"""Self-review: Shell:B reading her own live source, and a ledger of what her reviews found.

shellb_source  read-only access to the git-tracked source tree, safe to give a cloud reviewer: outline, read, search,
               the commit history and the result of the last scripts/check.sh. Paths outside `git ls-files` are
               refused, so data/ (conversations, memories, keys), logs and anything untracked never leave the box.
               (shellb_self, the full tool, also reads logs and status and edits a workspace; it stays local.)
self_findings  the ledger: each finding has a fingerprint, a severity and a status (open, fixed, wontfix). A nightly
               review lists the open ones, re-checks them against the code, marks what's fixed and adds only what's
               new, instead of re-auditing from scratch and repeating itself.
"""
import hashlib
import re
import subprocess
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

import codemap
import db
import selfmod
from tools import TOOLS, ToolResult, _fn

router = APIRouter(prefix="/api/findings")
LIVE = selfmod.LIVE
CHECK_FILE = db.DATA / "selfmod" / "last-check.txt"
SEVERITIES = ("critical", "high", "medium", "low")
STATUSES = ("open", "fixed", "wontfix")

SCHEMA = """
CREATE TABLE IF NOT EXISTS findings(
  id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE, title TEXT, severity TEXT, file TEXT, status TEXT,
  first_seen REAL, last_seen REAL, evidence TEXT, note TEXT, source TEXT);
CREATE INDEX IF NOT EXISTS findings_status ON findings(status, severity);
"""


def init():
    with db.conn() as c:
        c.executescript(SCHEMA)
    _seed()
    _give_reviewer_the_tools()


# ── shellb_source ───────────────────────────────────────────────────────────

def _tracked() -> set[str]:
    r = subprocess.run(["git", "ls-files", "-z"], cwd=LIVE, capture_output=True)
    return {n for n in r.stdout.decode(errors="replace").split("\0") if n}


def _check_path(rel: str, tracked: set[str]) -> str:
    rel = (rel or "").strip().lstrip("/").rstrip("/")
    if rel in ("", "."):
        return ""
    p = (LIVE / rel).resolve()
    if not str(p).startswith(str(LIVE) + "/"):
        raise ValueError(f"{rel} is outside the source tree")
    rel = str(p.relative_to(LIVE))
    if rel in tracked or any(t.startswith(rel + "/") for t in tracked):
        return rel
    raise ValueError(f"{rel} isn't part of the committed source (data, logs and untracked files are off limits here)")


async def shellb_source(args, ctx) -> ToolResult:
    import asyncio
    action = str(args.get("action") or "about")
    try:
        if action == "about":
            return ToolResult(await asyncio.to_thread(selfmod.about))
        if action == "checks":
            if not CHECK_FILE.is_file():
                return ToolResult("No check has run yet (scripts/check.sh writes data/selfmod/last-check.txt).")
            return ToolResult(CHECK_FILE.read_text()[-6000:])
        if action == "history":
            n = max(1, min(int(args.get("limit") or 30), 200))
            log = subprocess.run(["git", "log", f"-n{n}", "--format=%h %cs %s"], cwd=LIVE, capture_output=True, text=True).stdout
            path = str(args.get("path") or "").strip()
            if path:
                tracked = await asyncio.to_thread(_tracked)
                rel = _check_path(path, tracked)
                log = subprocess.run(["git", "log", f"-n{n}", "--format=%h %cs %s", "--", rel], cwd=LIVE,
                                     capture_output=True, text=True).stdout
            return ToolResult(log or "(no commits)")
        tracked = await asyncio.to_thread(_tracked)
        if action == "outline":
            rel = _check_path(str(args.get("path") or ""), tracked)
            p = LIVE / rel if rel else LIVE
            if p.is_dir():
                text = await asyncio.to_thread(codemap.outline_dir, p, rel, selfmod.HIDDEN)
            else:
                text = await asyncio.to_thread(codemap.outline_file, p, rel)
            return ToolResult(text)
        if action == "source":
            query = str(args.get("query") or "")
            if query:  # git grep over committed files only
                rel = _check_path(str(args.get("path") or ""), tracked)
                r = subprocess.run(["git", "grep", "-n", "-I", "-E", query, "--", rel or "."], cwd=LIVE,
                                   capture_output=True, text=True)
                lines = r.stdout.splitlines()
                return ToolResult("\n".join(l[:300] for l in lines[:200])
                                  + (f"\n…{len(lines) - 200} more matches" if len(lines) > 200 else "") or "(no matches)")
            rel = _check_path(str(args.get("path") or ""), tracked)
            if not rel or (LIVE / rel).is_dir():
                prefix = rel + "/" if rel else ""
                names = sorted({t[len(prefix):].split("/")[0] + ("/" if "/" in t[len(prefix):] else "")
                                for t in tracked if t.startswith(prefix)})
                return ToolResult("\n".join(prefix + n for n in names))
            text = await asyncio.to_thread(selfmod.source_text, rel, "", int(args.get("offset") or 1),
                                           int(args.get("limit") or 400), ctx.message_id)
            return ToolResult(text)
    except ValueError as e:
        return ToolResult(str(e), error=True)
    return ToolResult("action must be about, outline, source, history or checks", error=True)


