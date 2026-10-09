"""Tools available to Shell:B agents. Every tool runs locally against Shell:B services."""
import asyncio
import html
import ipaddress
import json
import os
import random
import re
import shutil
import socket
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote
from typing import Any, Awaitable, Callable
from urllib.parse import urlparse

import httpx
import numpy as np
import trafilatura

import db

OLLAMA = os.environ.get("SHELLB_OLLAMA", "http://localhost:11434")
SEARXNG = os.environ.get("SHELLB_SEARXNG", "http://localhost:8080")
COMFY = os.environ.get("SHELLB_COMFY", "http://localhost:8188")
ORPHEUS = os.environ.get("SHELLB_ORPHEUS", "http://localhost:8002")
SANDBOX_IMAGE = os.environ.get("SHELLB_SANDBOX_IMAGE", "shellb-sandbox:latest")

FILES = db.DATA / "files"
WORKSPACES = db.DATA / "workspaces"
CELLS = db.DATA / "cells"
for d in (FILES, WORKSPACES, CELLS):
    d.mkdir(exist_ok=True)

UA = "Mozilla/5.0 (X11; Linux aarch64) Shell:B/1.0"
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}


@dataclass
class ToolContext:
    conv_id: str
    message_id: str
    agent: dict
    settings: dict
    emit: Callable[[dict], Awaitable[None]]
    run_subagent: Callable[[str, str], Awaitable[str]] | None = None
    depth: int = 0
    project_id: str | None = None
    user_request: str = ""  # the user's latest message, so reviews can check the render against it
    tenant: str | None = None  # a guest's id (guests.py): nothing of the owner's is mounted or reachable


@dataclass
class ToolResult:
    text: str
    display: dict = field(default_factory=dict)
    error: bool = False
    model_images: list = field(default_factory=list)  # base64 images handed back to vision models


def _fn(name, description, props, required):
    return {"type": "function", "function": {
        "name": name, "description": description,
        "parameters": {"type": "object", "properties": props, "required": required}}}


# ── web ─────────────────────────────────────────────────────────────────────

async def web_search(args, ctx):
    query = str(args.get("query", "")).strip()
    n = int(args.get("max_results") or 6)
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(f"{SEARXNG}/search", params={"q": query, "format": "json"})
        r.raise_for_status()
        data = r.json()
    hits = data.get("results", [])[:n]
    if not hits:
        dead = ", ".join(f"{e} ({why})" for e, why in data.get("unresponsive_engines", []))
        return ToolResult(f"No results for {query!r}." + (f" Unresponsive engines: {dead}" if dead else ""))
    lines = [f"{i}. {h.get('title', '').strip()}\n   {h.get('url')}\n   {(h.get('content') or '').strip()[:300]}"
             for i, h in enumerate(hits, 1)]
    sources = [{"title": h.get("title", ""), "url": h.get("url")} for h in hits]
    return ToolResult("\n".join(lines), {"sources": sources})


def _blocked_host(host: str) -> bool:
    """Keep page fetches on the public internet (prompt-injected pages can't poke this machine, the LAN or the tailnet).

    Anything that isn't a global address is refused: loopback, link-local (incl. 169.254.169.254), RFC 1918, the
    Tailscale/CGNAT range 100.64/10, ULA, reserved. IPv4-mapped IPv6 (::ffff:127.0.0.1) is judged by its IPv4 part.
    """
    host = (host or "").strip("[]").rstrip(".").lower()
    if host in {"localhost", "host.docker.internal"} or host.endswith(".localhost"):
        return True
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False  # unresolvable: the fetch fails on its own
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%", 1)[0])
        if getattr(ip, "ipv4_mapped", None):
            ip = ip.ipv4_mapped
        if not ip.is_global or ip.is_multicast:
            return True
    return False


async def _redirect_guard(request: httpx.Request):
    """httpx request hook: every hop of a redirect chain gets the same local-address check as the first URL."""
    if await asyncio.to_thread(_blocked_host, request.url.host):  # a DNS lookup: off the event loop
        raise httpx.RequestError(f"refused to follow a redirect to a local address ({request.url.host})", request=request)


GUARD_HOOKS = {"request": [_redirect_guard]}  # pass as event_hooks= to any client that fetches agent-chosen URLs


FETCH_MAX = 25 * 1024 * 1024


async def web_fetch(args, ctx):
    url = str(args.get("url", "")).strip()
    start = int(args.get("start") or 0)
    limit = 12000
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return ToolResult(f"Refusing to fetch {url!r}: only http(s) URLs are supported.", error=True)
    if await asyncio.to_thread(_blocked_host, parsed.hostname):
        return ToolResult(f"Refusing to fetch {url!r}: local addresses are off limits.", error=True)
    doc = False
    async with httpx.AsyncClient(timeout=30, follow_redirects=True, headers={"User-Agent": UA},
                                 event_hooks=GUARD_HOOKS) as c:
        async with c.stream("GET", url) as r:
            r.raise_for_status()
            ctype = r.headers.get("content-type", "")
            doc = "pdf" in ctype or ctype.startswith("image/") or "officedocument" in ctype or "msword" in ctype \
                or "ms-excel" in ctype or "ms-powerpoint" in ctype
            body, size = [], 0
            if not doc:  # documents are fetched again by read_document, with its own limits
                async for part in r.aiter_bytes():  # a page bigger than this is not a page; don't hold it all in RAM
                    size += len(part)
                    if size > FETCH_MAX:
                        return ToolResult(f"{url} is larger than {FETCH_MAX // 2**20} MB; refusing to read it all. "
                                          "If it's a file or dataset, use download instead.", error=True)
                    body.append(part)
            raw = b"".join(body)
            final_url, encoding = str(r.url), r.encoding or "utf-8"
    if doc:
        import doc_tools  # documents and pictures: download and read them properly (OCR included)
        return await doc_tools.read_document({"path": final_url}, ctx)
    page = raw.decode(encoding, errors="replace")
    if "html" in ctype:
        text = await asyncio.to_thread(trafilatura.extract, page, output_format="markdown",
                                       include_links=True, include_tables=True, url=final_url)
        text = text or page
    elif ctype.startswith("text/") or "json" in ctype or "xml" in ctype:
        text = page
    else:
        return ToolResult(f"Unsupported content type {ctype!r} ({len(raw)} bytes) at {final_url}")
    chunk = text[start:start + limit]
    more = len(text) - start - len(chunk)
    tail = f"\n\n[… {more} more chars — call web_fetch again with start={start + len(chunk)}]" if more > 0 else ""
    return ToolResult(f"# {final_url}\n\n{chunk}{tail}", {"sources": [{"title": final_url, "url": final_url}]})


