"""Fleet (#/models/fleet): other machines that run Shell:B's local models, so the work spreads past the DGX Spark.

The agent loop, tools, memory and data all stay on the Spark. Only model calls travel: every Ollama request goes
through `stream()` / `post()` here, which pick a machine that has the model, is up and has a free slot, and fall back
to the Spark when a machine can't be reached. Nothing else changes for callers: the response is Ollama's own.

A fleet machine ("node") is one of:
- `agent`: it runs clients/shellb_node.py, a stdlib-only helper that relays to the Ollama on that machine (which
  stays on 127.0.0.1 there) and reports its hardware. Every request carries the node's own bearer token.
- `ollama`: a bare Ollama URL, for a machine whose Ollama already listens on a network you trust. No token, no stats.

Routing (`mode`):
- `off`: everything stays on the Spark.
- `overflow` (default): the Spark first; a request goes to another machine only while the Spark's slots are full
  (Ollama runs OLLAMA_NUM_PARALLEL requests at once; the rest queue) or the Spark doesn't have the model.
- `spread`: every request goes to the least busy machine that has the model; a machine that already has the model
  loaded wins a tie, and the Spark wins a full tie (no network hop).

Privacy: incognito chats and the adult agent never leave the Spark unless a node is marked `private` (a machine the
owner treats as their own as much as the Spark). Guest cells never use the fleet: they reach the host's Ollama
through the cell gateway (cells.py), and cell_boot sets CELL so `route()` keeps them local.

Nodes, tokens and the mode live in data/fleet/nodes.json (0600). Managing them needs the owner (remote.require_admin).
"""
import asyncio
import hmac
import json
import os
import re
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse

import auth
import db
from tools import OLLAMA

router = APIRouter(prefix="/api/fleet")

FLEET = db.DATA / "fleet"
FLEET.mkdir(mode=0o700, exist_ok=True)
NODES = FLEET / "nodes.json"
AGENT_SCRIPT = Path(__file__).resolve().parent.parent / "clients" / "shellb_node.py"
LOCAL = "local"
LOCAL_NAME = "DGX Spark"
MODES = ("off", "overflow", "spread")
POLL = 10           # seconds between health checks
AGENT_PORT = 8211   # clients/shellb_node.py default
PROXY_PATHS = re.compile(r"^/api/(chat|generate|embed|embeddings|show|tags|ps|version|pull|create|delete)$")

_status: dict[str, dict] = {}   # node id → {up, error, seen, latencyMs, models, loaded, info}
_inflight: dict[str, int] = {}  # node id → requests running there now (counted by stream/post)
_served: dict[str, int] = {}    # node id → requests served since start
_jobs: dict[tuple[str, str], dict] = {}  # (node id, model) → copy progress
_poller: asyncio.Task | None = None


# ── configuration ───────────────────────────────────────────────────────────

def _load() -> dict:
    try:
        cfg = json.loads(NODES.read_text())
    except (OSError, ValueError):
        cfg = {}
    cfg.setdefault("mode", "overflow")
    cfg.setdefault("localSlots", int(os.environ.get("SHELLB_LOCAL_SLOTS", "2")))
    cfg.setdefault("nodes", [])
    return cfg


def _save(cfg: dict):
    tmp = NODES.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2))
    tmp.chmod(0o600)
    tmp.replace(NODES)


def _node(cfg: dict, nid: str) -> dict:
    n = next((n for n in cfg["nodes"] if n["id"] == nid), None)
    if not n:
        raise HTTPException(404, "No such machine")
    return n


def _norm(model: str) -> str:
    """Ollama's own name matching: case-insensitive, ':latest' when no tag is given."""
    m = (model or "").strip().lower()
    return m if ":" in m.rsplit("/", 1)[-1] else m + ":latest"


def _base(n: dict) -> str:
    return n["url"].rstrip("/") + ("/ollama" if n.get("kind", "agent") == "agent" else "")


def _headers(n: dict) -> dict:
    return {"Authorization": f"Bearer {n['token']}"} if n.get("kind", "agent") == "agent" and n.get("token") else {}


def _local() -> dict:
    return {"id": LOCAL, "name": LOCAL_NAME, "url": OLLAMA, "kind": "local", "enabled": True,
            "slots": _load()["localSlots"], "private": True}


def _url(n: dict, path: str) -> str:
    return f"{OLLAMA}{path}" if n["id"] == LOCAL else f"{_base(n)}{path}"


