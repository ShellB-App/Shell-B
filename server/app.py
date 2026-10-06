"""Shell:B Web — FastAPI backend serving the UI and the agent API."""
import asyncio
import json
import os
import re
import shutil
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

import db
import auth
import mcp_hub
import mcp_router
import projects
import providers
import cli_agents
import verify
import skills
import skills_router
import groups
import schedules
import research
import notebook
import activity
import megaplan
import todos
import favorites
import codex
import codex_secrets
import media
import modelhub
import appstate
import studio_tools
import studio_assets
import devserver
import doc_tools
import maps
import flights
import weather
import routing
import sky
import planetary
import datasets
import wiki
import legal
import library
import scrape
import assets as asset_libs
import remote
import offline
import selfmod
import ask
import composer
import planmode
import sysinfo
import network
import memory
import episodes
import feedback
import reflection
import gibberlink
import secretary
import backup
import speech
from agent import Sink, Turn, build_system, history_messages, make_title, model_info, recall, user_payload
from defaults import DEFAULT_AGENTS, DEFAULT_SETTINGS
from tools import COMFY, FILES, OLLAMA, ORPHEUS, SANDBOX_IMAGE, SEARXNG, TOOLS, WORKSPACES

HERMES = "http://localhost:8001"
UI_DIST = Path(__file__).resolve().parent.parent / "ui" / "dist"
VERSION = "1.0.0"

app = FastAPI(title="Shell:B Web", version=VERSION)
app.add_middleware(auth.AuthMiddleware)

# Optional HTTPS redirect for Tailscale serve / reverse proxy. Set SHELLB_SECURE_URL to enable short-host redirects.
SECURE_URL = os.environ.get("SHELLB_SECURE_URL", "")
_SHORT_HOST = SECURE_URL.split("//")[1].split(".")[0].lower() if "//" in SECURE_URL else ""


class _ShortNameRedirect:
    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if _SHORT_HOST and scope["type"] == "http" and scope["method"] == "GET" and not scope["path"].startswith("/api/"):
            host = dict(scope["headers"]).get(b"host", b"").decode("latin-1").split(":")[0].lower()
            if host == _SHORT_HOST:
                qs = scope.get("query_string", b"").decode("latin-1")
                return await Response(status_code=307, headers={"location": SECURE_URL + scope["path"] + (f"?{qs}" if qs else "")})(scope, receive, send)
        await self.inner(scope, receive, send)


app.add_middleware(_ShortNameRedirect)
db.init()
activity.init()
auth.init()
studio_tools.register()
studio_assets.register()
devserver.register()
library.register()
flights.register()
weather.register()
routing.register()
planetary.register()
ask.register()
scrape.register()
skills.register()
groups.register()
doc_tools.register()
schedules.init()
schedules.register()
research.init()
notebook.init()
research.register()
megaplan.init()
megaplan.register()
todos.init()
todos.register()
asset_libs.init()
asset_libs.register()
selfmod.init()
selfmod.register()
codex.init()
media.init()
memory.init()
episodes.init()
feedback.init()
cli_agents.cleanup()
verify.register()
verify.init()
codex.register()
app.include_router(selfmod.router)
app.include_router(composer.router)
app.include_router(sysinfo.router)
app.include_router(network.router)
app.include_router(asset_libs.router)
app.include_router(groups.router)
app.include_router(schedules.router)
app.include_router(research.router)
app.include_router(notebook.router)
app.include_router(megaplan.router)
app.include_router(todos.router)
favorites.init()
app.include_router(favorites.router)
app.include_router(activity.router)
app.include_router(codex_secrets.router)
app.include_router(codex.router)
app.include_router(media.router)
app.include_router(reflection.router)  # before memory.router, whose /{mid}/{action} would match /reflection/run
app.include_router(memory.router)
app.include_router(episodes.router)
app.include_router(feedback.router)
app.include_router(modelhub.router)
app.include_router(devserver.router)
app.include_router(projects.router)
app.include_router(remote.router)
app.include_router(ask.router)
app.include_router(appstate.router)
app.include_router(auth.router)
app.include_router(gibberlink.router)
app.include_router(maps.router)
app.include_router(flights.router)
app.include_router(weather.router)
app.include_router(routing.router)
app.include_router(sky.router)
app.include_router(planetary.router)
datasets.init()
wiki.register()
legal.register()
secretary.init()
backup.init()
app.include_router(datasets.router)
app.include_router(wiki.router)
app.include_router(legal.router)
app.include_router(secretary.router)
app.include_router(backup.router)
app.include_router(mcp_router.router)
app.include_router(skills_router.router)
app.include_router(speech.router)



@app.on_event("startup")
async def _start_mcp():
    schedules.runner = _run_scheduled
    schedules.start()
    notebook.start()
    megaplan.run_turn, megaplan.abort_turn = _run_plan_turn, _abort_turn
    megaplan.find_agent, megaplan.get_settings = find_agent, get_settings
    megaplan.start()
    todos.runner, todos.abort_turn = _run_todo, _abort_turn
    todos.start()
    asset_libs.runner, asset_libs.abort_turn = _run_asset_job, _abort_turn
    asset_libs.start()
    codex.start()
    episodes.busy = lambda: bool(ACTIVE)
    episodes.start()
    reflection.busy = lambda: bool(ACTIVE)
    reflection.start()
    datasets.start()
    backup.start_scheduler()
    await devserver.serve_proxy()
    await mcp_hub.sync()


@app.on_event("shutdown")
async def _shutdown():
    for conv_id, live in list(ACTIVE.items()):
        _signal_abort(live)
    await devserver.stop_proxy()
    await mcp_hub.shutdown()
    schedules.stop()
    megaplan.stop()
    todos.stop()
    episodes.stop()
    reflection.stop()
    datasets.stop()
    backup.stop_scheduler()
    for t in list(_TASKS):
        if not t.done():
            t.cancel()
    _TASKS.clear()