# ── code sandbox ────────────────────────────────────────────────────────────

def _snapshot(root: Path):
    return {p: p.stat().st_mtime for p in root.rglob("*") if p.is_file() and ".git" not in p.relative_to(root).parts}


def _group_files(ctx):
    """Knowledge files of the chat's Project, mounted read-only at /project."""
    if ctx.project_id or not ctx.conv_id:
        return None
    gid = (db.get_conversation(ctx.conv_id) or {}).get("groupId")
    d = db.DATA / "groups" / gid / "files" if gid else None
    return d if d and d.is_dir() else None


def _library_mounts(ctx):
    """Every project, notebook, chat Project and generated file, read-only under /library (library.py)."""
    import library
    switches = db.kv_get("tool_switches", {})
    return library.sandbox_mounts() if switches.get("library", True) and library.allowed(ctx.agent, ctx.settings) else []


async def run_code(args, ctx):
    language = str(args.get("language") or "python").lower()
    code = str(args.get("code") or "")
    if language not in ("python", "bash"):
        return ToolResult("Supported languages: python, bash.", error=True)
    if not shutil.which("docker"):
        return ToolResult("Sandbox unavailable: docker is not installed.", error=True)
    ws = (db.DATA / "projects" / ctx.project_id) if ctx.project_id else (WORKSPACES / ctx.conv_id)
    ws.mkdir(exist_ok=True)
    cell = CELLS / f"{uuid.uuid4().hex}.{'py' if language == 'python' else 'sh'}"
    cell.write_text(code)
    before = _snapshot(ws)
    name = f"shellb-cell-{uuid.uuid4().hex[:10]}"
    cmd = ["docker", "run", "--rm", "--name", name, "--network", "none",
           # no capabilities, so setuid binaries in the image gain nothing. (no-new-privileges would be nicer, but under
           # the snap dockerd's AppArmor profile it makes every exec fail with EPERM.)
           "--cap-drop", "ALL",
           "--memory", "4g", "--cpus", "4", "--pids-limit", "512", "--read-only",
           "--tmpfs", "/tmp:rw,exec,size=512m", "--user", f"{os.getuid()}:{os.getgid()}",
           "-e", "HOME=/tmp", "-e", "MPLBACKEND=Agg", "-e", "PYTHONUNBUFFERED=1",
           "-v", f"{ws}:/work", *(["-v", f"{ws}/.git:/work/.git:ro"] if (ws / ".git").is_dir() else []),
           "-v", f"{cell}:/cell/main:ro", *([] if ctx.tenant else ["-v", f"{db.DATA / 'skills'}:/skills:ro"]),
           *(["-v", f"{_group_files(ctx)}:/project:ro"] if _group_files(ctx) else []),
           *([] if ctx.tenant else _library_mounts(ctx)),  # a guest's sandbox sees its own /work and nothing else
           *__import__("selfmod").sandbox_mounts(ctx.project_id), "-w", "/work", SANDBOX_IMAGE,
           "python" if language == "python" else "bash", "/cell/main"]
    t0 = time.time()
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=180)
        timed_out = False
    except asyncio.TimeoutError:
        await (await asyncio.create_subprocess_exec("docker", "kill", name)).wait()
        out, err = await proc.communicate()
        timed_out = True
    finally:
        cell.unlink(missing_ok=True)
    elapsed = time.time() - t0
    stdout, stderr = out.decode(errors="replace"), err.decode(errors="replace")
    if "Unable to find image" in stderr or "No such image" in stderr:
        return ToolResult(f"Sandbox image {SANDBOX_IMAGE} is not built yet.", error=True)

    after = _snapshot(ws)
    changed = sorted(p for p, m in after.items() if before.get(p) != m)
    rel = [str(p.relative_to(ws)) for p in changed]
    rel = [r for r in rel if not r.startswith(".git/")]
    changed = [p for p in changed if ".git" not in p.relative_to(ws).parts]
    if ctx.project_id and rel:  # caches and build output the repo ignores aren't worth reporting
        chk = subprocess.run(["git", "check-ignore", "--stdin"], cwd=ws, input="\n".join(rel), capture_output=True, text=True,
                             env={**os.environ, "GIT_DIR": str(ws / ".git"), "GIT_WORK_TREE": str(ws)})  # never the app's repo
        ignored = set(chk.stdout.splitlines())
        changed = [p for r, p in zip(rel, changed) if r not in ignored]
        rel = [r for r in rel if r not in ignored]
    img_base = f"/api/projects/{ctx.project_id}/raw" if ctx.project_id else f"/api/workspace/{ctx.conv_id}"
    images = [f"{img_base}/{r}" for r, p in zip(rel, changed) if p.suffix.lower() in IMAGE_EXT]
    # everything else the code wrote becomes a download chip (Studio/Code projects show files in their own tree)
    downloads = [] if ctx.project_id else [
        {"path": r, "url": f"{img_base}/{quote(r)}", "size": p.stat().st_size}
        for r, p in zip(rel, changed) if p.suffix.lower() not in IMAGE_EXT and p.is_file()
        and not any(part.startswith(".") or part == "__pycache__" for part in Path(r).parts)][:40]
    if ctx.project_id:
        for r in rel:
            await ctx.emit({"type": "file", "path": r, "action": "modified"})

    def clip(s, n=8000):
        return s if len(s) <= n else s[:n // 2] + f"\n…[{len(s) - n} chars truncated]…\n" + s[-n // 2:]

    parts = [f"exit code: {'TIMEOUT (180s)' if timed_out else proc.returncode}  ({elapsed:.1f}s)"]
    if stdout:
        parts.append("stdout:\n" + clip(stdout))
    if stderr:
        parts.append("stderr:\n" + clip(stderr, 4000))
    if rel:
        parts.append("files written in /work: " + ", ".join(rel[:40]))
    if images:
        parts.append("(image files are already displayed to the user — do not embed or link them in your reply)")
    if downloads:
        parts.append("(the other files are shown to the user as download buttons under this step)")
    return ToolResult("\n\n".join(parts), {"images": images, "files": rel[:40], "downloads": downloads,
                                            "exitCode": proc.returncode}, error=bool(proc.returncode) or timed_out)


# ── artifacts ───────────────────────────────────────────────────────────────

ARTIFACT_TYPES = ("html", "svg", "markdown", "mermaid", "code")


def _unescape_markup(type_: str, content: str) -> str:
    """Models sometimes emit markup entity-escaped (`&lt;svg&gt;`), which the preview iframe shows as literal text."""
    if type_ in ("html", "svg"):
        if re.match(r"\s*&lt;", content) and "<" not in content[:200]:
            return html.unescape(content)
    elif type_ == "mermaid" and "&gt;" in content and ">" not in content:
        return html.unescape(content)
    return content


async def create_artifact(args, ctx):
    art_id = re.sub(r"[^a-z0-9-]+", "-", str(args.get("id") or args.get("title") or "artifact").lower()).strip("-")[:48]
    type_ = str(args.get("type") or "html").lower()
    if type_ not in ARTIFACT_TYPES:
        type_ = "code"
    content = _unescape_markup(type_, str(args.get("content") or ""))
    if not content.strip():
        return ToolResult("Artifact content is empty.", error=True)
    title = str(args.get("title") or art_id)
    language = str(args.get("language") or {"html": "html", "svg": "svg", "markdown": "markdown",
                                              "mermaid": "mermaid"}.get(type_, "text"))
    art = db.save_artifact(ctx.conv_id, art_id or "artifact", title, type_, language, content, ctx.message_id)
    await ctx.emit({"type": "artifact", "artifact": art})
    return ToolResult(f"Saved artifact `{art['id']}` as version {art['version']} — it is now open for the user. "
                      f"To revise it, call create_artifact again with the same id and the full new content.",
                      {"artifact": {k: art[k] for k in ("id", "version", "title", "type", "language")}})


# ── image generation (NYX / ComfyUI + FLUX.1-schnell) ───────────────────────

FLUX_DEV = "flux1-dev-fp8.safetensors"  # Comfy-Org all-in-one checkpoint in models/checkpoints/


def flux_dev_available() -> bool:
    return (Path.home() / "comfyui/models/checkpoints" / FLUX_DEV).is_file()


def _flux_workflow(prompt, width, height, seed, quality="draft"):
    if quality == "high" and flux_dev_available():
        wf = _flux_workflow(prompt, width, height, seed)
        # dev: the same text encoders and VAE, the dev transformer, FluxGuidance instead of CFG, ~24 steps
        wf["1"] = {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": FLUX_DEV}}
        wf["7"] = {"class_type": "FluxGuidance", "inputs": {"conditioning": ["4", 0], "guidance": 3.5}}
        wf["8"]["inputs"].update({"steps": 24, "positive": ["7", 0]})
        return wf
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-schnell-fp8.safetensors", "weight_dtype": "fp8_e4m3fn"}},
        "2": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": "t5xxl_fp8_e4m3fn.safetensors",
                                                         "clip_name2": "clip_l.safetensors", "type": "flux", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["2", 0]}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        # schnell is guidance-distilled: no FluxGuidance node, cfg 1, 4 steps
        "8": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 4, "cfg": 1.0, "sampler_name": "euler",
                                                   "scheduler": "simple", "denoise": 1.0, "model": ["1", 0],
                                                   "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0]}},
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
        "10": {"class_type": "SaveImage", "inputs": {"filename_prefix": "ShellB_Web", "images": ["9", 0]}},
    }


