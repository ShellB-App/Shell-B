"""Import chat history from ChatGPT and Claude data exports (Settings → Memory → Import history).

Upload the export zip (or its bare conversations.json) → it is parsed on this machine into a preview held in memory →
the owner imports all or some of it. Each conversation becomes an ordinary Shell:B chat in a chat Project named
"Imported from ChatGPT" / "Imported from Claude", with the original timestamps, so:
- message search picks it up: episodes.py's FTS5 triggers on `messages` index every insert;
- the episodic sweep (episodes.py) summarizes it in the background like any other quiet chat;
- "Learn from past chats" (memory.py `_history_convs`, every chat with no Studio project) reads it.
`chat_imports` maps (source, original id) → conversation, so importing the same export again skips what is already
here; deleting an imported chat makes it importable again.

Formats (both drift; everything is read defensively):
- ChatGPT: conversations.json = [{title, create_time, update_time, mapping: {node: {message, parent, children}},
  current_node, conversation_id|id}]. The visible branch is current_node → parent → … → root. Only user/assistant
  text addressed to everyone is kept; images, audio and files become a short placeholder note.
- Claude: conversations.json = [{uuid, name, created_at, updated_at, chat_messages: [{sender: human|assistant, text,
  content: [{type: text, text}…], created_at, attachments, files}]}].
"""
import asyncio
import json
import re
import secrets
import threading
import time
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile

import db

router = APIRouter(prefix="/api/import")

UPLOADS = db.DATA / "imports"
MAX_UPLOAD = 4 * 1024 ** 3        # exports with images can be large; only conversations.json is read
MAX_JSON = 2 * 1024 ** 3
SESSION_TTL = 3600
SOURCES = {"chatgpt": "ChatGPT", "claude": "Claude", "gemini": "Gemini"}

_sessions: dict[str, dict] = {}   # upload token → {source, convs, created, filename}
_job = {"running": False, "phase": "", "done": 0, "total": 0, "imported": 0, "skipped": 0, "messages": 0, "error": "",
        "source": "", "groupId": None, "groupName": "", "finished": None}
_job_lock = threading.Lock()
_ready = False


def init():
    global _ready
    with db.conn() as c:
        c.execute("CREATE TABLE IF NOT EXISTS chat_imports(source TEXT, original_id TEXT, conv_id TEXT, imported REAL, "
                  "PRIMARY KEY(source, original_id))")
        c.execute("CREATE INDEX IF NOT EXISTS chat_imports_conv ON chat_imports(conv_id)")
    _ready = True


def _ensure():
    if not _ready:
        init()


# ── parsing ─────────────────────────────────────────────────────────────────

def _ts(v) -> float | None:
    """Epoch seconds from a float/int, numeric string or ISO-8601 string."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v) / (1000 if v > 1e11 else 1)  # milliseconds, just in case
    if isinstance(v, str):
        try:
            return _ts(float(v))
        except ValueError:
            pass
        try:
            return datetime.fromisoformat(v.strip().replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def _str(v) -> str:
    return v if isinstance(v, str) else ""


def _gpt_part(p) -> str:
    """One entry of ChatGPT `content.parts`: text, or a placeholder for what can't be carried over."""
    if isinstance(p, str):
        return p
    if not isinstance(p, dict):
        return ""
    kind = _str(p.get("content_type"))
    if kind == "audio_transcription" or (not kind and isinstance(p.get("text"), str)):
        return _str(p.get("text"))
    if "image" in kind:
        return "*[Image not imported]*"
    if "audio" in kind or "video" in kind:
        return ""  # voice-mode audio; its transcription is a separate part
    return "*[Attachment not imported]*"


def _gpt_text(msg: dict) -> str:
    content = msg.get("content") if isinstance(msg.get("content"), dict) else {}
    kind = _str(content.get("content_type"))
    if kind in ("text", "multimodal_text", ""):
        parts = content.get("parts") if isinstance(content.get("parts"), list) else []
        text = "\n\n".join(t for t in (_gpt_part(p).strip() for p in parts) if t)
        if not text and isinstance(content.get("text"), str):
            text = content["text"]
    elif kind == "code":
        code = _str(content.get("text")).strip()
        text = f"```{_str(content.get('language')) if content.get('language') not in (None, 'unknown') else ''}\n{code}\n```" if code else ""
    else:  # thoughts, reasoning_recap, tether_*, execution_output, user_editable_context, system_error…
        return ""
    meta = msg.get("metadata") if isinstance(msg.get("metadata"), dict) else {}
    atts = meta.get("attachments") if isinstance(meta.get("attachments"), list) else []
    names = [_str(a.get("name")) or "file" for a in atts if isinstance(a, dict)]
    if names:
        text = (text + "\n\n" if text else "") + "*[Attached, not imported: " + ", ".join(names) + "]*"
    return text.strip()


