"""CLI agents: Shell:B agents that think through the owner's logged-in Claude Code, Antigravity or Codex CLI.

Model names look like `claude-code/opus`, `antigravity/gemini-3.1-pro-high` or `codex/gpt-5.5`. A turn runs the CLI
once in print mode. The CLI drives its own tool loop, but its built-in tools (shell, files, browser, web) are switched
off or denied, and the only tools it has are Shell:B's, offered by cli_bridge.py over MCP. Each bridged call comes back
here (SESSIONS) and runs inside the live Turn, so approvals, Stop and the chat's tool cards work as they do for every
other agent. No API keys: the CLIs use their own subscription logins.
"""
import asyncio
import base64
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

import db

CLIS = {
    "claude-code": {"name": "Claude Code", "product": "Claude", "vendor": "Anthropic", "bin": "claude",
                    "login": "claude  (then /login)", "native": 1_000_000},
    "antigravity": {"name": "Google Antigravity", "product": "Gemini", "vendor": "Google", "bin": "agy",
                    "login": "agy  (sign in with Google)", "native": 1_000_000},
    "codex": {"name": "OpenAI Codex", "product": "OpenAI", "vendor": "OpenAI", "bin": "codex",
              "login": "codex login --device-auth", "native": 400_000},
}
BRIDGE = Path(__file__).with_name("cli_bridge.py")
DATA = db.DATA
RUNS = DATA / "cli-runs"  # one empty working dir per run: nothing for a CLI to pick up (CLAUDE.md, AGENTS.md, .git)
AGY_HOME = DATA / "cli-home" / "antigravity"  # Antigravity reads its settings from $HOME, so it gets its own
# Codex's built-in tools, all switched off: the bridge is the only way it can act
CODEX_OFF = ("shell_tool", "unified_exec", "apps", "browser_use", "browser_use_external", "computer_use", "image_generation",
             "multi_agent", "plugins", "view_image", "code_mode_host", "hooks", "skill_search", "tool_suggest", "goals",
             "sleep_tool", "workspace_dependencies", "in_app_browser", "memories")
TOOL_NOTE = ("## Your tools\nYou run inside {cli} in headless mode, but its own tools (shell, file editing, browser, web) "
             "are switched off. Your only tools are Shell:B's, served by the MCP server `shellb`{how}. They run on "
             "Shell:B's machine, in the user's workspace. Don't read tool schema files: call the tools directly.")

SESSIONS: dict[str, dict] = {}  # bridge token → {"tools": [...], "call": async (name, args) -> MCP result}


def split(model: str):
    if "/" in (model or ""):
        p, m = model.split("/", 1)
        if p in CLIS:
            return p, m
    return None


def is_cli(model: str) -> bool:
    return split(model or "") is not None


def _bin(pid: str) -> str | None:
    name = CLIS[pid]["bin"]
    return shutil.which(name) or shutil.which(name, path=str(Path.home() / ".local/bin"))


# ── status and models ───────────────────────────────────────────────────────

_status_cache: dict[str, tuple[float, dict]] = {}
_models_cache: dict[str, tuple[float, list]] = {}


def _logged_in(pid: str, exe: str) -> tuple[bool, str]:
    try:
        if pid == "claude-code":
            r = subprocess.run([exe, "auth", "status"], capture_output=True, text=True, timeout=20, env=_env(pid))
            d = json.loads(r.stdout or "{}")
            return bool(d.get("loggedIn")), d.get("email") or d.get("authMethod") or ""
        if pid == "antigravity":
            return (Path.home() / ".gemini/antigravity-cli/antigravity-oauth-token").is_file(), ""
        r = subprocess.run([exe, "login", "status"], capture_output=True, text=True, timeout=20, env=_env(pid))
        return r.returncode == 0, (r.stdout or r.stderr).strip().splitlines()[0][:120] if (r.stdout or r.stderr).strip() else ""
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


_refreshing: set[str] = set()


def _probe(pid: str) -> dict:
    exe = _bin(pid)
    st = {"installed": bool(exe), "loggedIn": False, "account": ""}
    if exe:
        st["loggedIn"], st["account"] = _logged_in(pid, exe)
    _status_cache[pid] = (time.time(), st)
    _refreshing.discard(pid)
    return st