def _mem_available_gb():
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) / 1024 / 1024
    return 0.0


async def make_room(needed_gb: float, keep: set[str]):
    """Unified memory is shared with Ollama: evict idle models if a GPU job needs headroom."""
    if _mem_available_gb() >= needed_gb:
        return []
    evicted = []
    async with httpx.AsyncClient(timeout=30) as c:
        loaded = (await c.get(f"{OLLAMA}/api/ps")).json().get("models", [])
        for m in sorted(loaded, key=lambda m: -m.get("size", 0)):
            name = m.get("name") or m.get("model")
            if name in keep or name.split(":")[0] in keep:
                continue
            await c.post(f"{OLLAMA}/api/generate", json={"model": name, "keep_alive": 0})
            evicted.append(name)
            await asyncio.sleep(1.5)
            if _mem_available_gb() >= needed_gb:
                break
    return evicted


def _snap(v, lo, hi, step=64):
    return max(lo, min(hi, int(round(int(v) / step) * step)))


async def generate_image(args, ctx):
    prompt = str(args.get("prompt") or "").strip()
    width = _snap(args.get("width") or 1024, 256, 1536)
    height = _snap(args.get("height") or 1024, 256, 1536)
    seed = int(args.get("seed") or random.randint(0, 2**32 - 1))
    quality = "high" if str(args.get("quality") or "").lower() == "high" and flux_dev_available() else "draft"
    keep = {ctx.agent.get("model", "")}
    evicted = await make_room(28, keep)
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{COMFY}/prompt", json={"prompt": _flux_workflow(prompt, width, height, seed, quality),
                                                   "client_id": uuid.uuid4().hex})
        r.raise_for_status()
        pid = r.json()["prompt_id"]
        deadline = time.time() + 300
        outputs = None
        while time.time() < deadline:
            await asyncio.sleep(1.0)
            h = (await c.get(f"{COMFY}/history/{pid}")).json()
            if pid in h:
                status = h[pid].get("status", {})
                if status.get("status_str") == "error":
                    return ToolResult(f"ComfyUI failed: {json.dumps(status.get('messages', []))[:800]}", error=True)
                outputs = h[pid].get("outputs")
                if outputs:
                    break
        if not outputs:
            return ToolResult("Image generation timed out after 300s.", error=True)
        urls, saved = [], []
        for node in outputs.values():
            for img in node.get("images", []):
                data = (await c.get(f"{COMFY}/view", params={"filename": img["filename"], "subfolder": img.get("subfolder", ""),
                                                             "type": img.get("type", "output")})).content
                if ctx.project_id:
                    want = str(args.get("save_as") or "").strip().lstrip("/")
                    if not want:
                        slug = re.sub(r"[^a-z0-9]+", "-", prompt.lower())[:40].strip("-") or "image"
                        want = f"assets/generated/{slug}-{seed % 10000}.png"
                    if not want.lower().endswith(".png"):
                        want = re.sub(r"\.\w+$", "", want) + ".png"
                    dest = (db.DATA / "projects" / ctx.project_id / want).resolve()
                    if not str(dest).startswith(str((db.DATA / "projects" / ctx.project_id).resolve()) + "/"):
                        return ToolResult(f"save_as must stay inside the project: {want!r}", error=True)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(data)
                    saved.append(want)
                    urls.append(f"/api/projects/{ctx.project_id}/raw/{want}")
                    await ctx.emit({"type": "file", "path": want, "action": "created"})
                else:
                    name = f"img-{uuid.uuid4().hex[:12]}.png"
                    (FILES / name).write_bytes(data)
                    urls.append(f"/api/files/{name}")
        # hand FLUX's ~22 GB back to the language models
        await c.post(f"{COMFY}/free", json={"unload_models": True, "free_memory": True})
    note = f" (evicted idle models to make room: {', '.join(evicted)})" if evicted else ""
    if saved:
        note += f" Saved into the project as {', '.join(saved)} — reference it with that relative path."
    if str(args.get("quality") or "").lower() == "high" and quality != "high":
        note += " (FLUX.1-dev is not installed, so this used schnell.)"
    return ToolResult(f"Generated {len(urls)} image(s) at {width}x{height}, seed {seed}, {'FLUX.1-dev' if quality == 'high' else 'FLUX.1-schnell'}. They are already displayed to the user "
                      f"above your reply — do not embed or link them.{note}",
                      {"images": urls, "prompt": prompt})


