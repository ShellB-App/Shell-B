"""Follow-ups and the morning brief (backlog C9).

Follow-ups (table `commitments`) are things the owner said she'd do or asked to be reminded of ("I'll send the deck
Friday", "remind me to call the vet"), things an agent promised to follow up on, and action items from Secretary
meetings. Each has a due date if one was given (YYYY-MM-DD, optionally THH:MM), who owes it (`me`, `agent`, or a
name from a meeting), where it came from (chat message, meeting, or added by hand) and a status: open / done /
dismissed.

  chat      after every interactive turn (`after_turn`, called next to memory.after_turn), a cheap keyword prefilter
            decides whether the utility model should look at the exchange at all; if so it lists new follow-ups and
            ones the owner says are now done. Local model only (skipped when the utility model is a cloud model),
            one call at a time (shares memory._lock), skipped for incognito chats and when `followUps` is off. What it
            noted is shown under the reply ("Noted a follow-up: …", with Undo) via message data `followUps`.
  meetings  secretary.py stores `actionItems` in meetings.summary_data; `sync_meetings` copies new ones in (deduped by
            ref), checked by the brief loop and whenever the list is read.

Morning brief: once a day at `morningBriefTime` (default 07:30 local; `morningBrief` turns it off), only if the owner
used Shell:B in the last BRIEF_ACTIVE_DAYS days, Shell:B posts one Activity item (source `brief`): follow-ups that are
overdue or due today, today's and tomorrow's Codex events, what unattended work finished since the last brief
(from Activity itself), approvals and memories waiting, and the weather for `briefWeatherPlace` if set (Open-Meteo,
as the weather tool already does; only the place name leaves the Spark). The utility model writes the prose; if
it's busy, down or a cloud model, a deterministic text is used instead. The structured brief is kept in kv `brief`.

API: GET/POST /api/commitments, PATCH /api/commitments/{id}, POST /api/commitments/{id}/undo?msg=,
GET /api/commitments/noted/{msg}, GET /api/brief, POST /api/brief/run.
"""
import asyncio
import difflib
import hashlib
import json
import re
import time
from datetime import date, datetime, timedelta

import httpx
from fastapi import APIRouter, HTTPException, Request

import db
import memory
import providers

router = APIRouter()

STATUSES = ("open", "done", "dismissed")
MAX_TEXT = 240
BRIEF_ACTIVE_DAYS = 3        # no brief for an owner who hasn't been around
BRIEF_LATE_HOURS = 6         # a brief missed by more than this (server down all morning) is skipped for the day
WORK_SOURCES = ("schedule", "todo", "plan", "scout", "notebook", "deploy", "data", "codex")
busy = lambda: False  # noqa: E731  set by app.py: a turn is running
_noted: dict[str, dict] = {}   # assistant message id -> {"state": "running"|"done", "items": [...]}
_tasks: set = set()
_task = None
_briefing = False


# ── storage ─────────────────────────────────────────────────────────────────

def init():
    with db.conn() as c:
        c.executescript("""
CREATE TABLE IF NOT EXISTS commitments(
  id TEXT PRIMARY KEY, text TEXT, due TEXT, who TEXT DEFAULT 'me', status TEXT DEFAULT 'open',
  origin TEXT DEFAULT 'chat', conv_id TEXT, msg_id TEXT, meeting_id TEXT, ref TEXT UNIQUE, note TEXT DEFAULT '',
  created REAL, updated REAL, closed REAL);
CREATE INDEX IF NOT EXISTS commitments_status ON commitments(status, due);
""")


def _row(r) -> dict:
    return {"id": r["id"], "text": r["text"], "due": r["due"], "who": r["who"] or "me", "status": r["status"],
            "origin": r["origin"], "convId": r["conv_id"], "msgId": r["msg_id"], "meetingId": r["meeting_id"],
            "note": r["note"] or "", "createdAt": r["created"] * 1000, "updatedAt": (r["updated"] or r["created"]) * 1000,
            "closedAt": r["closed"] * 1000 if r["closed"] else None}


def get(cid: str) -> dict | None:
    with db.conn() as c:
        r = c.execute("SELECT * FROM commitments WHERE id=?", (cid,)).fetchone()
    return _row(r) if r else None


def rows(statuses=("open",), limit=500) -> list[dict]:
    with db.conn() as c:
        rs = c.execute(f"SELECT * FROM commitments WHERE status IN ({','.join('?' * len(statuses))}) "
                       "ORDER BY due IS NULL, due, created DESC LIMIT ?", (*statuses, limit)).fetchall()
    return [_row(r) for r in rs]


def _clean(text) -> str:
    return " ".join(str(text or "").split())[:MAX_TEXT]


def _due(value) -> str | None:
    """YYYY-MM-DD or YYYY-MM-DDTHH:MM, or None for anything else ("Friday", "TBD")."""
    s = str(value or "").strip().replace(" ", "T")
    m = re.match(r"^(\d{4}-\d{2}-\d{2})(?:T(\d{1,2}:\d{2}))?", s)
    if not m:
        return None
    try:
        date.fromisoformat(m.group(1))
        if m.group(2):
            hh, mm = m.group(2).split(":")
            if not (0 <= int(hh) < 24 and 0 <= int(mm) < 60):
                return m.group(1)
            return f"{m.group(1)}T{int(hh):02d}:{mm}"
    except ValueError:
        return None
    return m.group(1)


_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
# whole words only: a prefix match would read "month" as Monday and "wedding" as Wednesday
_WD_RE = r"(monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)"
_MON_RE = (r"(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|"
           r"october|oct|november|nov|december|dec)")