# ── admin key ───────────────────────────────────────────────────────────────
# Anything that can launch a process on this machine or store a cloud API key needs the owner's login
# (server/auth.py) or the admin key from data/admin.key (`cat ~/shellb/web/data/admin.key`). Localhost alone is not enough.

ADMIN_KEY_FILE = db.DATA / "admin.key"
if not ADMIN_KEY_FILE.exists():
    import secrets
    ADMIN_KEY_FILE.write_text(secrets.token_urlsafe(18) + "\n")
    ADMIN_KEY_FILE.chmod(0o600)


is_admin = auth.is_admin
require_admin = auth.require_admin


@app.get("/api/admin/check")
def admin_check(req: Request):
    return {"ok": is_admin(req)}


# conv_id -> {"abort": Event, "loop": its event loop, "message": partial assistant message}
ACTIVE: dict[str, dict] = {}


def _signal_abort(live):
    """Set a turn's abort Event from any thread. Sync endpoints run in a worker thread, and Event.set() there
    doesn't wake the loop, so a turn blocked in abort.wait() (a silent Ollama stream, an approval) never notices."""
    try:
        same = asyncio.get_running_loop() is live["loop"]
    except RuntimeError:
        same = False
    if same:
        live["abort"].set()
    else:
        live["loop"].call_soon_threadsafe(live["abort"].set)
_TASKS: set = set()  # strong refs so running turns are not garbage-collected


from roster import find_agent, get_agents, get_settings



# ── conversations ───────────────────────────────────────────────────────────

@app.get("/api/conversations")
def conversations():
    out = db.list_conversations()
    for c in out:
        c["streaming"] = c["id"] in ACTIVE
    return out


@app.post("/api/conversations")
async def new_conversation(req: Request):
    body = await req.json() if (await req.body()) else {}
    gid = body.get("groupId") if body.get("groupId") and groups.get(body["groupId"]) else None
    if gid:
        groups.touch(gid)
    return db.create_conversation(body.get("agentId") or get_settings()["defaultAgent"], group_id=gid)


@app.get("/api/conversations/{conv_id}")
def conversation(conv_id: str):
    conv = db.get_conversation(conv_id)
    if not conv:
        raise HTTPException(404, "No such conversation")
    msgs = db.list_messages(conv_id)
    live = ACTIVE.get(conv_id)
    if live:
        msgs.append(live["message"])
    return {**conv, "messages": msgs, "artifacts": db.list_artifacts(conv_id), "streaming": bool(live),
            "researchBoard": research.board_brief(conv_id), "megaPlan": megaplan.plan_brief(conv_id)}


@app.get("/api/library")
def library():
    """Everything Shell:B has built: chat artifacts (latest versions) and Studio/Code projects that open in a browser."""
    apps = []
    for p in db.list_projects():
        entry = p["entry"] if p["kind"] != "code" else next(
            (e for e in ("index.html", "public/index.html", "dist/index.html") if (projects.PROJECTS / p["id"] / e).is_file()), None)
        if entry and (projects.PROJECTS / p["id"] / entry).is_file():
            apps.append({**projects.project_summary(p), "entry": entry})
    return {"artifacts": db.all_artifacts(), "apps": apps}


@app.patch("/api/conversations/{conv_id}")
async def patch_conversation(conv_id: str, req: Request):
    body = await req.json()
    extra = {}
    if "groupId" in body:
        if body["groupId"] and not groups.get(body["groupId"]):
            raise HTTPException(404, "No such project")
        extra["groupId"] = body["groupId"]
    return db.update_conversation(conv_id, title=body.get("title"), agentId=body.get("agentId"), pinned=body.get("pinned"), **extra)


@app.delete("/api/conversations/{conv_id}")
def delete_conversation(conv_id: str):
    if conv_id in ACTIVE:
        _signal_abort(ACTIVE[conv_id])
    db.delete_conversation(conv_id)
    research.unlink(conv_id)
    with db.conn() as c:
        c.execute("DELETE FROM mega_links WHERE conv_id=?", (conv_id,))
    return {"ok": True}


@app.post("/api/conversations/{conv_id}/stop")
def stop(conv_id: str):
    if conv_id in ACTIVE:
        _signal_abort(ACTIVE[conv_id])
    return {"ok": True}


async def generate_compaction_summary(conv_title: str, msgs: list[dict], settings: dict) -> str:
    """Generate a structured Markdown summary of older messages using the utility model (or fallback)."""
    transcript_lines = []
    for m in msgs:
        role = "User" if m.get("role") == "user" else "Assistant"
        content = (m.get("content") or "").strip()
        if m.get("role") == "compacted":
            transcript_lines.append(f"[Previous Compacted Context: {content[:400]}]")
        elif content:
            snippet = content if len(content) <= 600 else (content[:400] + " ... " + content[-150:])
            transcript_lines.append(f"{role}: {snippet}")
    transcript = "\n\n".join(transcript_lines[:40])

    model = settings.get("utilityModel") or ""
    from agent import OLLAMA, model_info
    import providers
    if model and not providers.is_cloud(model):
        prompt = (
            f"You are compacting earlier turns of a conversation between a user and an AI assistant.\n"
            f"Preserve all vital continuity so the assistant can proceed without losing context:\n"
            f"1. User goals, requirements, preferences, and project background.\n"
            f"2. Decisions made, code/solutions developed, conclusions reached.\n"
            f"3. Specific files created or modified (/work/...), tools run, and artifacts produced.\n"
            f"4. Current status, pending questions, or unresolved tasks.\n\n"
            f"Write a concise, high-density Markdown summary with bullet points. No preamble or filler.\n\n"
            f"Conversation Title: {conv_title}\n\n"
            f"Transcript to compact:\n{transcript}"
        )
        try:
            payload = {
                "model": model, "stream": False, "keep_alive": "2h",
                "options": {"temperature": 0.2, "num_predict": 450},
                "messages": [{"role": "user", "content": prompt}]
            }
            if "thinking" in (await model_info(model))["capabilities"]:
                payload["think"] = False
            async with httpx.AsyncClient(timeout=45) as client:
                r = await client.post(f"{OLLAMA}/api/chat", json=payload)
                if r.status_code == 200:
                    summary = (r.json()["message"]["content"] or "").strip()
                    if summary:
                        return summary
        except Exception as e:
            print(f"Utility model compaction failed, using extractive fallback: {e}")

    # Extractive fallback
    topics = []
    actions = []
    files_mentioned = set()
    for m in msgs:
        text = m.get("content") or ""
        for f in re.findall(r"(/work/[\w\d_./-]+|\b[\w\d_-]+\.(?:py|ts|tsx|js|html|css|json|md|sh|sql)\b)", text):
            files_mentioned.add(f)
        if m.get("role") == "user":
            first = text.strip().split("\n")[0][:140]
            if first:
                topics.append(first)
        elif m.get("role") == "assistant":
            blocks = m.get("blocks", [])
            for b in blocks:
                if b.get("type") == "tool":
                    actions.append(f"Used `{b.get('name')}`")
            first = text.strip().split("\n")[0][:140]
            if first:
                actions.append(first)

    summary_parts = [f"### Earlier Conversation Summary ({len(msgs)} messages compacted)"]
    if topics:
        summary_parts.append("**User requests & goals:**\n" + "\n".join(f"- {t}" for t in topics[:5]))
    if actions:
        summary_parts.append("**Key actions & outcomes:**\n" + "\n".join(f"- {a}" for a in actions[:6]))
    if files_mentioned:
        summary_parts.append("**Files & artifacts referenced:**\n" + ", ".join(f"`{f}`" for f in sorted(files_mentioned)[:10]))
    return "\n\n".join(summary_parts)


