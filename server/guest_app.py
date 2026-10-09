"""Shell:B Guest's web app: what friends reach at the guest address. The guest model is described in guests.py.

serve.py runs this process with two kinds of sockets. The owner's (SHELLB_PORT, 8200) reach app.app. The guests'
(SHELLB_GUEST_PORT, 8220) reach `guest_app`, which `root` picks by the port of the local socket that accepted the
connection. That is a fact about this machine, not something a client can send. guest_app mounts only the routes
below. Anything the owner app does is unreachable from the guest port, whatever a request carries: there's no owner
middleware, no localhost trust, and owner routes don't exist here.

The routes copy the paths the chat UI already uses (/api/conversations/…, /api/workspace/…, /api/files/…, /api/stt,
/api/tts), so the guest UI (ui/guest.html → ui/src/guest/) reuses the owner's chat components unchanged. Each handler
first checks that the chat or file belongs to the signed-in guest, then calls the owner app's own function for the
work.

Sign-in (guest_accounts.py): username and password, then a two-step code if the guest turned that on. Invite and
reset links set a password; device codes sign in another device. A guest with no password yet (invite-only, from
before accounts) reaches nothing but SETUP_OPEN until they choose one.

Frame keys (sandboxed artifacts, which carry no cookie): `/api/k/w-<conv>.<mac>/…` with mac = HMAC(the guest's frame
secret, scope), as in auth.py. The frame secret is derived per guest (guests.frame_secret) and reaches only that
guest's chats, files and artifact state.
"""
import asyncio
import hmac
import json
import os
import re
import time

import httpx
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from fastapi.routing import APIRoute

import app as owner
import appstate
import auth
import cells
import db
import flights
import guest_accounts
import guest_notes
import guests
import maps
import planetary
import routing
import sky
import speech
import weather
import wiki
import worldnotes
from roster import get_settings

GUEST_PORT = int(os.environ.get("SHELLB_GUEST_PORT", "8220"))
UPLOAD_MAX = 50 * 2**20
STT_MAX = 25 * 2**20
PER_MINUTE = 240  # API requests per guest per minute, all routes together
UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}
STATIC_DIRS = ("assets", "fonts", "icons", "vendor")
STATIC_FILES = ("favicon.svg", "guest.html", "manifest-guest.webmanifest", "guest-sw.js", "sw.js", "manifest.webmanifest")
# the only /api paths that answer without a guest session (every handler checks again; this is the outer wall)
OPEN = ("/api/auth/me", "/api/guest/login", "/api/guest/login/two-step", "/api/guest/code", "/api/guest/signup",
        "/api/guest/reset", "/api/guest/redeem", "/api/guest/logout", "/api/_hold")
# what a session of a guest with no password yet (invite-only, from before accounts) may reach: choosing one
SETUP_OPEN = ("/api/guest/account/create",)
# owner routers whose GET routes guests share as they are: offline Wikipedia, maps, sky, weather, routes, flights,
# and the Worlds notes (read-only here: their POST/DELETE stay owner-only)
SHARED_READS = (wiki.router, maps.router, weather.router, routing.router, sky.router, planetary.router, flights.router,
                worldnotes.router)
EFFORTS = ("low", "medium", "high")

guest_app = FastAPI(title="Shell:B Guest", docs_url=None, redoc_url=None, openapi_url=None)
_hits: dict[str, list[float]] = {}


async def root(scope, receive, send):
    """The process's ASGI entry (serve.py): the guest port gets guest_app, everything else (and lifespan) the owner's."""
    if scope["type"] in ("http", "websocket") and (scope.get("server") or (None, None))[1] == GUEST_PORT:
        return await guest_app(scope, receive, send)
    return await owner.app(scope, receive, send)


def _origin_ok(req: Request) -> bool:
    origin = req.headers.get("origin")
    if not origin:
        return True
    proto = req.headers.get("x-forwarded-proto") or req.url.scheme
    return origin == f"{proto}://{req.headers.get('host', '')}"