def relative_due(text, anchor: date) -> str | None:
    """A spoken deadline ("Friday", "by next Tuesday 3pm", "end of month", "Oct 9", "in 2 weeks") as YYYY-MM-DD[THH:MM],
    counted from `anchor` (the day it was said: a meeting's date, or today for a chat). None when there's no clear day."""
    s = re.sub(r"[.,]", " ", str(text or "").lower()).strip()
    if not s or s in ("tbd", "n/a", "none", "asap", "ongoing"):
        return None
    t = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", s)
    hhmm = ""
    if t:
        h = int(t.group(1)) % 12 + (12 if t.group(3) == "pm" else 0)
        if 0 <= h < 24 and int(t.group(2) or 0) < 60:
            hhmm = f"T{h:02d}:{int(t.group(2) or 0):02d}"
        s = s[:t.start()] + s[t.end():]
    d = None
    if re.search(r"\b(today|tonight|eod|end of (the )?day)\b", s):
        d = anchor
    elif re.search(r"\btomorrow\b", s):
        d = anchor + timedelta(days=1)
    elif re.search(r"\b(eow|end of (the )?week)\b", s):
        d = anchor + timedelta(days=(4 - anchor.weekday()) % 7)
    elif re.search(r"\b(eom|end of (the )?month)\b", s):
        nxt = (anchor.replace(day=28) + timedelta(days=4)).replace(day=1)
        d = nxt - timedelta(days=1)
    elif m := re.search(r"\bin (\d{1,3}|a|one|two|three) (day|week)s?\b", s):
        n = {"a": 1, "one": 1, "two": 2, "three": 3}.get(m.group(1)) or int(m.group(1))
        d = anchor + timedelta(days=n * (7 if m.group(2) == "week" else 1))
    elif m := re.search(r"\b(next |this )?" + _WD_RE + r"\b", s):
        wd = [w[:3] for w in _WEEKDAYS].index(m.group(2)[:3])
        ahead = (wd - anchor.weekday()) % 7 or 7  # "Friday" said on a Friday means next week's
        if m.group(1) == "next " and anchor.weekday() < wd:
            ahead += 7  # "next Friday" said on a Tuesday: the week after
        elif m.group(1) == "this " and wd >= anchor.weekday():
            ahead = wd - anchor.weekday()
        d = anchor + timedelta(days=ahead)
    elif m := (re.search(r"\b" + _MON_RE + r"\s+(\d{1,2})(?:st|nd|rd|th)?\b", s)
               or re.search(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?" + _MON_RE + r"\b", s)):
        a, b = m.groups()
        mon, day = (_MONTHS.index(a[:3]) + 1, int(b)) if not a.isdigit() else (_MONTHS.index(b[:3]) + 1, int(a))
        d = _next_date(anchor, mon, day)
    elif m := re.search(r"\b(\d{1,2})/(\d{1,2})\b", s):  # US month/day
        d = _next_date(anchor, int(m.group(1)), int(m.group(2)))
    return f"{d.isoformat()}{hhmm}" if d else None


def _next_date(anchor: date, month: int, day: int) -> date | None:
    """That month/day on or after `anchor` (a deadline isn't in the past), else None if it isn't a real date."""
    try:
        d = date(anchor.year, month, day)
        return d if d >= anchor - timedelta(days=7) else date(anchor.year + 1, month, day)
    except ValueError:
        return None


def _similar(a: str, b: str) -> bool:
    a, b = a.lower(), b.lower()
    return a == b or difflib.SequenceMatcher(None, a, b).ratio() >= 0.82


def add(text, *, due=None, who="me", origin="chat", conv_id=None, msg_id=None, meeting_id=None, ref=None,
        note="") -> tuple[str | None, dict | None]:
    """Store one follow-up. Returns (id, duplicate): an open follow-up that already says this comes back instead."""
    text = _clean(text)
    if not text:
        raise ValueError("empty follow-up")
    for o in rows():
        if _similar(o["text"], text):
            return None, o
    cid = db.new_id("fu")
    now = time.time()
    with db.conn() as c:
        cur = c.execute("INSERT OR IGNORE INTO commitments(id, text, due, who, status, origin, conv_id, msg_id, meeting_id, "
                        "ref, note, created, updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (cid, text, _due(due), (who or "me")[:60], "open", origin, conv_id, msg_id, meeting_id, ref,
                         note[:300], now, now))
    return (cid, None) if cur.rowcount else (None, None)


def update(cid: str, *, text=None, due="keep", status=None, who=None) -> dict:
    c0 = get(cid)
    if not c0:
        raise KeyError(cid)
    sets, args = ["updated=?"], [time.time()]
    if text is not None and _clean(text):
        sets.append("text=?"); args.append(_clean(text))
    if due != "keep":
        sets.append("due=?"); args.append(_due(due))
    if who is not None:
        sets.append("who=?"); args.append(str(who)[:60] or "me")
    if status is not None:
        if status not in STATUSES:
            raise ValueError(status)
        sets += ["status=?", "closed=?"]; args += [status, None if status == "open" else time.time()]
    with db.conn() as c:
        c.execute(f"UPDATE commitments SET {', '.join(sets)} WHERE id=?", (*args, cid))
    return get(cid)


def delete(cid: str):
    with db.conn() as c:
        c.execute("DELETE FROM commitments WHERE id=?", (cid,))


def _settings():
    return memory._settings()


def _today(settings=None) -> date:
    return memory._now(settings or _settings()).date()


def _mine(c: dict) -> bool:
    """Owed by the owner (or by an agent on her behalf), not by someone else in a meeting."""
    who = (c.get("who") or "me").strip().lower()
    if who in ("me", "agent", "i", "you", ""):
        return True
    try:
        from feedback import _owner_name
        name = _owner_name().lower()
        return name != "the user" and who.split()[0] == name
    except Exception:  # noqa: BLE001
        return False


def counts(settings=None) -> dict:
    today = _today(settings).isoformat()
    open_ = rows()
    return {"open": len(open_), "overdue": sum(1 for c in open_ if c["due"] and c["due"][:10] < today),
            "today": sum(1 for c in open_ if c["due"] and c["due"][:10] == today)}


# ── learning from chats ─────────────────────────────────────────────────────

# Cheap gate before any model call: most turns contain nothing like a promise or a reminder.
_USER_HINT = re.compile(
    r"\b(remind|reminder|don'?t (let me )?forget|i'?ll|i will|i'?m going to|i am going to|gonna|i need to|i have to|"
    r"i've got to|i must|i should|i promised|i owe|need to remember|follow[- ]?up|get back to|todo|to-do|deadline|"
    r"due (on|by)|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|next|end of|eod|eow))\b", re.I)
_DONE_HINT = re.compile(r"\b(i (just )?(sent|finished|did|called|emailed|paid|submitted|booked|fixed|wrote|handed|returned|"
                        r"got back)|(it'?s|that'?s|all) (done|sorted|handled)|already did|crossed off)\b", re.I)
_AGENT_HINT = re.compile(r"\b(i'?ll|i will) (follow up|check (back|in|on)|remind you|get back to you|look into|circle back|ping you)\b", re.I)

LEARN_PROMPT = """You keep {name}'s list of follow-ups: promises and reminders that need doing LATER. Today is {today}.

Read the latest exchange and find:
1. Things {name} says she will do later or asks to be reminded of ("I'll send the deck Friday", "remind me to call the vet", "I need to renew my passport before March"). who = "me".
2. Things the ASSISTANT explicitly promised to follow up on in a later conversation ("I'll check back on the build tomorrow"). who = "agent". Steps it does inside this same reply don't count.
3. Open follow-ups below that {name} now says are finished ("I sent the deck") -> list their ids under "done".

Never include: requests for the assistant to do something right now; hypotheticals, plans the user is only considering, or general advice; text the user pasted or quoted (emails, documents, logs); anything already in the open list.
Each follow-up is one short imperative phrase (e.g. "Send the Q3 deck to Mark", "Call the vet about Luna's shots"). Give "due" as an absolute date YYYY-MM-DD (add THH:MM only if a time was said) when a day was named or implied, otherwise null. Most exchanges have nothing: then return empty lists.

Open follow-ups:
{known}

{exchange}

Reply with JSON only, in exactly this shape:
{{"followUps": [{{"text": "Send the Q3 deck to Mark", "due": "2026-10-09", "who": "me"}}], "done": ["fu-..."]}}"""


def _incognito(conv_id: str) -> bool:
    """Incognito chats (privacy.py) teach Shell:B nothing."""
    try:
        import privacy
        return privacy.is_hidden(conv_id)
    except ImportError:
        pass
    except Exception:  # noqa: BLE001  fall through to reading the row directly
        pass
    try:
        with db.conn() as c:
            r = c.execute("SELECT * FROM conversations WHERE id=?", (conv_id,)).fetchone()
        if not r:
            return False
        keys = r.keys()
        if ("incognito" in keys and r["incognito"]) or ("adult" in keys and r["adult"]):
            return True
        if "data" in keys and r["data"]:
            return bool(json.loads(r["data"] or "{}").get("incognito"))
    except Exception:  # noqa: BLE001
        pass
    return False


def touch_owner():
    db.kv_set("owner_seen", time.time())


def after_turn(conv_id: str, msg_id: str, user_text: str, reply: str, agent: dict):
    """Called when an interactive turn completes (beside memory.after_turn). Never blocks the reply."""
    try:
        touch_owner()
        settings = _settings()
        by_tool = _by_tool.pop(msg_id, [])
        if by_tool:  # the agent used follow_ups this turn: show those under the reply (the message exists only now)
            _save_noted(msg_id, by_tool)
            _noted[msg_id] = {"state": "done", "items": by_tool}
        text = (user_text or "").split("\n\n[Selected element in ")[0].strip()
        if not settings.get("followUps", True) or not agent or len(text) < 8 or _incognito(conv_id):
            return
        has_open = bool(rows(limit=1))
        if not (_USER_HINT.search(text) or _AGENT_HINT.search(reply or "") or (has_open and _DONE_HINT.search(text))):
            return
        _noted[msg_id] = {"state": "running", "items": by_tool}
        t = asyncio.create_task(_learn_turn(conv_id, msg_id, text, reply, settings, by_tool))
        _tasks.add(t)
        t.add_done_callback(_tasks.discard)
    except Exception as e:  # noqa: BLE001
        print(f"commitments.after_turn failed: {type(e).__name__}: {e}")


async def _ask_json(prompt: str, settings: dict, n=500) -> tuple[dict, str]:
    """(parsed, raw). Local utility model only; {} when it's a cloud model or the call fails to parse."""
    from agent import OLLAMA, model_info
    model = settings.get("utilityModel") or ""
    if not model or providers.is_cloud(model):  # chat text never goes to a cloud model for this
        return {}, ""
    payload = {"model": model, "messages": [{"role": "user", "content": prompt}], "stream": False, "format": "json",
               "keep_alive": "2h", "options": {"temperature": 0.1, "num_predict": n}}
    if "thinking" in (await model_info(model))["capabilities"]:
        payload["think"] = False
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post(f"{OLLAMA}/api/chat", json=payload)
        r.raise_for_status()
    raw = r.json()["message"]["content"] or ""
    raw2 = re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.M).strip()
    try:
        data = json.loads(raw2)
    except ValueError:
        m = re.search(r"\{.*\}", raw2, re.S)
        try:
            data = json.loads(m.group(0)) if m else {}
        except ValueError:
            data = {}
    if isinstance(data, list):
        data = {"followUps": data}
    return (data if isinstance(data, dict) else {}), raw


