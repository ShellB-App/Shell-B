"""Screen sight: agents look at the owner's screen when the owner shares it.

A *source* is anything that hands over a frame of the owner's screen on request:
- a browser tab sharing a screen, window or tab (ui/src/screenShare.ts), signed in as the owner;
- the Shell:B Screen helper running on a computer (clients/shellb_screen.py), with a device token made in
  Settings → Screen. It can look without a browser prompt, so it's for the owner's own machines only.
Both register with POST /api/screen/connect, long-poll GET /api/screen/next for capture requests and send the JPEG
to POST /api/screen/frame/<rid>. Nothing is captured unless a source is connected, and every look happens on request.

`look_at_screen` is offered only in live chats (top-level turns), to models that can see, while a source is connected;
cloud models get it only with the cloudScreen setting. Frames land in the chat's /work/screen/ so they show in the
chat and can be looked at again; the model gets a downscaled copy.
"""
import asyncio
import base64
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

import auth
import db
from tools import TOOLS, WORKSPACES, ToolResult, _fn

router = APIRouter(prefix="/api/screen")
DIR = db.DATA / "screen"
DEVICES = DIR / "devices.json"
HELPER = Path(__file__).resolve().parent.parent / "clients" / "shellb_screen.py"
POLL = 25            # seconds a long-poll waits for a capture request
LIVE = POLL + 20     # a source that hasn't polled for this long is gone
ANSWER = 20          # seconds to wait for a frame
MAX_FRAME = 12 << 20
MODEL_EDGE = 1600    # the model's copy: longest side

GUIDE = ("- look_at_screen shows you the user's screen right now; they chose to share it. Use it when they point at "
         "something on screen ('this error', 'what do you think of this page?', 'help me with this') or to follow "
         "along with steps they're taking. Each look costs context, so look when it helps, not every turn, and never "
         "describe their screen without looking. Mention anything sensitive you happen to see only if it matters.")


@dataclass
class Source:
    id: str
    kind: str          # "browser" | "helper"
    name: str          # e.g. "Chrome on Windows", "EVIE-PC"
    label: str         # what is shared: "Entire screen", "Window: Visual Studio Code"
    owner: str         # "session:<id>" or "device:<id>": only it may poll and answer
    monitors: list = field(default_factory=list)
    screen: bool = True    # can take screenshots
    browser: bool = False  # can drive a browser window (helper with Playwright; browsing.py)
    since: float = field(default_factory=time.time)
    seen: float = field(default_factory=time.time)
    polling: int = 0
    looks: int = 0
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)

    def live(self) -> bool:
        return self.polling > 0 or time.time() - self.seen < LIVE

    def public(self) -> dict:
        return {"id": self.id, "kind": self.kind, "name": self.name, "label": self.label, "monitors": self.monitors,
                "since": self.since, "seen": self.seen, "looks": self.looks, "screen": self.screen, "browser": self.browser}


_sources: dict[str, Source] = {}
_waiting: dict[str, tuple[str, asyncio.Future]] = {}  # rid -> (source id, future for the frame bytes)


def live_sources() -> list[Source]:
    for sid in [s.id for s in _sources.values() if not s.live()]:
        _sources.pop(sid, None)
    # a browser share was started on purpose just now, so it comes before an always-on helper
    return sorted(_sources.values(), key=lambda s: (s.kind == "browser", s.since), reverse=True)


def available() -> bool:
    return any(s.screen for s in live_sources())


def browser_sources() -> list[Source]:
    return [s for s in live_sources() if s.browser]


def describe() -> str:
    out = []
    for s in live_sources():
        mon = f", {len(s.monitors)} monitors" if len(s.monitors) > 1 else ""
        if s.screen:
            out.append(f"`{s.id}` {s.name}: {s.label}{mon}")
    return "; ".join(out)


# ── device tokens (the helper) ──────────────────────────────────────────────

def _devices() -> dict:
    try:
        return json.loads(DEVICES.read_text())
    except (OSError, ValueError):
        return {}