def status(pid: str, fresh=False) -> dict:
    """Installed / logged in. Probing runs the CLI (`claude auth status` can take seconds), and this is called from
    the event loop while prompts are built, so a stale answer is returned at once and refreshed in a thread."""
    hit = _status_cache.get(pid)
    if hit and not fresh:
        if time.time() - hit[0] >= 60 and pid not in _refreshing:
            _refreshing.add(pid)
            import threading
            threading.Thread(target=_probe, args=(pid,), daemon=True).start()
        return hit[1]
    return _probe(pid)


def public_status(fresh=False) -> dict:
    return {pid: {**meta, **status(pid, fresh)} for pid, meta in CLIS.items()}


def available(model: str) -> tuple[bool, str]:
    pid, _ = split(model)
    st = status(pid)
    if not st["installed"]:
        return False, f"The {CLIS[pid]['name']} CLI (`{CLIS[pid]['bin']}`) isn't installed on Shell:B's machine."
    if not st["loggedIn"]:
        return False, f"The {CLIS[pid]['name']} CLI isn't logged in. In a terminal on Shell:B's machine run: {CLIS[pid]['login']}"
    return True, ""


async def list_models(pid: str) -> list[dict]:
    hit = _models_cache.get(pid)
    if hit and time.time() - hit[0] < 600:
        return hit[1]
    exe = _bin(pid)
    out = []
    if pid == "claude-code":
        out = [{"id": "opus", "label": "Claude Opus (latest)"}, {"id": "sonnet", "label": "Claude Sonnet (latest)"},
               {"id": "haiku", "label": "Claude Haiku (latest)"}]
    elif exe:
        args = [exe, "models"] if pid == "antigravity" else [exe, "debug", "models"]
        p = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                                                 env=_env(pid), cwd=str(_run_root()))
        raw = (await asyncio.wait_for(p.communicate(), 60))[0].decode(errors="replace")
        if pid == "antigravity":
            for line in raw.splitlines():
                if "\t" in line:
                    mid, label = line.split("\t", 1)
                    out.append({"id": mid.strip(), "label": label.strip()})
        else:
            d = json.loads(raw)
            for m in d.get("models", d) if isinstance(d, dict) else d:
                if m.get("visibility", "list") == "list":
                    out.append({"id": m.get("slug") or m.get("id"), "label": m.get("display_name") or m.get("slug")})
    for m in out:
        m["context"] = CLIS[pid]["native"]
    _models_cache[pid] = (time.time(), out)
    return out


def model_info(model: str) -> dict:
    pid, mid = split(model)
    native = 200_000 if "haiku" in mid else CLIS[pid]["native"]
    return {"capabilities": ["completion", "tools", "vision", "thinking"], "numCtx": 131072, "nativeCtx": native,
            "family": pid, "parameterSize": "cloud", "quantization": f"{CLIS[pid]['name']} CLI", "cloud": True,
            "provider": pid, "cli": True}


# ── running a turn ──────────────────────────────────────────────────────────

def _run_root() -> Path:
    RUNS.mkdir(parents=True, exist_ok=True)
    return RUNS


def _agy_home() -> Path:
    """$HOME for Antigravity runs: the owner's login (symlinked), our own settings and MCP config."""
    real = Path.home() / ".gemini/antigravity-cli/antigravity-oauth-token"
    cli = AGY_HOME / ".gemini/antigravity-cli"
    cfg = AGY_HOME / ".gemini/config"
    cli.mkdir(parents=True, exist_ok=True)
    cfg.mkdir(parents=True, exist_ok=True)
    tok = cli / "antigravity-oauth-token"
    if not tok.is_symlink() and not tok.exists():
        tok.symlink_to(real)
    (cli / "settings.json").write_text(json.dumps({
        "permissions": {"allow": ["mcp(shellb/*)"],
                        "deny": ["command(*)", "read_file(*)", "write_file(*)", "read_url(*)"]},
        "trustedWorkspaces": [str(_run_root())]}, indent=2))
    (cfg / "mcp_config.json").write_text(json.dumps(
        {"mcpServers": {"shellb": {"command": sys.executable, "args": [str(BRIDGE)]}}}, indent=2))
    return AGY_HOME


