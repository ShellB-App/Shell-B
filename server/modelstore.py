"""Model Store (#/models → Store, Updates): find, download and keep models current from Hugging Face and Ollama.

- Search: the Hugging Face Hub API, and ollama.com's library pages (no official API, so `_ollama_search` and
  `_ollama_tags` read the HTML; if the markup changes they return nothing rather than failing the page).
- Downloads: Ollama models and Hugging Face GGUFs (`hf.co/<repo>:<quant>`) go through modelhub's pull, so they show up
  under Installed like any other pull. Single-file `.safetensors` weights go into a ComfyUI model folder with resume
  and a sha256 check against the Hub's LFS hash. Pickle formats (.ckpt/.pt/.bin) are refused: loading one can run code.
- Updates: Ollama models compare their local manifest digest with the registry's (sha256 of the manifest body, the
  same digest `ollama list` shows); files this store downloaded compare their sha256 with the Hub's current one.
  `data/modelstore.json` records where each downloaded file came from.

Searching is open to anyone who can use the app; downloading, updating, deleting and the Hub token need the owner.
"""
import asyncio
import hashlib
import html
import json
import re
import shutil
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request

import db

router = APIRouter(prefix="/api/modelstore")
HF = "https://huggingface.co"
OLLAMA_SITE = "https://ollama.com"
OLLAMA = "http://localhost:11434"
COMFY_MODELS = Path.home() / "comfyui/models"
DESTS = {  # ComfyUI folder → what goes there
    "checkpoints": "Checkpoints (SD 1.5 / SDXL / all-in-one)",
    "diffusion_models": "Diffusion models (FLUX, Chroma, DiT)",
    "unet": "UNet (legacy diffusion-model folder)",
    "vae": "VAE",
    "loras": "LoRAs",
    "text_encoders": "Text encoders (T5, CLIP, Qwen)",
    "clip_vision": "CLIP vision",
    "controlnet": "ControlNet",
    "upscale_models": "Upscalers",
    "embeddings": "Textual-inversion embeddings",
}
MANIFEST = db.DATA / "modelstore.json"
TOKEN_FILE = db.DATA / "modelstore" / "hf.token"
NYX_UNIT = Path.home() / ".config/systemd/user/shellb-nyx.service"
REPO_RE = re.compile(r"^[\w.\-]{1,96}/[\w.\-]{1,96}$")
FILE_RE = re.compile(r"^[\w.\-/ ]{1,300}$")
SAFE_EXT = (".safetensors", ".gguf")
QUANT_RE = re.compile(r"(?:^|[-_.])((?:IQ|Q)\d(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4)(?=[-_.])", re.I)
UA = {"User-Agent": "ShellB-ModelStore/1.0"}

_jobs: dict[str, dict] = {}
_tasks: dict[str, asyncio.Task] = {}
_cache: dict[str, tuple[float, object]] = {}


def _owner(req: Request):
    import remote
    remote.require_admin(req)


def _cached(key: str, ttl: float):
    hit = _cache.get(key)
    return hit[1] if hit and time.time() - hit[0] < ttl else None


def _put(key: str, value):
    _cache[key] = (time.time(), value)
    return value


# ── Hugging Face token ──────────────────────────────────────────────────────

def hf_token() -> str:
    """The store's own token, else the one NYX already uses for gated FLUX files."""
    if TOKEN_FILE.is_file():
        return TOKEN_FILE.read_text().strip()
    try:
        m = re.search(r'HF_TOKEN=([^\s"]+)', NYX_UNIT.read_text())
        return m.group(1) if m else ""
    except OSError:
        return ""


def _hf_headers() -> dict:
    t = hf_token()
    return {**UA, **({"Authorization": f"Bearer {t}"} if t else {})}


# ── manifest ────────────────────────────────────────────────────────────────

def _manifest() -> dict:
    try:
        return json.loads(MANIFEST.read_text())
    except (OSError, ValueError):
        return {"files": {}}


def _save_manifest(m: dict):
    tmp = MANIFEST.with_suffix(".tmp")
    tmp.write_text(json.dumps(m, indent=1))
    tmp.replace(MANIFEST)


# ── search ──────────────────────────────────────────────────────────────────

