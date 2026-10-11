"""Cloud AI providers: lets Shell:B agents run on Claude (Anthropic) or Gemini / OpenAI-compatible models.

Model names look like `anthropic/claude-opus-5-5`, `gemini/gemini-3.1-pro-preview` or `openai/gpt-5`. Everything else
stays on Ollama. Cloud use is opt-in: nothing is sent unless Settings → Cloud AI is switched on and a key is set.
Messages arrive in Ollama's chat format (the agent loop's lingua franca) and are converted per provider; an
assistant message can carry `_native`, the provider's own form of that turn, so thinking signatures and
provider-specific tool-call fields are replayed exactly within a turn.
"""
import base64
import json
import os
import re
import time
import uuid

import httpx

import cli_agents
import db

PROVIDERS = {
    "anthropic": {"name": "Anthropic", "product": "Claude", "env": "ANTHROPIC_API_KEY",
                  "keyHint": "console.anthropic.com → API keys", "baseUrl": None},
    "gemini": {"name": "Google", "product": "Gemini", "env": "GEMINI_API_KEY",
               "keyHint": "aistudio.google.com → Get API key",
               "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai"},
    "openai": {"name": "OpenAI-compatible", "product": "OpenAI", "env": "OPENAI_API_KEY",
               "keyHint": "platform.openai.com → API keys (or any OpenAI-compatible endpoint)",
               "baseUrl": "https://api.openai.com/v1"},
}
SECRET = "__secret__"
CLOUD_CTX = 131072  # history budget for cloud agents unless the agent sets its own; keeps per-turn cost sane


def split(model: str):
    """('anthropic', 'claude-opus-5-5') for cloud models, None for local ones."""
    if "/" in model:
        p, m = model.split("/", 1)
        if p in PROVIDERS or p in cli_agents.CLIS:
            return p, m
    return None


def is_cloud(model: str) -> bool:
    return split(model or "") is not None


def is_cli(model: str) -> bool:
    """A cloud model reached through the owner's logged-in CLI (cli_agents.py) rather than an API key."""
    return cli_agents.is_cli(model or "")


def meta(pid: str) -> dict:
    return PROVIDERS.get(pid) or cli_agents.CLIS[pid]


# ── configuration ───────────────────────────────────────────────────────────

def config() -> dict:
    stored = db.kv_get("providers", {})
    out = {}
    for pid, meta in PROVIDERS.items():
        s = stored.get(pid, {})
        key = s.get("apiKey") or os.environ.get(meta["env"], "")
        if pid == "gemini" and not key:
            key = os.environ.get("GOOGLE_API_KEY", "")
        out[pid] = {"apiKey": key, "baseUrl": s.get("baseUrl") or meta["baseUrl"], "fromEnv": bool(key and not s.get("apiKey"))}
    return out


def public_config() -> dict:
    cfg = config()
    return {pid: {**PROVIDERS[pid], "configured": bool(c["apiKey"]), "apiKey": SECRET if c["apiKey"] else "",
                  "keyTail": c["apiKey"][-4:] if c["apiKey"] else "", "baseUrl": c["baseUrl"], "fromEnv": c["fromEnv"]}
            for pid, c in cfg.items()}


def save_config(pid: str, body: dict):
    if pid not in PROVIDERS:
        raise KeyError(pid)
    stored = db.kv_get("providers", {})
    cur = stored.get(pid, {})
    updated = []
    if "apiKey" in body and body["apiKey"] != SECRET:
        cur["apiKey"] = str(body["apiKey"] or "").strip()
        updated.append("apiKey")
    if "baseUrl" in body and pid == "openai":
        cur["baseUrl"] = str(body["baseUrl"] or "").strip().rstrip("/")
        updated.append("baseUrl")
    stored[pid] = cur
    db.kv_set("providers", stored)
    _models_cache.pop(pid, None)
    db.audit_log("admin:provider_change", {
        "provider": pid,
        "updated_fields": updated or [k for k in body.keys() if k != "apiKey"],
        "configured": bool(cur.get("apiKey")),
        "baseUrl": cur.get("baseUrl"),
    })



def enabled(settings: dict) -> bool:
    return bool(settings.get("cloudEnabled"))


def available(model: str, settings: dict) -> tuple[bool, str]:
    sp = split(model)
    if not sp:
        return True, ""
    if not enabled(settings):
        return False, "Cloud AI is switched off (Tools & Connectors → Cloud AI)."
    if sp[0] in cli_agents.CLIS:
        return cli_agents.available(model)
    if not config()[sp[0]]["apiKey"]:
        return False, f"No {PROVIDERS[sp[0]]['name']} API key is set (Tools & Connectors → Cloud AI)."
    return True, ""


