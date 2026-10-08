"""Scheduled tasks: an agent prompt that runs on its own, once at a set time or on a cron schedule.

Each run starts a new chat (in a chat Project if the task has one) titled after the task, so the results sit in the
sidebar like any other conversation. Times are kept in the task's IANA time zone, so "every weekday at 08:00" stays
08:00 across daylight-saving changes. Runs go one at a time: this is one GPU box, and two long agent turns at once
just make both slow. A run the server missed while it was down (or busy) fires once when it gets the chance, and is
marked late; missed runs never stack up.
"""
import asyncio
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Request

import activity
import db
from tools import TOOLS, ToolResult, _fn

router = APIRouter()
MIN_GAP = 5 * 60      # cron schedules may not fire more often than this
MAX_ENABLED = 50
POLL = 20             # seconds between checks for due tasks
RUN_NOTE = """## Scheduled run
This turn was started by the scheduled task "{name}", not by a person typing. Nobody is watching it live: don't ask
questions or wait for confirmation; make reasonable assumptions, finish the job, and end with a clear result the user
can read later."""

# set by app.py: async (task dict) -> (conv_id, status, error)
runner = None
_queue: asyncio.Queue | None = None
_pending: set[str] = set()   # task ids queued or running, so a slow run is not queued twice
_running: str | None = None
_TASKS: set = set()


def init():
    with db.conn() as c:
        c.executescript("""
CREATE TABLE IF NOT EXISTS schedules(
  id TEXT PRIMARY KEY, name TEXT, prompt TEXT, agent_id TEXT, group_id TEXT, kind TEXT, at REAL, cron TEXT, tz TEXT,
  enabled INTEGER DEFAULT 1, next_run REAL, last_run REAL, last_status TEXT, last_conv TEXT, created_by TEXT,
  created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS schedule_runs(
  id TEXT PRIMARY KEY, schedule_id TEXT, conv_id TEXT, trigger TEXT, started REAL, finished REAL, status TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS schedule_runs_sched ON schedule_runs(schedule_id, started);
""")
        # a run that was in flight when the server stopped never finished
        cut = c.execute("SELECT r.id, r.conv_id, s.name FROM schedule_runs r LEFT JOIN schedules s ON s.id=r.schedule_id "
                        "WHERE r.status='running'").fetchall()
        c.execute("UPDATE schedule_runs SET status='interrupted', finished=? WHERE status='running'", (time.time(),))
    for r in cut:
        activity.post("schedule", "interrupted", f"Scheduled: {r['name'] or 'deleted task'}",
                      "A server restart cut this run short.", f"#/c/{r['conv_id']}" if r["conv_id"] else "#/scheduled",
                      ref=f"run:{r['id']}")


# ── cron ────────────────────────────────────────────────────────────────────

_NAMES = {"dow": ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
          "month": ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]}
_FIELDS = [("minute", 0, 59), ("hour", 0, 23), ("dom", 1, 31), ("month", 1, 12), ("dow", 0, 7)]
_MACROS = {"@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0",
           "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *"}


def _value(tok, name):
    tok = tok.lower()
    if name in _NAMES and tok[:3] in _NAMES[name]:
        return _NAMES[name].index(tok[:3]) + (1 if name == "month" else 0)
    if not tok.isdigit():
        raise ValueError(f"bad {name} value '{tok}'")
    return int(tok)