def _gpt_branch(mapping: dict, current) -> list[dict]:
    """The visible branch: from current_node up the parent links (cycle-safe), else the newest leaf."""
    if current not in mapping:
        leaves = [k for k, n in mapping.items() if isinstance(n, dict) and not n.get("children")]
        def when(k):
            m = mapping[k].get("message") or {}
            return _ts(m.get("create_time")) or 0
        current = max(leaves, key=when) if leaves else None
    chain, seen = [], set()
    while current in mapping and current not in seen:
        seen.add(current)
        node = mapping[current] if isinstance(mapping[current], dict) else {}
        if isinstance(node.get("message"), dict):
            chain.append(node["message"])
        current = node.get("parent")
    return chain[::-1]


def _parse_chatgpt(conv: dict) -> dict | None:
    mapping = conv.get("mapping")
    if not isinstance(mapping, dict):
        return None
    msgs = []
    for m in _gpt_branch(mapping, conv.get("current_node")):
        role = _str((m.get("author") or {}).get("role"))
        meta = m.get("metadata") if isinstance(m.get("metadata"), dict) else {}
        if role not in ("user", "assistant") or meta.get("is_visually_hidden_from_conversation"):
            continue
        if role == "assistant" and m.get("recipient") not in (None, "all"):  # a tool call (python, browser, dalle…)
            continue
        text = _gpt_text(m)
        if text:
            msgs.append({"role": role, "text": text, "ts": _ts(m.get("create_time")), "model": _str(meta.get("model_slug"))})
    return {"id": _str(conv.get("conversation_id")) or _str(conv.get("id")), "title": _str(conv.get("title")).strip(),
            "created": _ts(conv.get("create_time")), "updated": _ts(conv.get("update_time")), "messages": msgs}


def _parse_claude(conv: dict) -> dict | None:
    items = conv.get("chat_messages")
    if not isinstance(items, list):
        return None
    msgs = []
    for m in items:
        if not isinstance(m, dict):
            continue
        sender = _str(m.get("sender") or m.get("role"))
        role = {"human": "user", "user": "user", "assistant": "assistant"}.get(sender)
        if not role:
            continue
        texts = []
        for b in m.get("content") if isinstance(m.get("content"), list) else []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and isinstance(b.get("text"), str):
                texts.append(b["text"])
            elif b.get("type") == "tool_use" and isinstance(b.get("input"), dict) and isinstance(b["input"].get("content"), str):
                inp = b["input"]  # an Artifact: keep its content, it's often the point of the chat
                title = _str(inp.get("title")) or "Artifact"
                lang = _str(inp.get("language")) or {"application/vnd.ant.code": "", "text/html": "html", "text/markdown": "markdown",
                                                     "image/svg+xml": "svg", "application/vnd.ant.mermaid": "mermaid",
                                                     "application/vnd.ant.react": "jsx"}.get(_str(inp.get("type")), "")
                texts.append(f"**{title}**\n\n```{lang}\n{inp['content']}\n```")
            elif b.get("type") == "image":
                texts.append("*[Image not imported]*")
        text = "\n\n".join(t.strip() for t in texts if t and t.strip()) or _str(m.get("text")).strip()
        names = [_str(a.get("file_name")) or "file" for k in ("attachments", "files")
                 for a in (m.get(k) if isinstance(m.get(k), list) else []) if isinstance(a, dict)]
        if names:
            text = (text + "\n\n" if text else "") + "*[Attached, not imported: " + ", ".join(dict.fromkeys(names)) + "]*"
        if text:
            msgs.append({"role": role, "text": text, "ts": _ts(m.get("created_at")), "model": ""})
    return {"id": _str(conv.get("uuid")) or _str(conv.get("id")), "title": _str(conv.get("name")).strip(),
            "created": _ts(conv.get("created_at")), "updated": _ts(conv.get("updated_at")), "messages": msgs}


