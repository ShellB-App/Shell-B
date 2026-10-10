"""Git remotes for Code workspaces: fetch, pull and push between a project's repository and a remote over https.

A project's remote is project-meta/<pid>/git.json: {url, branch, secretId}. `url` is https only, with no credentials
in it and never a local, LAN or tailnet address (tools._blocked_host); public clone stays in projects.py. The
credential is a Codex secret (kind `secret`, e.g. a GitHub fine-grained token): git gets it through GIT_ASKPASS from
the environment, never on the command line, and stored credential helpers are switched off for the run. Pulls are
fast-forward only, so a diverged branch is reported, not merged blindly; pushes never force.

Who may: fetch/pull/push from the UI need an admin (the owner's session or the admin key, like SSH workspaces). The
`git_remote` tool lets an agent working in the project check status, fetch and pull on its own; a push shows an
approval card in the chat (kind `git`) with the commits it would publish and waits for the owner, the way browser
submits and emails do. Everything is appended to data/ssh/audit.jsonl.
"""
import asyncio
import json
import os
import re
import stat
import subprocess
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Request

import db
import projects as P

router = APIRouter(prefix="/api/projects")
TIMEOUT = 180
BRANCH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$")
GIT_PROTOCOLS = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always"]
ASKPASS = db.DATA / "ssh" / "git-askpass.sh"
ASKPASS_SRC = '#!/bin/sh\ncase "$1" in *sername*) printf "%s" "$SHELLB_GIT_USER";; *) printf "%s" "$SHELLB_GIT_PASS";; esac\n'


def _meta(pid: str) -> Path:
    return P.META / pid / "git.json"


def config(pid: str) -> dict | None:
    f = _meta(pid)
    if not f.is_file():
        return None
    try:
        return json.loads(f.read_text())
    except ValueError:
        return None


def check_url(url: str) -> str:
    from tools import _blocked_host
    u = urlparse(str(url or "").strip())
    if u.scheme != "https" or not u.hostname or u.username or u.password:
        raise ValueError("Use an https:// URL without credentials in it, e.g. https://github.com/owner/repo.git")
    if _blocked_host(u.hostname):
        raise ValueError("Local addresses are off limits for remotes")
    return u.geturl()


def set_remote(pid: str, url: str, branch: str = "main", secret_id: str | None = None) -> dict:
    if not db.get_project(pid):
        raise LookupError("No such project")
    url = check_url(url)
    branch = (branch or "main").strip()
    if not BRANCH_RE.match(branch) or ".." in branch:
        raise ValueError("That isn't a usable branch name")
    if secret_id:
        import codex
        e = codex.get(secret_id)
        if not e or e["kind"] != "secret":
            raise ValueError("The credential must be a Codex secret")
    cfg = {"url": url, "branch": branch, "secretId": secret_id or None, "set": time.time()}
    _meta(pid).parent.mkdir(parents=True, exist_ok=True)
    _meta(pid).write_text(json.dumps(cfg))
    P.git(pid, "remote", "remove", "origin", check=False)
    P.git(pid, "remote", "add", "origin", url)
    return cfg


def clear_remote(pid: str) -> bool:
    f = _meta(pid)
    if not f.exists():
        return False
    f.unlink()
    P.git(pid, "remote", "remove", "origin", check=False)
    return True


def _askpass() -> Path:
    ASKPASS.parent.mkdir(parents=True, exist_ok=True)
    if not ASKPASS.exists() or ASKPASS.read_text() != ASKPASS_SRC:
        ASKPASS.write_text(ASKPASS_SRC)
    ASKPASS.chmod(stat.S_IRWXU)
    return ASKPASS


def _credential(cfg: dict) -> tuple[str, str] | None:
    sid = cfg.get("secretId")
    if not sid:
        return None
    import codex_secrets
    value = codex_secrets._value(sid)
    if not value:
        return None
    # "user:token" names the user; a bare token uses the username GitHub, GitLab and Gitea all accept for tokens
    user, _, pw = value.partition(":") if ":" in value and " " not in value else ("", "", value)
    return (user or "x-access-token", pw or value)


def _run(pid: str, cfg: dict, *args: str) -> subprocess.CompletedProcess:
    base = P.root(pid)
    env = {**P.git_env(base), "GIT_TERMINAL_PROMPT": "0", "GIT_LFS_SKIP_SMUDGE": "1", "GIT_ASKPASS": str(_askpass()),
           "SHELLB_GIT_USER": "", "SHELLB_GIT_PASS": ""}
    cred = _credential(cfg)
    if cred:
        env["SHELLB_GIT_USER"], env["SHELLB_GIT_PASS"] = cred
    cmd = ["git", "-c", "user.name=Shell:B Studio", "-c", "user.email=studio@shellb.local", "-c", "credential.helper=",
           "-c", "http.followRedirects=initial", *GIT_PROTOCOLS, *args]
    return subprocess.run(cmd, cwd=base, capture_output=True, text=True, env=env, timeout=TIMEOUT)