# ── model catalog ───────────────────────────────────────────────────────────

_models_cache: dict[str, tuple[float, list]] = {}


def _anthropic_client(key):
    from anthropic import AsyncAnthropic
    return AsyncAnthropic(api_key=key, max_retries=2, timeout=900)


async def list_models(pid: str) -> list[dict]:
    hit = _models_cache.get(pid)
    if hit and time.time() - hit[0] < 600:
        return hit[1]
    c = config()[pid]
    if not c["apiKey"]:
        return []
    out = []
    if pid == "anthropic":
        client = _anthropic_client(c["apiKey"])
        async for m in client.models.list(limit=100):
            out.append({"id": m.id, "label": getattr(m, "display_name", m.id),
                        "context": getattr(m, "max_input_tokens", None) or 200000})
    else:
        async with httpx.AsyncClient(timeout=20) as h:
            r = await h.get(f"{c['baseUrl']}/models", headers={"Authorization": f"Bearer {c['apiKey']}"})
            r.raise_for_status()
        skip = re.compile(r"embed|tts|image|imagen|live|audio|realtime|transcribe|robotics|computer-use|aqa|search|moderation|dall-e|whisper|babbage|davinci|veo|lyria", re.I)
        for m in r.json().get("data", []):
            mid = m["id"].removeprefix("models/")
            if skip.search(mid):
                continue
            if pid == "gemini" and not mid.startswith("gemini"):
                continue
            if pid == "openai" and c["baseUrl"].startswith("https://api.openai.com") and not re.match(r"^(gpt-4\.1|gpt-5|o3|o4)", mid):
                continue
            out.append({"id": mid, "label": m.get("display_name") or mid, "context": 1_000_000 if pid == "gemini" else 400_000})
    out.sort(key=lambda m: m["id"])
    _models_cache[pid] = (time.time(), out)
    return out


def model_info(model: str) -> dict:
    if is_cli(model):
        return cli_agents.model_info(model)
    pid, mid = split(model)
    caps = ["completion", "tools", "vision", "thinking"]
    native = 200_000 if "haiku" in mid else 1_000_000
    if pid == "openai" and not re.match(r"^(gpt-[5-9]|o\d)", mid):
        caps.remove("thinking")
    return {"capabilities": caps, "numCtx": CLOUD_CTX, "nativeCtx": native, "family": pid,
            "parameterSize": "cloud", "quantization": PROVIDERS[pid]["name"], "cloud": True, "provider": pid}


# ── shared helpers ──────────────────────────────────────────────────────────

def _mime(b64: str) -> str:
    head = base64.b64decode(b64[:24] + "=" * (-len(b64[:24]) % 4))
    if head.startswith(b"\x89PNG"):
        return "image/png"
    if head.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if head.startswith(b"GIF8"):
        return "image/gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    return "image/png"


class Output:
    """What a provider stream hands back to the agent loop."""

    def __init__(self):
        self.content, self.thinking = "", ""
        self.tool_calls: list[dict] = []
        self.native = None
        self.prompt_tokens = self.completion_tokens = 0


async def stream(model, messages, schemas, effort, temperature, on_thinking, on_text, abort) -> Output:
    if is_cli(model):  # a plain completion (no tools), e.g. for notebooks
        system, prompt, images = cli_agents.render_prompt(messages)
        r = await cli_agents.run(model, system, prompt, images, effort, on_text=on_text, on_thinking=on_thinking, abort=abort)
        out = Output()
        out.content = r["text"]
        out.prompt_tokens, out.completion_tokens = r["usage"]["prompt"], r["usage"]["completion"]
        return out
    pid, mid = split(model)
    key = config()[pid]
    if pid == "anthropic":
        return await _anthropic(mid, key, messages, schemas, effort, temperature, on_thinking, on_text, abort)
    return await _openai_compat(pid, mid, key, messages, schemas, effort, temperature, on_thinking, on_text, abort)


# ── Anthropic (Claude) ──────────────────────────────────────────────────────

FALLBACK_MODELS = ("claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5")


