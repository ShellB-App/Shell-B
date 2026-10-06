"""Generate: make images (NYX / FLUX), music (ORPHEUS / MusicGen) and sound effects (Stable Audio, or AudioGen on ORPHEUS
when it is down) straight from the #/generate playground, without an LLM turn.

A job is one prompt × N variations. Jobs run as asyncio tasks, one at a time per service (each service has its own FIFO
lock), so FLUX never runs twice over and a music job doesn't wait behind an image job. The workflows, post-processing and
file locations are the agent tools' own (tools._flux_workflow / _comfy_run, studio_assets.save_output / trim_and_fade),
so a result here is the same file a chat would have produced. Every result is filed in the Media gallery with its seed
and params (meta.via = "generate"); that table is the playground's history, and its /api/media/{id}/to-assets copies a
keeper into an asset library. Job state itself is in memory: a restart forgets queued jobs, never finished files.
"""
import asyncio
import json
import random
import time
import uuid
from types import SimpleNamespace

import httpx
from fastapi import APIRouter, HTTPException, Request

import db
import media
import roster
from tools import COMFY, FILES, ORPHEUS, _comfy_run, _flux_workflow, _snap, flux_dev_available, make_room
from studio_assets import STABLE_AUDIO, make_loop, save_output, slug, trim_and_fade, _duration

router = APIRouter(prefix="/api/generate")

KINDS = {"image": "nyx", "music": "orpheus", "sfx": "stableaudio"}
TOOL = {"image": "generate_image", "music": "generate_music", "sfx": "generate_sfx"}  # Media's labels for these
MAX_COUNT = 4
MAX_JOBS = 60          # finished jobs kept in memory for the job list
_jobs: dict[str, dict] = {}
_tasks: dict[str, asyncio.Task] = {}
_locks: dict[str, asyncio.Lock] = {}
_svc_cache: tuple[float, dict] = (0.0, {})


def _lock(service: str) -> asyncio.Lock:
    if service not in _locks:
        _locks[service] = asyncio.Lock()
    return _locks[service]


# ── services ────────────────────────────────────────────────────────────────

async def services(fresh: bool = False) -> dict:
    """Up/down for the three generators. /api/status has no Stable Audio probe, so this asks all three itself."""
    global _svc_cache
    if not fresh and time.time() - _svc_cache[0] < 10:
        return _svc_cache[1]

    async def probe(c, url):
        try:
            return {"ok": (await c.get(url, timeout=3)).status_code == 200}
        except httpx.HTTPError as e:
            return {"ok": False, "error": type(e).__name__}
    async with httpx.AsyncClient() as c:
        nyx, orpheus, stable = await asyncio.gather(probe(c, f"{COMFY}/system_stats"), probe(c, f"{ORPHEUS}/health"),
                                                    probe(c, f"{STABLE_AUDIO}/health"))
    out = {"nyx": nyx, "orpheus": orpheus, "stableaudio": stable, "fluxDev": flux_dev_available()}
    _svc_cache = (time.time(), out)
    return out


# ── params ──────────────────────────────────────────────────────────────────

def _params(kind: str, p: dict) -> dict:
    """Clamp what the UI sent to what each service accepts. A seed of None means pick one."""
    p = p or {}
    seed = p.get("seed")
    seed = int(seed) % 2**31 if isinstance(seed, (int, float)) or (isinstance(seed, str) and seed.strip().isdigit()) else None
    if kind == "image":
        quality = "high" if p.get("quality") == "high" and flux_dev_available() else "draft"
        steps = max(1, min(50 if quality == "high" else 8, int(p.get("steps") or (24 if quality == "high" else 4))))
        return {"seed": seed, "width": _snap(p.get("width") or 1024, 256, 1536), "height": _snap(p.get("height") or 1024, 256, 1536),
                "steps": steps, "quality": quality}
    if kind == "music":
        return {"duration": max(3.0, min(30.0, float(p.get("duration") or 12))),
                "guidance": max(1.0, min(10.0, float(p.get("guidance") or 3.0))), "loop": bool(p.get("loop"))}
    return {"seed": seed, "duration": max(0.5, min(46.0, float(p.get("duration") or 4))),
            "steps": max(10, min(250, int(p.get("steps") or 100))), "loop": bool(p.get("loop"))}


