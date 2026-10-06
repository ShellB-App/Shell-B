"""Remote (SSH) Code workspaces: the agent loop stays here, its tools run on another machine over SSH.

A remote workspace is an ordinary `code` project plus project-meta/<pid>/remote.json ({hostId, path}). The local
project folder stays empty; agent tools, the terminal, the file tree and the editor go to the remote path instead.

Trust model (see auth.py):
- One Shell:B keypair (data/ssh/id_ed25519). The user's own ~/.ssh keys, ssh-agent and ~/.ssh/config are never used.
- Host keys are pinned. Adding a host fetches its key and shows the fingerprint; nothing connects until the owner
  confirms it. A changed key fails the connection.
- Only an admin (the owner session or the admin key; never plain localhost or a frame key) manages hosts, answers
  approvals, uses the remote terminal or reads and writes remote files from the UI.
- Agent commands and file changes wait for the owner's approval unless the host is in auto mode. Reads don't ask.
- Every remote command and write is appended to data/ssh/audit.jsonl.
"""
import asyncio
import hmac
import json
import posixpath
import re
import shlex
import time
import uuid

import asyncssh
from fastapi import APIRouter, HTTPException, Request

import auth
import db
from tools import ToolResult, _fn

router = APIRouter(prefix="/api/ssh")

SSH = db.DATA / "ssh"
SSH.mkdir(mode=0o700, exist_ok=True)
KEY = SSH / "id_ed25519"
HOSTS = SSH / "hosts.json"
AUDIT = SSH / "audit.jsonl"
META = db.DATA / "project-meta"

RUN_TIMEOUT = 180
APPROVAL_TIMEOUT = 15 * 60
TEXT_LIMIT = 80_000
OUT_LIMIT = 8000
GATED = {"run_code", "write_file", "edit_file", "delete_file", "rename_file"}


# ── admin ───────────────────────────────────────────────────────────────────

def is_admin(req: Request) -> bool:
    if auth.is_owner(req):
        return True
    given = req.headers.get("x-shellb-admin", "")
    return bool(given) and hmac.compare_digest(given.strip(), (db.DATA / "admin.key").read_text().strip())


def require_admin(req: Request):
    if not is_admin(req):
        raise HTTPException(403, "admin-key-required")


def audit(**entry):
    with AUDIT.open("a") as f:
        f.write(json.dumps({"t": time.time(), **entry}) + "\n")


# ── key and hosts ───────────────────────────────────────────────────────────

def private_key() -> asyncssh.SSHKey:
    if not KEY.exists():
        k = asyncssh.generate_private_key("ssh-ed25519", comment="shellb@" + __import__("socket").gethostname())
        KEY.write_bytes(k.export_private_key())
        KEY.chmod(0o600)
        (SSH / "id_ed25519.pub").write_bytes(k.export_public_key())
    return asyncssh.read_private_key(str(KEY))


def public_key() -> str:
    return private_key().export_public_key().decode().strip()


def _hosts() -> dict:
    return json.loads(HOSTS.read_text()) if HOSTS.exists() else {}


def _save_hosts(h: dict):
    tmp = HOSTS.with_suffix(".tmp")
    tmp.write_text(json.dumps(h, indent=2))
    tmp.chmod(0o600)
    tmp.replace(HOSTS)


def get_host(hid: str) -> dict:
    h = _hosts().get(hid)
    if not h:
        raise ValueError(f"No SSH host {hid!r}.")
    return h


def host_view(h: dict) -> dict:
    return {k: h.get(k) for k in ("id", "name", "host", "port", "user", "fingerprint", "trusted", "autoApprove", "created")}


async def scan_key(host: str, port: int) -> asyncssh.SSHKey:
    key = await asyncio.wait_for(asyncssh.get_server_host_key(host, port, config=None), timeout=15)
    if key is None:
        raise ValueError(f"{host}:{port} did not offer a host key.")
    return key