async def compact_conversation_history(conv_id: str, keep_recent: int = 4) -> dict:
    conv = db.get_conversation(conv_id)
    if not conv:
        raise HTTPException(404, "No such conversation")
    msgs = db.list_messages(conv_id)
    if len(msgs) <= keep_recent:
        return {"ok": True, "compacted": False, "message": "Conversation is short; compaction not needed.",
                "totalMessages": len(msgs)}

    to_compact = msgs[:-keep_recent]
    to_keep = msgs[-keep_recent:]

    settings = get_settings()
    summary = await generate_compaction_summary(conv["title"], to_compact, settings)

    archived = []
    for m in to_compact:
        if m.get("compacted") and m.get("compactedMessages"):
            archived.extend(m["compactedMessages"])
        else:
            archived.append(m)

    to_delete_ids = [m["id"] for m in to_compact]
    with db.conn() as c:
        c.executemany("DELETE FROM messages WHERE id=?", [(mid,) for mid in to_delete_ids])

    comp_mid = db.new_id("msg")
    comp_timestamp = (to_keep[0]["timestamp"] / 1000.0 - 0.1) if to_keep and to_keep[0].get("timestamp") else (time.time() - 5)
    comp_data = {
        "compacted": True,
        "compactedCount": len(archived),
        "compactedMessages": archived,
        "timestamp": comp_timestamp * 1000
    }
    with db.conn() as c:
        c.execute("INSERT INTO messages VALUES(?,?,?,?,?,?)",
                  (comp_mid, conv_id, "compacted", summary, json.dumps(comp_data), comp_timestamp))

    db.touch_conversation(conv_id)
    return {
        "ok": True,
        "compacted": True,
        "summary": summary,
        "compactedCount": len(archived),
        "remainingCount": len(to_keep) + 1,
        "checkpointId": comp_mid
    }


@app.post("/api/conversations/{conv_id}/compact")
async def compact_conversation_endpoint(conv_id: str, req: Request):
    body = await req.json() if (await req.body()) else {}
    keep_recent = max(2, min(int(body.get("keepRecent", 4)), 10))
    return await compact_conversation_history(conv_id, keep_recent=keep_recent)


@app.post("/api/conversations/{conv_id}/fork")
async def fork_conversation(conv_id: str, req: Request):
    conv = db.get_conversation(conv_id)
    if not conv:
        raise HTTPException(404, "No such conversation")
    body = await req.json() if (await req.body()) else {}
    target_msg_id = body.get("messageId")
    new_title = body.get("title") or f"{conv['title']} (fork)"

    all_msgs = db.list_messages(conv_id)
    if target_msg_id:
        idx = next((i for i, m in enumerate(all_msgs) if m["id"] == target_msg_id), None)
        if idx is None:
            raise HTTPException(404, "Target message not found in this conversation")
        msgs_to_copy = all_msgs[: idx + 1]
    else:
        msgs_to_copy = all_msgs

    # Create new conversation
    new_conv = db.create_conversation(
        agent_id=conv["agentId"],
        title=new_title,
        project_id=conv.get("projectId"),
        group_id=conv.get("groupId")
    )
    new_cid = new_conv["id"]

    # Duplicate messages and map IDs
    msg_id_map = {}
    with db.conn() as c:
        for m in msgs_to_copy:
            old_mid = m["id"]
            new_mid = db.new_id("msg")
            msg_id_map[old_mid] = new_mid
            m_data = {k: v for k, v in m.items() if k not in ("id", "role", "content", "timestamp")}
            created_ts = (m["timestamp"] / 1000.0) if m.get("timestamp") else time.time()
            c.execute("INSERT INTO messages VALUES(?,?,?,?,?,?)",
                      (new_mid, new_cid, m["role"], m["content"], json.dumps(m_data), created_ts))

    # Duplicate artifacts associated with copied messages
    with db.conn() as c:
        art_rows = c.execute("SELECT * FROM artifacts WHERE conv_id=?", (conv_id,)).fetchall()
        for a in art_rows:
            old_mid = a["message_id"]
            if not old_mid or old_mid in msg_id_map:
                mapped_mid = msg_id_map.get(old_mid, old_mid)
                c.execute("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?)",
                          (new_cid, a["id"], a["version"], a["title"], a["type"], a["language"],
                           a["content"], mapped_mid, a["created"]))

    # Duplicate workspace files if they exist
    old_ws = WORKSPACES / conv_id
    new_ws = WORKSPACES / new_cid
    if old_ws.is_dir():
        try:
            shutil.copytree(old_ws, new_ws, dirs_exist_ok=True)
        except Exception as e:
            print(f"Warning: failed to copy workspace files for forked conv {conv_id} -> {new_cid}: {e}")

    db.touch_conversation(new_cid)
    return db.get_conversation(new_cid)