def _env(pid: str, bridge_url: str = "") -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ANTHROPIC_", "OPENAI_", "GEMINI_", "GOOGLE_API"))}
    env["PATH"] = f"{Path.home() / '.local/bin'}:{env.get('PATH', '/usr/bin:/bin')}"
    env["SHELLB_BRIDGE"] = bridge_url
    if pid == "claude-code":
        env.update(MCP_TOOL_TIMEOUT="3600000", MCP_TIMEOUT="30000", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1")
    if pid == "antigravity":
        env["HOME"] = str(_agy_home())
    return env


def _toml(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)  # a JSON string is a valid TOML basic string when left as UTF-8


def _effort(pid, effort):
    if pid == "claude-code":
        return {"off": "low", "low": "low", "medium": "medium", "high": "high", "max": "max"}.get(effort, "medium")
    return {"off": "low", "low": "low", "medium": "medium", "high": "high", "max": "xhigh"}.get(effort, "medium")


def render_prompt(messages: list[dict]) -> tuple[str, str, list[str]]:
    """(system, prompt, images): Ollama-style messages flattened for a one-shot CLI run. Earlier turns become a
    transcript; the last user message is the request; its images are passed along when the CLI takes them."""
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
    rest = [m for m in messages if m["role"] != "system"]
    last = rest[-1] if rest and rest[-1]["role"] == "user" else {"content": "", "images": []}
    prior = rest[:-1] if rest and rest[-1]["role"] == "user" else rest
    parts = []
    if prior:
        lines = [f"<{m['role']}>\n{m.get('content', '')}\n</{m['role']}>" for m in prior if m["role"] in ("user", "assistant")]
        parts.append("<conversation_so_far>\n" + "\n".join(lines) + "\n</conversation_so_far>\n\n"
                     "The user's new message follows. Reply to it; the conversation above is context.\n")
    parts.append(last.get("content", ""))
    return system, "\n".join(parts), list(last.get("images") or [])


def _ext(b64: str) -> str:
    head = base64.b64decode(b64[:24] + "=" * (-len(b64[:24]) % 4))
    return ".jpg" if head.startswith(b"\xff\xd8") else ".gif" if head.startswith(b"GIF8") else ".webp" if head[8:12] == b"WEBP" else ".png"


def _argv(pid, mid, exe, run_dir: Path, system, prompt, images, effort, bridge_url, resume=None):
    """argv and stdin bytes. `resume` continues the CLI's own saved session, so only the new message goes in."""
    if pid == "claude-code":
        (run_dir / "system.md").write_text(system)
        argv = [exe, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
                "--input-format", "stream-json", "--model", mid, "--tools", "", "--setting-sources", "",
                "--disable-slash-commands", "--system-prompt-file", str(run_dir / "system.md"),
                "--effort", _effort(pid, effort)]
        if resume:
            argv += ["--resume", resume]
        if bridge_url:
            mcp = {"mcpServers": {"shellb": {"type": "stdio", "command": sys.executable, "args": [str(BRIDGE)],
                                             "env": {"SHELLB_BRIDGE": bridge_url}}}}
            argv += ["--strict-mcp-config", "--mcp-config", json.dumps(mcp), "--allowedTools", "mcp__shellb"]
        else:
            argv += ["--strict-mcp-config"]
        content = [{"type": "image", "source": {"type": "base64", "media_type": "image/" + _ext(b)[1:].replace("jpg", "jpeg"),
                                                "data": b}} for b in images]
        content.append({"type": "text", "text": prompt or "(empty message)"})
        stdin = json.dumps({"type": "user", "message": {"role": "user", "content": content}}) + "\n"
        return argv, stdin.encode()
    if pid == "antigravity":
        argv = [exe, "--output-format", "stream-json", "--model", mid, "--print-timeout", "0"]
        note = "\n\n[An image was attached, but this CLI can't receive it here.]" if images else ""
        if resume:  # it has no system-prompt flag: the instructions went in with the first message of the session
            argv += ["--conversation", resume]
            stdin = f"{prompt}{note}"
        else:
            stdin = f"<system_instructions>\n{system}\n</system_instructions>\n\n{prompt}{note}"
        return argv, stdin.encode()
    argv = [exe, "exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules",
            "-s", "read-only", "-m", mid, "-c", 'web_search="disabled"', "-c", 'approval_policy="never"',
            "-c", f"model_reasoning_effort={_toml(_effort(pid, effort))}"]
    for f in CODEX_OFF:
        argv += ["--disable", f]
    if bridge_url:
        argv += ["-c", f"mcp_servers.shellb.command={_toml(sys.executable)}", "-c", f"mcp_servers.shellb.args=[{_toml(str(BRIDGE))}]",
                 "-c", f"mcp_servers.shellb.env={{SHELLB_BRIDGE={_toml(bridge_url)}}}",
                 "-c", "mcp_servers.shellb.tool_timeout_sec=3600", "-c", "mcp_servers.shellb.startup_timeout_sec=30"]
    if len(system) < 100_000:  # one argv string is capped at 128 KiB
        argv += ["-c", f"developer_instructions={_toml(system)}"]
    else:
        prompt = f"<system_instructions>\n{system}\n</system_instructions>\n\n{prompt}"
    for i, b in enumerate(images):
        p = run_dir / f"image{i}{_ext(b)}"
        p.write_bytes(base64.b64decode(b))
        argv += ["-i", str(p)]
    argv.append("-")
    return argv, prompt.encode()


def tool_note(model: str) -> str:
    pid, _ = split(model)
    how = " (call them with call_mcp_tool, server name `shellb`)" if pid == "antigravity" else ""
    return TOOL_NOTE.format(cli=CLIS[pid]["name"], how=how)


async def run(model, system, prompt, images, effort, *, on_text, on_thinking, abort: asyncio.Event,
              tools: list[dict] | None = None, call=None, busy=lambda: False, stall_s=600.0, resume: str | None = None) -> dict:
    """Run one CLI turn. `tools` (MCP tool specs) and `call` give it Shell:B's tools through the bridge; without
    them it only writes text. `resume` is a session id from an earlier run (Claude Code and Antigravity).
    Returns {"text", "usage": {"prompt", "completion"}, "stopped", "session"}; raises on failure."""
    pid, mid = split(model)
    exe = _bin(pid)
    ok, why = available(model)
    if not ok:
        raise RuntimeError(why)
    token = uuid.uuid4().hex
    bridge_url = ""
    if tools is not None and call is not None:
        SESSIONS[token] = {"tools": tools, "call": call}
        bridge_url = f"http://127.0.0.1:{os.environ.get('SHELLB_PORT', '8200')}/api/cli-bridge/{token}"
    run_dir = _run_root() / token
    run_dir.mkdir()
    usage = {"prompt": 0, "completion": 0}
    texts: list[str] = []
    errors: list[str] = []
    state = {"step": None, "last": time.monotonic(), "session": None}

    async def text(t):
        texts.append(t)
        await on_text(t)

    async def handle(ev: dict):
        sid = ev.get("session_id") or ev.get("conversation_id") or (ev.get("init") or {}).get("conversation_id") \
            or (ev.get("thread_id") if ev.get("type") == "thread.started" else None)
        if sid and not state["session"]:
            state["session"] = sid
        if pid == "claude-code":
            t = ev.get("type")
            if t == "stream_event":
                d = (ev.get("event") or {}).get("delta") or {}
                if d.get("type") == "text_delta" and d.get("text"):
                    await text(d["text"])
                elif d.get("type") == "thinking_delta" and d.get("thinking"):
                    await on_thinking(d["thinking"])
            elif t == "result":
                u = ev.get("usage") or {}
                usage["prompt"] += u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
                usage["completion"] += u.get("output_tokens", 0)
                if ev.get("is_error"):
                    errors.append(str(ev.get("result") or ev.get("subtype") or "Claude Code reported an error"))
        elif pid == "antigravity":
            if ev.get("event") == "step_update":
                s = ev["step_update"]
                if s.get("step_type") != "agent_response":
                    return
                if s.get("thinking_delta"):
                    await on_thinking(s["thinking_delta"])
                if s.get("text_delta"):
                    if state["step"] not in (None, s.get("step_index")) and texts and not texts[-1].endswith("\n\n"):
                        await text("\n\n")
                    state["step"] = s.get("step_index")
                    await text(s["text_delta"])
                u = s.get("usage") or {}
                usage["prompt"] += u.get("input_tokens", 0)
                usage["completion"] += u.get("output_tokens", 0) + u.get("thinking_tokens", 0)
            elif ev.get("event") == "result":
                r = ev["result"]
                if r.get("status") not in ("SUCCESS", None):
                    errors.append(str(r.get("error") or r.get("response") or r.get("status")))
            elif ev.get("event") == "error" or ev.get("error"):
                errors.append(str(ev.get("error") or ev))
        else:
            t = ev.get("type", "")
            item = ev.get("item") or {}
            if t == "item.completed" and item.get("type") == "agent_message" and item.get("text"):
                if texts and not texts[-1].endswith("\n\n"):
                    await text("\n\n")
                await text(item["text"])
            elif t == "item.completed" and item.get("type") == "reasoning" and item.get("text"):
                await on_thinking(item["text"] + "\n\n")
            elif t == "turn.completed":
                u = ev.get("usage") or {}
                usage["prompt"] += u.get("input_tokens", 0)
                usage["completion"] += u.get("output_tokens", 0)
            elif t in ("turn.failed", "error"):
                errors.append(str((ev.get("error") or {}).get("message") if isinstance(ev.get("error"), dict) else ev.get("message") or ev))

    try:
        argv, stdin = _argv(pid, mid, exe, run_dir, system, prompt, images, effort, bridge_url,
                            resume if pid != "codex" else None)
        home = _run_root() / pid  # one fixed working dir per CLI: Claude Code files its sessions under the cwd
        home.mkdir(exist_ok=True)
        proc = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.PIPE, cwd=str(home), env=_env(pid, bridge_url),
                                                    start_new_session=True, limit=32 * 1024 * 1024)
        proc.stdin.write(stdin)
        await proc.stdin.drain()
        proc.stdin.close()
        err_tail = bytearray()

        async def read_err():
            async for line in proc.stderr:
                err_tail.extend(line)
                del err_tail[:-4000]

        async def read_out():
            async for line in proc.stdout:
                state["last"] = time.monotonic()
                line = line.strip()
                if not line.startswith(b"{"):
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                await handle(ev)

        work = asyncio.gather(read_out(), read_err())
        stop = asyncio.create_task(abort.wait())
        stopped = False
        try:
            while not work.done():
                await asyncio.wait({work, stop}, timeout=5, return_when=asyncio.FIRST_COMPLETED)
                if work.done():
                    break
                if busy():
                    state["last"] = time.monotonic()  # a Shell:B tool is running for it: that isn't silence
                if stop.done() or time.monotonic() - state["last"] > stall_s:
                    stopped = stop.done()
                    _kill(proc)
                    if not stopped:
                        raise RuntimeError(f"{CLIS[pid]['name']} sent nothing for over {stall_s / 60:g} minutes, so the turn "
                                           "was ended. Send a message to try again.")
                    break
            await asyncio.wait_for(work, 10) if not stopped else None
        finally:
            stop.cancel()
            if not work.done():
                work.cancel()
        rc = await asyncio.wait_for(proc.wait(), 10)
        if stopped:
            return {"text": "".join(texts), "usage": usage, "stopped": True, "session": state["session"]}
        if errors or (rc != 0 and not texts):
            msg = "; ".join(errors) or err_tail.decode(errors="replace").strip()[-1500:] or f"exit code {rc}"
            raise RuntimeError(f"{CLIS[pid]['name']}: {msg}")
        return {"text": "".join(texts), "usage": usage, "stopped": False, "session": state["session"]}
    finally:
        SESSIONS.pop(token, None)
        shutil.rmtree(run_dir, ignore_errors=True)
        if "proc" in locals() and proc.returncode is None:
            _kill(proc)


