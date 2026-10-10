"""Composer shortcuts: `#` variables and context references, `/` commands and saved prompts, `@` agent routing.

    #name        a text variable: built-ins (#date, #time, #clipboard…) and saved ones (Settings → Shortcuts) are
                 expanded by the browser before sending, so the transcript shows what the agent saw
    #<item>      a context reference: a chat artifact, a library item (Studio/Code project, research notebook, chat
                 Project, media) or a URL. It travels as an attachment of kind "ref"; resolve_refs() inlines its content
                 (or a listing plus a pointer to the library tool) when the turn starts, so the stored message replays
                 the same context later
    /command     built-in actions (/new, /effort…) run in the browser; /image, /search… nudge the agent to a tool
                 (TOOL_COMMANDS); /<skill> loads a skill; /<prompt> inserts a saved prompt template ({{blanks}} to fill)
    @Agent       sends this one turn to another agent without changing the conversation's agent

After each reply, /api/composer/suggest predicts the user's likely next message with the local utility model; the
composer shows it as ghost text that Tab accepts (like Claude Code's prompt suggestions).
"""
import re
import time

import httpx
from fastapi import APIRouter, HTTPException, Request

import db
import providers
import library
import skills

router = APIRouter()

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
BUILTIN_VARS = {"date", "time", "now", "weekday", "clipboard", "agent", "chat"}
UI_COMMANDS = {"new", "clear", "effort", "agent", "help", "prompts", "plan"}  # handled in Composer.tsx
# /command → (tool it nudges the agent to, what it does)
TOOL_COMMANDS = {
    "image": ("generate_image", "Generate an image (FLUX)"),
    "music": ("generate_music", "Generate a music clip (ORPHEUS)"),
    "search": ("web_search", "Search the web first"),
    "fetch": ("web_fetch", "Read a web page"),
    "run": ("run_code", "Run code in the sandbox"),
    "artifact": ("create_artifact", "Build it as an artifact"),
    "remember": ("memory_save", "Save this to long-term memory"),
    "recall": ("memory_search", "Search long-term memory"),
    "library": ("library", "Look it up in the library"),
    "translate": ("translate", "Translate this (local model)"),
}
REF_INLINE = 60_000
LISTING_INLINE = 8_000


def _items(key):
    return db.kv_get(key, [])


def _put(key, item, fields):
    name = str(item.get("name") or "").strip().lower()
    if not NAME_RE.match(name):
        raise HTTPException(400, "Use a short name: lowercase letters, digits, - and _")
    if key == "composer_vars" and name in BUILTIN_VARS:
        raise HTTPException(400, f"#{name} is built in")
    if key == "composer_prompts" and (name in TOOL_COMMANDS or name in UI_COMMANDS):
        raise HTTPException(400, f"/{name} is built in")
    clean = {"name": name, **{f: str(item.get(f) or "") for f in fields}, "updatedAt": time.time() * 1000}
    rest = [x for x in _items(key) if x["name"] not in (name, item.get("oldName"))]
    db.kv_set(key, sorted(rest + [clean], key=lambda x: x["name"]))
    return clean


def tool_hint(content: str, tool_names) -> str:
    """The nudge for a leading /image, /search… (empty if none applies)."""
    m = re.match(r"^/([a-z]+)\b", content)
    if not m or m.group(1) not in TOOL_COMMANDS:
        return ""
    tool, _ = TOOL_COMMANDS[m.group(1)]
    if tool not in tool_names:
        return f"\n\n[The user typed /{m.group(1)}, but the {tool} tool is switched off for you: say so briefly and do your best without it.]"
    return f"\n\n[The user typed /{m.group(1)}: use the {tool} tool for this request.]"


# ── context references ──────────────────────────────────────────────────────

async def _resolve_one(att: dict) -> dict:
    kind, ref = att.get("refKind"), str(att.get("ref") or "")
    try:
        if kind == "url":
            import tools
            r = await tools.web_fetch({"url": ref}, None)
            text = r.text
        else:
            e = library.resolve(ref)
            kind = e["kind"]
            att["name"] = att.get("name") or e["title"]
            if kind == "artifact":
                conv, aid = e["ref"].split("/", 1)
                a = next(x for x in db.latest_artifacts(conv) if x["id"] == aid)
                lang = f", {a['language']}" if a.get("language") else ""
                text = f"Artifact {aid} v{a['version']} ({a['type']}{lang})\n\n{a['content']}"
            else:
                listing = library.listing(e)
                if len(listing) > LISTING_INLINE:
                    listing = listing[:LISTING_INLINE] + "\n…(cut short)"
                about = f"{e['about']}\n\n" if e.get("about") else ""
                text = (f"{e['kind']} ({e['sub']}): {e['title']}\n{about}{listing}\n\n"
                        f"[Read, view or import its files with the library tool, ref=`{e['ref']}`.]")
    except Exception as ex:
        text = f"[Could not load this reference: {ex}]"
    att["truncated"] = len(text) > REF_INLINE
    att["inline"] = text[:REF_INLINE]
    att["size"] = len(att["inline"])
    att["refKind"] = kind
    return att