async def propose(exchange: str, settings: dict) -> tuple[list[dict], list[str], str]:
    """Run the extractor. Returns (new follow-ups, ids now done, raw model output)."""
    from feedback import _owner_name
    known = rows()[:25]
    listing = "\n".join(f"[{c['id']}] {c['text']}" + (f" (due {c['due']})" if c["due"] else "") for c in known) or "(none)"
    name = _owner_name()
    name = "the user" if name == "The user" else name
    prompt = LEARN_PROMPT.format(name=name, today=f"{memory._now(settings):%A, %B %d, %Y}", known=listing,
                                 exchange=exchange)
    data, raw = await _ask_json(prompt, settings)
    items = data.get("followUps") or data.get("followups") or data.get("commitments") or []
    out = []
    for i in items if isinstance(items, list) else []:
        if not isinstance(i, dict):
            continue
        text = _clean(i.get("text") or i.get("task"))
        who = str(i.get("who") or "me").lower()
        if text:
            due = _due(i.get("due")) or relative_due(i.get("due"), date.today())  # the model sometimes says "Friday"
            out.append({"text": text, "due": due, "who": "agent" if who in ("agent", "assistant") else "me"})
    ids = {c["id"] for c in known}
    done = [str(d) for d in (data.get("done") or []) if str(d) in ids] if isinstance(data.get("done"), list) else []
    return out[:4], done[:4], raw


