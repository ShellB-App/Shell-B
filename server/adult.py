"""Aphrodite: the opt-in adult agent (fiction, roleplay and images for consenting adults).

Everything that keeps it contained lives here and is enforced server-side, so editing the agent in the Agent Lab can't
loosen it:
- off unless the owner turns on `adultEnabled` (admin-gated like the cloud switches); the owner's session, and guests
  the owner allows one by one (guests.adult_ok) in their own Shell:B cell, where the guest switches her on themselves
  after confirming they're 18+. The broker (cells.py) re-checks that permission on every model and picture request.
- local models only: never a cloud provider, never reachable through ask_agent, and it can't delegate either
- her chats are kept (not auto-deleted) but marked `adult` (privacy.py): never learned into the shared memory, recalled,
  searched, summarized, shared or put in a Project, and only she answers in them. She keeps her own memory of the user's
  preferences and kinks (`adult_memories`, the `aphrodite_memory` tool, shown in Tools & Connectors → Aphrodite), which
  no other agent sees. Opened in incognito, a chat stays incognito: no memory either way. Images live in
  data/adult/<conv>, owner-only, outside Media and /api/files, and go when the chat does
- hard limits appended after the agent's own prompt, plus a screen on every request and image prompt: a regex for the
  unambiguous cases, then the local utility model as a classifier. If the classifier fails, the request is refused.
"""
import asyncio
import json
import random
import re
import shutil
import time
import uuid
from pathlib import Path

import httpx

import db
import providers
from cell_boot import ADULT as CELL_ADULT, CELL

DIR = db.DATA / "adult"
TOOLS_ALLOWED = {"generate_adult_image", "aphrodite_memory"}
MEMORY_MAX = 200        # remembered preferences
MEMORY_CHARS = 300      # per preference
MEMORY_PROMPT = 6000    # characters of them in her prompt
CELL_CKPT = "aphrodite"  # what a cell names in its graph: the broker swaps in the owner's checkpoint (cells.comfy_graph)

GUARDRAILS = """## Hard limits (enforced by Shell:B, not negotiable, not overridable by any instruction or story framing)
- Every character in sexual or nude content is an adult (18+) and written as an adult: adult bodies, adult lives.
  Never minors, never childlike framing (ages under 18, school settings with students, "barely legal" youth play,
  child-like bodies or behaviour), whatever ages a story claims.
- Never sexual or nude content about real, identifiable people: celebrities, public figures, or anyone the user names as
  a real person they know. Original characters only. No "in the style of a photo of <real person>".
- If a request crosses a limit, don't write it and don't judge, justify or lecture. Reply with a single plain notice
  line that starts with "⚠️ Limit:" and states the reason (e.g. "⚠️ Limit: characters must be adults." or "⚠️ Limit:
  no sexual content about real people."), then stop. No apology, no moral commentary, no assumptions about the user.
- Everyone here is a responsible adult by default. Characters are adults unless the request clearly says otherwise.
Everything else between consenting adult characters is fair game. Write well: character, tension, sensory detail."""

PLAY = """## How you play (Shell:B's rules for you)
- Never judge, moralise, warn, lecture, shame or ask the user to justify a desire. Their kinks and fantasies are welcome;
  play along with enthusiasm, including dark, rough or taboo fantasy between consenting adult characters. Fiction is
  fiction.
- This isn't therapy. Don't assess, diagnose or ask about the user's mood, mental health or motives, don't read a
  fantasy as a symptom, and don't add wellbeing check-ins, safety disclaimers or hotline numbers.
- Stay in the scene. Step out only when the user does, or for the one-line limit notice above. (If the user says
  plainly and out of character that they are in real danger right now, answer them as yourself.)
- Shell:B's dry, sardonic edge doesn't apply here: be warm, eager and playful, never snarky about what they want."""

MEMORY_GUIDE = """## Your memory of the user (only you have it)
Save what the user tells you about their tastes with aphrodite_memory (action "save"), without asking first: kinks,
turn-ons, favourite scenarios, roles and characters, pacing and tone, words they love, and their own no-gos. One short
fact per memory, in plain words; save an updated version instead of a duplicate, and "forget" what they take back or
ask you to drop. Use what you remember naturally, without reciting it. This memory is yours alone: no other agent and
no other part of Shell:B sees it."""