async def resolve_refs(attachments: list) -> list:
    """Fill in the content of #references that haven't been resolved yet (edits and regenerations keep theirs)."""
    out = []
    for a in attachments or []:
        if a.get("kind") == "ref" and "inline" not in a:
            a = await _resolve_one(dict(a))
        out.append(a)
    return out


# ── API ─────────────────────────────────────────────────────────────────────

@router.get("/api/composer")
def composer_catalog():
    return {
        "variables": _items("composer_vars"),
        "prompts": _items("composer_prompts"),
        "skills": [{"name": s["name"], "description": s["description"]} for s in skills.list_skills() if s.get("enabled")],
        "toolCommands": [{"name": k, "tool": t, "description": d} for k, (t, d) in TOOL_COMMANDS.items()],
    }


@router.put("/api/composer/variables")
async def put_variable(req: Request):
    return _put("composer_vars", await req.json(), ("value", "description"))


@router.delete("/api/composer/variables/{name}")
def delete_variable(name: str):
    db.kv_set("composer_vars", [v for v in _items("composer_vars") if v["name"] != name])
    return {"ok": True}


@router.put("/api/composer/prompts")
async def put_prompt(req: Request):
    return _put("composer_prompts", await req.json(), ("title", "content", "description"))


@router.delete("/api/composer/prompts/{name}")
def delete_prompt(name: str):
    db.kv_set("composer_prompts", [p for p in _items("composer_prompts") if p["name"] != name])
    return {"ok": True}


@router.get("/api/composer/refs")
def search_refs(q: str = "", conv: str = "", limit: int = 30):
    """Things a # can point at: this chat's artifacts first, then the rest of the library."""
    low = q.lower().strip()
    es = library.entries()
    if conv:
        es.sort(key=lambda e: 0 if e["kind"] == "artifact" and e["ref"].startswith(conv + "/") else 1)
    hits = [e for e in es if not low or low in e["title"].lower()] \
        + [e for e in es if low and low not in e["title"].lower() and low in (e.get("about") or "").lower()]
    return [{**e, "here": bool(conv) and e["ref"].startswith(conv + "/")} for e in hits[:limit]]


# ── next-message suggestions ────────────────────────────────────────────────

SUGGEST_PROMPT = """Below is the end of a chat between a user and their AI assistant. Predict the user's next message: \
what they would most likely type now, in their own voice and style (casual, terse, first person, as if typed into the \
chat box). Make it a natural follow-up to the assistant's last reply, specific to this conversation, 2-12 words, no \
quotes. Do not answer for the assistant, and don't say thanks. If the assistant asked the user a question, answer it \
the way the user plausibly would. If there is no obvious next step, reply with NONE.

{transcript}

The user's next message:"""
_suggested: dict[str, str] = {}  # last message id → suggestion (cleared as it grows)


def _settings():
    from defaults import DEFAULT_SETTINGS
    return {**DEFAULT_SETTINGS, **db.kv_get("settings", {})}


@router.get("/api/composer/suggest")
async def suggest(conv: str):
    """The user's likely next message in this chat, or "" (turn in progress, nothing obvious, or switched off)."""
    settings = _settings()
    model = settings.get("utilityModel") or ""
    msgs = [m for m in db.list_messages(conv) if m["role"] in ("user", "assistant") and (m["content"] or "").strip()]
    # local only: the transcript may hold anything, so it never goes to a cloud utility model
    if not settings.get("promptSuggestions", True) or not model or providers.is_cloud(model) \
            or not msgs or msgs[-1]["role"] != "assistant":
        return {"suggestion": ""}
    key = msgs[-1]["id"]
    if key in _suggested:
        return {"suggestion": _suggested[key]}
    lines = []
    for m in msgs[-6:]:
        text = m["content"].strip()
        text = text if len(text) < 1500 else text[:700] + "\n…\n" + text[-700:]  # replies end with the question/next step
        lines.append(f"{'User' if m['role'] == 'user' else 'Assistant'}: {text}")
    from agent import OLLAMA, model_info
    payload = {"model": model, "messages": [{"role": "user", "content": SUGGEST_PROMPT.format(transcript="\n\n".join(lines))}],
               "stream": False, "keep_alive": "2h", "options": {"temperature": 0.4, "num_predict": 40}}
    try:
        if "thinking" in (await model_info(model))["capabilities"]:
            payload["think"] = False
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"{OLLAMA}/api/chat", json=payload)
            r.raise_for_status()
        out = (r.json()["message"]["content"] or "").strip().splitlines()
    except Exception:
        return {"suggestion": ""}
    text = re.sub(r"^(user|you)\s*:\s*", "", out[0] if out else "", flags=re.I).strip().strip('"\'`*')
    if not text or text.upper().startswith("NONE") or len(text) > 140:
        text = ""
    if len(_suggested) > 500:
        _suggested.clear()
    _suggested[key] = text
    return {"suggestion": text}