# ── routing ─────────────────────────────────────────────────────────────────

def _has(nid: str, model: str) -> bool | None:
    """True/False when the node's model list is known, None when it isn't (never polled yet)."""
    s = _status.get(nid)
    if not s or s.get("models") is None:
        return None
    return _norm(model) in s["models"]


def route(model: str, *, private: bool = False, light: bool = False) -> list[dict]:
    """Machines to try for one request, best first. The Spark is always in the list (last if nothing else fits) so a
    request never fails just because the fleet is down. `light` calls (model metadata) prefer the Spark."""
    local = _local()
    cfg = _load()
    if auth.CELL or cfg["mode"] == "off" or not cfg["nodes"]:
        return [local]
    remotes = [n for n in cfg["nodes"] if n.get("enabled", True) and _status.get(n["id"], {}).get("up")
               and _has(n["id"], model) and (not private or n.get("private"))]
    local_has = _has(LOCAL, model) is not False
    if not remotes:
        return [local]
    if light and local_has:
        return [local] + remotes

    def load(n):
        return _inflight.get(n["id"], 0) / max(1, int(n.get("slots") or 1))

    def cold(n):
        return _norm(model) not in (_status.get(n["id"], {}).get("loaded") or ())

    if cfg["mode"] == "overflow":
        if local_has and _inflight.get(LOCAL, 0) < local["slots"]:
            return [local] + sorted(remotes, key=lambda n: (load(n) >= 1, cold(n), load(n)))
        ranked = sorted(remotes, key=lambda n: (load(n) >= 1, cold(n), load(n)))
        # every machine full: queue where the model is warm and the queue is shortest, the Spark included
        if local_has and all(load(n) >= 1 for n in remotes):
            ranked = sorted(ranked + [local], key=lambda n: (load(n), cold(n), n["id"] != LOCAL))
        return ranked + ([] if local in ranked else [local])
    pool = remotes + ([local] if local_has else [])
    ranked = sorted(pool, key=lambda n: (load(n), cold(n), n["id"] != LOCAL))
    return ranked + ([] if any(n["id"] == LOCAL for n in ranked) else [local])


def _mark_down(n: dict, err: str):
    if n["id"] == LOCAL:
        return
    s = _status.setdefault(n["id"], {})
    s.update(up=False, error=err[:300], downAt=time.time())


def _failover_error(e: Exception) -> bool:
    return isinstance(e, (httpx.ConnectError, httpx.ConnectTimeout, httpx.RemoteProtocolError, httpx.ReadError,
                          httpx.WriteError, httpx.PoolTimeout))


@asynccontextmanager
async def stream(path: str, body: dict, *, timeout, private: bool = False):
    """POST a streaming Ollama call to the best machine; yields the open httpx.Response (Ollama's own NDJSON).
    `r.extensions['fleet_node']` names the machine. Falls over to the next machine only before anything is read."""
    last: Exception | None = None
    for n in route(body.get("model", ""), private=private):
        c = httpx.AsyncClient(timeout=timeout)
        try:
            r = await c.send(c.build_request("POST", _url(n, path), json=body, headers=_headers(n)), stream=True)
        except Exception as e:  # noqa: BLE001
            await c.aclose()
            if n["id"] != LOCAL and _failover_error(e):
                _mark_down(n, f"{type(e).__name__}: {e}")
                last = e
                continue
            raise
        if n["id"] != LOCAL and r.status_code in (401, 502, 503, 504):  # helper up but Ollama there isn't (or bad token)
            _mark_down(n, f"HTTP {r.status_code}: {(await r.aread()).decode(errors='replace')[:200]}")
            await r.aclose()
            await c.aclose()
            continue
        r.extensions["fleet_node"] = n["name"]
        _inflight[n["id"]] = _inflight.get(n["id"], 0) + 1
        _served[n["id"]] = _served.get(n["id"], 0) + 1
        try:
            yield r
        finally:
            _inflight[n["id"]] -= 1
            await r.aclose()
            await c.aclose()
        return
    raise last or RuntimeError("No machine could take the request")