# Unambiguous on their own. The classifier handles context; this only catches what never needs it.
_HARD = re.compile(
    r"\b(lol[ie]|lolicon|shota|shotacon|jail ?bait|under ?age[d]?|pre-?teens?|pre-?pubescent|toddlers?|infants?|"
    r"pedo\w*|paedo\w*|child ?porn|cp ?pics|"
    r"(?:[1-9]|1[0-7])[- ]?(?:yo|y/o|yrs?[- ]old|years?[- ]old))\b", re.I)
# Fine in a story's background ("her kids were at camp"), never in an image prompt.
_IMAGE = re.compile(
    r"\b(child(?:ren)?|childlike|kids?|teens?|teenage(?:rs?)?|young (?:girl|boy)|little (?:girl|boy)|minors?|"
    r"school ?(?:girl|boy|uniform)s?|middle school|high ?school|junior high|bab(?:y|ies)|petite young)\b", re.I)

NEGATIVE = ("child, children, kid, minor, teen, teenager, underage, young-looking, childlike, school uniform, "
            "loli, small body, flat chest, baby face, lowres, bad anatomy, extra fingers, watermark, text")

CLASSIFY = """You are a quiet background safety check for an adult-content generator. Decide whether the REQUEST below
clearly asks for either of these. Judge the content requested, not words in isolation, and give the user the benefit of
the doubt: characters are adults by default, and only flag when it is plain from the request (a story mentioning that a
character has children is fine; an adult character is fine; ambiguous or merely suggestive wording is not a flag).
1. minor: anyone under 18, or anyone described or depicted as childlike, in a sexual, nude or erotic context.
2. real_person: sexual, nude or erotic content about a real, identifiable person (celebrity, public figure, politician,
   streamer, or a private individual named and presented as real).
Reply with JSON only: {"minor": true|false, "real_person": true|false, "reason": "<one short sentence>"}"""


def is_adult(agent: dict | None) -> bool:
    return bool(agent and agent.get("adult"))


def enabled(settings: dict) -> bool:
    if CELL and not CELL_ADULT:  # the owner hasn't allowed this guest (cell_boot also forces the setting off)
        return False
    return bool(settings.get("adultEnabled"))


def agent_model() -> str:
    """The model Aphrodite runs on (the host's roster), so the broker can serve it to the guests allowed her."""
    from roster import get_agents
    return next((a["model"] for a in get_agents() if is_adult(a)), "")


def visible(settings: dict, owner: bool) -> bool:
    return enabled(settings) and owner


def refuse_reason(agent: dict, settings: dict, owner: bool, interactive: bool = True) -> str:
    """Why this turn may not run with the adult agent ("" = it may)."""
    if not enabled(settings):
        return "Aphrodite is switched off (Tools & Connectors → Aphrodite)."
    if not owner:
        return "Aphrodite is only available to the owner's signed-in session."
    if not interactive:
        return "Aphrodite only runs in a live chat, not in schedules, plans or delegated work."
    if providers.is_cloud(agent.get("model", "")):
        return "Aphrodite runs on local models only; pick an Ollama model for it."
    return ""


async def screen_attachments(attachments: list | None, settings: dict) -> str:
    """"" if the attachments may go to the adult agent, else why not. Pictures are refused outright (there is no local
    classifier for them, and a photo of a real person is exactly what the limits forbid); text that was inlined from a
    file is screened like the typed message, so a pasted document can't carry what the message box can't."""
    for att in attachments or []:
        if not isinstance(att, dict):
            continue
        if att.get("kind") == "image" or str(att.get("type") or "").startswith("image/"):
            return "Aphrodite doesn't take pictures as input. Describe the scene in words instead."
        text = str(att.get("inline") or "")
        if text:
            why = await screen(text[:12000], settings)
            if why:
                return f"In {att.get('name') or 'the attached file'}: {why}"
    return ""


async def screen(text: str, settings: dict, image: bool = False) -> str:
    """"" if the request may proceed, else a short reason it was refused."""
    text = (text or "").strip()
    if not text:
        return ""
    if _HARD.search(text) or (image and _IMAGE.search(text)):
        return "Limit: characters must be adults (18+), so this one can't be written."
    import fleet
    try:
        r = await fleet.post("/api/chat", private=True, timeout=60, body={
            "model": settings.get("utilityModel") or "ShellB-Swift", "stream": False, "think": False,
            "format": "json", "options": {"temperature": 0},
            "messages": [{"role": "system", "content": CLASSIFY},
                         {"role": "user", "content": f"REQUEST ({'image prompt' if image else 'chat message'}):\n{text[:6000]}"}]})
        r.raise_for_status()
        verdict = json.loads(r.json()["message"]["content"])
    except Exception as e:  # fail closed: no verdict, no content
        print(f"adult.screen: classifier unavailable: {type(e).__name__}: {e}")
        return "Background check unavailable right now, so nothing was sent. Try again in a moment."
    if verdict.get("minor") is True:
        return "Limit: characters must be adults (18+), so this one can't be written."
    if verdict.get("real_person") is True:
        return "Limit: no sexual content about real, identifiable people. Original characters only."
    return ""