HF_KINDS = {"llm": {"filter": "gguf"}, "image": {"pipeline_tag": "text-to-image"}, "lora": {"filter": "lora"}, "all": {}}
HF_SORTS = {"downloads", "likes", "trendingScore", "lastModified"}


async def _hf_search(q: str, kind: str, sort: str) -> list[dict]:
    params = [("limit", "40"), ("sort", sort if sort in HF_SORTS else "downloads"), ("direction", "-1"),
              *[("expand[]", e) for e in ("downloads", "likes", "lastModified", "gated", "pipeline_tag", "tags", "library_name")],
              *HF_KINDS.get(kind, {}).items()]
    if q:
        params.append(("search", q))
    async with httpx.AsyncClient(timeout=20, headers=_hf_headers()) as c:
        r = await c.get(f"{HF}/api/models", params=params)
    r.raise_for_status()
    out = []
    for m in r.json():
        tags = m.get("tags") or []
        out.append({"source": "hf", "id": m["id"], "downloads": m.get("downloads", 0), "likes": m.get("likes", 0),
                    "updated": m.get("lastModified"), "gated": bool(m.get("gated")), "pipeline": m.get("pipeline_tag") or "",
                    "license": next((t[8:] for t in tags if t.startswith("license:")), ""),
                    "formats": [t for t in ("gguf", "safetensors", "diffusers", "lora") if t in tags]})
    return out


def _count(v: str) -> int:
    v = v.replace(",", "").strip()
    mult = {"K": 1e3, "M": 1e6, "B": 1e9}.get(v[-1:].upper(), 1)
    try:
        return int(float(v.rstrip("KMBkmb")) * mult)
    except ValueError:
        return 0


def _ollama_search_parse(page: str) -> list[dict]:
    """Entries on ollama.com/search and /library (two slightly different layouts). Cloud-only models are dropped."""
    out = []
    for block in re.split(r"<li\b", page)[1:]:
        m = re.search(r'href="/library/([\w.\-]+)"', block)
        if not m:
            continue
        sizes = re.findall(r'bg-\[#ddf4ff\][^>]*>([\w.]+)</span>', block)
        cloud = bool(re.search(r'bg-cyan-50[^>]*>cloud</span>', block))
        if cloud and not sizes and "embedding" not in block:
            continue
        desc = re.search(r'<p[^>]*title="([^"]*)"', block) or re.search(r"<p[^>]*>\s*([^<]{8,}?)\s*</p>", block)
        dl = re.search(r'title="([\d,]+) downloads"', block) or re.search(r"<span\s*>([\d.,]+[KMB]?)</span>\s*<span[^>]*>&nbsp;Pulls", block)
        out.append({"source": "ollama", "id": m.group(1), "description": html.unescape(desc.group(1)) if desc else "",
                    "capabilities": re.findall(r'bg-indigo-50[^>]*>([\w-]+)</span>', block), "sizes": sizes,
                    "downloads": _count(dl.group(1)) if dl else 0})
    return out


async def _ollama_search(q: str, capability: str, sort: str) -> list[dict]:
    if not q and capability == "all" and sort in ("", "downloads"):  # the library page: everything, by all-time pulls
        url, params = f"{OLLAMA_SITE}/library", {}
    else:
        url = f"{OLLAMA_SITE}/search"
        params = [("c", "local"), *([("q", q)] if q else []), ("o", "newest" if sort == "newest" else "popular")]
        if capability in ("tools", "thinking", "embedding"):
            params.append(("c", capability))
    async with httpx.AsyncClient(timeout=20, headers=UA, follow_redirects=True) as c:
        r = await c.get(url, params=params)
    r.raise_for_status()
    return _ollama_search_parse(r.text)


def _ollama_tags_parse(name: str, page: str) -> list[dict]:
    out, seen = [], set()
    for m in re.finditer(rf'href="/library/{re.escape(name)}:([\w.\-]+)" class="md:hidden', page):
        tag = m.group(1)
        if tag in seen:
            continue
        seen.add(tag)
        chunk = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", page[m.end():m.end() + 1500]))
        info = re.search(r"\b([0-9a-f]{12})\b\s*•\s*([\d.]+\s*[KMGT]?B)\s*•\s*([\w.]+) context window\s*•\s*([\w, ]+?) input\s*•?\s*([\w ]+? ago)?", chunk)
        out.append({"tag": tag, "digest": info.group(1) if info else "", "size": info.group(2).replace(" ", "") if info else "",
                    "context": info.group(3) if info else "", "input": info.group(4).strip() if info else "",
                    "updated": (info.group(5) or "").strip() if info else ""})
    return out