def _redact(text: str, cfg: dict) -> str:
    cred = _credential(cfg)
    if cred and cred[1]:
        text = text.replace(cred[1], "***")
    return text.strip()[-2000:]


def _audit(pid: str, action: str, ok: bool, detail: str = "", by: str = "owner"):
    import remote
    try:
        remote.audit(kind="git", project=pid, action=action, ok=ok, by=by, detail=detail[:300])
    except Exception:  # noqa: BLE001
        pass


def status(pid: str, cfg: dict) -> dict:
    """Branch, ahead/behind the remote-tracking branch (as of the last fetch), uncommitted changes."""
    branch = P.git(pid, "rev-parse", "--abbrev-ref", "HEAD", check=False).strip() or "?"
    dirty = bool(P.git(pid, "status", "--porcelain", check=False).strip())
    ahead = behind = None
    ref = f"origin/{cfg['branch']}"
    if P.git(pid, "rev-parse", "--verify", "-q", ref, check=False).strip():
        counts = P.git(pid, "rev-list", "--left-right", "--count", f"HEAD...{ref}", check=False).strip().split()
        if len(counts) == 2:
            ahead, behind = int(counts[0]), int(counts[1])
    last = (P.root(pid) / ".git" / "FETCH_HEAD")
    return {"url": cfg["url"], "branch": cfg["branch"], "secretId": cfg.get("secretId"), "hasCredential": _credential(cfg) is not None,
            "localBranch": branch, "ahead": ahead, "behind": behind, "dirty": dirty,
            "lastFetch": last.stat().st_mtime if last.exists() else None}


def outgoing(pid: str, cfg: dict, limit: int = 20) -> list[str]:
    ref = f"origin/{cfg['branch']}"
    if not P.git(pid, "rev-parse", "--verify", "-q", ref, check=False).strip():
        return P.git(pid, "log", "--oneline", f"-{limit}", check=False).strip().splitlines()
    return P.git(pid, "log", "--oneline", f"{ref}..HEAD", check=False).strip().splitlines()[:limit]


async def fetch(pid: str, cfg: dict, by: str = "owner") -> dict:
    r = await asyncio.to_thread(_run, pid, cfg, "fetch", "--no-tags", "origin", cfg["branch"])
    ok = r.returncode == 0
    _audit(pid, "fetch", ok, _redact(r.stderr, cfg), by)
    if not ok:
        raise RuntimeError(_redact(r.stderr or r.stdout, cfg) or "fetch failed")
    return status(pid, cfg)


async def pull(pid: str, cfg: dict, by: str = "owner") -> dict:
    """Fetch, then fast-forward the working branch; a diverged branch stops here with the counts."""
    P.commit(pid, "Work in progress (before pull)")
    await fetch(pid, cfg, by)
    r = await asyncio.to_thread(_run, pid, cfg, "merge", "--ff-only", f"origin/{cfg['branch']}")
    ok = r.returncode == 0
    _audit(pid, "pull", ok, _redact(r.stderr, cfg), by)
    if not ok:
        st = status(pid, cfg)
        raise RuntimeError(f"Can't fast-forward: this workspace is {st['ahead']} commit(s) ahead and {st['behind']} behind the remote. "
                           "Push first, or rebase in the Terminal.")
    db.update_project(pid)
    return {**status(pid, cfg), "merged": _redact(r.stdout, cfg)}


async def push(pid: str, cfg: dict, by: str = "owner") -> dict:
    P.commit(pid, "Work in progress (before push)")
    r = await asyncio.to_thread(_run, pid, cfg, "push", "origin", f"HEAD:{cfg['branch']}")
    ok = r.returncode == 0
    _audit(pid, "push", ok, _redact(r.stderr, cfg), by)
    if not ok:
        raise RuntimeError(_redact(r.stderr or r.stdout, cfg) or "push failed")
    await asyncio.to_thread(_run, pid, cfg, "fetch", "--no-tags", "origin", cfg["branch"])
    return {**status(pid, cfg), "pushed": _redact(r.stderr, cfg)}


# ── agent tool ──────────────────────────────────────────────────────────────