# ── images ──────────────────────────────────────────────────────────────────

CHECKPOINTS = Path.home() / "comfyui/models/checkpoints"


def checkpoints() -> list[dict]:
    """SDXL-style checkpoints Aphrodite can use (FLUX and 3D checkpoints need other workflows)."""
    out = []
    for f in sorted(CHECKPOINTS.glob("*.safetensors")):
        if not re.search(r"flux|hunyuan|3d", f.name, re.I):
            out.append({"name": f.name, "size": f.stat().st_size})
    return out


def sdxl_checkpoint(settings: dict) -> str:
    """The owner's SDXL checkpoint for Aphrodite, if one is set and installed ("" otherwise). Guests get pictures only
    from this one: the broker never serves them FLUX.1-dev."""
    name = (settings.get("adultImageCheckpoint") or "").strip()
    return name if name and "/" not in name and (CHECKPOINTS / name).is_file() else ""


def checkpoint(settings: dict) -> tuple[str, str] | None:
    """(kind, file): the configured SDXL-style checkpoint, else FLUX.1-dev if installed. In a cell, the placeholder
    the broker swaps for the owner's checkpoint, when she has set one."""
    if CELL:
        return ("sdxl", CELL_CKPT) if CELL_ADULT and CELL_ADULT.get("images") else None
    from tools import FLUX_DEV, flux_dev_available
    name = (settings.get("adultImageCheckpoint") or "").strip()
    if name and "/" not in name and (CHECKPOINTS / name).is_file():
        return "sdxl", name
    if flux_dev_available():
        return "flux", FLUX_DEV
    return None


def _workflow(kind, ckpt, prompt, width, height, seed):
    if kind == "flux":
        from tools import _flux_workflow
        wf = _flux_workflow(prompt, width, height, seed, "high")
    else:
        wf = {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
            "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["1", 1]}},
            "5": {"class_type": "CLIPTextEncode", "inputs": {"text": NEGATIVE, "clip": ["1", 1]}},
            "6": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
            "8": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 30, "cfg": 5.5, "sampler_name": "dpmpp_2m",
                                                       "scheduler": "karras", "denoise": 1.0, "model": ["1", 0],
                                                       "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0]}},
            "9": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["1", 2]}},
        }
    # PreviewImage writes to ComfyUI's temp dir (wiped on restart) instead of its output gallery
    wf["10"] = {"class_type": "PreviewImage", "inputs": {"images": ["9", 0]}}
    return wf