def _to_anthropic(messages):
    system, out = [], []
    pending_results: list = []

    def flush():
        if pending_results:
            out.append({"role": "user", "content": list(pending_results)})
            pending_results.clear()

    for m in messages:
        role = m["role"]
        if role == "system":
            system.append(m["content"])
            continue
        if role == "tool":
            content = [{"type": "text", "text": m.get("content") or "(no output)"}]
            for img in m.get("images") or []:
                content.append({"type": "image", "source": {"type": "base64", "media_type": _mime(img), "data": img}})
            block = {"type": "tool_result", "tool_use_id": m.get("tool_call_id") or "", "content": content}
            if m.get("is_error"):
                block["is_error"] = True
            pending_results.append(block)
            continue
        flush()
        if role == "assistant":
            if m.get("_native") and m["_native"].get("provider") == "anthropic":
                out.append({"role": "assistant", "content": m["_native"]["content"]})
            else:
                out.append({"role": "assistant", "content": m.get("content") or "(no reply)"})
        else:
            blocks = [{"type": "image", "source": {"type": "base64", "media_type": _mime(i), "data": i}}
                      for i in m.get("images") or []]
            blocks.append({"type": "text", "text": m.get("content") or "(empty message)"})
            out.append({"role": "user", "content": blocks})
    flush()
    return "\n\n".join(system), out


def _block_param(b) -> dict:
    """A response content block in the shape the API accepts back."""
    t = b.type
    if t == "text":
        return {"type": "text", "text": b.text}
    if t == "thinking":
        return {"type": "thinking", "thinking": b.thinking, "signature": b.signature}
    if t == "redacted_thinking":
        return {"type": "redacted_thinking", "data": b.data}
    if t == "tool_use":
        return {"type": "tool_use", "id": b.id, "name": b.name, "input": b.input}
    return b.model_dump(mode="json", exclude_none=True)


async def _anthropic(mid, key, messages, schemas, effort, temperature, on_thinking, on_text, abort):
    import anthropic
    client = _anthropic_client(key["apiKey"])
    system, msgs = _to_anthropic(messages)
    tools = [{"name": s["function"]["name"], "description": s["function"].get("description", ""),
              "input_schema": s["function"].get("parameters") or {"type": "object", "properties": {}},
              "eager_input_streaming": True} for s in schemas]
    params = {"model": mid, "max_tokens": 64000, "system": system, "messages": msgs,
              "cache_control": {"type": "ephemeral"}}
    if tools:
        params["tools"] = tools
    level = {"off": "low", "low": "low", "medium": "medium", "high": "high"}.get(effort, "medium")
    if "haiku" in mid or re.search(r"-(3|4-[015])\b|sonnet-4-5|opus-4-1", mid):
        # older models: manual thinking budget, sampling allowed
        if effort in ("medium", "high"):
            params["thinking"] = {"type": "enabled", "budget_tokens": 16000 if effort == "high" else 4096}
        else:
            params["temperature"] = float(temperature)
    else:
        params["thinking"] = {"type": "adaptive", "display": "summarized"}
        params["output_config"] = {"effort": level}
    betas = []
    if mid in FALLBACK_MODELS:  # a policy decline is retried server-side on a suitable model
        betas.append("server-side-fallback-2026-07-01")
        params["fallbacks"] = "default"
    if betas:
        params["betas"] = betas

    out = Output()
    try:
        final = await _anthropic_once(client, params, out, on_thinking, on_text, abort)
    except anthropic.BadRequestError as e:
        if "fallback" in str(e).lower() and "fallbacks" in params:  # account/model without the beta: run plain
            params.pop("fallbacks")
            params.pop("betas", None)
            out = Output()
            final = await _anthropic_once(client, params, out, on_thinking, on_text, abort)
        else:
            raise
    if final is None:  # aborted mid-stream
        return out
    out.native = {"provider": "anthropic", "content": [_block_param(b) for b in final.content]}
    u = final.usage
    out.prompt_tokens = (u.input_tokens or 0) + (getattr(u, "cache_read_input_tokens", 0) or 0) + (getattr(u, "cache_creation_input_tokens", 0) or 0)
    out.completion_tokens = u.output_tokens or 0
    if final.stop_reason == "refusal":
        cat = getattr(getattr(final, "stop_details", None), "category", None)
        note = f"\n\n*(Claude declined this request{f' — {cat}' if cat else ''}.)*"
        out.content += note
        await on_text(note)
        out.tool_calls = []
        return out
    for b in final.content:
        if b.type == "tool_use":
            args = b.input if isinstance(b.input, dict) else {"_raw": b.input}
            if final.stop_reason == "max_tokens":
                args = {"_truncated": True}
            out.tool_calls.append({"id": b.id, "function": {"name": b.name, "arguments": args}})
    return out


