"""Night shift: slow, heavy work for the big local model while the owner is away. Shown at #/activity/night-shift.

The box sits idle most of the day, and the everyday agents run on the fast model (ShellB-Swift). The night shift
gives queued jobs to the quality model (setting `nightShiftModel`, ShellB-Titan = gpt-oss-120b) whenever Shell:B has
been quiet for a while, and gets out of the way the moment anyone needs the box.

Jobs (table nightshift_jobs), research first, then redrafts, oldest first within each kind:
  research  a question the owner (or an agent, via the night_shift tool) queued. Minerva works it unattended with a
            big tool budget and ends with a cited report. The chat is the result.
  redraft   a reply the owner rated 👎 in the last REDRAFT_DAYS. It is queued here automatically (setting
            `nightShiftRedrafts`). The original agent (Shell:B for cloud agents) writes a better answer in a new chat, given
            the conversation so far and the owner's feedback. The original chat is never touched.
Each finished job posts to Activity (source `nightshift`), so it also shows in the morning brief.

When it runs (`_can_start`): the setting `nightShift` is on, the time is inside `nightShiftWindow` ("01:00-07:00",
or "" for any time), no interactive turn started in the last `nightShiftIdleMinutes`, and nothing else is running
(chats, scheduled runs, to-dos, Mega Plans, asset scouts, notebooks, Generate jobs, dataset downloads).

Yielding: a job's turn is aborted as soon as an interactive turn starts (`touch`, called from app.begin_turn) or
any other turn or background job appears. The job goes back in the queue and later continues in the same chat. The
big model doesn't fit next to the fast one with the other services up (~70 GB ceiling for one model), so the shift
unloads the other chat models before it starts and unloads its own model when it yields or the queue is empty. Every
turn waits for that unload (`make_room`) before it talks to Ollama. When the queue is done, the fast
model is warmed up again so the owner's next message doesn't wait for a load.
"""
import asyncio
import json
import time
from datetime import datetime

import httpx
from fastapi import APIRouter, HTTPException, Request

import activity
import db
from tools import TOOLS, ToolResult, _fn

router = APIRouter(prefix="/api/nightshift")
OLLAMA = "http://localhost:11434"
KINDS = ("research", "redraft")
STATUSES = ("queued", "running", "done", "failed", "cancelled")
POLL = 30              # seconds between idle checks
WATCH = 3              # seconds between checks for a reason to yield while a job runs
MAX_ATTEMPTS = 2       # errored runs before a job is marked failed (yielding doesn't count)
REDRAFT_DAYS = 14
REDRAFT_PER_SYNC = 10
RESEARCH_AGENT = "minerva"

RESEARCH_NOTE = """## Night shift
This turn was started by the night shift: the owner queued this question to be researched while they're away. Nobody
is watching it live, so don't ask questions or wait for confirmation. Make reasonable assumptions and say what they were.

There is no hurry. Be thorough: search widely, read the primary sources rather than summaries of them, cross-check
claims that matter, and note where sources disagree. End with a complete report as your final reply, written for the
owner to read in the morning: the answer first, then the details, with every claim cited to the page it came from.
The run can be interrupted when the owner comes back; if you see an earlier, unfinished attempt above, pick up from
there instead of starting over."""

REDRAFT_NOTE = """## Night shift: second draft
This turn was started by the night shift, not by a person typing. Nobody is watching it live, so don't ask questions.
The owner rated one of your earlier replies down. Write the reply they should have got: answer the original request
again, from scratch, fixing what their feedback says was wrong. Don't apologise or talk about the earlier reply; just
give the better answer. Use tools if the task needs them (search, check facts, write the file)."""

RESUME = ("[Night shift] The previous attempt was interrupted because the owner needed the box. Continue from where "
          "it stopped and finish the job; don't repeat work that is already done above.")

# set by app.py
run_turn = None        # async (job, conv_id or None, content, note, opts, on_conv) -> (conv_id, status, error, text)
abort_turn = None      # (conv_id) -> bool
busy = None            # () -> str | None: background work other than chat turns that is running, if any
active_convs = None    # () -> conv ids with a turn running now (ours included)
get_settings = None

_running: dict | None = None   # {"job", "conv", "kind", "title", "since"}
_yield_reason: str | None = None
_unload: asyncio.Task | None = None
_last_human = time.time()      # a restart counts as activity: wait a full idle period after it
_wake_event: asyncio.Event | None = None
_TASKS: set = set()