def _normalize(c: dict) -> dict:
    """Merge consecutive same-role messages, make timestamps strictly increasing, fill in title and dates."""
    merged = []
    for m in c["messages"]:
        if merged and merged[-1]["role"] == m["role"]:
            merged[-1]["text"] += "\n\n" + m["text"]
            merged[-1]["model"] = merged[-1]["model"] or m["model"]
        else:
            merged.append(dict(m))
    first = next((m["ts"] for m in merged if m["ts"]), None)
    t = c["created"] or first or time.time()
    c["created"] = t
    for m in merged:  # messages are ordered by `created`, so ties or clock skew would shuffle them
        m["ts"] = m["ts"] if m["ts"] and m["ts"] > t else t + 0.001
        t = m["ts"]
    c["updated"] = max(c["updated"] or 0, t)
    c["messages"] = merged
    if not c["title"]:
        first_user = next((m["text"] for m in merged if m["role"] == "user"), "")
        line = first_user.strip().splitlines()[0] if first_user.strip() else ""
        c["title"] = (line[:77] + "…") if len(line) > 80 else (line or "Untitled chat")
    c["title"] = c["title"][:200]
    return c


def _parse_gemini(day: dict) -> dict | None:
    """One day of Takeout's My Activity → Gemini Apps records (MyActivity.json), grouped by `_gemini_days`.

    Each record is one prompt: {"header": "Gemini Apps", "title": "Prompted <text>", "time": ISO, "details": [...],
    "subtitles": [...]}. Takeout logs what was asked, not the model's reply, so these chats hold the prompts (and a reply
    when a record carries one under "subtitles"), one chat per day."""
    msgs = []
    for r in day["records"]:
        title = _str(r.get("title"))
        text = re.sub(r"^(Prompted|Asked|Searched for)\s+", "", title).strip()
        if not text or re.match(r"^(Used|Visited|Viewed|Opened)\b", title):
            continue
        ts = _iso_ts(r.get("time"))
        msgs.append({"role": "user", "text": text, "ts": ts, "model": "gemini"})
        reply = " ".join(_str(s.get("name")) for s in (r.get("subtitles") or []) if isinstance(s, dict) and _str(s.get("name")).strip())
        if reply and not reply.startswith(("Gemini Apps", "Google")):
            msgs.append({"role": "assistant", "text": reply, "ts": ts, "model": "gemini"})
    if not msgs:
        return None
    first, last = min(m["ts"] or 0 for m in msgs), max(m["ts"] or 0 for m in msgs)
    return {"id": f"gemini-{day['day']}", "title": f"Gemini · {day['day']}", "created": first, "updated": last, "messages": msgs}


def _iso_ts(v) -> float | None:
    from datetime import datetime
    s = _str(v).strip()
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _gemini_days(records: list) -> list[dict]:
    """Takeout records → [{day: YYYY-MM-DD, records: [...]}], oldest first."""
    from datetime import datetime, timezone
    days: dict[str, list] = {}
    for r in records:
        if not isinstance(r, dict) or _str(r.get("header")) != "Gemini Apps":
            continue
        ts = _iso_ts(r.get("time"))
        day = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d") if ts else "undated"
        days.setdefault(day, []).append(r)
    return [{"day": d, "records": sorted(rs, key=lambda r: _iso_ts(r.get("time")) or 0)} for d, rs in sorted(days.items())]


def detect(data) -> tuple[str, list]:
    if isinstance(data, dict):  # a single conversation, or a wrapper object
        for k in ("conversations", "items", "data"):
            if isinstance(data.get(k), list):
                data = data[k]
                break
        else:
            data = [data]
    if not isinstance(data, list):
        raise ValueError("This file has no list of conversations.")
    for c in data[:50]:
        if isinstance(c, dict) and isinstance(c.get("mapping"), dict):
            return "chatgpt", data
        if isinstance(c, dict) and isinstance(c.get("chat_messages"), list):
            return "claude", data
        if isinstance(c, dict) and _str(c.get("header")) == "Gemini Apps" and "title" in c:
            return "gemini", _gemini_days(data)
    raise ValueError("Not a ChatGPT, Claude or Gemini export: no conversations with `mapping` or `chat_messages`, and no "
                     "Gemini Apps activity records, found.")


def parse(data) -> tuple[str, list[dict]]:
    source, raw = detect(data)
    fn = {"chatgpt": _parse_chatgpt, "claude": _parse_claude, "gemini": _parse_gemini}[source]
    out, seen = [], set()
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            continue
        try:
            c = fn(item)
        except Exception:  # noqa: BLE001 — one malformed conversation shouldn't sink the export
            c = None
        if not c or not c["messages"]:
            continue
        c["id"] = c["id"] or f"idx-{i}-{c['created'] or 0}"
        if c["id"] in seen:
            continue
        seen.add(c["id"])
        out.append(_normalize(c))
    return source, out


