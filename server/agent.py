"""The Shell:B agent loop: stream from Ollama, run tools, repeat until the model answers."""
import asyncio
import base64
import json
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Awaitable, Callable

import httpx

import db
import mcp_hub
import providers
import cli_agents
import groups
import planmode
import skills
import research
import megaplan
import library
import codex
import commitments
import media
import assets as asset_libs
import scrape
import remote
import selfmod
import ask
import screen
import compaction
import memory
import places
import wiki
import legal
from tools import OLLAMA, TOOLS, WORKSPACES, ToolContext, ToolResult, ask_agent_schema, search_memories
from capabilities import model_info, think_param, _caps_cache
from prompts import (
    VENDOR_NOTE,
    RICH_LINKS,
    MAP_CARDS,
    QUICK_REPLIES,
    ARTIFACT_LINK,
    FILE_LINK,
    CODE_TOOLCHAIN,
    build_system,
    delegates,
    code_context,
    project_context,
)

# Ollama's errors when it can't parse a tool call the model wrote (e.g. Qwen's XML format with mismatched tags)
BAD_TOOL_CALL = re.compile(r"XML syntax error|error parsing tool call|failed to parse tool call", re.I)

Emit = Callable[[dict], Awaitable[None]]









# ── image & payload helpers ─────────────────────────────────────────────────


def _image_b64(url: str, conv_id: str):
    # attachments live in the conversation workspace (/api/workspace/<conv>/<path>)
    # or, in Studio, in the project itself (/api/projects/<pid>/raw/<path>)
    from urllib.parse import unquote
    prefix = f"/api/workspace/{conv_id}/"
    if url.startswith(prefix):
        p = (WORKSPACES / conv_id / unquote(url[len(prefix):])).resolve()
        if p.is_file() and p.is_relative_to((WORKSPACES / conv_id).resolve()):  # this chat's /work only
            import projects as P  # also enlarges tiny images, which crash the vision runner
            try:
                return base64.b64encode(P.downscale(p.read_bytes(), 1600)).decode()
            except Exception:  # not a raster PIL can open (e.g. SVG): pass it through as before
                return base64.b64encode(p.read_bytes()).decode()
    m = re.match(r"^/api/projects/([\w-]+)/raw/(.+)$", url)
    if m:
        import projects as P
        try:
            p = P.safe_path(m.group(1), unquote(m.group(2)))
        except Exception:
            return None
        if p.is_file():
            return base64.b64encode(P.downscale(p.read_bytes(), 1600)).decode() if p.suffix.lower() != ".gif" else base64.b64encode(p.read_bytes()).decode()
    return None


def user_payload(msg, conv_id, include_images=True):
    text = msg["content"]
    images = []
    for att in msg.get("attachments", []):
        if att.get("projectPath"):
            if att.get("kind") == "image" and include_images:
                b = _image_b64(att["url"], conv_id)
                if b:
                    images.append(b)
            text += f"\n\n[The user attached {att['projectPath']}; it is saved in the project]"
            continue
        if att.get("kind") == "image":
            if include_images:
                b = _image_b64(att["url"], conv_id)
                if b:
                    images.append(b)
            text += f"\n\n[Attached image: /work/{att['name']}]"
        elif att.get("kind") == "ref":
            more = " It is cut short; fetch the rest with the matching tool." if att.get("truncated") else ""
            text += (f"\n\n<context kind=\"{att.get('refKind', '')}\" ref=\"{att.get('ref', '')}\" title=\"{att['name']}\">\n"
                     f"{att.get('inline', '')}\n</context>\n[The user referenced this with #.{more}]")
        elif att.get("kind") == "text" and att.get("inline"):
            text += f"\n\n<file name=\"{att['name']}\" path=\"/work/{att['name']}\">\n{att['inline']}\n</file>"
        elif att.get("document"):
            pages = f", {att['pages']} pages" if att.get("pages") else ""
            if att.get("inline"):
                more = ""
                if att.get("truncated"):
                    seen = re.findall(r"^\[page (\d+)\]", att["inline"], re.M)
                    more = (f" It is cut short after page {seen[-1]}: read the rest with read_document, pages={seen[-1]}-."
                            if seen else " It is cut short: read the rest with read_document.")
                attr = f' pages="{att["pages"]}"' if att.get("pages") else ""
                text += (f"\n\n<document name=\"{att['name']}\" path=\"/work/{att['name']}\"{attr}>\n"
                         f"{att['inline']}\n</document>\n[Extracted text layer.{more} Use view_document to see figures, "
                         "charts or layout, and ocr for text inside pictures.]")
            elif att.get("scanned"):
                text += (f"\n\n[Attached scanned document: /work/{att['name']}{pages} with no text layer. Read it with "
                         "read_document (it OCRs automatically) or look at it with view_document.]")
            else:
                text += f"\n\n[Attached document: /work/{att['name']}{pages}. Read it with read_document.]"
        else:
            text += (f"\n\n[Attached file: /work/{att['name']} ({att.get('size', 0)} bytes). Read documents with "
                     "read_document; inspect other files with run_code]")
    out = {"role": "user", "content": text}
    if images:
        out["images"] = images
    return out


def assistant_text(msg):
    texts = [b["text"] for b in msg.get("blocks", []) if b.get("type") == "text" and b.get("text")]
    extras = []
    for b in msg.get("blocks", []):
        if b.get("type") == "tool" and b.get("display"):
            d = b["display"]
            if d.get("images") and b["name"] == "generate_image":
                extras.append(f"[generated image: {d.get('prompt', '')[:200]}]")
            if d.get("artifact"):
                extras.append(f"[artifact `{d['artifact']['id']}` v{d['artifact']['version']}]")
    return ("\n\n".join(texts) + ("\n\n" + " ".join(extras) if extras else "")).strip() or "(no reply)"


def _compact_dropped(dropped: list[dict]) -> str:
    """Produce a concise extractive summary of messages dropped due to context window limits."""
    lines = []
    for m in dropped:
        role = "User" if m.get("role") == "user" else "Assistant"
        c = (m.get("content") or "").strip()
        if not c:
            continue
        first_line = c.split("\n")[0][:140]
        if len(first_line) < len(c):
            first_line += "..."
        lines.append(f"- **{role}**: {first_line}")
    return "\n".join(lines[:12])


log = logging.getLogger("shellb.agent")
CHARS_PER_TOKEN = 3.0  # measured on code-heavy turns: 131k tokens of Qwen context held ~390k chars
ELIDED = "[Older tool result removed to free context"


def _msg_chars(m: dict) -> int:
    n = len(m.get("content") or "") + len(m.get("thinking") or "")
    if m.get("tool_calls"):
        n += len(json.dumps(m["tool_calls"], ensure_ascii=False))
    return n + 1500 * len(m.get("images") or [])


