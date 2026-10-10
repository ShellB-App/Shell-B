"""Project to-dos: a list of tasks you preload into a chat Project, which an agent then works through on its own.

Each item has a title, optional details (the full instruction), the agent that should do it and a priority (high,
normal or low). The list is kept in priority order, and within a priority in the order you arrange it; that is also
the order it runs in. Start the list and the worker takes the first pending item, opens a fresh chat in the project titled after it, and runs the agent with
nobody watching. The agent ends by calling project_todos(action=finish) with done, blocked or failed and a short
summary; that summary (and the chat) is what later items see, so item 3 knows what items 1 and 2 produced. If the
agent doesn't report, a turn that completed counts as done.

A blocked or failed item stops the list so later items don't build on a bad result; fix it, then start again.
Like scheduled tasks, one to-do runs at a time: this is one GPU box.
"""
import asyncio
import time
from collections import deque

from fastapi import APIRouter, HTTPException, Request

import activity
import db
from tools import TOOLS, ToolResult, _fn

router = APIRouter()
STATUSES = ("pending", "running", "done", "blocked", "failed", "skipped")
OPEN = ("pending",)
PRIORITIES = ("high", "normal", "low")   # stored as 0, 1, 2 so SQL can sort on it
MAX_ITEMS = 200
SUMMARY_LIMIT = 1200
RUN_NOTE = """## To-do run
This turn was started from the to-do list of the project "{project}", not by a person typing. Nobody is watching it
live: don't ask questions or wait for confirmation; make reasonable assumptions and do the whole job.

Your item is #{n}: "{title}".
Save anything later items or the user will need where they can find it: an artifact, or project_save_file for notes
and documents. When you're finished, call project_todos with action=finish, a status (done; blocked if you need
something from the user, saying exactly what; failed if it can't be done) and a summary of what you did and where the
results are. That summary is what the next items and the user see first.

### The project's to-do list
{outline}"""

# set by app.py: async (item, project, message, note, on_conv) -> (conv_id, status, error, final_text)
runner = None
# set by app.py: abort(conv_id) -> bool
abort_turn = None

_wake_event: asyncio.Event | None = None
_manual: deque = deque()         # item ids the user asked to run once, ahead of the lists
_running: dict | None = None     # {"item": id, "group": id, "conv": id | None, "since": ms}
_reports: dict[str, tuple[str, str]] = {}   # item id -> (status, summary) from project_todos(action=finish)
_TASKS: set = set()


def init():
    with db.conn() as c:
        c.executescript("""
CREATE TABLE IF NOT EXISTS project_todos(
  id TEXT PRIMARY KEY, group_id TEXT, ord REAL, title TEXT, details TEXT DEFAULT '', agent_id TEXT,
  status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, conv_id TEXT, result TEXT DEFAULT '', error TEXT,
  created_by TEXT, created REAL, updated REAL, started REAL, finished REAL);
CREATE INDEX IF NOT EXISTS project_todos_group ON project_todos(group_id, ord);
CREATE TABLE IF NOT EXISTS project_todo_lists(group_id TEXT PRIMARY KEY, active INTEGER DEFAULT 0, note TEXT DEFAULT '',
  started REAL, updated REAL);
""")
        if "priority" not in {r["name"] for r in c.execute("PRAGMA table_info(project_todos)")}:
            c.execute("ALTER TABLE project_todos ADD COLUMN priority INTEGER DEFAULT 1")
        # an item in flight when the server stopped goes back in the queue; its list carries on where it was
        c.execute("UPDATE project_todos SET status='pending', error='Interrupted by a server restart; it will run again.', "
                  "updated=? WHERE status='running'", (time.time(),))


# ── storage ─────────────────────────────────────────────────────────────────

def _item(r, n=None):
    t = {"id": r["id"], "groupId": r["group_id"], "title": r["title"], "details": r["details"] or "",
         "agentId": r["agent_id"], "priority": PRIORITIES[r["priority"] if r["priority"] in (0, 1, 2) else 1],
         "status": r["status"], "attempts": r["attempts"], "convId": r["conv_id"],
         "result": r["result"] or "", "error": r["error"] or "", "createdBy": r["created_by"] or "user",
         "createdAt": r["created"] * 1000, "updatedAt": r["updated"] * 1000,
         "startedAt": r["started"] * 1000 if r["started"] else None,
         "finishedAt": r["finished"] * 1000 if r["finished"] else None}
    if n is not None:
        t["n"] = n
    t["queued"] = t["id"] in _manual
    return t