async def _local_ollama() -> dict[str, str]:
    """Installed Ollama models → full manifest digest."""
    async with httpx.AsyncClient(timeout=10) as c:
        tags = (await c.get(f"{OLLAMA}/api/tags")).json().get("models", [])
    return {m["name"]: m.get("digest", "") for m in tags}


@router.get("/search")
async def api_search(source: str = "hf", q: str = "", kind: str = "all", sort: str = "downloads"):
    q = q.strip()[:120]
    key = f"s:{source}:{q}:{kind}:{sort}"
    if (hit := _cached(key, 600)) is not None:
        return hit
    try:
        items = await (_ollama_search(q, kind, sort) if source == "ollama" else _hf_search(q, kind, sort))
    except httpx.HTTPError as e:
        raise HTTPException(502, f"{'ollama.com' if source == 'ollama' else 'Hugging Face'} didn't answer: {e}")
    if source == "ollama":
        local = await _local_ollama()
        bases = {n.split(":")[0] for n in local}
        for m in items:
            m["installed"] = m["id"] in bases
    return _put(key, {"items": items})


# ── details ─────────────────────────────────────────────────────────────────

DIFFUSERS_PART = re.compile(r"(^|/)(unet|vae|text_encoder(_\d)?|transformer|tokenizer(_\d)?|scheduler|image_encoder)/|"
                            r"diffusion_pytorch_model|model-\d{5}-of-\d{5}")


def _guess_dest(path: str, size: int, tags: list[str]) -> str:
    n = path.lower()
    for seg in n.split("/")[:-1]:  # Comfy-Org style repos: split_files/<folder>/<file>
        if seg in DESTS:
            return seg
    if "lora" in n or "lora" in tags:
        return "loras"
    if re.search(r"(^|[/_\-.])vae([/_\-.]|$)|\bae\.safetensors$", n):
        return "vae"
    if re.search(r"t5|umt5|clip_[lg]|text_encoder|qwen.*(vl|2\.5)", n):
        return "text_encoders"
    if "controlnet" in n:
        return "controlnet"
    if re.search(r"esrgan|upscal|4x|2x_", n):
        return "upscale_models"
    if re.search(r"flux|chroma|dit|transformer|wan|hunyuan|z[-_]?image|qwen[-_]?image", n) and "checkpoint" not in n:
        return "diffusion_models"
    return "checkpoints"


async def _hf_repo(repo: str, fresh: bool = False) -> dict:
    key = f"r:{repo}"
    if not fresh and (hit := _cached(key, 300)) is not None:
        return hit
    async with httpx.AsyncClient(timeout=30, headers=_hf_headers()) as c:
        r = await c.get(f"{HF}/api/models/{repo}", params={"blobs": "true"})
    if r.status_code in (401, 403, 404):
        raise HTTPException(404, "No such repository, or it's private.")
    r.raise_for_status()
    return _put(key, r.json())