def init():
    with db.conn() as c:
        c.executescript("""
CREATE TABLE IF NOT EXISTS nightshift_jobs(
  id TEXT PRIMARY KEY, kind TEXT, title TEXT, prompt TEXT DEFAULT '', agent_id TEXT, ref TEXT, status TEXT DEFAULT 'queued',
  attempts INTEGER DEFAULT 0, yields INTEGER DEFAULT 0, conv_id TEXT, result TEXT DEFAULT '', error TEXT DEFAULT '',
  created_by TEXT, created REAL, updated REAL, started REAL, finished REAL);
CREATE INDEX IF NOT EXISTS nightshift_jobs_status ON nightshift_jobs(status, created);
CREATE UNIQUE INDEX IF NOT EXISTS nightshift_jobs_ref ON nightshift_jobs(kind, ref) WHERE ref IS NOT NULL;
""")
        # a job cut off by a restart carries on in its chat next time
        c.execute("UPDATE nightshift_jobs SET status='queued', updated=? WHERE status='running'", (time.time(),))


def _settings() -> dict:
    return get_settings() if get_settings else {}


def _job(r) -> dict:
    return {"id": r["id"], "kind": r["kind"], "title": r["title"], "prompt": r["prompt"] or "", "agentId": r["agent_id"],
            "ref": r["ref"], "status": r["status"], "attempts": r["attempts"], "yields": r["yields"], "convId": r["conv_id"],
            "result": r["result"] or "", "error": r["error"] or "", "createdBy": r["created_by"] or "user",
            "createdAt": r["created"] * 1000, "updatedAt": r["updated"] * 1000,
            "startedAt": r["started"] * 1000 if r["started"] else None,
            "finishedAt": r["finished"] * 1000 if r["finished"] else None}


def get(jid) -> dict | None:
    with db.conn() as c:
        r = c.execute("SELECT * FROM nightshift_jobs WHERE id=?", (jid,)).fetchone()
    return _job(r) if r else None


def jobs(limit=100) -> list[dict]:
    with db.conn() as c:
        rows = c.execute("SELECT * FROM nightshift_jobs ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 "
                         "ELSE 2 END, CASE WHEN status IN ('running','queued') THEN 0 ELSE -COALESCE(finished, updated) END, "
                         "CASE kind WHEN 'research' THEN 0 ELSE 1 END, created LIMIT ?", (limit,)).fetchall()
    return [_job(r) for r in rows]


def _set(jid, **f):
    f["updated"] = time.time()
    with db.conn() as c:
        c.execute(f"UPDATE nightshift_jobs SET {', '.join(k + '=?' for k in f)} WHERE id=?", (*f.values(), jid))


def add_research(prompt: str, title: str = "", agent_id: str = RESEARCH_AGENT, created_by="user") -> dict:
    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("say what to research")
    title = (title or "").strip() or prompt.splitlines()[0]
    if len(title) > 90:
        title = title[:90].rsplit(" ", 1)[0] + "…"
    from roster import get_agents
    if not any(a["id"] == agent_id for a in get_agents()):
        raise ValueError(f"no agent '{agent_id}'")
    jid, now = db.new_id("night"), time.time()
    with db.conn() as c:
        c.execute("INSERT INTO nightshift_jobs(id, kind, title, prompt, agent_id, status, created_by, created, updated) "
                  "VALUES(?,?,?,?,?,'queued',?,?,?)", (jid, "research", title, prompt, agent_id, created_by, now, now))
    _wake()
    return get(jid)


def cancel(jid):
    j = get(jid)
    if not j:
        raise KeyError(jid)
    if j["status"] == "running" and _running and _running["job"] == jid:
        _yield("cancelled")
    if j["status"] in ("queued", "running"):
        _set(jid, status="cancelled", finished=time.time())


def requeue(jid):
    j = get(jid)
    if not j:
        raise KeyError(jid)
    if j["status"] in ("queued", "running"):
        return
    _set(jid, status="queued", attempts=0, error="", finished=None)
    _wake()


def delete(jid):
    j = get(jid)
    if j and j["status"] == "running":
        raise ValueError("that job is running; cancel it first")
    with db.conn() as c:
        c.execute("DELETE FROM nightshift_jobs WHERE id=?", (jid,))