@guest_app.middleware("http")
async def guard(req: Request, call_next):
    path = req.url.path
    framed = path.startswith("/api/k/")
    if req.method in UNSAFE and not framed and not _origin_ok(req):
        return JSONResponse({"detail": "Cross-site request refused"}, status_code=403)
    got = None
    if path.startswith("/api/") and not framed and path not in OPEN:
        got = guests.session_of(req)
        if not got:
            return JSONResponse({"detail": "Not signed in"}, status_code=401)
        if not got[0]["passwordSet"] and path not in SETUP_OPEN:
            return JSONResponse({"detail": "Choose a username and password first", "code": "account_required"},
                                status_code=403)
    if path.startswith("/api/") and not framed:
        token = req.cookies.get(guests.COOKIE) or auth._client_ip(req.scope)
        now = time.time()
        hits = [t for t in _hits.get(token, []) if now - t < 60]
        if len(hits) >= PER_MINUTE:
            return JSONResponse({"detail": "Slow down a little"}, status_code=429, headers={"Retry-After": "10"})
        hits.append(now)
        _hits[token] = hits
        if len(_hits) > 5000:
            _hits.clear()
    if got and cells.enabled(got[0]) and not path.startswith("/api/guest/"):
        resp = await cells.proxy(req, got[0])  # their own Shell:B answers everything but the gateway's account routes
    else:
        resp = await call_next(req)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    if not framed:
        resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    if path.startswith("/api/") and not framed:
        resp.headers.setdefault("Cache-Control", "no-store")
    return resp


def _set_cookie(resp: Response, req: Request, token: str, remember: bool = True):
    """Without "Remember me" the cookie ends with the browser session (and the server drops it after IDLE_TTL)."""
    secure = req.url.scheme == "https" or req.headers.get("x-forwarded-proto") == "https"
    resp.set_cookie(guests.COOKIE, token, max_age=guests.SESSION_TTL if remember else None, httponly=True,
                    samesite="strict", secure=secure, path="/")


async def _body(req: Request) -> dict:
    try:
        body = await req.json()
    except ValueError:
        raise HTTPException(400, "Send JSON")
    return body if isinstance(body, dict) else {}


def _signed_in(got: dict, req: Request) -> JSONResponse:
    """A sign-in step's answer: the cookie, or a ticket for the two-step code."""
    if "ticket" in got:
        return JSONResponse({"twoStep": True, "ticket": got["ticket"]})
    resp = JSONResponse({"ok": True, "name": got["guest"]["name"]})
    _set_cookie(resp, req, got["token"], got["remember"])
    return resp


def _session(req: Request) -> tuple[dict, dict]:
    got = guests.session_of(req)
    if not got:
        raise HTTPException(401, "Not signed in")
    return got


def _agent(g: dict, agent_id: str | None) -> dict:
    agents = guests.agents_for(g)
    if not agents:
        raise HTTPException(503, "No agents are shared with guests right now. Tell Evie.")
    if not agent_id:
        default = get_settings().get("defaultAgent")
        return next((a for a in agents if a["id"] == default), agents[0])
    hit = next((a for a in agents if a["id"] == agent_id), None)
    if not hit:
        raise HTTPException(404, "That agent isn't available here")
    return hit


def _me(g: dict, sess: dict) -> dict:
    cfg = g["config"]
    return {"id": g["id"], "name": g["name"], "today": guests.usage(g["id"]),
            "limits": {k: cfg[k] for k in guests.LIMITS}, "storageBytes": guests.storage_bytes(g["id"]),
            "agents": [guests.public_agent(a, g) for a in guests.agents_for(g)],
            "defaultAgent": get_settings().get("defaultAgent"), "devices": guests.devices(g["id"], sess["id"]),
            "username": g["username"], "twoStep": g["twoStep"],
            "deviceCodes": sess.get("via") in guest_accounts.PASSWORD_VIAS}


