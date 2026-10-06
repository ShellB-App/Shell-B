"""Feedback on replies: thumbs up/down, reasons, a note, and what Shell:B learns from them.

Each rating is stored in table `feedback` (one row per message; changing your mind replaces it) and mirrored into the
message's data as `feedback`, so the chat shows it after a reload. When the owner ticks "remember this" and says what
was wrong (or right), the utility model distills it into at most one lasting rule about how the owner wants answers,
saved as a `preference` memory (origin `feedback`). Preferences are core memories, so the rule is in every prompt
from the next message on. Feedback about this one answer only ("the date is wrong") yields no rule; the chat offers
"Try again with this feedback" instead.

The table also keeps per-agent counts, which the nightly reflection (backlog C4) can mine for patterns.
"""
import json
import re
import time

import httpx
from fastapi import APIRouter, HTTPException, Request

import db
import memory

router = APIRouter(prefix="/api/feedback")

REASONS = {
    "too-long": "too long", "too-short": "too short or shallow", "wrong": "factually wrong", "ignored": "didn't follow my instructions",
    "format": "badly formatted (too many lists or headings)", "tone": "wrong tone", "didnt-do": "talked instead of doing the task",
    "great": "exactly right",
}

# reasons that say what to do instead; "wrong tone" or "ignored my instructions" alone don't, so they need a note
DIRECTIONAL = {"too-long", "too-short", "format", "didnt-do"}


def init():
    with db.conn() as c:
        c.executescript("""
CREATE TABLE IF NOT EXISTS feedback(
  msg_id TEXT PRIMARY KEY, conv_id TEXT, agent_id TEXT, model TEXT, rating TEXT, reasons TEXT, note TEXT,
  rule_id TEXT, created REAL);
CREATE INDEX IF NOT EXISTS feedback_agent ON feedback(agent_id, created);
""")


def _set_message_data(msg_id, key, value):
    with db.conn() as c:
        r = c.execute("SELECT data FROM messages WHERE id=?", (msg_id,)).fetchone()
        if not r:
            return
        data = json.loads(r["data"] or "{}")
        if value is None:
            data.pop(key, None)
        else:
            data[key] = value
        c.execute("UPDATE messages SET data=? WHERE id=?", (json.dumps(data), msg_id))


def _exchange(conv_id, msg_id):
    """The user message a reply answered, and the reply."""
    msgs = db.list_messages(conv_id)
    i = next((k for k, m in enumerate(msgs) if m["id"] == msg_id), None)
    if i is None or msgs[i]["role"] != "assistant":
        return None, None
    asked = next((m for m in reversed(msgs[:i]) if m["role"] == "user"), None)
    return asked, msgs[i]


DISTILL_PROMPT = """The user rated an AI assistant's reply and said what they think. Decide whether this reveals a LASTING
preference about how the assistant should answer them in general (length, format, tone, depth, process, things to
always or never do), or whether it is only about this particular answer (a wrong fact, a bug, a one-off request).

If lasting, write ONE short rule in the third person ("{name} prefers …", "{name} wants …", "Never …"), general enough
to apply to future conversations and specific enough to act on. Never guess: if the feedback doesn't say what they want
instead (e.g. just "wrong tone" with no hint of which tone), return an empty rule. If your rule refines or contradicts a known preference
below, put that preference's id in "replaces". If a known preference already says the same thing, return an empty rule.

Known preferences:
{known}

The user asked:
<request>
{request}
</request>

The assistant replied:
<reply>
{reply}
</reply>

Rating: {rating}
What the user said about it: {feedback}

Reply with JSON only: {{"rule": "…" or "", "replaces": "mem-…" or "", "why": "one-off" | "lasting"}}"""


async def distill(name, request, reply, rating, feedback, settings) -> dict:
    from agent import OLLAMA, model_info
    import providers
    model = settings.get("utilityModel") or ""
    if not model or providers.is_cloud(model):
        return {}
    known = [m for m in memory.rows() if m["category"] == "preference"][:30]
    prompt = DISTILL_PROMPT.format(
        name=name, known="\n".join(f"[{m['id']}] {m['text']}" for m in known) or "(none)",
        request=memory._clip(request, 2000), reply=memory._clip(reply, 2500), rating=rating, feedback=feedback)
    payload = {"model": model, "stream": False, "format": "json", "keep_alive": "2h",
               "options": {"temperature": 0.1, "num_predict": 300}, "messages": [{"role": "user", "content": prompt}]}
    if "thinking" in (await model_info(model))["capabilities"]:
        payload["think"] = False
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post(f"{OLLAMA}/api/chat", json=payload)
        r.raise_for_status()
    raw = r.json()["message"]["content"] or ""
    m = re.search(r"\{.*\}", raw, re.S)
    try:
        out = json.loads(m.group(0)) if m else {}
    except ValueError:
        out = {}
    rule = memory._clean(out.get("rule"))
    replaces = str(out.get("replaces") or "")
    return {"rule": rule, "replaces": replaces if replaces in {k["id"] for k in known} else ""}