def items(gid) -> list[dict]:
    with db.conn() as c:
        rows = c.execute("SELECT * FROM project_todos WHERE group_id=? ORDER BY priority, ord, created", (gid,)).fetchall()
    return [_item(r, i + 1) for i, r in enumerate(rows)]


def get_item(tid) -> dict | None:
    with db.conn() as c:
        r = c.execute("SELECT * FROM project_todos WHERE id=?", (tid,)).fetchone()
    if not r:
        return None
    return next((t for t in items(r["group_id"]) if t["id"] == tid), None)


def list_state(gid) -> dict:
    with db.conn() as c:
        r = c.execute("SELECT * FROM project_todo_lists WHERE group_id=?", (gid,)).fetchone()
    return {"active": bool(r and r["active"]), "note": (r["note"] if r else "") or ""}


def _set_list(gid, active: bool, note=""):
    now = time.time()
    with db.conn() as c:
        c.execute("INSERT INTO project_todo_lists(group_id, active, note, started, updated) VALUES(?,?,?,?,?) "
                  "ON CONFLICT(group_id) DO UPDATE SET active=excluded.active, note=excluded.note, updated=excluded.updated, "
                  "started=CASE WHEN excluded.active=1 AND project_todo_lists.active=0 THEN excluded.started "
                  "ELSE project_todo_lists.started END",
                  (gid, int(active), note, now, now))


def detail(gid) -> dict:
    out = {"items": items(gid), **list_state(gid)}
    out["live"] = dict(_running) if _running and _running["group"] == gid else None
    return out


def _priority(value) -> int:
    v = str(value or "normal").strip().lower()
    v = {"urgent": "high", "p1": "high", "1": "high", "medium": "normal", "p2": "normal", "2": "normal",
         "p3": "low", "3": "low"}.get(v, v)
    if v not in PRIORITIES:
        raise ValueError("priority must be high, normal or low")
    return PRIORITIES.index(v)


def _agent_ok(aid):
    from roster import get_agents
    return any(a["id"] == aid for a in get_agents())


def add(gid, entries: list[dict], created_by="user", after: str | None = None) -> list[dict]:
    """Add items to the end of the list (or after item `after`)."""
    entries = [e for e in entries if str(e.get("title") or "").strip()]
    if not entries:
        raise ValueError("a to-do needs a title")
    cur = items(gid)
    if len(cur) + len(entries) > MAX_ITEMS:
        raise ValueError(f"a project can hold at most {MAX_ITEMS} to-dos")
    if after:
        idx = next((i for i, t in enumerate(cur) if t["id"] == after or str(t["n"]) == str(after)), None)
        if idx is None:
            raise ValueError(f"no to-do '{after}'")
        lo = _ord(cur[idx]["id"])
        hi = _ord(cur[idx + 1]["id"]) if idx + 1 < len(cur) else lo + len(entries) + 1
    else:
        lo = max((_ord(t["id"]) for t in cur), default=0)
        hi = lo + len(entries) + 1
    step = (hi - lo) / (len(entries) + 1)
    now, ids = time.time(), []
    with db.conn() as c:
        for i, e in enumerate(entries):
            aid = str(e.get("agentId") or e.get("agent") or "shellb")
            if not _agent_ok(aid):
                raise ValueError(f"no agent '{aid}'")
            tid = db.new_id("todo")
            c.execute("INSERT INTO project_todos(id, group_id, ord, title, details, agent_id, priority, status, created_by, "
                      "created, updated) VALUES(?,?,?,?,?,?,?,'pending',?,?,?)",
                      (tid, gid, lo + step * (i + 1), str(e["title"]).strip()[:200], str(e.get("details") or "").strip(),
                       aid, _priority(e.get("priority")), created_by, now, now))
            ids.append(tid)
    _wake()
    return [t for t in items(gid) if t["id"] in ids]


def _ord(tid) -> float:
    with db.conn() as c:
        return c.execute("SELECT ord FROM project_todos WHERE id=?", (tid,)).fetchone()["ord"]