# ── sign-in ─────────────────────────────────────────────────────────────────

@guest_app.get("/api/auth/me")
def auth_me(req: Request):
    got = guests.session_of(req)
    if not got:
        return {"authenticated": False, "via": None, "passwordSet": True, "frameKey": None}
    g = got[0]
    if g["passwordSet"] and cells.enabled(g):  # what the full Shell:B UI asks first (cell_boot.auth_me answers the same)
        return {"authenticated": True, "via": "session", "passwordSet": True, "needsAccount": False,
                "frameKey": guests.frame_secret(g["id"]), "cell": {"guest": g["name"]},
                "guest": {"id": g["id"], "name": g["name"], "username": g["username"]}}
    return {"authenticated": True, "via": "guest", "passwordSet": True, "needsAccount": not g["passwordSet"],
            "frameKey": guests.frame_secret(g["id"]) if g["passwordSet"] else None,
            "guest": {"id": g["id"], "name": g["name"], "username": g["username"]}}


@guest_app.post("/api/guest/login")
async def login(req: Request):
    body = await _body(req)
    got = await guest_accounts.sign_in(req, body.get("username"), body.get("password"), body.get("remember") is not False)
    return _signed_in(got, req)


@guest_app.post("/api/guest/login/two-step")
async def login_two_step(req: Request):
    body = await _body(req)
    return _signed_in(await guest_accounts.second_step(req, body.get("ticket"), body.get("code")), req)


@guest_app.post("/api/guest/code")
async def code_info(req: Request):
    """What an invite or reset link is for: the forms greet the guest by name before anything is spent."""
    return await guest_accounts.code_info(req, (await _body(req)).get("code"))


@guest_app.post("/api/guest/signup")
async def signup(req: Request):
    body = await _body(req)
    got = await guest_accounts.signup(req, body.get("code"), body.get("username"), body.get("password"), body.get("email"),
                                      body.get("remember") is not False)
    return _signed_in(got, req)


@guest_app.post("/api/guest/reset")
async def reset(req: Request):
    body = await _body(req)
    got = await guest_accounts.reset(req, body.get("code"), body.get("password"), body.get("remember") is not False)
    return _signed_in(got, req)


@guest_app.post("/api/guest/redeem")
async def redeem(req: Request):
    """A device code from another signed-in device."""
    body = await _body(req)
    token, g = await guests.redeem(str(body.get("code") or ""), req)
    resp = JSONResponse({"ok": True, "name": g["name"]})
    _set_cookie(resp, req, token)
    return resp


@guest_app.post("/api/guest/logout")
def logout(req: Request):
    got = guests.session_of(req)
    if got:
        guests.drop_device(got[0]["id"], got[1]["id"][:16])
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(guests.COOKIE, path="/")
    return resp


@guest_app.get("/api/guest/me")
def me(req: Request):
    got = guests.session_of(req)
    if not got:
        raise HTTPException(401, "Not signed in")
    return _me(*got)


@guest_app.post("/api/guest/device-code")
def device_code(req: Request):
    g, sess = _session(req)
    if sess.get("via") not in guest_accounts.PASSWORD_VIAS:
        raise HTTPException(403, "Device codes can only be made on a device where you signed in with your password.")
    guest_accounts.log(g["id"], "device_code", req)
    return {"code": guests.device_code(g["id"]), "expiresIn": guests.DEVICE_TTL}


# ── the guest's account ─────────────────────────────────────────────────────

@guest_app.get("/api/guest/account")
def account(req: Request):
    return guest_accounts.account(*_session(req))


@guest_app.patch("/api/guest/account")
async def update_account(req: Request):
    g, sess = _session(req)
    guest_accounts.update_profile(g, await _body(req))
    return guest_accounts.account(*_session(req))