def _kill(proc):
    """SIGTERM the CLI's whole process group (it has MCP and helper children), SIGKILL it 3 s later if needed."""
    def sig(s):
        try:
            os.killpg(proc.pid, s)
        except (ProcessLookupError, PermissionError):
            pass
    sig(signal.SIGTERM)
    asyncio.get_running_loop().call_later(3, lambda: proc.returncode is None and sig(signal.SIGKILL))


# ── the bridge's side in shellb-web ─────────────────────────────────────────

def bridge_tools(token: str) -> list[dict] | None:
    s = SESSIONS.get(token)
    return None if s is None else s["tools"]


async def bridge_call(token: str, name: str, args: dict) -> dict | None:
    s = SESSIONS.get(token)
    if s is None:
        return None
    return await s["call"](name, args)


def mcp_tools(schemas: list[dict]) -> list[dict]:
    """Shell:B's Ollama-style tool schemas as MCP tool specs."""
    out = []
    for s in schemas:
        f = s.get("function", s)
        params = f.get("parameters") or {"type": "object", "properties": {}}
        out.append({"name": f["name"], "description": f.get("description", ""), "inputSchema": params})
    return out


def cleanup():
    """Leftover run dirs from a shellb-web that died mid-turn."""
    if RUNS.is_dir():
        for p in RUNS.iterdir():
            if re.fullmatch(r"[0-9a-f]{32}", p.name):
                shutil.rmtree(p, ignore_errors=True)
