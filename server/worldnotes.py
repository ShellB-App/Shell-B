"""Feature notes for the Worlds app: extra facts, sections, pictures, sounds and links attached to a map feature's card.

Atlas writes them with the `annotate_map_feature` tool (the owner can too, via POST /api/worlds/notes). Media is
downloaded once into data/worlds/media and served from here, so cards keep working offline and never hotlink.
Everything in a note comes from the web, so the UI renders it as plain text, and only an allowlist of media types
is kept (no SVG or HTML, which could carry script). GLB models are allowed: binary meshes, no script.

A note with a `place` (lat, lon, kind) is also a point of its own on the map ("Atlas places" layer): that is how Atlas
adds a feature the curated datasets don't have, with a full card from the start.
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
    "model/gltf-binary": ("model", ".glb"),
}
PLACE_KINDS = ("place", "mission", "crater", "volcano", "mountain", "canyon", "plain", "sea", "site", "city", "wreck", "wonder", "event", "route")
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
            buf = bytearray()
            async for chunk in r.aiter_bytes():
                buf += chunk
                if len(buf) > MAX_BYTES:
                    raise ValueError(f"{url} is over {MAX_BYTES // 2**20} MB")
            if mime not in TYPES and bytes(buf[:4]) == b"glTF":
                mime = "model/gltf-binary"  # GitHub and most mirrors serve GLB as octet-stream
            if mime not in TYPES:
                raise ValueError(f"{url} is {mime or 'an unknown type'}; cards take JPEG/PNG/GIF/WebP images, MP3/OGG/WAV/FLAC audio, "
                                 "MP4/WebM video or GLB 3D models")
            if mime == "model/gltf-binary" and bytes(buf[:4]) != b"glTF":
                raise ValueError(f"{url} says it is a GLB model but isn't one")
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

    place = None
    if args.get("lat") is not None or args.get("lon") is not None:
        try:
            lat, lon = float(args.get("lat")), float(args.get("lon"))
        except (TypeError, ValueError):
            raise ValueError("lat and lon must be numbers (decimal degrees)")
        if not (-90 <= lat <= 90) or not (-180 <= lon <= 360):
            raise ValueError("lat must be within ±90 and lon within ±180")
        kind = _text(args.get("kind"), 20).lower() or "place"
        place = {"lat": round(lat, 5), "lon": round(lon - 360 if lon > 180 else lon, 5), "kind": kind if kind in PLACE_KINDS else "place"}
        color = _text(args.get("color"), 7)
        if re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            place["color"] = color

    with _lock:
        notes = _load()
        cur = notes.get(key) if not args.get("replace") else None
        cur = cur or {"body": slug(body), "feature": feature, "summary": "", "facts": [], "sections": [], "media": [], "links": []}
        if place:
            cur["place"] = {**cur.get("place", {}), **place}
        for r in (args.get("remove") or [])[:30]:  # drop what's wrong before adding what's right
            if not isinstance(r, dict) or r.get("part") not in ("facts", "sections", "media", "links", "summary", "place"):
                problems.append(f"remove needs part = facts | sections | media | links | summary | place: {r!r:.80}")
                continue
            if r["part"] == "summary":
                cur["summary"] = ""
            elif r["part"] == "place":
                cur.pop("place", None)
            else:
                m = _text(r.get("match"), 200).lower()
                before = len(cur[r["part"]])
                cur[r["part"]] = [x for x in cur[r["part"]] if m and m not in " ".join(str(v) for v in x.values()).lower()]
                if len(cur[r["part"]]) == before:
                    problems.append(f"nothing in {r['part']} matched {m!r}")
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


def place_rows(body: str | None = None) -> list[dict]:
    """Every note that is a point of its own, as the Worlds app's places layer wants it."""
    out = []
    for key, n in _load().items():
        p = n.get("place")
        if not p or (body and n.get("body") != slug(body)):
            continue
        out.append({"key": key, "body": n["body"], "feature": n["feature"], "lat": p["lat"], "lon": p["lon"], "kind": p.get("kind", "place"),
                    "color": p.get("color"), "summary": n.get("summary", ""), "media": len(n.get("media", [])), "by": n.get("by"), "updated": n.get("updated")})
    return out


@router.get("/places")
def get_places(body: str | None = Query(None)):
    return {"places": place_rows(body)}


