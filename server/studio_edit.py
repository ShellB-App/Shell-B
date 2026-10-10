"""edit_image: change a picture that already exists (NYX/ComfyUI). Three actions:

- cutout   remove the background with BiRefNet → a trimmed RGBA PNG (the same graph generate_sprite uses)
- upscale  an ESRGAN-family model from ~/comfyui/models/upscale_models (install one in Models → Store → Upscalers)
- inpaint  repaint the masked part from a prompt. The mask is a black/white image (white = repaint), or "background"
           / "subject" to let BiRefNet pick the area. FLUX.1-dev with inpaint conditioning when it is installed, else an
           SDXL checkpoint named by the `editCheckpoint` setting (Aphrodite's checkpoint is never used here).

Inputs are a path in the project or chat /work, or a generated /api/files name. Results save like the other asset
tools (studio_assets.save_output): into the project's assets/edited/ or /api/files, and media.py files them.
"""
import io
import random
import re
import time
import uuid
from pathlib import Path

import httpx

import db
from tools import BIREFNET, COMFY, FLUX_DEV, TOOLS, ToolResult, _comfy_run, _fn, flux_dev_available, make_room

COMFY_MODELS = Path.home() / "comfyui" / "models"
ACTIONS = ("cutout", "upscale", "inpaint")


def upscalers() -> list[str]:
    d = COMFY_MODELS / "upscale_models"
    return sorted(p.name for p in d.glob("*") if p.suffix.lower() in (".pth", ".safetensors", ".pt") and not p.name.startswith(".")) if d.is_dir() else []


def _sdxl_checkpoint(settings: dict) -> str | None:
    want = str(settings.get("editCheckpoint") or "").strip()
    adult = str(settings.get("adultImageCheckpoint") or "").strip()
    d = COMFY_MODELS / "checkpoints"
    if want and (d / want).is_file():
        return want
    skip = {FLUX_DEV, adult, "hunyuan3d-dit-v2.safetensors"}
    for p in sorted(d.glob("*.safetensors")) if d.is_dir() else []:
        if p.name not in skip and not re.search(r"nsfw|hunyuan|flux", p.name, re.I):
            return p.name
    return None


# ── graphs (pure functions, tested) ─────────────────────────────────────────

def cutout_graph(image_name: str) -> dict:
    return {
        "9": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "30": {"class_type": "LoadBackgroundRemovalModel", "inputs": {"bg_removal_name": BIREFNET}},
        "31": {"class_type": "RemoveBackground", "inputs": {"image": ["9", 0], "bg_removal_model": ["30", 0]}},
        "32": {"class_type": "MaskToImage", "inputs": {"mask": ["31", 0]}},
        "33": {"class_type": "SaveImage", "inputs": {"filename_prefix": "ShellB_Web_mask", "images": ["32", 0]}},
    }


def upscale_graph(image_name: str, model: str) -> dict:
    return {
        "9": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "40": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": model}},
        "41": {"class_type": "ImageUpscaleWithModel", "inputs": {"upscale_model": ["40", 0], "image": ["9", 0]}},
        "10": {"class_type": "SaveImage", "inputs": {"filename_prefix": "ShellB_Web_up", "images": ["41", 0]}},
    }


def _mask_nodes(image_node: list, mask_name: str | None, auto: str | None, grow: int) -> tuple[dict, list]:
    """Nodes that produce the inpaint mask: from a mask image (white = repaint) or BiRefNet's subject/background."""
    if mask_name:
        nodes = {"11": {"class_type": "LoadImage", "inputs": {"image": mask_name}},
                 "12": {"class_type": "ImageToMask", "inputs": {"image": ["11", 0], "channel": "red"}}}
        src = ["12", 0]
    else:
        nodes = {"30": {"class_type": "LoadBackgroundRemovalModel", "inputs": {"bg_removal_name": BIREFNET}},
                 "31": {"class_type": "RemoveBackground", "inputs": {"image": image_node, "bg_removal_model": ["30", 0]}}}
        src = ["31", 0]
        if auto == "background":
            nodes["35"] = {"class_type": "InvertMask", "inputs": {"mask": src}}
            src = ["35", 0]
    nodes["13"] = {"class_type": "GrowMask", "inputs": {"mask": src, "expand": grow, "tapered_corners": True}}
    return nodes, ["13", 0]