def _read_json_file(path: Path):
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if (Path(n).name.lower().startswith("conversations") or
                     (Path(n).name == "MyActivity.json" and "Gemini" in n)) and n.lower().endswith(".json") and not n.startswith("__MACOSX")]
            if not names:
                if any(Path(n).name == "MyActivity.html" and "Gemini" in n for n in z.namelist()):
                    raise ValueError("This Google Takeout has Gemini activity as HTML. Export again with the JSON format "
                                     "(Takeout → My Activity → Multiple formats → JSON) and upload that zip.")
                raise ValueError("No conversations.json (ChatGPT, Claude) or Gemini Apps MyActivity.json (Google Takeout) in this zip.")
            combined = []
            for n in sorted(names, key=lambda n: (n.count("/"), n)):  # conversations.json, or conversations-000.json …
                if z.getinfo(n).file_size > MAX_JSON:
                    raise ValueError(f"{n} is too large to import.")
                with z.open(n) as f:
                    data = json.load(f)
                combined.extend(data if isinstance(data, list) else [data])
            return combined
    with open(path, "rb") as f:
        head = f.read(1).lstrip()
    try:
        with open(path, encoding="utf-8-sig") as f:
            return json.load(f)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ValueError("That isn't a zip or a JSON file." if head not in (b"[", b"{") else "The JSON in this file is damaged.")


def existing(source: str) -> dict[str, str]:
    """original id → conversation id, for imports whose chat still exists."""
    _ensure()
    with db.conn() as c:
        rows = c.execute("SELECT i.original_id, i.conv_id FROM chat_imports i JOIN conversations c ON c.id=i.conv_id "
                         "WHERE i.source=?", (source,)).fetchall()
    return {r["original_id"]: r["conv_id"] for r in rows}


def _preview(token: str) -> dict:
    s = _sessions[token]
    have = existing(s["source"])
    convs = s["convs"]
    dates = [c["created"] for c in convs]
    return {"token": token, "source": s["source"], "sourceLabel": SOURCES[s["source"]], "filename": s["filename"],
            "count": len(convs), "already": sum(c["id"] in have for c in convs),
            "messages": sum(len(c["messages"]) for c in convs),
            "from": min(dates) * 1000 if dates else None, "to": max(c["updated"] for c in convs) * 1000 if convs else None,
            "conversations": [{"id": c["id"], "title": c["title"], "createdAt": c["created"] * 1000, "updatedAt": c["updated"] * 1000,
                               "messages": len(c["messages"]), "imported": c["id"] in have, "convId": have.get(c["id"])}
                              for c in sorted(convs, key=lambda c: -c["updated"])]}


# ── importing ───────────────────────────────────────────────────────────────

def _group_for(source: str) -> tuple[str, str]:
    name = f"Imported from {SOURCES[source]}"
    now = time.time()
    with db.conn() as c:
        r = c.execute("SELECT id FROM groups WHERE name=? ORDER BY created LIMIT 1", (name,)).fetchone()
        if r:
            c.execute("UPDATE groups SET updated=? WHERE id=?", (now, r["id"]))
            return r["id"], name
        gid = f"grp-{db.new_id('x')[2:]}"
        c.execute("INSERT INTO groups(id, name, description, instructions, emoji, color, pinned, created, updated) VALUES(?,?,?,?,?,?,0,?,?)",
                  (gid, name, f"Conversations imported from a {SOURCES[source]} data export. Edit or move them like any chat.",
                   "", "", "", now, now))
    (db.DATA / "groups" / gid / "files").mkdir(parents=True, exist_ok=True)
    return gid, name


def run_import(source: str, convs: list[dict], agent_id: str, batch: int = 25):
    """Blocking; call in a thread. Writes in short transactions so live chats aren't starved of the write lock."""
    _ensure()
    have = existing(source)
    todo = [c for c in convs if c["id"] not in have]
    _job.update(phase="importing", total=len(convs), done=len(convs) - len(todo), skipped=len(convs) - len(todo))
    if not todo:
        return
    gid, gname = _group_for(source)
    _job.update(groupId=gid, groupName=gname)
    label = SOURCES[source]
    for i in range(0, len(todo), batch):
        with db.conn() as c:
            for conv in todo[i:i + batch]:
                cid = db.new_id("conv")
                c.execute("INSERT INTO conversations(id, title, agent_id, pinned, created, updated, project_id, group_id) "
                          "VALUES(?,?,?,0,?,?,NULL,?)", (cid, conv["title"], agent_id, conv["created"], conv["updated"], gid))
                for m in conv["messages"]:
                    data = {"imported": source}
                    if m["role"] == "assistant":
                        data.update(agentId=agent_id, model=f"{label}{' · ' + m['model'] if m['model'] else ''}",
                                    blocks=[{"type": "text", "text": m["text"]}], status="complete")
                    c.execute("INSERT INTO messages VALUES(?,?,?,?,?,?)",
                              (db.new_id("msg"), cid, m["role"], m["text"], json.dumps(data), m["ts"]))
                c.execute("INSERT OR REPLACE INTO chat_imports VALUES(?,?,?,?)", (source, conv["id"], cid, time.time()))
                _job["imported"] += 1
                _job["messages"] += len(conv["messages"])
                _job["done"] += 1


