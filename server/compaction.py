"""Chat compaction that never deletes anything.

When a chat's history fills most of its agent's context window, the oldest messages are summarized: a `summary`
row is inserted where they end, and each summarized message gets `data.summarizedBy = <summary id>`. The originals
stay in the database, the full-text index (episodes.msg_fts) and the chat view; only the prompt leaves them out
(agent.history_messages, through `visible`). A later summary folds the previous one in, and marks it summarizedBy
too, so the prompt only ever carries the newest summary.

The summary is written in the background after a reply (`schedule`), never while someone waits for the next one,
and is applied at the start of the following turn (`commit_pending`), only if the summarized messages haven't
changed in between (an edit or regenerate deletes them).

Older versions deleted the summarized rows and kept a JSON copy inside a `compacted` row; `migrate_legacy` puts
those back once.
"""
import asyncio
import hashlib
import json
import re
import time

import httpx

import db
import providers
from capabilities import model_info
from tools import OLLAMA

CHARS_PER_TOKEN = 3.0      # agent.CHARS_PER_TOKEN (not imported: agent imports this module)
TRIGGER = 0.70             # summarize once the next prompt would fill this much of num_ctx
TARGET = 0.30              # ...until the history left in the prompt is about this much of it
KEEP_RECENT = 4            # the newest messages are never summarized
SUMMARY_CHARS = 6000       # longest summary kept (the utility model is asked for far less)
_inflight: set[str] = set()
_tasks: set[asyncio.Task] = set()


def _kv_key(conv_id: str) -> str:
    return f"compaction_pending:{conv_id}"


def _clear(conv_id: str):
    with db.conn() as c:
        c.execute("DELETE FROM kv WHERE key=?", (_kv_key(conv_id),))


# ── what the prompt sees ────────────────────────────────────────────────────

def visible(history: list[dict]) -> list[dict]:
    """The messages a prompt is built from: summarized originals (and superseded summaries) left out. A message whose
    summary was deleted (an edit before it) counts as not summarized again."""
    ids = {m["id"] for m in history if m.get("role") == "summary"}
    return [m for m in history if not (m.get("summarizedBy") and m["summarizedBy"] in ids)
            and m.get("role") in ("user", "assistant", "summary")]


def latest_summary(history: list[dict]) -> dict | None:
    return next((m for m in reversed(visible(history)) if m.get("role") == "summary"), None)


def _chars(m: dict) -> int:
    n = len(m.get("content") or "")
    for b in m.get("blocks") or []:  # tool calls and results don't reach the prompt in full; count a little of each
        if b.get("type") == "tool":
            n += min(len(json.dumps(b.get("args") or {}, ensure_ascii=False)) + len(b.get("result") or ""), 1200)
    return n


def history_chars(history: list[dict]) -> int:
    return sum(_chars(m) for m in visible(history))


def note(history: list[dict], conv_id: str) -> str:
    """The system-prompt section that stands in for summarized messages; "" when nothing is summarized."""
    s = latest_summary(history)
    if not s:
        return ""
    count = s.get("count") or len(s.get("summaryOf") or [])
    return (f"## Earlier in this conversation\n"
            f"The first {count} messages of this chat are no longer in your context. Below is a lossy summary of them, "
            f"written by a smaller model: exact code, numbers and wording may be missing. When you need specifics, read "
            f"them with recall_conversations (action read, conversation {conv_id}) or ask the user. Don't claim to "
            f"remember details that aren't here.\n\n{s['content']}")


def context_info(history: list[dict], num_ctx: int, fixed_chars: int = 0) -> dict:
    used = int((history_chars(history) + fixed_chars) / CHARS_PER_TOKEN)
    return {"used": used, "limit": int(num_ctx), "estimated": True}


# ── choosing what to summarize ──────────────────────────────────────────────

def _pick(history: list[dict], num_ctx: int, fixed_chars: int, force: bool) -> list[dict]:
    """The oldest visible messages to fold into the next summary (ending on an assistant reply)."""
    vis = visible(history)
    budget = num_ctx * CHARS_PER_TOKEN
    if not force and history_chars(history) + fixed_chars < budget * TRIGGER:
        return []
    msgs = [m for m in vis if m.get("role") in ("user", "assistant")]
    if len(msgs) <= KEEP_RECENT:
        return []
    candidates = msgs[:-KEEP_RECENT]
    remaining = sum(_chars(m) for m in msgs)
    goal = budget * TARGET - fixed_chars
    picked = []
    for m in candidates:
        if not force and remaining <= goal and picked and picked[-1]["role"] == "assistant":
            break
        picked.append(m)
        remaining -= _chars(m)
    while picked and picked[-1]["role"] != "assistant":  # never split a question from its answer
        picked.pop()
    return picked