TEXT_EXT = {".txt", ".md", ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".csv", ".tsv", ".html", ".css", ".xml",
            ".yaml", ".yml", ".toml", ".ini", ".cfg", ".sh", ".sql", ".c", ".h", ".cpp", ".hpp", ".rs", ".go",
            ".java", ".kt", ".swift", ".rb", ".php", ".log", ".env", ".qml", ".cmake", ".bat", ".ps1", ".r", ".m"}
IMG_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp"}


@app.post("/api/conversations/{conv_id}/upload")
async def upload(conv_id: str, file: UploadFile = File(...)):
    if not db.get_conversation(conv_id):
        raise HTTPException(404, "No such conversation")
    ws = WORKSPACES / conv_id
    ws.mkdir(exist_ok=True)
    name = re.sub(r"[^\w.\- ]+", "_", Path(file.filename or "upload").name).strip() or "upload"
    dest = ws / name
    stem, n = dest.stem, 1
    while dest.exists():
        dest = ws / f"{stem}-{n}{dest.suffix}"
        n += 1
    data = await file.read()
    dest.write_bytes(data)
    ext = dest.suffix.lower()
    att = {"id": db.new_id("att"), "name": dest.name, "size": len(data), "type": file.content_type or "",
           "url": f"/api/workspace/{conv_id}/{dest.name}"}
    if ext in IMG_EXT or (file.content_type or "").startswith("image/"):
        att["kind"] = "image"
    elif ext in TEXT_EXT or (file.content_type or "").startswith("text/"):
        att["kind"] = "text"
        try:
            text = data.decode("utf-8")
            if len(text) <= 120_000:
                att["inline"] = text
        except UnicodeDecodeError:
            att["kind"] = "file"
    else:
        att["kind"] = "file"
    if att["kind"] in ("file", "image") and ext in doc_tools.PDF_LIKE | doc_tools.OFFICE_NATIVE:
        # documents arrive with their text layer so the model can read them without a tool call
        try:
            text, pages, scanned = await asyncio.to_thread(doc_tools.quick_text, dest)
        except Exception:
            text, pages, scanned = "", 0, False
        att["kind"], att["document"] = "file", True
        if pages:
            att["pages"] = pages
        if scanned:
            att["scanned"] = True
        elif text.strip():
            att["inline"] = text[:60_000]
            att["truncated"] = len(text) > 60_000
    return att


@app.post("/api/conversations/{conv_id}/chat")
async def chat(conv_id: str, req: Request):
    body = await req.json()
    conv = db.get_conversation(conv_id)
    if not conv:
        raise HTTPException(404, "No such conversation")
    if conv_id in ACTIVE:
        raise HTTPException(409, "This conversation is already generating")
    if any(a.get("kind") == "ref" for a in body.get("attachments") or []):
        body["attachments"] = await composer.resolve_refs(body["attachments"])
    # Auto-compact older messages if conversation is getting too long
    raw_msgs = db.list_messages(conv_id)
    if len(raw_msgs) >= 24 or sum(len(m.get("content", "")) for m in raw_msgs) > 36000:
        try:
            await compact_conversation_history(conv_id, keep_recent=4)
        except Exception as e:
            print(f"Auto-compaction skipped: {e}")
    queue, _ = begin_turn(conv, body)

    async def stream():
        # the turn keeps running (and persists) even if the browser disconnects mid-stream
        while True:
            ev = await queue.get()
            if ev is None:
                break
            yield f"data: {json.dumps(ev)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


VOICE_NOTE = """## Voice conversation
The user is talking to you hands-free: their message was spoken and transcribed, and your reply will be read aloud.
Reply the way you would speak: short (a few sentences unless they ask for more), natural, no Markdown tables,
headings or bullet lists, no URLs read out. Transcription can mishear words; if something sounds off, ask. If the
answer needs code, a long list or a document, put it in an artifact or file and say briefly what you made."""

VOICE_REMINDER = ("\n\n[Spoken aloud by voice: answer in two to four plain spoken sentences, like talking to a friend. "
                  "No lists, headings, bold or tables. Offer to go deeper instead of covering everything.]")