def _save_devices(d: dict):
    DIR.mkdir(parents=True, exist_ok=True)
    tmp = DEVICES.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=1))
    tmp.chmod(0o600)
    tmp.replace(DEVICES)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _device_for(token: str) -> str | None:
    h = _hash(token.strip())
    for did, d in _devices().items():
        if hmac.compare_digest(d.get("hash", ""), h):
            return did
    return None


def _caller(req: Request) -> str:
    """Who is talking: a paired helper (by its token) or the owner's browser session. Nobody else may be a source."""
    tok = req.headers.get("x-shellb-screen")
    if tok:
        did = _device_for(tok)
        if not did:
            raise HTTPException(401, "This screen helper isn't paired any more. Pair it again in Settings → Screen.")
        return f"device:{did}"
    if auth.is_owner(req):
        return f"session:{(auth.session_of(req) or {}).get('id', '')}"
    raise HTTPException(403, "Only the owner can share a screen.")


def _mine(sid: str, req: Request) -> Source:
    s = _sources.get(sid)
    if not s:
        raise HTTPException(404, "unknown-source")
    if s.owner != _caller(req):
        raise HTTPException(403, "That isn't your screen source.")
    return s


# ── source endpoints ────────────────────────────────────────────────────────

@router.post("/connect")
async def connect(req: Request):
    who = _caller(req)
    body = await req.json()
    kind = "helper" if who.startswith("device:") else "browser"
    name = str(body.get("name") or "").strip()[:80]
    if kind == "helper":
        did = who.split(":", 1)[1]
        devs = _devices()
        name = name or devs.get(did, {}).get("name", "Computer")
        devs.setdefault(did, {})["lastSeen"] = time.time()
        _save_devices(devs)
        for s in [s for s in _sources.values() if s.owner == who]:  # a restarted helper replaces its old self
            _drop(s.id)
    mons = [{"w": int(m.get("w") or 0), "h": int(m.get("h") or 0)} for m in (body.get("monitors") or [])[:16] if isinstance(m, dict)]
    s = Source(id="scr-" + uuid.uuid4().hex[:8], kind=kind, name=name or "Browser",
               label=str(body.get("label") or ("Desktop" if kind == "helper" else "Screen")).strip()[:120],
               owner=who, monitors=mons, screen=kind == "browser" or body.get("screen", True) is not False,
               browser=kind == "helper" and bool(body.get("browser")))
    _sources[s.id] = s
    return {"id": s.id, "poll": POLL}


@router.get("/next")
async def next_request(id: str, req: Request):
    s = _mine(id, req)
    s.polling += 1
    s.seen = time.time()
    try:
        r = await asyncio.wait_for(s.queue.get(), POLL)
    except asyncio.TimeoutError:
        r = None
    finally:
        s.polling -= 1
        s.seen = time.time()
    if r and await req.is_disconnected():  # the poll died while the request waited: hand it to the next poll
        s.queue.put_nowait(r)
        r = None
    return {"request": r}


@router.post("/frame/{rid}")
async def frame(rid: str, id: str, req: Request):
    s = _mine(id, req)
    w = _waiting.get(rid)
    if not w or w[0] != s.id or w[1].done():
        raise HTTPException(404, "Nobody is waiting for that frame any more.")
    if req.headers.get("x-screen-error"):
        w[1].set_result(("error", req.headers["x-screen-error"][:300]))
        return {"ok": True}
    data = await req.body()
    if not data or len(data) > MAX_FRAME:
        raise HTTPException(413, "Send one JPEG or PNG under 12 MB.")
    w[1].set_result(("ok", data))
    return {"ok": True}