async def post(path: str, body: dict, *, timeout=60, private: bool = False, light: bool = False) -> httpx.Response:
    """A non-streaming Ollama call (stream:false chats, embeddings, /api/show) on the best machine. Since nothing has
    reached the caller yet, any network failure on a fleet machine retries on the next one."""
    last: Exception | None = None
    for n in route(body.get("model", ""), private=private, light=light):
        _inflight[n["id"]] = _inflight.get(n["id"], 0) + 1
        try:
            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.post(_url(n, path), json=body, headers=_headers(n))
        except Exception as e:  # noqa: BLE001
            if n["id"] != LOCAL and (_failover_error(e) or isinstance(e, httpx.TimeoutException)):
                _mark_down(n, f"{type(e).__name__}: {e}")
                last = e
                continue
            raise
        finally:
            _inflight[n["id"]] -= 1
        if n["id"] != LOCAL and r.status_code in (401, 502, 503, 504):
            _mark_down(n, f"HTTP {r.status_code}: {r.text[:200]}")
            continue
        r.extensions["fleet_node"] = n["name"]
        _served[n["id"]] = _served.get(n["id"], 0) + 1
        return r
    raise last or RuntimeError("No machine could take the request")


def remote_models() -> dict[str, list[str]]:
    """Models only fleet machines have: normalized name → names of the machines that have it (for the model list)."""
    local = (_status.get(LOCAL) or {}).get("models") or set()
    cfg = _load()
    if cfg["mode"] == "off":
        return {}
    out: dict[str, list[str]] = {}
    for n in cfg["nodes"]:
        s = _status.get(n["id"]) or {}
        if n.get("enabled", True) and s.get("up"):
            for m in s.get("models") or ():
                if m not in local:
                    out.setdefault((s.get("names") or {}).get(m, m), []).append(n["name"])
    return out


# ── health ──────────────────────────────────────────────────────────────────

async def _probe(n: dict) -> dict:
    t0 = time.monotonic()
    async with httpx.AsyncClient(timeout=httpx.Timeout(6, connect=4)) as c:
        if n["id"] == LOCAL:
            tags = (await c.get(f"{OLLAMA}/api/tags")).json().get("models", [])
            ps = (await c.get(f"{OLLAMA}/api/ps")).json().get("models", [])
            info = {"os": "Linux", "memory": _meminfo()}
        elif n.get("kind", "agent") == "agent":
            r = await c.get(n["url"].rstrip("/") + "/node/info", headers=_headers(n))
            if r.status_code == 401:
                raise RuntimeError("the machine refused the token (run the setup command again, or make a new token)")
            r.raise_for_status()
            info = r.json()
            if not (info.get("ollama") or {}).get("up"):
                raise RuntimeError(f"the helper runs, but Ollama there doesn't answer: {(info.get('ollama') or {}).get('error', '')}")
            tags, ps = info.pop("tags", []), info.pop("ps", [])
        else:
            ver = (await c.get(f"{_base(n)}/api/version")).json()
            tags = (await c.get(f"{_base(n)}/api/tags")).json().get("models", [])
            ps = (await c.get(f"{_base(n)}/api/ps")).json().get("models", [])
            info = {"ollama": {"up": True, "version": ver.get("version")}}
    return {"up": True, "error": "", "seen": time.time(), "latencyMs": int((time.monotonic() - t0) * 1000),
            "models": {_norm(m["name"]) for m in tags}, "sizes": {_norm(m["name"]): m.get("size", 0) for m in tags},
            "names": {_norm(m["name"]): m["name"].removesuffix(":latest") for m in tags},
            "loaded": {_norm(m["name"]) for m in ps},
            "loadedDetail": [{"name": m["name"], "size": m.get("size", 0), "vram": m.get("size_vram", 0)} for m in ps],
            "info": info}


def _meminfo() -> dict:
    m = {}
    try:
        for line in open("/proc/meminfo"):
            k, v = line.split(":", 1)
            m[k] = int(v.split()[0]) * 1024
    except OSError:
        pass
    return {"total": m.get("MemTotal", 0), "available": m.get("MemAvailable", 0)}


async def poll_once():
    nodes = [_local()] + [n for n in _load()["nodes"]]

    async def one(n):
        try:
            s = await _probe(n)
        except Exception as e:  # noqa: BLE001
            prev = _status.get(n["id"]) or {}
            s = {**prev, "up": False, "error": str(e)[:300] or type(e).__name__, "downAt": prev.get("downAt") or time.time()}
        _status[n["id"]] = s

    await asyncio.gather(*(one(n) for n in nodes))
    for nid in set(_status) - {n["id"] for n in nodes}:
        _status.pop(nid, None)