@guest_app.post("/api/guest/account/create")
async def create_account(req: Request):
    """A guest who joined by invite before accounts existed chooses a username and password."""
    g, sess = _session(req)
    body = await _body(req)
    await guest_accounts.create_for_session(req, g, sess, body.get("username"), body.get("password"), body.get("email"))
    return {"ok": True}


@guest_app.post("/api/guest/account/password")
async def change_password(req: Request):
    g, sess = _session(req)
    body = await _body(req)
    await guest_accounts.change_password(req, g, sess, body.get("current"), body.get("password"))
    return {"ok": True}


@guest_app.post("/api/guest/account/two-step/setup")
async def two_step_setup(req: Request):
    g, _sess = _session(req)
    return await guest_accounts.two_step_begin(req, g, (await _body(req)).get("password"))


@guest_app.post("/api/guest/account/two-step")
async def two_step_on(req: Request):
    g, _sess = _session(req)
    return {"recoveryCodes": guest_accounts.two_step_enable(req, g, (await _body(req)).get("code"))}


@guest_app.post("/api/guest/account/two-step/off")
async def two_step_off(req: Request):
    g, _sess = _session(req)
    await guest_accounts.two_step_disable(req, g, (await _body(req)).get("password"))
    return {"ok": True}


@guest_app.post("/api/guest/account/recovery-codes")
async def recovery_codes(req: Request):
    g, _sess = _session(req)
    return {"recoveryCodes": await guest_accounts.new_recovery_codes(req, g, (await _body(req)).get("password"))}


@guest_app.delete("/api/guest/devices/{short_id}")
def drop_device(short_id: str, req: Request):
    g = guests.require(req)
    if not guests.drop_device(g["id"], short_id):
        raise HTTPException(404)
    return {"ok": True}


# ── memory and reports ──────────────────────────────────────────────────────

@guest_app.get("/api/guest/memories")
def memories(req: Request):
    return guests.memories(guests.require(req)["id"])


@guest_app.delete("/api/guest/memories/{mid}")
def forget(mid: str, req: Request):
    if not guests.forget_memory(guests.require(req)["id"], mid):
        raise HTTPException(404)
    return {"ok": True}


@guest_app.delete("/api/guest/memories")
def forget_all(req: Request):
    g = guests.require(req)
    with db.conn() as c:
        c.execute("DELETE FROM guest_memories WHERE guest_id=?", (g["id"],))
    return {"ok": True}


@guest_app.post("/api/guest/report")
async def report(req: Request):
    g = guests.require(req)
    body = await req.json()
    return guests.add_report(g, body.get("text"), body.get("convId"), body.get("msgId"), bool(body.get("includeChat")),
                             req.headers.get("user-agent") or "")


# ── agents and conversations ────────────────────────────────────────────────

@guest_app.get("/api/agents")
def agents(req: Request):
    g = guests.require(req)
    return [guests.public_agent(a, g) for a in guests.agents_for(g)]


@guest_app.get("/api/conversations")
def conversations(req: Request):
    g = guests.require(req)
    out = guests.conversations(g)
    for c in out:
        c["streaming"] = c["id"] in owner.ACTIVE
    return out


@guest_app.post("/api/conversations")
async def new_conversation(req: Request):
    g = guests.require(req)
    body = await req.json() if (await req.body()) else {}
    return guests.create_conversation(g, _agent(g, body.get("agentId"))["id"])


@guest_app.get("/api/conversations/{conv_id}")
def conversation(conv_id: str, req: Request):
    guests.conversation(guests.require(req), conv_id)
    out = owner.conversation(conv_id)
    for k in ("researchBoard", "megaPlan"):
        out.pop(k, None)
    return out


@guest_app.patch("/api/conversations/{conv_id}")
async def patch_conversation(conv_id: str, req: Request):
    g = guests.require(req)
    guests.conversation(g, conv_id)
    body = await req.json()
    agent_id = _agent(g, body["agentId"])["id"] if body.get("agentId") else None
    title = str(body["title"])[:120] if body.get("title") else None
    return db.update_conversation(conv_id, title=title, agentId=agent_id, pinned=body.get("pinned"))