def _public(j: dict) -> dict:
    ahead = 0
    if j["status"] == "queued":
        ahead = sum(1 for o in _jobs.values() if o["service"] == j["service"] and o["status"] in ("queued", "running")
                    and o["created"] < j["created"])
    return {**{k: v for k, v in j.items() if not k.startswith("_")}, "ahead": ahead}


# ── generation ──────────────────────────────────────────────────────────────

def _file(kind: str, url: str, prompt: str, meta: dict) -> str | None:
    """Files a result in the Media gallery and returns its id (for Save to library)."""
    try:
        with db.conn() as c:
            media._insert(c, url, "image" if kind == "image" else "audio", TOOL[kind], prompt, None, None, None,
                          {"via": "generate", **meta}, time.time())
            r = c.execute("SELECT id FROM media WHERE url=?", (url,)).fetchone()
        return r["id"] if r else None
    except Exception as e:  # noqa: BLE001 — the file exists either way
        print(f"generate: media insert failed: {type(e).__name__}: {e}")
        return None


async def _image(c: httpx.AsyncClient, j: dict, seed: int) -> dict:
    p = j["params"]
    wf = _flux_workflow(j["prompt"], p["width"], p["height"], seed, p["quality"])
    wf["8"]["inputs"]["steps"] = p["steps"]
    wf["10"]["inputs"]["filename_prefix"] = "ShellB_Generate"
    t0 = time.time()
    outputs = await _comfy_run(c, wf, 600)
    item = next((im for n in outputs.values() for im in n.get("images", [])), None)
    if not item:
        raise RuntimeError("ComfyUI finished without an image.")
    data = (await c.get(f"{COMFY}/view", params={"filename": item["filename"], "subfolder": item.get("subfolder", ""),
                                                 "type": item.get("type", "output")})).content
    name = f"img-{uuid.uuid4().hex[:12]}.png"
    (FILES / name).write_bytes(data)
    model = "FLUX.1-dev" if p["quality"] == "high" else "FLUX.1-schnell"
    return {"url": f"/api/files/{name}", "seed": seed, "model": model, "elapsed": round(time.time() - t0, 1)}


async def _music(c: httpx.AsyncClient, j: dict) -> dict:
    p = j["params"]
    r = await c.post(f"{ORPHEUS}/generate", json={"prompt": j["prompt"], "cfg_coef": p["guidance"],
                                                  "duration": min(30.0, p["duration"] + (2 if p["loop"] else 0))})
    if r.status_code >= 400:
        raise RuntimeError(f"ORPHEUS: {r.text[:400]}")
    wav = await asyncio.to_thread(make_loop, r.content, 2.0) if p["loop"] else r.content
    _, url = await save_output(SimpleNamespace(project_id=None), wav, f"assets/audio/music/{slug(j['prompt'], 'music')}.wav", ".wav")
    try:
        elapsed = float(r.headers.get("X-Orpheus-Elapsed", "").rstrip("s"))
    except ValueError:
        elapsed = None
    return {"url": url, "seed": None, "model": r.headers.get("X-Orpheus-Model") or "MusicGen", "elapsed": elapsed,
            "seconds": round(await asyncio.to_thread(_duration, wav), 2)}