@router.get("/hf/{repo:path}")
async def api_hf_repo(repo: str):
    if not REPO_RE.match(repo):
        raise HTTPException(400, "Use owner/name.")
    d = await _hf_repo(repo)
    tags = d.get("tags") or []
    man = _manifest()["files"]
    have = {(v["repo"], v["file"]): k for k, v in man.items()}
    gguf: dict[str, dict] = {}
    files = []
    for s in d.get("siblings") or []:
        path, size = s["rfilename"], (s.get("lfs") or {}).get("size") or s.get("size") or 0
        low = path.lower()
        if low.endswith(".gguf"):
            if "mmproj" in low:
                continue
            q = QUANT_RE.search(Path(path).name)
            quant = q.group(1).upper() if q else Path(path).stem
            g = gguf.setdefault(quant, {"quant": quant, "size": 0, "files": 0})
            g["size"] += size
            g["files"] += 1
        elif low.endswith(".safetensors"):
            files.append({"path": path, "size": size, "sha256": (s.get("lfs") or {}).get("sha256", ""),
                          "dest": _guess_dest(path, size, tags), "subfolder": "/" in path,
                          "diffusersPart": bool(DIFFUSERS_PART.search(low)),
                          "installed": have.get((repo, path), "")})
    readme = ""
    try:
        async with httpx.AsyncClient(timeout=15, headers=_hf_headers(), follow_redirects=True) as c:
            r = await c.get(f"{HF}/{repo}/raw/main/README.md")
            if r.status_code == 200:
                readme = re.sub(r"^---\n.*?\n---\n", "", r.text, flags=re.S)[:8000]
    except httpx.HTTPError:
        pass
    local = await _local_ollama()
    quants = sorted(gguf.values(), key=lambda g: g["size"])
    for g in quants:
        g["pull"] = f"hf.co/{repo}:{g['quant']}"
        g["installed"] = any(n.lower() == g["pull"].lower() for n in local)
    card = d.get("cardData") or {}
    return {"id": d["id"], "sha": d.get("sha"), "updated": d.get("lastModified"), "gated": d.get("gated") or False,
            "license": card.get("license") or next((t[8:] for t in tags if t.startswith("license:")), ""),
            "pipeline": d.get("pipeline_tag") or "", "downloads": d.get("downloads", 0), "likes": d.get("likes", 0),
            "baseModel": card.get("base_model"), "gguf": quants, "files": sorted(files, key=lambda f: (f["diffusersPart"], f["subfolder"], f["path"])),
            "readme": readme, "diffusers": "model_index.json" in {s["rfilename"] for s in d.get("siblings") or []},
            "dests": DESTS, "tokenSet": bool(hf_token())}


@router.get("/ollama/{name}")
async def api_ollama_model(name: str):
    if not re.match(r"^[\w.\-]{1,80}$", name):
        raise HTTPException(400, "Bad model name.")
    key = f"o:{name}"
    if (hit := _cached(key, 600)) is None:
        async with httpx.AsyncClient(timeout=20, headers=UA, follow_redirects=True) as c:
            r = await c.get(f"{OLLAMA_SITE}/library/{name}/tags")
        if r.status_code == 404:
            raise HTTPException(404, "No such model in the Ollama library.")
        r.raise_for_status()
        desc = re.search(r'<meta name="description" content="([^"]*)"', r.text)
        hit = _put(key, {"name": name, "description": html.unescape(desc.group(1)) if desc else "",
                         "tags": [t for t in _ollama_tags_parse(name, r.text) if "cloud" not in t["tag"]]})
    local = await _local_ollama()
    tags = [{**t, "installed": f"{name}:{t['tag']}" in local,
             "current": local.get(f"{name}:{t['tag']}", "").startswith(t["digest"]) if t["digest"] else None} for t in hit["tags"]]
    return {**hit, "tags": tags}


# ── downloads ───────────────────────────────────────────────────────────────

def _dest_path(dest: str, file: str) -> Path:
    if dest not in DESTS:
        raise HTTPException(400, f"Destination must be one of: {', '.join(DESTS)}")
    name = Path(file).name
    if not name.lower().endswith(".safetensors") or name.startswith("."):
        raise HTTPException(400, "Only .safetensors files go into ComfyUI from here (pickle formats can run code).")
    folder = (COMFY_MODELS / dest).resolve()
    p = (folder / name).resolve()
    if p.parent != folder:
        raise HTTPException(400, "Bad file name.")
    return p