async def _learn_turn(conv_id, msg_id, text, reply, settings, prior=()):
    items = list(prior)  # what the agent noted itself with follow_ups; add() skips the learner's repeats of it
    try:
        async with memory._lock:  # one utility-model call at a time on the shared GPU
            exchange = (f"Latest exchange:\n<user>\n{memory._clip(text, 3000)}\n</user>\n<assistant>\n"
                        f"{memory._clip(reply, 1500)}\n</assistant>")
            found, done, _ = await propose(exchange, settings)
        for f in found:
            cid, dup = add(f["text"], due=f["due"], who=f["who"], origin="chat", conv_id=conv_id, msg_id=msg_id)
            if cid:
                items.append({"op": "add", "id": cid, "text": f["text"], "due": _due(f["due"]), "who": f["who"]})
        for cid in done:
            c0 = get(cid)
            # never close what this same turn created: "add a follow-up… tell me what you added" read as "done"
            if c0 and c0["status"] == "open" and c0.get("msgId") != msg_id:
                update(cid, status="done")
                items.append({"op": "done", "id": cid, "text": c0["text"], "due": c0["due"], "who": c0["who"]})
        if items:
            _save_noted(msg_id, items)
    except Exception as e:  # noqa: BLE001
        print(f"follow-up learner failed: {type(e).__name__}: {e}")
    finally:
        _noted[msg_id] = {"state": "done", "items": items}
        if len(_noted) > 500:
            for k in list(_noted)[:250]:
                _noted.pop(k, None)


def _save_noted(msg_id, items):
    with db.conn() as c:
        r = c.execute("SELECT data FROM messages WHERE id=?", (msg_id,)).fetchone()
        if not r:
            return
        data = json.loads(r["data"] or "{}")
        data["followUps"] = items
        c.execute("UPDATE messages SET data=? WHERE id=?", (json.dumps(data), msg_id))


def _drop_noted(msg_id, cid):
    with db.conn() as c:
        r = c.execute("SELECT data FROM messages WHERE id=?", (msg_id,)).fetchone()
        if r:
            data = json.loads(r["data"] or "{}")
            data["followUps"] = [i for i in data.get("followUps", []) if i.get("id") != cid]
            c.execute("UPDATE messages SET data=? WHERE id=?", (json.dumps(data), msg_id))
    if msg_id in _noted:
        _noted[msg_id]["items"] = [i for i in _noted[msg_id]["items"] if i.get("id") != cid]


# ── agent tool ──────────────────────────────────────────────────────────────

_by_tool: dict[str, list[dict]] = {}  # assistant message id -> follow-ups the agent added/closed during that turn


def tool_allowed(agent: dict, settings: dict) -> bool:
    """Every chat agent gets follow_ups while follow-ups are on; cloud agents only with cloud memory (they're personal)."""
    if not settings.get("followUps", True):
        return False
    return not providers.is_cloud(agent.get("model", "")) or bool(settings.get("cloudMemory", False))


def _noted_by_tool(ctx, item: dict):
    lst = _by_tool.setdefault(ctx.message_id, [])
    lst.append(item)
    if len(_by_tool) > 200:
        for k in list(_by_tool)[:100]:
            _by_tool.pop(k, None)


def _line(c: dict, today: date, status=False) -> str:
    out = f"[{c['id']}] {c['text']}"
    if c["due"]:
        out += f" — due {c['due']} ({_fmt_due(c['due'], today)})"
    if (c["who"] or "me") != "me":
        out += f" · owed by {c['who']}"
    if status:
        out += f" · {c['status']}"
    return out


def _tool_due(raw, today: date) -> tuple[str | None, str | None]:
    """(due, error): ISO dates pass through, spoken ones ("Friday", "end of month") are counted from today."""
    if raw in (None, ""):
        return None, None
    due = _due(raw) or relative_due(raw, today)
    return (due, None) if due else (None, f"Couldn't read the due date {str(raw)!r}: give YYYY-MM-DD (optionally THH:MM).")