def _signature(msgs: list[dict]) -> str:
    return hashlib.sha1("|".join(f"{m['id']}:{len(m.get('content') or '')}" for m in msgs).encode()).hexdigest()


# ── writing the summary ─────────────────────────────────────────────────────

def _clip(text: str, n: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= n else text[: n * 2 // 3] + " … " + text[-n // 3:]


async def _summarize(title: str, previous: str, msgs: list[dict], settings: dict) -> str:
    lines = []
    for m in msgs:
        role = "User" if m["role"] == "user" else "Assistant"
        tools = [b.get("name") for b in m.get("blocks") or [] if b.get("type") == "tool"]
        extra = f" [tools: {', '.join(t for t in tools[:8] if t)}]" if tools else ""
        if (m.get("content") or "").strip() or extra:
            lines.append(f"{role}{extra}: {_clip(m.get('content') or '', 1500)}")
    transcript = _clip("\n\n".join(lines), 24000)
    model = settings.get("utilityModel") or ""
    if model and not providers.is_cloud(model):
        prompt = (
            "You maintain the running summary of a long conversation between a user and an AI assistant. The messages "
            "below are leaving the assistant's context; your summary is all it will keep of them.\n"
            "Keep, as dense Markdown bullets: the user's goals, requirements and preferences; decisions and their "
            "reasons; facts, numbers, names and file paths (/work/..., project files) that later turns may need; "
            "what was built or changed; open questions and unfinished tasks. Fold the previous summary in; drop what "
            "is settled and no longer matters. No preamble.\n\n"
            f"Conversation title: {title}\n\n"
            f"Previous summary:\n{previous or '(none)'}\n\n"
            f"Messages to fold in:\n{transcript}")
        try:
            payload = {"model": model, "stream": False, "keep_alive": "30m",
                       "options": {"temperature": 0.2, "num_predict": 1200},
                       "messages": [{"role": "user", "content": prompt}]}
            if "thinking" in (await model_info(model))["capabilities"]:
                payload["think"] = False
            async with httpx.AsyncClient(timeout=120) as client:
                r = await client.post(f"{OLLAMA}/api/chat", json=payload)
            if r.status_code == 200:
                text = re.sub(r"<think>.*?</think>", "", r.json()["message"]["content"] or "", flags=re.S).strip()
                if text:
                    return text[:SUMMARY_CHARS]
        except Exception as e:  # noqa: BLE001 — fall back to an extractive summary
            print(f"compaction: utility model failed ({type(e).__name__}: {e}); using the extractive summary")
    # extractive fallback: first lines of each request and reply, plus the files mentioned
    asks = [m["content"].strip().split("\n")[0][:160] for m in msgs if m["role"] == "user" and m.get("content")]
    answers = [m["content"].strip().split("\n")[0][:160] for m in msgs if m["role"] == "assistant" and m.get("content")]
    files = sorted({f for m in msgs for f in re.findall(r"(/work/[\w./-]+|\b[\w-]+\.(?:py|tsx?|js|html|css|json|md|sh|sql)\b)",
                                                        m.get("content") or "")})
    parts = [previous] if previous else []
    if asks:
        parts.append("**Asked:**\n" + "\n".join(f"- {a}" for a in asks[:12]))
    if answers:
        parts.append("**Answered / did:**\n" + "\n".join(f"- {a}" for a in answers[:12]))
    if files:
        parts.append("**Files mentioned:** " + ", ".join(f"`{f}`" for f in files[:20]))
    return "\n\n".join(parts)[:SUMMARY_CHARS]


async def prepare(conv_id: str, num_ctx: int, fixed_chars: int, settings: dict, force: bool = False) -> dict | None:
    """Write the next summary and park it in kv until the next turn applies it. None if nothing needs summarizing."""
    conv = db.get_conversation(conv_id)
    if not conv:
        return None
    history = db.list_messages(conv_id)
    picked = _pick(history, num_ctx, fixed_chars, force)
    if not picked:
        return None
    prev = latest_summary(history)
    summary = await _summarize(conv["title"], prev["content"] if prev else "", picked, settings)
    pending = {"summary": summary, "ids": [m["id"] for m in picked], "sig": _signature(picked),
               "previous": prev["id"] if prev else None,
               "count": (prev.get("count", 0) if prev else 0) + len(picked), "created": time.time()}
    db.kv_set(_kv_key(conv_id), pending)
    return pending


def commit_pending(conv_id: str) -> dict | None:
    """Apply a parked summary, if its messages are still exactly as summarized. Returns the summary message."""
    pending = db.kv_get(_kv_key(conv_id))
    if not pending:
        return None
    _clear(conv_id)
    history = db.list_messages(conv_id)
    by_id = {m["id"]: m for m in history}
    picked = [by_id.get(i) for i in pending["ids"]]
    if any(m is None for m in picked) or _signature(picked) != pending["sig"]:
        return None  # edited or regenerated since: the next turn's schedule writes a fresh one
    last = picked[-1]
    after = next((m for m in history if m["timestamp"] > last["timestamp"]), None)
    t_last = last["timestamp"] / 1000
    created = (t_last + after["timestamp"] / 1000) / 2 if after else t_last + 0.001
    sid = db.new_id("msg")
    data = {"summaryOf": pending["ids"], "count": pending["count"], "supersedes": pending.get("previous")}
    marked = pending["ids"] + ([pending["previous"]] if pending.get("previous") else [])
    with db.conn() as c:
        c.execute("INSERT INTO messages(id, conv_id, role, content, data, created) VALUES(?,?,?,?,?,?)",
                  (sid, conv_id, "summary", pending["summary"], json.dumps(data), created))
        c.executemany("UPDATE messages SET data=json_set(COALESCE(data, '{}'), '$.summarizedBy', ?) WHERE id=? AND conv_id=?",
                      [(sid, mid, conv_id) for mid in marked])
    return {"id": sid, "role": "summary", "content": pending["summary"], "timestamp": created * 1000, **data}


async def compact_now(conv_id: str, num_ctx: int, settings: dict) -> dict:
    """The Compact button: summarize everything but the newest messages, right away."""
    pending = await prepare(conv_id, num_ctx, 0, settings, force=True)
    if not pending:
        return {"ok": True, "compacted": False, "message": "This conversation is short; there's nothing to summarize yet."}
    msg = commit_pending(conv_id)
    if not msg:
        return {"ok": True, "compacted": False, "message": "The conversation changed while summarizing; try again."}
    return {"ok": True, "compacted": True, "summary": msg["content"], "compactedCount": len(pending["ids"]),
            "checkpointId": msg["id"]}


def schedule(conv_id: str, model: str, num_ctx: int, fixed_chars: int, settings: dict):
    """After a reply: start writing a summary in the background if the next prompt would be too full. CLI agents keep
    their own context (a resumed session), so they're skipped."""
    if conv_id in _inflight or providers.is_cli(model or "") or db.kv_get(_kv_key(conv_id)):
        return
    if history_chars(db.list_messages(conv_id)) + fixed_chars < num_ctx * CHARS_PER_TOKEN * TRIGGER:
        return

    async def job():
        _inflight.add(conv_id)
        try:
            await prepare(conv_id, num_ctx, fixed_chars, settings)
        except Exception as e:  # noqa: BLE001
            print(f"compaction {conv_id}: {type(e).__name__}: {e}")
        finally:
            _inflight.discard(conv_id)
    t = asyncio.get_running_loop().create_task(job())
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)


def forget(conv_id: str):
    _clear(conv_id)


# ── one-time migration of the old, deleting compaction ──────────────────────

def migrate_legacy():
    """Put back the messages older versions deleted (their JSON copies sit in `compacted` rows) and turn those rows
    into summaries. Runs at startup; does nothing once no `compacted` rows are left."""
    with db.conn() as c:
        rows = c.execute("SELECT * FROM messages WHERE role='compacted'").fetchall()
        for r in rows:
            data = json.loads(r["data"] or "{}")
            archived = data.get("compactedMessages") or []
            ids = []
            for m in archived:
                mid = m.get("id") or db.new_id("msg")
                ids.append(mid)
                extra = {k: v for k, v in m.items() if k not in ("id", "role", "content", "timestamp")}
                extra["summarizedBy"] = r["id"]
                ts = (m.get("timestamp") or 0) / 1000 or r["created"] - 1
                c.execute("INSERT OR IGNORE INTO messages(id, conv_id, role, content, data, created) VALUES(?,?,?,?,?,?)",
                          (mid, r["conv_id"], m.get("role") or "user", m.get("content") or "", json.dumps(extra), ts))
            c.execute("UPDATE messages SET role='summary', data=? WHERE id=?",
                      (json.dumps({"summaryOf": ids, "count": len(ids), "legacy": True}), r["id"]))
    return len(rows)
