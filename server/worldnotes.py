"""Feature notes for the Worlds app: extra facts, sections, pictures, sounds and links attached to a map feature's card.

Atlas writes them with the `annotate_map_feature` tool (the owner can too, via POST /api/worlds/notes). Media is
downloaded once into data/worlds/media and served from here, so cards keep working offline and never hotlink.
Everything in a note comes from the web, so the UI renders it as plain text, and only an allowlist of media types
is kept (no SVG or HTML, which could carry script).
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import FileResponse

import scrape
from tools import TOOLS, ToolResult, _fn

DIR = Path(__file__).resolve().parent.parent / "data" / "worlds"
MEDIA = DIR / "media"
NOTES = DIR / "notes.json"
MAX_BYTES = 40 * 1024 * 1024
TYPES = {  # content type → (kind, extension)
    "image/jpeg": ("image", ".jpg"), "image/png": ("image", ".png"), "image/gif": ("image", ".gif"), "image/webp": ("image", ".webp"),
    "audio/mpeg": ("audio", ".mp3"), "audio/ogg": ("audio", ".ogg"), "audio/wav": ("audio", ".wav"), "audio/x-wav": ("audio", ".wav"),
    "audio/wave": ("audio", ".wav"), "audio/flac": ("audio", ".flac"), "audio/webm": ("audio", ".webm"),
    "video/mp4": ("video", ".mp4"), "video/webm": ("video", ".webm"),
}
MIME_BY_EXT = {ext: mime for mime, (_, ext) in TYPES.items()}
_lock = threading.Lock()

router = APIRouter(prefix="/api/worlds")


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


KINDS = (r"mission|crater|volcano|mountain|canyon|plain|spaceport|sea|wonder|shipwreck|launch ?site|webcam|landmark"
         r"|painted cave|rock art|rock shelter|early village|sanctuary|megaliths?|megalithic tomb|archaeological find")


def clean_name(feature: str) -> str:
    """'Venera 9 (mission)' → 'Venera 9': agents tend to copy the kind label from the context into the name."""
    return re.sub(rf"\s*\((?:{KINDS})\)\s*$", "", feature.strip(), flags=re.I)


def key_for(body: str, feature: str) -> str:
    return f"{slug(body)}:{slug(clean_name(feature))}"


def _load() -> dict[str, dict]:
    try:
        return json.loads(NOTES.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save(notes: dict[str, dict]):
    DIR.mkdir(parents=True, exist_ok=True)
    tmp = NOTES.with_suffix(".tmp")
    tmp.write_text(json.dumps(notes, ensure_ascii=False, indent=1))
    tmp.replace(NOTES)


def _text(v: Any, limit: int) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()[:limit]


def _url(v: Any) -> str:
    u = str(v or "").strip()
    p = urlparse(u)
    return u if p.scheme in ("http", "https") and p.hostname else ""


async def _fetch_media(url: str) -> dict:
    """Download one media file into data/worlds/media; returns {file, kind, mime, bytes}."""
    scrape._check_url(url)
    async with scrape.client(timeout=90) as c:
        async with c.stream("GET", url) as r:
            r.raise_for_status()
            mime = r.headers.get("content-type", "").split(";")[0].strip().lower()
            if mime not in TYPES:
                raise ValueError(f"{url} is {mime or 'an unknown type'}; cards take JPEG/PNG/GIF/WebP images, MP3/OGG/WAV/FLAC audio or MP4/WebM video")
            buf = bytearray()
            async for chunk in r.aiter_bytes():
                buf += chunk
                if len(buf) > MAX_BYTES:
                    raise ValueError(f"{url} is over {MAX_BYTES // 2**20} MB")
    kind, ext = TYPES[mime]
    name = hashlib.sha256(bytes(buf)).hexdigest()[:24] + ext
    MEDIA.mkdir(parents=True, exist_ok=True)
    if not (MEDIA / name).exists():
        (MEDIA / name).write_bytes(bytes(buf))
    return {"file": name, "kind": kind, "mime": mime, "bytes": len(buf)}


async def annotate(args: dict, by: str) -> tuple[str, dict, list[str]]:
    """Merge args into a feature's note. Returns (key, note, problems)."""
    body, feature = _text(args.get("body"), 40), clean_name(_text(args.get("feature"), 160))
    if not body or not feature:
        raise ValueError("Both 'body' (e.g. 'venus') and 'feature' (the card's name, e.g. 'Venera 13') are required.")
    key = key_for(body, feature)
    problems: list[str] = []

    media_in = []
    for m in (args.get("media") or [])[:12]:
        if not isinstance(m, dict):
            continue
        src = _url(m.get("url"))
        if not src:
            problems.append(f"skipped media without an http(s) url: {m!r:.80}")
            continue
        try:
            got = await _fetch_media(src)
        except Exception as e:  # noqa: BLE001 - report every failure to the agent
            problems.append(f"couldn't keep {src}: {e}")
            continue
        media_in.append({**got, "url": src, "caption": _text(m.get("caption"), 400), "credit": _text(m.get("credit"), 200),
                         "license": _text(m.get("license"), 80), "source": _url(m.get("source_page")) or src,
                         "note": _text(m.get("note"), 300)})

    with _lock:
        notes = _load()
        cur = notes.get(key) if not args.get("replace") else None
        cur = cur or {"body": slug(body), "feature": feature, "summary": "", "facts": [], "sections": [], "media": [], "links": []}
        if args.get("summary"):
            cur["summary"] = _text(args["summary"], 800)
        for f in (args.get("facts") or [])[:30]:
            if isinstance(f, dict) and f.get("label") and f.get("value"):
                label = _text(f["label"], 60)
                cur["facts"] = [x for x in cur["facts"] if x["label"].lower() != label.lower()] + [{"label": label, "value": _text(f["value"], 200)}]
        for s in (args.get("sections") or [])[:12]:
            if isinstance(s, dict) and s.get("title") and s.get("text"):
                title = _text(s["title"], 80)
                text = str(s["text"]).strip()[:4000]  # keeps paragraph breaks
                cur["sections"] = [x for x in cur["sections"] if x["title"].lower() != title.lower()] + [{"title": title, "text": text}]
        for m in media_in:
            cur["media"] = [x for x in cur["media"] if x["url"] != m["url"]] + [m]
        for ln in (args.get("links") or [])[:20]:
            if isinstance(ln, dict) and _url(ln.get("url")):
                cur["links"] = [x for x in cur["links"] if x["url"] != ln["url"]] + [{"title": _text(ln.get("title") or ln["url"], 120), "url": _url(ln["url"])}]
        cur.update(updated=int(time.time() * 1000), by=by, feature=feature)
        notes[key] = cur
        _save(notes)
    return key, cur, problems


