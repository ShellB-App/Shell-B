"""Episodic memory: Shell:B remembers past conversations, not just facts (memory.py).

Two indexes over every conversation (chats, chat Projects, Studio/Code threads, unattended runs):
  msg_fts       SQLite FTS5 over message text, kept in sync by triggers on `messages`, so every writer (db.py,
                deletions, regenerations) is covered without code changes there.
  conv_summary  a 1-3 sentence summary per conversation by the utility model, plus its embedding. A background sweep
                (`start`) writes them for conversations whose message count changed and that have been quiet for a
                minute. It waits while anyone is chatting and shares memory.py's lock so the GPU sees one job at a time.

Agents get `recall_conversations` (search, then read), and the system prompt lists a few recent conversations with
their summaries so there is continuity between chats. The sidebar search uses `/api/chats/search`.
"""
import asyncio
import time

import httpx
import numpy as np
from fastapi import APIRouter

import db
from episodes_search import (
    SEM_ALONE,
    SEM_MIN,
    STOP,
    _clip,
    _conv_meta,
    _fts_query,
    _plain,
    read,
    recent,
    search,
    semantic_search,
    text_search,
)

# Re-export search and retrieval symbols for backward compatibility
__all__ = [
    "GUIDE",
    "PER_SWEEP",
    "QUIET",
    "SEM_ALONE",
    "SEM_MIN",
    "STOP",
    "SWEEP_EVERY",
    "_clip",
    "_conv_meta",
    "_fts_query",
    "_plain",
    "init",
    "read",
    "recent",
    "router",
    "search",
    "semantic_search",
    "stale",
    "start",
    "summarize",
    "text_search",
]

router = APIRouter(prefix="/api/chats")

QUIET = 60            # seconds a conversation must be idle before it is (re)summarized
SWEEP_EVERY = 90
PER_SWEEP = 4
busy = lambda: False  # noqa: E731  set by app.py: True while a turn is running
_task = None
_stats = {"summarized": 0, "last": 0.0, "error": ""}

GUIDE = """- recall_conversations searches your past conversations with the user (full text plus summaries) and reads them.
  Use it when the user refers to an earlier chat ("last time", "what did we decide about…", "that script you wrote"),
  or when earlier work would clearly help. Search first, then `read` the best match (optionally around a message id).
  Say which conversation you're drawing on. Don't use it for facts already in your memory list."""


# ── storage ─────────────────────────────────────────────────────────────────

def init():
    with db.conn() as c:
        c.executescript("""
CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(
  content, msg_id UNINDEXED, conv_id UNINDEXED, role UNINDEXED, created UNINDEXED, tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS msg_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO msg_fts(rowid, content, msg_id, conv_id, role, created) VALUES (new.rowid, new.content, new.id, new.conv_id, new.role, new.created);
END;
CREATE TRIGGER IF NOT EXISTS msg_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM msg_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS msg_fts_au AFTER UPDATE OF content ON messages BEGIN
  DELETE FROM msg_fts WHERE rowid = old.rowid;
  INSERT INTO msg_fts(rowid, content, msg_id, conv_id, role, created) VALUES (new.rowid, new.content, new.id, new.conv_id, new.role, new.created);
END;
CREATE TABLE IF NOT EXISTS conv_summary(
  conv_id TEXT PRIMARY KEY, summary TEXT, embedding BLOB, msg_count INTEGER, updated REAL);
""")
        if not db.kv_get("msg_fts_built"):  # index the messages written before the triggers existed
            c.execute("DELETE FROM msg_fts")
            c.execute("INSERT INTO msg_fts(rowid, content, msg_id, conv_id, role, created) "
                      "SELECT rowid, content, id, conv_id, role, created FROM messages")
    db.kv_set("msg_fts_built", True)
    if not db.kv_get("episodes_tools"):  # agents with memory get the past-conversation tool once
        agents = db.kv_get("agents")
        if agents:
            for a in agents:
                tools = a.get("tools", [])
                # not scouts: they read untrusted pages and can fetch URLs, so past chats would be one injection away
                if "memory_search" in tools and "recall_conversations" not in tools and "scrape" not in tools:
                    tools.insert(tools.index("memory_search") + 1, "recall_conversations")
            db.kv_set("agents", agents)
        db.kv_set("episodes_tools", True)
    with db.conn() as c:  # summaries of deleted conversations
        c.execute("DELETE FROM conv_summary WHERE conv_id NOT IN (SELECT id FROM conversations)")


def _settings():
    from defaults import DEFAULT_SETTINGS
    return {**DEFAULT_SETTINGS, **db.kv_get("settings", {})}


# ── summaries ───────────────────────────────────────────────────────────────