# ── connections ─────────────────────────────────────────────────────────────

_conns: dict[str, tuple[asyncio.AbstractEventLoop, asyncssh.SSHClientConnection]] = {}
_locks: dict[tuple, asyncio.Lock] = {}


async def connect(hid: str) -> asyncssh.SSHClientConnection:
    loop = asyncio.get_running_loop()  # a connection belongs to the loop that opened it
    async with _locks.setdefault((hid, id(loop)), asyncio.Lock()):
        hit = _conns.get(hid)
        if hit and hit[0] is loop and not hit[1].is_closed():
            return hit[1]
        h = get_host(hid)
        if not h.get("trusted"):
            raise ValueError(f"The host key of {h['name']} hasn't been confirmed yet.")
        pinned = asyncssh.import_public_key(h["hostKey"])
        c = await asyncio.wait_for(asyncssh.connect(
            h["host"], h["port"], username=h["user"], client_keys=[private_key()], known_hosts=([pinned], [], []),
            agent_path=None, config=None, password=None, kbdint_auth=False, keepalive_interval=30, keepalive_count_max=4,
            connect_timeout=15), timeout=20)
        _conns[hid] = (loop, c)
        return c


def drop(hid: str):
    hit = _conns.pop(hid, None)
    try:
        if hit and hit[0] is asyncio.get_running_loop():
            hit[1].close()
    except RuntimeError:  # no running loop: the connection goes with its own loop
        pass


# ── workspaces ──────────────────────────────────────────────────────────────

def config(pid: str | None) -> dict | None:
    if not pid:
        return None
    f = META / pid / "remote.json"
    return json.loads(f.read_text()) if f.is_file() else None


def resolve(cfg: dict, rel: str) -> str:
    """A path relative to the workspace root; refuses anything that leaves it (symlinks are checked on access)."""
    base = cfg["path"].rstrip("/") or "/"
    rel = (rel or "").strip()
    if base != "/work" and (rel == "/work" or rel.startswith("/work/")):  # habit from the local sandbox: /work is the root
        rel = rel[len("/work/"):] if rel.startswith("/work/") else ""
    p = posixpath.normpath(rel if rel.startswith("/") else posixpath.join(base, rel))
    if p != base and not p.startswith(base.rstrip("/") + "/"):
        raise ValueError(f"Path escapes the workspace: {rel!r}")
    return p


async def _inside(sftp, cfg: dict, p: str) -> str:
    """The real path, which must still be inside the workspace (a symlink must not lead out of it)."""
    base = await sftp.realpath(cfg["path"])
    try:
        real = await sftp.realpath(p)
    except asyncssh.SFTPError:
        real = posixpath.join(await sftp.realpath(posixpath.dirname(p)), posixpath.basename(p))
    if real != base and not real.startswith(base.rstrip("/") + "/"):
        raise ValueError(f"{p} resolves outside the workspace ({real}).")
    return real


async def run(pid: str, script: str, *, interpreter: str = "bash", timeout: int = RUN_TIMEOUT, who: str = "agent"):
    cfg = config(pid)
    c = await connect(cfg["hostId"])
    cmd = f"cd {shlex.quote(cfg['path'])} && {'python3 -' if interpreter == 'python' else 'bash -s'}"
    audit(who=who, host=cfg["hostId"], pid=pid, op="run", interpreter=interpreter, script=script[:4000])
    try:
        r = await c.run(cmd, input=script, timeout=timeout, check=False)
        return r.exit_status, str(r.stdout or ""), str(r.stderr or ""), False
    except asyncssh.TimeoutError as e:
        return None, str(e.stdout or ""), str(e.stderr or ""), True