def update(tid, patch: dict) -> dict:
    t = get_item(tid)
    if not t:
        raise KeyError(tid)
    sets, vals = [], []
    if "title" in patch:
        title = str(patch["title"] or "").strip()
        if not title:
            raise ValueError("a to-do needs a title")
        sets.append("title=?"); vals.append(title[:200])
    if "details" in patch:
        sets.append("details=?"); vals.append(str(patch["details"] or "").strip())
    if patch.get("agentId"):
        if not _agent_ok(patch["agentId"]):
            raise ValueError(f"no agent '{patch['agentId']}'")
        sets.append("agent_id=?"); vals.append(patch["agentId"])
    if patch.get("priority") and _priority(patch["priority"]) != PRIORITIES.index(t["priority"]):
        # a re-prioritised item joins the end of its new priority group, like a new one
        sets += ["priority=?", "ord=?"]
        vals += [_priority(patch["priority"]), max((_ord(x["id"]) for x in items(t["groupId"])), default=0) + 1]
    if "result" in patch:
        sets.append("result=?"); vals.append(str(patch["result"] or "")[:SUMMARY_LIMIT * 2])
    if patch.get("status"):
        st = patch["status"]
        if st not in STATUSES or st == "running":
            raise ValueError(f"status must be one of {', '.join(s for s in STATUSES if s != 'running')}")
        if t["status"] == "running":
            raise ValueError("that to-do is running; stop the list first")
        sets.append("status=?"); vals.append(st)
        if st == "pending":   # re-open: clear the old outcome, keep the chat link for reference
            sets.append("error=?"); vals.append("")
        if st in ("done", "skipped") and t["status"] != st:
            sets.append("finished=?"); vals.append(time.time())
    if sets:
        with db.conn() as c:
            c.execute(f"UPDATE project_todos SET {', '.join(sets)}, updated=? WHERE id=?", (*vals, time.time(), tid))
    _wake()
    return get_item(tid)


def delete(tid):
    t = get_item(tid)
    if t and t["status"] == "running":
        raise ValueError("that to-do is running; stop the list first")
    if tid in _manual:
        _manual.remove(tid)
    with db.conn() as c:
        c.execute("DELETE FROM project_todos WHERE id=?", (tid,))


def delete_group(gid):
    with db.conn() as c:
        c.execute("DELETE FROM project_todos WHERE group_id=?", (gid,))
        c.execute("DELETE FROM project_todo_lists WHERE group_id=?", (gid,))


def reorder(gid, ids: list[str]):
    cur = {t["id"] for t in items(gid)}
    rest = [t["id"] for t in items(gid) if t["id"] not in ids]
    with db.conn() as c:
        for i, tid in enumerate([x for x in ids if x in cur] + rest):
            c.execute("UPDATE project_todos SET ord=? WHERE id=?", (float(i + 1), tid))
    return items(gid)


def clear_finished(gid):
    with db.conn() as c:
        c.execute("DELETE FROM project_todos WHERE group_id=? AND status IN ('done','skipped')", (gid,))


# ── running ─────────────────────────────────────────────────────────────────

def _wake():
    if _wake_event:
        _wake_event.set()


def start_list(gid):
    if not any(t["status"] in OPEN for t in items(gid)):
        raise ValueError("nothing left to do: add a to-do or re-open one first")
    _set_list(gid, True)
    _wake()


def stop_list(gid, note="Stopped by you."):
    _set_list(gid, False, note)
    for tid in [x for x in _manual if (get_item(x) or {}).get("groupId") == gid]:
        _manual.remove(tid)
    if _running and _running["group"] == gid and _running.get("conv") and abort_turn:
        abort_turn(_running["conv"])


def run_one(tid):
    t = get_item(tid)
    if not t:
        raise KeyError(tid)
    if t["status"] == "running" or tid in _manual:
        return False
    if t["status"] != "pending":
        update(tid, {"status": "pending"})
    _manual.append(tid)
    _wake()
    return True