def fit_turn_context(messages: list[dict], num_ctx: int, schema_chars: int, keep_last=3, force=False) -> int:
    """Keep a long tool-using turn inside the model's context window. Ollama silently cuts a prompt (and the reply)
    at num_ctx, so a turn that reads many files used to fill it and end with the answer cut off mid-sentence.
    Over the high-water mark, the oldest tool results of this turn shrink to a one-line stub until the prompt is back
    under the low-water mark; elisions are batched because each one makes Ollama re-read the whole prompt.
    force=True trims to the low-water mark regardless (after a reply was cut off). Returns how many were elided."""
    limit = num_ctx * CHARS_PER_TOKEN - schema_chars
    reserve = max(8192, num_ctx * 0.15) * CHARS_PER_TOKEN  # room for thinking and the reply
    high, low = limit - reserve, (limit - reserve) * 0.7
    total = sum(map(_msg_chars, messages))
    if total <= high and not force:
        return 0
    tools = [i for i, m in enumerate(messages) if m.get("role") == "tool" and not m["content"].startswith(ELIDED)]
    elided = 0
    for i in tools[:-keep_last] if len(tools) > keep_last else []:
        if total <= low:
            break
        m = messages[i]
        head = m["content"].split("\n", 1)[0][:160]
        stub = f"{ELIDED} ({len(m['content']):,} chars; it began: {head!r}). Call the tool again if you still need it.]"
        total -= _msg_chars(m) - len(stub)
        m["content"] = stub
        m.pop("images", None)
        elided += 1
    return elided


def history_messages(history, conv_id, num_ctx):
    """Prior turns as plain user/assistant text. Summarized messages are left out (compaction.visible); their summary
    goes into the system prompt instead (compaction.note). Anything still over budget is trimmed from the front, and
    the first remaining request says so honestly (no invented "I remember everything" turns)."""
    out = []
    user_seen = 0
    for m in reversed(compaction.visible(history)):
        if m["role"] == "user":
            user_seen += 1
            out.append(user_payload(m, conv_id, include_images=user_seen <= 2))
        elif m["role"] == "assistant":
            out.append({"role": "assistant", "content": assistant_text(m)})
    out.reverse()
    budget = int(num_ctx * 0.6 * CHARS_PER_TOKEN)  # chars; leaves room for system prompt, tools and the reply
    dropped = []
    while out and sum(len(m["content"]) for m in out) > budget:
        dropped.append(out.pop(0))
    while out and out[0]["role"] != "user":
        dropped.append(out.pop(0))
    if dropped and out and isinstance(out[0].get("content"), str):
        gist = _compact_dropped(dropped)
        out[0] = {**out[0], "content": f"[{len(dropped)} earlier messages of this chat didn't fit in your context and were "
                                       f"left out. Their first lines:\n{gist}\nUse recall_conversations (action read, "
                                       f"conversation {conv_id}) if you need them.]\n\n" + out[0]["content"]}
    return out


# ── the loop ────────────────────────────────────────────────────────────────

class Sink:
    """Collects blocks for a turn and streams changes to the client (batched to ~60 ms)."""

    def __init__(self, emit: Emit):
        self.emit = emit
        self.blocks: list[dict] = []
        self._pending: dict[int, str] = {}
        self._last = 0.0

    async def start(self, block):
        await self.flush()
        self.blocks.append(block)
        # events are serialized later, off the queue: send a snapshot, or deltas that land first get counted twice
        await self.emit({"type": "block_start", "index": len(self.blocks) - 1, "block": dict(block)})
        return len(self.blocks) - 1

    async def delta(self, index, text):
        self.blocks[index]["text"] += text
        self._pending[index] = self._pending.get(index, "") + text
        if time.time() - self._last > 0.06:
            await self.flush()

    async def update(self, index):
        await self.flush()
        await self.emit({"type": "block_update", "index": index, "block": dict(self.blocks[index])})

    async def flush(self):
        self._last = time.time()
        for i, t in self._pending.items():
            await self.emit({"type": "block_delta", "index": i, "text": t})
        self._pending.clear()


WRITE_TOOLS = {
    "write_file", "edit_file", "delete_file", "rename_file",
    "create_artifact", "memory_save", "memory_forget",
    "save_skill", "schedule_task", "dev_server",
    "project_save_file", "library", "codex", "follow_ups",
}


def _canonical_args_key(name: str, args) -> str:
    """Produces a deterministic string key for (tool_name, args) to detect exact repeats."""
    if not isinstance(args, dict):
        return f"{name}:{str(args)}"
    clean = {k: v for k, v in args.items() if not k.startswith("_")}
    try:
        serialized = json.dumps(clean, sort_keys=True, separators=(",", ":"), default=str)
    except Exception:
        serialized = str(clean)
    return f"{name}:{serialized}"


class LoopGuard:
    """Guards against runaway agent loops, tight cycles, and idle repetition without limiting productive work."""

    def __init__(self, settings: dict):
        self.settings = settings
        self.enabled = bool(settings.get("runawayLoopChecker", True))
        self.interval = max(3, int(settings.get("loopCheckInterval", 10)))
        self.hard_cap = max(self.interval, int(settings.get("maxToolRoundsHardCap", 120)))
        self.call_history: list[dict] = []
        self.progress_count = 0
        self.last_checkpoint_progress = 0
        self.consecutive_stalls = 0
        self.seen_signatures: dict[str, int] = {}

    def check_pre_call(self, name: str, args) -> str | None:
        """Pre-execution check before tool runs. Returns an error message to intercept loops, or None if safe."""
        if not self.enabled:
            return None

        key = _canonical_args_key(name, args)
        recent = self.call_history[-6:]

        # 1. Exact repeat of an immediately preceding or recent failed call
        for call in reversed(recent[-3:]):
            if call["key"] == key and call.get("error"):
                return (f"[LOOP PREVENTED: '{name}' was just executed with identical arguments and failed. "
                        "Do not retry identical failed commands without altering arguments or fixing the underlying issue.]")

        # 2. Repeated identical read/query call with no intervening state changes
        call_count = self.seen_signatures.get(key, 0)
        if call_count >= 2:
            intervening_writes = any(c.get("is_write") for c in self.call_history[-(call_count * 2):])
            if not intervening_writes:
                return (f"[LOOP PREVENTED: '{name}' has already been called {call_count} times with identical arguments "
                        "in this turn without any state changes. Rely on the output already in context instead of repeating.]")

        # 3. Oscillation / cycle trap (A -> B -> A -> B)
        if len(recent) >= 3:
            keys = [c["key"] for c in recent]
            if keys[-1] == keys[-3] and key == keys[-2] and not any(c.get("progress") for c in recent[-3:]):
                return (f"[OSCILLATION DETECTED: You are trapped in an alternating 2-step loop between '{name}' and "
                        f"'{recent[-1]['name']}'. Stop this cycle and adopt a completely different approach.]")

        return None

    def record_post_call(self, name: str, args, res: ToolResult, round_num: int):
        """Records the outcome of a tool execution and tracks progress indicators."""
        if not self.enabled:
            return

        key = _canonical_args_key(name, args)
        self.seen_signatures[key] = self.seen_signatures.get(key, 0) + 1

        is_write = (name in WRITE_TOOLS or
                    (name == "shellb_self" and isinstance(args, dict) and
                     args.get("action") in ("write_file", "edit_file", "delete_file", "deploy")))
        is_error = bool(res.error)

        is_progress = False
        if not is_error:
            if is_write:
                is_progress = True
            elif name in ("run_code", "generate_image", "generate_3d", "generate_music", "generate_sfx"):
                is_progress = True
            elif self.seen_signatures[key] == 1 and len(res.text.strip()) > 30:
                is_progress = True

        if is_progress:
            self.progress_count += 1

        self.call_history.append({
            "name": name,
            "args": args,
            "key": key,
            "round": round_num,
            "error": is_error,
            "is_write": is_write,
            "progress": is_progress,
            "text_len": len(res.text),
        })

    def check_consecutive_errors(self) -> str | None:
        """Returns a warning if 3+ consecutive calls errored."""
        if not self.enabled or len(self.call_history) < 3:
            return None
        if all(c.get("error") for c in self.call_history[-3:]):
            return ("\n\n[WARNING: 3 consecutive tool calls have failed with errors. "
                    "Analyze what fundamental assumption is failing before issuing another call.]")
        return None

    def evaluate_checkpoint(self, round_num: int) -> tuple[str, str]:
        """Runs at checkpoint intervals (every X turns).
        Returns:
            ("extend", note): forward progress detected -> budget dynamically extends.
            ("warn", note): no progress on 1st checkpoint -> reflection prompt injected.
            ("terminate", note): no progress across 2 consecutive checkpoints -> graceful stop.
        """
        if not self.enabled:
            return ("extend", "")

        progress_in_window = self.progress_count - self.last_checkpoint_progress
        self.last_checkpoint_progress = self.progress_count

        if progress_in_window > 0:
            self.consecutive_stalls = 0
            return ("extend", f"Progress detected (+{progress_in_window} events). Extending budget.")

        self.consecutive_stalls += 1
        if self.consecutive_stalls == 1:
            return ("warn", (
                f"\n\n[RUNAWAY LOOP CHECKPOINT: You have taken {self.interval} tool rounds without making measurable progress "
                "or modifying state. Before calling any more tools, you MUST explicitly explain in your next response: "
                "1) What blocker or repeated error is occurring? "
                "2) Why have recent attempts failed? "
                "3) What completely different strategy will you use now?]"
            ))
        else:
            return ("terminate", (
                f"*(Runaway loop prevented: Paused after {round_num} tool rounds because no forward progress was "
                "detected across consecutive check intervals. The agent appears trapped in a repetitive loop.)*"
            ))