def begin_turn(conv, body, stream=True, note=""):
    """Start an agent turn in the background. Returns (event queue or None, task); the task's result is the final
    assistant message. `note` is appended to the system prompt (scheduled runs say no one is watching)."""
    conv_id = conv["id"]
    if body.get("fromMessageId"):
        db.delete_messages_from(conv_id, body["fromMessageId"])

    settings = get_settings()
    if body.get("maxToolRounds"):  # long unattended turns (Mega Plans) get a bigger tool budget
        settings = {**settings, "maxToolRounds": int(body["maxToolRounds"])}
    project_id = conv.get("projectId")
    agent, agents = find_agent(body.get("agentId") or conv["agentId"])
    pick, own = body.get("model"), providers.split(agent.get("model", ""))
    if pick and pick != agent.get("model") and own and (providers.split(pick) or ("",))[0] == own[0]:
        agent = {**agent, "model": pick}  # the composer's model picker: same provider only, so privacy doesn't change
    effort = body.get("effort") or agent.get("effort", "medium")
    attachments = body.get("attachments") or []
    content = (body.get("content") or "").strip()
    if conv["agentId"] != agent["id"] and not body.get("routeOnly"):  # an @mention borrows the agent for one turn
        db.update_conversation(conv_id, agentId=agent["id"])

    history = db.list_messages(conv_id)
    first_turn = not any(m["role"] == "assistant" for m in history)
    user_msg = {"id": db.new_id("msg"), "role": "user", "content": content, "attachments": attachments,
                "timestamp": time.time() * 1000}
    if body.get("mode") == "plan" and stream:
        user_msg["mode"] = "plan"
    if body.get("voice") and stream:
        user_msg["voice"] = True  # spoken in hands-free voice mode
    db.add_message(conv_id, "user", content, {k: user_msg[k] for k in ("attachments", "mode", "voice") if k in user_msg}, msg_id=user_msg["id"])

    queue: asyncio.Queue | None = asyncio.Queue() if stream else None
    abort = asyncio.Event()
    asst_id = db.new_id("msg")
    live = {"id": asst_id, "role": "assistant", "content": "", "agentId": agent["id"], "model": agent["model"],
            "blocks": [], "status": "streaming", "timestamp": time.time() * 1000}
    plan = body.get("mode") == "plan" and stream  # plan mode needs someone there to approve the plan
    if plan:
        live["mode"] = "plan"
    ACTIVE[conv_id] = {"abort": abort, "loop": asyncio.get_running_loop(), "message": live}

    async def emit(ev):
        if queue is not None:
            await queue.put(ev)

    async def run():
        t0 = time.time()
        sink = Sink(emit)
        live["blocks"] = sink.blocks
        turn = Turn(conv_id, asst_id, agent, agents, settings, emit, abort, project_id=project_id)
        turn.interactive = stream  # streamed turns have someone watching; background ones can't ask questions
        turn.plan = plan
        turn.user_request = content.split("\n\n[Selected element in ")[0][:800]
        status, error = "complete", None
        try:
            await emit({"type": "start", "userMessage": user_msg, "message": {**live, "blocks": []}})
            has_images = any(a.get("kind") == "image" for a in attachments)
            info = await model_info(agent["model"])
            if has_images and "vision" not in info["capabilities"]:
                turn.model = settings["visionFallbackModel"]
                live["model"] = turn.model
                await emit({"type": "model", "model": turn.model, "note": f"{agent['model']} can't see images; "
                                                                          f"using {turn.model} for this turn"})
                info = await model_info(turn.model)
            num_ctx = int(agent.get("numCtx") or info["numCtx"] or 32768)
            memories = await recall(agent, content, settings)
            tool_names = turn.enabled_tools(info)
            system = build_system(agent, tool_names, effort, db.latest_artifacts(conv_id), memories, agents, settings,
                                  project_id=project_id,
                                  group_id=None if project_id else conv.get("groupId"), conv_id=conv_id,
                                  user_text=content)
            if note:
                system += "\n\n" + note
            if plan:
                system += "\n\n" + planmode.NOTE
            if body.get("voice") and stream:
                system += "\n\n" + VOICE_NOTE
            # freshContext: the model sees only this message (the system prompt carries the state it needs)
            prior = [] if body.get("freshContext") else history_messages(history, conv_id, num_ctx)
            msgs = [{"role": "system", "content": system}] + prior \
                + [user_payload(user_msg, conv_id)]
            invoked = re.match(r"^/([a-z0-9][a-z0-9-]*)\b", content)
            if invoked and "use_skill" in tool_names and invoked.group(1) in {s["name"] for s in skills.for_agent(agent)}:
                msgs[-1]["content"] += (f"\n\n[The user invoked the skill `{invoked.group(1)}`: call use_skill with that "
                                        "name first and follow it.]")
            msgs[-1]["content"] += composer.tool_hint(content, tool_names)
            if plan:
                msgs[-1]["content"] += planmode.REMINDER
            if body.get("voice") and stream:
                msgs[-1]["content"] += VOICE_REMINDER
            if memories:
                await emit({"type": "memories", "memories": memories})
            status = await turn.run(msgs, sink, effort)
        except Exception as e:
            status, error = "error", f"{type(e).__name__}: {e}"
            await emit({"type": "error", "error": error})
        final = {**live, "blocks": sink.blocks, "status": "stopped" if abort.is_set() else status,
                 "durationMs": int((time.time() - t0) * 1000), "usage": turn.usage, "model": turn.model}
        if error:
            final["error"] = error
        final["content"] = "\n\n".join(b["text"] for b in sink.blocks if b["type"] == "text")
        db.add_message(conv_id, "assistant", final["content"],
                       {k: final[k] for k in ("agentId", "model", "blocks", "status", "durationMs", "usage", "mode") if k in final}
                       | ({"error": error} if error else {}), msg_id=asst_id)
        ACTIVE.pop(conv_id, None)
        if stream and status == "complete" and not abort.is_set():
            memory.after_turn(conv_id, asst_id, content, final["content"], agent)
        if project_id:
            try:
                sha = await asyncio.to_thread(projects.commit, project_id,
                                              f"{agent['name']}: {content.splitlines()[0][:90] if content else 'update'}")
                if sha:
                    await emit({"type": "commit", "sha": sha})
                    t = asyncio.create_task(projects.refresh_cover(project_id))
                    _TASKS.add(t)
                    t.add_done_callback(_TASKS.discard)
            except Exception as e:
                await emit({"type": "error", "error": f"Saving a version failed: {e}"})
        if first_turn and status == "complete" and conv["title"] in ("New conversation", "Design session", "Coding session", "", None):
            try:
                title = await make_title(content, final["content"], settings)
                if title:
                    db.update_conversation(conv_id, title=title)
                    await emit({"type": "title", "title": title})
            except Exception:
                pass
        await emit({"type": "done", "message": final})
        await emit(None)
        return final

    task = asyncio.create_task(run())
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return queue, task


async def _run_plan_turn(conv_id, content, note, opts=None):
    """One Mega Plan turn (a step's work, a review, planning or the final report), awaited to the end. Plans are
    background work on a shared box: a turn waits while a person is talking to any agent (in this chat or another),
    so interactive use stays fast. `opts` may set effort, maxToolRounds and freshContext."""
    while True:
        busy = [c for c in ACTIVE if c == conv_id or not megaplan.link_of(c)]
        if not busy:
            break
        await asyncio.sleep(3)
    conv = db.get_conversation(conv_id)
    history = db.list_messages(conv_id)
    if history and history[-1]["role"] == "user" and history[-1]["content"] == content:
        db.delete_messages_from(conv_id, history[-1]["id"])  # the same prompt, left unanswered by an interrupted turn
    elif (len(history) >= 2 and history[-2]["role"] == "user" and history[-2]["content"] == content
          and (history[-1].get("data") or history[-1]).get("status") == "error"):
        db.delete_messages_from(conv_id, history[-2]["id"])  # the same prompt, whose attempt errored: retry it cleanly
    _, task = begin_turn(conv, {"content": content, **(opts or {})}, stream=False, note=note)
    return await task