# ── the findings ledger ─────────────────────────────────────────────────────

def _fingerprint(title: str, file: str) -> str:
    norm = re.sub(r"[^a-z0-9]+", " ", f"{(file or '').split(':')[0]} {title}".lower()).strip()
    return hashlib.sha1(norm.encode()).hexdigest()[:16]


def _row(r) -> dict:
    return {"id": r["id"], "title": r["title"], "severity": r["severity"], "file": r["file"], "status": r["status"],
            "firstSeen": r["first_seen"] * 1000, "lastSeen": r["last_seen"] * 1000, "evidence": r["evidence"],
            "note": r["note"], "source": r["source"]}


def list_findings(status: str = "", limit: int = 200) -> list[dict]:
    order = "CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, last_seen DESC"
    with db.conn() as c:
        if status:
            rows = c.execute(f"SELECT * FROM findings WHERE status=? ORDER BY {order} LIMIT ?", (status, limit)).fetchall()
        else:
            rows = c.execute(f"SELECT * FROM findings ORDER BY status='open' DESC, {order} LIMIT ?", (limit,)).fetchall()
    return [_row(r) for r in rows]


def upsert(title: str, severity: str, file: str = "", evidence: str = "", source: str = "", fid: str = "") -> dict:
    severity = severity if severity in SEVERITIES else "medium"
    now = time.time()
    with db.conn() as c:
        row = c.execute("SELECT * FROM findings WHERE id=?", (fid,)).fetchone() if fid else \
            c.execute("SELECT * FROM findings WHERE fingerprint=?", (_fingerprint(title, file),)).fetchone()
        if row:  # seen again: still there (re-opened if it had been marked fixed)
            c.execute("UPDATE findings SET last_seen=?, severity=?, evidence=COALESCE(NULLIF(?, ''), evidence), "
                      "status=CASE WHEN status='fixed' THEN 'open' ELSE status END WHERE id=?",
                      (now, severity, evidence[:4000], row["id"]))
            fid = row["id"]
        else:
            fid = db.new_id("fnd")
            c.execute("INSERT INTO findings VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                      (fid, _fingerprint(title, file), title[:300], severity, file[:300], "open", now, now,
                       evidence[:4000], "", source[:200]))
        r = c.execute("SELECT * FROM findings WHERE id=?", (fid,)).fetchone()
    return _row(r)


def mark(fid: str, status: str, note: str = "") -> dict:
    if status not in STATUSES:
        raise ValueError(f"status must be one of {', '.join(STATUSES)}")
    with db.conn() as c:
        if not c.execute("UPDATE findings SET status=?, note=?, last_seen=? WHERE id=?",
                         (status, note[:2000], time.time(), fid)).rowcount:
            raise KeyError(fid)
        return _row(c.execute("SELECT * FROM findings WHERE id=?", (fid,)).fetchone())


async def self_findings(args, ctx) -> ToolResult:
    action = str(args.get("action") or "list")
    try:
        if action == "list":
            items = list_findings(str(args.get("status") or "open"))
            if not items:
                return ToolResult("No findings with that status.")
            return ToolResult("\n".join(f"- {f['id']} [{f['severity']}] {f['title']} ({f['file'] or 'no file'}; "
                                        f"last seen {time.strftime('%Y-%m-%d', time.localtime(f['lastSeen'] / 1000))})"
                                        + (f"\n  evidence: {f['evidence'][:400]}" if f["evidence"] else "")
                                        for f in items))
        if action == "add":
            f = upsert(str(args.get("title") or ""), str(args.get("severity") or "medium"), str(args.get("file") or ""),
                       str(args.get("evidence") or ""), source=f"agent:{ctx.agent.get('id')}")
            return ToolResult(f"Recorded {f['id']} ({f['status']}, {f['severity']}): {f['title']}")
        if action == "mark":
            f = mark(str(args.get("id") or ""), str(args.get("status") or ""), str(args.get("note") or ""))
            return ToolResult(f"{f['id']} is now {f['status']}.")
    except (ValueError, KeyError) as e:
        return ToolResult(f"Couldn't do that: {e}", error=True)
    return ToolResult("action must be list, add or mark", error=True)