@router.get("/notes/all")
def list_notes(body: str | None = Query(None)):
    """Every annotated card, briefly (for the Atlas copilot's context and the Worlds app's index)."""
    rows = []
    for key, n in _load().items():
        if body and n.get("body") != slug(body):
            continue
        rows.append({"key": key, "body": n["body"], "feature": n["feature"], "facts": len(n.get("facts", [])), "sections": len(n.get("sections", [])),
                     "media": len(n.get("media", [])), "links": len(n.get("links", [])), "place": n.get("place"), "by": n.get("by"), "updated": n.get("updated")})
    return {"notes": rows}


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
             f"{len(note['sections'])} sections, {len(note['media'])} media, {len(note['links'])} links"
             + (f", shown on the map at {note['place']['lat']}, {note['place']['lon']} ({note['place'].get('kind', 'place')})" if note.get("place") else "") + "."]
    if problems:
        lines.append("Problems:\n- " + "\n- ".join(problems))
    lines.append("The card refreshes by itself in the Worlds app; clicking the feature shows it.")
    return ToolResult("\n".join(lines), {"key": key, "body": note["body"], "feature": note["feature"]}, error=bool(problems) and not note["media"] and not note["facts"] and not note["sections"])


async def read_tool(args: dict, ctx: Any) -> ToolResult:
    body = _text(args.get("body"), 40)
    feature = clean_name(_text(args.get("feature"), 160))
    if feature:
        if not body:
            return ToolResult("Give the world id too ('body').", error=True)
        note = _load().get(key_for(body, feature))
        if not note:
            return ToolResult(f"No card notes yet for {feature} on {body}: the card shows only the curated text. "
                              "Use annotate_map_feature to add some.")
        view = {k: v for k, v in note.items() if k != "media"}
        view["media"] = [{k: m.get(k) for k in ("kind", "caption", "credit", "license", "url", "note")} for m in note.get("media", [])]
        return ToolResult(json.dumps(view, ensure_ascii=False, indent=1)[:12000], {"key": key_for(body, feature)})
    rows = list_notes(body or None)["notes"]
    if not rows:
        return ToolResult("No cards have been annotated yet" + (f" on {body}" if body else "") + ".")
    lines = [f"{len(rows)} annotated card(s)" + (f" on {body}" if body else "") + ":"]
    for r in rows[:80]:
        where = f" · place at {r['place']['lat']}, {r['place']['lon']}" if r.get("place") else ""
        lines.append(f"- {r['feature']} ({r['body']}): {r['facts']} facts, {r['sections']} sections, {r['media']} media, {r['links']} links{where}")
    return ToolResult("\n".join(lines))


def register():
    TOOLS["read_map_card"] = {
        "fn": read_tool, "service": None,
        "ui": {"displayName": "Read Map Card", "icon": "BookOpen", "category": "web",
               "description": "Reads what a Worlds card already holds, or lists every annotated card."},
        "schema": _fn(
            "read_map_card",
            "Read the extra information already attached to a feature's card in the Worlds app (summary, facts, sections, media, "
            "links, and whether it is a place of its own), so you add to it rather than repeat it. Without 'feature' it lists "
            "every annotated card, optionally for one world.",
            {
                "body": {"type": "string", "description": "World id: 'venus', 'mars', 'moon', 'earth', ..."},
                "feature": {"type": "string", "description": "The feature's name as its card shows it; omit to list all cards"},
            },
            [],
        ),
    }
    TOOLS["annotate_map_feature"] = {
        "fn": annotate_tool, "service": None,
        "ui": {"displayName": "Annotate Map Card", "icon": "Pencil", "category": "web",
               "description": "Adds facts, sections, pictures, sound and links to a feature's card in the Worlds app."},
        "schema": _fn(
            "annotate_map_feature",
            "Add verified information to the card a map feature shows when clicked in the Worlds app (landing sites, craters, "
            "wonders, shipwrecks, prehistoric sites, any named feature). Merges with what's there: facts and sections replace ones "
            "with the same label/title, media and links are added; 'remove' drops items first. Media URLs must point straight at a "
            "JPEG/PNG/GIF/WebP image, MP3/OGG/WAV/FLAC audio, MP4/WebM video or GLB 3D model file (for Wikimedia Commons use the "
            "upload.wikimedia.org file URL; NASA 3D Resources GLBs from raw.githubusercontent.com/nasa/NASA-3D-Resources work); "
            "they are downloaded and kept offline. Give every media item its credit, license and source page. To put a NEW point on "
            "the map (something no layer has), pass lat, lon and kind: the card then also appears as a pin in the 'Atlas places' layer.",
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
                "remove": {"type": "array", "description": "Items to drop before adding: {part: facts|sections|media|links, match: text found in the item} or {part: summary|place}",
                           "items": {"type": "object", "properties": {"part": {"type": "string"}, "match": {"type": "string"}}, "required": ["part"]}},
                "lat": {"type": "number", "description": "With lon: make this card a point of its own on the map (decimal degrees, north positive)"},
                "lon": {"type": "number", "description": "East positive"},
                "kind": {"type": "string", "description": "For a new point: place, mission, crater, volcano, mountain, canyon, plain, sea, site, city, wreck, wonder, event or route"},
                "color": {"type": "string", "description": "Optional pin colour for a new point, #rrggbb"},
                "replace": {"type": "boolean", "description": "Start the note over instead of merging (default false)"},
            },
            ["body", "feature"],
        ),
    }