class Turn:
    def __init__(self, conv_id, message_id, agent, agents, settings, emit: Emit, abort: asyncio.Event, depth=0, project_id=None):
        self.conv_id, self.message_id = conv_id, message_id
        self.project_id = project_id
        self.user_request = ""
        self.agent, self.agents, self.settings = agent, agents, settings
        self.emit, self.abort, self.depth = emit, abort, depth
        self.usage = {"prompt": 0, "completion": 0}
        self._done_reason = None
        self.model = agent["model"]
        self.mcp_specs: dict = {}
        self.remote = bool(remote.config(project_id))  # a remote (SSH) workspace: file and code tools run there
        self.interactive = False  # someone is watching the chat live (begin_turn sets it), so ask_user can reach them
        self.plan = False  # plan mode (planmode.py): read-only research, then a plan for the owner to approve
        self.loop_guard = LoopGuard(settings)
        self._current_round = 0

    def enabled_tools(self, info):
        if "tools" not in info["capabilities"]:
            return []
        switches = db.kv_get("tool_switches", {})
        names = [t for t in self.agent.get("tools", []) if t in TOOLS and switches.get(t, True)
                 and TOOLS[t].get("scope") not in ("project", "skills", "group", "global")]
        if not self.project_id and groups.group_of(self.conv_id):  # chats in a Project get its knowledge tools
            names += [t for t in groups.PROJECT_TOOLS if t in TOOLS and switches.get(t, True)]
        if switches.get("library", True) and library.allowed(self.agent, self.settings):
            names.append("library")  # every agent, wherever it works, can reach everything Shell:B has made
        if switches.get("codex", True) and codex.allowed(self.agent, self.settings):
            names.append("codex")  # the owner's long-term reference shelf (codex.py), searched on demand
        if switches.get("follow_ups", True) and "follow_ups" in TOOLS and commitments.tool_allowed(self.agent, self.settings):
            names.append("follow_ups")  # the owner's to-dos and reminders (commitments.py)
        if switches.get("asset_library", True) and library.allowed(self.agent, self.settings):
            names.append("asset_library")  # reusable asset libraries (assets.py), shared by every chat and project
        if switches.get("wiki", True) and "wiki" in TOOLS and wiki.available():
            names.append("wiki")  # offline Wikipedia & co. (wiki.py), for every agent once an archive is installed
        if switches.get("legal", True) and "legal" in TOOLS and legal.available():
            names.append("legal")  # offline US/EU law (legal.py), for every agent once the index is built
        if "web_search" in names and "track_flight" in TOOLS and switches.get("track_flight", True):
            names.append("track_flight")  # live ADS-B (flights.py); online like web search, so only for agents that search
        if "web_search" in names and "weather" in TOOLS and switches.get("weather", True):
            names.append("weather")  # Open-Meteo (weather.py), same online gate
        if "web_search" in names and "shop" in TOOLS and switches.get("shop", True):
            names.append("shop")  # price comparison, basket and cart links (shopping.py), same online gate
        if "web_search" in names and "geocode" in TOOLS and switches.get("geocode", True):
            names.append("geocode")  # OSM place lookup (weather.py), same online gate
        if "directions" in TOOLS and switches.get("directions", True) and places.regions():
            names.append("directions")  # offline Valhalla (routing.py); no internet needed, so not tied to web_search
        if self.depth == 0 and asset_libs.job_of(self.conv_id):  # an asset scout run gets the whole collecting kit
            names += [t for t in ("scrape", "web_search", "web_fetch", "run_code", "view_document")
                      if t not in names and t in TOOLS and switches.get(t, True)]
        if skills.for_agent(self.agent):  # agents with skills get the loader tools automatically
            names += [t for t in ("use_skill", "read_skill_file") if t in TOOLS and switches.get(t, True)]
        if self.remote:  # the remote kit replaces the local project tools and the sandbox
            names = [t for t in names if t not in remote.TOOLS] + [t for t in remote.TOOLS if switches.get(t, True)]
        elif self.project_id:  # every agent working in a Studio project gets the file + vision tools
            names += [t for t, spec in TOOLS.items() if spec.get("scope") == "project" and switches.get(t, True)]
            code = (db.get_project(self.project_id) or {}).get("kind") == "code"
            for t in ("run_code",) if code else ("run_code", "generate_image", "generate_3d"):
                if t not in names and t in TOOLS and switches.get(t, True):
                    names.append(t)
            if selfmod.is_self(self.project_id) and "shellb_self" not in names and switches.get("shellb_self", True):
                names.append("shellb_self")  # whoever works in Shell:B's own source can inspect and deploy her
        lk = megaplan.link_of(self.conv_id) if self.depth == 0 else None
        if lk and lk["role"] == "orchestrator" and "mega_plan" not in names and switches.get("mega_plan", True):
            names.append("mega_plan")  # whoever orchestrates a plan needs the tool to review and edit it
        if self.depth == 0 and self.interactive and "ask_user" in TOOLS and switches.get("ask_user", True):
            names.append("ask_user")  # unattended runs (schedules, plans, scouts) have nobody to ask
        if self.depth == 0 and self.interactive and "look_at_screen" in TOOLS and switches.get("look_at_screen", True) \
                and "vision" in info["capabilities"] and screen.available() \
                and (not providers.is_cloud(self.model) or self.settings.get("cloudScreen", False)):
            names.append("look_at_screen")  # screen.py: only while the owner shares a screen, and only in a live chat
        if self.depth == 0 and "chat_transcript" in TOOLS and "chat_transcript" not in names and switches.get("chat_transcript", True) \
                and (providers.is_cloud(self.model) or self.user_request.startswith("/verify-chat")):
            names.append("chat_transcript")  # verify.py: lets an agent audit this chat's full record
        if self.depth > 0:
            names = [t for t in names if t != "ask_agent"]
        if providers.is_cloud(self.model) and not self.settings.get("cloudMemory", False):
            names = [t for t in names if t not in ("memory_save", "memory_forget", "memory_search", "recall_conversations", "leave_message", "check_messages")]
        import privacy
        if privacy.is_incognito(self.conv_id):  # incognito: nothing recalled, nothing remembered
            names = [t for t in names if t not in privacy.MEMORY_TOOLS]
        import adult
        if adult.is_adult(self.agent):
            self.mcp_specs = {}
            return [t for t in names if t in adult.TOOLS_ALLOWED]
        names = [t for t in names if t not in adult.TOOLS_ALLOWED]
        if self.plan:  # MCP tools are unknown quantities, so planning goes without them
            self.mcp_specs = {}
            return [t for t in names if planmode.offered(t)]
        servers = [t.split(":", 1)[1] for t in self.agent.get("tools", []) if t.startswith("mcp:")]
        self.mcp_specs = mcp_hub.tool_specs(servers)
        return names + list(self.mcp_specs)

    async def run(self, messages, sink: Sink, effort: str):
        info = await model_info(self.model)
        tool_names = self.enabled_tools(info)
        self.offered = set(tool_names)  # _run_tools refuses anything else, whatever name the model makes up
        schemas = [ask_agent_schema(delegates(self.agent, self.agents, self.settings)) if n == "ask_agent"
                   else self.mcp_specs[n]["schema"] if n in self.mcp_specs
                   else remote.TOOLS[n]["schema"] if self.remote and n in remote.TOOLS else TOOLS[n]["schema"] for n in tool_names]
        cloud = providers.is_cloud(self.model)
        if cloud:
            ok, why = providers.available(self.model, self.settings)
            if not ok:
                raise RuntimeError(why)
        think = think_param(effort, info, self.model)
        options = {"temperature": float(self.agent.get("temperature", 0.6))}
        if self.agent.get("numCtx"):
            options["num_ctx"] = int(self.agent["numCtx"])
        loop_guard = self.loop_guard
        max_rounds = int(self.settings.get("maxToolRounds", 16))
        interval = loop_guard.interval
        hard_cap = loop_guard.hard_cap
        budget = max(max_rounds, interval) if loop_guard.enabled else max_rounds
        if providers.is_cli(self.model):
            return await self._run_cli(messages, sink, effort, schemas, budget, loop_guard)

        num_ctx = int(options.get("num_ctx") or info.get("numCtx") or 32768)
        schema_chars = len(json.dumps(schemas, ensure_ascii=False))
        retried_cutoff = False
        round_ = 0
        while round_ <= budget:
            self._current_round = round_
            gone = fit_turn_context(messages, num_ctx, schema_chars)
            if gone and messages[-1].get("role") == "tool":
                messages[-1]["content"] += (f"\n\n[Your context is filling up: {gone} older tool results were removed. "
                                            "Read only what you still need, then write your answer.]")
                log.info("turn %s: elided %d tool results to fit num_ctx=%d", self.message_id, gone, num_ctx)
            payload = {"model": self.model, "messages": messages, "stream": True, "options": options, "keep_alive": "2h"}
            if schemas and round_ < budget:
                payload["tools"] = schemas
            if think is not None:
                payload["think"] = think
            native = None
            if cloud:
                content, thinking, tool_calls, native = await self._stream_cloud(
                    messages, schemas if round_ < budget else [], effort, sink)
            else:
                try:
                    content, thinking, tool_calls = await self._stream(payload, sink)
                except RuntimeError as e:  # Ollama couldn't parse the tool call the model wrote: sample it once more
                    if not BAD_TOOL_CALL.search(str(e)) or self.abort.is_set():
                        raise
                    content, thinking, tool_calls = await self._stream(payload, sink)
            if self.abort.is_set():
                return "stopped"
            if round_ == budget and not tool_calls and not content.strip():
                await sink.start({"type": "text", "text": f"*(Stopped after {budget} rounds of tool calls without a "
                                                          "final answer. Send a message to let me continue.)*"})
            asst = {"role": "assistant", "content": content}
            if thinking and not cloud:
                asst["thinking"] = thinking
            if tool_calls:
                asst["tool_calls"] = [{"function": tc["function"]} for tc in tool_calls] if not cloud else tool_calls
            if native:
                asst["_native"] = native
            messages.append(asst)
            if not tool_calls and not cloud and self._done_reason == "length" and not self.abort.is_set():
                # the context window filled up and Ollama cut the reply off: free room and ask for the answer once
                log.warning("turn %s: reply cut off at num_ctx=%d (round %d)", self.message_id, num_ctx, round_)
                if not retried_cutoff:
                    retried_cutoff = True
                    fit_turn_context(messages, num_ctx, schema_chars, keep_last=1, force=True)
                    messages.append({"role": "user", "content": (
                        "[Shell:B: your reply was cut off because your context window filled up. Older tool results "
                        "were removed to make room. Don't call more tools: write your complete final answer now from "
                        "what you found, and say what you could not cover.]")})
                    round_ += 1
                    continue
                await sink.start({"type": "text", "text": "*(My reply was cut off: the model's context window "
                                                          f"({num_ctx:,} tokens) filled up. Ask me to continue, or "
                                                          "narrow the request.)*"})
                return "complete"
            if not tool_calls:
                return "complete"
            results = await self._run_tools(tool_calls, sink)
            for tc, res in zip(tool_calls, results):
                body = res.text if len(res.text) <= 16000 else res.text[:16000] + "\n…[truncated]"
                msg = {"role": "tool", "tool_name": tc["function"]["name"], "content": body}
                if cloud:
                    msg["tool_call_id"] = tc.get("id", "")
                    msg["is_error"] = res.error
                if res.model_images:
                    msg["images"] = res.model_images
                messages.append(msg)

            # Warning on consecutive tool errors
            err_warn = loop_guard.check_consecutive_errors()
            if err_warn and messages[-1].get("role") == "tool":
                messages[-1]["content"] += err_warn

            # Milestone runaway loop check every X turns
            if loop_guard.enabled and (round_ + 1) % interval == 0:
                dec, note = loop_guard.evaluate_checkpoint(round_ + 1)
                if dec == "extend":
                    if round_ + 1 + interval > budget and budget < hard_cap:
                        budget = min(budget + interval, hard_cap)
                elif dec == "warn":
                    if messages[-1].get("role") == "tool":
                        messages[-1]["content"] += note
                elif dec == "terminate":
                    await sink.start({"type": "text", "text": note})
                    return "complete"

            if round_ + 1 == budget and messages[-1].get("role") == "tool":  # the next round has no tools
                messages[-1]["content"] += ("\n\n[That was your last tool round. Answer the user now: what you found, "
                                            "what is left to do and what got in the way.]")
            if self.abort.is_set():
                return "stopped"
            round_ += 1
        return "complete"

    async def _stream(self, payload, sink: Sink):
        """One Ollama /api/chat call. The read runs as a task raced against Stop and a silence watchdog: Ollama
        sends nothing while a model writes a tool call (or evaluates a long prompt), so a check per chunk alone
        can't see Stop, and a model looping inside a tool call would hold the turn and the GPU forever."""
        stall = float(self.settings.get("streamStallMinutes", 10)) * 60
        self._last_chunk, self._think = time.monotonic(), (None, 0.0)
        work = asyncio.create_task(self._stream_read(payload, sink, stall))
        stop = asyncio.create_task(self.abort.wait())
        try:
            while not work.done():
                await asyncio.wait({work, stop}, timeout=5, return_when=asyncio.FIRST_COMPLETED)
                if work.done():
                    break
                quiet = time.monotonic() - self._last_chunk
                if stop.done() or quiet > stall:
                    work.cancel()  # leaving the stream closes the connection, and Ollama drops the generation
                    try:
                        await work
                    except (asyncio.CancelledError, Exception):
                        pass
                    await self._close_thinking(sink, *self._think)
                    await sink.flush()
                    if stop.done():
                        return "", "", []  # the caller sees the abort and ends the turn as stopped
                    raise RuntimeError(f"{self.model} sent nothing for over {stall / 60:g} minutes, so the turn was ended "
                                       "(the model may be stuck repeating itself). Send a message to try again.")
            return work.result()
        finally:
            stop.cancel()
            if not work.done():
                work.cancel()

    async def _close_thinking(self, sink: Sink, cur_think, think_started):
        if cur_think is not None and "durationMs" not in sink.blocks[cur_think]:
            sink.blocks[cur_think]["durationMs"] = int((time.time() - think_started) * 1000)
            await sink.update(cur_think)

    async def _stream_read(self, payload, sink: Sink, stall):
        content, thinking, tool_calls = "", "", []
        cur_think = cur_text = None
        think_started = 0.0
        self._done_reason = None
        async with httpx.AsyncClient(timeout=httpx.Timeout(stall + 60, connect=10)) as c:
            async with c.stream("POST", f"{OLLAMA}/api/chat", json=payload) as r:
                if r.status_code != 200:
                    raise RuntimeError(f"Ollama {r.status_code}: {(await r.aread()).decode()[:500]}")
                async for line in r.aiter_lines():
                    self._last_chunk = time.monotonic()
                    if self.abort.is_set():
                        break
                    if not line.strip():
                        continue
                    chunk = json.loads(line)
                    if chunk.get("error"):
                        raise RuntimeError(chunk["error"])
                    m = chunk.get("message") or {}
                    if m.get("thinking"):
                        if cur_think is None:
                            think_started = time.time()
                            cur_think = await sink.start({"type": "thinking", "text": "", "startedAt": think_started * 1000})
                            self._think = (cur_think, think_started)
                        thinking += m["thinking"]
                        await sink.delta(cur_think, m["thinking"])
                    if m.get("content"):
                        if cur_think is not None and "durationMs" not in sink.blocks[cur_think]:
                            sink.blocks[cur_think]["durationMs"] = int((time.time() - think_started) * 1000)
                            await sink.update(cur_think)
                        if cur_text is None:
                            cur_text = await sink.start({"type": "text", "text": ""})
                        content += m["content"]
                        await sink.delta(cur_text, m["content"])
                    for tc in m.get("tool_calls") or []:
                        fn = tc.get("function", {})
                        args = fn.get("arguments", {})
                        if isinstance(args, str):
                            try:
                                args = json.loads(args)
                            except json.JSONDecodeError:
                                args = {"_raw": args}
                        tool_calls.append({"function": {"name": fn.get("name", ""), "arguments": args}})
                    if chunk.get("done"):
                        self._done_reason = chunk.get("done_reason")  # "length" = cut off at num_ctx/num_predict
                        self.usage["prompt"] += chunk.get("prompt_eval_count", 0)
                        self.usage["completion"] += chunk.get("eval_count", 0)
        await self._close_thinking(sink, cur_think, think_started)
        await sink.flush()
        return content, thinking, tool_calls

    async def _stream_cloud(self, messages, schemas, effort, sink: Sink):
        state = {"think": None, "text": None, "t0": 0.0}

        async def close_thinking():
            i = state["think"]
            if i is not None and "durationMs" not in sink.blocks[i]:
                sink.blocks[i]["durationMs"] = int((time.time() - state["t0"]) * 1000)
                await sink.update(i)

        async def on_thinking(t):
            if state["think"] is None:
                state["t0"] = time.time()
                state["think"] = await sink.start({"type": "thinking", "text": "", "startedAt": state["t0"] * 1000})
            await sink.delta(state["think"], t)

        async def on_text(t):
            await close_thinking()
            if state["text"] is None:
                state["text"] = await sink.start({"type": "text", "text": ""})
            await sink.delta(state["text"], t)

        out = await providers.stream(self.model, messages, schemas, effort, self.agent.get("temperature", 0.6),
                                     on_thinking, on_text, self.abort)
        await close_thinking()
        await sink.flush()
        self.usage["prompt"] += out.prompt_tokens
        self.usage["completion"] += out.completion_tokens
        return out.content, out.thinking, out.tool_calls, out.native

    async def _run_cli(self, messages, sink: Sink, effort, schemas, max_rounds, loop_guard: LoopGuard | None = None):
        """A CLI agent's turn (cli_agents.py): the CLI loops on its own and calls Shell:B's tools through the
        bridge; each call lands in _run_tools here, so it gets the same cards, approvals and Stop."""
        state = {"think": None, "text": None, "t0": 0.0, "busy": 0, "calls": 0, "budget": max_rounds}
        pending: set[asyncio.Task] = set()

        async def close_thinking():
            i = state["think"]
            if i is not None and "durationMs" not in sink.blocks[i]:
                sink.blocks[i]["durationMs"] = int((time.time() - state["t0"]) * 1000)
                await sink.update(i)

        async def on_thinking(t):
            if state["think"] is None:
                state["t0"] = time.time()
                state["think"] = await sink.start({"type": "thinking", "text": "", "startedAt": state["t0"] * 1000})
            await sink.delta(state["think"], t)

        async def on_text(t):
            await close_thinking()
            if state["text"] is None:
                if not t.strip():
                    return
                state["text"] = await sink.start({"type": "text", "text": ""})
            await sink.delta(state["text"], t)

        async def call(name, args):
            await close_thinking()
            state["text"] = state["think"] = None  # text after the tool goes into a new block, below its card
            if self.abort.is_set():
                return {"content": [{"type": "text", "text": "The user stopped this turn."}], "isError": True}
            state["calls"] += 1
            if loop_guard and loop_guard.enabled and state["calls"] % loop_guard.interval == 0:
                dec, note = loop_guard.evaluate_checkpoint(state["calls"])
                if dec == "extend":
                    if state["calls"] + loop_guard.interval > state["budget"]:
                        state["budget"] = min(state["budget"] + loop_guard.interval, loop_guard.hard_cap)
                elif dec == "terminate":
                    return {"content": [{"type": "text", "text": note}], "isError": True}
            if state["calls"] > state["budget"]:
                return {"content": [{"type": "text", "text": f"Tool budget used up ({state['budget']} calls). Don't call more "
                                     "tools: answer the user now with what you found, what is left and what got in the way."}],
                        "isError": True}
            state["busy"] += 1
            # shielded: if the CLI dies (Stop) and drops the bridge request, the tool still finishes and its card settles
            task = asyncio.create_task(self._run_tools([{"function": {"name": name, "arguments": args if isinstance(args, dict) else {}}}], sink))
            pending.add(task)
            task.add_done_callback(pending.discard)
            try:
                res = (await asyncio.shield(task))[0]
            finally:
                state["busy"] -= 1
            body = res.text if len(res.text) <= 16000 else res.text[:16000] + "\n…[truncated]"
            content = [{"type": "text", "text": body or "(no output)"}]
            content += [{"type": "image", "data": b, "mimeType": providers._mime(b)} for b in res.model_images or []]
            return {"content": content, "isError": bool(res.error)}

        system, prompt, images = cli_agents.render_prompt(messages)
        key, resume = self._cli_resume(messages)
        if resume:
            prompt = resume["prompt"]

        async def go(sid):
            return await cli_agents.run(self.model, system, prompt, images, effort, on_text=on_text, on_thinking=on_thinking,
                                        abort=self.abort, tools=cli_agents.mcp_tools(schemas), call=call,
                                        busy=lambda: state["busy"] > 0, resume=sid,
                                        stall_s=float(self.settings.get("streamStallMinutes", 10)) * 60)
        try:
            r = await go(resume and resume["sid"])
        except RuntimeError:
            # the saved session is gone or broken: if nothing happened yet, start over with the whole transcript
            if not resume or state["calls"] or state["text"] is not None or self.abort.is_set():
                raise
            db.kv_set(key, None)
            system, prompt, images = cli_agents.render_prompt(messages)
            r = await go(None)
        if key and r.get("session"):
            db.kv_set(key, {"pid": providers.split(self.model)[0], "sid": r["session"], "lastMsg": self.message_id,
                            "model": self.model, "at": time.time()})
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        await close_thinking()
        await sink.flush()
        self.usage["prompt"] += r["usage"]["prompt"]
        self.usage["completion"] += r["usage"]["completion"]
        messages.append({"role": "assistant", "content": r["text"]})
        return "stopped" if r["stopped"] or self.abort.is_set() else "complete"

    def _cli_resume(self, messages):
        """(kv key, resume) for a CLI turn. resume = {"sid", "prompt"} when the CLI's own session from this agent's last
        reply in this chat can carry on: then only what's new is sent (other agents' turns since, and the new message).
        A fresh session (and the full transcript) when there is none, when that reply was edited away or regenerated,
        for sub-agents, and for turns sent without history (freshContext)."""
        if self.depth > 0 or not self.conv_id:
            return None, None
        key = f"cli_session:{self.conv_id}:{self.agent['id']}"
        sess = db.kv_get(key)
        prior = [m for m in messages if m["role"] in ("user", "assistant")][:-1]
        if not sess or sess.get("pid") == "codex" or sess.get("pid") != (providers.split(self.model) or ("",))[0] or not prior:
            return key, None
        hist = db.list_messages(self.conv_id)
        ids = [m["id"] for m in hist]
        if sess.get("lastMsg") not in ids:
            return key, None
        tail = hist[ids.index(sess["lastMsg"]) + 1:]
        if tail and tail[-1]["role"] == "user":  # the message this turn answers
            tail = tail[:-1]
        latest = messages[-1].get("content", "")
        if tail:
            lines = [f"<{m['role']}>\n{user_payload(m, self.conv_id, include_images=False)['content'] if m['role'] == 'user' else assistant_text(m)}\n</{m['role']}>"
                     for m in tail if m["role"] in ("user", "assistant")]
            latest = ("<since_your_last_reply>\n" + "\n".join(lines) + "\n</since_your_last_reply>\n\n"
                      "Those messages were added to the chat since your last reply (other agents may have answered). "
                      "The user's new message follows.\n" + latest)
        return key, {"sid": sess["sid"], "prompt": latest}

    async def _run_tools(self, tool_calls, sink: Sink):
        idxs = []
        for tc in tool_calls:
            name, args = tc["function"]["name"], tc["function"]["arguments"]
            idxs.append(await sink.start({"type": "tool", "name": name, "args": args, "status": "running",
                                          "startedAt": time.time() * 1000, "agentId": self.agent["id"]}))

        async def one(tc, idx):
            name, args = tc["function"]["name"], tc["function"]["arguments"]
            t0 = time.time()
            ctx = ToolContext(self.conv_id, self.message_id, self.agent, self.settings, self.emit,
                              run_subagent=self._subagent_runner(sink, idx), depth=self.depth, project_id=self.project_id,
                              user_request=self.user_request)
            try:
                loop_err = self.loop_guard.check_pre_call(name, args) if hasattr(self, "loop_guard") else None
                if loop_err:
                    res = ToolResult(loop_err, error=True)
                elif isinstance(args, dict):
                    _fix_enums(args, (remote.TOOLS if self.remote and name in remote.TOOLS else TOOLS).get(name, {}).get("schema"))
                if not loop_err:
                    if isinstance(args, dict) and args.get("_truncated"):
                        res = ToolResult("The tool input was cut off (output limit reached). Send a smaller input.", error=True)
                    elif getattr(self, "offered", None) is not None and name not in self.offered:
                        res = ToolResult(f"{name!r} isn't one of your tools in this chat.", error=True)
                    elif self.plan and not planmode.allowed(name, args):
                        res = ToolResult(planmode.refusal(name, args), error=True)
                    elif self.remote and name in remote.TOOLS:
                        res = await self._remote_tool(name, args, ctx, sink, idx)
                    elif name == "shellb_self" and isinstance(args, dict) and args.get("action") in selfmod.GATED:
                        res = await self._self_change(args, ctx, sink, idx)
                    elif name == "ask_user" and self.interactive and self.depth == 0:
                        res = await ask.run(args, self.conv_id, self.abort, sink, idx)
                    elif name == "codex" and isinstance(args, dict) and args.get("action") == "request":
                        res = await self._secret_request(args, ctx, sink, idx)
                    elif name == "schedule_task" and isinstance(args, dict) \
                            and str(args.get("action") or "create").lower() == "create":
                        res = await self._schedule_request(args, ctx, sink, idx)
                    elif name == "find_capability" and isinstance(args, dict) and args.get("action") == "propose":
                        res = await self._capability_proposal(args, ctx, sink, idx)
                    elif name in self.mcp_specs:
                        res = await mcp_hub.call(self.mcp_specs[name], args, ctx)
                    elif name not in TOOLS:
                        res = ToolResult(f"Unknown tool {name!r}.", error=True)
                    else:
                        res = await TOOLS[name]["fn"](args, ctx)
            except Exception as e:  # tool failures go back to the model, which can retry or explain
                res = ToolResult(f"{name} failed: {type(e).__name__}: {e}", error=True)
            try:  # bookkeeping must never turn a finished tool call into a failed turn
                if hasattr(self, "loop_guard"):
                    self.loop_guard.record_post_call(name, args, res, getattr(self, "_current_round", 0))
            except Exception as e:
                print(f"loop_guard.record_post_call: {type(e).__name__}: {e}")
            try:  # pages read in a chat attached to a research board land on it as sources
                research.auto_capture(self.conv_id, name, args, res)
            except Exception:
                pass
            try:
                if res.display and not res.error:  # generated pictures, sounds and models go into Library → Media
                    media.record(name, res.display, self.conv_id, self.agent.get("id"), self.project_id)
            except Exception as e:
                print(f"media.record: {type(e).__name__}: {e}")
            b = sink.blocks[idx]
            b.update(status="error" if res.error else "done", durationMs=int((time.time() - t0) * 1000),
                     result=res.text if len(res.text) <= 6000 else res.text[:6000] + "\n…", display=res.display)
            await sink.update(idx)
            return res

        # return_exceptions: one call that blows up must not abandon its siblings mid-run with cards stuck on "running"
        results = await asyncio.gather(*(one(tc, i) for tc, i in zip(tool_calls, idxs)), return_exceptions=True)
        out = []
        for r, tc, idx in zip(results, tool_calls, idxs):
            if isinstance(r, BaseException) and not isinstance(r, Exception):
                raise r  # cancellation (Stop) still propagates
            if isinstance(r, Exception):
                r = ToolResult(f"{tc['function']['name']} failed: {type(r).__name__}: {r}", error=True)
                sink.blocks[idx].update(status="error", result=r.text)
                await sink.update(idx)
            out.append(r)
        return out

    async def _remote_tool(self, name, args, ctx, sink: Sink, idx):
        """Run a tool in the remote workspace, first asking the owner when it changes something (remote.GATED)."""
        if remote.needs_approval(self.project_id, name, self.message_id):
            aid = uuid.uuid4().hex
            b = sink.blocks[idx]
            b.update(status="approval", approval={"id": aid})
            await sink.update(idx)
            detail = args.get("code") or args.get("command") or args.get("path") or json.dumps(args)[:2000]
            decision = await remote.wait_approval(aid, self.abort, {"kind": "remote", "conv": self.conv_id,
                                                                    "title": f"{name} on the remote host", "detail": str(detail)})
            b.pop("approval", None)
            b.update(status="running", decision=decision)
            await sink.update(idx)
            if decision == "allow_turn":
                remote._turn_allow.add(self.message_id)
            elif decision != "allow":
                why = {"deny": "The owner denied this call.", "timeout": "Nobody approved this call within 15 minutes.",
                       "stopped": "The turn was stopped."}[decision]
                return ToolResult(f"{why} It did not run. Don't retry it unchanged; ask the user how to proceed.", error=True)
        return await remote.TOOLS[name]["fn"](args, ctx)

    async def _self_change(self, args, ctx, sink: Sink, idx):
        """Deploy or roll back Shell:B's own code: run the checks, then wait for the owner to approve the diff."""
        plan = await selfmod.prepare_gated(args, ctx)
        if isinstance(plan, ToolResult):
            return plan
        aid = uuid.uuid4().hex
        b = sink.blocks[idx]
        b.update(status="approval", approval={"id": aid, "kind": "self", "title": plan["title"], "detail": plan["preview"]})
        await sink.update(idx)
        decision = await remote.wait_approval(aid, self.abort, {"kind": "self", "conv": self.conv_id,
                                                                "title": plan["title"], "detail": plan["preview"]})
        b.pop("approval", None)
        b.update(status="running", decision=decision)
        await sink.update(idx)
        if decision not in ("allow", "allow_turn"):
            why = {"deny": "The owner declined.", "timeout": "Nobody approved it within 15 minutes.",
                   "stopped": "The turn was stopped."}[decision]
            return ToolResult(f"{why} Nothing changed in the live app. Don't retry unchanged; ask what to adjust.", error=True)
        return await selfmod.apply_gated(plan, ctx)

    async def _secret_request(self, args, ctx, sink: Sink, idx):
        """An API call that uses Codex secrets: checked first, then (unless the owner turned it off) approved by the owner."""
        import codex_secrets
        plan = codex_secrets.prepare(args)
        if isinstance(plan, ToolResult):
            return plan
        if plan["ask"]:
            aid = uuid.uuid4().hex
            b = sink.blocks[idx]
            b.update(status="approval", approval={"id": aid, "kind": "secret", "title": plan["title"], "detail": plan["detail"]})
            await sink.update(idx)
            decision = await remote.wait_approval(aid, self.abort, {"kind": "secret", "conv": self.conv_id,
                                                                    "title": plan["title"], "detail": plan["detail"]})
            b.pop("approval", None)
            b.update(status="running", decision=decision)
            await sink.update(idx)
            if decision not in ("allow", "allow_turn"):
                why = {"deny": "The owner declined.", "timeout": "Nobody approved it within 15 minutes.",
                       "stopped": "The turn was stopped."}[decision]
                return ToolResult(f"{why} The request was not sent. Don't retry unchanged; ask the user how to proceed.", error=True)
        return await codex_secrets.perform(plan, ctx)

    async def _schedule_request(self, args, ctx, sink: Sink, idx):
        """A new scheduled task runs unattended with this agent's tools, again and again, so the owner approves it. Live
        chats ask right away; unattended turns (sub-agents, plans, scheduled runs) save it switched off for review."""
        import schedules
        args = {k: v for k, v in args.items() if k != "_pending"}
        if not (self.interactive and self.depth == 0):
            return await schedules.schedule_task({**args, "_pending": True}, ctx)
        when = args.get("cron") or args.get("at") or "?"
        title = f"Schedule “{str(args.get('name') or args.get('prompt') or '')[:60]}”"
        detail = (f"When: {when} ({args.get('tz') or self.settings.get('timeZone') or 'UTC'})\n"
                  f"Runs as: {args.get('agent') or self.agent.get('id')}\n\n{args.get('prompt') or ''}")
        aid = uuid.uuid4().hex
        b = sink.blocks[idx]
        b.update(status="approval", approval={"id": aid, "kind": "schedule", "title": title, "detail": detail})
        await sink.update(idx)
        decision = await remote.wait_approval(aid, self.abort, {"kind": "schedule", "conv": self.conv_id,
                                                                "title": title, "detail": detail})
        b.pop("approval", None)
        b.update(status="running", decision=decision)
        await sink.update(idx)
        if decision not in ("allow", "allow_turn"):
            why = {"deny": "The owner declined.", "timeout": "Nobody approved it within 15 minutes.",
                   "stopped": "The turn was stopped."}.get(decision, "Not approved.")
            return ToolResult(f"{why} Nothing was scheduled.", error=True)
        return await schedules.schedule_task(args, ctx)

    async def _capability_proposal(self, args, ctx, sink: Sink, idx):
        """Install a community skill or MCP server the agent found, once the owner approves it here. Only a live,
        top-level chat can ask; skills arrive switched on (the owner just read them), MCP servers switched off."""
        import community
        if not (self.interactive and self.depth == 0):
            return ToolResult("Only a live chat can propose installs; tell the user what you'd install and why.", error=True)
        try:
            plan = await community.prepare_proposal(str(args.get("id") or ""), str(args.get("option") or ""))
        except (KeyError, ValueError) as e:
            return ToolResult(f"Can't propose that: {e}", error=True)
        detail = (f"Why: {args['why']}\n\n" if args.get("why") else "") + plan["detail"]
        aid = uuid.uuid4().hex
        b = sink.blocks[idx]
        b.update(status="approval", approval={"id": aid, "kind": "install", "title": plan["title"], "detail": detail})
        await sink.update(idx)
        decision = await remote.wait_approval(aid, self.abort, {"kind": "install", "conv": self.conv_id,
                                                                "title": plan["title"], "detail": detail})
        b.pop("approval", None)
        b.update(status="running", decision=decision)
        await sink.update(idx)
        if decision not in ("allow", "allow_turn"):
            why = {"deny": "The owner declined.", "timeout": "Nobody approved it within 15 minutes.",
                   "stopped": "The turn was stopped."}.get(decision, "Not approved.")
            return ToolResult(f"{why} Nothing was installed.", error=True)
        try:
            res = await community.install(str(args["id"]), plan.get("option", ""), {}, "", enable_skill=True)
        except (KeyError, ValueError) as e:
            return ToolResult(f"Install failed: {e}", error=True)
        db.audit_log("community:install", {"id": args["id"], "as": res["name"], "by": self.agent.get("id")})
        if res["kind"] == "skill":
            return ToolResult(f"Installed the skill `{res['name']}` and switched it on; call use_skill to load it.")
        await mcp_hub.sync()
        return ToolResult(f"Installed the MCP server `{res['name']}` switched OFF"
                          + (f" (it still needs: {', '.join(res['missing'])})" if res.get("missing") else "")
                          + ". The owner turns it on under Tools → Servers, then adds it to an agent as mcp:" + res["name"] + ".")

    def _subagent_runner(self, parent_sink: Sink, parent_idx: int):
        async def run_sub(agent_id: str, task: str) -> str:
            import adult
            sub_agent = next((a for a in self.agents if a["id"] == agent_id and not adult.is_adult(a)), None)
            if sub_agent is None:
                return f"No agent named {agent_id!r}. Available: {', '.join(a['id'] for a in self.agents if not adult.is_adult(a))}"
            import prompts
            allowed = {a["id"] for a in prompts.delegates(self.agent, self.agents, self.settings)}
            if agent_id not in allowed:  # the tool's enum is only a hint to the model; this is the rule (cloudDelegation etc.)
                return (f"{agent_id!r} isn't available to you right now (cloud agents need Cloud AI and delegation switched "
                        f"on). You can ask: {', '.join(sorted(allowed)) or 'nobody'}.")
            parent = parent_sink.blocks[parent_idx]
            parent["children"] = []

            async def sub_emit(ev):
                # artifacts made by the sub-agent surface in the conversation; everything else is summarized
                if ev.get("type") == "artifact":
                    await self.emit(ev)
                elif ev.get("type") in ("block_start", "block_update") and ev["block"]["type"] == "tool":
                    b = ev["block"]
                    kids = parent["children"]
                    entry = {"name": b["name"], "status": b["status"], "args": _short_args(b.get("args"))}
                    if ev["type"] == "block_start":
                        kids.append(entry)
                    else:
                        for k in reversed(kids):
                            if k["name"] == b["name"] and k["status"] == "running":
                                k.update(entry)
                                break
                    await parent_sink.update(parent_idx)

            async def sub_emit_all(ev):
                if ev.get("type") == "file":
                    await self.emit(ev)
                else:
                    await sub_emit(ev)

            sub = Turn(self.conv_id, self.message_id, sub_agent, self.agents, self.settings, sub_emit_all, self.abort,
                       depth=1, project_id=self.project_id)
            sub.plan = self.plan  # a planning turn's helpers only research too
            sub.user_request = task[:800]
            info = await model_info(sub_agent["model"])
            system = build_system(sub_agent, sub.enabled_tools(info), sub_agent.get("effort", "medium"),
                                  db.latest_artifacts(self.conv_id), [], self.agents, self.settings, project_id=self.project_id,
                                  group_id=None if self.project_id else groups.group_of(self.conv_id), conv_id=self.conv_id,
                                  user_text=task)
            if sub.plan:
                system += ("\n\n[Plan mode: the user hasn't approved any changes yet. Research with read-only tools and "
                           "report what you find and what you'd do; change nothing.]")
            msgs = [{"role": "system", "content": system}, {"role": "user", "content": task}]
            sub_sink = Sink(sub_emit_all)
            await sub.run(msgs, sub_sink, sub_agent.get("effort", "medium"))
            self.usage["prompt"] += sub.usage["prompt"]
            self.usage["completion"] += sub.usage["completion"]
            text = "\n\n".join(b["text"] for b in sub_sink.blocks if b["type"] == "text").strip()
            return text or "(the agent returned no text)"
        return run_sub