async def follow_ups_tool(args, ctx):
    from tools import ToolResult
    a = str(args.get("action") or "list")
    today = _today(ctx.settings)
    if a == "list":
        status = str(args.get("status") or "open")
        statuses = STATUSES if status == "all" else (status,) if status in STATUSES else ("open",)
        items = rows(statuses, limit=max(1, min(100, int(args.get("limit") or 40))))
        if not items:
            return ToolResult("No open follow-ups." if statuses == ("open",) else "No follow-ups.")
        return ToolResult(f"Today is {today.isoformat()} ({today.strftime('%A')}).\n"
                          + "\n".join(_line(c, today, status == "all") for c in items))
    if a == "add":
        due, err = _tool_due(args.get("due"), today)
        if err:
            return ToolResult(err, error=True)
        who = "agent" if str(args.get("who") or "").lower() in ("agent", "assistant", "you") else "me"
        try:
            cid, dup = add(args.get("text"), due=due, who=who, origin="chat", conv_id=ctx.conv_id, msg_id=ctx.message_id)
        except ValueError:
            return ToolResult("add needs text: one short imperative phrase, e.g. \"Send the Q3 deck to Mark\".", error=True)
        if dup:
            return ToolResult(f"Already tracked, so nothing was added: {_line(dup, today)}")
        c = get(cid)
        _noted_by_tool(ctx, {"op": "add", "id": cid, "text": c["text"], "due": c["due"], "who": c["who"]})
        return ToolResult(f"Added: {_line(c, today)}. The owner sees it under your reply (with Undo) and in Activity → Follow-ups.")
    cid = str(args.get("id") or "").strip()
    c0 = get(cid) if cid else None
    if a in ("done", "dismiss", "update", "reopen") and not c0:
        return ToolResult(f"No follow-up {cid!r}. Use action=list to see the ids.", error=True)
    if a in ("done", "dismiss", "reopen"):
        c = update(cid, status={"done": "done", "dismiss": "dismissed", "reopen": "open"}[a])
        if a == "done":
            _noted_by_tool(ctx, {"op": "done", "id": cid, "text": c["text"], "due": c["due"], "who": c["who"]})
        return ToolResult(f"{ {'done': 'Marked done', 'dismiss': 'Dismissed', 'reopen': 'Reopened'}[a] }: {_line(c, today)}")
    if a == "update":
        kw = {}
        if args.get("text"):
            kw["text"] = args["text"]
        if "due" in args:
            due, err = _tool_due(args.get("due"), today)
            if err:
                return ToolResult(err, error=True)
            kw["due"] = due
        if args.get("who"):
            kw["who"] = "agent" if str(args["who"]).lower() in ("agent", "assistant", "you") else "me"
        if not kw:
            return ToolResult("update needs text, due (null clears it) or who.", error=True)
        return ToolResult(f"Updated: {_line(update(cid, **kw), today)}")
    return ToolResult(f"Unknown action {a!r}.", error=True)


def register():
    from tools import TOOLS, _fn
    TOOLS["follow_ups"] = {
        "fn": follow_ups_tool, "service": None, "scope": "global", "auto": "when Follow-ups is on (cloud agents also need Cloud → Memory)",
        "ui": {"displayName": "Follow-ups", "icon": "ListTodo", "category": "memory",
               "description": "The owner's follow-ups: things she said she'd do or asked to be reminded of, and things an agent "
                              "promised. They show in Activity and in the morning brief."},
        "schema": _fn("follow_ups",
                      "The owner's follow-ups (personal to-dos and reminders, shown in Activity and the morning brief). Use it when "
                      "she asks to be reminded of something, says she'll do something by a date, asks what's on her plate, or "
                      "says she finished something. list (status open|done|dismissed|all) → items with ids and due dates; add "
                      "(text, due, who) → one short imperative phrase (\"Call the vet about Luna's shots\"), due as YYYY-MM-DD"
                      "[THH:MM] or words like \"Friday\" / \"end of month\", who=me (the owner, default) or agent (you "
                      "promised it); done / dismiss / reopen (id); update (id, text, due, who). Chats are also scanned for "
                      "follow-ups automatically after each reply, so don't add one just because she mentioned a plan.",
                      {"action": {"type": "string", "enum": ["list", "add", "done", "dismiss", "reopen", "update"]},
                       "id": {"type": "string", "description": "Follow-up id (fu-…)"},
                       "text": {"type": "string"},
                       "due": {"type": ["string", "null"], "description": "YYYY-MM-DD[THH:MM] or a spoken day; null clears it"},
                       "who": {"type": "string", "enum": ["me", "agent"]},
                       "status": {"type": "string", "enum": ["open", "done", "dismissed", "all"]},
                       "limit": {"type": "integer"}}, ["action"]),
    }


# ── meetings (secretary.py action items) ────────────────────────────────────