def _next():
    while _manual:
        t = get_item(_manual.popleft())
        if t and t["status"] == "pending":
            return t, False
    with db.conn() as c:
        r = c.execute("SELECT t.id FROM project_todos t JOIN project_todo_lists l ON l.group_id=t.group_id "
                      "JOIN groups g ON g.id=t.group_id WHERE l.active=1 AND t.status='pending' "
                      "ORDER BY l.started, t.priority, t.ord, t.created LIMIT 1").fetchone()
        if not r:   # lists with nothing left: switch them off
            for g in c.execute("SELECT group_id FROM project_todo_lists l WHERE active=1 AND NOT EXISTS("
                               "SELECT 1 FROM project_todos t WHERE t.group_id=l.group_id AND t.status='pending')").fetchall():
                c.execute("UPDATE project_todo_lists SET active=0, note='All done.', updated=? WHERE group_id=?",
                          (time.time(), g["group_id"]))
    return (get_item(r["id"]), True) if r else (None, False)


def outline(gid, mark=None) -> str:
    lines = []
    for t in items(gid):
        icon = {"done": "[x]", "skipped": "[-]", "running": "[>]", "blocked": "[!]", "failed": "[!]"}.get(t["status"], "[ ]")
        line = (f"{icon} #{t['n']} " + ("" if t["priority"] == "normal" else f"[{t['priority']} priority] ")
                + f"{t['title']} ({t['status']}") + (f", chat `{t['convId']}`" if t["convId"] else "") + ")"
        if t["id"] == mark:
            line += "  ← you are here"
        lines.append(line)
        if t["id"] != mark and t["status"] in ("done", "blocked", "failed") and t["result"]:
            lines.append("    " + t["result"][:500].replace("\n", "\n    "))
    return "\n".join(lines) or "(empty)"


def _message(t) -> str:
    body = t["details"].strip() or t["title"]
    if t["details"].strip() and t["title"].lower() not in body.lower()[:200]:
        body = f"# {t['title']}\n\n{body}"
    if t["attempts"] > 0 and (t["result"] or t["error"]):
        body += ("\n\n---\nThis item ran before and did not finish. Last time: "
                 + (t["result"] or t["error"])[:800] + "\nPick up from there.")
    return body


async def _run(t, from_list):
    global _running
    import groups
    g = groups.get(t["groupId"])
    if not g:
        return
    now = time.time()
    with db.conn() as c:
        c.execute("UPDATE project_todos SET status='running', attempts=attempts+1, started=?, finished=NULL, error='', "
                  "updated=? WHERE id=?", (now, now, t["id"]))
    _running = {"item": t["id"], "group": t["groupId"], "conv": None, "since": now * 1000}
    _reports.pop(t["id"], None)

    def on_conv(cid):
        _running["conv"] = cid
        with db.conn() as c:
            c.execute("UPDATE project_todos SET conv_id=? WHERE id=?", (cid, t["id"]))

    note = RUN_NOTE.format(project=g["name"], n=t["n"], title=t["title"], outline=outline(t["groupId"], mark=t["id"]))
    conv_id, status, error, text = None, "error", None, ""
    try:
        conv_id, status, error, text = await runner(t, g, _message(t), note, on_conv)
    except Exception as e:
        error = f"{type(e).__name__}: {e}"
    finally:
        _running = None
    stopped = status == "stopped"
    if t["id"] in _reports:
        outcome, summary = _reports.pop(t["id"])
    elif stopped:
        outcome, summary = "pending", ""
    elif status == "complete":
        outcome, summary = "done", (text or "").strip()[-SUMMARY_LIMIT:]
    else:
        outcome, summary = "failed", ""
    with db.conn() as c:
        c.execute("UPDATE project_todos SET status=?, result=CASE WHEN ?<>'' THEN ? ELSE result END, error=?, finished=?, "
                  "updated=? WHERE id=?",
                  (outcome, summary, summary[:SUMMARY_LIMIT * 2], error or ("Stopped." if stopped else ""),
                   time.time() if outcome != "pending" else None, time.time(), t["id"]))
    groups.touch(t["groupId"])
    if outcome != "pending":
        activity.post("todo", outcome, f"To-do in {g['name']}: {t['title']}", error or activity.excerpt(summary),
                      f"#/c/{conv_id}" if conv_id else f"#/p/{t['groupId']}")
    if from_list and outcome in ("blocked", "failed"):
        _set_list(t["groupId"], False, f"Stopped at #{t['n']} \"{t['title']}\", which {outcome}"
                  + (" and needs you" if outcome == "blocked" else "") + ". Fix it, then start again.")