# ── 3D models (NYX / Hunyuan3D-2) ───────────────────────────────────────────

HUNYUAN3D = "hunyuan3d-dit-v2.safetensors"
BIREFNET = "birefnet.safetensors"
REF_STYLE = (", a single complete object, entire object in frame and centered, three-quarter view, isolated on a plain pure "
             "white background, soft even studio lighting, no cast shadow, no text, product render")


def _hunyuan_workflow(image_node: list, seed: int, octree: int) -> dict:
    """Image → shape: cut the object out onto white with BiRefNet (otherwise floor shadows become a ground sheet in the
    mesh), DINOv2 conditioning, the Hunyuan3D-2 DiT, then surface-net meshing to GLB. Input must be 1024×1024."""
    return {
        "30": {"class_type": "LoadBackgroundRemovalModel", "inputs": {"bg_removal_name": BIREFNET}},
        "31": {"class_type": "RemoveBackground", "inputs": {"image": image_node, "bg_removal_model": ["30", 0]}},
        "32": {"class_type": "EmptyImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1, "color": 0xFFFFFF}},
        "33": {"class_type": "ImageCompositeMasked", "inputs": {"destination": ["32", 0], "source": image_node, "x": 0, "y": 0,
                                                                "resize_source": False, "mask": ["31", 0]}},
        "34": {"class_type": "SaveImage", "inputs": {"filename_prefix": "ShellB_Web_3dcut", "images": ["33", 0]}},
        "20": {"class_type": "ImageOnlyCheckpointLoader", "inputs": {"ckpt_name": HUNYUAN3D}},
        "21": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["20", 0], "shift": 1.0}},
        "22": {"class_type": "CLIPVisionEncode", "inputs": {"clip_vision": ["20", 1], "image": ["33", 0], "crop": "none"}},
        "23": {"class_type": "Hunyuan3Dv2Conditioning", "inputs": {"clip_vision_output": ["22", 0]}},
        "24": {"class_type": "EmptyLatentHunyuan3Dv2", "inputs": {"resolution": 3072, "batch_size": 1}},
        "25": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 30, "cfg": 5.0, "sampler_name": "euler",
                                                    "scheduler": "normal", "denoise": 1.0, "model": ["21", 0],
                                                    "positive": ["23", 0], "negative": ["23", 1], "latent_image": ["24", 0]}},
        "26": {"class_type": "VAEDecodeHunyuan3D", "inputs": {"samples": ["25", 0], "vae": ["20", 2], "num_chunks": 8000,
                                                              "octree_resolution": octree}},
        "27": {"class_type": "VoxelToMesh", "inputs": {"voxel": ["26", 0], "algorithm": "surface net", "threshold": 0.6}},
        "28": {"class_type": "SaveGLB", "inputs": {"mesh": ["27", 0], "filename_prefix": "3d/ShellB_Web"}},
    }


def _finish_glb(data: bytes, color: list[float]) -> bytes:
    """ComfyUI's GLB carries positions and indices only. Add smooth vertex normals and a PBR material so it shades well
    in three.js and other viewers."""
    import struct
    jlen = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20:20 + jlen])
    boff = 20 + jlen
    blen = struct.unpack_from("<I", data, boff)[0]
    raw = data[boff + 8:boff + 8 + blen]
    bin_ = bytearray(raw)
    prim = gltf["meshes"][0]["primitives"][0]

    def read(acc_i, dtype, width):
        acc = gltf["accessors"][acc_i]
        bv = gltf["bufferViews"][acc["bufferView"]]
        start = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
        n = acc["count"] * {"SCALAR": 1, "VEC3": 3}[acc["type"]]
        return np.frombuffer(raw, dtype=dtype, count=n, offset=start).reshape(-1, width)

    pos = read(prim["attributes"]["POSITION"], np.float32, 3).astype(np.float64)
    idx = read(prim["indices"], {5125: np.uint32, 5123: np.uint16}[gltf["accessors"][prim["indices"]]["componentType"]], 3)
    if "NORMAL" not in prim["attributes"]:
        tri = pos[idx]
        fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])  # area-weighted face normals
        vn = np.zeros_like(pos)
        for k in range(3):
            np.add.at(vn, idx[:, k], fn)
        vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)
        while len(bin_) % 4:
            bin_.append(0)
        off = len(bin_)
        bin_ += vn.astype(np.float32).tobytes()
        gltf["bufferViews"].append({"buffer": 0, "byteOffset": off, "byteLength": len(bin_) - off, "target": 34962})
        gltf["accessors"].append({"bufferView": len(gltf["bufferViews"]) - 1, "componentType": 5126,
                                  "count": len(vn), "type": "VEC3"})
        prim["attributes"]["NORMAL"] = len(gltf["accessors"]) - 1
    if "material" not in prim:
        gltf.setdefault("materials", []).append({"name": "Generated", "pbrMetallicRoughness": {
            "baseColorFactor": [*color, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.6}})
        prim["material"] = len(gltf["materials"]) - 1
    gltf["asset"].pop("extras", None)  # drop the embedded ComfyUI workflow
    gltf["buffers"] = [{"byteLength": len(bin_)}]
    while len(bin_) % 4:
        bin_.append(0)
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bin_))
    return out + struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(bin_), 0x004E4942) + bytes(bin_)