async def _loop():
    while True:
        try:
            await poll_once()
        except Exception as e:  # noqa: BLE001
            print(f"fleet: poll failed: {e}")
        await asyncio.sleep(POLL)


def start():
    global _poller
    if auth.CELL or (_poller and not _poller.done()):
        return
    _poller = asyncio.create_task(_loop())


# ── copying models to a machine ─────────────────────────────────────────────

def _params(text: str) -> dict:
    """/api/show's parameters text → /api/create's parameters map (stop can repeat)."""
    out: dict = {}
    for line in (text or "").splitlines():
        k, _, v = line.strip().partition(" ")
        v = v.strip().strip('"')
        if not k or not v:
            continue
        try:
            val: object = int(v)
        except ValueError:
            try:
                val = float(v)
            except ValueError:
                val = v
        if k == "stop":
            out.setdefault("stop", []).append(val)
        else:
            out[k] = val
    return out


async def _node_stream(n: dict, path: str, body: dict, job: dict):
    """Run a streaming /api/pull or /api/create on a machine, mirroring its progress into `job`."""
    async with httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10)) as c:
        async with c.stream("POST", _url(n, path), json={**body, "stream": True}, headers=_headers(n)) as r:
            if r.status_code != 200:
                raise RuntimeError(f"{r.status_code}: {(await r.aread()).decode(errors='replace')[:300]}")
            async for line in r.aiter_lines():
                if job.get("cancel"):
                    raise asyncio.CancelledError
                if not line.strip():
                    continue
                d = json.loads(line)
                if d.get("error"):
                    raise RuntimeError(d["error"])
                job["status"] = d.get("status", job["status"])
                if d.get("total"):
                    job["total"], job["completed"] = d["total"], d.get("completed", 0)


async def _copy(n: dict, model: str, job: dict):
    """Give a machine the same model the Spark has. Registry models are pulled there. Models built here (ShellB-*,
    FROM a local blob) are rebuilt there: pull the parent, then /api/create with the same system prompt, template,
    renderer, parser and parameters, so the copy answers the same way."""
    try:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"{OLLAMA}/api/show", json={"model": model})
        if r.status_code != 200:
            raise RuntimeError(f"The Spark doesn't have {model}")
        d = r.json()
        mf = d.get("modelfile") or ""
        frm = next((ln[5:].strip() for ln in mf.splitlines() if ln.startswith("FROM ")), "")
        built_here = frm.startswith("/") or "sha256" in frm
        if not built_here:
            job["status"] = "downloading"
            await _node_stream(n, "/api/pull", {"model": model}, job)
        else:
            parent = (d.get("details") or {}).get("parent_model") or ""
            if not parent:
                raise RuntimeError(f"{model} was built from a local file, not from a downloadable model, so it can't be "
                                   "copied over the network yet. Pull its source model on that machine by hand.")
            job["status"] = f"downloading {parent}"
            await _node_stream(n, "/api/pull", {"model": parent}, job)
            body = {"model": model, "from": parent, "parameters": _params(d.get("parameters", ""))}
            for k in ("system", "template", "license"):
                if d.get(k):
                    body[k] = d[k] if k != "license" else [d[k]]
            for ln in mf.splitlines():
                key, _, val = ln.partition(" ")
                if key in ("RENDERER", "PARSER") and val.strip():
                    body[key.lower()] = val.strip()
            job.update(status=f"building {model}", total=0, completed=0)
            await _node_stream(n, "/api/create", body, job)
        job.update(state="done", status="ready", finished=time.time())
        await poll_once()
    except asyncio.CancelledError:
        job.update(state="cancelled", status="cancelled", finished=time.time())
    except Exception as e:  # noqa: BLE001
        job.update(state="error", error=str(e)[:400], finished=time.time())


# ── API ─────────────────────────────────────────────────────────────────────

def _public(n: dict) -> dict:
    s = _status.get(n["id"]) or {}
    models = sorted(s.get("models") or ())
    return {**{k: v for k, v in n.items() if k != "token"}, "hasToken": bool(n.get("token")),
            "up": bool(s.get("up")), "error": s.get("error", ""), "seen": s.get("seen"), "latencyMs": s.get("latencyMs"),
            "models": [{"name": (s.get("names") or {}).get(m) or m.removesuffix(":latest"), "size": (s.get("sizes") or {}).get(m, 0)}
                       for m in models],
            "loaded": s.get("loadedDetail") or [], "info": s.get("info") or {},
            "inflight": _inflight.get(n["id"], 0), "served": _served.get(n["id"], 0)}