def _owner_name() -> str:
    """What the owner goes by, from identity memories (e.g. "…but I also go by Alex" beats "my name is Alexander")."""
    ids = [m["text"] for m in memory.rows() if m["category"] == "identity"]
    for pat in (r"\bgo(?:es)? by\s+([A-Z][a-z]+)", r"\b(?:called|name is)\s+([A-Z][a-z]+)"):
        for t in ids:
            hit = re.search(pat, t)
            if hit:
                return hit.group(1)
    return "The user"


@router.post("")
async def api_feedback(req: Request):
    b = await req.json()
    msg_id = str(b.get("msgId") or "")
    with db.conn() as c:
        row = c.execute("SELECT conv_id FROM messages WHERE id=?", (msg_id,)).fetchone()
    conv_id = row["conv_id"] if row else ""
    rating = b.get("rating")
    if rating not in ("up", "down", None):
        raise HTTPException(400, "rating must be up, down or null")
    asked, reply = _exchange(conv_id, msg_id)
    if reply is None:
        raise HTTPException(404, "No such reply")
    if rating is None:  # cleared
        with db.conn() as c:
            c.execute("DELETE FROM feedback WHERE msg_id=?", (msg_id,))
        _set_message_data(msg_id, "feedback", None)
        return {"feedback": None}
    reasons = [r for r in b.get("reasons") or [] if r in REASONS][:6]
    note = " ".join(str(b.get("note") or "").split())[:1000]
    fb = {"rating": rating, "reasons": reasons, "note": note, "at": time.time() * 1000}
    with db.conn() as c:
        old = c.execute("SELECT rule_id FROM feedback WHERE msg_id=?", (msg_id,)).fetchone()
        c.execute("INSERT OR REPLACE INTO feedback VALUES(?,?,?,?,?,?,?,?,?)",
                  (msg_id, conv_id, reply.get("agentId"), reply.get("model"), rating, json.dumps(reasons), note,
                   old["rule_id"] if old else None, time.time()))

    learned, why = None, ""
    said = "; ".join([REASONS[r] for r in reasons] + ([note] if note else []))
    import privacy
    if b.get("remember") and privacy.is_incognito(conv_id):  # incognito chats teach Shell:B nothing
        why = "Thanks. This chat is incognito, so nothing was added to memory."
    elif b.get("remember") and (note or DIRECTIONAL & set(reasons)):
        settings = memory._settings()
        try:
            async with memory._lock:
                out = await distill(_owner_name(), (asked or {}).get("content", ""), reply.get("content", ""),
                                    "thumbs up" if rating == "up" else "thumbs down", said, settings)
                if out.get("rule"):
                    mid, dup = await memory.add(out["rule"], category="preference", origin="feedback", source=conv_id,
                                                replaces=out["replaces"] or None, settings=settings)
                    learned = {"id": mid, "text": dup["text"] if dup else out["rule"], "existing": bool(dup)}
                    with db.conn() as c:
                        c.execute("UPDATE feedback SET rule_id=? WHERE msg_id=?", (mid, msg_id))
                else:
                    why = "one-off"
        except Exception as e:  # noqa: BLE001  the rating is saved either way
            why = f"Couldn't distill a rule: {type(e).__name__}"
    elif b.get("remember") and said:
        why = "vague"
    if learned:
        fb["learned"] = learned
    _set_message_data(msg_id, "feedback", fb)
    return {"feedback": fb, "why": why}


@router.get("/stats")
def api_stats(days: int = 30):
    """Thumbs per agent over the last `days`."""
    since = time.time() - max(1, days) * 86400
    with db.conn() as c:
        rows = c.execute("SELECT agent_id, rating, count(*) AS n FROM feedback WHERE created>? GROUP BY agent_id, rating",
                         (since,)).fetchall()
    out: dict[str, dict] = {}
    for r in rows:
        out.setdefault(r["agent_id"] or "", {"up": 0, "down": 0})[r["rating"]] = r["n"]
    return out