def clear_finished():
    # cancelled redrafts stay, so the same 👎 isn't queued again
    with db.conn() as c:
        c.execute("DELETE FROM nightshift_jobs WHERE status IN ('done','failed') OR (status='cancelled' AND kind<>'redraft')")


# ── redrafts from 👎 ─────────────────────────────────────────────────────────

def sync_redrafts() -> int:
    """Queue a redraft for each recent thumbs-down that has none yet. Returns how many were added."""
    if not _settings().get("nightShiftRedrafts", True):
        return 0
    import adult
    from roster import get_agents
    agents = {a["id"]: a for a in get_agents()}
    since, added = time.time() - REDRAFT_DAYS * 86400, 0
    with db.conn() as c:
        rows = c.execute("SELECT f.* FROM feedback f JOIN conversations v ON v.id=f.conv_id WHERE f.rating='down' "
                         "AND f.created>=? AND COALESCE(v.incognito, 0)=0 AND NOT EXISTS (SELECT 1 FROM nightshift_jobs j "
                         "WHERE j.kind='redraft' AND j.ref=f.msg_id) ORDER BY f.created DESC LIMIT ?",
                         (since, REDRAFT_PER_SYNC)).fetchall()
        for f in rows:
            a = agents.get(f["agent_id"])
            if a and adult.is_adult(a):
                continue   # interactive-only, never unattended
            conv = db.get_conversation(f["conv_id"])
            now = time.time()
            c.execute("INSERT OR IGNORE INTO nightshift_jobs(id, kind, title, agent_id, ref, status, created_by, created, updated) "
                      "VALUES(?,?,?,?,?,'queued','feedback',?,?)",
                      (db.new_id("night"), "redraft", f"Second draft: {(conv or {}).get('title') or 'a reply'}"[:120],
                       _redraft_agent(a), f["msg_id"], now, now))
            added += 1
    return added


def _redraft_agent(a: dict | None) -> str:
    import providers
    if not a or providers.is_cloud(a.get("model", "")):
        return "shellb"   # the night shift is local work: a cloud agent's reply is redrafted by Shell:B
    return a["id"]


def _clip(s: str, n: int) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[:n].rsplit(" ", 1)[0] + " …[cut]"


def redraft_message(msg_id: str) -> str | None:
    """The redraft prompt: the conversation up to the rated reply, the reply, and what the owner said about it."""
    import feedback
    with db.conn() as c:
        f = c.execute("SELECT * FROM feedback WHERE msg_id=?", (msg_id,)).fetchone()
    if not f or f["rating"] != "down":
        return None
    msgs = db.list_messages(f["conv_id"])
    i = next((k for k, m in enumerate(msgs) if m["id"] == msg_id), None)
    if i is None:
        return None
    asked = next((k for k in range(i - 1, -1, -1) if msgs[k]["role"] == "user"), None)
    if asked is None:
        return None
    earlier = [m for m in msgs[max(0, asked - 8):asked] if (m.get("content") or "").strip()]
    reasons = [feedback.REASONS.get(r, r) for r in json.loads(f["reasons"] or "[]")]
    parts = []
    if earlier:
        parts.append("## The conversation before the request\n" + "\n\n".join(
            f"**{'Owner' if m['role'] == 'user' else 'Assistant'}:** {_clip(m['content'], 1500)}" for m in earlier))
    parts.append("## The request\n" + _clip(msgs[asked]["content"], 6000))
    parts.append("## The reply they rated down\n" + _clip(msgs[i].get("content") or "(empty)", 6000))
    said = "; ".join(reasons)
    if f["note"]:
        said = (said + ". " if said else "") + f"In their words: \"{f['note'].strip()}\""
    parts.append("## What they said was wrong\n" + (said or "Nothing specific; work out what a better answer looks like."))
    parts.append("Now write the better reply to the request.")
    return "\n\n".join(parts)


# ── when to run ──────────────────────────────────────────────────────────────

def touch():
    """An interactive turn is starting: note the time and get out of the way."""
    global _last_human
    _last_human = time.time()
    if _running:
        _yield("you came back")


def _yield(reason: str):
    global _yield_reason
    if not _running or _yield_reason:
        return
    _yield_reason = reason
    if _running.get("conv") and abort_turn:
        abort_turn(_running["conv"])
    _start_unload()