async def _download(jid: str, repo: str, file: str, revision: str, sha256: str, size: int, target: Path):
    j = _jobs[jid]
    part = target.with_name(f".{target.name}.part")
    h = hashlib.sha256()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        have = part.stat().st_size if part.exists() else 0
        if have > size:
            part.unlink()
            have = 0
        if have:  # resume: hash what's already there first
            j["status"] = "Checking the partial download"
            with part.open("rb") as f:
                while chunk := await asyncio.to_thread(f.read, 8 << 20):
                    h.update(chunk)
        j.update(completed=have, status="Downloading")
        url = f"{HF}/{repo}/resolve/{revision}/{file}"
        headers = {**_hf_headers(), **({"Range": f"bytes={have}-"} if have else {})}
        t0, b0 = time.time(), have
        async with httpx.AsyncClient(timeout=httpx.Timeout(60, connect=20), follow_redirects=True) as c:
            async with c.stream("GET", url, headers=headers) as r:
                if r.status_code in (401, 403):
                    raise RuntimeError("Hugging Face refused: the repo is gated. Accept its terms on the website and set a token.")
                if r.status_code == 200 and have:  # server ignored the range: start over
                    have = 0
                    h = hashlib.sha256()
                    part.unlink(missing_ok=True)
                if r.status_code not in (200, 206):
                    raise RuntimeError(f"HTTP {r.status_code}")
                with part.open("ab") as f:
                    async for chunk in r.aiter_bytes(4 << 20):
                        await asyncio.to_thread(f.write, chunk)
                        h.update(chunk)
                        have += len(chunk)
                        dt = time.time() - t0
                        j.update(completed=have, rate=(have - b0) / dt if dt > 1 else None)
        if size and have != size:
            raise RuntimeError(f"Incomplete download ({have:,} of {size:,} bytes). Retry to resume.")
        j["status"] = "Verifying"
        if sha256 and h.hexdigest() != sha256:
            part.unlink(missing_ok=True)
            raise RuntimeError("Checksum mismatch: the file was discarded.")
        part.replace(target)
        m = _manifest()
        rel = str(target.relative_to(COMFY_MODELS))
        m["files"][rel] = {"repo": repo, "file": file, "revision": revision, "sha256": h.hexdigest(), "size": have,
                           "installedAt": time.time() * 1000}
        _save_manifest(m)
        j.update(state="done", status="Installed", finished=time.time() * 1000)
    except asyncio.CancelledError:
        j.update(state="cancelled", status="Paused (resumes where it stopped)", finished=time.time() * 1000)
        raise
    except Exception as e:  # noqa: BLE001
        j.update(state="error", status="Failed", error=str(e)[:300], finished=time.time() * 1000)
    finally:
        _tasks.pop(jid, None)


async def start_file(repo: str, file: str, dest: str) -> dict:
    if not REPO_RE.match(repo) or not FILE_RE.match(file) or ".." in file:
        raise HTTPException(400, "Bad repository or file.")
    target = _dest_path(dest, file)
    if target.exists():  # ComfyUI graphs name files exactly, so a same-named download would silently replace a model
        raise HTTPException(409, f"{target.name} is already in {dest}. Delete it first if you want this copy instead.")
    d = await _hf_repo(repo, fresh=True)
    sib = next((s for s in d.get("siblings") or [] if s["rfilename"] == file), None)
    if not sib:
        raise HTTPException(404, f"{file} isn't in {repo}.")
    lfs = sib.get("lfs") or {}
    size = lfs.get("size") or sib.get("size") or 0
    free = shutil.disk_usage(target.parent if target.parent.exists() else COMFY_MODELS).free
    if size + (2 << 30) > free:
        raise HTTPException(507, f"Not enough disk: needs {size / 1e9:.1f} GB plus 2 GB headroom, {free / 1e9:.1f} GB free.")
    jid = f"hf:{repo}/{file}"
    if jid in _tasks:
        raise HTTPException(409, "Already downloading.")
    _jobs[jid] = {"id": jid, "kind": "file", "name": Path(file).name, "repo": repo, "dest": dest, "state": "running",
                  "status": "Starting", "completed": 0, "total": size, "rate": None, "error": "", "started": time.time() * 1000,
                  "finished": None}
    _tasks[jid] = asyncio.create_task(_download(jid, repo, file, d.get("sha") or "main", lfs.get("sha256", ""), size, target))
    return _jobs[jid]


def start_pull(name: str) -> dict:
    import modelhub
    return modelhub.start_pull(name)


@router.post("/download")
async def api_download(req: Request):
    """{"pull": "<ollama name or hf.co/...:quant>"} or {"repo", "file", "dest"} for a ComfyUI file."""
    _owner(req)
    b = await req.json()
    if b.get("pull"):
        return start_pull(str(b["pull"]).strip())
    return await start_file(str(b.get("repo") or ""), str(b.get("file") or ""), str(b.get("dest") or ""))


@router.get("/jobs")
def api_jobs():
    """Store file downloads plus Ollama pulls (modelhub), newest first."""
    import modelhub
    pulls = [{"id": f"pull:{p['name']}", "kind": "pull", "name": p["name"], "state": p["state"], "status": p["status"],
              "completed": p.get("completed") or 0, "total": p.get("total") or 0, "rate": None, "error": p.get("error") or "",
              "started": p["started"], "finished": p.get("finished")} for p in list(modelhub._pulls.values())]
    return sorted([*_jobs.values(), *pulls], key=lambda j: -j["started"])


