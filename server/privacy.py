"""Privacy controls (backlog C11): incognito chats and local-only memories.

Incognito chat (`conversations.incognito`, set when the chat is created; db.py adds the column):
  - no long-term memory in the prompt (app.py skips recall; agent.py drops the memory tools, which also drops the
    "your most recent other conversations" list from prompts.py),
  - no learning (memory.after_turn returns early, "Learn from past chats" skips it, feedback.py never distills a rule),
  - never summarized by the episodes sweep and never found by past-conversation search, the sidebar's
    "In messages" search or recall_conversations (episodes.py / episodes_search.py filter on the flag),
  - deleted `incognitoHours` (default 24) after its last message, by `sweep`, which the episodes loop calls.
  Incognito chats can't be moved into a chat Project: the project would list it to other chats.

Local-only memory (`memories.local_only`, memory.py adds the column): never put in a prompt for a cloud agent, even
when `cloudMemory` lets cloud agents see memories, and never returned by memory_search to one. A memory that
replaces or merges a local-only one stays local-only.
"""
import shutil
import time

import db

MEMORY_TOOLS = ("memory_save", "memory_forget", "memory_search", "recall_conversations", "follow_ups", "leave_message", "check_messages")
DEFAULT_HOURS = 24
HIDDEN_SQL = "SELECT id FROM conversations WHERE incognito=1"  # for `conv_id NOT IN (…)` filters

PROMPT_NOTE = """## Incognito chat
The user opened this chat in incognito mode. You have no long-term memory here: nothing they say is remembered,
learned or searchable later, and the chat is deleted automatically. Don't offer to remember things; if they ask you
to, say this chat is incognito and they can tell you again in a normal chat."""


def is_incognito(conv_id: str | None) -> bool:
    if not conv_id:
        return False
    with db.conn() as c:
        r = c.execute("SELECT incognito FROM conversations WHERE id=?", (conv_id,)).fetchone()
    return bool(r and r["incognito"])


def mark_incognito(conv_id: str) -> dict | None:
    with db.conn() as c:
        c.execute("UPDATE conversations SET incognito=1, group_id=NULL WHERE id=?", (conv_id,))
    return db.get_conversation(conv_id)


def hours(settings: dict | None = None) -> float:
    if settings is None:
        settings = db.kv_get("settings", {}) or {}
    try:
        return max(0.25, float(settings.get("incognitoHours") or DEFAULT_HOURS))
    except (TypeError, ValueError):
        return DEFAULT_HOURS


def expired(now: float | None = None, settings: dict | None = None) -> list[str]:
    cutoff = (now or time.time()) - hours(settings) * 3600
    with db.conn() as c:
        # guests' chats (guests.py) are incognito to the owner's side but kept until the guest deletes them
        return [r["id"] for r in c.execute("SELECT id FROM conversations WHERE incognito=1 AND tenant IS NULL AND updated < ?",
                                           (cutoff,))]


def forget_conversation(conv_id: str):
    """Delete an incognito chat and everything derived from it, the way DELETE /api/conversations does plus its
    uploads, summary and ratings."""
    import research
    db.delete_conversation(conv_id)
    research.unlink(conv_id)
    with db.conn() as c:
        for table in ("mega_links", "conv_summary", "feedback"):
            if c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                c.execute(f"DELETE FROM {table} WHERE conv_id=?", (conv_id,))
    import adult
    adult.forget(conv_id)
    ws = db.DATA / "workspaces" / conv_id
    if conv_id and ws.is_dir() and ws.resolve().parent == (db.DATA / "workspaces").resolve():
        shutil.rmtree(ws, ignore_errors=True)


def sweep(active=()) -> int:
    """Delete incognito chats whose last message is older than `incognitoHours`. Skips chats in `active`."""
    n = 0
    for cid in expired():
        if cid in active:
            continue
        try:
            forget_conversation(cid)
            n += 1
        except Exception as e:  # noqa: BLE001
            print(f"incognito sweep {cid}: {type(e).__name__}: {e}")
    return n


def private_memory_ids() -> set[str]:
    with db.conn() as c:
        return {r["id"] for r in c.execute("SELECT id FROM memories WHERE local_only=1")}