def _start_unload():
    global _unload
    if _unload and not _unload.done():
        return
    try:
        _unload = asyncio.get_running_loop().create_task(_unload_model(_model()))
    except RuntimeError:   # called from a worker thread: nothing to unload from there, the worker does it
        pass


async def make_room(timeout=30):
    """An interactive turn waits here until the night model has left memory."""
    t = _unload
    if t and not t.done():
        try:
            await asyncio.wait_for(asyncio.shield(t), timeout)
        except (asyncio.TimeoutError, Exception):  # noqa: BLE001
            pass


def in_window(spec: str, now: datetime | None = None) -> bool:
    spec = (spec or "").strip()
    if not spec:
        return True
    try:
        a, b = (x.strip() for x in spec.split("-", 1))
        start, end = (int(x[:2]) * 60 + int(x[3:5]) for x in (a.zfill(5), b.zfill(5)))
    except Exception:  # noqa: BLE001
        return True   # a malformed window doesn't switch the shift off; the settings UI validates it
    now = now or datetime.now()
    m = now.hour * 60 + now.minute
    return start <= m < end if start <= end else (m >= start or m < end)


def idle_seconds() -> float:
    return time.time() - _last_human


def _can_start() -> str | None:
    """None when a job may start, or why not."""
    s = _settings()
    if not s.get("nightShift", True):
        return "off"
    if not in_window(s.get("nightShiftWindow", "")):
        return "outside its hours"
    need = float(s.get("nightShiftIdleMinutes", 20)) * 60
    if idle_seconds() < need:
        return "waiting for you to be away"
    if active_convs and active_convs():
        return "waiting for a chat to finish"
    other = busy() if busy else None
    if other:
        return f"waiting for {other}"
    return None


def _model() -> str:
    return str(_settings().get("nightShiftModel") or "ShellB-Titan")


# ── models ──────────────────────────────────────────────────────────────────

async def _loaded() -> list[dict]:
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            return (await c.get(f"{OLLAMA}/api/ps")).json().get("models", [])
    except Exception:  # noqa: BLE001
        return []


def _same(a: str, b: str) -> bool:
    return a.removesuffix(":latest") == b.removesuffix(":latest")


async def _unload_model(name: str):
    try:
        async with httpx.AsyncClient(timeout=30) as c:
            await c.post(f"{OLLAMA}/api/generate", json={"model": name, "keep_alive": 0})
        for _ in range(20):   # wait until the runner is really gone
            if not any(_same(m["name"], name) for m in await _loaded()):
                return
            await asyncio.sleep(0.5)
    except Exception as e:  # noqa: BLE001
        print(f"[nightshift] unloading {name} failed: {type(e).__name__}: {e}")


async def _make_space(model: str):
    """Unload every other chat model (embeddings stay) so the big one fits."""
    emb = str(_settings().get("embeddingModel") or "")
    for m in await _loaded():
        if not _same(m["name"], model) and not _same(m["name"], emb):
            await _unload_model(m["name"])


async def _rewarm():
    """Load the everyday model back so the owner's next message doesn't wait for it."""
    s = _settings()
    name = s.get("utilityModel") or "ShellB-Swift"
    try:
        async with httpx.AsyncClient(timeout=600) as c:
            await c.post(f"{OLLAMA}/api/generate", json={"model": name, "prompt": "", "stream": False})
    except Exception as e:  # noqa: BLE001
        print(f"[nightshift] warming {name} failed: {type(e).__name__}: {e}")


# ── running ─────────────────────────────────────────────────────────────────

def _wake():
    if _wake_event:
        _wake_event.set()


def _next() -> dict | None:
    with db.conn() as c:
        r = c.execute("SELECT * FROM nightshift_jobs WHERE status='queued' "
                      "ORDER BY CASE kind WHEN 'research' THEN 0 ELSE 1 END, created LIMIT 1").fetchone()
    return _job(r) if r else None


async def _watch(job_task: asyncio.Task):
    """Abort our turn when anything else wants the box."""
    while not job_task.done():
        await asyncio.sleep(WATCH)
        if not _running or _yield_reason:
            continue
        others = [c for c in (active_convs() if active_convs else []) if c != _running.get("conv")]
        other = ("another chat" if others else None) or (busy() if busy else None)
        if other:
            _yield(f"{other} started")