@router.post("/result/{rid}")
async def result(rid: str, id: str, req: Request):
    """A helper's answer to anything other than a screenshot (browser actions): one JSON object."""
    s = _mine(id, req)
    w = _waiting.get(rid)
    if not w or w[0] != s.id or w[1].done():
        raise HTTPException(404, "Nobody is waiting for that result any more.")
    body = await req.body()
    if len(body) > MAX_FRAME * 2:
        raise HTTPException(413, "Result too large.")
    try:
        data = json.loads(body)
    except ValueError:
        raise HTTPException(400, "Send JSON.")
    w[1].set_result(("json", data if isinstance(data, dict) else {"ok": False, "error": "bad result"}))
    return {"ok": True}


@router.post("/disconnect")
async def disconnect(id: str, req: Request):
    _mine(id, req)
    _drop(id)
    return {"ok": True}


def _drop(sid: str):
    s = _sources.pop(sid, None)
    if not s:
        return
    for rid, (src, fut) in list(_waiting.items()):
        if src == sid and not fut.done():
            fut.set_result(("error", "The screen stopped being shared."))


@router.get("/sources")
def sources(req: Request):
    auth.require_admin(req)
    return [s.public() for s in live_sources()]


@router.delete("/sources/{sid}")
def stop_source(sid: str, req: Request):
    """The owner ends any share from Settings, e.g. a helper left running on another machine."""
    auth.require_admin(req)
    _drop(sid)
    return {"ok": True}


# ── pairing ─────────────────────────────────────────────────────────────────

@router.get("/devices")
def devices(req: Request):
    auth.require_admin(req)
    live = {s.owner.split(":", 1)[1] for s in live_sources() if s.kind == "helper"}
    return [{"id": k, "name": v.get("name", ""), "created": v.get("created"), "lastSeen": v.get("lastSeen"),
             "connected": k in live} for k, v in _devices().items()]


@router.post("/devices")
async def pair(req: Request):
    """A new device token, baked into a copy of the helper script. The token is shown (and downloadable) only once."""
    auth.require_admin(req)
    body = await req.json()
    name = re.sub(r"\s+", " ", str(body.get("name") or "")).strip()[:60] or "My computer"
    token = "sbs_" + secrets.token_urlsafe(32)
    did = "dev-" + uuid.uuid4().hex[:8]
    devs = _devices()
    devs[did] = {"name": name, "hash": _hash(token), "created": time.time()}
    _save_devices(devs)
    # the tailnet address first: the page may be open through Cloudflare Access, which a script can't get past
    url = os.environ.get("SHELLB_SECURE_URL", "") or str(body.get("url") or "").strip()
    return {"id": did, "name": name, "token": token, "url": url, "script": helper_script(url, token, name)}


@router.delete("/devices/{did}")
def unpair(did: str, req: Request):
    auth.require_admin(req)
    devs = _devices()
    if devs.pop(did, None) is None:
        raise HTTPException(404, "No such device.")
    _save_devices(devs)
    for s in [s for s in _sources.values() if s.owner == f"device:{did}"]:
        _drop(s.id)
    return {"ok": True}


def helper_script(url: str, token: str, name: str) -> str:
    src = HELPER.read_text()
    return (src.replace('DEFAULT_URL = ""', f"DEFAULT_URL = {url.rstrip('/')!r}", 1)
               .replace('DEFAULT_TOKEN = ""', f"DEFAULT_TOKEN = {token!r}", 1)
               .replace('DEFAULT_NAME = ""', f"DEFAULT_NAME = {name!r}", 1))


@router.get("/helper.py")
def helper_plain(req: Request):
    """The helper without a token (for reading, or with --token)."""
    auth.require_admin(req)
    return Response(HELPER.read_text(), media_type="text/x-python",
                    headers={"content-disposition": 'attachment; filename="shellb_screen.py"'})


# ── the tool ────────────────────────────────────────────────────────────────

def _pick(want: str) -> Source | None:
    live = [s for s in live_sources() if s.screen]
    if not want:
        return live[0] if live else None
    w = want.lower()
    return next((s for s in live if s.id == want), None) \
        or next((s for s in live if w in s.name.lower() or w in s.label.lower() or w == s.kind), None)