@router.get("/notes")
def get_note(body: str = Query(...), feature: str = Query(...)):
    return _load().get(key_for(body, feature)) or {}


@router.post("/notes")
async def post_note(payload: dict = Body(...)):
    try:
        key, note, problems = await annotate(payload, by="owner")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"key": key, "note": note, "problems": problems}


@router.delete("/notes")
def delete_note(body: str = Query(...), feature: str = Query(...), part: str | None = Query(None), index: int | None = Query(None)):
    """Remove a whole note, or one item: part = facts | sections | media | links, with its index."""
    key = key_for(body, feature)
    with _lock:
        notes = _load()
        if key not in notes:
            raise HTTPException(404, "No note for that feature")
        if part is None:
            del notes[key]
        elif part in ("facts", "sections", "media", "links") and index is not None and 0 <= index < len(notes[key][part]):
            notes[key][part].pop(index)
        else:
            raise HTTPException(400, "part must be facts, sections, media or links, with a valid index")
        _save(notes)
        used = {m["file"] for n in notes.values() for m in n.get("media", [])}
        for f in MEDIA.glob("*") if MEDIA.exists() else []:
            if f.name not in used and time.time() - f.stat().st_mtime > 600:  # not one an annotate is still saving
                f.unlink(missing_ok=True)  # media nobody shows any more
    return {"ok": True}