def inpaint_graph(image_name: str, prompt: str, seed: int, mask_name: str | None = None, auto: str | None = None,
                  flux: bool = True, checkpoint: str | None = None, grow: int = 12, steps: int | None = None) -> dict:
    mask_nodes, mask = _mask_nodes(["9", 0], mask_name, auto, grow)
    g = {"9": {"class_type": "LoadImage", "inputs": {"image": image_name}}, **mask_nodes,
         "10": {"class_type": "SaveImage", "inputs": {"filename_prefix": "ShellB_Web_inpaint", "images": ["15", 0]}}}
    if flux:
        g.update({
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": FLUX_DEV}},
            "2": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": "t5xxl_fp8_e4m3fn.safetensors", "clip_name2": "clip_l.safetensors",
                                                             "type": "flux", "device": "default"}},
            "3": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
            "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
            "5": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["2", 0]}},
            "7": {"class_type": "FluxGuidance", "inputs": {"conditioning": ["4", 0], "guidance": 30.0}},
            "14": {"class_type": "InpaintModelConditioning", "inputs": {"positive": ["7", 0], "negative": ["5", 0], "vae": ["3", 0],
                                                                        "pixels": ["9", 0], "mask": mask, "noise_mask": True}},
            "8": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": steps or 24, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple",
                                                       "denoise": 1.0, "model": ["1", 0], "positive": ["14", 0], "negative": ["14", 1], "latent_image": ["14", 2]}},
            "15": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
        })
    else:
        g.update({
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}},
            "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["1", 1]}},
            "5": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry, low quality, artifacts, text, watermark", "clip": ["1", 1]}},
            "14": {"class_type": "VAEEncodeForInpaint", "inputs": {"pixels": ["9", 0], "vae": ["1", 2], "mask": mask, "grow_mask_by": 6}},
            "8": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": steps or 30, "cfg": 6.0, "sampler_name": "dpmpp_2m", "scheduler": "karras",
                                                       "denoise": 1.0, "model": ["1", 0], "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["14", 0]}},
            "15": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["1", 2]}},
        })
    return g


# ── running ─────────────────────────────────────────────────────────────────

def _resolve(ctx, path: str) -> Path | None:
    from tools import FILES, WORKSPACES
    p = (path or "").strip()
    m = re.match(r"^/?api/files/([\w.-]+)$", p)
    if m:
        f = (FILES / m.group(1)).resolve()
        return f if f.is_file() else None
    base = (db.DATA / "projects" / ctx.project_id).resolve() if ctx.project_id else (WORKSPACES / ctx.conv_id).resolve()
    rel = p.removeprefix("/project/").removeprefix("/work/").lstrip("/")
    f = (base / rel).resolve()
    return f if f.is_file() and str(f).startswith(str(base) + "/") else None


async def _upload(c: httpx.AsyncClient, data: bytes, suffix: str) -> str:
    name = f"shellb-edit-{uuid.uuid4().hex[:10]}{suffix}"
    r = await c.post(f"{COMFY}/upload/image", files={"image": (name, data, "image/png")}, data={"overwrite": "true"})
    r.raise_for_status()
    return r.json().get("name") or name