async def _worker():
    global _wake_event
    _wake_event = asyncio.Event()
    while True:
        try:
            t, from_list = _next()
            if t:
                await _run(t, from_list)
                continue
        except Exception as e:   # keep the worker alive whatever one item does
            print(f"[todos] run failed: {type(e).__name__}: {e}")
            await asyncio.sleep(5)
        _wake_event.clear()
        try:
            await asyncio.wait_for(_wake_event.wait(), 30)
        except asyncio.TimeoutError:
            pass


def start():
    t = asyncio.create_task(_worker())
    _TASKS.add(t)


def stop():
    for t in list(_TASKS):
        t.cancel()
    _TASKS.clear()


def running_now():
    return dict(_running) if _running else None


def brief(gid, conv_id=None) -> str:
    """The to-do list for a project chat's system prompt."""
    ts = items(gid)
    if not ts or (_running and _running.get("conv") == conv_id):
        return ""   # a to-do run gets the full list in its own note
    st = list_state(gid)
    open_n = sum(t["status"] == "pending" for t in ts)
    head = (f"### Project to-do list ({open_n} open of {len(ts)}; "
            + ("working through it on its own now" if st["active"] else "not running") + ")")
    return (head + "\nThe user preloads tasks here for agents to run unattended. Add, change or start them with project_todos "
            "when the user asks.\n" + outline(gid))


# ── agent tool ──────────────────────────────────────────────────────────────

async def project_todos(args, ctx):
    import groups
    gid = groups.group_of(ctx.conv_id)
    if not gid:
        return ToolResult("This chat is not in a project.", error=True)
    action = (args.get("action") or "list").lower()
    disp = lambda: {"todos": {"groupId": gid, "open": sum(t["status"] == "pending" for t in items(gid))}}
    try:
        if action == "list":
            st = list_state(gid)
            return ToolResult(outline(gid) + f"\n\nList is {'running' if st['active'] else 'stopped'}."
                              + (f" {st['note']}" if st["note"] else ""))
        if action == "finish":
            mine = _running and _running.get("conv") == ctx.conv_id
            if not mine:
                return ToolResult("finish is only for a to-do run; this chat isn't running one.", error=True)
            outcome = (args.get("status") or "done").lower()
            if outcome not in ("done", "blocked", "failed"):
                return ToolResult("status must be done, blocked or failed", error=True)
            summary = str(args.get("summary") or "").strip()
            if not summary:
                return ToolResult("Give a summary: what you did and where the results are.", error=True)
            _reports[_running["item"]] = (outcome, summary[:SUMMARY_LIMIT * 2])
            return ToolResult(f"Recorded as {outcome}. Finish your reply now; the next item starts after this turn.")
        if action == "add":
            entries = args.get("items") or [{"title": args.get("title"), "details": args.get("details"), "agent": args.get("agent"),
                                              "priority": args.get("priority")}]
            for e in entries:
                e["agentId"] = e.get("agent") or e.get("agentId") or ctx.agent.get("id")
            added = add(gid, entries, created_by=f"agent:{ctx.agent.get('id')}", after=args.get("after"))
            return ToolResult(f"Added {len(added)} to-do(s): " + ", ".join(f"#{t['n']} {t['title']}" for t in added)
                              + ". The user sees them on the project page.", display=disp())
        tid = _resolve(gid, args.get("id"))
        if action == "update":
            patch = {k: args[k] for k in ("title", "details", "status", "priority") if args.get(k)}
            if args.get("agent"):
                patch["agentId"] = args["agent"]
            t = update(tid, patch)
            return ToolResult(f"Updated #{t['n']} {t['title']} ({t['status']}).", display=disp())
        if action == "delete":
            delete(tid)
            return ToolResult("Deleted.", display=disp())
        if action == "run":
            if tid:
                run_one(tid)
                return ToolResult("Queued that to-do; it runs in its own chat in this project.", display=disp())
            start_list(gid)
            return ToolResult("Started the to-do list. Items run one at a time, each in its own chat in this project; the "
                              "user can watch or stop it from the project page.", display=disp())
        return ToolResult("action must be list, add, update, delete, run or finish", error=True)
    except (ValueError, KeyError) as e:
        return ToolResult(f"Couldn't do that: {e}", error=True)


def _resolve(gid, key):
    if not key:
        return None
    key = str(key).lstrip("#")
    t = next((t for t in items(gid) if t["id"] == key or str(t["n"]) == key), None)
    if not t:
        raise KeyError(f"no to-do '{key}' (use action=list)")
    return t["id"]


