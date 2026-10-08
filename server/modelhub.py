"""Models (#/models): what's installed, what's holding memory right now, and the controls to change both.

The DGX Spark's GB10 shares one pool of unified memory between the CPU and the GPU, so "what's loaded" covers more
than Ollama: ComfyUI (FLUX, Hunyuan3D), ORPHEUS (MusicGen/AudioGen) and Stable Audio keep their own models resident.
`overview` maps nvidia-smi's per-process GPU memory to services through each process's systemd unit, and lists
Ollama's loaded models from /api/ps. Unloading is open to anyone who can use the app (models load again on first
use); pulling and deleting change what agents can run and cost disk, so they need the owner (remote.require_admin).

Pulls run as background tasks, so a big download keeps going when the page is closed; `_pulls` is their progress.
"""
import asyncio
import json
import re
import shutil
import subprocess
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request

router = APIRouter(prefix="/api/modelhub")
OLLAMA = "http://localhost:11434"
SERVICES = {   # systemd unit → (label, how to free its memory)
    "ollama.service": ("Ollama", None),
    "shellb-nyx.service": ("NYX · ComfyUI (images, 3D)", ("POST", "http://localhost:8188/free", {"unload_models": True, "free_memory": True})),
    "shellb-orpheus.service": ("ORPHEUS (music, sound effects)", ("POST", "http://localhost:8002/unload", None)),
    "shellb-stableaudio.service": ("Stable Audio", ("POST", "http://localhost:8003/unload", None)),
    "shellb-hermes.service": ("HERMES (speech)", None),
}
NAME_RE = re.compile(r"^[\w][\w.\-/:]{0,199}$")
_pulls: dict[str, dict] = {}
_TASKS: dict[str, asyncio.Task] = {}


def _owner(req: Request):
    import remote
    remote.require_admin(req)


def _unit(pid: int) -> str:
    try:
        for line in Path(f"/proc/{pid}/cgroup").read_text().splitlines():
            units = re.findall(r"/([\w@.\-]+\.service)", line)  # user units sit under user@1000.service: take the innermost
            if units:
                return units[-1]
    except OSError:
        pass
    return ""


def gpu_processes() -> list[dict]:
    """GPU memory by service, from nvidia-smi (the GB10 reports per-process use even though the totals are N/A)."""
    try:
        out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=8).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    by: dict[str, dict] = {}
    for line in out.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3 or not parts[0].isdigit():
            continue
        pid, name, mib = int(parts[0]), parts[1], parts[2]
        unit = _unit(pid)
        key = unit or name
        e = by.setdefault(key, {"id": key, "label": SERVICES.get(unit, (Path(name).name, None))[0], "bytes": 0,
                                "freeable": bool(SERVICES.get(unit, (None, None))[1]), "pids": []})
        e["bytes"] += int(mib) * 1024 * 1024 if mib.isdigit() else 0
        e["pids"].append(pid)
    return sorted(by.values(), key=lambda e: -e["bytes"])


def _used_by() -> dict[str, list[str]]:
    """Model name → who relies on it (agents by name, plus the Shell:B-wide model settings)."""
    from roster import get_agents, get_settings
    use: dict[str, list[str]] = {}
    for a in get_agents():
        if a.get("model"):
            use.setdefault(a["model"].removesuffix(":latest"), []).append(a.get("name") or a["id"])
    s = get_settings()
    for key, label in (("embeddingModel", "Memory and search embeddings"), ("utilityModel", "Utility model"),
                       ("visionFallbackModel", "Vision fallback")):
        if s.get(key):
            use.setdefault(str(s[key]).removesuffix(":latest"), []).append(label)
    return use


def _norm(name: str) -> str:
    return name.removesuffix(":latest")


@router.get("/overview")
async def api_overview():
    from agent import model_info
    async with httpx.AsyncClient(timeout=10) as c:
        tags = (await c.get(f"{OLLAMA}/api/tags")).json().get("models", [])
        ps = (await c.get(f"{OLLAMA}/api/ps")).json().get("models", [])
    use = _used_by()
    installed = []
    for m in tags:
        name = _norm(m["name"])
        try:
            info = await model_info(m["name"])
        except Exception:  # noqa: BLE001
            info = {"capabilities": []}
        d = m.get("details") or {}
        installed.append({"name": name, "size": m.get("size", 0), "modifiedAt": m.get("modified_at"), "family": d.get("family", ""),
                          "parameterSize": d.get("parameter_size", ""), "quantization": d.get("quantization_level", ""),
                          "capabilities": info.get("capabilities", []), "usedBy": use.get(name, []),
                          "custom": name.lower().startswith("shellb-")})
    installed.sort(key=lambda m: (not m["custom"], not m["usedBy"], m["name"].lower()))
    loaded = [{"name": _norm(m["name"]), "size": m.get("size", 0), "vram": m.get("size_vram", 0),
               "context": m.get("context_length"), "expiresAt": m.get("expires_at"), "usedBy": use.get(_norm(m["name"]), [])}
              for m in ps]
    mem = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        k, v = line.split(":", 1)
        if k in ("MemTotal", "MemAvailable"):
            mem[k] = int(v.split()[0]) * 1024
    try:
        du = shutil.disk_usage("/usr/share/ollama" if Path("/usr/share/ollama").exists() else "/")
        disk = {"total": du.total, "free": du.free}
    except OSError:
        disk = None
    return {"installed": installed, "loaded": loaded, "gpu": await asyncio.to_thread(gpu_processes), "memory": mem,
            "disk": disk, "pulls": sorted(_pulls.values(), key=lambda p: -p["started"])}