SUMMARY_PROMPT = """Summarize this conversation between a user and their AI assistant for the assistant's future reference.
In 1-3 plain sentences: what the user wanted, what was decided, made or found (name files, artifacts, numbers), and
anything left open. No preamble, no Markdown.

Title: {title}

{transcript}"""


def _transcript(conv_id: str) -> str:
    msgs = [m for m in db.list_messages(conv_id) if (m["content"] or "").strip() and m["role"] in ("user", "assistant")]
    lines = [f"{'User' if m['role'] == 'user' else 'Assistant'}: {_clip(m['content'], 900)}" for m in msgs]
    return _clip("\n\n".join(lines), 9000)


async def summarize(conv_id: str, settings: dict) -> str:
    from agent import OLLAMA, model_info
    import providers
    model = settings.get("utilityModel") or ""
    if not model or providers.is_cloud(model):  # transcripts stay on this machine
        return ""
    conv = db.get_conversation(conv_id)
    if not conv:
        return ""
    with db.conn() as c:
        count = c.execute("SELECT count(*) FROM messages WHERE conv_id=?", (conv_id,)).fetchone()[0]
    payload = {"model": model, "stream": False, "keep_alive": "2h", "options": {"temperature": 0.2, "num_predict": 220},
               "messages": [{"role": "user", "content": SUMMARY_PROMPT.format(title=conv["title"], transcript=_transcript(conv_id))}]}
    if "thinking" in (await model_info(model))["capabilities"]:
        payload["think"] = False
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post(f"{OLLAMA}/api/chat", json=payload)
        r.raise_for_status()
    summary = " ".join((r.json()["message"]["content"] or "").replace("**", "").split())[:700]
    emb = None
    if summary:
        from tools import embed
        try:
            emb = (await embed([f"{conv['title']}. {summary}"], settings["embeddingModel"]))[0].astype(np.float32).tobytes()
        except Exception:  # noqa: BLE001
            emb = None
    with db.conn() as c:
        c.execute("INSERT OR REPLACE INTO conv_summary VALUES(?,?,?,?,?)", (conv_id, summary, emb, count, time.time()))
    return summary


def stale(limit=PER_SWEEP) -> list[str]:
    """Conversations with at least one exchange whose summary is missing or behind, quiet for QUIET seconds."""
    with db.conn() as c:
        rows = c.execute("""
SELECT m.conv_id, count(*) AS n, max(m.created) AS last FROM messages m
LEFT JOIN conv_summary s ON s.conv_id = m.conv_id
WHERE m.conv_id NOT IN (SELECT id FROM conversations WHERE incognito=1)
GROUP BY m.conv_id HAVING n >= 2 AND last < ? AND (max(s.msg_count) IS NULL OR max(s.msg_count) != n)
ORDER BY last DESC LIMIT ?""", (time.time() - QUIET, limit)).fetchall()
    return [r["conv_id"] for r in rows]


async def _sweep():
    import memory
    await asyncio.sleep(20)  # let startup settle
    while True:
        try:
            import privacy
            privacy.sweep()  # incognito chats past their time are deleted
        except Exception as e:  # noqa: BLE001
            print(f"incognito sweep: {type(e).__name__}: {e}")
        try:
            if not busy():
                settings = _settings()
                for cid in stale():
                    if busy():
                        break
                    async with memory._lock:
                        await summarize(cid, settings)
                    _stats["summarized"] += 1
                    _stats["last"] = time.time()
                _stats["error"] = ""
        except Exception as e:  # noqa: BLE001
            _stats["error"] = f"{type(e).__name__}: {e}"
            print(f"episodes sweep: {_stats['error']}")
        await asyncio.sleep(SWEEP_EVERY)


def start():
    global _task
    if _task is None:
        _task = asyncio.create_task(_sweep())


def stop():
    global _task
    if _task and not _task.done():
        _task.cancel()
        _task = None


# ── HTTP ────────────────────────────────────────────────────────────────────

@router.get("/search")
def api_search(q: str = "", limit: int = 20, conv_id: str | None = None):
    """Sidebar & full-text search: conversations whose messages match the query, newest first."""
    q = q.strip()
    if len(q) < 2:
        return {"results": []}
    found = text_search(q, "all", limit=300, conv_id=conv_id)
    if not found and " " in q:
        found = text_search(q, "any", limit=300, conv_id=conv_id)
    meta = _conv_meta(found)
    out = [{**meta[i], "hits": found[i]["hits"][:5], "totalHits": len(found[i]["hits"])} for i in found if i in meta]
    out.sort(key=lambda r: -r["updatedAt"])
    return {"results": out[: max(1, min(limit, 50))]}


@router.get("/summary-status")
def api_status():
    with db.conn() as c:
        done = c.execute("SELECT count(*) FROM conv_summary").fetchone()[0]
    return {**_stats, "summaries": done, "pending": len(stale(1000))}