async def _run(job: dict):
    global _running, _yield_reason
    model = _model()
    _yield_reason = None
    now = time.time()
    _set(job["id"], status="running", started=job.get("startedAt") and job["startedAt"] / 1000 or now)
    _running = {"job": job["id"], "conv": job["convId"], "kind": job["kind"], "title": job["title"], "since": now * 1000,
                "model": model}
    resumed = bool(job["convId"] and db.get_conversation(job["convId"]))
    if job["kind"] == "research":
        content, note, opts = (RESUME if resumed else job["prompt"]), RESEARCH_NOTE, {"maxToolRounds": 80, "effort": "high"}
    else:
        msg = None if resumed else redraft_message(job["ref"])
        if not resumed and not msg:
            _running = None
            _set(job["id"], status="cancelled", error="The rated reply or its feedback is gone.", finished=time.time())
            return
        content, note, opts = (RESUME if resumed else msg), REDRAFT_NOTE, {"maxToolRounds": 40, "effort": "high"}
    opts["localModel"] = model
    opts["localNumCtx"] = int(_settings().get("nightShiftContext") or 65536)

    def on_conv(cid):
        _running["conv"] = cid
        _set(job["id"], conv_id=cid)

    await _make_space(model)
    conv_id, status, error, text = job["convId"], "error", None, ""
    task = asyncio.create_task(run_turn(job, job["convId"] if resumed else None, content, note, opts, on_conv))
    watcher = asyncio.create_task(_watch(task))
    try:
        conv_id, status, error, text = await task
    except Exception as e:  # noqa: BLE001
        error = f"{type(e).__name__}: {e}"
    finally:
        watcher.cancel()
        reason, _running, _yield_reason = _yield_reason, None, None
    if reason == "cancelled":
        return
    if reason or status == "stopped":   # yielded: back in the queue, same chat next time
        _set(job["id"], status="queued", yields=job["yields"] + 1, conv_id=conv_id)
        print(f"[nightshift] yielded {job['id']} ({reason or 'stopped'})")
        return
    if status == "complete":
        _set(job["id"], status="done", result=(text or "").strip()[:4000], error="", finished=time.time(), conv_id=conv_id)
        _report(job, "done", text, conv_id)
        return
    attempts = job["attempts"] + 1
    final = attempts >= MAX_ATTEMPTS
    _set(job["id"], status="failed" if final else "queued", attempts=attempts, error=error or status,
         finished=time.time() if final else None, conv_id=conv_id)
    if final:
        _report(job, "failed", error or status, conv_id)


def _report(job, outcome, text, conv_id):
    if job["kind"] == "redraft":
        try:   # so the original reply can point at its second draft
            import feedback
            feedback._set_message_data(job["ref"], "redraft", {"convId": conv_id, "status": outcome})
        except Exception:  # noqa: BLE001
            pass
    title = ("Night shift: " + job["title"]) if job["kind"] == "research" else job["title"]
    activity.post("nightshift", outcome, title, activity.excerpt(text), f"#/c/{conv_id}" if conv_id else "#/activity/night-shift",
                  ref=f"night:{job['id']}:{outcome}")


async def _worker():
    global _wake_event
    _wake_event = asyncio.Event()
    await asyncio.sleep(30)
    ran = False
    while True:
        try:
            if _can_start() is None:
                sync_redrafts()
                job = _next()
                if job:
                    await _run(job)
                    ran = True
                    continue
            if ran and not _running:   # the queue is empty or we yielded: hand the memory back
                ran = False
                await _unload_model(_model())
                if _can_start() is None:   # nobody came back; have the everyday model ready for them
                    await _rewarm()
        except Exception as e:  # noqa: BLE001 — keep the worker alive whatever one job does
            print(f"[nightshift] {type(e).__name__}: {e}")
            await asyncio.sleep(5)
        _wake_event.clear()
        try:
            await asyncio.wait_for(_wake_event.wait(), POLL)
        except asyncio.TimeoutError:
            pass


def start():
    init()
    t = asyncio.create_task(_worker())
    _TASKS.add(t)


def stop():
    for t in list(_TASKS):
        t.cancel()
    _TASKS.clear()


def running_now():
    return dict(_running) if _running else None