@guest_app.delete("/api/conversations/{conv_id}")
def delete_conversation(conv_id: str, req: Request):
    g = guests.require(req)
    guests.conversation(g, conv_id)
    if conv_id in owner.ACTIVE:
        owner._abort_turn(conv_id)
    guests.forget_conversation(g, conv_id)
    return {"ok": True}


@guest_app.post("/api/conversations/{conv_id}/stop")
def stop(conv_id: str, req: Request):
    guests.conversation(guests.require(req), conv_id)
    if conv_id in owner.ACTIVE:
        owner._abort_turn(conv_id)
    return {"ok": True}


@guest_app.post("/api/conversations/{conv_id}/upload")
async def upload(conv_id: str, req: Request, file: UploadFile = File(...)):
    g = guests.require(req)
    guests.conversation(g, conv_id)
    size = getattr(file, "size", None) or 0
    if size > UPLOAD_MAX:
        raise HTTPException(413, f"Files over {UPLOAD_MAX // 2**20} MB can't be attached here.")
    guests.check_storage(g, size)
    att = await owner.upload(conv_id, file)
    guests._storage.pop(g["id"], None)
    return att


@guest_app.post("/api/conversations/{conv_id}/chat")
async def chat(conv_id: str, req: Request):
    g = guests.require(req)
    conv = guests.conversation(g, conv_id)
    body = await req.json()
    if conv_id in owner.ACTIVE:
        raise HTTPException(409, "This conversation is already generating")
    if guests.busy(g["id"]):
        raise HTTPException(429, "One reply at a time: wait for the one in progress to finish.")
    guests.check_turn(g)
    agent = _agent(g, body.get("agentId") or conv["agentId"])
    content = str(body.get("content") or "")
    atts = guests.clean_attachments(conv_id, body.get("attachments"))
    if not content.strip() and not atts:
        raise HTTPException(400, "Empty message")
    if len(content) > guests.MAX_MESSAGE:
        raise HTTPException(413, f"Messages are limited to {guests.MAX_MESSAGE:,} characters here.")
    clean = {"content": content, "agentId": agent["id"], "attachments": atts}
    if body.get("effort") in EFFORTS:
        clean["effort"] = body["effort"]
    if body.get("voice"):
        clean["voice"] = True
    if body.get("routeOnly"):  # an @mention answers this turn only, without changing the chat's agent
        clean["routeOnly"] = True
    if body.get("fromMessageId"):  # edit or regenerate: only a message of this chat
        if not any(m["id"] == body["fromMessageId"] for m in db.list_messages(conv_id)):
            raise HTTPException(404, "No such message")
        clean["fromMessageId"] = body["fromMessageId"]
    sem = guests.slots()
    wait_for_owner = guests.settings()["ownerWait"]

    async def stream():
        held, t0, told = False, time.time(), False
        try:
            while True:  # one guest turn at a time, and the owner's own turns go first
                if not held:
                    try:
                        await asyncio.wait_for(sem.acquire(), 2)
                        held = True
                    except asyncio.TimeoutError:
                        pass
                if held and (not guests.owner_busy() or time.time() - t0 > wait_for_owner):
                    break
                if not told:
                    told = True
                    yield f"data: {json.dumps({'type': 'queued', 'message': 'Waiting for Shell:B to finish another reply…'})}\n\n"
                else:
                    yield ": waiting\n\n"
                if held:
                    await asyncio.sleep(2)
            if conv_id in owner.ACTIVE:
                yield f"data: {json.dumps({'type': 'error', 'error': 'This conversation is already generating'})}\n\n"
                return
            try:
                queue, task = owner.begin_turn(conv, clean, note=guests.note(g), api=guests.turn_api(g))
            except RuntimeError as e:
                yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
                return
            guests.started(conv_id, g["id"])
            task.add_done_callback(lambda _t: guests.finished(conv_id, sem))
            held = False  # the turn's task gives the slot back when it ends, even if this stream is dropped
            while True:
                ev = await queue.get()
                if ev is None:
                    break
                yield f"data: {json.dumps(ev)}\n\n"
        finally:
            if held:
                sem.release()

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@guest_app.post("/api/questions/{aid}")
async def answer(aid: str, req: Request):
    g = guests.require(req)
    if not guests.answer_question(g, aid, answers=(await req.json()).get("answers")):
        raise HTTPException(404, "That question is no longer waiting.")
    return {"ok": True}