async def _anthropic_once(client, params, out, on_thinking, on_text, abort):
    async with client.beta.messages.stream(**params) as s:
        async for ev in s:
            if abort.is_set():
                return None
            if ev.type == "content_block_delta":
                d = ev.delta
                if d.type == "thinking_delta" and d.thinking:
                    out.thinking += d.thinking
                    await on_thinking(d.thinking)
                elif d.type == "text_delta" and d.text:
                    out.content += d.text
                    await on_text(d.text)
        return await s.get_final_message()


# ── Gemini / OpenAI-compatible ──────────────────────────────────────────────

def _to_openai(messages):
    out = []
    for m in messages:
        role = m["role"]
        if role == "tool":
            out.append({"role": "tool", "tool_call_id": m.get("tool_call_id") or "", "content": m.get("content") or "(no output)"})
            if m.get("images"):  # tool messages are text-only here; show returned images in a follow-up user turn
                out.append({"role": "user", "content": [{"type": "text", "text": f"[images returned by {m.get('tool_name', 'the tool')}]"}]
                            + [{"type": "image_url", "image_url": {"url": f"data:{_mime(i)};base64,{i}"}} for i in m["images"]]})
        elif role == "assistant":
            if m.get("_native") and m["_native"].get("provider") == "openai":
                out.append(m["_native"]["message"])
            else:
                out.append({"role": "assistant", "content": m.get("content") or "(no reply)"})
        elif role == "user" and m.get("images"):
            out.append({"role": "user", "content": [{"type": "text", "text": m.get("content") or ""}]
                        + [{"type": "image_url", "image_url": {"url": f"data:{_mime(i)};base64,{i}"}} for i in m["images"]]})
        else:
            out.append({"role": role, "content": m.get("content") or ""})
    return out


def _merge(dst: dict, src: dict):
    for k, v in src.items():
        if isinstance(v, dict):
            _merge(dst.setdefault(k, {}), v)
        elif isinstance(v, str) and k in ("arguments",) and isinstance(dst.get(k), str):
            dst[k] += v
        elif v is not None:
            dst[k] = v


async def _openai_compat(pid, mid, key, messages, schemas, effort, temperature, on_thinking, on_text, abort):
    body = {"model": mid, "messages": _to_openai(messages), "stream": True, "stream_options": {"include_usage": True}}
    if schemas:
        body["tools"] = schemas
    reasoning = pid == "gemini" or re.match(r"^(gpt-[5-9]|o\d)", mid)
    if reasoning:
        body["reasoning_effort"] = {"off": "low", "low": "low", "medium": "medium", "high": "high"}.get(effort, "medium")
    if not re.match(r"^(gpt-[5-9]|o\d|gemini-3)", mid):
        body["temperature"] = float(temperature)
    out = Output()
    calls: dict[int, dict] = {}
    async with httpx.AsyncClient(timeout=httpx.Timeout(900, connect=15)) as h:
        async with h.stream("POST", f"{key['baseUrl']}/chat/completions", json=body,
                            headers={"Authorization": f"Bearer {key['apiKey']}"}) as r:
            if r.status_code != 200:
                raise RuntimeError(f"{PROVIDERS[pid]['product']} {r.status_code}: {(await r.aread()).decode()[:600]}")
            async for line in r.aiter_lines():
                if abort.is_set():
                    return out
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                chunk = json.loads(data)
                if chunk.get("error"):
                    raise RuntimeError(str(chunk["error"])[:600])
                if chunk.get("usage"):
                    out.prompt_tokens = chunk["usage"].get("prompt_tokens") or 0
                    out.completion_tokens = chunk["usage"].get("completion_tokens") or 0
                for ch in chunk.get("choices") or []:
                    d = ch.get("delta") or {}
                    rt = d.get("reasoning_content") or d.get("reasoning")
                    if rt:
                        out.thinking += rt
                        await on_thinking(rt)
                    if d.get("content"):
                        out.content += d["content"]
                        await on_text(d["content"])
                    for tc in d.get("tool_calls") or []:
                        _merge(calls.setdefault(tc.get("index", len(calls)), {}), {k: v for k, v in tc.items() if k != "index"})
    native_calls = []
    for i in sorted(calls):
        tc = calls[i]
        tc.setdefault("id", f"call_{uuid.uuid4().hex[:12]}")
        tc["type"] = "function"
        fn = tc.setdefault("function", {})
        raw = fn.get("arguments") or "{}"
        try:
            args = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError:
            args = {"_raw": raw}
        native_calls.append(tc)
        out.tool_calls.append({"id": tc["id"], "function": {"name": fn.get("name", ""), "arguments": args}})
    msg = {"role": "assistant", "content": out.content or None}
    if native_calls:
        msg["tool_calls"] = native_calls
    out.native = {"provider": "openai", "message": msg}
    return out