def _mesh_preview(glb: bytes, color: list[float], size: int = 512) -> bytes:
    """Three shaded views (front, three-quarter, side) of a GLB mesh, rendered with numpy point splats. The screenshot
    browser has no WebGL, so this is how the agent gets to see the shape it generated."""
    import io
    import struct
    from PIL import Image
    jlen = struct.unpack_from("<I", glb, 12)[0]
    gltf = json.loads(glb[20:20 + jlen])
    raw = glb[20 + jlen + 8:]
    prim = gltf["meshes"][0]["primitives"][0]

    def read(i):
        acc = gltf["accessors"][i]
        bv = gltf["bufferViews"][acc["bufferView"]]
        return np.frombuffer(raw, np.float32, acc["count"] * 3, bv.get("byteOffset", 0) + acc.get("byteOffset", 0)).reshape(-1, 3)

    v, n = read(prim["attributes"]["POSITION"]).astype(np.float64), read(prim["attributes"]["NORMAL"]).astype(np.float64)
    v = v - (v.max(0) + v.min(0)) / 2
    scale = size * 0.42 / max(np.abs(v).max(), 1e-9)
    light = np.array([-0.4, 0.6, 0.7]) / np.linalg.norm([-0.4, 0.6, 0.7])
    base = np.array(color) * 255
    views = []
    for yaw in (0.0, -45.0, -90.0):
        a, pitch = np.radians(yaw), np.radians(-15.0)
        ry = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
        rx = np.array([[1, 0, 0], [0, np.cos(pitch), -np.sin(pitch)], [0, np.sin(pitch), np.cos(pitch)]])
        r = rx @ ry
        p, pn = v @ r.T, n @ r.T
        order = np.argsort(p[:, 2])  # far to near, so nearer points overwrite
        p, pn = p[order], pn[order]
        shade = np.clip(pn @ light, 0, 1) * 0.7 + 0.3
        rgb = np.clip(base[None, :] * shade[:, None], 0, 255).astype(np.uint8)
        img = np.full((size, size, 3), 244, np.uint8)
        x = (p[:, 0] * scale + size / 2).astype(int)
        y = (size / 2 - p[:, 1] * scale).astype(int)
        for dx, dy in ((0, 0), (1, 0), (0, 1), (1, 1)):
            xx, yy = np.clip(x + dx, 0, size - 1), np.clip(y + dy, 0, size - 1)
            img[yy, xx] = rgb
        views.append(img)
    buf = io.BytesIO()
    Image.fromarray(np.concatenate(views, axis=1)).save(buf, "PNG")
    return buf.getvalue()


async def _comfy_run(c: httpx.AsyncClient, workflow: dict, timeout_s: int) -> dict:
    r = await c.post(f"{COMFY}/prompt", json={"prompt": workflow, "client_id": uuid.uuid4().hex})
    r.raise_for_status()
    pid = r.json()["prompt_id"]
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        await asyncio.sleep(2.0)
        try:  # ComfyUI can stall its HTTP loop for a while when loading big checkpoints
            h = (await c.get(f"{COMFY}/history/{pid}", timeout=30)).json()
        except httpx.TimeoutException:
            continue
        if pid in h:
            status = h[pid].get("status", {})
            if status.get("status_str") == "error":
                raise RuntimeError(f"ComfyUI failed: {json.dumps(status.get('messages', []))[:800]}")
            if h[pid].get("outputs") and status.get("completed", True):
                return h[pid]["outputs"]
    raise TimeoutError(f"3D generation timed out after {timeout_s}s.")