def register():
    TOOLS["project_todos"] = {
        "fn": project_todos, "service": None, "scope": "group", "auto": "in chats inside a chat Project",
        "ui": {"displayName": "Project To-dos", "icon": "ListChecks", "category": "project",
               "description": "Reads and edits the project's to-do list and starts it running. Added in project chats."},
        "schema": _fn("project_todos",
                      "The project's to-do list: tasks the user preloads for agents to run on their own, one at a time, each "
                      "in a new chat in this project. list shows it; add appends items (write each as a complete, "
                      "self-contained instruction, since it runs with nobody watching); update changes one (status pending "
                      "re-opens it); delete removes one; run starts the whole list, or one item when you give id. In a "
                      "to-do run, finish reports your item's outcome. Items run high priority first, then normal, then low.",
                      {"action": {"type": "string", "enum": ["list", "add", "update", "delete", "run", "finish"]},
                       "id": {"type": "string", "description": "Item id or its number, e.g. 3"},
                       "title": {"type": "string"},
                       "details": {"type": "string", "description": "The full instruction the agent gets"},
                       "priority": {"type": "string", "enum": list(PRIORITIES),
                                    "description": "high runs before normal (the default), normal before low"},
                       "agent": {"type": "string", "description": "Agent id to do it (default: you)"},
                       "items": {"type": "array", "description": "For add: several items at once",
                                 "items": {"type": "object", "properties": {"title": {"type": "string"},
                                           "details": {"type": "string"}, "agent": {"type": "string"},
                                           "priority": {"type": "string", "enum": list(PRIORITIES)}}, "required": ["title"]}},
                       "after": {"type": "string", "description": "For add: insert after this item instead of at the end"},
                       "status": {"type": "string", "description": "update: pending|done|skipped|blocked|failed. finish: done|blocked|failed"},
                       "summary": {"type": "string", "description": "For finish: what you did and where the results are"}},
                      ["action"]),
    }


# ── API ─────────────────────────────────────────────────────────────────────

def _need(gid):
    import groups
    if not groups.get(gid):
        raise HTTPException(404, "No such project")


def _err(e):
    return HTTPException(404, "No such to-do") if isinstance(e, KeyError) else HTTPException(400, str(e))


@router.get("/api/chat-projects/{gid}/todos")
def api_list(gid: str):
    _need(gid)
    return detail(gid)


@router.post("/api/chat-projects/{gid}/todos")
async def api_add(gid: str, req: Request):
    _need(gid)
    body = await req.json()
    try:
        add(gid, body.get("items") or [body], after=body.get("after"))
    except (ValueError, KeyError) as e:
        raise _err(e)
    return detail(gid)


@router.patch("/api/chat-projects/{gid}/todos/{tid}")
async def api_patch(gid: str, tid: str, req: Request):
    _need(gid)
    try:
        update(tid, await req.json())
    except (ValueError, KeyError) as e:
        raise _err(e)
    return detail(gid)


@router.delete("/api/chat-projects/{gid}/todos/{tid}")
def api_delete(gid: str, tid: str):
    _need(gid)
    try:
        delete(tid)
    except ValueError as e:
        raise _err(e)
    return detail(gid)


@router.post("/api/chat-projects/{gid}/todos-order")
async def api_reorder(gid: str, req: Request):
    _need(gid)
    reorder(gid, (await req.json()).get("ids") or [])
    return detail(gid)


@router.post("/api/chat-projects/{gid}/todos-clear")
def api_clear(gid: str):
    _need(gid)
    clear_finished(gid)
    return detail(gid)


@router.post("/api/chat-projects/{gid}/todos/{tid}/run")
async def api_run_one(gid: str, tid: str):  # async: _wake() sets an asyncio.Event
    _need(gid)
    try:
        run_one(tid)
    except (ValueError, KeyError) as e:
        raise _err(e)
    return detail(gid)


@router.post("/api/chat-projects/{gid}/todos-start")
async def api_start(gid: str):  # async: _wake() sets an asyncio.Event
    _need(gid)
    try:
        start_list(gid)
    except ValueError as e:
        raise _err(e)
    return detail(gid)


@router.post("/api/chat-projects/{gid}/todos-stop")
def api_stop(gid: str):
    _need(gid)
    stop_list(gid)
    return detail(gid)