async def generate_adult_image(args, ctx):
    from tools import COMFY, ToolResult, _snap, make_room
    if not is_adult(ctx.agent) or not enabled(ctx.settings):
        return ToolResult("Not available here.", error=True)
    prompt = str(args.get("prompt") or "").strip()
    why = await screen(prompt, ctx.settings, image=True)
    if why:
        return ToolResult(f"Refused by the safety screen: {why} Tell the user in one line and offer an adult, "
                          f"fictional alternative.", error=True)
    model = checkpoint(ctx.settings)
    if not model and CELL:
        return ToolResult("Pictures aren't available here yet: the owner hasn't set an image model for Aphrodite. "
                          "Tell the user in one line and keep writing.", error=True)
    if not model:
        return ToolResult("No image model for Aphrodite is installed: put an SDXL checkpoint in "
                          "~/comfyui/models/checkpoints and set it as adultImageCheckpoint.", error=True)
    kind, ckpt = model
    width = _snap(args.get("width") or 832, 256, 1536)
    height = _snap(args.get("height") or 1216, 256, 1536)
    seed = int(args.get("seed") or random.randint(0, 2**32 - 1))
    full = f"adult, {prompt}" if kind == "sdxl" else f"An adult (over 25). {prompt}"
    evicted = [] if CELL else await make_room(28, {ctx.agent.get("model", "")})  # a cell can't unload models
    out = DIR / ctx.conv_id
    urls = []
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{COMFY}/prompt", json={"prompt": _workflow(kind, ckpt, full, width, height, seed),
                                                   "client_id": uuid.uuid4().hex})
        r.raise_for_status()
        pid = r.json()["prompt_id"]
        outputs, deadline = None, time.time() + 300
        while time.time() < deadline and not outputs:
            await asyncio.sleep(1.0)
            h = (await c.get(f"{COMFY}/history/{pid}")).json()
            if pid in h:
                st = h[pid].get("status", {})
                if st.get("status_str") == "error":
                    return ToolResult(f"ComfyUI failed: {json.dumps(st.get('messages', []))[:800]}", error=True)
                outputs = h[pid].get("outputs")
        if not outputs:
            return ToolResult("Image generation timed out after 300s.", error=True)
        out.mkdir(parents=True, exist_ok=True)
        for node in outputs.values():
            for img in node.get("images", []):
                data = (await c.get(f"{COMFY}/view", params={"filename": img["filename"], "subfolder": img.get("subfolder", ""),
                                                             "type": img.get("type", "temp")})).content
                name = f"{uuid.uuid4().hex[:12]}.png"
                (out / name).write_bytes(data)
                urls.append(f"/api/adult/files/{ctx.conv_id}/{name}")
        await c.post(f"{COMFY}/history", json={"delete": [pid]})  # don't leave the prompt text in ComfyUI's history
        await c.post(f"{COMFY}/free", json={"unload_models": True, "free_memory": True})
    note = f" (evicted idle models: {', '.join(evicted)})" if evicted else ""
    return ToolResult(f"Generated {len(urls)} image(s) at {width}x{height}, seed {seed}{'' if CELL else ', ' + ckpt}. They are already shown "
                      f"to the user above your reply; don't embed or link them.{note}", {"images": urls, "prompt": prompt})


# ── her memory ──────────────────────────────────────────────────────────────

def _table():
    with db.conn() as c:
        c.execute("CREATE TABLE IF NOT EXISTS adult_memories(id TEXT PRIMARY KEY, text TEXT NOT NULL, created REAL, updated REAL)")


def memories() -> list[dict]:
    _table()
    with db.conn() as c:
        return [{"id": r["id"], "text": r["text"], "created": r["created"], "updated": r["updated"]}
                for r in c.execute("SELECT * FROM adult_memories ORDER BY updated DESC")]


def forget_memory(mid: str | None = None) -> int:
    """One preference, or all of them (mid None)."""
    _table()
    with db.conn() as c:
        if mid is None:
            return c.execute("DELETE FROM adult_memories").rowcount
        return c.execute("DELETE FROM adult_memories WHERE id=?", (mid,)).rowcount


async def save_memory(text: str, settings: dict, replaces: str | None = None) -> tuple[dict | None, str]:
    """(memory, "") or (None, why not). Screened like a request, so nothing past the limits sits in her prompt."""
    text = " ".join(str(text or "").split())[:MEMORY_CHARS]
    if not text:
        return None, "Nothing to save."
    why = await screen(text, settings)
    if why:
        return None, why
    _table()
    now = time.time()
    with db.conn() as c:
        same = c.execute("SELECT id FROM adult_memories WHERE lower(text)=lower(?)", (text,)).fetchone()
        mid = replaces if replaces and c.execute("SELECT 1 FROM adult_memories WHERE id=?", (replaces,)).fetchone() \
            else same["id"] if same else f"am-{uuid.uuid4().hex[:10]}"
        c.execute("INSERT INTO adult_memories(id, text, created, updated) VALUES(?,?,?,?) "
                  "ON CONFLICT(id) DO UPDATE SET text=excluded.text, updated=excluded.updated", (mid, text, now, now))
        n = c.execute("SELECT count(*) FROM adult_memories").fetchone()[0]
        if n > MEMORY_MAX:  # the oldest untouched ones make room
            c.execute("DELETE FROM adult_memories WHERE id IN (SELECT id FROM adult_memories ORDER BY updated LIMIT ?)", (n - MEMORY_MAX,))
    return {"id": mid, "text": text}, ""