def _abort_turn(conv_id):
    live = ACTIVE.get(conv_id)
    if live:
        _signal_abort(live)
    return bool(live)


async def _run_scheduled(t, on_conv):
    """One run of a scheduled task: a fresh chat titled after the task, with the task's prompt as the message."""
    from zoneinfo import ZoneInfo
    gid = t["groupId"] if t["groupId"] and groups.get(t["groupId"]) else None
    agent, _ = find_agent(t["agentId"])
    conv = db.create_conversation(agent["id"], title=f"{t['name']} · {datetime.now(ZoneInfo(t['tz'])):%b %-d, %H:%M}",
                                  group_id=gid)
    on_conv(conv["id"])
    if gid:
        groups.touch(gid)
    _, task = begin_turn(conv, {"content": t["prompt"]}, stream=False, note=schedules.RUN_NOTE.format(name=t["name"]))
    final = await task
    return conv["id"], final["status"], final.get("error")


async def _run_todo(item, group, message, note, on_conv):
    """One project to-do: a fresh chat in the project titled after the item, run by the item's agent."""
    agent, _ = find_agent(item["agentId"])
    conv = db.create_conversation(agent["id"], title=f"To-do #{item['n']}: {item['title']}"[:120], group_id=group["id"])
    on_conv(conv["id"])
    groups.touch(group["id"])
    _, task = begin_turn(conv, {"content": message}, stream=False, note=note)
    final = await task
    return conv["id"], final["status"], final.get("error"), final.get("content", "")


async def _run_asset_job(job, message, note, on_conv):
    """One asset scout job: a fresh chat titled after the library, run unattended with a big tool budget. Like Mega
    Plan turns, it waits while a person is talking to an agent so interactive use stays fast."""
    while ACTIVE:
        await asyncio.sleep(3)
    agent, _ = find_agent(job["agentId"])
    conv = db.create_conversation(agent["id"], title=f"Asset scout: {job['libName']}"[:120])
    on_conv(conv["id"])
    _, task = begin_turn(conv, {"content": message, "maxToolRounds": 60}, stream=False, note=note)
    final = await task
    return conv["id"], final["status"], final.get("error"), final.get("content", "")


# ── agents, tools, settings, models ─────────────────────────────────────────

@app.get("/api/agents")
def agents_list():
    settings = get_settings()
    out = []
    for a in get_agents():
        ok, why = providers.available(a["model"], settings)
        out.append({**a, "cloud": providers.is_cloud(a["model"]), "unavailable": "" if ok else why})
    return out


@app.put("/api/agents/{agent_id}")
async def agent_upsert(agent_id: str, req: Request):
    body = {k: v for k, v in (await req.json()).items() if k not in ("cloud", "unavailable")}
    body["id"] = re.sub(r"[^a-z0-9-]+", "-", (body.get("id") or agent_id).lower()).strip("-") or agent_id
    agents = get_agents()
    idx = next((i for i, a in enumerate(agents) if a["id"] == agent_id), None)
    if idx is None:
        agents.append(body)
    else:
        agents[idx] = {**agents[idx], **body}
    db.kv_set("agents", agents)
    return body


@app.delete("/api/agents/{agent_id}")
def agent_delete(agent_id: str):
    agents = [a for a in get_agents() if a["id"] != agent_id]
    if not agents:
        raise HTTPException(400, "Keep at least one agent")
    db.kv_set("agents", agents)
    deleted = set(db.kv_get("deleted_agents", [])) | {agent_id}
    db.kv_set("deleted_agents", sorted(deleted))
    return {"ok": True}


@app.post("/api/agents/{agent_id}/reset")
def agent_reset(agent_id: str):
    default = next((a for a in DEFAULT_AGENTS if a["id"] == agent_id), None)
    if not default:
        raise HTTPException(404, "Not a built-in agent")
    agents = [a for a in get_agents() if a["id"] != agent_id]
    order = [a["id"] for a in DEFAULT_AGENTS]
    agents.insert(min(order.index(agent_id), len(agents)), dict(default))
    db.kv_set("agents", agents)
    db.kv_set("deleted_agents", [x for x in db.kv_get("deleted_agents", []) if x != agent_id])
    return default


@app.get("/api/tools")
async def tools_list():
    switches = db.kv_get("tool_switches", {})
    status = await service_status()
    out = []
    for tid, t in TOOLS.items():
        svc = t["service"]
        out.append({"id": tid, **t["ui"], "enabled": switches.get(tid, True), "scope": t.get("scope", "global"),
                    "service": svc, "available": True if svc is None else status.get(svc, {}).get("ok", False)})
    for cfg in mcp_hub.configs():
        st = mcp_hub.server_status(cfg["id"])
        conn = mcp_hub.CONNECTOR_BY_ID.get(cfg.get("connector"), {})
        n = sum(1 for t in st["tools"] if t["enabled"])
        out.append({"id": f"mcp:{cfg['id']}", "displayName": cfg["name"], "icon": conn.get("icon", "Plug"), "category": "mcp",
                    "description": f"{conn.get('name', 'MCP server')} · " + (f"{n} tools" if st["status"] == "ready" else st["status"]),
                    "enabled": bool(cfg.get("enabled")), "scope": "global", "service": "mcp",
                    "available": st["status"] == "ready", "cloud": conn.get("local") is False})
    return out