@guest_app.post("/api/ssh/approvals/{aid}")
async def dismiss(aid: str, req: Request):
    """The question card's Dismiss sends a decision here; for a guest it can only answer their own questions."""
    g = guests.require(req)
    decision = (await req.json()).get("decision")
    if decision != "deny" or not guests.answer_question(g, aid, decision="deny"):
        raise HTTPException(404, "That question is no longer waiting.")
    return {"ok": True}


# ── files ───────────────────────────────────────────────────────────────────

@guest_app.get("/api/workspace/{conv_id}")
def workspace_list(conv_id: str, req: Request):
    guests.conversation(guests.require(req), conv_id)
    return owner.workspace_list(conv_id)


@guest_app.get("/api/workspace/{conv_id}/{path:path}")
def workspace_file(conv_id: str, path: str, req: Request, download: bool = False):
    guests.conversation(guests.require(req), conv_id)
    return owner.workspace_file(conv_id, path, download)


@guest_app.get("/api/files/{name}")
def files(name: str, req: Request):
    if not guests.owns_file(guests.require(req), name):
        raise HTTPException(404)
    return owner.files(name)


@guest_app.delete("/api/appstate")
def clear_appstate(s: str, req: Request):
    g = guests.require(req)
    m = re.match(r"^art:([A-Za-z0-9_-]{1,64}):", s or "")
    if not m or not guests.owns(g, m.group(1)):
        raise HTTPException(404)
    return appstate.clear_state(s)


@guest_app.api_route("/api/k/{key}/{rest:path}", methods=["GET", "HEAD", "POST"])
async def framed(key: str, rest: str, req: Request):
    """What a sandboxed artifact may load without a cookie: its own chat's /work files, the files its guest generated,
    and its own saved state. The key is only good for chats of the guest whose frame secret signed it. A cell guest's
    key goes to their cell, without the gate header: the cell checks the key and its scope itself (auth._cell_auth)."""
    cell_guest = cells.frame_owner(key)
    if cell_guest:
        return await cells.proxy(req, cell_guest, gate=False)
    m = auth.SCOPED_KEY.match(key)
    scope, mac = m.groups() if m else ("", "")
    conv_id = scope[2:] if scope.startswith("w-") else ""
    with db.conn() as c:
        r = c.execute("SELECT tenant FROM conversations WHERE id=?", (conv_id,)).fetchone() if conv_id else None
    gid = r["tenant"] if r else None
    if not gid or not hmac.compare_digest(auth.frame_mac(guests.frame_secret(gid), scope), mac):
        raise HTTPException(404)
    req.scope["shellb_prefix"] = f"/api/k/{key}"
    s = req.query_params.get("s") or ""
    state_ok = not s or s.startswith(f"art:{conv_id}:")
    if rest == "appstate/boot.js" and req.method in ("GET", "HEAD") and state_ok:
        return appstate.boot(req)
    if rest == "appstate" and s and state_ok:
        return appstate.get_state(s) if req.method == "GET" else await appstate.write_state(s, req)
    if req.method not in ("GET", "HEAD"):
        raise HTTPException(404)
    if rest.startswith(f"workspace/{conv_id}/") and len(rest) > len(f"workspace/{conv_id}/"):
        return owner.workspace_file(conv_id, rest[len(f"workspace/{conv_id}/"):])
    if rest.startswith("files/") and guests.owns_file({"id": gid}, rest[len("files/"):]):
        return owner.files(rest[len("files/"):])
    raise HTTPException(404)