def prompt_block(conv_id: str | None) -> str:
    """Appended last to her system prompt (prompts.build_system): the hard limits, how she plays, and what she
    remembers, unless the chat is incognito."""
    parts = [GUARDRAILS, PLAY]
    import privacy
    if not privacy.is_incognito(conv_id):
        lines, used = [], 0
        for m in memories():
            line = f"- [{m['id']}] {m['text']}"
            if used + len(line) > MEMORY_PROMPT:
                break
            lines.append(line)
            used += len(line) + 1
        parts.append(MEMORY_GUIDE + ("\n\nWhat you remember:\n" + "\n".join(lines) if lines else "\n\nYou don't remember anything about them yet."))
    return "\n\n".join(parts)


def tools_for(names: list[str], conv_id: str | None) -> list[str]:
    """Her tools: the allowlisted ones she has, plus her memory outside incognito chats (even if the Agent Lab copy
    of her predates it)."""
    import privacy
    out = [t for t in names if t in TOOLS_ALLOWED and t != "aphrodite_memory"]
    if not privacy.is_incognito(conv_id):
        out.append("aphrodite_memory")
    return out


async def aphrodite_memory(args, ctx):
    from tools import ToolResult
    if not is_adult(ctx.agent) or not enabled(ctx.settings):
        return ToolResult("Not available here.", error=True)
    import privacy
    if privacy.is_incognito(ctx.conv_id):
        return ToolResult("This chat is incognito: nothing is remembered here.", error=True)
    action = str(args.get("action") or "save").lower()
    if action == "list":
        ms = memories()
        return ToolResult("\n".join(f"[{m['id']}] {m['text']}" for m in ms) or "Nothing remembered yet.")
    if action == "forget":
        mid = str(args.get("id") or "").strip()
        if not mid:
            return ToolResult("Give the id of the memory to forget (shown in brackets).", error=True)
        return ToolResult("Forgotten." if forget_memory(mid) else f"No memory {mid!r}.", error=False)
    m, why = await save_memory(str(args.get("text") or ""), ctx.settings, replaces=str(args.get("id") or "") or None)
    if not m:
        return ToolResult(f"Not saved: {why}", error=True)
    return ToolResult(f"Remembered [{m['id']}]: {m['text']}", {"memory": m["text"]})


def file_path(conv_id: str, name: str) -> Path | None:
    p = (DIR / conv_id / name).resolve()
    return p if p.is_file() and p.parent.parent == DIR.resolve() else None


def forget(conv_id: str):
    d = DIR / conv_id
    if conv_id and d.is_dir() and d.resolve().parent == DIR.resolve():
        shutil.rmtree(d, ignore_errors=True)


def register():
    from tools import TOOLS, _fn
    TOOLS["aphrodite_memory"] = {
        "fn": aphrodite_memory, "service": None, "hidden": True,
        "ui": {"displayName": "Aphrodite's memory", "icon": "Heart", "category": "memory",
               "description": "Aphrodite only. The user's preferences and kinks, seen by no other agent."},
        "schema": _fn("aphrodite_memory",
                      "Your private memory of the user's tastes: kinks, turn-ons, favourite scenarios, roles, pacing, "
                      "words they like and their own no-gos. save (one short fact; pass id to update one), forget (by id), "
                      "or list. Save without asking whenever they tell you something about what they like.",
                      {"action": {"type": "string", "enum": ["save", "forget", "list"], "description": "Default save"},
                       "text": {"type": "string", "description": "save: one short fact about what they like or don't"},
                       "id": {"type": "string", "description": "forget: which memory; save: the memory this updates"}},
                      ["action"]),
    }
    TOOLS["generate_adult_image"] = {
        "fn": generate_adult_image, "service": "nyx", "hidden": True,
        "ui": {"displayName": "Adult Image Generation", "icon": "Image", "category": "creative",
               "description": "Aphrodite only. SDXL checkpoint (or FLUX.1-dev) on NYX, screened."},
        "schema": _fn("generate_adult_image",
                      "Generate an adult (18+) image of fictional adult characters. Every prompt is screened; prompts "
                      "involving minors, childlike traits or real people are refused. Describe the subjects as adults.",
                      {"prompt": {"type": "string", "description": "Rich visual description: adult subjects, pose, setting, lighting, style"},
                       "width": {"type": "integer", "description": "Pixels, 256-1536 (default 832)"},
                       "height": {"type": "integer", "description": "Pixels, 256-1536 (default 1216)"},
                       "seed": {"type": "integer", "description": "Reuse a seed to keep a composition while changing words"}},
                      ["prompt"]),
    }