def sync_meetings() -> int:
    """Copy action items from summarized meetings into follow-ups. Each item once (ref = meeting + task)."""
    added = 0
    try:
        seen = db.kv_get("commitments_meetings", None)
        first = seen is None
        seen = seen or {}
        with db.conn() as c:
            if not c.execute("SELECT name FROM sqlite_master WHERE name='meetings'").fetchone():
                return 0
            ms = c.execute("SELECT id, title, created, updated, summary_data FROM meetings "
                           "WHERE summary_data LIKE '%actionItems%'").fetchall()
        cutoff = time.time() - 14 * 86400  # on the first sync, only recent meetings: old action items aren't news
        for m in ms:
            stamp = m["updated"] or m["created"] or 0
            if seen.get(m["id"]) == stamp or (first and stamp < cutoff):
                seen[m["id"]] = stamp
                continue
            seen[m["id"]] = stamp
            try:
                items = json.loads(m["summary_data"] or "{}").get("actionItems") or []
            except ValueError:
                continue
            for it in items[:30]:
                if not isinstance(it, dict):
                    continue
                task = _clean(it.get("task") or it.get("text"))
                if not task:
                    continue
                owner = _clean(it.get("owner"))[:60]
                who = "me" if owner.lower() in ("me", "i", "myself") else (owner or "unassigned")
                when = str(it.get("deadline") or "").strip()
                note = f"From meeting “{m['title'] or 'Meeting'}”" + (f" · timeline: {when}" if when and not _due(when)
                                                                      and when.upper() != "TBD" else "")
                ref = f"meeting:{m['id']}:{hashlib.sha1(task.lower().encode()).hexdigest()[:10]}"
                said = date.fromtimestamp(m["created"] or stamp or time.time())  # "Friday" counts from the meeting day
                cid, _ = add(task, due=_due(when) or relative_due(when, said), who=who, origin="meeting",
                             meeting_id=m["id"], ref=ref, note=note)
                added += bool(cid)
        db.kv_set("commitments_meetings", seen)
        if added:
            import activity
            activity.post("brief", "review", f"{added} action item{'s' if added > 1 else ''} from meetings added to follow-ups",
                          "", "#/activity/follow-ups", ref=f"meetings-sync:{int(time.time())}")
    except Exception as e:  # noqa: BLE001
        print(f"commitments.sync_meetings: {type(e).__name__}: {e}")
    return added


# ── morning brief ───────────────────────────────────────────────────────────

def _state() -> dict:
    return db.kv_get("brief", {}) or {}


def _save_state(**kw):
    db.kv_set("brief", {**_state(), **kw})


def _brief_time(settings) -> tuple[int, int]:
    m = re.match(r"^(\d{1,2}):(\d{2})$", str(settings.get("morningBriefTime") or "07:30").strip())
    h, mi = (int(m.group(1)), int(m.group(2))) if m else (7, 30)
    return (h % 24, mi % 60)


def _slot(settings, now=None) -> datetime:
    now = now or memory._now(settings)
    h, m = _brief_time(settings)
    return now.replace(hour=h, minute=m, second=0, microsecond=0)


def owner_active(days=BRIEF_ACTIVE_DAYS) -> bool:
    since = time.time() - days * 86400
    seen = db.kv_get("owner_seen", 0) or 0
    if seen > since:
        return True
    try:
        with db.conn() as c:
            if c.execute("SELECT name FROM sqlite_master WHERE name='auth_sessions'").fetchone():
                r = c.execute("SELECT max(last_seen) FROM auth_sessions").fetchone()
                if r and (r[0] or 0) > since:
                    return True
    except Exception:  # noqa: BLE001
        pass
    return False


def _due_now(settings) -> bool:
    if not settings.get("morningBrief", True):
        return False
    now = memory._now(settings)
    slot = _slot(settings, now)
    if now < slot or now > slot + timedelta(hours=BRIEF_LATE_HOURS):
        return False
    return _state().get("lastDay") != now.date().isoformat()


def _fmt_due(due: str | None, today: date) -> str:
    if not due:
        return ""
    d = date.fromisoformat(due[:10])
    t = f" {due[11:16]}" if len(due) > 10 else ""
    if d == today:
        return f"today{t}"
    if d == today + timedelta(days=1):
        return f"tomorrow{t}"
    if d < today:
        n = (today - d).days
        return f"{n} day{'s' if n > 1 else ''} overdue"
    return d.strftime("%a %b %d") + t


def _events(settings) -> list[str]:
    try:
        import codex
        block = codex.upcoming_schedule_prompt(memory._now(settings), days=1)
    except Exception:  # noqa: BLE001
        return []
    out = []
    for line in block.splitlines():
        m = re.match(r"^- \*\*(Today|Tomorrow)\*\*: (.+)$", line.strip())
        if m:
            out.append(f"{m.group(1)}: {m.group(2)}")
    return out[:6]


def _overnight(since: float) -> list[dict]:
    try:
        with db.conn() as c:
            rs = c.execute(f"SELECT ts, source, status, title FROM activity WHERE ts>? AND source IN "
                           f"({','.join('?' * len(WORK_SOURCES))}) ORDER BY ts", (since, *WORK_SOURCES)).fetchall()
    except Exception:  # noqa: BLE001
        return []
    return [{"source": r["source"], "status": r["status"], "title": r["title"]} for r in rs][-12:]


def _waiting() -> dict:
    out = {"approvals": 0, "memories": 0, "attention": 0}
    try:
        import activity
        out["approvals"] = len(activity.pending())
        s = activity.summary()
        out["attention"] = s.get("attention", 0)
    except Exception:  # noqa: BLE001
        pass
    out["memories"] = memory.pending_count()
    return out


async def _weather(settings) -> dict | None:
    place = str(settings.get("briefWeatherPlace") or "").strip()
    if not place:
        return None
    try:
        import weather
        d = await asyncio.wait_for(weather.weather_for(place, None, None), timeout=15)
        p, dl = d["place"], d["forecast"].get("daily", {})
        us = (p.get("countryCode") or "").upper() in ("US", "LR", "MM")
        conv = (lambda c: round(c * 9 / 5 + 32)) if us else (lambda c: round(c))
        return {"place": p.get("name") or place, "summary": weather.WMO.get(dl["weather_code"][0], "mixed"),
                "low": conv(dl["temperature_2m_min"][0]), "high": conv(dl["temperature_2m_max"][0]),
                "unit": "°F" if us else "°C", "rain": dl.get("precipitation_probability_max", [None])[0]}
    except Exception as e:  # noqa: BLE001  offline, unknown place: the brief goes without
        print(f"brief weather: {type(e).__name__}: {e}")
        return None