def _secure_url(req: Request) -> str:
    return os.environ.get("SHELLB_SECURE_URL") or str(req.base_url).rstrip("/")


def setup(req: Request, n: dict) -> dict:
    """What to run on the machine, for both shells. The helper is fetched with the node's own token."""
    base, tok, port = _secure_url(req), n.get("token", ""), _port(n["url"])
    return {
        "linux": (f"curl -fsS -H 'X-Fleet-Token: {tok}' {base}/api/fleet/agent -o shellb_node.py && "
                  f"python3 shellb_node.py --token {tok} --port {port}"),
        "windows": (f"iwr -UseBasicParsing -Headers @{{'X-Fleet-Token'='{tok}'}} {base}/api/fleet/agent -OutFile shellb_node.py; "
                    f"python shellb_node.py --token {tok} --port {port}"),
        "service": f"python3 shellb_node.py --token {tok} --port {port} --install-service",
    }


def _port(url: str) -> int:
    m = re.search(r":(\d+)(/|$)", url.split("//", 1)[-1])
    return int(m.group(1)) if m else AGENT_PORT


def _clean_url(raw: str, kind: str) -> str:
    u = (raw or "").strip().rstrip("/")
    if not u:
        raise HTTPException(400, "Enter the machine's address, e.g. evie-home or 100.100.215.122")
    if "://" not in u:
        u = "http://" + u
    if not re.match(r"^https?://[\w.\-\[\]:]+$", u):
        raise HTTPException(400, "The address should be a host name or IP, with an optional port")
    if not re.search(r":\d+$", u.split("//", 1)[1]):
        u += f":{AGENT_PORT if kind == 'agent' else 11434}"
    return u


@router.get("")
async def overview():
    cfg = _load()
    if LOCAL not in _status:
        await poll_once()
    return {"mode": cfg["mode"], "localSlots": cfg["localSlots"], "cell": auth.CELL,
            "local": _public(_local()), "nodes": [_public(n) for n in cfg["nodes"]],
            "jobs": [{"node": k[0], "model": k[1], **{x: y for x, y in v.items() if x != "task"}} for k, v in _jobs.items()]}


@router.put("/config")
async def set_config(req: Request):
    auth.require_admin(req)
    body = await req.json()
    cfg = _load()
    if "mode" in body:
        if body["mode"] not in MODES:
            raise HTTPException(400, f"mode must be one of {', '.join(MODES)}")
        cfg["mode"] = body["mode"]
    if "localSlots" in body:
        cfg["localSlots"] = max(1, min(16, int(body["localSlots"])))
    _save(cfg)
    db.audit_log("fleet:config", {"mode": cfg["mode"], "localSlots": cfg["localSlots"]})
    return await overview()


@router.post("/nodes")
async def add_node(req: Request):
    auth.require_admin(req)
    body = await req.json()
    kind = body.get("kind", "agent")
    if kind not in ("agent", "ollama"):
        raise HTTPException(400, "kind must be agent or ollama")
    url = _clean_url(body.get("url", ""), kind)
    cfg = _load()
    if any(n["url"] == url for n in cfg["nodes"]):
        raise HTTPException(409, "That machine is already in the fleet")
    host = url.split("//", 1)[1].rsplit(":", 1)[0]
    n = {"id": "node-" + uuid.uuid4().hex[:10], "name": (body.get("name") or host).strip()[:40], "url": url, "kind": kind,
         "token": secrets.token_urlsafe(24) if kind == "agent" else "", "enabled": True,
         "slots": max(1, min(16, int(body.get("slots") or 1))), "private": bool(body.get("private")), "added": time.time()}
    cfg["nodes"].append(n)
    _save(cfg)
    db.audit_log("fleet:add", {"id": n["id"], "name": n["name"], "url": url, "kind": kind})
    asyncio.create_task(poll_once())
    return {"node": _public(n), "setup": setup(req, n) if kind == "agent" else None}


@router.get("/nodes/{nid}/setup")
def node_setup(nid: str, req: Request):
    auth.require_admin(req)
    n = _node(_load(), nid)
    if n.get("kind") != "agent":
        raise HTTPException(400, "Only helper machines have a setup command")
    return setup(req, n)