@router.post("/jobs/cancel")
async def api_cancel(req: Request):
    _owner(req)
    jid = str((await req.json()).get("id") or "")
    if jid.startswith("pull:"):
        import modelhub
        jid = jid[5:]
        if (t := modelhub._TASKS.get(jid)):
            t.cancel()
        return {"ok": True}
    t = _tasks.get(jid)
    if t:
        t.cancel()
    return {"ok": True}


@router.post("/jobs/dismiss")
async def api_dismiss(req: Request):
    jid = str((await req.json()).get("id") or "")
    if jid.startswith("pull:"):
        import modelhub
        if jid[5:] not in modelhub._TASKS:
            modelhub._pulls.pop(jid[5:], None)
    elif jid not in _tasks:
        _jobs.pop(jid, None)
    return {"ok": True}


def running() -> list[dict]:
    """For the top-bar download indicator (datasets.downloads)."""
    return [{"id": f"store:{j['id']}", "kind": "model", "name": j["name"], "detail": j["status"], "phase": "download",
             "done": j["completed"], "total": j["total"], "rate": j["rate"], "started": j["started"] / 1000, "link": "#/models"}
            for j in list(_jobs.values()) if j["state"] == "running"]


# ── installed ComfyUI files ─────────────────────────────────────────────────

def _referenced() -> str:
    """Shell:B's own source, to warn before deleting a file a tool loads by name."""
    if (hit := _cached("src", 300)) is not None:
        return hit
    src = "\n".join(p.read_text(errors="ignore") for p in Path(__file__).parent.glob("*.py"))
    try:
        from roster import get_settings
        src += "\n" + json.dumps(get_settings())
    except Exception:  # noqa: BLE001
        pass
    return _put("src", src)


@router.get("/files")
def api_files():
    man = _manifest()["files"]
    src = _referenced()
    out = []
    for dest in DESTS:
        folder = COMFY_MODELS / dest
        for f in sorted(folder.glob("*")) if folder.is_dir() else []:
            if f.is_file() and not f.name.startswith(".") and f.suffix.lower() in (".safetensors", ".gguf", ".ckpt", ".pt", ".pth", ".bin", ".sft"):
                rel = f"{dest}/{f.name}"
                st = f.stat()
                out.append({"path": rel, "dest": dest, "name": f.name, "size": st.st_size, "modified": st.st_mtime * 1000,
                            "source": man.get(rel), "inUse": f.name in src})
    du = shutil.disk_usage(COMFY_MODELS)
    return {"files": out, "dests": DESTS, "disk": {"total": du.total, "free": du.free}, "tokenSet": bool(hf_token())}


@router.delete("/files/{dest}/{name}")
def api_delete_file(dest: str, name: str, req: Request, force: bool = False):
    _owner(req)
    if dest not in DESTS:
        raise HTTPException(400, "Unknown folder.")
    folder = (COMFY_MODELS / dest).resolve()
    p = (folder / name).resolve()
    if p.parent != folder or not p.is_file():
        raise HTTPException(404, "No such file.")
    if name in _referenced() and not force:
        raise HTTPException(409, f"Shell:B loads {name} by name. Delete anyway?")
    p.unlink()
    m = _manifest()
    if m["files"].pop(f"{dest}/{name}", None):
        _save_manifest(m)
    _cache.pop("src", None)
    return {"ok": True}


# ── updates ─────────────────────────────────────────────────────────────────

def _registry_url(name: str) -> str | None:
    base, _, tag = name.partition(":")
    tag = tag or "latest"
    if base.startswith("hf.co/") or base.startswith("huggingface.co/"):
        return f"https://hf.co/v2/{base.split('/', 1)[1]}/manifests/{tag}"
    if base.count("/") == 0:
        return f"https://registry.ollama.ai/v2/library/{base}/manifests/{tag}"
    if base.count("/") == 1:
        return f"https://registry.ollama.ai/v2/{base}/manifests/{tag}"
    return None