async def _sfx(c: httpx.AsyncClient, j: dict, seed: int, stable: bool) -> dict:
    p = j["params"]
    dur = p["duration"] + (1.0 if p["loop"] else 0)
    t0 = time.time()
    if stable:
        r = await c.post(f"{STABLE_AUDIO}/generate", json={"prompt": j["prompt"], "duration": dur, "steps": p["steps"], "seed": seed})
    else:  # AudioGen takes neither a seed nor steps
        r = await c.post(f"{ORPHEUS}/generate/sfx", json={"prompt": j["prompt"], "duration": min(30.0, dur)})
    if r.status_code >= 400:
        raise RuntimeError(f"{'Stable Audio' if stable else 'ORPHEUS'}: {r.text[:400]}")
    wav = await asyncio.to_thread(make_loop if p["loop"] else trim_and_fade, r.content)
    sub = "ambience" if p["loop"] else "sfx"
    _, url = await save_output(SimpleNamespace(project_id=None), wav, f"assets/audio/{sub}/{slug(j['prompt'], 'sfx')}.wav", ".wav")
    return {"url": url, "seed": seed if stable else None, "elapsed": round(time.time() - t0, 1),
            "model": "stabilityai/stable-audio-open-1.0" if stable else "facebook/audiogen-medium",
            "seconds": round(await asyncio.to_thread(_duration, wav), 2)}


def _keep() -> set[str]:
    """Models make_room must not evict: the default chat agent's and the embedder, which a chat is most likely using."""
    try:
        settings = roster.get_settings()
        agent, _ = roster.find_agent(settings.get("defaultAgent") or "shellb")
        return {m for m in (agent.get("model"), settings.get("embeddingModel")) if m}
    except Exception:  # noqa: BLE001
        return set()


def _waiting(service: str, but: str) -> bool:
    return any(o["service"] == service and o["status"] == "queued" and o["id"] != but for o in _jobs.values())


async def _run(j: dict):
    kind, p = j["kind"], j["params"]
    base = p.get("seed") if p.get("seed") is not None else random.randint(0, 2**31 - 1)
    try:
        # AudioGen fallback: decided at start, so a job queued while Stable Audio was down still runs if it came back
        stable = kind == "sfx" and (await services(fresh=True))["stableaudio"]["ok"]
        if kind == "sfx" and not stable:
            j["service"], j["engine"] = "orpheus", "AudioGen (Stable Audio is down)"
        async with _lock(j["service"]):
            if j["status"] == "cancelled":
                return
            j["status"], j["started"] = "running", time.time()
            evicted = await make_room({"image": 28 if p.get("quality") != "high" else 36, "music": 12, "sfx": 14}[kind], _keep())
            if evicted:
                j["note"] = f"Unloaded idle models to make room: {', '.join(evicted)}"
            async with httpx.AsyncClient(timeout=600) as c:
                try:
                    for i in range(j["count"]):
                        if j.get("_stop"):
                            break
                        seed = (base + i) % 2**31
                        if kind == "image":
                            res = await _image(c, j, seed)
                        elif kind == "music":
                            res = await _music(c, j)
                        else:
                            res = await _sfx(c, j, seed, stable)
                        meta = {"seed": res["seed"], "params": {k: v for k, v in p.items() if k != "seed"}, "model": res["model"],
                                "job": j["id"], "audioInfo": {"model": res["model"], "elapsed": res["elapsed"], "prompt": j["prompt"]}}
                        res["mediaId"] = _file(kind, res["url"], j["prompt"], meta)
                        j["results"].append(res)
                finally:
                    # hand the GPU memory back to the language models, unless another job for this service is next
                    if not _waiting(j["service"], j["id"]):
                        try:
                            if kind == "image":
                                await c.post(f"{COMFY}/free", json={"unload_models": True, "free_memory": True})
                            elif stable:
                                await c.post(f"{STABLE_AUDIO}/unload")
                        except httpx.HTTPError:
                            pass
        j["status"] = "stopped" if j.get("_stop") and len(j["results"]) < j["count"] else "done"
    except asyncio.CancelledError:
        j["status"] = "cancelled"
        raise
    except (httpx.HTTPError, RuntimeError, TimeoutError, OSError) as e:
        j["status"] = "failed"
        msg = str(e) or type(e).__name__
        if isinstance(e, httpx.ConnectError):
            msg = f"Couldn't reach {j['service'].upper()}: is the service running?"
        j["error"] = msg[:600]
    finally:
        j["finished"] = time.time()
        _tasks.pop(j["id"], None)
        _trim()