@router.post("/nodes/{nid}/token")
def new_token(nid: str, req: Request):
    auth.require_admin(req)
    cfg = _load()
    n = _node(cfg, nid)
    if n.get("kind") != "agent":
        raise HTTPException(400, "Only helper machines use a token")
    n["token"] = secrets.token_urlsafe(24)
    _save(cfg)
    db.audit_log("fleet:token", {"id": nid})
    return setup(req, n)


@router.patch("/nodes/{nid}")
async def patch_node(nid: str, req: Request):
    auth.require_admin(req)
    body = await req.json()
    cfg = _load()
    n = _node(cfg, nid)
    if "name" in body and str(body["name"]).strip():
        n["name"] = str(body["name"]).strip()[:40]
    if "enabled" in body:
        n["enabled"] = bool(body["enabled"])
    if "private" in body:
        n["private"] = bool(body["private"])
    if "slots" in body:
        n["slots"] = max(1, min(16, int(body["slots"])))
    if "url" in body:
        n["url"] = _clean_url(body["url"], n.get("kind", "agent"))
    _save(cfg)
    db.audit_log("fleet:edit", {"id": nid, **{k: v for k, v in body.items() if k in ("name", "enabled", "private", "slots", "url")}})
    asyncio.create_task(poll_once())
    return _public(n)


@router.delete("/nodes/{nid}")
def delete_node(nid: str, req: Request):
    auth.require_admin(req)
    cfg = _load()
    n = _node(cfg, nid)
    cfg["nodes"] = [x for x in cfg["nodes"] if x["id"] != nid]
    _save(cfg)
    _status.pop(nid, None)
    for k in [k for k in _jobs if k[0] == nid]:
        _jobs[k]["cancel"] = True
        _jobs.pop(k)
    db.audit_log("fleet:remove", {"id": nid, "name": n["name"]})
    return {"ok": True}


@router.post("/nodes/{nid}/models")
async def copy_model(nid: str, req: Request):
    auth.require_admin(req)
    n = _node(_load(), nid)
    model = ((await req.json()).get("model") or "").strip()
    if not model:
        raise HTTPException(400, "model is required")
    key = (nid, _norm(model).removesuffix(":latest"))
    if key in _jobs and _jobs[key]["state"] == "running":
        return {"ok": True}
    job = {"state": "running", "status": "starting", "completed": 0, "total": 0, "error": "", "started": time.time()}
    _jobs[key] = job
    job["task"] = asyncio.create_task(_copy(n, model, job))
    db.audit_log("fleet:copy", {"id": nid, "model": model})
    return {"ok": True}


@router.post("/jobs/cancel")
async def cancel_job(req: Request):
    auth.require_admin(req)
    b = await req.json()
    job = _jobs.get((b.get("node", ""), b.get("model", "")))
    if job and job["state"] == "running":
        job["cancel"] = True
        job["task"].cancel()
    return {"ok": True}


@router.post("/jobs/dismiss")
async def dismiss_job(req: Request):
    auth.require_admin(req)
    b = await req.json()
    k = (b.get("node", ""), b.get("model", ""))
    if k in _jobs and _jobs[k]["state"] != "running":
        _jobs.pop(k)
    return {"ok": True}


@router.delete("/nodes/{nid}/models/{model:path}")
async def remove_model(nid: str, model: str, req: Request):
    auth.require_admin(req)
    n = _node(_load(), nid)
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.request("DELETE", _url(n, "/api/delete"), json={"model": model}, headers=_headers(n))
    if r.status_code != 200:
        raise HTTPException(502, f"{n['name']}: {r.text[:200]}")
    db.audit_log("fleet:delete-model", {"id": nid, "model": model})
    await poll_once()
    return {"ok": True}


@router.get("/agent")
def agent_script(req: Request):
    """The helper script. Open to a fleet machine presenting its own token (auth.PUBLIC lets this path through), so the
    setup command can fetch it; otherwise the owner."""
    given = req.headers.get("x-fleet-token", "")
    ok = bool(given) and any(n.get("token") and hmac.compare_digest(given, n["token"]) for n in _load()["nodes"])
    if not ok and not auth.is_admin(req):
        raise HTTPException(403, "A fleet token or the owner is required")
    return PlainTextResponse(AGENT_SCRIPT.read_text(), headers={"Content-Disposition": "attachment; filename=shellb_node.py"})