async def gather(settings=None) -> dict:
    settings = settings or _settings()
    sync_meetings()
    now = memory._now(settings)
    today = now.date()
    mine = [c for c in rows() if _mine(c)]
    overdue = [c for c in mine if c["due"] and c["due"][:10] < today.isoformat()]
    due_today = [c for c in mine if c["due"] and c["due"][:10] == today.isoformat()]
    soon_end = (today + timedelta(days=2)).isoformat()
    soon = [c for c in mine if c["due"] and today.isoformat() < c["due"][:10] <= soon_end]
    undated = [c for c in mine if not c["due"]]
    since = max(_state().get("lastAt", 0), time.time() - 24 * 3600)
    from feedback import _owner_name
    name = _owner_name()
    return {
        "day": today.isoformat(), "dayLabel": f"{now:%A, %B %d}", "name": "" if name == "The user" else name,
        "overdue": [{"id": c["id"], "text": c["text"], "due": _fmt_due(c["due"], today)} for c in overdue[:6]],
        "today": [{"id": c["id"], "text": c["text"], "due": _fmt_due(c["due"], today)} for c in due_today[:6]],
        "soon": [{"id": c["id"], "text": c["text"], "due": _fmt_due(c["due"], today)} for c in soon[:4]],
        "openCount": len(mine), "undatedCount": len(undated),
        "events": _events(settings), "overnight": _overnight(since), "waiting": _waiting(),
        "weather": await _weather(settings), "feeds": _feeds(since),
    }


def _feeds(since: float) -> list[str]:
    """Headlines that arrived in the feeds since the last brief (feeds.py), newest first."""
    try:
        import feeds
        return [f"{i['feed']}: {i['title']}" for i in feeds.since(since, limit=6)]
    except Exception:  # noqa: BLE001
        return []


def _plural(n, word):
    return f"{n} {word}{'' if n == 1 else 's'}"


def fallback_text(d: dict) -> str:
    """The brief without a model: plain sentences from the same facts."""
    parts = [f"Good morning{', ' + d['name'] if d['name'] else ''}."]
    if d["overdue"]:
        parts.append("Overdue: " + "; ".join(c["text"] for c in d["overdue"][:3]) + ".")
    if d["today"]:
        parts.append("Due today: " + "; ".join(c["text"] + (f" ({c['due'][6:]})" if len(c["due"]) > 5 else "")
                                                 for c in d["today"][:3]) + ".")
    if d.get("soon"):
        parts.append("Coming up: " + "; ".join(f"{c['text']} ({c['due']})" for c in d["soon"][:3]) + ".")
    if d["events"]:
        parts.append("On the calendar: " + "; ".join(d["events"][:3]) + ".")
    ov = d["overnight"]
    if ov:
        bad = [o for o in ov if o["status"] in ("failed", "blocked", "rolled-back", "interrupted", "paused")]
        parts.append(f"While you were away {_plural(len(ov), 'job')} reported in"
                     + (f", {len(bad)} need{'s' if len(bad) == 1 else ''} a look ({bad[0]['title']})" if bad else "") + ".")
    w = d["waiting"]
    asks = [x for x in (w["approvals"] and _plural(w["approvals"], "approval"),
                        w["memories"] and f"{w['memories']} memor{'y' if w['memories'] == 1 else 'ies'} to review") if x]
    if asks:
        parts.append(" and ".join(asks) + " waiting for you.")
    if d["weather"]:
        wx = d["weather"]
        parts.append(f"{wx['place']}: {wx['summary']}, {wx['low']}–{wx['high']}{wx['unit']}"
                     + (f", {wx['rain']}% chance of rain" if wx.get("rain") else "") + ".")
    if d.get("feeds"):
        parts.append("In your feeds: " + "; ".join(d["feeds"][:3]) + ".")
    if len(parts) == 1:
        parts.append("Nothing is due and nothing ran overnight. A clear day.")
    return " ".join(parts)


BRIEF_PROMPT = """Write {who}'s morning brief for {day}. Use ONLY these facts:

{facts}

Rules: one short paragraph, at most 80 words, plain text (no Markdown, no lists, no headings). Start with a brief greeting{named}. Cover ONLY the sections present in the facts, in this order: overdue, today, soon, events, overnight (failures first; routine successes only as a count), waitingForHer, weather, feeds (at most three headlines, named by feed). A section that is missing from the facts must not be mentioned at all (never say the calendar is clear or nothing is waiting). Never invent tasks, times or numbers. Warm but brisk, like a good chief of staff.

Reply with JSON only: {{"brief": "..."}}"""


async def compose(settings=None, use_model=True) -> dict:
    settings = settings or _settings()
    d = await gather(settings)
    facts = {k: d[k] for k in ("overdue", "today", "soon", "openCount", "events", "overnight", "weather", "feeds")}
    facts["waitingForHer"] = {"approvals": d["waiting"]["approvals"], "memoriesToReview": d["waiting"]["memories"]}
    facts["waitingForHer"] = {k: v for k, v in facts["waitingForHer"].items() if v}
    facts = {k: v for k, v in facts.items() if v}  # the model narrates empty sections ("nothing due today") if it sees them
    facts = json.dumps(facts, ensure_ascii=False, indent=1)
    text, by = "", "fallback"
    if use_model and not busy():
        try:
            async with asyncio.timeout(90):
                async with memory._lock:
                    out, _ = await _ask_json(BRIEF_PROMPT.format(who=d["name"] or "the owner", day=d["dayLabel"], facts=facts,
                                                                 named=f" using her name ({d['name']})" if d["name"] else ""),
                                             settings, n=400)
            text = " ".join(str(out.get("brief") or "").split())
            if text:
                by = settings.get("utilityModel") or "model"
        except Exception as e:  # noqa: BLE001  Ollama busy or down: the plain version still goes out
            print(f"brief model failed: {type(e).__name__}: {e}")
    if not text or len(text) > 900:
        text, by = fallback_text(d), "fallback"
    return {**d, "text": text, "by": by, "at": time.time() * 1000}