@router.get("/media/{name}")
def media(name: str):
    if not re.fullmatch(r"[0-9a-f]{24}\.[a-z0-9]{3,4}", name):
        raise HTTPException(404)
    f = MEDIA / name
    if not f.exists():
        raise HTTPException(404)
    return FileResponse(f, media_type=MIME_BY_EXT.get(f.suffix, "application/octet-stream"),
                        headers={"Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"})


async def annotate_tool(args: dict, ctx: Any) -> ToolResult:
    try:
        key, note, problems = await annotate(args, by="Atlas")
    except ValueError as e:
        return ToolResult(str(e), error=True)
    lines = [f"Updated the {note['feature']} card on {note['body']} ({key}): {len(note['facts'])} facts, "
             f"{len(note['sections'])} sections, {len(note['media'])} media, {len(note['links'])} links."]
    if problems:
        lines.append("Problems:\n- " + "\n- ".join(problems))
    lines.append("The card refreshes by itself in the Worlds app; clicking the feature shows it.")
    return ToolResult("\n".join(lines), {"key": key, "body": note["body"], "feature": note["feature"]}, error=bool(problems) and not note["media"] and not note["facts"] and not note["sections"])


def register():
    TOOLS["annotate_map_feature"] = {
        "fn": annotate_tool, "service": None,
        "ui": {"displayName": "Annotate Map Card", "icon": "Pencil", "category": "web",
               "description": "Adds facts, sections, pictures, sound and links to a feature's card in the Worlds app."},
        "schema": _fn(
            "annotate_map_feature",
            "Add verified information to the card a map feature shows when clicked in the Worlds app (landing sites, craters, "
            "wonders, shipwrecks, any named feature). Merges with what's there: facts and sections replace ones with the same "
            "label/title, media and links are added. Media URLs must point straight at a JPEG/PNG/GIF/WebP image, MP3/OGG/WAV/FLAC "
            "audio or MP4/WebM video file (for Wikimedia Commons use the upload.wikimedia.org file URL); they are downloaded and "
            "kept offline. Give every media item its credit, license and source page.",
            {
                "body": {"type": "string", "description": "World id: 'venus', 'mars', 'moon', 'earth', ..."},
                "feature": {"type": "string", "description": "The feature's name exactly as its card shows it, e.g. 'Venera 13'"},
                "summary": {"type": "string", "description": "One or two sentences shown at the top of the extra info"},
                "facts": {"type": "array", "description": "Short key facts", "items": {"type": "object", "properties": {
                    "label": {"type": "string"}, "value": {"type": "string"}}, "required": ["label", "value"]}},
                "sections": {"type": "array", "description": "Short titled paragraphs", "items": {"type": "object", "properties": {
                    "title": {"type": "string"}, "text": {"type": "string"}}, "required": ["title", "text"]}},
                "media": {"type": "array", "description": "Pictures, audio or video to keep on the card", "items": {"type": "object", "properties": {
                    "url": {"type": "string", "description": "Direct file URL"},
                    "caption": {"type": "string"}, "credit": {"type": "string"}, "license": {"type": "string"},
                    "source_page": {"type": "string", "description": "Page the file is described on"},
                    "note": {"type": "string", "description": "Caveat shown with it, e.g. 'artist's reconstruction, not mission audio'"}},
                    "required": ["url", "caption"]}},
                "links": {"type": "array", "description": "Further reading", "items": {"type": "object", "properties": {
                    "title": {"type": "string"}, "url": {"type": "string"}}, "required": ["url"]}},
                "replace": {"type": "boolean", "description": "Start the note over instead of merging (default false)"},
            },
            ["body", "feature"],
        ),
    }