@router.post("/unload")
async def api_unload(req: Request):
    """{"model": name} unloads one Ollama model; {"service": unit} asks that service to free its models."""
    b = await req.json()
    async with httpx.AsyncClient(timeout=30) as c:
        if b.get("model"):
            name = str(b["model"])
            r = await c.post(f"{OLLAMA}/api/generate", json={"model": name, "keep_alive": 0})
            if r.status_code >= 400:
                raise HTTPException(400, f"Ollama refused: {r.text[:200]}")
        elif b.get("service") in SERVICES and SERVICES[b["service"]][1]:
            method, url, body = SERVICES[b["service"]][1]
            try:
                await c.request(method, url, json=body)
            except httpx.HTTPError as e:
                raise HTTPException(502, f"{SERVICES[b['service']][0]} didn't answer: {e}")
        else:
            raise HTTPException(400, "Send a model or a service that can be freed.")
    await asyncio.sleep(1.5)  # let the runner exit before the page re-reads memory
    return {"ok": True}


@router.post("/load")
async def api_load(req: Request):
    """Warms a model up so the first real message doesn't wait for it to load."""
    name = str((await req.json()).get("model") or "")
    async with httpx.AsyncClient(timeout=600) as c:
        info = (await c.post(f"{OLLAMA}/api/show", json={"model": name})).json()
        caps = info.get("capabilities") or []
        if "embedding" in caps:
            r = await c.post(f"{OLLAMA}/api/embed", json={"model": name, "input": ["warm up"]})
        else:
            r = await c.post(f"{OLLAMA}/api/generate", json={"model": name, "prompt": "", "stream": False})
    if r.status_code >= 400:
        raise HTTPException(400, r.text[:300])
    return {"ok": True}


@router.get("/show/{name:path}")
async def api_show(name: str):
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(f"{OLLAMA}/api/show", json={"model": name})
    if r.status_code >= 400:
        raise HTTPException(404, "No such model.")
    d = r.json()
    mi = d.get("model_info") or {}
    ctx = next((v for k, v in mi.items() if k.endswith(".context_length")), None)
    return {"modelfile": (d.get("modelfile") or "")[:12000], "parameters": d.get("parameters") or "",
            "template": (d.get("template") or "")[:6000], "system": (d.get("system") or "")[:6000],
            "license": (d.get("license") or "")[:3000], "details": d.get("details") or {}, "capabilities": d.get("capabilities") or [],
            "contextLength": ctx, "architecture": mi.get("general.architecture"), "parameterCount": mi.get("general.parameter_count")}


async def _pull(name: str):
    p = _pulls[name]
    layers: dict[str, list[int]] = {}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(None, connect=20)) as c:
            async with c.stream("POST", f"{OLLAMA}/api/pull", json={"model": name, "stream": True}) as r:
                if r.status_code >= 400:
                    raise RuntimeError((await r.aread()).decode(errors="replace")[:300])
                async for line in r.aiter_lines():
                    if not line.strip():
                        continue
                    ev = json.loads(line)
                    if ev.get("error"):
                        raise RuntimeError(ev["error"])
                    p["status"] = ev.get("status", p["status"])
                    if ev.get("digest") and ev.get("total"):
                        layers[ev["digest"]] = [ev.get("completed", 0), ev["total"]]
                        p["completed"] = sum(v[0] for v in layers.values())
                        p["total"] = sum(v[1] for v in layers.values())
        p.update(state="done", status="Installed", finished=time.time() * 1000)
    except asyncio.CancelledError:
        p.update(state="cancelled", status="Cancelled", finished=time.time() * 1000)
        raise
    except Exception as e:  # noqa: BLE001
        p.update(state="error", status="Failed", error=str(e)[:300], finished=time.time() * 1000)
    finally:
        _TASKS.pop(name, None)


@router.post("/pull")
async def api_pull(req: Request):
    _owner(req)
    return start_pull(str((await req.json()).get("model") or ""))


def start_pull(name: str) -> dict:
    """Start (or resume) an Ollama pull in the background; also used by the Model Store (modelstore.py)."""
    name = name.strip()
    if name.startswith("ollama pull "):
        name = name[len("ollama pull "):].strip()
    if not NAME_RE.match(name):
        raise HTTPException(400, "Use a model name like qwen3:8b, or hf.co/<user>/<repo>:<quant> for Hugging Face GGUFs.")
    if name in _TASKS:
        raise HTTPException(400, f"{name} is already downloading.")
    _pulls[name] = {"name": name, "state": "running", "status": "Starting", "completed": 0, "total": 0, "error": "",
                    "started": time.time() * 1000, "finished": None}
    _TASKS[name] = asyncio.create_task(_pull(name))
    return _pulls[name]


@router.post("/pull/cancel")
async def api_pull_cancel(req: Request):
    _owner(req)
    name = str((await req.json()).get("model") or "")
    t = _TASKS.get(name)
    if t:
        t.cancel()
    return {"ok": True}


@router.post("/pull/dismiss")
async def api_pull_dismiss(req: Request):
    name = str((await req.json()).get("model") or "")
    if name not in _TASKS:
        _pulls.pop(name, None)
    return {"ok": True}


@router.delete("/installed/{name:path}")
async def api_delete(name: str, req: Request, force: bool = False):
    _owner(req)
    users = _used_by().get(_norm(name), [])
    if users and not force:
        raise HTTPException(409, f"{name} is used by {', '.join(users)}. Point them at another model first, or delete anyway.")
    async with httpx.AsyncClient(timeout=60) as c:
        await c.post(f"{OLLAMA}/api/generate", json={"model": name, "keep_alive": 0})
        r = await c.request("DELETE", f"{OLLAMA}/api/delete", json={"model": name})
    if r.status_code >= 400:
        raise HTTPException(400, f"Ollama couldn't delete it: {r.text[:200]}")
    return {"ok": True}