async def list_files(pid: str, limit: int = 5000) -> list[dict]:
    """The file tree, like projects.list_files: skips .git and node_modules; files only."""
    exit_, out, _, _ = await run(pid, "find . \\( -name .git -o -name node_modules -o -name __pycache__ -o -name .venv \\) -prune "
                                      f"-o -type f -printf '%s\\t%T@\\t%P\\n' 2>/dev/null | head -n {limit}", who="tree")
    import projects as P
    files = []
    for line in out.splitlines():
        size, mtime, path = (line.split("\t", 2) + ["", ""])[:3]
        if path:
            files.append({"path": path, "size": int(size or 0), "mtime": float(mtime or 0) * 1000,
                          "kind": P.file_kind(__import__("pathlib").Path(path))})
    return sorted(files, key=lambda f: f["path"])


async def read_text(pid: str, rel: str) -> str:
    cfg = config(pid)
    c = await connect(cfg["hostId"])
    async with c.start_sftp_client() as sftp:
        p = await _inside(sftp, cfg, resolve(cfg, rel))
        async with sftp.open(p, "rb") as f:
            data = await f.read(TEXT_LIMIT * 4)
    return data.decode(errors="replace")


async def write_text(pid: str, rel: str, content: str, who: str = "agent") -> bool:
    """Write a file (creating parent folders); returns whether it existed before."""
    cfg = config(pid)
    c = await connect(cfg["hostId"])
    async with c.start_sftp_client() as sftp:
        p = resolve(cfg, rel)
        await sftp.makedirs(posixpath.dirname(p), exist_ok=True)
        p = await _inside(sftp, cfg, p)
        existed = await sftp.exists(p)
        async with sftp.open(p, "wb") as f:
            await f.write(content.encode())
    audit(who=who, host=cfg["hostId"], pid=pid, op="write", path=rel, bytes=len(content))
    return existed


# ── approvals ───────────────────────────────────────────────────────────────

_pending: dict[str, asyncio.Future] = {}
_meta: dict[str, dict] = {}       # what each waiting approval is about, for the Activity inbox
_turn_allow: set[str] = set()  # message ids whose remaining remote calls the owner allowed in one go


def needs_approval(pid: str, name: str, message_id: str) -> bool:
    if name not in GATED or message_id in _turn_allow:
        return False
    try:
        return not get_host(config(pid)["hostId"]).get("autoApprove")
    except ValueError:
        return True