def overview() -> dict:
    s = _settings()
    items = jobs()
    return {"jobs": items, "running": running_now(), "blocked": None if _running else _can_start(),
            "idleSeconds": int(idle_seconds()), "queued": sum(j["status"] == "queued" for j in items),
            "settings": {"enabled": s.get("nightShift", True), "window": s.get("nightShiftWindow", ""),
                         "idleMinutes": s.get("nightShiftIdleMinutes", 20), "model": _model(),
                         "redrafts": s.get("nightShiftRedrafts", True)}}


# ── agent tool ──────────────────────────────────────────────────────────────

async def night_shift_tool(args, ctx):
    action = (args.get("action") or "list").lower()
    try:
        if action == "queue":
            j = add_research(str(args.get("prompt") or ""), str(args.get("title") or ""),
                             created_by=f"agent:{ctx.agent.get('id')}")
            return ToolResult(f"Queued for the night shift: \"{j['title']}\" (id {j['id']}). It runs on {_model()} once "
                              "the owner has been away a while; the report lands in Activity.")
        if action == "list":
            rows = [j for j in jobs(40) if j["status"] in ("queued", "running")]
            done = [j for j in jobs(40) if j["status"] in ("done", "failed")][:10]
            out = ["Queued or running:"] + ([f"- {j['id']} [{j['status']}] {j['title']}" for j in rows] or ["- nothing"])
            out += ["Recently finished:"] + [f"- {j['id']} [{j['status']}] {j['title']}" + (f" (chat {j['convId']})" if j["convId"] else "")
                                            for j in done]
            return ToolResult("\n".join(out))
        if action == "cancel":
            cancel(str(args.get("id") or ""))
            return ToolResult("Cancelled.")
        return ToolResult("action must be queue, list or cancel", error=True)
    except (ValueError, KeyError) as e:
        return ToolResult(f"Couldn't do that: {e}", error=True)


def tool_allowed(agent: dict, settings: dict) -> bool:
    import providers
    return bool(settings.get("nightShift", True)) and not providers.is_cloud(agent.get("model", ""))


def register():
    TOOLS["night_shift"] = {
        "fn": night_shift_tool, "service": None, "scope": "global",
        "ui": {"displayName": "Night Shift", "icon": "Moon", "category": "memory",
               "description": "Queues deep research for the big local model to do while the owner is away."},
        "schema": _fn("night_shift",
                      "The night shift: slow, thorough research the big local model does while the owner is away; the report "
                      "lands in Activity. Use queue when the owner says to look into something later, overnight or while "
                      "they're away, or when a question deserves more time than this turn has. Write prompt as a complete, "
                      "self-contained research brief (it runs with nobody watching). list shows the queue; cancel removes a job.",
                      {"action": {"type": "string", "enum": ["queue", "list", "cancel"]},
                       "prompt": {"type": "string", "description": "For queue: the full research brief"},
                       "title": {"type": "string", "description": "For queue: a short title"},
                       "id": {"type": "string", "description": "For cancel: the job id"}},
                      ["action"]),
    }


# ── API ─────────────────────────────────────────────────────────────────────

def _err(e):
    return HTTPException(404, "No such job") if isinstance(e, KeyError) else HTTPException(400, str(e))


@router.get("")
def api_overview():
    return overview()


@router.post("")
async def api_add(req: Request):
    b = await req.json()
    try:
        add_research(str(b.get("prompt") or ""), str(b.get("title") or ""), str(b.get("agentId") or RESEARCH_AGENT))
    except (ValueError, KeyError) as e:
        raise _err(e)
    return overview()


@router.post("/{jid}/cancel")
async def api_cancel(jid: str):
    try:
        cancel(jid)
    except (ValueError, KeyError) as e:
        raise _err(e)
    return overview()


@router.post("/{jid}/retry")
async def api_retry(jid: str):
    try:
        requeue(jid)
    except (ValueError, KeyError) as e:
        raise _err(e)
    return overview()


@router.delete("/{jid}")
def api_delete(jid: str):
    try:
        delete(jid)
    except (ValueError, KeyError) as e:
        raise _err(e)
    return overview()


@router.post("-clear")
def api_clear():
    clear_finished()
    return overview()


@router.post("-redrafts")
def api_sync():
    sync_redrafts()
    return overview()