# ── speech ──────────────────────────────────────────────────────────────────

def _voice(v) -> str:
    """Kokoro's built-in voices only: the owner's designed and cloned voices aren't shared."""
    if v and guests.KOKORO_VOICE.match(str(v)):
        return str(v)
    own = str(get_settings().get("ttsVoice") or "")
    return own if guests.KOKORO_VOICE.match(own) else "af_heart"


@guest_app.post("/api/stt")
async def stt(req: Request, file: UploadFile = File(...)):
    guests.require(req)
    if (getattr(file, "size", None) or 0) > STT_MAX:
        raise HTTPException(413, "That recording is too long.")
    return await speech.stt(file)


@guest_app.post("/api/tts")
async def tts(req: Request):
    guests.require(req)
    body = await req.json()
    text = str(body.get("text", ""))[:4000]
    try:
        speed = max(0.5, min(2.0, float(body.get("speed") or 1.0)))
    except (TypeError, ValueError):
        speed = 1.0
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post(f"{speech.HERMES}/tts", json={"text": text, "voice": _voice(body.get("voice")), "speed": speed,
                                                       "format": "mp3"})
    if r.status_code != 200:
        raise HTTPException(502, "Speech is unavailable right now")
    return Response(r.content, media_type=r.headers.get("content-type", "audio/mpeg"))


@guest_app.get("/api/tts/voices")
async def voices(req: Request):
    guests.require(req)
    try:
        got = await speech.voices()
    except Exception:  # noqa: BLE001
        return {"voices": [], "details": []}
    keep = [v for v in got.get("voices") or [] if guests.KOKORO_VOICE.match(v)]
    return {"voices": keep, "details": [d for d in got.get("details") or [] if d.get("id") in keep]}


# ── shared apps: Wiki, Worlds (read-only) and Notes (the guest's own) ───────────────────────

guest_app.include_router(guest_notes.router)
for _r in SHARED_READS:
    for _route in _r.routes:
        if isinstance(_route, APIRoute) and _route.methods <= {"GET", "HEAD"}:
            guest_app.router.routes.append(_route)


# ── the guest UI ────────────────────────────────────────────────────────────

@guest_app.get("/api/_hold")
async def hold(ms: int = 4000):
    """?shot (guest.html): a late pixel that holds the load event, so headless screenshots catch a settled page."""
    return await owner.hold(ms)


@guest_app.api_route("/api/{rest:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
def not_here(rest: str):
    raise HTTPException(404, "Not available in Shell:B Guest")


@guest_app.get("/{path:path}")
def spa(path: str, req: Request):
    dist = owner.UI_DIST.resolve()
    first = path.split("/", 1)[0]
    if path in STATIC_FILES or (first in STATIC_DIRS and "/" in path):
        target = (dist / path).resolve()
        if target.is_file() and str(target).startswith(str(dist) + "/"):
            cache = "no-cache" if path in STATIC_FILES else "public, max-age=31536000, immutable" if first == "assets" else None
            headers = {"Cache-Control": cache} if cache else {}
            if first == "vendor":  # artifacts load these from their sandboxed, opaque-origin frame
                headers["Access-Control-Allow-Origin"] = "*"
            return FileResponse(target, headers=headers)
        raise HTTPException(404)
    got = guests.session_of(req)
    page = dist / ("index.html" if got and got[0]["passwordSet"] and cells.enabled(got[0]) else "guest.html")
    if page.is_file():
        return FileResponse(page, headers={"Cache-Control": "no-cache"})
    return JSONResponse({"error": "Shell:B Guest isn't built yet"}, status_code=503)