async def wait_approval(aid: str, abort: asyncio.Event, meta: dict | None = None, timeout: float = APPROVAL_TIMEOUT):
    fut = asyncio.get_running_loop().create_future()
    _pending[aid] = fut
    _meta[aid] = {**(meta or {}), "since": time.time()}
    import notify
    notify.approval(aid, _meta[aid])  # pushes to the owner's devices if still unanswered after a short grace
    stop = asyncio.create_task(abort.wait())
    try:
        done, _ = await asyncio.wait({fut, stop}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        return fut.result() if fut in done else "stopped" if stop in done else "timeout"
    finally:
        stop.cancel()
        _pending.pop(aid, None)
        _meta.pop(aid, None)


def pending_count() -> int:
    return len(_pending)


# ── agent tools ─────────────────────────────────────────────────────────────

def _need(ctx) -> dict:
    cfg = config(ctx.project_id)
    if not cfg:
        raise ValueError("This tool only works in a remote workspace.")
    return cfg


def _clip(s: str, n: int = OUT_LIMIT) -> str:
    return s if len(s) <= n else s[:n // 2] + f"\n…[{len(s) - n:,} chars cut]…\n" + s[-n // 2:]


async def _changed(ctx, path, action):
    await ctx.emit({"type": "file", "path": path, "action": action})


async def t_run_code(args, ctx):
    _need(ctx)
    language = str(args.get("language") or "bash").lower()
    if language not in ("python", "bash"):
        return ToolResult("Supported languages: python, bash.", error=True)
    t0 = time.time()
    code, out, err, timed_out = await run(ctx.project_id, str(args.get("code") or ""), interpreter=language)
    parts = []
    if out.strip():
        parts.append("stdout:\n" + _clip(out))
    if err.strip():
        parts.append("stderr:\n" + _clip(err))
    if timed_out:
        parts.append(f"Timed out after {RUN_TIMEOUT}s.")
    parts.append(f"exit code: {code}")
    await _changed(ctx, "", "modified")
    return ToolResult("\n\n".join(parts), {"exitCode": code, "stdout": _clip(out), "stderr": _clip(err),
                                          "elapsed": round(time.time() - t0, 2), "remote": True}, error=bool(timed_out or code))


async def t_read_file(args, ctx):
    _need(ctx)
    rel = str(args.get("path", ""))
    try:
        text = await read_text(ctx.project_id, rel)
    except (FileNotFoundError, asyncssh.SFTPNoSuchFile):
        return ToolResult(f"{rel} does not exist.", error=True)
    if "\x00" in text[:4000]:
        return ToolResult(f"{rel} looks binary; inspect it with run_code (e.g. file, xxd | head).")
    start = max(1, int(args.get("start_line") or 1))
    end = int(args.get("end_line") or 0)
    if start > 1 or end:
        text = "".join(text.splitlines(keepends=True)[start - 1:end or None])
    if len(text) > TEXT_LIMIT:
        text = text[:TEXT_LIMIT] + f"\n…[truncated at {TEXT_LIMIT} chars; read the rest with start_line/end_line]"
    return ToolResult(text)


async def t_write_file(args, ctx):
    _need(ctx)
    rel, content = str(args.get("path", "")).strip(), args.get("content")
    if not rel or content is None:
        return ToolResult("write_file needs path and content.", error=True)
    existed = await write_text(ctx.project_id, rel, str(content))
    action = "modified" if existed else "created"
    await _changed(ctx, rel, action)
    return ToolResult(f"{'Overwrote' if existed else 'Created'} {rel} ({str(content).count(chr(10)) + 1} lines).",
                      {"file": {"path": rel, "action": action}})


async def t_edit_file(args, ctx):
    _need(ctx)
    rel = str(args.get("path", "")).strip()
    old, new = args.get("old_string"), args.get("new_string")
    if old is None or new is None:
        return ToolResult("edit_file needs old_string and new_string.", error=True)
    try:
        text = await read_text(ctx.project_id, rel)
    except (FileNotFoundError, asyncssh.SFTPNoSuchFile):
        return ToolResult(f"{rel} does not exist — create it with write_file.", error=True)
    count = text.count(old)
    if count == 0:
        return ToolResult(f"old_string was not found in {rel}. Re-read the file and copy the exact text, including whitespace.",
                          error=True)
    if count > 1 and not args.get("replace_all"):
        return ToolResult(f"old_string occurs {count} times in {rel}. Add context to make it unique, or pass replace_all=true.",
                          error=True)
    await write_text(ctx.project_id, rel, text.replace(old, new) if args.get("replace_all") else text.replace(old, new, 1))
    await _changed(ctx, rel, "modified")
    return ToolResult(f"Edited {rel} ({count if args.get('replace_all') else 1} replacement).",
                      {"file": {"path": rel, "action": "modified"}})


async def t_delete_file(args, ctx):
    cfg = _need(ctx)
    rel = str(args.get("path", "")).strip()
    p = resolve(cfg, rel)
    if p == cfg["path"].rstrip("/"):
        return ToolResult("Refusing to delete the workspace root.", error=True)
    code, _, err, _ = await run(ctx.project_id, f"rm -r -- {shlex.quote(p)}")
    if code:
        return ToolResult(f"Deleting {rel} failed: {err.strip()}", error=True)
    await _changed(ctx, rel, "deleted")
    return ToolResult(f"Deleted {rel}. Remote workspaces have no Shell:B version history; use git there to recover.")


async def t_rename_file(args, ctx):
    cfg = _need(ctx)
    src, dst = str(args.get("from", "")).strip(), str(args.get("to", "")).strip()
    ps, pd = resolve(cfg, src), resolve(cfg, dst)
    code, _, err, _ = await run(ctx.project_id, f"mkdir -p -- {shlex.quote(posixpath.dirname(pd))} && mv -- {shlex.quote(ps)} {shlex.quote(pd)}")
    if code:
        return ToolResult(f"Renaming failed: {err.strip()}", error=True)
    await _changed(ctx, src, "deleted")
    await _changed(ctx, dst, "created")
    return ToolResult(f"Renamed {src} → {dst}.")


async def t_list_files(args, ctx):
    _need(ctx)
    files = await list_files(ctx.project_id)
    if not files:
        return ToolResult("The workspace is empty.")
    return ToolResult("\n".join(f"{f['path']}  ({f['size']:,} bytes)" for f in files[:1000])
                      + (f"\n…and {len(files) - 1000} more (use find_files)" if len(files) > 1000 else ""))


async def t_find_files(args, ctx):
    import fnmatch
    _need(ctx)
    glob = str(args.get("glob") or "*").strip()
    paths = [f["path"] for f in await list_files(ctx.project_id)
             if fnmatch.fnmatch(f["path"], glob) or fnmatch.fnmatch(posixpath.basename(f["path"]), glob)]
    if not paths:
        return ToolResult(f"No files match {glob!r}.")
    return ToolResult("\n".join(paths[:500]) + (f"\n…and {len(paths) - 500} more" if len(paths) > 500 else ""))


async def t_search_files(args, ctx):
    _need(ctx)
    pattern = str(args.get("pattern") or "")
    if not pattern:
        return ToolResult("search_files needs a pattern.", error=True)
    glob = str(args.get("glob") or "").strip()
    n = max(0, min(5, int(args.get("context") or 0)))
    ci = "" if args.get("case_sensitive") else "-i"
    q, g = shlex.quote(pattern), shlex.quote(glob)
    script = (f"if command -v rg >/dev/null; then rg -n --no-heading --color never {ci} -C {n} {f'-g {g}' if glob else ''} -e {q} . ; "
              f"else grep -rInE {ci} -C {n} --exclude-dir=.git --exclude-dir=node_modules {f'--include={g}' if glob else ''} -e {q} . ; fi"
              " | head -n 400")
    code, out, err, _ = await run(ctx.project_id, script)
    if not out.strip():
        return ToolResult(f"No matches for /{pattern}/" + (f" in {glob}" if glob else "") + "." + (f" ({err.strip()[:300]})" if err.strip() else ""))
    return ToolResult(_clip(re.sub(r"(?m)^\./", "", out), 30000))


TOOLS = {}


def register():
    specs = {
        "run_code": (t_run_code, "Run a bash script (or python3 code) ON THE REMOTE HOST, from the workspace root. It runs as "
                                 "the SSH user with that machine's network and software. Not sandboxed: changes are real and "
                                 "there is no Shell:B version history, so prefer reversible steps.",
                     {"language": {"type": "string", "enum": ["bash", "python"]}, "code": {"type": "string"}}, ["code"]),
        "read_file": (t_read_file, "Read a text file in the remote workspace. Use start_line/end_line for long files.",
                      {"path": {"type": "string"}, "start_line": {"type": "integer"}, "end_line": {"type": "integer"}}, ["path"]),
        "write_file": (t_write_file, "Create or overwrite a text file in the remote workspace with complete content. "
                                     "Prefer edit_file for small changes.",
                       {"path": {"type": "string"}, "content": {"type": "string"}}, ["path", "content"]),
        "edit_file": (t_edit_file, "Replace an exact snippet in a remote file. old_string must match exactly (including "
                                   "whitespace) and be unique unless replace_all is true.",
                      {"path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"},
                       "replace_all": {"type": "boolean"}}, ["path", "old_string", "new_string"]),
        "delete_file": (t_delete_file, "Delete a file or folder in the remote workspace (not recoverable from Shell:B).",
                        {"path": {"type": "string"}}, ["path"]),
        "rename_file": (t_rename_file, "Move or rename a file in the remote workspace.",
                        {"from": {"type": "string"}, "to": {"type": "string"}}, ["from", "to"]),
        "list_files": (t_list_files, "List the remote workspace's files with sizes (skips .git and node_modules).", {}, []),
        "find_files": (t_find_files, "List remote files whose path or name matches a glob, e.g. *.py, src/*.ts, Makefile.",
                       {"glob": {"type": "string"}}, ["glob"]),
        "search_files": (t_search_files, "Search the remote workspace with a regular expression (ripgrep, or grep -E). "
                                         "Returns path:line: text for each match.",
                         {"pattern": {"type": "string"}, "glob": {"type": "string"},
                          "context": {"type": "integer", "description": "Lines of context (0-5)"},
                          "case_sensitive": {"type": "boolean"}}, ["pattern"]),
    }
    for name, (fn, desc, props, req) in specs.items():
        TOOLS[name] = {"fn": fn, "schema": _fn(name, desc, props, req)}


register()


def context(proj: dict) -> str:
    cfg = config(proj["id"])
    try:
        h = get_host(cfg["hostId"])
        where = f"{h['user']}@{h['host']}:{cfg['path']}"
        auto = h.get("autoApprove")
    except ValueError:
        where, auto = f"(missing host) {cfg['path']}", False
    return f"""## Shell:B remote workspace: "{proj['name']}" on {where}
You are the user's coding partner on a REMOTE machine reached over SSH. Your tools act on that machine, in {cfg['path']}.
File tool paths are relative to that folder (e.g. src/app.py); there is no /work sandbox here.

- run_code runs bash (or python3) there as the SSH user, from the workspace root. It is NOT a sandbox: it has that
  machine's network, packages and permissions, and its changes are real. There is no Shell:B version history here;
  if the folder is a git repository, use git (status, diff) to review and recover.
- {"The owner approves each command and file change before it runs. Batch related steps into one run_code call, say what it does, and don't retry a call the owner denied; ask instead." if not auto else "This host is in auto mode: commands run without asking. Stay careful; prefer read-only inspection first."}
- Understand before you change: search_files, find_files and read_file first. Never edit a file you haven't read.
- Make focused edits with edit_file; write_file for new files. Match the existing style.
- Verify by running the code or tests with run_code. Never claim something works unless you ran it this turn.
- Never print, copy or exfiltrate secrets (keys, tokens, .env files) you come across. Don't touch files outside the
  workspace, don't install system packages, change services or use sudo unless the user asks for it explicitly.
- Reply like a senior engineer: what you changed (file:line), how you verified it, and anything left open."""


# ── HTTP: hosts, workspaces, approvals ──────────────────────────────────────

@router.get("/key")
def key_get(req: Request):
    require_admin(req)
    return {"publicKey": public_key()}


@router.get("/hosts")
def hosts_list(req: Request):
    require_admin(req)
    return [host_view(h) for h in _hosts().values()]


@router.post("/hosts")
async def host_add(req: Request):
    """Fetch the host's key and store it unconfirmed. The owner checks the fingerprint, then POSTs /trust."""
    require_admin(req)
    body = await req.json()
    host, user = str(body.get("host") or "").strip(), str(body.get("user") or "").strip()
    port = int(body.get("port") or 22)
    if not host or not user or any(ch in host + user for ch in " \t\n/@") or host.startswith("-") or user.startswith("-"):
        raise HTTPException(400, "Give a host name or address and a user name.")
    try:
        key = await scan_key(host, port)
    except Exception as e:
        raise HTTPException(400, f"Couldn't reach {host}:{port}: {type(e).__name__}: {e}")
    hid = "ssh-" + uuid.uuid4().hex[:10]
    h = {"id": hid, "name": str(body.get("name") or f"{user}@{host}").strip()[:80], "host": host, "port": port, "user": user,
         "hostKey": key.export_public_key().decode().strip(), "fingerprint": key.get_fingerprint("sha256"),
         "trusted": False, "autoApprove": False, "created": time.time()}
    hosts = _hosts()
    hosts[hid] = h
    _save_hosts(hosts)
    audit(who="owner", host=hid, op="add-host", target=f"{user}@{host}:{port}", fingerprint=h["fingerprint"])
    return host_view(h)


@router.post("/hosts/{hid}/trust")
async def host_trust(hid: str, req: Request):
    """Confirm the pinned key. The caller repeats the fingerprint it was shown, so a stale screen can't confirm a new key."""
    require_admin(req)
    body = await req.json()
    hosts = _hosts()
    h = hosts.get(hid) or {}
    if not h:
        raise HTTPException(404, "No such host")
    if str(body.get("fingerprint") or "") != h["fingerprint"]:
        raise HTTPException(409, "The fingerprint doesn't match the stored host key.")
    h["trusted"] = True
    _save_hosts(hosts)
    audit(who="owner", host=hid, op="trust-host", fingerprint=h["fingerprint"])
    return host_view(h)


@router.patch("/hosts/{hid}")
async def host_patch(hid: str, req: Request):
    require_admin(req)
    body = await req.json()
    hosts = _hosts()
    h = hosts.get(hid)
    if not h:
        raise HTTPException(404, "No such host")
    if "name" in body:
        h["name"] = str(body["name"]).strip()[:80] or h["name"]
    if "autoApprove" in body:
        h["autoApprove"] = bool(body["autoApprove"])
        audit(who="owner", host=hid, op="auto-mode", on=h["autoApprove"])
    _save_hosts(hosts)
    return host_view(h)


@router.delete("/hosts/{hid}")
def host_delete(hid: str, req: Request):
    require_admin(req)
    hosts = _hosts()
    if hosts.pop(hid, None) is None:
        raise HTTPException(404, "No such host")
    _save_hosts(hosts)
    drop(hid)
    audit(who="owner", host=hid, op="delete-host")
    return {"ok": True}


@router.post("/hosts/{hid}/test")
async def host_test(hid: str, req: Request):
    require_admin(req)
    try:
        drop(hid)
        c = await connect(hid)
        r = await c.run("uname -srm; echo \"$HOME\"; command -v git rg python3 | tr '\\n' ' '", timeout=20, check=False)
    except asyncssh.PermissionDenied:
        raise HTTPException(400, "The host refused the Shell:B key. Add the public key to ~/.ssh/authorized_keys there.")
    except asyncssh.HostKeyNotVerifiable:
        raise HTTPException(400, "The host's key no longer matches the pinned one. Check the machine, then remove and re-add it.")
    except Exception as e:
        raise HTTPException(400, f"{type(e).__name__}: {e}")
    lines = str(r.stdout or "").splitlines() + ["", "", ""]
    return {"ok": True, "system": lines[0], "home": lines[1], "tools": lines[2].split()}


INSTALL_KEY = r"""umask 077
read -r key
mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys || exit 2
if grep -qxF "$key" ~/.ssh/authorized_keys; then echo present; exit 0; fi
[ -s ~/.ssh/authorized_keys ] && [ -n "$(tail -c1 ~/.ssh/authorized_keys)" ] && echo >> ~/.ssh/authorized_keys
printf '%s\n' "$key" >> ~/.ssh/authorized_keys && echo added
"""


@router.post("/hosts/{hid}/install-key")
async def host_install_key(hid: str, req: Request):
    """ssh-copy-id: log in once with the user's password and append Shell:B's public key to ~/.ssh/authorized_keys.

    Only for a host whose key the owner already confirmed, so the password never goes to an unverified machine.
    The password is used for this one connection and is never stored, logged or echoed back.
    """
    require_admin(req)
    body = await req.json()
    password = body.get("password")
    if not isinstance(password, str) or not password:
        raise HTTPException(400, "Enter the SSH password for this user.")
    try:
        h = get_host(hid)
    except ValueError:
        raise HTTPException(404, "No such host")
    if not h.get("trusted"):
        raise HTTPException(400, "Confirm the host's fingerprint before sending it a password.")
    try:
        pinned = asyncssh.import_public_key(h["hostKey"])
        async with await asyncio.wait_for(asyncssh.connect(
                h["host"], h["port"], username=h["user"], password=password, client_keys=None, known_hosts=([pinned], [], []),
                agent_path=None, config=None, preferred_auth="keyboard-interactive,password", connect_timeout=15), timeout=25) as c:
            r = await c.run("sh -c " + shlex.quote(INSTALL_KEY), input=public_key() + "\n", check=False, timeout=20)
    except asyncssh.PermissionDenied:
        audit(who="owner", host=hid, op="install-key", ok=False, why="password refused")
        raise HTTPException(400, "The host refused that password (or doesn't allow password logins).")
    except asyncssh.HostKeyNotVerifiable:
        raise HTTPException(400, "The host's key no longer matches the pinned one. Nothing was sent.")
    except Exception as e:
        raise HTTPException(400, f"{type(e).__name__}: {e}")
    finally:
        password = None
    out = str(r.stdout or "").strip()
    if r.exit_status != 0 or out not in ("added", "present"):
        audit(who="owner", host=hid, op="install-key", ok=False, why=str(r.stderr or "")[:300])
        raise HTTPException(400, f"Installing the key failed: {str(r.stderr or r.stdout or '').strip()[:300] or f'exit {r.exit_status}'}")
    audit(who="owner", host=hid, op="install-key", ok=True, result=out)
    drop(hid)
    try:  # prove the key works now
        c = await connect(hid)
        await c.run("true", check=True, timeout=15)
    except Exception as e:
        raise HTTPException(400, f"The key was {out}, but logging in with it still fails: {type(e).__name__}: {e}. "
                                 "The server may not allow key logins for this user (check AuthorizedKeysFile and file permissions).")
    return {"ok": True, "result": out}


@router.post("/workspaces")
async def workspace_create(req: Request):
    """A Code workspace whose files live at {path} on a confirmed host."""
    import projects as P
    require_admin(req)
    body = await req.json()
    hid, path = str(body.get("hostId") or ""), str(body.get("path") or "").strip()
    try:
        h = get_host(hid)
        c = await connect(hid)
        async with c.start_sftp_client() as sftp:
            path = await sftp.realpath(path or ".")
            if not await sftp.isdir(path):
                raise ValueError(f"{path} is not a folder on {h['name']}.")
    except Exception as e:
        raise HTTPException(400, f"{type(e).__name__}: {e}" if not isinstance(e, ValueError) else str(e))
    if path == "/":
        raise HTTPException(400, "Pick a project folder, not the filesystem root.")
    name = str(body.get("name") or "").strip() or f"{posixpath.basename(path)} ({h['name']})"
    proj = db.create_project(name[:80], "code", "README.md", f"Remote: {h['user']}@{h['host']}:{path}")
    P.create_project_files(proj["id"], name, "", "code", readme=False)
    (META / proj["id"]).mkdir(parents=True, exist_ok=True)
    (META / proj["id"] / "remote.json").write_text(json.dumps({"hostId": hid, "path": path}))
    audit(who="owner", host=hid, op="create-workspace", pid=proj["id"], path=path)
    return P.project_summary(db.get_project(proj["id"]))


@router.post("/approvals/{aid}")
async def approval_answer(aid: str, req: Request):
    require_admin(req)
    body = await req.json()
    decision = str(body.get("decision") or "")
    if decision not in ("allow", "deny", "allow_turn"):
        raise HTTPException(400, "decision is allow, allow_turn or deny")
    fut = _pending.get(aid)
    if fut is None or fut.done():
        raise HTTPException(404, "That request is no longer waiting.")
    fut.set_result(decision)
    return {"ok": True}