async def _first_image(c: httpx.AsyncClient, outputs: dict, node: str) -> bytes | None:
    imgs = (outputs.get(node) or {}).get("images") or []
    if not imgs:
        return None
    im = imgs[0]
    r = await c.get(f"{COMFY}/view", params={"filename": im["filename"], "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
    r.raise_for_status()
    return r.content


async def edit_image(args, ctx):
    from PIL import Image
    from studio_assets import _cutout, save_output
    action = str(args.get("action") or "").lower().strip()
    if action not in ACTIONS:
        return ToolResult(f"action is one of {', '.join(ACTIONS)}", error=True)
    src = _resolve(ctx, str(args.get("image") or ""))
    if not src:
        return ToolResult("Give `image`: a path in the project or /work, or a generated /api/files/… name.", error=True)
    data = src.read_bytes()
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Exception:  # noqa: BLE001
        return ToolResult(f"{src.name} isn't an image PIL can open.", error=True)
    if im.width * im.height > 4096 * 4096:
        return ToolResult("Images over 16 megapixels are too large to edit here; downscale first.", error=True)
    settings = ctx.settings if hasattr(ctx, "settings") else (db.kv_get("settings") or {})
    save_as = str(args.get("save_as") or "")
    stem = re.sub(r"[^\w-]+", "_", src.stem)[:40]
    t0 = time.time()
    keep = {ctx.agent.get("model", "")} if getattr(ctx, "agent", None) else set()
    try:
        async with httpx.AsyncClient(timeout=120) as c:
            if action == "cutout":
                await make_room(6, keep)
                name = await _upload(c, data, src.suffix or ".png")
                outputs = await _comfy_run(c, cutout_graph(name), 300)
                mask = await _first_image(c, outputs, "33")
                if not mask:
                    return ToolResult("ComfyUI returned no mask.", error=True)
                rgba, dims = _cutout(data, mask, int(args["size"]) if args.get("size") else None, None, None)
                rel, url = await save_output(ctx, rgba, f"assets/edited/{stem}-cutout.png", ".png", save_as)
                what = f"Cut out the subject of {src.name} ({dims[0]}×{dims[1]} RGBA)"
            elif action == "upscale":
                models = upscalers()
                if not models:
                    return ToolResult("No upscaler is installed. Models → Store → Upscalers (an ESRGAN model) adds one to ~/comfyui/models/upscale_models.", error=True)
                model = str(args.get("model") or "")
                model = model if model in models else models[0]
                await make_room(8, keep)
                name = await _upload(c, data, src.suffix or ".png")
                outputs = await _comfy_run(c, upscale_graph(name, model), 600)
                out = await _first_image(c, outputs, "10")
                if not out:
                    return ToolResult("ComfyUI returned no image.", error=True)
                ext = ".png"
                rel, url = await save_output(ctx, out, f"assets/edited/{stem}-upscaled.png", ext, save_as)
                o = Image.open(io.BytesIO(out))
                what = f"Upscaled {src.name} with {model}: {im.width}×{im.height} → {o.width}×{o.height}"
            else:
                prompt = str(args.get("prompt") or "").strip()
                if not prompt:
                    return ToolResult("inpaint needs a `prompt` describing what the masked area should become.", error=True)
                mask_arg = str(args.get("mask") or "").strip()
                auto = mask_arg if mask_arg in ("background", "subject") else None
                mask_name = None
                if not auto:
                    mpath = _resolve(ctx, mask_arg) if mask_arg else None
                    if not mpath:
                        return ToolResult("inpaint needs `mask`: a black/white image (white = repaint), or \"background\" / \"subject\".", error=True)
                flux = flux_dev_available()
                ckpt = None if flux else _sdxl_checkpoint(settings)
                if not flux and not ckpt:
                    return ToolResult("Inpainting needs FLUX.1-dev (Models → Store) or an SDXL checkpoint named in the editCheckpoint setting.", error=True)
                await make_room(30 if flux else 12, keep)
                name = await _upload(c, data, src.suffix or ".png")
                if not auto:
                    mask_name = await _upload(c, mpath.read_bytes(), mpath.suffix or ".png")
                seed = int(args.get("seed") or random.randint(0, 2**31 - 1))
                outputs = await _comfy_run(c, inpaint_graph(name, prompt, seed, mask_name, auto, flux, ckpt, int(args.get("grow") or 12)), 900)
                out = await _first_image(c, outputs, "10")
                if not out:
                    return ToolResult("ComfyUI returned no image.", error=True)
                rel, url = await save_output(ctx, out, f"assets/edited/{stem}-inpaint.png", ".png", save_as)
                what = f"Inpainted {src.name} ({'FLUX.1-dev' if flux else ckpt}, seed {seed}, mask: {auto or mpath.name})"
    except ValueError as e:
        return ToolResult(str(e), error=True)
    except (httpx.HTTPError, RuntimeError, TimeoutError) as e:
        return ToolResult(f"NYX/ComfyUI: {type(e).__name__}: {e}"[:500], error=True)
    where = rel or url
    return ToolResult(f"{what} in {time.time() - t0:.0f}s → {where}",
                      display={"images": [url], "prompt": f"{action}: {args.get('prompt') or src.name}", "tool": "edit_image"})


def register():
    TOOLS["edit_image"] = {
        "fn": edit_image, "service": "comfy",
        "ui": {"displayName": "Edit image", "icon": "Wand2", "category": "media",
               "description": "Change an existing picture on NYX: cut out the subject, upscale with an ESRGAN model, or inpaint a masked area from a prompt"},
        "schema": _fn("edit_image", "Edit an existing image. cutout: remove the background (RGBA PNG). upscale: 2-4× with an installed "
                      "upscale model. inpaint: repaint the masked area from `prompt`; `mask` is a black/white image path (white = "
                      "repaint) or \"background\"/\"subject\" (BiRefNet decides). Saves into assets/edited/ (or /api/files outside a project).",
                      {"action": {"type": "string", "enum": list(ACTIONS)},
                       "image": {"type": "string", "description": "path in the project or /work, or /api/files/<name>"},
                       "prompt": {"type": "string"}, "mask": {"type": "string"},
                       "model": {"type": "string", "description": "upscale model file name (default: the first installed)"},
                       "size": {"type": "integer", "description": "cutout: fit the result in this many pixels"},
                       "grow": {"type": "integer", "description": "inpaint: grow the mask by this many pixels (default 12)"},
                       "seed": {"type": "integer"}, "save_as": {"type": "string"}},
                      ["action", "image"]),
    }