def _fix_enums(args: dict, schema: dict | None):
    """Repair enum values the model mangled. Qwen's XML-style tool calls sometimes leak markup into a value
    ("source>", "<bash"); without this the model sees "unknown action" and retries the same thing forever."""
    props = ((schema or {}).get("function") or {}).get("parameters", {}).get("properties", {})
    for k, v in args.items():
        allowed = (props.get(k) or {}).get("enum")
        if not allowed or not isinstance(v, str) or v in allowed:
            continue
        clean = v.strip().strip("<>/\"'`= \n\t").lower()
        match = [a for a in allowed if isinstance(a, str) and a.lower() == clean]
        if match:
            args[k] = match[0]


def _short_args(args):
    if not isinstance(args, dict):
        return str(args)[:120]
    for k in ("query", "url", "prompt", "title", "task", "text"):
        if k in args:
            return str(args[k])[:120]
    if "code" in args:
        return str(args["code"]).strip().splitlines()[0][:120] if str(args["code"]).strip() else ""
    return json.dumps(args)[:120]


async def recall(agent, text, settings):
    if not ({"memory_search", "memory_save"} & set(agent.get("tools", []))):
        return []
    cloud = providers.is_cloud(agent.get("model", ""))
    if cloud and not settings.get("cloudMemory", False):
        return []
    try:
        return await memory.recall(text, settings, cloud=cloud)  # local-only memories never reach a cloud agent
    except Exception:
        return []


async def make_title(user_text, reply, settings):
    prompt = ("Write a short title (3-6 words) for a conversation that starts like this. Reply with the title only, "
              f"no quotes or punctuation at the end.\n\nUser: {user_text[:600]}\n\nAssistant: {reply[:600]}")
    payload = {"model": settings["utilityModel"], "messages": [{"role": "user", "content": prompt}],
               "stream": False, "keep_alive": "2h", "options": {"temperature": 0.3, "num_predict": 24}}
    info = await model_info(settings["utilityModel"])
    if "thinking" in info["capabilities"]:
        payload["think"] = False
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(f"{OLLAMA}/api/chat", json=payload)
        r.raise_for_status()
    title = r.json()["message"]["content"].strip().strip('"\'*#').splitlines()[0]
    return title[:60] or None