def parse_cron(expr: str):
    """Five-field cron (minute hour day-of-month month day-of-week) with *, lists, ranges, steps and day/month
    names. Returns (sets, dom_restricted, dow_restricted)."""
    expr = _MACROS.get(expr.strip().lower(), expr)
    parts = expr.split()
    if len(parts) != 5:
        raise ValueError("cron needs 5 fields: minute hour day-of-month month day-of-week")
    sets, restricted = [], []
    for part, (name, lo, hi) in zip(parts, _FIELDS):
        out = set()
        for item in part.split(","):
            rng, _, step = item.partition("/")
            step = int(step) if step else 1
            if step < 1:
                raise ValueError(f"bad step in {name}")
            if rng == "*":
                a, b = lo, (6 if name == "dow" else hi)
            elif "-" in rng:
                a, b = (_value(x, name) for x in rng.split("-", 1))
            else:
                a = _value(rng, name)
                b = (6 if name == "dow" else hi) if step > 1 else a
            if not (lo <= a <= hi and lo <= b <= hi and a <= b):
                raise ValueError(f"{name} out of range ({lo}-{hi}): '{item}'")
            out.update(range(a, b + 1, step))
        if name == "dow" and 7 in out:
            out = (out - {7}) | {0}
        sets.append(sorted(out))
        restricted.append(part != "*")
    return sets, restricted[2], restricted[4]


def next_cron(expr: str, tz: str, after: float) -> float | None:
    """The first time strictly after `after` (epoch seconds) that matches `expr` in time zone `tz`."""
    (mins, hours, doms, months, dows), dom_r, dow_r = parse_cron(expr)
    zone = ZoneInfo(tz)
    start = datetime.fromtimestamp(after, zone).replace(second=0, microsecond=0, tzinfo=None) + timedelta(minutes=1)
    day = start.date()
    for _ in range(366 * 5):
        if day.month in months:
            dom_ok, dow_ok = day.day in doms, (day.weekday() + 1) % 7 in dows
            # cron rule: when both day fields are restricted, either one matching is enough
            if (dom_ok or dow_ok) if (dom_r and dow_r) else (dom_ok and dow_ok):
                for h in hours:
                    for m in mins:
                        local = datetime(day.year, day.month, day.day, h, m)
                        if local >= start:
                            ts = local.replace(tzinfo=zone).timestamp()
                            if ts > after:
                                return ts
        day += timedelta(days=1)
    return None