def _run_job(token: str, ids: list[str] | None):
    """The whole job runs in its own thread: the event loop never waits on it, and it can't be cancelled half-way."""
    s = _sessions.get(token)
    try:
        convs = s["convs"] if ids is None else [c for c in s["convs"] if c["id"] in set(ids)]
        agent_id = (db.kv_get("settings", {}) or {}).get("defaultAgent") or "shellb"
        run_import(s["source"], convs, agent_id)
        db.audit_log("import:chats", {"source": s["source"], "imported": _job["imported"], "skipped": _job["skipped"]})
    except Exception as e:  # noqa: BLE001
        _job["error"] = f"{type(e).__name__}: {e}"
    finally:
        _job.update(running=False, phase="done", finished=time.time())
    if _job["imported"]:
        import activity
        activity.post("memory", "done", f"Imported {_job['imported']} chat{'s' if _job['imported'] != 1 else ''} from {SOURCES[s['source']]}",
                      "They're searchable now. Learn from them in Settings → Memory.", f"#/p/{_job['groupId']}",
                      ref=f"import:{token}:{time.time():.3f}")


def _gc():
    now = time.time()
    for t in [t for t, s in _sessions.items() if now - s["created"] > SESSION_TTL]:
        _sessions.pop(t, None)


# ── HTTP ────────────────────────────────────────────────────────────────────

@router.post("/upload")
async def api_upload(file: UploadFile = File(...)):
    """Save the upload, parse it in a thread, and return a preview. The file is deleted once parsed."""
    _gc()
    UPLOADS.mkdir(exist_ok=True)
    token = secrets.token_hex(8)
    path = UPLOADS / f"{token}.upload"
    size = 0
    try:
        with path.open("wb") as out:
            while chunk := await file.read(1 << 20):
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise HTTPException(413, "That file is larger than 4 GB.")
                out.write(chunk)
        try:
            source, convs = await asyncio.to_thread(lambda: parse(_read_json_file(path)))
        except (ValueError, zipfile.BadZipFile) as e:
            raise HTTPException(400, str(e))
    finally:
        path.unlink(missing_ok=True)
    if not convs:
        raise HTTPException(400, "This export has no conversations with any text in them.")
    _sessions[token] = {"source": source, "convs": convs, "created": time.time(), "filename": Path(file.filename or "").name}
    return await asyncio.to_thread(_preview, token)


@router.post("/run")
async def api_run(req: Request):
    body = await req.json()
    token = str(body.get("token") or "")
    if token not in _sessions:
        raise HTTPException(404, "That upload has expired. Choose the file again.")
    ids = body.get("ids")
    if ids is not None and not isinstance(ids, list):
        raise HTTPException(400, "`ids` must be a list")
    with _job_lock:
        if _job["running"]:
            raise HTTPException(409, "An import is already running")
        _job.update(running=True, phase="starting", done=0, total=0, imported=0, skipped=0, messages=0, error="",
                    source=_sessions[token]["source"], groupId=None, groupName="", finished=None)
    threading.Thread(target=_run_job, args=(token, [str(i) for i in ids] if ids is not None else None),
                     name="chat-import", daemon=True).start()
    return dict(_job)


@router.get("/status")
def api_status():
    return dict(_job)


@router.get("/preview/{token}")
async def api_preview(token: str):
    if token not in _sessions:
        raise HTTPException(404, "That upload has expired. Choose the file again.")
    return await asyncio.to_thread(_preview, token)


@router.delete("/{token}")
def api_discard(token: str):
    _sessions.pop(token, None)
    return {"ok": True}


@router.get("/learnable")
def api_learnable():
    """Imported chats that "Learn from past chats" hasn't read yet (it reads every non-Studio chat, these included)."""
    _ensure()
    done = set(db.kv_get("memory_backfilled", []))
    with db.conn() as c:
        ids = [r["conv_id"] for r in c.execute("SELECT i.conv_id FROM chat_imports i JOIN conversations c ON c.id=i.conv_id "
                                               "WHERE c.project_id IS NULL")]
    return {"imported": len(ids), "unread": sum(i not in done for i in ids)}