async def generate_3d(args, ctx):
    from PIL import Image
    import io
    prompt = str(args.get("prompt") or "").strip()
    image = str(args.get("image") or "").strip().lstrip("/")
    if not prompt and not image:
        return ToolResult("Give a prompt (text to 3D) or an image path in the project (image to 3D).", error=True)
    seed = int(args.get("seed") or random.randint(0, 2**31 - 1))
    octree = 384 if str(args.get("quality") or "").lower() == "high" else 256
    color = args.get("color") or "#c8c8cc"
    try:
        rgb = [int(color.lstrip("#")[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    except (ValueError, AttributeError):
        rgb = [0.78, 0.78, 0.8]
    root = (db.DATA / "projects" / ctx.project_id).resolve() if ctx.project_id else None
    keep = {ctx.agent.get("model", "")}
    evicted = await make_room(36 if not image else 16, keep)
    async with httpx.AsyncClient(timeout=60) as c:
        if image:
            if not root:
                return ToolResult("image= needs a Studio project; outside one, describe the object with prompt instead.", error=True)
            src = (root / image).resolve()
            if not str(src).startswith(str(root) + "/") or not src.is_file():
                return ToolResult(f"No such image in the project: {image!r}", error=True)
            with Image.open(src) as im:  # flatten transparency onto white and pad to a centered 1024² square
                im = im.convert("RGBA")
                im.thumbnail((900, 900))
                flat = Image.new("RGB", (1024, 1024), (255, 255, 255))
                flat.paste(im, ((1024 - im.width) // 2, (1024 - im.height) // 2), mask=im.split()[3])
                buf = io.BytesIO()
                flat.save(buf, "PNG")
            up = await c.post(f"{COMFY}/upload/image", files={"image": (f"ref-{uuid.uuid4().hex[:8]}.png", buf.getvalue(), "image/png")},
                              data={"overwrite": "true"})
            up.raise_for_status()
            wf = {"9": {"class_type": "LoadImage", "inputs": {"image": up.json()["name"]}}}
        else:
            wf = _flux_workflow(prompt + REF_STYLE, 1024, 1024, seed)
            wf["10"]["inputs"]["filename_prefix"] = "ShellB_Web_3dref"
        wf.update(_hunyuan_workflow(["9", 0], seed, octree))
        t0 = time.time()
        try:
            outputs = await _comfy_run(c, wf, 900)
        except (RuntimeError, TimeoutError) as e:
            return ToolResult(str(e), error=True)
        finally:
            await c.post(f"{COMFY}/free", json={"unload_models": True, "free_memory": True})

        async def fetch(item):
            return (await c.get(f"{COMFY}/view", params={"filename": item["filename"], "subfolder": item.get("subfolder", ""),
                                                         "type": item.get("type", "output")})).content
        glb_item = next((f for n in outputs.values() for f in n.get("3d", [])), None)
        ref_item = next((f for f in outputs.get("34", {}).get("images", [])), None)
        if not glb_item:
            return ToolResult(f"ComfyUI finished without a mesh: {json.dumps(outputs)[:500]}", error=True)
        glb = _finish_glb(await fetch(glb_item), rgb)
        ref = await fetch(ref_item) if ref_item else None
    elapsed = time.time() - t0
    preview = await asyncio.to_thread(_mesh_preview, glb, rgb)

    slug = re.sub(r"[^a-z0-9]+", "-", (prompt or Path(image).stem).lower())[:40].strip("-") or "model"
    images, saved = [], []
    if root:
        want = str(args.get("save_as") or "").strip().lstrip("/") or f"assets/models/{slug}-{seed % 10000}.glb"
        want = re.sub(r"\.\w+$", "", want) + ".glb"
        dest = (root / want).resolve()
        if not str(dest).startswith(str(root) + "/"):
            return ToolResult(f"save_as must stay inside the project: {want!r}", error=True)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(glb)
        saved.append(want)
        await ctx.emit({"type": "file", "path": want, "action": "created"})
        for suffix, data in (("-ref.png", ref), ("-preview.png", preview)):
            if data:
                rel = want[:-4] + suffix
                (root / rel).write_bytes(data)
                saved.append(rel)
                images.append(f"/api/projects/{ctx.project_id}/raw/{rel}")
                await ctx.emit({"type": "file", "path": rel, "action": "created"})
        where = f"Saved as {want} — load it with GLTFLoader from that relative path."
        url = f"/api/projects/{ctx.project_id}/raw/{want}"
    else:
        name = f"model-{uuid.uuid4().hex[:12]}.glb"
        (FILES / name).write_bytes(glb)
        url = f"/api/files/{name}"
        where = f"Download link: {url}"
        for data in (ref, preview):
            if data:
                rname = f"img-{uuid.uuid4().hex[:12]}.png"
                (FILES / rname).write_bytes(data)
                images.append(f"/api/files/{rname}")
    note = f" (evicted idle models to make room: {', '.join(evicted)})" if evicted else ""
    from studio_tools import _deliver_images  # vision models see the mesh views; text-only ones get a written review
    review, model_imgs = await _deliver_images(ctx, [preview], "", "These are three views (front, three-quarter, side) of a "
                                               f"generated 3D mesh of: {prompt or image}. Say whether the shape is right and "
                                               "list any defects: missing parts, blobs, holes, a ground sheet, wrong proportions.")
    return ToolResult(
        f"Generated a 3D model in {elapsed:.0f}s (seed {seed}, octree {octree}, {len(glb) / 1e6:.1f} MB GLB). {where} "
        "It is geometry only: one mesh with smooth normals and a single flat material, no textures, roughly 2 units across "
        "and centered on the origin, Y up. Recolor or re-material it in three.js (traverse meshes and set material), scale "
        "it to fit, and frame the camera from its bounding box. Shown above your reply: the cut-out reference image it was "
        "built from, then the mesh itself from the front, three-quarter and side. Check the mesh views for missing parts "
        f"or blobs; if it is wrong, try again with a clearer, simpler object description or another seed.{note}{review}",
        {"images": images, "prompt": prompt or image, "model": url}, model_images=model_imgs)


# ── music (ORPHEUS / MusicGen) ──────────────────────────────────────────────

async def generate_music(args, ctx):
    from studio_assets import make_loop, save_output, slug
    prompt = str(args.get("prompt") or "").strip()
    duration = max(3.0, min(30.0, float(args.get("duration") or 12)))
    loop = bool(args.get("loop"))
    async with httpx.AsyncClient(timeout=600) as c:
        r = await c.post(f"{ORPHEUS}/generate", json={"prompt": prompt, "duration": min(30.0, duration + (2 if loop else 0))})
        r.raise_for_status()
    wav = make_loop(r.content, 2.0) if loop else r.content
    try:
        rel, url = await save_output(ctx, wav, f"assets/audio/music/{slug(prompt, 'music')}.wav", ".wav",
                                     str(args.get("save_as") or ""))
    except ValueError as e:
        return ToolResult(str(e), error=True)
    elapsed = r.headers.get("X-Orpheus-Elapsed", "?")
    try:
        secs = float(elapsed.rstrip("s"))
    except ValueError:
        secs = None
    where = f" Saved into the project as {rel}." if rel else ""
    if loop:
        where += " The ends are crossfaded so it loops: play it with loop=true."
    return ToolResult(f"Generated {duration:.0f}s of music ({elapsed}).{where} A player with the waveform and audio details is "
                      "already shown to the user — do not link it or repeat those stats.",
                      {"audio": [url], "prompt": prompt,
                       "audioInfo": {"model": r.headers.get("X-Orpheus-Model"), "elapsed": secs, "prompt": prompt}})


# ── memory (embeddings in SQLite) ───────────────────────────────────────────

async def embed(texts: list[str], model: str) -> np.ndarray:
    import fleet
    r = await fleet.post("/api/embed", {"model": model, "input": texts, "keep_alive": "2h",
                                        "options": {"num_ctx": 2048}}, timeout=60)  # memories are short; default ctx wastes ~10 GB
    r.raise_for_status()
    v = np.array(r.json()["embeddings"], dtype=np.float32)
    return v / (np.linalg.norm(v, axis=1, keepdims=True) + 1e-9)


async def search_memories(query: str, settings: dict, k=5, min_score=0.0):
    import memory
    return await memory.search(query, settings, k=k, min_score=min_score)


async def memory_save(args, ctx):
    import memory
    text = str(args.get("text") or "").strip()
    if not text:
        return ToolResult("Nothing to remember.", error=True)
    tags = args.get("tags") or []
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]
    replaces = str(args.get("replaces") or "").strip() or None
    old = memory.get(replaces) if replaces else None
    if replaces and (not old or old["status"] != "active"):
        return ToolResult(f"No active memory {replaces} to replace; check the id with memory_search.", error=True)
    mid, dup = await memory.add(text, category=args.get("category") or (old and old["category"]) or "other",
                                origin="user" if not ctx.conv_id else "agent", source=ctx.conv_id or None,
                                expires=args.get("expires"), pinned=bool(old and old["pinned"]), replaces=replaces,
                                tags=tags, settings=ctx.settings)
    if dup:
        if dup["status"] == "pending":
            memory.accept(dup["id"])
        return ToolResult(f"Already remembered (as {dup['id']}): {dup['text']}")
    return ToolResult(f"Remembered ({mid})" + (f", replacing {replaces}." if replaces else "."), {"memory": text})


async def memory_forget(args, ctx):
    import memory
    mid = str(args.get("id") or "").strip()
    m = memory.get(mid)
    if not m or m["status"] != "active":
        return ToolResult(f"No active memory {mid}; find the id with memory_search.", error=True)
    memory.retire(mid, str(args.get("reason") or "Forgotten at the user's request")[:200])
    return ToolResult(f"Forgot {mid}: {m['text']}", {"memory": f"Forgot: {m['text']}"})


async def memory_search(args, ctx):
    hits = await search_memories(str(args.get("query") or ""), ctx.settings, k=int(args.get("k") or 6))
    import providers
    if providers.is_cloud((ctx.agent or {}).get("model", "")):  # privacy.py: local-only memories stay on this machine
        hits = [h for h in hits if not h.get("localOnly")]
    if not hits:
        return ToolResult("No matching memories.")
    return ToolResult("\n".join(f"- [{h['id']}] ({h['category']}, {h['score']:.2f}) {h['text']}" for h in hits))


async def recall_conversations(args, ctx):
    from datetime import datetime
    import episodes
    action = str(args.get("action") or "search").lower()
    if action == "read":
        cid = str(args.get("conversation_id") or "").strip()
        text = episodes.read(cid, str(args.get("message_id") or "").strip())
        if text is None:
            return ToolResult(f"No conversation {cid}; search first to get its id.", error=True)
        return ToolResult(text, {"memory": f"Read a past conversation"})
    q = str(args.get("query") or "").strip()
    if not q:
        return ToolResult("Give a query to search past conversations.", error=True)
    hits = await episodes.search(q, ctx.settings, limit=max(1, min(int(args.get("limit") or 6), 12)), exclude=ctx.conv_id)
    if not hits:
        return ToolResult("No past conversation matches that.")
    out = []
    for h in hits:
        out.append(f"## {h['title']} ({h['convId']}) · {h['where']} · {datetime.fromtimestamp(h['updatedAt'] / 1000):%b %d %Y}"
                   + (f"\nSummary: {h['summary']}" if h["summary"] else "")
                   + "".join(f"\n- [{x['msgId']}] {x['role']}: {x['snippet'].replace('[[', '').replace(']]', '')}" for x in h["hits"]))
    return ToolResult("\n\n".join(out) + "\n\nUse action=read with a conversation_id (and optionally a message_id) for the full text.")


# ── delegation ──────────────────────────────────────────────────────────────

async def ask_agent(args, ctx):
    if ctx.run_subagent is None or ctx.depth >= 1:
        return ToolResult("Delegation is not available from a sub-agent.", error=True)
    agent_id = str(args.get("agent_id") or "").strip().lower()
    task = str(args.get("task") or "").strip()
    reply = await ctx.run_subagent(agent_id, task)
    return ToolResult(reply, {"delegate": agent_id})


# ── registry ────────────────────────────────────────────────────────────────

TOOLS: dict[str, dict[str, Any]] = {
    "web_search": {
        "fn": web_search, "service": "searxng",
        "ui": {"displayName": "Web Search", "icon": "Search", "category": "web",
               "description": "Private web search through VASSAGO (SearXNG)."},
        "schema": _fn("web_search", "Search the web. Use for anything current, factual, or outside your knowledge. "
                      "Returns titles, URLs and snippets; follow up with web_fetch to read pages.",
                      {"query": {"type": "string", "description": "Search query"},
                       "max_results": {"type": "integer", "description": "Number of results (default 6)"}}, ["query"]),
    },
    "web_fetch": {
        "fn": web_fetch, "service": None,
        "ui": {"displayName": "Read Web Page", "icon": "Globe", "category": "web",
               "description": "Fetches a URL and extracts the readable content as Markdown."},
        "schema": _fn("web_fetch", "Fetch a web page or text URL and return its main content as Markdown.",
                      {"url": {"type": "string", "description": "Absolute http(s) URL"},
                       "start": {"type": "integer", "description": "Character offset to continue a long page"}}, ["url"]),
    },
    "run_code": {
        "fn": run_code, "service": "sandbox",
        "ui": {"displayName": "Code Sandbox", "icon": "Terminal", "category": "code",
               "description": "Runs Python or Bash in an isolated, network-less container with a per-conversation /work folder."},
        "schema": _fn("run_code", "Execute code in an isolated sandbox (no network). Python 3.12 with numpy, pandas, scipy, "
                      "sympy, scikit-learn, polars, duckdb, xgboost, lightgbm, cvxpy, ortools, pulp, geopandas, astropy, "
                      "skyfield, matplotlib, plotly, pillow, opencv, openpyxl, python-docx/pptx, pymupdf, pdfplumber, weasyprint, "
                      "pytesseract and playwright. CLI: pandoc, libreoffice (soffice --headless --convert-to pdf), xelatex/pdflatex, "
                      "ImageMagick, `chromium --headless --screenshot`, poppler-utils, ffmpeg, tesseract (eng spa jpn fra deu ita "
                      "por rus ara hin kor chi_sim chi_tra), Noto fonts incl. CJK and emoji, node, go, rustc/cargo, java, R. "
                      "No GPU, and nothing can be installed. The working directory /work persists for this "
                      "conversation and holds any files the user uploaded. Save plots as PNG files in /work to show them. "
                      "Print results you want to see.",
                      {"language": {"type": "string", "enum": ["python", "bash"]},
                       "code": {"type": "string", "description": "The full program to run"}}, ["language", "code"]),
    },
    "create_artifact": {
        "fn": create_artifact, "service": None,
        "ui": {"displayName": "Artifacts", "icon": "Boxes", "category": "creative",
               "description": "Opens apps, documents, SVGs, diagrams and code in the side workspace, with versions."},
        "schema": _fn("create_artifact",
                      "Create or update a document/app shown in the side panel. Use it for substantial, self-contained "
                      "deliverables: interactive HTML apps or pages, SVG graphics, Markdown documents, Mermaid diagrams, "
                      "or complete code files. Reuse the same id to publish a new version. Always send the complete content.",
                      {"id": {"type": "string", "description": "Short kebab-case id, e.g. 'pomodoro-timer'"},
                       "title": {"type": "string"},
                       "type": {"type": "string", "enum": list(ARTIFACT_TYPES)},
                       "language": {"type": "string", "description": "For type=code: the programming language"},
                       "content": {"type": "string", "description": "Full content of the artifact"}},
                      ["id", "title", "type", "content"]),
    },
    "generate_image": {
        "fn": generate_image, "service": "nyx",
        "ui": {"displayName": "Image Generation", "icon": "Image", "category": "creative",
               "description": "FLUX.1-schnell on NYX (ComfyUI). ~10 s per image."},
        "schema": _fn("generate_image", "Generate an image from a detailed visual description using FLUX.",
                      {"prompt": {"type": "string", "description": "Rich visual description: subject, composition, lighting, style"},
                       "width": {"type": "integer", "description": "Pixels, 256-1536 (default 1024)"},
                       "height": {"type": "integer", "description": "Pixels, 256-1536 (default 1024)"},
                       "quality": {"type": "string", "enum": ["draft", "high"],
                                   "description": "draft = FLUX.1-schnell, ~10 s (default); high = FLUX.1-dev, ~1 min, better "
                                                  "detail, text rendering and prompt-following, for final hero art"},
                       "seed": {"type": "integer", "description": "Reuse a seed to keep a composition while changing words"},
                       "save_as": {"type": "string", "description": "Studio projects only: where to save it, e.g. assets/hero.png"}},
                      ["prompt"]),
    },
    "generate_3d": {
        "fn": generate_3d, "service": "nyx",
        "ui": {"displayName": "3D Model Generation", "icon": "Box", "category": "creative",
               "description": "Text or image to a 3D mesh (.glb) with FLUX + Hunyuan3D-2 on NYX. ~2-3 min per model."},
        "schema": _fn("generate_3d", "Generate a 3D model (.glb mesh) from a text description or from an image in the project. "
                      "Untextured geometry with one solid material. Takes 2-3 minutes, so make one model at a time.",
                      {"prompt": {"type": "string", "description": "The object to model: shape, proportions, style, materials. One object, not a scene."},
                       "image": {"type": "string", "description": "Studio projects only: instead of prompt, a project image of one object to lift into 3D, e.g. assets/chair.png"},
                       "color": {"type": "string", "description": "Base material color as #rrggbb (default light grey)"},
                       "quality": {"type": "string", "enum": ["standard", "high"], "description": "high = finer mesh, slower and larger (default standard)"},
                       "save_as": {"type": "string", "description": "Studio projects only: where to save it, e.g. assets/models/chair.glb"}},
                      []),
    },
    "generate_music": {
        "fn": generate_music, "service": "orpheus",
        "ui": {"displayName": "Music Generation", "icon": "Music", "category": "creative",
               "description": "MusicGen stereo on ORPHEUS."},
        "schema": _fn("generate_music", "Generate an instrumental music clip from a text description (genre, mood, instruments, tempo).",
                      {"prompt": {"type": "string", "description": "Genre, mood, instruments, tempo (bpm) and key, e.g. "
                                  "'chiptune boss battle, fast 160 bpm, square-wave lead, driving bass, A minor'"},
                       "duration": {"type": "number", "description": "Seconds, 3-30 (default 12)"},
                       "loop": {"type": "boolean", "description": "Crossfade the ends so it loops seamlessly (game/background music)"},
                       "save_as": {"type": "string", "description": "Studio projects only, e.g. assets/audio/music/theme.wav"}},
                      ["prompt"]),
    },
    "memory_save": {
        "fn": memory_save, "service": "embeddings",
        "ui": {"displayName": "Remember", "icon": "Brain", "category": "memory",
               "description": "Stores durable facts and preferences in long-term memory."},
        "schema": _fn("memory_save", "Save a durable fact to long-term memory: the user's preferences, projects, decisions, "
                      "or anything they ask you to remember. One self-contained fact per call. Don't save trivia or secrets. "
                      "To correct an existing memory, pass its id as `replaces` (the old one is retired).",
                      {"text": {"type": "string", "description": "One short third-person sentence, e.g. 'User prefers metric units.'"},
                       "category": {"type": "string", "enum": ["identity", "work", "preference", "person", "project",
                                                               "interest", "routine", "other"]},
                       "replaces": {"type": "string", "description": "Id of a memory this one corrects (mem-…)"},
                       "expires": {"type": "string", "description": "YYYY-MM-DD when the fact stops being true (a visit, a deadline)"},
                       "tags": {"type": "array", "items": {"type": "string"}}}, ["text"]),
    },
    "memory_forget": {
        "fn": memory_forget, "service": None,
        "ui": {"displayName": "Forget", "icon": "BrainCog", "category": "memory",
               "description": "Retires a long-term memory that is wrong, outdated, or that the user asks to forget."},
        "schema": _fn("memory_forget", "Forget a long-term memory that is wrong or no longer true, or that the user asks you to "
                      "forget. Use the id shown in your memory list or by memory_search. It can be restored in Settings → Memory.",
                      {"id": {"type": "string"}, "reason": {"type": "string"}}, ["id"]),
    },
    "memory_search": {
        "fn": memory_search, "service": "embeddings",
        "ui": {"displayName": "Recall", "icon": "BrainCircuit", "category": "memory",
               "description": "Semantic search over long-term memory."},
        "schema": _fn("memory_search", "Search long-term memory for facts about the user, their work, or past decisions.",
                      {"query": {"type": "string"}, "k": {"type": "integer"}}, ["query"]),
    },
    "recall_conversations": {
        "fn": recall_conversations, "service": None,
        "ui": {"displayName": "Past Conversations", "icon": "History", "category": "memory",
               "description": "Searches and reads earlier conversations with the user (full text and summaries)."},
        "schema": _fn("recall_conversations", "Search or read your earlier conversations with the user. Use when they refer "
                      "to a past chat or earlier work. action=search (query) lists matching conversations with summaries "
                      "and snippets; action=read (conversation_id, optional message_id) returns the transcript.",
                      {"action": {"type": "string", "enum": ["search", "read"]},
                       "query": {"type": "string", "description": "search: what to look for"},
                       "conversation_id": {"type": "string", "description": "read: conv-… id from a search"},
                       "message_id": {"type": "string", "description": "read: show the part around this msg-… id"},
                       "limit": {"type": "integer"}}, ["action"]),
    },
    "ask_agent": {
        "fn": ask_agent, "service": None,
        "ui": {"displayName": "Delegate to Agent", "icon": "GitFork", "category": "subagent",
               "description": "Hands a self-contained task to another Shell:B agent and returns its answer."},
        "schema": None,  # built per request so the enum lists the current agents
    },
}


def ask_agent_schema(agents):
    import providers
    roster = "; ".join(f"{a['id']}{' [cloud: data leaves this machine]' if providers.is_cloud(a['model']) else ''}: "
                       f"{a['title']} — {a['description']}" for a in agents)
    return _fn("ask_agent", f"Delegate a self-contained task to a specialist agent and get its final answer. "
               f"The agent cannot see this conversation, so include all needed context. Agents: {roster}",
               {"agent_id": {"type": "string", "enum": [a["id"] for a in agents]},
                "task": {"type": "string", "description": "Complete brief including context and expected output"}},
               ["agent_id", "task"])