def describe(t: dict) -> str:
    """A short human summary of when a task runs."""
    if t["kind"] == "once":
        return "Once, " + datetime.fromtimestamp(t["at"], ZoneInfo(t["tz"])).strftime("%a %b %-d %Y, %H:%M")
    try:
        (mins, hours, doms, months, dows), dom_r, dow_r = parse_cron(t["cron"])
    except ValueError:
        return t["cron"]
    month_r = len(months) < 12
    if len(mins) == 1 and len(hours) == 1 and not month_r:
        at = f"{hours[0]:02d}:{mins[0]:02d}"
        if not dom_r and not dow_r:
            return f"Every day at {at}"
        if not dom_r:
            if dows == [1, 2, 3, 4, 5]:
                return f"Weekdays at {at}"
            if dows == [0, 6]:
                return f"Weekends at {at}"
            return f"{', '.join(_NAMES['dow'][d].title() for d in dows)} at {at}"
        if not dow_r and len(doms) == 1:
            return f"Monthly on day {doms[0]} at {at}"
    if len(mins) == 1 and len(hours) == 24 and not dom_r and not dow_r and not month_r:
        return "Every hour" + (f" at :{mins[0]:02d}" if mins[0] else "")
    if not dom_r and not dow_r and not month_r:
        if len(hours) == 24 and len(mins) > 1 and mins[0] == 0 and 60 % len(mins) == 0 \
                and mins == list(range(0, 60, 60 // len(mins))):
            return f"Every {60 // len(mins)} minutes"
        if len(mins) == 1 and len(hours) > 1 and hours[0] == 0 and 24 % len(hours) == 0 \
                and hours == list(range(0, 24, 24 // len(hours))):
            return f"Every {24 // len(hours)} hours" + (f" at :{mins[0]:02d}" if mins[0] else "")
    return f"Cron {t['cron']}"


# ── storage ─────────────────────────────────────────────────────────────────

def _row(r):
    t = {"id": r["id"], "name": r["name"], "prompt": r["prompt"], "agentId": r["agent_id"], "groupId": r["group_id"],
         "kind": r["kind"], "at": r["at"] * 1000 if r["at"] else None, "cron": r["cron"] or "", "tz": r["tz"],
         "enabled": bool(r["enabled"]), "nextRun": r["next_run"] * 1000 if r["next_run"] else None,
         "lastRun": r["last_run"] * 1000 if r["last_run"] else None, "lastStatus": r["last_status"],
         "lastConvId": r["last_conv"], "createdBy": r["created_by"] or "user",
         "createdAt": r["created"] * 1000, "updatedAt": r["updated"] * 1000}
    t["when"] = describe({**t, "at": r["at"]})
    t["running"] = t["id"] == _running
    t["queued"] = t["id"] in _pending and not t["running"]
    return t


def get(sid):
    with db.conn() as c:
        r = c.execute("SELECT * FROM schedules WHERE id=?", (sid,)).fetchone()
    return _row(r) if r else None


def list_all():
    with db.conn() as c:
        rows = c.execute("SELECT * FROM schedules ORDER BY enabled DESC, next_run IS NULL, next_run, created DESC").fetchall()
    return [_row(r) for r in rows]


def runs(sid=None, limit=30):
    with db.conn() as c:
        rows = c.execute(
            "SELECT r.*, s.name FROM schedule_runs r LEFT JOIN schedules s ON s.id=r.schedule_id "
            + ("WHERE r.schedule_id=? " if sid else "") + "ORDER BY r.started DESC LIMIT ?",
            ((sid, limit) if sid else (limit,))).fetchall()
    return [{"id": r["id"], "scheduleId": r["schedule_id"], "name": r["name"], "convId": r["conv_id"], "trigger": r["trigger"],
             "startedAt": r["started"] * 1000, "finishedAt": r["finished"] * 1000 if r["finished"] else None,
             "status": r["status"], "error": r["error"]} for r in rows]


def last_finished() -> float:
    with db.conn() as c:
        r = c.execute("SELECT MAX(finished) f FROM schedule_runs").fetchone()
    return (r["f"] or 0) * 1000


def _check_tz(tz):
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError(f"unknown time zone '{tz}'")


def _plan(kind, at, cron, tz, now=None):
    """Validate the timing fields; returns next_run (epoch seconds)."""
    now = now or time.time()
    _check_tz(tz)
    if kind == "once":
        if not at:
            raise ValueError("a one-time task needs a date and time")
        if at <= now:
            raise ValueError("that time is already in the past")
        return at
    if kind != "cron":
        raise ValueError("kind must be 'once' or 'cron'")
    first = next_cron(cron, tz, now)
    if first is None:
        raise ValueError("that cron expression never fires")
    second = next_cron(cron, tz, first)
    if second and second - first < MIN_GAP:
        raise ValueError(f"tasks can run at most every {MIN_GAP // 60} minutes")
    return first


def parse_local(text: str, tz: str) -> float:
    """'2026-10-02T08:00' (wall-clock time in tz) or an ISO string with an offset -> epoch seconds."""
    dt = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo(tz))
    return dt.timestamp()


def save(body: dict, sid: str | None = None, created_by="user") -> dict:
    cur = get(sid) if sid else None
    if sid and not cur:
        raise KeyError(sid)
    merged = {**(cur or {}), **{k: v for k, v in body.items() if v is not None}}
    name = str(merged.get("name") or "").strip()[:120]
    prompt = str(merged.get("prompt") or "").strip()
    if not name or not prompt:
        raise ValueError("a task needs a name and a prompt")
    kind = merged.get("kind") or "cron"
    tz = merged.get("tz") or "UTC"
    cron = str(merged.get("cron") or "").strip() if kind == "cron" else ""
    at = merged.get("at")
    if isinstance(at, str):
        at = parse_local(at, tz)
    elif at:
        at = float(at) / 1000  # the UI sends milliseconds
    at = at if kind == "once" else None
    enabled = bool(merged.get("enabled", True))
    timing_changed = not cur or any(body.get(k) is not None for k in ("kind", "at", "cron", "tz")) \
        or (enabled and not cur["enabled"])
    if timing_changed and enabled:
        next_run = _plan(kind, at, cron, tz)
    elif enabled:
        next_run = cur["nextRun"] / 1000 if cur["nextRun"] else _plan(kind, at, cron, tz)
    else:
        next_run = None
    if enabled and (not cur or not cur["enabled"]):
        with db.conn() as c:
            n = c.execute("SELECT COUNT(*) n FROM schedules WHERE enabled=1").fetchone()["n"]
        if n >= MAX_ENABLED:
            raise ValueError(f"at most {MAX_ENABLED} tasks can be active at once")
    now = time.time()
    vals = (name, prompt, merged.get("agentId") or "shellb", merged.get("groupId") or None, kind, at, cron, tz,
            int(enabled), next_run)
    with db.conn() as c:
        if cur:
            c.execute("UPDATE schedules SET name=?, prompt=?, agent_id=?, group_id=?, kind=?, at=?, cron=?, tz=?, enabled=?, "
                      "next_run=?, updated=? WHERE id=?", (*vals, now, sid))
        else:
            sid = db.new_id("sched")
            c.execute("INSERT INTO schedules(name, prompt, agent_id, group_id, kind, at, cron, tz, enabled, next_run, "
                      "id, created_by, created, updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      (*vals, sid, created_by, now, now))
    _wake()
    return get(sid)


def delete(sid):
    with db.conn() as c:
        c.execute("DELETE FROM schedules WHERE id=?", (sid,))
        c.execute("DELETE FROM schedule_runs WHERE schedule_id=?", (sid,))


# ── the loop ────────────────────────────────────────────────────────────────

_wake_event: asyncio.Event | None = None


def _wake():
    if _wake_event:
        _wake_event.set()


def enqueue(sid, trigger="manual"):
    if sid in _pending:
        return False
    _pending.add(sid)
    _queue.put_nowait((sid, trigger))
    return True


async def _tick():
    now = time.time()
    with db.conn() as c:
        due = c.execute("SELECT * FROM schedules WHERE enabled=1 AND next_run IS NOT NULL AND next_run<=?", (now,)).fetchall()
    for r in due:
        late = now - r["next_run"] > 120
        # move the schedule on before running, so a crash mid-run can't make it fire again and again
        if r["kind"] == "once":
            nxt, enabled = None, 0
        else:
            try:
                nxt, enabled = next_cron(r["cron"], r["tz"], now), 1
            except (ValueError, ZoneInfoNotFoundError):
                nxt, enabled = None, 0
        with db.conn() as c:
            c.execute("UPDATE schedules SET next_run=?, enabled=? WHERE id=?", (nxt, enabled, r["id"]))
        enqueue(r["id"], "late" if late else "schedule")


async def _loop():
    global _wake_event
    _wake_event = asyncio.Event()
    while True:
        try:
            await _tick()
        except Exception as e:  # keep the scheduler alive whatever one tick does
            print(f"[schedules] tick failed: {type(e).__name__}: {e}")
        with db.conn() as c:
            r = c.execute("SELECT MIN(next_run) n FROM schedules WHERE enabled=1").fetchone()
        wait = POLL if not r["n"] else max(1, min(POLL, r["n"] - time.time()))
        _wake_event.clear()
        try:
            await asyncio.wait_for(_wake_event.wait(), wait)
        except asyncio.TimeoutError:
            pass


async def _worker():
    global _running
    while True:
        sid, trigger = await _queue.get()
        t = get(sid)
        if not t:
            _pending.discard(sid)
            continue
        _running = sid
        rid, started = db.new_id("run"), time.time()
        with db.conn() as c:
            c.execute("INSERT INTO schedule_runs VALUES(?,?,?,?,?,?,?,?)", (rid, sid, None, trigger, started, None, "running", None))
        conv_id, status, error = None, "error", None
        try:
            conv_id, status, error = await runner(t, lambda cid: _set_run_conv(rid, sid, cid))
        except Exception as e:
            error = f"{type(e).__name__}: {e}"
        finally:
            _running = None
            _pending.discard(sid)
        with db.conn() as c:
            c.execute("UPDATE schedule_runs SET conv_id=?, finished=?, status=?, error=? WHERE id=?",
                      (conv_id, time.time(), status, error, rid))
            c.execute("UPDATE schedules SET last_run=?, last_status=?, last_conv=? WHERE id=?", (started, status, conv_id, sid))
        if status != "stopped":
            activity.post("schedule", "done" if status == "complete" else "failed", f"Scheduled: {t['name']}",
                          error or "", f"#/c/{conv_id}" if conv_id else "#/scheduled", ref=f"run:{rid}")


def _set_run_conv(rid, sid, conv_id):
    with db.conn() as c:
        c.execute("UPDATE schedule_runs SET conv_id=? WHERE id=?", (conv_id, rid))
        c.execute("UPDATE schedules SET last_conv=? WHERE id=?", (conv_id, sid))


def start():
    global _queue
    _queue = asyncio.Queue()
    for fn in (_loop, _worker):
        t = asyncio.create_task(fn())
        _TASKS.add(t)


def stop():
    for t in list(_TASKS):
        t.cancel()
    _TASKS.clear()


def running_now():
    return _running


# ── agent tool ──────────────────────────────────────────────────────────────

async def schedule_task(args, ctx):
    import groups
    action = (args.get("action") or "create").lower()
    tz = ctx.settings.get("timeZone") or "UTC"
    if action == "list":
        ts = list_all()
        if not ts:
            return ToolResult("No scheduled tasks.")
        lines = [f"- {t['id']} · {t['name']} · {t['when']} ({t['tz']}) · "
                 + ("next " + datetime.fromtimestamp(t["nextRun"] / 1000, ZoneInfo(t["tz"])).strftime("%Y-%m-%d %H:%M")
                    if t["nextRun"] else "paused") for t in ts]
        return ToolResult("\n".join(lines))
    if action in ("delete", "cancel"):
        t = get(str(args.get("id") or ""))
        if not t:
            return ToolResult("No task with that id; call with action=list to see them.", error=True)
        delete(t["id"])
        return ToolResult(f"Deleted the scheduled task '{t['name']}'.", display={"schedule": {"id": t["id"], "deleted": True}})
    if action != "create":
        return ToolResult("action must be create, list or delete", error=True)
    body = {"name": args.get("name") or str(args.get("prompt", ""))[:60], "prompt": args.get("prompt"),
            "agentId": args.get("agent") or ctx.agent.get("id"), "tz": args.get("tz") or tz,
            "groupId": None if ctx.project_id else groups.group_of(ctx.conv_id)}
    if args.get("cron"):
        body |= {"kind": "cron", "cron": args["cron"]}
    elif args.get("at"):
        body |= {"kind": "once", "at": str(args["at"])}
    else:
        return ToolResult("Give either `at` (one time) or `cron` (repeating).", error=True)
    pending = bool(args.get("_pending"))  # set by agent._schedule_request when nobody could approve it live
    if pending:
        body["enabled"] = False
    try:
        t = save(body, created_by=f"agent:{ctx.agent.get('id')}")
    except (ValueError, KeyError) as e:
        return ToolResult(f"Couldn't schedule it: {e}", error=True)
    if pending:
        import activity
        activity.post("schedule", "review", f"{ctx.agent.get('name') or 'An agent'} wants to schedule “{t['name']}”",
                      f"{t['when']} ({t['tz']}). Switch it on under Scheduled if you want it.\n\n"
                      + activity.excerpt(t["prompt"], 600), "#/scheduled", ref=f"sched-review:{t['id']}")
        return ToolResult(f"Saved '{t['name']}' ({t['when']}, id {t['id']}) switched OFF: no one was here to approve it, so "
                          "the owner has to switch it on under Scheduled (they've been told in Activity).",
                          display={"schedule": {"id": t["id"], "name": t["name"], "when": t["when"], "nextRun": None}})
    nxt = datetime.fromtimestamp(t["nextRun"] / 1000, ZoneInfo(t["tz"])).strftime("%A %B %-d, %Y at %H:%M %Z")
    return ToolResult(f"Scheduled '{t['name']}' ({t['when']}, id {t['id']}). Next run: {nxt}. Each run starts a new chat; "
                      "the user can see and edit it under Scheduled in the sidebar.",
                      display={"schedule": {"id": t["id"], "name": t["name"], "when": t["when"], "nextRun": t["nextRun"]}})


def register():
    TOOLS["schedule_task"] = {
        "fn": schedule_task, "service": None,
        "ui": {"displayName": "Schedule Tasks", "icon": "CalendarClock", "category": "automation",
               "description": "Lets the agent schedule prompts to run later, once or on a repeating schedule."},
        "schema": _fn("schedule_task",
                      "Schedule a prompt to run automatically later, once or repeating, e.g. 'every weekday at 8 summarize the "
                      "news' or 'tomorrow at 9 remind me to call the supplier'. Each run starts a new chat with the prompt, "
                      "run by an agent with nobody watching, so write the prompt as a complete, self-contained instruction. "
                      "Times are wall-clock in the user's time zone (see Current date and time). Also lists and deletes tasks.",
                      {"action": {"type": "string", "enum": ["create", "list", "delete"], "description": "Default create"},
                       "name": {"type": "string", "description": "Short task name"},
                       "prompt": {"type": "string", "description": "The full instruction each run starts with"},
                       "at": {"type": "string", "description": "One-time run, local ISO time like 2026-10-02T09:00"},
                       "cron": {"type": "string", "description": "Repeating: 5-field cron in local time, e.g. '0 8 * * 1-5'"},
                       "agent": {"type": "string", "description": "Agent id to run it (default: you)"},
                       "id": {"type": "string", "description": "Task id, for delete"}}, []),
    }


# ── API ─────────────────────────────────────────────────────────────────────

def _err(e):
    return HTTPException(404, "No such task") if isinstance(e, KeyError) else HTTPException(400, str(e))


@router.get("/api/schedules")
def api_list():
    return {"tasks": list_all(), "runs": runs(limit=40)}


@router.post("/api/schedules")
async def api_create(req: Request):
    try:
        return save(await req.json())
    except (ValueError, KeyError) as e:
        raise _err(e)


@router.patch("/api/schedules/{sid}")
async def api_patch(sid: str, req: Request):
    try:
        return save(await req.json(), sid)
    except (ValueError, KeyError) as e:
        raise _err(e)


@router.delete("/api/schedules/{sid}")
def api_delete(sid: str):
    delete(sid)
    return {"ok": True}


@router.post("/api/schedules/{sid}/run")
async def api_run(sid: str):  # async: enqueue() touches the worker's asyncio.Queue
    if not get(sid):
        raise HTTPException(404, "No such task")
    return {"queued": enqueue(sid, "manual")}


@router.get("/api/schedules/{sid}/runs")
def api_runs(sid: str):
    return runs(sid, limit=100)


@router.post("/api/schedules/preview")
async def api_preview(req: Request):
    """The next few run times for a draft task, so the editor can show them before saving."""
    body = await req.json()
    tz = body.get("tz") or "UTC"
    try:
        _check_tz(tz)
        if body.get("kind") == "once":
            at = body.get("at")
            at = parse_local(at, tz) if isinstance(at, str) else float(at) / 1000
            if at <= time.time():
                raise ValueError("that time is already in the past")
            times = [at]
        else:
            times, t = [], time.time()
            for _ in range(5):
                t = next_cron(body.get("cron") or "", tz, t)
                if t is None:
                    break
                times.append(t)
            _plan("cron", None, body.get("cron") or "", tz)
        return {"ok": True, "next": [x * 1000 for x in times],
                "when": describe({"kind": body.get("kind") or "cron", "at": times[0] if times else None,
                                  "cron": body.get("cron") or "", "tz": tz})}
    except (ValueError, ZoneInfoNotFoundError) as e:
        return {"ok": False, "error": str(e), "next": []}