async def run_brief(settings=None, force=False) -> dict:
    global _briefing
    if _briefing:
        return _state().get("last") or {}
    _briefing = True
    try:
        settings = settings or _settings()
        b = await compose(settings)
        import activity
        attention = bool(b["overdue"] or b["waiting"]["approvals"])
        title = f"Morning brief · {b['dayLabel']}"
        n = len(b["overdue"]) + len(b["today"])
        if n:
            title += f" · {_plural(n, 'follow-up')} due"
        activity.post("brief", "review" if attention else "done", title, b["text"], "#/activity/follow-ups",
                      ref=f"brief:{b['day']}" + (f":{int(time.time())}" if force else ""))
        _save_state(lastDay=b["day"], lastAt=time.time(), last=b)
        return b
    finally:
        _briefing = False


async def _loop():
    await asyncio.sleep(90)
    waited = 0
    while True:
        try:
            sync_meetings()
            settings = _settings()
            if _due_now(settings):
                if not owner_active():
                    _save_state(lastDay=memory._now(settings).date().isoformat(), skipped="owner away")
                elif busy() and waited < 3:  # give a running chat up to ~15 minutes, then brief without the model
                    waited += 1
                else:
                    waited = 0
                    await run_brief(settings)
        except Exception as e:  # noqa: BLE001
            print(f"brief loop: {type(e).__name__}: {e}")
        await asyncio.sleep(300)


def start():
    global _task
    init()
    if _task is None:
        _task = asyncio.create_task(_loop())


def stop():
    global _task
    if _task and not _task.done():
        _task.cancel()
    _task = None


# ── HTTP ────────────────────────────────────────────────────────────────────

def brief_info() -> dict:
    settings = _settings()
    st = _state()
    now = memory._now(settings)
    slot = _slot(settings, now)
    if st.get("lastDay") == now.date().isoformat() or now > slot + timedelta(hours=BRIEF_LATE_HOURS):
        nxt = slot + timedelta(days=1)
    elif now < slot:
        nxt = slot
    else:  # due now: within five minutes (or once a running chat finishes)
        nxt = now
    h, m = _brief_time(settings)
    return {"enabled": settings.get("morningBrief", True), "time": f"{h:02d}:{m:02d}",
            "place": settings.get("briefWeatherPlace", ""), "followUps": settings.get("followUps", True),
            "running": _briefing, "next": nxt.timestamp() * 1000, "ownerActive": owner_active(),
            "lastAt": st.get("lastAt", 0) * 1000, "last": st.get("last")}


def _summary(statuses=("open",)) -> dict:
    return {"items": rows(statuses), "counts": counts()}


@router.get("/api/commitments")
def api_list(status: str = "open"):
    sync_meetings()
    sts = STATUSES if status == "all" else tuple(s for s in status.split(",") if s in STATUSES) or ("open",)
    return _summary(sts)


@router.post("/api/commitments")
async def api_add(req: Request):
    b = await req.json()
    try:
        cid, dup = add(b.get("text"), due=b.get("due"), who=b.get("who") or "me", origin="manual")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {**_summary(), "added": cid, "duplicate": dup and dup["text"]}


@router.get("/api/commitments/noted/{msg_id}")
def api_noted(msg_id: str):
    if msg_id in _noted:
        return _noted[msg_id]
    with db.conn() as c:
        r = c.execute("SELECT data FROM messages WHERE id=?", (msg_id,)).fetchone()
    items = json.loads(r["data"] or "{}").get("followUps", []) if r else []
    return {"state": "done" if items else "none", "items": items}


@router.patch("/api/commitments/{cid}")
async def api_update(cid: str, req: Request):
    b = await req.json()
    try:
        update(cid, text=b.get("text"), due=b["due"] if "due" in b else "keep", status=b.get("status"), who=b.get("who"))
    except KeyError:
        raise HTTPException(404, "No such follow-up")
    except ValueError:
        raise HTTPException(400, "status must be open, done or dismissed")
    return _summary(("open", "done", "dismissed") if b.get("status") else ("open",))


@router.post("/api/commitments/{cid}/undo")
def api_undo(cid: str, msg: str = ""):
    """Undo what the learner did under a reply: a noted follow-up is deleted, one it marked done is reopened."""
    c0 = get(cid)
    if c0:
        noted = (_noted.get(msg) or api_noted(msg)) if msg else {"items": []}
        op = next((i.get("op") for i in noted.get("items", []) if i.get("id") == cid),
                  "add" if c0["status"] == "open" else "done")
        if op == "done":
            update(cid, status="open")
        else:
            delete(cid)
    if msg:
        _drop_noted(msg, cid)
    return _summary()


@router.delete("/api/commitments/{cid}")
def api_delete(cid: str):
    delete(cid)
    return _summary()


@router.get("/api/brief")
def api_brief():
    return brief_info()


@router.post("/api/brief/run")
async def api_brief_run():
    """"Brief me now": compose and post one regardless of the time (doesn't move today's scheduled one)."""
    if not _briefing:
        st = _state()
        b = await run_brief(force=True)
        _save_state(lastDay=st.get("lastDay"))  # the scheduled brief still comes at its time
        return {**brief_info(), "last": b}
    return brief_info()