@app.put("/api/tools/{tool_id}")
async def tool_toggle(tool_id: str, req: Request):
    body = await req.json()
    if tool_id.startswith("mcp:"):
        mcp_hub.patch(tool_id[4:], {"enabled": bool(body.get("enabled"))})
        await mcp_hub.sync()
        return {"ok": True}
    switches = db.kv_get("tool_switches", {})
    switches[tool_id] = bool(body.get("enabled"))
    db.kv_set("tool_switches", switches)
    return {"ok": True}


@app.get("/api/settings")
def settings_get():
    return get_settings()


@app.put("/api/settings")
async def settings_put(req: Request):
    body = await req.json()
    if any(k.startswith("cloud") and body[k] != get_settings().get(k) for k in body):
        require_admin(req)
    old = get_settings()
    merged = {**old, **{k: v for k, v in body.items() if k in DEFAULT_SETTINGS}}
    db.kv_set("settings", merged)
    changed = {k: v for k, v in body.items() if k in DEFAULT_SETTINGS and old.get(k) != v}
    if changed:
        db.audit_log("admin:settings_change", {
            "changed_keys": list(changed.keys()),
            "changes": {k: {"old": old.get(k), "new": v} for k, v in changed.items()}
        })
    return merged


@app.get("/api/audit-log")
def audit_log_get(req: Request, limit: int = 100, offset: int = 0, action: str | None = None):
    require_admin(req)
    return db.list_audit_log(limit=min(limit, 500), offset=offset, action=action)



@app.get("/api/models")
async def models():
    async with httpx.AsyncClient(timeout=10) as c:
        tags = (await c.get(f"{OLLAMA}/api/tags")).json().get("models", [])
        loaded = {m["name"]: m for m in (await c.get(f"{OLLAMA}/api/ps")).json().get("models", [])}
    out = []
    for m in tags:
        name = m["name"]
        try:
            info = await model_info(name)
        except Exception:
            info = {"capabilities": []}
        out.append({"name": name.removesuffix(":latest"), "size": m.get("size", 0), **info,
                    "loaded": name in loaded, "modifiedAt": m.get("modified_at")})
    out.sort(key=lambda m: (not m["name"].startswith("ShellB"), m["name"].lower()))
    if get_settings().get("cloudEnabled"):
        for pid, c in providers.config().items():
            if not c["apiKey"]:
                continue
            try:
                for cm in await providers.list_models(pid):
                    name = f"{pid}/{cm['id']}"
                    out.append({"name": name, "label": cm["label"], "size": 0, **providers.model_info(name),
                                "nativeCtx": cm["context"] or 0, "loaded": False, "modifiedAt": None})
            except Exception:
                pass
        for pid in cli_agents.CLIS:
            if not cli_agents.status(pid)["loggedIn"]:
                continue
            try:
                for cm in await cli_agents.list_models(pid):
                    name = f"{pid}/{cm['id']}"
                    out.append({"name": name, "label": cm["label"], "size": 0, **cli_agents.model_info(name),
                                "nativeCtx": cm["context"] or 0, "loaded": False, "modifiedAt": None})
            except Exception:
                pass
    return out


# ── CLI agents (cli_agents.py): Claude Code, Antigravity and Codex on the owner's own logins ──

@app.get("/api/cli-agents")
async def cli_agents_status(fresh: bool = False):
    return await asyncio.to_thread(cli_agents.public_status, fresh)


@app.get("/api/cli-agents/{pid}/models")
async def cli_agents_models(pid: str):
    if pid not in cli_agents.CLIS:
        raise HTTPException(404, "Unknown CLI")
    cli_agents._models_cache.pop(pid, None)
    try:
        return {"ok": True, "models": await cli_agents.list_models(pid)}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {str(e)[:300]}", "models": []}


def _bridge_guard(req: Request):
    # only the bridge process the CLI spawned on this machine; the per-turn token in the path is the real key
    if (req.client.host if req.client else "") not in ("127.0.0.1", "::1") or "x-forwarded-for" in req.headers:
        raise HTTPException(403, "local only")


@app.get("/api/cli-bridge/{token}/tools")
def cli_bridge_tools(token: str, req: Request):
    _bridge_guard(req)
    tools = cli_agents.bridge_tools(token)
    if tools is None:
        raise HTTPException(404, "No such turn (it has ended)")
    return {"tools": tools}


@app.post("/api/cli-bridge/{token}/call")
async def cli_bridge_call(token: str, req: Request):
    _bridge_guard(req)
    body = await req.json()
    res = await cli_agents.bridge_call(token, str(body.get("name", "")), body.get("arguments") or {})
    if res is None:
        raise HTTPException(404, "No such turn (it has ended)")
    return res


# ── cloud providers ─────────────────────────────────────────────────────────

@app.get("/api/providers")
def providers_get():
    return providers.public_config()


@app.put("/api/providers/{pid}")
async def providers_put(pid: str, req: Request):
    require_admin(req)
    try:
        providers.save_config(pid, await req.json())
    except KeyError:
        raise HTTPException(404, "Unknown provider")
    return providers.public_config()[pid]


@app.get("/api/providers/{pid}/models")
async def providers_models(pid: str):
    if pid not in providers.PROVIDERS:
        raise HTTPException(404, "Unknown provider")
    providers._models_cache.pop(pid, None)
    try:
        return {"ok": True, "models": await providers.list_models(pid)}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {str(e)[:300]}", "models": []}


# ── memory ──────────────────────────────────────────────────────────────────

@app.get("/api/memories")
def memories():
    return db.all_memories()


@app.post("/api/memories")
async def memory_add(req: Request):
    from tools import ToolContext, memory_save
    body = await req.json()
    ctx = ToolContext("", "", {}, get_settings(), None)
    res = await memory_save({"text": body.get("text", "")}, ctx)
    return {"ok": not res.error, "message": res.text}


@app.delete("/api/memories/{mem_id}")
def memory_delete(mem_id: str):
    db.delete_memory(mem_id)
    return {"ok": True}


# ── files ───────────────────────────────────────────────────────────────────