async def run(args, ctx, abort=None, sink=None, idx=None):
    """`git_remote` in a chat: status/fetch/pull free, push behind an approval card (needs the chat loop's sink)."""
    from tools import ToolResult
    import remote
    args = args if isinstance(args, dict) else {}
    pid = ctx.project_id
    if not pid:
        return ToolResult("This tool only works inside a Code or Studio project.", error=True)
    cfg = config(pid)
    action = str(args.get("action") or "status").lower()
    if not cfg:
        return ToolResult("This project has no remote. The owner sets one in the Code page's Remote panel (URL, branch and a Codex secret for the token).", error=True)
    try:
        if action == "status":
            st = status(pid, cfg)
            out = outgoing(pid, cfg)
            return ToolResult(json.dumps({**st, "outgoing": out}, indent=1))
        if action == "fetch":
            return ToolResult(json.dumps(await fetch(pid, cfg, by="agent"), indent=1))
        if action == "pull":
            return ToolResult(json.dumps(await pull(pid, cfg, by="agent"), indent=1))
        if action == "push":
            if sink is None:
                return ToolResult("A push needs the owner's approval in a live chat; this run can't ask.", error=True)
            P.commit(pid, str(args.get("message") or "Work in progress (before push)")[:200])
            commits = outgoing(pid, cfg)
            if not commits and status(pid, cfg)["ahead"] == 0:
                return ToolResult("Nothing to push: the remote already has every commit.")
            title = f"Push {len(commits) or 'the'} commit{'s' if len(commits) != 1 else ''} to {cfg['url'].split('://', 1)[-1]} ({cfg['branch']})"
            detail = "\n".join(commits) or "(the remote branch is unknown until the first fetch)"
            aid = uuid.uuid4().hex
            b = sink.blocks[idx]
            b.update(status="approval", approval={"id": aid, "kind": "git", "title": title, "detail": detail})
            await sink.update(idx)
            decision = await remote.wait_approval(aid, abort, {"kind": "git", "conv": ctx.conv_id, "title": title, "detail": detail})
            b.pop("approval", None)
            b.update(status="running", decision=decision)
            await sink.update(idx)
            if decision not in ("allow", "allow_turn"):
                _audit(pid, "push", False, f"not approved: {decision}", by="agent")
                why = {"deny": "The owner declined", "timeout": "Nobody approved it within 15 minutes", "stopped": "The turn was stopped"}.get(decision, "It wasn't approved")
                return ToolResult(f"{why}, so nothing was pushed. Don't retry unchanged; ask what to change.", error=True)
            return ToolResult(json.dumps(await push(pid, cfg, by="agent"), indent=1))
        return ToolResult("action is one of status, fetch, pull, push", error=True)
    except (RuntimeError, subprocess.TimeoutExpired) as e:
        return ToolResult(f"git {action} failed: {e}", error=True)


def register():
    from tools import TOOLS, _fn
    TOOLS["git_remote"] = {
        "fn": run, "service": None, "scope": "project", "auto": "in Code and Studio projects that have a remote set up",
        "ui": {"displayName": "Git remote", "icon": "GitBranch", "category": "code",
               "description": "Fetch, pull and push the project with its git remote; pushes wait for the owner's approval (gitremote.py)"},
        "schema": _fn("git_remote", "The project's git remote (set by the owner in the Remote panel). status: branch, ahead/behind, "
                      "outgoing commits; fetch; pull (fast-forward only); push (commits pending work first, then asks the owner).",
                      {"action": {"type": "string", "enum": ["status", "fetch", "pull", "push"]},
                       "message": {"type": "string", "description": "commit message for uncommitted work before a push"}},
                      ["action"]),
    }


# ── routes (owner/admin) ────────────────────────────────────────────────────

def _admin(req: Request):
    import remote
    remote.require_admin(req)


def _cfg(pid: str) -> dict:
    if not db.get_project(pid):
        raise HTTPException(404, "No such project")
    cfg = config(pid)
    if not cfg:
        raise HTTPException(404, "This project has no remote")
    return cfg


@router.get("/{pid}/git")
def api_get(pid: str, req: Request):
    _admin(req)
    if not db.get_project(pid):
        raise HTTPException(404, "No such project")
    cfg = config(pid)
    if not cfg:
        return {"remote": None}
    return {"remote": status(pid, cfg), "outgoing": outgoing(pid, cfg)}


@router.put("/{pid}/git")
async def api_set(pid: str, req: Request):
    _admin(req)
    b = await req.json()
    try:
        cfg = set_remote(pid, str(b.get("url") or ""), str(b.get("branch") or "main"), b.get("secretId") or None)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    _audit(pid, "set", True, cfg["url"])
    return {"remote": status(pid, cfg), "outgoing": outgoing(pid, cfg)}


@router.delete("/{pid}/git")
def api_clear(pid: str, req: Request):
    _admin(req)
    if not clear_remote(pid):
        raise HTTPException(404, "This project has no remote")
    return {"ok": True}


@router.post("/{pid}/git/{action}")
async def api_action(pid: str, action: str, req: Request):
    _admin(req)
    cfg = _cfg(pid)
    fn = {"fetch": fetch, "pull": pull, "push": push}.get(action)
    if not fn:
        raise HTTPException(404, "action is fetch, pull or push")
    try:
        out = await fn(pid, cfg)
    except (RuntimeError, subprocess.TimeoutExpired) as e:
        raise HTTPException(409, str(e))
    return {"remote": out, "outgoing": outgoing(pid, cfg)}