async def send(src: Source, payload: dict, timeout: float):
    """Hand a request to a source and wait for its answer: ("ok", image bytes), ("json", dict) or ("error", text)."""
    rid = uuid.uuid4().hex
    fut = asyncio.get_running_loop().create_future()
    _waiting[rid] = (src.id, fut)
    try:
        src.queue.put_nowait({"rid": rid, **payload})
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise RuntimeError(f"{src.name} didn't answer within {int(timeout)} s. "
                               + ("The sharing tab may be asleep or closed." if src.kind == "browser"
                                  else "The helper may have stopped."))
    finally:
        _waiting.pop(rid, None)


async def capture(src: Source, monitor: int | None, timeout: float = ANSWER) -> bytes:
    status, data = await send(src, {"monitor": monitor, "maxEdge": 2560}, timeout)
    if status != "ok":
        raise RuntimeError(f"{src.name}: {data}")
    src.looks += 1
    return data


async def look_at_screen(args, ctx) -> ToolResult:
    from PIL import Image
    import projects as P
    args = args if isinstance(args, dict) else {}
    if str(args.get("action") or "").lower() == "list":
        return ToolResult(f"Shared screens: {describe()}" if available() else "No screen is being shared right now.")
    src = _pick(str(args.get("screen") or "").strip())
    if not src:
        return ToolResult("No screen is being shared right now" + (f" that matches {args.get('screen')!r}" if args.get("screen") else "")
                          + ". Ask the user to press the screen button by the message box and pick 'Share screen live', "
                          "or to start the Shell:B Screen helper on their computer.", error=True)
    try:
        mon = int(args["monitor"]) if args.get("monitor") not in (None, "") else None
    except (TypeError, ValueError):
        mon = None
    try:
        raw = await capture(src, mon)
        im = Image.open(io.BytesIO(raw))
        size = im.size
        im = im.convert("RGB")
    except RuntimeError as e:
        return ToolResult(str(e), error=True)
    except Exception as e:
        return ToolResult(f"The screen sent something that isn't a picture ({type(e).__name__}).", error=True)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    d = WORKSPACES / ctx.conv_id / "screen"
    d.mkdir(parents=True, exist_ok=True)
    name = f"{stamp}-{uuid.uuid4().hex[:4]}.jpg"
    (d / name).write_bytes(buf.getvalue())
    model = base64.b64encode(P.downscale(buf.getvalue(), MODEL_EDGE if size[0] >= size[1] else
                                         round(MODEL_EDGE * size[0] / size[1]), "JPEG")).decode()
    what = f"{src.name} ({src.label}" + (f", monitor {mon}" if mon is not None else "") + ")"
    return ToolResult(f"Screenshot of {what} at {time.strftime('%H:%M:%S')}, {size[0]}×{size[1]}, saved as "
                      f"/work/screen/{name}. It is already shown to the user; describe or act on what you see.",
                      {"images": [f"/api/workspace/{ctx.conv_id}/screen/{name}"]}, model_images=[model])


def register():
    TOOLS["look_at_screen"] = {
        "fn": look_at_screen, "service": None, "scope": "global", "auto": "in live chats while a screen is shared, for vision models (cloud agents need Cloud → Screen)",
        "ui": {"displayName": "Look at Screen", "icon": "MonitorUp", "category": "media",
               "description": "While you share your screen (from the chat, or with the Shell:B Screen helper), agents that can see "
                              "may take a look when it helps."},
        "schema": _fn("look_at_screen",
                      "Take a screenshot of the user's shared screen right now and look at it. Use it when they refer to "
                      "something on their screen or ask for help with what they're doing.",
                      {"action": {"type": "string", "enum": ["look", "list"], "description": "look (default) or list the shared screens"},
                       "screen": {"type": "string", "description": "Which shared screen, by id or name; default: the most recent share"},
                       "monitor": {"type": "integer", "description": "Helper only: monitor number (1 = primary, 0 = all monitors together)"}},
                      []),
    }