@app.get("/api/files/{name}")
def files(name: str):
    p = (FILES / name).resolve()
    if p.parent != FILES.resolve() or not p.is_file():
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/workspace/{conv_id}")
def workspace_list(conv_id: str):
    """Every file in a chat's sandbox /work folder, newest first, so the UI can offer them for download."""
    root = (WORKSPACES / conv_id).resolve()
    if root.parent != WORKSPACES.resolve() or not root.is_dir():
        return []
    out = []
    for p in root.rglob("*"):
        rel = p.relative_to(root)
        if not p.is_file() or any(part.startswith(".") or part == "__pycache__" for part in rel.parts):
            continue
        st = p.stat()
        out.append({"path": str(rel), "size": st.st_size, "mtime": st.st_mtime,
                    "url": f"/api/workspace/{conv_id}/{quote(str(rel))}"})
    out.sort(key=lambda f: -f["mtime"])
    return out[:500]


# Agent-written HTML/SVG opened in a tab must not run with the app's origin (it could read the admin key).
ACTIVE_TYPES = (".html", ".htm", ".svg", ".xml", ".xhtml")


@app.get("/api/workspace/{conv_id}/{path:path}")
def workspace_file(conv_id: str, path: str, download: bool = False):
    root = (WORKSPACES / conv_id).resolve()
    p = (root / path).resolve()
    if root.parent != WORKSPACES.resolve() or not str(p).startswith(str(root) + "/") or not p.is_file():
        raise HTTPException(404)
    if download:
        return FileResponse(p, filename=p.name)
    # chat artifacts load /work files (fonts need CORS) from their sandboxed, opaque-origin frame
    headers = {"X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*"}
    if p.suffix.lower() in ACTIVE_TYPES:
        headers["Content-Security-Policy"] = "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads"
        if p.suffix.lower() in (".html", ".htm"):  # known CDN URLs → /vendor, so the page works offline
            return Response(offline.localize(p.read_text(errors="replace")), media_type="text/html; charset=utf-8", headers=headers)
    return FileResponse(p, headers=headers)


# ── status ──────────────────────────────────────────────────────────────────

_status_cache: tuple[float, dict] = (0.0, {})


async def _probe(client, url, ok=lambda r: r.status_code < 500):
    try:
        r = await client.get(url, timeout=3)
        return {"ok": bool(ok(r))}
    except Exception as e:
        return {"ok": False, "error": type(e).__name__}


async def service_status():
    global _status_cache
    if time.time() - _status_cache[0] < 15:
        return _status_cache[1]
    settings = get_settings()
    async with httpx.AsyncClient() as c:
        results = await asyncio.gather(
            _probe(c, f"{OLLAMA}/api/version"),
            _probe(c, f"{SEARXNG}/healthz", ok=lambda r: r.status_code == 200),  # a real search here hammers the engines
            _probe(c, f"{COMFY}/system_stats", ok=lambda r: r.status_code == 200),
            _probe(c, f"{ORPHEUS}/health", ok=lambda r: r.status_code == 200),
            _probe(c, f"{HERMES}/health", ok=lambda r: r.status_code == 200),
        )
        try:
            tags = (await c.get(f"{OLLAMA}/api/tags", timeout=3)).json().get("models", [])
            embed_ok = any(m["name"] == settings["embeddingModel"] for m in tags)
        except Exception:
            embed_ok = False
    proc = await asyncio.create_subprocess_exec("docker", "image", "inspect", SANDBOX_IMAGE,
                                                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    sandbox_ok = (await proc.wait()) == 0
    names = ["ollama", "searxng", "nyx", "orpheus", "hermes"]
    status = dict(zip(names, results))
    status["embeddings"] = {"ok": embed_ok}
    status["sandbox"] = {"ok": sandbox_ok}
    status["studio"] = {"ok": Path(projects.FIREFOX).exists()}
    _status_cache = (time.time(), status)
    return status


@app.get("/api/status")
async def status():
    services = await service_status()
    mem = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        k, v = line.split(":", 1)
        if k in ("MemTotal", "MemAvailable"):
            mem[k] = int(v.split()[0]) * 1024
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            loaded = (await c.get(f"{OLLAMA}/api/ps")).json().get("models", [])
    except Exception:
        loaded = []
    return {"version": VERSION, "services": services, "memory": mem,
            "loaded": [{"name": m["name"].removesuffix(":latest"), "size": m.get("size", 0),
                        "context": m.get("context_length")} for m in loaded],
            "active": list(ACTIVE), "scheduledRunAt": schedules.last_finished(), "megaPlan": megaplan.running_now(), "todo": todos.running_now(), "assetJob": asset_libs.running_now(),
            "notebook": notebook.running_now(), "activity": activity.summary(), "memoryPending": memory.pending_count(),
            "dataJob": datasets.running_now(), "downloads": datasets.downloads()}


@app.get("/api/_hold")
async def hold(ms: int = 4000):
    """Dev aid: a pixel that arrives late, used by ?shot to delay the page load event for screenshots."""
    await asyncio.sleep(min(ms, 20000) / 1000)
    return Response(b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,"
                    b"\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;", media_type="image/gif")


# ── UI ──────────────────────────────────────────────────────────────────────

class CorsStatic(StaticFiles):
    """Studio previews run in a sandboxed (null-origin) frame, and ES module imports are CORS fetches."""
    async def get_response(self, path, scope):
        r = await super().get_response(path, scope)
        r.headers["Access-Control-Allow-Origin"] = "*"
        return r


if UI_DIST.exists():
    app.mount("/assets", StaticFiles(directory=UI_DIST / "assets"), name="assets")
    if (UI_DIST / "vendor").exists():
        app.mount("/vendor", CorsStatic(directory=UI_DIST / "vendor"), name="vendor")


@app.get("/{path:path}")
def spa(path: str):
    target = (UI_DIST / path).resolve()
    if path and target.is_file() and str(target).startswith(str(UI_DIST.resolve())):
        return FileResponse(target)
    index = UI_DIST / "index.html"
    if index.exists():
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
    return JSONResponse({"error": "UI not built — run `npm run build` in ~/shellb/web/ui"}, status_code=503)