def running_now() -> list[dict]:
    """Queued or running generations, for /api/status: a restart would drop them (the queue lives in memory)."""
    return [{"id": j["id"], "kind": j["kind"], "status": j["status"]} for j in _jobs.values() if j["status"] in ("queued", "running")]


def _trim():
    done = sorted((o for o in _jobs.values() if o["status"] not in ("queued", "running")), key=lambda o: o["created"])
    for o in done[:max(0, len(done) - MAX_JOBS)]:
        _jobs.pop(o["id"], None)


def start_job(kind: str, prompt: str, params: dict, count: int = 1) -> dict:
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(KINDS)}.")
    prompt = " ".join(str(prompt or "").split())[:2000]
    if not prompt:
        raise ValueError("Write a prompt first.")
    j = {"id": db.new_id("gen"), "kind": kind, "prompt": prompt, "params": _params(kind, params), "service": KINDS[kind],
         "engine": None, "count": max(1, min(MAX_COUNT, int(count or 1))), "status": "queued", "results": [], "error": None,
         "note": None, "created": time.time(), "started": None, "finished": None}
    _jobs[j["id"]] = j
    _tasks[j["id"]] = asyncio.create_task(_run(j))  # referenced until it finishes, so it isn't garbage-collected
    return j


# ── HTTP ────────────────────────────────────────────────────────────────────

@router.get("")
async def overview():
    jobs = sorted(_jobs.values(), key=lambda o: -o["created"])
    return {"services": await services(), "jobs": [_public(j) for j in jobs], "maxCount": MAX_COUNT}


@router.post("")
async def create(req: Request):
    b = await req.json()
    try:
        j = start_job(str(b.get("kind") or ""), b.get("prompt") or "", b.get("params") or {}, b.get("count") or 1)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    return _public(j)


@router.get("/jobs/{jid}")
def job(jid: str):
    j = _jobs.get(jid)
    if not j:
        raise HTTPException(404, "No such job (jobs are forgotten when Shell:B restarts).")
    return _public(j)


@router.post("/jobs/{jid}/stop")
def stop(jid: str):
    """A queued job is dropped; a running one finishes the variation it is on and keeps what it made."""
    j = _jobs.get(jid)
    if not j:
        raise HTTPException(404, "No such job.")
    if j["status"] == "queued":
        j["status"] = "cancelled"
        t = _tasks.get(jid)
        if t:
            t.cancel()
    elif j["status"] == "running":
        j["_stop"] = True
    return _public(j)


@router.delete("/jobs/{jid}")
def forget(jid: str):
    j = _jobs.get(jid)
    if j and j["status"] in ("queued", "running"):
        raise HTTPException(400, "Stop the job first.")
    _jobs.pop(jid, None)
    return {"ok": True}


@router.get("/history")
def history(kind: str = "", limit: int = 120):
    """Everything made here, newest first, from the Media table (hidden rows and deleted files left out)."""
    where, args = ["hidden=0", "meta LIKE ?"], ['%"via": "generate"%']
    if kind in TOOL:
        where.append("tool=?")
        args.append(TOOL[kind])
    with db.conn() as c:
        rows = c.execute(f"SELECT * FROM media WHERE {' AND '.join(where)} ORDER BY created DESC LIMIT ?",
                         (*args, max(1, min(limit, 500)))).fetchall()
    out = []
    for r in rows:
        p = media._path(r["url"])
        if p is None or not p.exists():
            continue
        meta = json.loads(r["meta"] or "{}")
        out.append({"mediaId": r["id"], "url": r["url"], "kind": {v: k for k, v in TOOL.items()}.get(r["tool"], "image"),
                    "prompt": r["prompt"] or "", "seed": meta.get("seed"), "params": meta.get("params") or {},
                    "model": meta.get("model"), "job": meta.get("job"), "createdAt": r["created"] * 1000})
    return {"items": out}