def register():
    TOOLS["shellb_source"] = {
        "fn": shellb_source, "service": None,
        "ui": {"displayName": "Read Own Source", "icon": "FileCode", "category": "system",
               "description": "Read-only view of Shell:B's committed source code (never data, logs or keys); safe for cloud reviewers."},
        "schema": _fn("shellb_source",
                      "Read-only view of your own source code, Shell:B Web (FastAPI server/ + React ui/src), at its live "
                      "commit. action=about: overview, modules, agents, recent commits. outline: classes/functions of a "
                      "file or folder. source: read a file with line numbers (path, offset, limit) or search all files "
                      "with a regex (query, optional path). history: recent commits (optional path). checks: the last "
                      "scripts/check.sh result (compile, pyflakes, tests, TypeScript). Only committed files are visible.",
                      {"action": {"type": "string", "enum": ["about", "outline", "source", "history", "checks"]},
                       "path": {"type": "string", "description": "file or folder relative to the repo root, e.g. server/agent.py"},
                       "query": {"type": "string", "description": "source: regex to search for"},
                       "offset": {"type": "integer", "description": "source: first line (1-based)"},
                       "limit": {"type": "integer", "description": "source: lines to read (default 400); history: commits"}},
                      ["action"]),
    }
    TOOLS["self_findings"] = {
        "fn": self_findings, "service": None,
        "ui": {"displayName": "Self-Review Findings", "icon": "ClipboardCheck", "category": "system",
               "description": "The ledger of issues Shell:B's self-reviews found, with open/fixed status."},
        "schema": _fn("self_findings",
                      "The ledger of issues found in Shell:B's own code. action=list (status open|fixed|wontfix, default "
                      "open): what earlier reviews found. add (title, severity critical|high|medium|low, file e.g. "
                      "server/app.py:640, evidence): record a finding; the same title+file again just refreshes it. "
                      "mark (id, status fixed|wontfix|open, note): after you re-checked the code. Re-check open findings "
                      "before adding new ones, and cite file:line evidence.",
                      {"action": {"type": "string", "enum": ["list", "add", "mark"]},
                       "status": {"type": "string", "enum": list(STATUSES)},
                       "id": {"type": "string"}, "title": {"type": "string"},
                       "severity": {"type": "string", "enum": list(SEVERITIES)},
                       "file": {"type": "string"}, "evidence": {"type": "string"}, "note": {"type": "string"}},
                      ["action"]),
    }


def _give_reviewer_the_tools():
    """The cloud reviewer (agent `claude`) gets the source-only tools once, in the stored roster too."""
    if db.kv_get("selfreview_tools_added"):
        return
    agents = db.kv_get("agents")
    if agents:
        for a in agents:
            if a["id"] == "claude":
                a["tools"] = list(dict.fromkeys(a.get("tools", []) + ["shellb_source", "self_findings"]))
            if a["id"] in ("shellb", "hephaestus"):
                a["tools"] = list(dict.fromkeys(a.get("tools", []) + ["self_findings"]))
        db.kv_set("agents", agents)
    db.kv_set("selfreview_tools_added", True)


# Seeded from the 2026-10-07 review (fixed items are recorded as fixed so a later review knows they were checked).
SEED = [
    ("Path traversal through '..' project/board/asset IDs could read admin.key or delete data/", "critical",
     "server/projects.py:311", "fixed", "62d3c23: auth._bad_path middleware + ids.check in folder helpers"),
    ("Backups excluded project .git folders; restore wiped Studio/Code history and git fell through to the app repo",
     "critical", "server/backup.py:52", "fixed", "62d3c23: .git kept, projects.git pinned with GIT_DIR"),
    ("planetary.py called fetchers deleted in 9879d92 (telemetry, earthquakes, Atlas tool 500)", "high",
     "server/planetary.py:361", "fixed", "62d3c23 restored them"),
    ("Auto-compaction deleted message rows and told the model it retained full context", "high",
     "server/app.py:649", "fixed", "62d3c23: compaction.py marks instead of deleting"),
    ("Agent-created schedules ran without owner approval", "medium", "server/schedules.py:407", "fixed",
     "2788f40: approval card / disabled for review"),
    ("Secretary diarization over-segments (51 speakers in one meeting) using hand-built pitch/MFCC features", "high",
     "server/secretary.py:81", "open", "Neural speaker embeddings via HERMES planned"),
    ("Main UI bundle is 2.7 MB: shells and heavy apps are not lazy-loaded", "medium", "ui/src/main.tsx:9", "open", ""),
    ("Kiosk opens empty windows for Wiki, Memory, Agent Lab and Tools and ignores hash links", "medium",
     "ui/src/kiosk/KioskApp.tsx:722", "open", ""),
    ("171 places swallow errors silently (catch(() => {})), several on user actions", "medium",
     "ui/src/components/Notes.tsx:294", "open", ""),
    ("No DNS pinning: _blocked_host resolves, then httpx resolves again (rebinding window)", "low",
     "server/tools.py:88", "open", ""),
]


def _seed():
    if db.kv_get("findings_seeded"):
        return
    for title, sev, file, status, note in SEED:
        f = upsert(title, sev, file, source="review 2026-10-07")
        if status != "open" or note:
            mark(f["id"], status, note)
    db.kv_set("findings_seeded", True)


# ── HTTP ────────────────────────────────────────────────────────────────────

@router.get("")
def api_list(status: str = ""):
    return list_findings(status)


@router.patch("/{fid}")
async def api_mark(fid: str, req: Request):
    body = await req.json()
    try:
        return mark(fid, str(body.get("status") or ""), str(body.get("note") or ""))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except KeyError:
        raise HTTPException(404, "No such finding")