async def _ollama_status(c: httpx.AsyncClient, sem: asyncio.Semaphore, name: str, digest: str) -> dict:
    url = _registry_url(name)
    st = {"kind": "ollama", "name": name.removesuffix(":latest"), "status": "local", "detail": "Created on this machine"}
    if not url:
        return st
    async with sem:
        try:
            r = await c.get(url, headers={**UA, "Accept": "application/vnd.docker.distribution.manifest.v2+json"})
        except httpx.HTTPError as e:
            return {**st, "status": "unknown", "detail": f"Registry didn't answer: {type(e).__name__}"}
    if r.status_code in (401, 404):
        return st
    if r.status_code != 200:
        return {**st, "status": "unknown", "detail": f"Registry said HTTP {r.status_code}"}
    remote = hashlib.sha256(r.content).hexdigest()
    if remote == digest:
        return {**st, "status": "current", "detail": "Up to date"}
    return {**st, "status": "update", "detail": "A newer build is published", "pull": name}


@router.get("/updates")
async def api_updates(fresh: bool = False):
    if not fresh and (hit := _cached("updates", 3600)) is not None:
        return hit
    local = await _local_ollama()
    sem = asyncio.Semaphore(8)
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as c:
        ollama = await asyncio.gather(*(_ollama_status(c, sem, n, d) for n, d in local.items()))
    files = []
    for rel, src in _manifest()["files"].items():
        st = {"kind": "file", "name": rel, "repo": src["repo"], "file": src["file"], "dest": rel.split("/", 1)[0]}
        if not (COMFY_MODELS / rel).is_file():
            files.append({**st, "status": "missing", "detail": "Recorded but no longer on disk"})
            continue
        try:
            d = await _hf_repo(src["repo"], fresh=True)
        except Exception as e:  # noqa: BLE001
            files.append({**st, "status": "unknown", "detail": f"Hub didn't answer: {str(e)[:80]}"})
            continue
        sib = next((s for s in d.get("siblings") or [] if s["rfilename"] == src["file"]), None)
        if not sib:
            files.append({**st, "status": "unknown", "detail": "The file was removed or renamed upstream"})
        elif (sib.get("lfs") or {}).get("sha256", src["sha256"]) != src["sha256"]:
            files.append({**st, "status": "update", "detail": f"Changed upstream {str(d.get('lastModified', ''))[:10]}"})
        else:
            files.append({**st, "status": "current", "detail": "Up to date"})
    order = {"update": 0, "missing": 1, "unknown": 2, "current": 3, "local": 4}
    items = sorted([*ollama, *files], key=lambda s: (order[s["status"]], s["name"].lower()))
    return _put("updates", {"items": items, "checked": time.time() * 1000})


@router.post("/update")
async def api_update(req: Request):
    _owner(req)
    b = await req.json()
    _cache.pop("updates", None)
    if b.get("kind") == "ollama":
        return start_pull(str(b.get("name") or ""))
    rel = str(b.get("name") or "")
    src = _manifest()["files"].get(rel)
    if not src:
        raise HTTPException(404, "This store didn't download that file, so it doesn't know where it came from.")
    target = COMFY_MODELS / rel
    if target.exists():  # download beside it, then replace: a failed update leaves the old file working
        target.replace(target.with_name(f".{target.name}.old"))
    try:
        job = await start_file(src["repo"], src["file"], rel.split("/", 1)[0])
    except Exception:
        old = target.with_name(f".{target.name}.old")
        if old.exists():
            old.replace(target)
        raise
    asyncio.create_task(_finish_update(job["id"], target))
    return job


async def _finish_update(jid: str, target: Path):
    t = _tasks.get(jid)
    if t:
        try:
            await t
        except asyncio.CancelledError:
            pass
    old = target.with_name(f".{target.name}.old")
    if _jobs.get(jid, {}).get("state") == "done":
        old.unlink(missing_ok=True)
    elif old.exists() and not target.exists():
        old.replace(target)


# ── settings ────────────────────────────────────────────────────────────────

@router.put("/hf-token")
async def api_set_token(req: Request):
    _owner(req)
    token = str((await req.json()).get("token") or "").strip()
    if token:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(f"{HF}/api/whoami-v2", headers={"Authorization": f"Bearer {token}"})
        if r.status_code != 200:
            raise HTTPException(400, "Hugging Face didn't accept that token.")
        TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        TOKEN_FILE.write_text(token)
        TOKEN_FILE.chmod(0o600)
        return {"ok": True, "user": r.json().get("name")}
    TOKEN_FILE.unlink(missing_ok=True)
    return {"ok": True}
