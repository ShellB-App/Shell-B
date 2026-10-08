"""Asset libraries: reusable sets of sounds, music, textures, sprites, pictures, models and fonts.

A library is a folder of files (data/assets/<lib id>/) plus a row per asset with curated metadata: title, category,
tags, description, license, author, source URL and free-form extra fields (sprite frame size, loop points, BPM…).
People upload and curate on the Assets page (#/assets); every agent, wherever it works, gets the `asset_library` tool
to search, look at, add, tag and import assets, and to create or fork libraries. Locked libraries are read-only to
agents, which fork them instead. Code reaches the files read-only under /library/assets/<lib id>/ in run_code, where
each library also has a library.json manifest; Studio and Code projects import copies so they stay self-contained.

Asset scouts: a scout job sends an agent (Magpie by default) off on its own to find assets for a library from the web,
with the `scrape` tool (links, downloads, archives; scrape.py), run_code to process them and asset_library to file
them with their license and attribution. Jobs queue and run one at a time, like to-dos, each in its own chat.
"""
import asyncio
import hashlib
import io
import json
import mimetypes
import re
import shutil
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask

import db
import ids
import scrape
from tools import TOOLS, ToolResult, _fn

router = APIRouter(prefix="/api/assets")
ASSETS = db.DATA / "assets"
THUMBS = db.DATA / "asset-thumbs"
TMP = db.DATA / "asset-tmp"
for _d in (ASSETS, THUMBS, TMP):
    _d.mkdir(exist_ok=True)
MOUNT = "/library/assets"
MANIFEST = "library.json"
FILE_LIMIT = scrape.FILE_LIMIT
CATEGORIES = ["picture", "texture", "sprite", "tileset", "icon", "ui", "background", "sound", "music", "ambience", "voice",
              "model", "font", "vector", "video", "data", "other"]
DEFAULT_CATEGORY = {"image": "picture", "audio": "sound", "video": "video", "model": "model", "font": "font", "data": "data",
                    "archive": "other", "other": "other"}
LICENSES = ["CC0", "CC-BY 4.0", "CC-BY 3.0", "CC-BY-SA 4.0", "CC-BY-SA 3.0", "OGA-BY", "GPL", "MIT", "Public domain",
            "Royalty-free", "Generated", "Proprietary", "Unknown"]
FIELDS = ("title", "description", "category", "license", "author", "source_url")
JOB_STATUSES = ("queued", "running", "done", "failed", "stopped")
MAX_QUEUE = 20
UA_LIMIT = 30   # tags per asset

# set by app.py: async (job, message, note, on_conv) -> (conv_id, status, error, final_text)
runner = None
abort_turn = None
_wake: asyncio.Event | None = None
_running: dict | None = None
_dirty: set[str] = set()   # libraries whose library.json needs rewriting
_TASKS: set = set()


def init():
    with db.conn() as c:
        c.executescript("""
CREATE TABLE IF NOT EXISTS asset_libs(
  id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT '', tags TEXT DEFAULT '[]', license TEXT DEFAULT '',
  locked INTEGER DEFAULT 0, forked_from TEXT, created_by TEXT, created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS assets(
  id TEXT PRIMARY KEY, lib_id TEXT, path TEXT, kind TEXT, mime TEXT, size INTEGER, sha TEXT,
  width INTEGER, height INTEGER, duration REAL, title TEXT DEFAULT '', description TEXT DEFAULT '', category TEXT,
  tags TEXT DEFAULT '[]', license TEXT DEFAULT '', author TEXT DEFAULT '', source_url TEXT DEFAULT '', meta TEXT DEFAULT '{}',
  added_by TEXT, job_id TEXT, created REAL, updated REAL, UNIQUE(lib_id, path));
CREATE INDEX IF NOT EXISTS assets_lib ON assets(lib_id, created);
CREATE INDEX IF NOT EXISTS assets_sha ON assets(lib_id, sha);
CREATE TABLE IF NOT EXISTS asset_jobs(
  id TEXT PRIMARY KEY, lib_id TEXT, agent_id TEXT, brief TEXT, sources TEXT DEFAULT '[]', max_assets INTEGER DEFAULT 40,
  license TEXT DEFAULT 'open', status TEXT DEFAULT 'queued', conv_id TEXT, result TEXT DEFAULT '', error TEXT DEFAULT '',
  created_by TEXT, created REAL, started REAL, finished REAL);
""")
        c.execute("UPDATE asset_jobs SET status='queued', error='Interrupted by a server restart; it will run again.' "
                  "WHERE status='running'")


# ── rows ────────────────────────────────────────────────────────────────────

def _lib(r) -> dict:
    return {"id": r["id"], "name": r["name"], "description": r["description"] or "", "tags": json.loads(r["tags"] or "[]"),
            "license": r["license"] or "", "locked": bool(r["locked"]), "forkedFrom": r["forked_from"],
            "createdBy": r["created_by"], "createdAt": (r["created"] or 0) * 1000, "updatedAt": (r["updated"] or 0) * 1000}


def _asset(r) -> dict:
    return {"id": r["id"], "libId": r["lib_id"], "path": r["path"], "kind": r["kind"], "mime": r["mime"], "size": r["size"],
            "sha": r["sha"], "width": r["width"], "height": r["height"], "duration": r["duration"], "title": r["title"] or "",
            "description": r["description"] or "", "category": r["category"] or "other", "tags": json.loads(r["tags"] or "[]"),
            "license": r["license"] or "", "author": r["author"] or "", "sourceUrl": r["source_url"] or "",
            "meta": json.loads(r["meta"] or "{}"), "addedBy": r["added_by"] or "", "jobId": r["job_id"],
            "createdAt": (r["created"] or 0) * 1000, "updatedAt": (r["updated"] or 0) * 1000}


def _job(r) -> dict:
    lib = get_lib(r["lib_id"])
    with db.conn() as c:
        added = c.execute("SELECT COUNT(*) FROM assets WHERE job_id=?", (r["id"],)).fetchone()[0]
    return {"id": r["id"], "libId": r["lib_id"], "libName": lib["name"] if lib else "(deleted library)", "agentId": r["agent_id"],
            "brief": r["brief"], "sources": json.loads(r["sources"] or "[]"), "maxAssets": r["max_assets"], "license": r["license"],
            "status": r["status"], "convId": r["conv_id"], "result": r["result"] or "", "error": r["error"] or "", "added": added,
            "createdBy": r["created_by"], "createdAt": (r["created"] or 0) * 1000,
            "startedAt": (r["started"] or 0) * 1000 or None, "finishedAt": (r["finished"] or 0) * 1000 or None}


def norm_tags(tags) -> list[str]:
    if isinstance(tags, str):
        tags = re.split(r"[,;\n]", tags)
    out = []
    for t in tags or []:
        t = re.sub(r"\s+", " ", str(t).strip().lower().lstrip("#"))[:40]
        if t and t not in out:
            out.append(t)
    return out[:UA_LIMIT]


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")[:48] or "library"


# ── libraries ───────────────────────────────────────────────────────────────

def lib_dir(lid: str) -> Path:
    return ASSETS / ids.check("assetlib", lid, "asset library")


def get_lib(lid: str) -> dict | None:
    with db.conn() as c:
        r = c.execute("SELECT * FROM asset_libs WHERE id=?", (lid,)).fetchone()
    return _lib(r) if r else None


def list_libs() -> list[dict]:
    with db.conn() as c:
        libs = [_lib(r) for r in c.execute("SELECT * FROM asset_libs ORDER BY updated DESC")]
        stats = {r["lib_id"]: r for r in c.execute(
            "SELECT lib_id, COUNT(*) n, COALESCE(SUM(size),0) bytes FROM assets GROUP BY lib_id")}
        cats = {}
        for r in c.execute("SELECT lib_id, category, COUNT(*) n FROM assets GROUP BY lib_id, category ORDER BY n DESC"):
            cats.setdefault(r["lib_id"], {})[r["category"]] = r["n"]
        covers = {}
        for r in c.execute("SELECT id, lib_id FROM assets WHERE kind='image' ORDER BY created DESC"):
            if len(covers.setdefault(r["lib_id"], [])) < 4:
                covers[r["lib_id"]].append(r["id"])
    for l in libs:
        s = stats.get(l["id"])
        l.update(count=s["n"] if s else 0, bytes=s["bytes"] if s else 0, categories=cats.get(l["id"], {}),
                 covers=covers.get(l["id"], []))
    return libs


def create_lib(name: str, description="", tags=None, license="", created_by="you", forked_from=None) -> dict:
    name = (name or "").strip()[:120]
    if not name:
        raise ValueError("A library needs a name.")
    lid, now = db.new_id("alib"), time.time()
    with db.conn() as c:
        c.execute("INSERT INTO asset_libs(id, name, description, tags, license, locked, forked_from, created_by, created, updated) "
                  "VALUES(?,?,?,?,?,0,?,?,?,?)",
                  (lid, name, (description or "").strip()[:4000], json.dumps(norm_tags(tags)), (license or "").strip()[:80],
                   forked_from, created_by, now, now))
    lib_dir(lid).mkdir(parents=True, exist_ok=True)
    _dirty.add(lid)
    return get_lib(lid)


def update_lib(lid: str, patch: dict) -> dict:
    if not get_lib(lid):
        raise ValueError("No such library.")
    sets, vals = [], []
    for k, col in (("name", "name"), ("description", "description"), ("license", "license")):
        if k in patch and patch[k] is not None:
            v = str(patch[k]).strip()
            if k == "name" and not v:
                raise ValueError("A library needs a name.")
            sets.append(f"{col}=?"); vals.append(v[:4000])
    if "tags" in patch and patch["tags"] is not None:
        sets.append("tags=?"); vals.append(json.dumps(norm_tags(patch["tags"])))
    if "locked" in patch and patch["locked"] is not None:
        sets.append("locked=?"); vals.append(1 if patch["locked"] else 0)
    if sets:
        with db.conn() as c:
            c.execute(f"UPDATE asset_libs SET {', '.join(sets)}, updated=? WHERE id=?", (*vals, time.time(), lid))
        _dirty.add(lid)
    return get_lib(lid)


def touch(lid: str):
    with db.conn() as c:
        c.execute("UPDATE asset_libs SET updated=? WHERE id=?", (time.time(), lid))
    _dirty.add(lid)


def delete_lib(lid: str):
    with db.conn() as c:
        ids = [r[0] for r in c.execute("SELECT id FROM assets WHERE lib_id=?", (lid,))]
        c.execute("DELETE FROM assets WHERE lib_id=?", (lid,))
        c.execute("DELETE FROM asset_libs WHERE id=?", (lid,))
    for aid in ids:
        for t in THUMBS.glob(f"{aid}-*"):
            t.unlink(missing_ok=True)
    shutil.rmtree(lib_dir(lid), ignore_errors=True)
    _dirty.discard(lid)


def fork_lib(lid: str, name: str | None = None, created_by="you", ids: list[str] | None = None) -> dict:
    """A new library with copies of every asset (or just `ids`); files are hard-linked, so forks cost no disk space
    until one side replaces a file."""
    src = get_lib(lid)
    if not src:
        raise ValueError("No such library.")
    new = create_lib(name or f"{src['name']} (fork)", src["description"], src["tags"], src["license"], created_by, forked_from=lid)
    rows = list_assets(lid)
    if ids:
        keep = set(ids)
        rows = [a for a in rows if a["id"] in keep]
    now = time.time()
    with db.conn() as c:
        for a in rows:
            s, d = lib_dir(lid) / a["path"], lib_dir(new["id"]) / a["path"]
            if not s.is_file():
                continue
            d.parent.mkdir(parents=True, exist_ok=True)
            try:
                d.hardlink_to(s)
            except OSError:
                shutil.copy2(s, d)
            c.execute("INSERT INTO assets(id, lib_id, path, kind, mime, size, sha, width, height, duration, title, description, "
                      "category, tags, license, author, source_url, meta, added_by, job_id, created, updated) "
                      "SELECT ?, ?, path, kind, mime, size, sha, width, height, duration, title, description, category, tags, "
                      "license, author, source_url, meta, added_by, NULL, created, ? FROM assets WHERE id=?",
                      (db.new_id("ast"), new["id"], now, a["id"]))
    _dirty.add(new["id"])
    return get_lib(new["id"])


def resolve_lib(ref) -> dict:
    ref = str(ref or "").strip().strip("`")
    if not ref:
        raise ValueError("Pass lib: a library id (alib-…) or its name. action=libraries lists them.")
    lib = get_lib(ref)
    if lib:
        return lib
    libs = list_libs()
    low = ref.lower()
    hits = [l for l in libs if l["name"].lower() == low] or [l for l in libs if low in l["name"].lower()]
    if len(hits) == 1:
        return hits[0]
    if hits:
        raise ValueError(f"{ref!r} matches {len(hits)} libraries: " + ", ".join(f"`{l['id']}` {l['name']}" for l in hits[:10]))
    raise ValueError(f"No asset library matches {ref!r}. action=libraries lists them; action=create makes one.")


# ── assets ──────────────────────────────────────────────────────────────────

def kind_of(name: str) -> str:
    if name.lower().endswith((".txt", ".md")):   # readmes and license files that come with packs
        return "data"
    k = scrape.ext_kind(name)
    return k if k in ("image", "audio", "video", "model", "font", "data", "archive") else "other"


def probe(p: Path) -> dict:
    kind = kind_of(p.name)
    out = {"kind": kind, "mime": mimetypes.guess_type(p.name)[0] or "application/octet-stream", "width": None, "height": None,
           "duration": None}
    if kind == "image" and p.suffix.lower() != ".svg":
        try:
            from PIL import Image
            with Image.open(p) as im:
                out["width"], out["height"] = im.width, im.height
                n = getattr(im, "n_frames", 1)
                if n > 1:   # animated GIF/WebP/APNG: approximate length from the first frame's delay
                    out["duration"] = round((im.info.get("duration") or 100) * n / 1000, 2)
        except Exception:
            pass
    elif kind == "image":
        try:
            head = p.read_text(errors="replace")[:4000]
            vb = re.search(r'viewBox="[\d.\-]+[ ,]+[\d.\-]+[ ,]+([\d.]+)[ ,]+([\d.]+)"', head)
            w, h = re.search(r'\bwidth="([\d.]+)', head), re.search(r'\bheight="([\d.]+)', head)
            if w and h:
                out["width"], out["height"] = int(float(w.group(1))), int(float(h.group(1)))
            elif vb:
                out["width"], out["height"] = int(float(vb.group(1))), int(float(vb.group(2)))
        except Exception:
            pass
    elif kind == "audio":
        try:
            import soundfile
            info = soundfile.info(str(p))
            out["duration"] = round(info.duration, 3)
        except Exception:
            pass
    return out


def sha_of(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def clean_rel(rel: str) -> str:
    parts = [re.sub(r"[^\w.\- ()+,]+", "_", s).strip(" .") for s in str(rel or "").replace("\\", "/").split("/")]
    parts = [s for s in parts if s and s not in (".", "..")]
    if not parts:
        raise ValueError("Empty asset path.")
    out = "/".join(parts)[:300]
    if out == MANIFEST:
        raise ValueError(f"{MANIFEST} is reserved for the library's manifest.")
    return out


def get_asset(aid: str) -> dict | None:
    with db.conn() as c:
        r = c.execute("SELECT * FROM assets WHERE id=?", (aid,)).fetchone()
    return _asset(r) if r else None


def find_asset(lid: str, ref: str) -> dict:
    ref = str(ref or "").strip().strip("`")
    with db.conn() as c:
        r = c.execute("SELECT * FROM assets WHERE lib_id=? AND (id=? OR path=?)", (lid, ref, ref.lstrip("/"))).fetchone()
        if not r:
            rows = c.execute("SELECT * FROM assets WHERE lib_id=? AND (path LIKE ? OR title LIKE ?) LIMIT 6",
                             (lid, f"%{ref}%", f"%{ref}%")).fetchall()
            if len(rows) == 1:
                r = rows[0]
            elif rows:
                raise ValueError(f"{ref!r} matches several assets: " + ", ".join(f"`{x['id']}` {x['path']}" for x in rows))
    if not r:
        raise ValueError(f"No asset {ref!r} in that library.")
    return _asset(r)


def list_assets(lid: str | None = None, query="", tags=None, category="", kind="", limit=0) -> list[dict]:
    """Assets of one library (or all), newest first, filtered by words (title, path, tags, description, author…),
    every one of `tags`, a category and a kind."""
    sql, vals = "SELECT * FROM assets", []
    conds = []
    if lid:
        conds.append("lib_id=?"); vals.append(lid)
    if category:
        conds.append("category=?"); vals.append(category.strip().lower())
    if kind:
        conds.append("kind=?"); vals.append(kind.strip().lower())
    words = [w for w in re.findall(r"[\w\-]+", (query or "").lower()) if len(w) > 1]
    for w in words:
        conds.append("lower(path || ' ' || title || ' ' || description || ' ' || tags || ' ' || category || ' ' || author "
                     "|| ' ' || license || ' ' || meta) LIKE ?")
        vals.append(f"%{w}%")
    if conds:
        sql += " WHERE " + " AND ".join(conds)
    sql += " ORDER BY created DESC, path"
    with db.conn() as c:
        rows = [_asset(r) for r in c.execute(sql, vals)]
    want = norm_tags(tags)
    if want:
        rows = [a for a in rows if all(t in a["tags"] for t in want)]
    return rows[:limit] if limit else rows


def add_file(lid: str, src: Path, rel: str, fields: dict | None = None, added_by="you", job_id=None, move=False,
             replace=False) -> tuple[dict, str]:
    """File src into the library at rel. Returns (asset, status) with status "added", "duplicate" (same bytes already
    there: its metadata is merged instead) or "replaced"."""
    fields = fields or {}
    if not src.is_file():
        raise ValueError(f"{src.name} is not a file.")
    if src.stat().st_size > FILE_LIMIT:
        raise ValueError(f"{src.name} is over {FILE_LIMIT // 2**20} MB.")
    digest = sha_of(src)
    with db.conn() as c:
        dup = c.execute("SELECT * FROM assets WHERE lib_id=? AND sha=?", (lid, digest)).fetchone()
    if dup and not replace:
        a = _asset(dup)
        merged = {k: v for k, v in fields.items() if v and not a.get({"source_url": "sourceUrl"}.get(k, k))}
        if fields.get("tags"):
            merged["add_tags"] = fields["tags"]
        merged.pop("tags", None)
        return (update_asset(a["id"], merged) if merged else a), "duplicate"
    rel = clean_rel(rel)
    root = lib_dir(lid)
    dest = root / rel
    existing = None
    with db.conn() as c:
        r = c.execute("SELECT * FROM assets WHERE lib_id=? AND path=?", (lid, rel)).fetchone()
        existing = _asset(r) if r else None
    if existing and not replace:
        stem, suf, n = dest.stem, dest.suffix, 1
        while (dest.parent / f"{stem}-{n}{suf}").exists() or _path_taken(lid, str((dest.parent / f"{stem}-{n}{suf}").relative_to(root))):
            n += 1
        dest = dest.parent / f"{stem}-{n}{suf}"
        rel = str(dest.relative_to(root))
        existing = None
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    if move:
        shutil.move(str(src), dest)
    else:
        shutil.copy2(src, dest)
    info = probe(dest)
    now = time.time()
    category = (fields.get("category") or "").strip().lower() or DEFAULT_CATEGORY.get(info["kind"], "other")
    title = (fields.get("title") or "").strip() or re.sub(r"[_\-]+", " ", dest.stem).strip()
    meta = fields.get("meta") if isinstance(fields.get("meta"), dict) else {}
    with db.conn() as c:
        if existing:   # replace the file under an existing asset, keeping its id and curation
            c.execute("UPDATE assets SET kind=?, mime=?, size=?, sha=?, width=?, height=?, duration=?, updated=? WHERE id=?",
                      (info["kind"], info["mime"], dest.stat().st_size, digest, info["width"], info["height"], info["duration"],
                       now, existing["id"]))
            aid, status = existing["id"], "replaced"
        else:
            aid, status = db.new_id("ast"), "added"
            c.execute("INSERT INTO assets(id, lib_id, path, kind, mime, size, sha, width, height, duration, title, description, "
                      "category, tags, license, author, source_url, meta, added_by, job_id, created, updated) "
                      "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      (aid, lid, rel, info["kind"], info["mime"], dest.stat().st_size, digest, info["width"], info["height"],
                       info["duration"], title[:200], (fields.get("description") or "").strip()[:4000], category[:40],
                       json.dumps(norm_tags(fields.get("tags"))), (fields.get("license") or "").strip()[:80],
                       (fields.get("author") or "").strip()[:200], (fields.get("source_url") or "").strip()[:1000],
                       json.dumps(meta), added_by, job_id, now, now))
    for t in THUMBS.glob(f"{aid}-*"):
        t.unlink(missing_ok=True)
    touch(lid)
    if existing and fields:
        return update_asset(aid, {k: v for k, v in fields.items() if v}), status
    return get_asset(aid), status


def _path_taken(lid, rel) -> bool:
    with db.conn() as c:
        return bool(c.execute("SELECT 1 FROM assets WHERE lib_id=? AND path=?", (lid, rel)).fetchone())


def update_asset(aid: str, patch: dict) -> dict:
    """Edit curation fields. tags replaces the tag list; add_tags/remove_tags adjust it; meta merges (null removes a
    key); path renames or moves the file inside its library."""
    a = get_asset(aid)
    if not a:
        raise ValueError("No such asset.")
    sets, vals = [], []
    alias = {"sourceUrl": "source_url"}
    for k, v in patch.items():
        col = alias.get(k, k)
        if col in FIELDS and v is not None:
            v = str(v).strip()
            if col == "category":
                v = v.lower() or "other"
            sets.append(f"{col}=?"); vals.append(v[:4000])
    tags = a["tags"]
    if patch.get("tags") is not None:
        tags = norm_tags(patch["tags"])
    if patch.get("add_tags") or patch.get("addTags"):
        tags = norm_tags(tags + norm_tags(patch.get("add_tags") or patch.get("addTags")))
    if patch.get("remove_tags") or patch.get("removeTags"):
        drop = set(norm_tags(patch.get("remove_tags") or patch.get("removeTags")))
        tags = [t for t in tags if t not in drop]
    if tags != a["tags"]:
        sets.append("tags=?"); vals.append(json.dumps(tags))
    if isinstance(patch.get("meta"), dict):
        meta = {**a["meta"]}
        for k, v in patch["meta"].items():
            if v is None or v == "":
                meta.pop(str(k), None)
            else:
                meta[str(k)[:60]] = v
        sets.append("meta=?"); vals.append(json.dumps(meta)[:20000])
    if patch.get("path") and clean_rel(patch["path"]) != a["path"]:
        new = clean_rel(patch["path"])
        if Path(new).suffix.lower() != Path(a["path"]).suffix.lower():
            new += Path(a["path"]).suffix
        if _path_taken(a["libId"], new):
            raise ValueError(f"{new} already exists in that library.")
        src, dst = lib_dir(a["libId"]) / a["path"], lib_dir(a["libId"]) / new
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
        _prune(src.parent, lib_dir(a["libId"]))
        sets.append("path=?"); vals.append(new)
    if sets:
        with db.conn() as c:
            c.execute(f"UPDATE assets SET {', '.join(sets)}, updated=? WHERE id=?", (*vals, time.time(), aid))
        touch(a["libId"])
    return get_asset(aid)


def _prune(d: Path, root: Path):
    while d != root and d.is_dir() and not any(d.iterdir()):
        d.rmdir()
        d = d.parent


def delete_asset(aid: str):
    a = get_asset(aid)
    if not a:
        return
    with db.conn() as c:
        c.execute("DELETE FROM assets WHERE id=?", (aid,))
    p = lib_dir(a["libId"]) / a["path"]
    p.unlink(missing_ok=True)
    _prune(p.parent, lib_dir(a["libId"]))
    for t in THUMBS.glob(f"{aid}-*"):
        t.unlink(missing_ok=True)
    touch(a["libId"])


def file_of(a: dict) -> Path:
    return lib_dir(a["libId"]) / a["path"]


def file_url(a: dict) -> str:
    from urllib.parse import quote
    return f"/api/assets/file/{a['libId']}/{quote(a['path'])}"


def thumb(a: dict) -> tuple[bytes, str] | None:
    """A small preview: WebP for raster images and .glb models, the file itself for SVG."""
    p = file_of(a)
    if not p.is_file():
        return None
    if p.suffix.lower() == ".svg":
        return p.read_bytes(), "image/svg+xml"
    cache = THUMBS / f"{a['id']}-{(a['sha'] or '')[:10]}.webp"
    if cache.exists():
        return cache.read_bytes(), "image/webp"
    from PIL import Image
    try:
        if a["kind"] == "image":
            im = Image.open(p)
            im.seek(0)
        elif p.suffix.lower() == ".glb":
            from tools import _mesh_preview
            im = Image.open(io.BytesIO(_mesh_preview(p.read_bytes(), [0.72, 0.72, 0.76], 384)))
            im = im.crop((im.width // 3, 0, 2 * im.width // 3, im.height))   # the three-quarter view
        else:
            return None
        im = im.convert("RGBA")
        small = max(im.width, im.height) <= 128   # pixel art: scale up without smoothing so sprites stay crisp
        if small:
            f = max(1, 256 // max(im.width, im.height))
            im = im.resize((im.width * f, im.height * f), Image.NEAREST)
        else:
            im.thumbnail((384, 384), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "WEBP", quality=82, lossless=small)
        cache.write_bytes(buf.getvalue())
        return buf.getvalue(), "image/webp"
    except Exception:
        return None


def font_coverage(p: Path) -> str:
    """What a font maps, from fc-query: code point ranges, and a warning when it's a keyboard-layout font."""
    try:
        out = subprocess.run(["fc-query", "--format=%{charset}\n", str(p)], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return ""
    ranges = []
    for tok in (out.splitlines() or [""])[0].split():
        lo, _, hi = tok.partition("-")
        try:
            ranges.append((int(lo, 16), int(hi or lo, 16)))
        except ValueError:
            continue
    if not ranges:
        return ""
    n = sum(hi - lo + 1 for lo, hi in ranges)
    shown = ", ".join(f"U+{lo:04X}" + (f"–{hi:04X}" if hi > lo else "") for lo, hi in ranges[:12])
    line = f"font covers {n} code points: {shown}" + (", …" if len(ranges) > 12 else "")
    # nothing past Latin Extended-B apart from punctuation, symbols and a few private-use slots
    if all(hi < 0x250 or (0x2000 <= lo and hi < 0x2200) or (0xF000 <= lo and hi < 0xF900) for lo, hi in ranges):
        line += ("\nIf this font draws anything other than Latin letters (Tengwar, runes, Elvish, symbols, icons), its glyphs "
                 "sit on ASCII keys: write text in its keyboard layout (action=view shows which key draws what), not in "
                 "Unicode code points it doesn't cover, which render as fallback boxes.")
    missing = "".join(chr(c) for c in range(0x21, 0x7F) if not any(lo <= c <= hi for lo, hi in ranges))
    if missing and len(missing) < 94:
        line += (f"\nIncomplete: no glyphs for the keys {missing} — text using them falls back to another font. A font "
                 "with many gaps is usually a supplement (e.g. alternate forms) to pair with the family's main font.")
    return line


def _font_specimen(p: Path) -> bytes | None:
    """A keyboard chart of a font: each key's label in a plain font, with the glyph the font draws for it underneath."""
    from PIL import Image, ImageDraw, ImageFont
    rows = ["1234567890-=", "qwertyuiop[]", "asdfghjkl;'\\", "zxcvbnm,./`~", "QWERTYUIOP{}", "ASDFGHJKL:\"|", "ZXCVBNM<>?!@"]
    try:
        face, label = ImageFont.truetype(str(p), 40), ImageFont.load_default(15)
    except Exception:
        return None
    sample = "The quick brown fox jumps over the lazy dog"
    im = Image.new("RGB", (12 * 78 + 20, 84 * len(rows) + 90), "white")
    d = ImageDraw.Draw(im)
    for r, row in enumerate(rows):
        for i, ch in enumerate(row):
            x, y = 10 + i * 78, r * 84
            d.text((x + 4, y + 4), ch, font=label, fill="#c0392b")
            d.text((x + 14, y + 24), ch, font=face, fill="black")
    y = 84 * len(rows)
    d.text((10, y + 4), sample, font=label, fill="#c0392b")
    d.text((10, y + 26), sample, font=ImageFont.truetype(str(p), 34), fill="black")
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def _png_of(a: dict) -> bytes | None:
    """The asset as PNG bytes for a vision model: SVGs rasterized with PyMuPDF, models as their preview,
    fonts as a keyboard chart."""
    p = file_of(a)
    if a["kind"] == "font":
        return _font_specimen(p)
    if p.suffix.lower() == ".svg":
        import pymupdf
        with pymupdf.open(stream=p.read_bytes(), filetype="svg") as doc:
            page = doc[0]
            zoom = max(1.0, 1024 / max(page.rect.width, page.rect.height, 1))
            return page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False).tobytes("png")
    if p.suffix.lower() == ".glb":
        from tools import _mesh_preview
        return _mesh_preview(p.read_bytes(), [0.72, 0.72, 0.76], 512)
    if a["kind"] == "image":
        from PIL import Image
        with Image.open(p) as im:
            im.seek(0)
            im = im.convert("RGBA")
            if max(im.width, im.height) < 256:   # tiny sprites: enlarge crisply so the model can see them
                f = 512 // max(im.width, im.height, 1)
                im = im.resize((im.width * f, im.height * f), Image.NEAREST)
            elif max(im.width, im.height) > 2048:
                im.thumbnail((2048, 2048))
            buf = io.BytesIO()
            im.save(buf, "PNG")
            return buf.getvalue()
    return None


def manifest(lid: str) -> dict:
    lib = get_lib(lid)
    rows = list_assets(lid)
    return {"library": {k: lib[k] for k in ("id", "name", "description", "tags", "license", "forkedFrom")} if lib else {},
            "assets": [{"path": a["path"], "title": a["title"], "kind": a["kind"], "category": a["category"], "tags": a["tags"],
                        "description": a["description"], "license": a["license"], "author": a["author"],
                        "source": a["sourceUrl"], "width": a["width"], "height": a["height"], "duration": a["duration"],
                        "size": a["size"], "meta": a["meta"]} for a in sorted(rows, key=lambda a: a["path"])]}


def credits(rows: list[dict]) -> str:
    """Attribution list for CREDITS.md: what CC-BY and similar licenses ask for when you ship the asset."""
    lines = ["# Credits", ""]
    for a in sorted(rows, key=lambda a: a["path"]):
        bits = [f"**{a['title'] or a['path']}** (`{a['path']}`)"]
        if a["author"]:
            bits.append(f"by {a['author']}")
        if a["license"]:
            bits.append(f"· {a['license']}")
        if a["sourceUrl"]:
            bits.append(f"· {a['sourceUrl']}")
        lines.append("- " + " ".join(bits))
    return "\n".join(lines) + "\n"


def write_manifests():
    for lid in list(_dirty):
        _dirty.discard(lid)
        if get_lib(lid):
            lib_dir(lid).mkdir(parents=True, exist_ok=True)
            (lib_dir(lid) / MANIFEST).write_text(json.dumps(manifest(lid), indent=1))


# ── agent-facing text ───────────────────────────────────────────────────────

def _lib_line(l: dict) -> str:
    cats = ", ".join(f"{n} {k}" for k, n in list(l.get("categories", {}).items())[:6])
    bits = [f"- `{l['id']}` **{l['name']}** ({l.get('count', 0)} assets{': ' + cats if cats else ''})"]
    if l["tags"]:
        bits.append("tags: " + ", ".join(l["tags"][:10]))
    if l["locked"]:
        bits.append("locked (fork to change)")
    if l["description"]:
        bits.append("— " + l["description"][:140])
    return " · ".join(bits)


def _asset_line(a: dict, lib_name: str | None = None) -> str:
    dims = f" {a['width']}×{a['height']}" if a["width"] else ""
    dur = f" {a['duration']:.1f}s" if a["duration"] else ""
    tags = f" [{', '.join(a['tags'][:8])}]" if a["tags"] else ""
    lic = f" · {a['license']}" if a["license"] else ""
    where = f" in {lib_name}" if lib_name else ""
    return f"- `{a['id']}` {a['path']} · {a['category']}{dims}{dur}{tags}{lic}{where}"


def _detail(a: dict) -> str:
    lib = get_lib(a["libId"])
    lines = [f"# {a['title'] or a['path']}", f"id `{a['id']}` · library `{a['libId']}` ({lib['name'] if lib else '?'})",
             f"path: {a['path']} · kind {a['kind']} · category {a['category']} · {a['size']:,} bytes"
             + (f" · {a['width']}×{a['height']}" if a["width"] else "") + (f" · {a['duration']}s" if a["duration"] else ""),
             f"tags: {', '.join(a['tags']) or '(none)'}", f"license: {a['license'] or '(not recorded)'} · author: {a['author'] or '(unknown)'}",
             f"source: {a['sourceUrl'] or '(none)'}", f"added by {a['addedBy']}" + (f" (scout job {a['jobId']})" if a["jobId"] else ""),
             f"run_code path: {MOUNT}/{a['libId']}/{a['path']}",
             f"URL for HTML artifacts and pages (no import needed): {file_url(a)}"]
    if a["kind"] == "font":
        lines.append(font_coverage(file_of(a)) or "font coverage: unknown")
    if a["description"]:
        lines.append(f"description: {a['description']}")
    if a["meta"]:
        lines.append("meta: " + json.dumps(a["meta"]))
    return "\n".join(lines)


def catalog(limit=15) -> str:
    libs = list_libs()
    return "\n".join(_lib_line(l) for l in libs[:limit]) + (f"\n- …and {len(libs) - limit} more" if len(libs) > limit else "")


GUIDE = ("- asset_library holds reusable asset libraries (sounds, music, textures, sprites, pictures, icons, models, fonts) "
         "shared by every chat, Studio design and Code workspace. Before generating or hunting for an asset, search here; "
         "import (lib, assets or tags, to) copies what you need into where you're working. Add good assets you make or find "
         "(add files=[…] from your working folder, or urls=[…]) with a category, tags, and the license, author and source URL. "
         "Libraries marked locked are read-only to you: fork them. dispatch sends an asset scout off to collect assets "
         f"from the web on its own. In run_code the libraries are read-only under {MOUNT}/<lib id>/ (each has a {MANIFEST}). "
         "HTML artifacts can use a library file directly at /api/assets/file/<lib id>/<path> (action=info gives the URL), "
         "or import it and use the /work path as a relative URL. For fonts, action=info shows what the font covers and "
         "action=view shows which key draws which glyph: many script fonts (Tengwar, runes) sit on ASCII keys.")


def job_of(conv_id: str | None) -> dict | None:
    if not conv_id:
        return None
    with db.conn() as c:
        r = c.execute("SELECT * FROM asset_jobs WHERE conv_id=? AND status='running'", (conv_id,)).fetchone()
    return _job(r) if r else None


# ── tool ────────────────────────────────────────────────────────────────────

def _writable(lib: dict):
    if lib["locked"]:
        raise ValueError(f"\"{lib['name']}\" is locked, so agents can't change it. Fork it (action=fork) and work on the fork, "
                         "or ask the user to unlock it on the Assets page.")


def _sources(ctx, files) -> list[tuple[Path, str]]:
    """Paths, folders or globs in the working folder → [(file, its path below the folder or the glob's fixed part)]."""
    import library
    root = library._dest_root(ctx).resolve()
    out: list[tuple[Path, str]] = []
    for f in ([files] if isinstance(files, str) else files or []):
        f = re.sub(r"^/?work/", "", str(f).strip()).lstrip("/")
        if not f:
            continue
        if any(ch in f for ch in "*?["):
            fixed = re.split(r"[*?\[]", f, 1)[0]
            base = (root / fixed.rsplit("/", 1)[0]).resolve() if "/" in fixed else root
            if not str(base).startswith(str(root)):
                raise ValueError(f"{f!r} is outside your working folder.")
            out += [(p, str(p.relative_to(base))) for p in sorted(root.glob(f))
                    if p.is_file() and ".git" not in p.parts and p.resolve().is_relative_to(root)]
        else:
            p = library._dest(ctx, f)
            if p.is_dir():
                out += [(q, str(q.relative_to(p))) for q in sorted(p.rglob("*"))
                        if q.is_file() and ".git" not in q.parts and not q.is_symlink() and q.resolve().is_relative_to(root)]
            elif p.is_file():
                out.append((p, p.name))
            else:
                raise ValueError(f"Nothing at {f!r} in your working folder.")
    seen, uniq = set(), []
    for p, rel in out:
        if p not in seen and p.name != MANIFEST:
            seen.add(p)
            uniq.append((p, rel))
    return uniq


def _fields(args: dict) -> dict:
    out = {k: args.get(k) for k in FIELDS if args.get(k)}
    if args.get("tags"):
        out["tags"] = norm_tags(args["tags"])
    if isinstance(args.get("meta"), dict):
        out["meta"] = args["meta"]
    return out


async def _add(args, ctx, lib) -> str:
    _writable(lib)
    job = job_of(ctx.conv_id)
    who = ctx.agent.get("name", "agent")
    shared = _fields(args)
    keep = bool(args.get("keep_structure"))
    folder = str(args.get("to") or "").strip().strip("/")
    # each entry: [file or None, url or None, explicit path in the library or "", path below the source folder, fields, error]
    items: list[list] = []
    for it in args.get("items") or []:
        if not isinstance(it, dict):
            continue
        f = {**shared, **_fields(it)}
        if it.get("tags") and shared.get("tags"):
            f["tags"] = norm_tags(shared["tags"] + norm_tags(it["tags"]))
        if it.get("url"):
            items.append([None, str(it["url"]), str(it.get("path") or ""), "", f, None])
        elif it.get("file"):
            for p, rel in _sources(ctx, it["file"]):
                items.append([p, None, str(it.get("path") or ""), rel, f, None])
    for p, rel in _sources(ctx, args.get("files")):
        items.append([p, None, "", rel, shared, None])
    urls = args.get("urls") or []
    for u in [urls] if isinstance(urls, str) else urls:
        items.append([None, str(u), "", "", shared, None])
    if not items:
        return "Nothing to add: pass files (paths or globs in your working folder), urls, or items."
    if len(items) > 500:
        return f"{len(items)} files is too many for one call; add at most 500 at a time."
    tmp = Path(tempfile.mkdtemp(dir=TMP))
    try:
        pending = [it for it in items if it[1]]
        if pending:
            got = await scrape.download_many([it[1] for it in pending], tmp, unpack=False)
            for it, r in zip(pending, got):
                it[4] = {**it[4], "source_url": it[4].get("source_url") or it[1]}
                if "path" in r:
                    it[0] = r["path"]
                else:
                    it[5] = f"✗ {it[1]}: {r['error']}"

        def file_all():
            done = {"added": [], "duplicate": [], "replaced": []}
            errs = []
            for p, _, explicit, rel, f, err in items:
                if err or p is None:
                    errs.append(err or "✗ nothing downloaded")
                    continue
                if explicit:
                    path = explicit if "/" in explicit else f"{folder or (f.get('category') or DEFAULT_CATEGORY.get(kind_of(p.name), 'other')).lower()}/{explicit}"
                else:
                    name = rel if keep and rel else p.name
                    path = f"{folder or (f.get('category') or DEFAULT_CATEGORY.get(kind_of(p.name), 'other')).lower()}/{name}"
                try:
                    a, st = add_file(lib["id"], p, path, f, added_by=who, job_id=job["id"] if job else None,
                                     replace=bool(args.get("replace")))
                    done[st].append(a)
                except ValueError as e:
                    errs.append(f"✗ {p.name}: {e}")
            return done, errs

        done, errs = await asyncio.to_thread(file_all)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    out = [f"Library \"{lib['name']}\" (`{lib['id']}`): added {len(done['added'])}"
           + (f", replaced {len(done['replaced'])}" if done["replaced"] else "")
           + (f", {len(done['duplicate'])} already there (same bytes; tags/metadata merged)" if done["duplicate"] else "") + "."]
    out += [_asset_line(a) for a in (done["added"] + done["replaced"])[:40]]
    if len(done["added"]) > 40:
        out.append(f"…and {len(done['added']) - 40} more")
    out += errs[:20]
    missing = [a for a in done["added"] if not a["license"]]
    if missing:
        out.append(f"{len(missing)} added asset(s) have no license recorded; set license/author/source_url with action=update.")
    return "\n".join(out)


def _pick(lib, args) -> list[dict]:
    refs = args.get("assets") or ([args["asset"]] if args.get("asset") else [])
    refs = [refs] if isinstance(refs, str) else refs
    if refs:
        return [find_asset(lib["id"], r) for r in refs]
    if args.get("tags") or args.get("query") or args.get("category") or args.get("kind"):
        return list_assets(lib["id"], str(args.get("query") or ""), args.get("tags"), str(args.get("category") or ""),
                           str(args.get("kind") or ""))
    raise ValueError("Pass assets (ids or paths), or filter by tags / query / category / kind.")


async def _import(args, ctx, lib) -> ToolResult:
    import library
    rows = _pick(lib, args)
    if not rows:
        return ToolResult("No assets match.", error=True)
    to = str(args.get("to") or "").strip().strip("/") or "assets"
    copied = []

    def copy():
        for a in rows:
            src = file_of(a)
            if not src.is_file():
                continue
            dest = library._dest(ctx, f"{to}/{a['path']}" if not args.get("flatten") else f"{to}/{Path(a['path']).name}")
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
            copied.append((a, dest))
        if args.get("credits", True) and any(a["license"] or a["author"] for a, _ in copied):
            cred = library._dest(ctx, f"{to}/CREDITS.md")
            cred.write_text(credits([a for a, _ in copied]))
            copied.append(({"path": "CREDITS.md", "license": "", "author": "", "title": "credits", "sourceUrl": ""}, cred))

    await asyncio.to_thread(copy)
    base = library._dest_root(ctx)
    rels = [str(d.relative_to(base)) for _, d in copied]
    if ctx.project_id:
        for r in rels:
            await ctx.emit({"type": "file", "path": r, "action": "created"})
    where = "this project" if ctx.project_id else "/work"
    shown = "\n".join(f"- {r}" for r in rels[:40]) + (f"\n…and {len(rels) - 40} more" if len(rels) > 40 else "")
    note = " A CREDITS.md lists their licenses and authors; keep it with the assets." if any(r.endswith("CREDITS.md") for r in rels) else ""
    if not ctx.project_id and rels:
        note += (f" HTML artifacts in this chat resolve relative URLs against /work, so use these paths as they are, "
                 f"e.g. url('{rels[0]}').")
    if any(a.get("kind") == "font" for a, _ in copied):
        note += " Before writing text in a decorative or non-Latin font, action=view it to see which key draws which glyph."
    return ToolResult(f"Copied {len([r for r in rels if not r.endswith('CREDITS.md')])} asset(s) from \"{lib['name']}\" into {where}:\n"
                      f"{shown}\n{note}".rstrip(),
                      {"file": {"path": rels[0], "action": "created"}} if ctx.project_id and rels else {})


async def asset_library(args, ctx):
    action = str(args.get("action") or "libraries").lower()
    try:
        if action == "libraries":
            libs = list_libs()
            if not libs:
                return ToolResult("There are no asset libraries yet. action=create makes one.")
            return ToolResult(f"{len(libs)} asset librar{'y' if len(libs) == 1 else 'ies'}:\n" + "\n".join(_lib_line(l) for l in libs))
        if action == "create":
            lib = create_lib(str(args.get("name") or ""), str(args.get("description") or ""), args.get("tags"),
                             str(args.get("license") or ""), created_by=ctx.agent.get("name", "agent"))
            return ToolResult(f"Created library \"{lib['name']}\" (`{lib['id']}`). Add assets with action=add lib={lib['id']}.")
        if action == "search":
            libs = {l["id"]: l["name"] for l in list_libs()}
            rows = list_assets(None, str(args.get("query") or ""), args.get("tags"), str(args.get("category") or ""),
                               str(args.get("kind") or ""))
            if not rows:
                return ToolResult("No assets match. Try fewer words, or action=libraries to browse.")
            n = int(args.get("limit") or 60)
            return ToolResult(f"{len(rows)} match(es):\n" + "\n".join(_asset_line(a, libs.get(a["libId"])) for a in rows[:n])
                              + (f"\n…and {len(rows) - n} more (narrow the search or raise limit)" if len(rows) > n else ""))
        if action == "jobs":
            return ToolResult("\n".join(f"- `{j['id']}` {j['status']} · {j['libName']} · {j['added']} added · {j['brief'][:100]}"
                                        for j in list_jobs()[:20]) or "No scout jobs yet.")
        if action == "dispatch":
            if args.get("lib"):
                lib = resolve_lib(args["lib"])
            else:
                lib = create_lib(str(args.get("name") or "")[:120] or "Scouted assets", str(args.get("description") or ""),
                                 args.get("tags"), created_by=ctx.agent.get("name", "agent"))
            _writable(lib)
            j = create_job(lib["id"], str(args.get("brief") or ""), args.get("sources") or [], str(args.get("agent") or "magpie"),
                           int(args.get("max_assets") or 40), str(args.get("license_policy") or "open"), ctx.agent.get("name", "agent"))
            return ToolResult(f"Queued scout job `{j['id']}` for \"{lib['name']}\" (`{lib['id']}`). It runs on its own in a new "
                              "chat; the Assets page shows its progress.")
        lib = resolve_lib(args.get("lib"))
        if action == "list":
            rows = list_assets(lib["id"], str(args.get("query") or ""), args.get("tags"), str(args.get("category") or ""),
                               str(args.get("kind") or ""))
            n = int(args.get("limit") or 100)
            head = _lib_line({**lib, **next((l for l in list_libs() if l["id"] == lib["id"]), {})})
            if len(lib["description"]) > 140:   # the line above shortens it; notes like a font's key layout matter here
                head += "\nAbout this library: " + lib["description"]
            return ToolResult(head + f"\n{len(rows)} asset(s)" + (" matching" if len(rows) else "") + ":\n"
                              + "\n".join(_asset_line(a) for a in rows[:n])
                              + (f"\n…and {len(rows) - n} more" if len(rows) > n else "")
                              + f"\nrun_code sees these files under {MOUNT}/{lib['id']}/")
        if action == "info":
            return ToolResult(_detail(find_asset(lib["id"], args.get("asset") or (args.get("assets") or [""])[0])))
        if action == "view":
            from studio_tools import _deliver_images
            a = find_asset(lib["id"], args.get("asset") or (args.get("assets") or [""])[0])
            if a["kind"] not in ("image", "font") and not a["path"].lower().endswith(".glb"):
                return ToolResult(f"{a['path']} is {a['kind']}, not an image: here's what's recorded.\n" + _detail(a))
            png = await asyncio.to_thread(_png_of, a)
            if not png:
                return ToolResult(f"Couldn't render {a['path']}.", error=True)
            if a["kind"] == "font":
                text, imgs = await _deliver_images(
                    ctx, [png], f"Here is a keyboard chart of the font {a['path']} from \"{lib['name']}\": each red label is "
                    "the key typed, the black glyph under it is what this font draws for that key.\n" + _detail(a),
                    f"This is a keyboard chart of the font {a['path']}: each red label is a typed key and the black glyph under it "
                    "is what the font draws. Say which writing system the glyphs are (ordinary Latin letters, decorative Latin, "
                    "Tengwar, runes, symbols…). If they aren't Latin letters, list which key draws which letter or sign.")
                return ToolResult(text, model_images=imgs)
            text, imgs = await _deliver_images(ctx, [png], f"Here is {a['path']} from the asset library \"{lib['name']}\".",
                                               f"Describe this asset ({a['path']}) for someone choosing game/design assets: subject, "
                                               "style, palette, perspective, whether it's a sprite sheet (frame grid), tileable, "
                                               "transparent background, and quality issues.")
            return ToolResult(text, model_images=imgs)
        if action == "import":
            return await _import(args, ctx, lib)
        if action == "fork":
            new = fork_lib(lib["id"], str(args.get("name") or "") or None, ctx.agent.get("name", "agent"),
                           ids=[find_asset(lib["id"], r)["id"] for r in (args.get("assets") or [])] or None)
            return ToolResult(f"Forked \"{lib['name']}\" into \"{new['name']}\" (`{new['id']}`) with "
                              f"{len(list_assets(new['id']))} assets. Change the fork freely.")
        _writable(lib)
        if action == "add":
            return ToolResult(await _add(args, ctx, lib))
        if action == "update":
            rows = _pick(lib, args)
            patch = {k: args[k] for k in (*FIELDS, "add_tags", "remove_tags", "meta", "path") if args.get(k) is not None}
            if args.get("tags") is not None and (args.get("assets") or args.get("asset")):
                patch["tags"] = args["tags"]   # with explicit assets, tags= sets the list; as a filter it only selects
            if "path" in patch and len(rows) != 1:
                return ToolResult("path renames one asset at a time.", error=True)
            if not patch:
                return ToolResult("Nothing to change: pass title, description, category, tags, add_tags, remove_tags, license, "
                                  "author, source_url, meta or path.", error=True)
            done = [update_asset(a["id"], patch) for a in rows]
            return ToolResult(f"Updated {len(done)} asset(s):\n" + "\n".join(_asset_line(a) for a in done[:40]))
        if action == "remove":
            rows = _pick(lib, args)
            for a in rows:
                delete_asset(a["id"])
            return ToolResult(f"Removed {len(rows)} asset(s) from \"{lib['name']}\".")
        if action == "edit_library":
            new = update_lib(lib["id"], {k: args.get(k) for k in ("name", "description", "tags", "license")})
            return ToolResult("Updated:\n" + _lib_line(new))
        return ToolResult("Unknown action. Use libraries, search, list, info, view, import, create, fork, add, update, remove, "
                          "edit_library, dispatch or jobs.", error=True)
    except (ValueError, OSError) as e:
        return ToolResult(str(e) or "Not found.", error=True)


def register():
    TOOLS["asset_library"] = {
        "fn": asset_library, "service": None, "scope": "global",
        "ui": {"displayName": "Asset Libraries", "icon": "Shapes", "category": "library",
               "description": "Every agent can search, view, import, add and curate reusable assets (sounds, textures, "
                              "sprites, pictures, models, fonts), fork libraries, and dispatch asset scouts."},
        "schema": _fn("asset_library",
                      "Reusable asset libraries (sounds, music, textures, sprites, tilesets, pictures, icons, models, fonts) shared "
                      "across every chat, Studio design and Code workspace. "
                      "libraries → list them; search (query, tags, category, kind) → assets in every library; list (lib, …) → one "
                      "library; info / view (lib, asset) → details / look at an image; import (lib, assets or a tags/query filter, "
                      "to) → copy into where you're working, with a CREDITS.md; create (name, description, tags); fork (lib, name); "
                      "add (lib, files=[paths or globs in your working folder] or urls=[…] or items=[{file|url, title, tags, …}], "
                      "category, tags, license, author, source_url, meta, to) → file assets; update (lib, assets, fields / "
                      "add_tags / remove_tags / meta / path); remove (lib, assets); edit_library (lib, name, description, tags, "
                      "license); dispatch (lib or name, brief, sources, max_assets) → send an asset scout to collect assets from "
                      "the web on its own; jobs → scout jobs.",
                      {"action": {"type": "string", "enum": ["libraries", "search", "list", "info", "view", "import", "create", "fork",
                                                             "add", "update", "remove", "edit_library", "dispatch", "jobs"]},
                       "lib": {"type": "string", "description": "Library id (alib-…) or name"},
                       "asset": {"type": "string", "description": "One asset: id (ast-…) or path in the library"},
                       "assets": {"type": "array", "items": {"type": "string"}, "description": "Asset ids or paths"},
                       "query": {"type": "string", "description": "Words to match in titles, paths, tags, descriptions, authors"},
                       "tags": {"type": "array", "items": {"type": "string"},
                                "description": "search/list/import: assets having all these tags; add/create: tags to set"},
                       "category": {"type": "string", "description": "One of: " + ", ".join(CATEGORIES)},
                       "kind": {"type": "string", "enum": ["image", "audio", "video", "model", "font", "data", "other"]},
                       "files": {"type": "array", "items": {"type": "string"},
                                 "description": "add: files, folders or globs in your working folder, e.g. downloads/pack/**/*.png"},
                       "urls": {"type": "array", "items": {"type": "string"}, "description": "add: file URLs to download straight into the library"},
                       "items": {"type": "array", "items": {"type": "object"},
                                 "description": "add: per-asset entries {file or url, path, title, tags, category, description, license, author, source_url, meta}"},
                       "to": {"type": "string", "description": "add: folder inside the library (default: the category); import: destination folder (default assets)"},
                       "keep_structure": {"type": "boolean", "description": "add: keep sub-folders below the glob/folder"},
                       "replace": {"type": "boolean", "description": "add: overwrite an asset at the same path"},
                       "title": {"type": "string"}, "description": {"type": "string"},
                       "license": {"type": "string", "description": "e.g. CC0, CC-BY 4.0, OGA-BY, Generated, Unknown"},
                       "author": {"type": "string"}, "source_url": {"type": "string"},
                       "meta": {"type": "object", "description": "Extra fields, e.g. {frameWidth: 32, frameHeight: 32, fps: 10} for "
                                                                 "sprite sheets, {bpm: 120, loop: true} for music; null removes a key"},
                       "add_tags": {"type": "array", "items": {"type": "string"}},
                       "remove_tags": {"type": "array", "items": {"type": "string"}},
                       "path": {"type": "string", "description": "update: new path for one asset (rename/move)"},
                       "name": {"type": "string", "description": "create/fork/edit_library/dispatch: library name"},
                       "brief": {"type": "string", "description": "dispatch: what to collect, style, quantities, formats"},
                       "sources": {"type": "array", "items": {"type": "string"}, "description": "dispatch: sites or pages to start from"},
                       "max_assets": {"type": "integer", "description": "dispatch: stop after this many (default 40)"},
                       "license_policy": {"type": "string", "enum": ["cc0", "open", "any"],
                                          "description": "dispatch: cc0 = public domain only; open = CC0/CC-BY/OGA-BY etc. (default); any = anything, recorded"},
                       "flatten": {"type": "boolean", "description": "import: drop the library's folders"},
                       "limit": {"type": "integer"}},
                      ["action"]),
    }


# ── scout jobs ──────────────────────────────────────────────────────────────

LICENSE_RULE = {
    "cc0": "Only take assets released as CC0 / public domain. Skip anything else.",
    "open": "Take assets under open licenses that allow reuse in commercial projects: CC0, public domain, CC-BY, CC-BY-SA, "
            "OGA-BY, MIT and similar. Skip non-commercial (NC), no-derivatives (ND) and unclear licenses.",
    "any": "Any license is acceptable, but record exactly what it is (\"Unknown\" if you can't find it).",
}

RUN_NOTE = """## Asset scout run
You were dispatched as an asset scout. Nobody is watching live: don't ask questions; make sensible choices and do the
whole job, then stop.

Target library: "{lib}" (`{lib_id}`). Collect at most {max_assets} assets.
{license_rule}

How to work:
1. Find candidates: web_search, then scrape action=links on promising pages (browser=true for sites that build their
   pages with JavaScript; follow the "Pages" it lists to reach download pages). Prefer dedicated asset sites and packs
   (e.g. OpenGameArt, Kenney, ambientCG, Poly Haven, Freesound previews, itch.io free packs) over random image hosts.
2. Read each asset's license and author on its page (scrape with text=true, or web_fetch). Record them.
3. Fetch with scrape action=download (zip packs are unpacked). Look before you keep, but efficiently: for more than
   a few images, use run_code to build one labelled contact sheet (PIL grid of thumbnails, small sprites scaled up with
   NEAREST, file name under each) saved in /work, then view_document that single image. Don't open images one by one.
   Use run_code to inspect sizes, durations, frame grids, or to convert/slice/trim. Drop junk, duplicates and off-brief files.
   Budget your steps: file assets as soon as you have a good batch, rather than leaving everything for the end.
4. File the keepers with asset_library action=add lib={lib_id}: a clear category ({categories}), 3-8 useful tags (subject,
   style, palette, mood, use), license, author, source_url (the page, not the CDN file) and meta where it helps
   (sprite sheets: frameWidth, frameHeight, frames, fps, and spacing/margin if frames have gaps between them; music: bpm,
   loop; textures: tileable, resolution).
   One add call can take many files with shared fields, or items=[…] with per-file fields.
5. Finish with a short report: what you added (counts by category), where it came from, licenses, and anything you skipped
   and why. Don't add the same thing twice; the library already has:
{existing}"""


def list_jobs(lid: str | None = None) -> list[dict]:
    with db.conn() as c:
        rows = c.execute("SELECT * FROM asset_jobs" + (" WHERE lib_id=?" if lid else "") + " ORDER BY created DESC LIMIT 60",
                         (lid,) if lid else ()).fetchall()
    return [_job(r) for r in rows]


def get_job(jid: str) -> dict | None:
    with db.conn() as c:
        r = c.execute("SELECT * FROM asset_jobs WHERE id=?", (jid,)).fetchone()
    return _job(r) if r else None


def create_job(lid, brief, sources, agent_id="magpie", max_assets=40, license="open", created_by="you") -> dict:
    brief = (brief or "").strip()
    if not brief:
        raise ValueError("Say what the scout should collect (brief).")
    if not get_lib(lid):
        raise ValueError("No such library.")
    with db.conn() as c:
        if c.execute("SELECT COUNT(*) FROM asset_jobs WHERE status IN ('queued','running')").fetchone()[0] >= MAX_QUEUE:
            raise ValueError(f"{MAX_QUEUE} scout jobs are already waiting; let some finish first.")
        jid = db.new_id("ajob")
        srcs = [s.strip() for s in ([sources] if isinstance(sources, str) else sources or []) for s in str(s).splitlines() if s.strip()]
        c.execute("INSERT INTO asset_jobs(id, lib_id, agent_id, brief, sources, max_assets, license, status, created_by, created) "
                  "VALUES(?,?,?,?,?,?,?,'queued',?,?)",
                  (jid, lid, agent_id or "magpie", brief[:8000], json.dumps(srcs[:40]), max(1, min(int(max_assets or 40), 500)),
                   license if license in LICENSE_RULE else "open", created_by, time.time()))
    if _wake:
        _wake.set()
    return get_job(jid)


def stop_job(jid: str) -> dict:
    j = get_job(jid)
    if not j:
        raise ValueError("No such job.")
    if j["status"] == "queued":
        with db.conn() as c:
            c.execute("UPDATE asset_jobs SET status='stopped', finished=?, error='Cancelled before it started.' WHERE id=?",
                      (time.time(), jid))
    elif j["status"] == "running" and j["convId"] and abort_turn:
        abort_turn(j["convId"])
    return get_job(jid)


def delete_job(jid: str):
    j = get_job(jid)
    if j and j["status"] == "running":
        raise ValueError("Stop the job first.")
    with db.conn() as c:
        c.execute("DELETE FROM asset_jobs WHERE id=?", (jid,))


def _message(j: dict) -> str:
    out = [f"Collect assets for the library \"{j['libName']}\".", "", j["brief"]]
    if j["sources"]:
        out += ["", "Start from these sources:"] + [f"- {s}" for s in j["sources"]]
    out += ["", f"Up to {j['maxAssets']} assets."]
    return "\n".join(out)


async def _run(j: dict):
    global _running
    lib = get_lib(j["libId"])
    now = time.time()
    if not lib:
        with db.conn() as c:
            c.execute("UPDATE asset_jobs SET status='failed', error='Its library was deleted.', finished=? WHERE id=?", (now, j["id"]))
        return
    with db.conn() as c:
        c.execute("UPDATE asset_jobs SET status='running', started=?, finished=NULL, error='' WHERE id=?", (now, j["id"]))
    _running = {"job": j["id"], "lib": j["libId"], "conv": None, "since": now * 1000}

    def on_conv(cid):
        _running["conv"] = cid
        with db.conn() as c:
            c.execute("UPDATE asset_jobs SET conv_id=? WHERE id=?", (cid, j["id"]))

    have = list_assets(lib["id"])
    existing = ("\n".join(f"   {a['path']} [{', '.join(a['tags'][:5])}]" + (f" from {a['sourceUrl']}" if a["sourceUrl"] else "")
                          for a in have[:80]) + (f"\n   …and {len(have) - 80} more (asset_library list)" if len(have) > 80 else "")
                if have else "   (nothing yet)")
    note = RUN_NOTE.format(lib=lib["name"], lib_id=lib["id"], max_assets=j["maxAssets"], license_rule=LICENSE_RULE[j["license"]],
                           categories=", ".join(CATEGORIES), existing=existing)
    status, error, text = "error", None, ""
    try:
        _, status, error, text = await runner(j, _message(j), note, on_conv)
    except Exception as e:
        error = f"{type(e).__name__}: {e}"
    finally:
        _running = None
    outcome = "done" if status == "complete" else "stopped" if status == "stopped" else "failed"
    with db.conn() as c:
        c.execute("UPDATE asset_jobs SET status=?, result=?, error=?, finished=? WHERE id=?",
                  (outcome, (text or "").strip()[-4000:], error or ("Stopped." if outcome == "stopped" else ""), time.time(), j["id"]))
    touch(lib["id"])
    if outcome != "stopped":
        import activity
        activity.post("scout", outcome, f"Asset scout: {lib['name']}", error or activity.excerpt(text), f"#/assets/{lib['id']}")


def _next() -> dict | None:
    with db.conn() as c:
        r = c.execute("SELECT * FROM asset_jobs WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
    return _job(r) if r else None


async def _worker():
    global _wake
    _wake = asyncio.Event()
    while True:
        try:
            j = _next()
            if j:
                await _run(j)
                continue
        except Exception as e:
            print(f"[assets] scout job failed: {type(e).__name__}: {e}")
            await asyncio.sleep(5)
        _wake.clear()
        try:
            await asyncio.wait_for(_wake.wait(), 30)
        except asyncio.TimeoutError:
            pass


async def _manifests():
    while True:
        await asyncio.sleep(3)
        if _dirty:
            try:
                await asyncio.to_thread(write_manifests)
            except Exception as e:
                print(f"[assets] manifest write failed: {e}")


def start():
    for fn in (_worker, _manifests):
        t = asyncio.create_task(fn())
        _TASKS.add(t)


def running_now():
    return dict(_running) if _running else None


# ── routes ──────────────────────────────────────────────────────────────────

def _err(e: Exception):
    raise HTTPException(400, str(e))


def _lib_or_404(lid) -> dict:
    lib = get_lib(lid)
    if not lib:
        raise HTTPException(404, "No such library.")
    return lib


@router.get("/libs")
def libs_list():
    return list_libs()


@router.post("/libs")
async def libs_create(req: Request):
    b = await req.json()
    try:
        return create_lib(b.get("name", ""), b.get("description", ""), b.get("tags"), b.get("license", ""))
    except ValueError as e:
        _err(e)


@router.get("/libs/{lid}")
def libs_get(lid: str):
    lib = _lib_or_404(lid)
    rows = list_assets(lid)
    tags: dict[str, int] = {}
    for a in rows:
        for t in a["tags"]:
            tags[t] = tags.get(t, 0) + 1
    fork_of = get_lib(lib["forkedFrom"]) if lib["forkedFrom"] else None
    with db.conn() as c:
        forks = [{"id": r["id"], "name": r["name"]} for r in c.execute("SELECT id, name FROM asset_libs WHERE forked_from=?", (lid,))]
    return {**lib, "assets": rows, "tagCounts": tags, "forkedFromName": fork_of["name"] if fork_of else None, "forks": forks,
            "jobs": list_jobs(lid), "mount": f"{MOUNT}/{lid}"}


@router.patch("/libs/{lid}")
async def libs_patch(lid: str, req: Request):
    _lib_or_404(lid)
    try:
        return update_lib(lid, await req.json())
    except ValueError as e:
        _err(e)


@router.delete("/libs/{lid}")
def libs_delete(lid: str):
    _lib_or_404(lid)
    if any(j["status"] == "running" for j in list_jobs(lid)):
        raise HTTPException(409, "A scout is working on this library; stop it first.")
    delete_lib(lid)
    return {"ok": True}


@router.post("/libs/{lid}/fork")
async def libs_fork(lid: str, req: Request):
    _lib_or_404(lid)
    b = await req.json()
    try:
        return await asyncio.to_thread(fork_lib, lid, b.get("name") or None, "you", b.get("ids") or None)
    except ValueError as e:
        _err(e)


@router.post("/libs/{lid}/upload")
async def libs_upload(lid: str, files: list[UploadFile] = File(...), folder: str = Form(""), tags: str = Form(""),
                      category: str = Form(""), license: str = Form(""), author: str = Form(""), source_url: str = Form(""),
                      unzip: bool = Form(True)):
    _lib_or_404(lid)
    tmp = Path(tempfile.mkdtemp(dir=TMP))
    added, dups, errors = [], 0, []
    try:
        staged: list[tuple[Path, str]] = []
        for f in files:
            name = re.sub(r"[^\w.\- ()+,]+", "_", Path(f.filename or "upload").name).strip() or "upload"
            p = scrape._unique(tmp / name)
            size = 0
            with open(p, "wb") as out:
                while chunk := await f.read(1 << 20):
                    size += len(chunk)
                    if size > FILE_LIMIT:
                        break
                    out.write(chunk)
            if size > FILE_LIMIT:
                errors.append(f"{name}: over {FILE_LIMIT // 2**20} MB")
                p.unlink(missing_ok=True)
                continue
            if unzip and scrape.is_archive(p):
                try:   # a pack keeps its own folder: <category or folder>/<pack name>/<path inside the archive>
                    got = await asyncio.to_thread(scrape.extract, p)
                    staged += [(q, str(q.relative_to(tmp))) for q in got if q.name != MANIFEST]
                except ValueError as e:
                    errors.append(f"{name}: {e}")
                continue
            staged.append((p, name))
        fields = {"tags": norm_tags(tags), "category": category, "license": license, "author": author, "source_url": source_url}
        fields = {k: v for k, v in fields.items() if v}

        def file_all():
            nonlocal dups
            for p, rel in staged:
                cat = (category or DEFAULT_CATEGORY.get(kind_of(p.name), "other")).lower()
                path = f"{folder.strip('/')}/{rel}" if folder.strip("/") else (f"{cat}/{rel}")
                try:
                    a, st = add_file(lid, p, path, fields, added_by="you", move=True)
                    if st == "duplicate":
                        dups += 1
                    else:
                        added.append(a)
                except ValueError as e:
                    errors.append(f"{p.name}: {e}")

        await asyncio.to_thread(file_all)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return {"added": added, "duplicates": dups, "errors": errors}


@router.post("/libs/{lid}/bulk")
async def libs_bulk(lid: str, req: Request):
    """Apply one change to many assets: {ids, delete} or {ids, patch: {category, addTags, removeTags, license, author, …}}."""
    _lib_or_404(lid)
    b = await req.json()
    ids = [i for i in b.get("ids") or [] if (get_asset(i) or {}).get("libId") == lid]
    try:
        if b.get("delete"):
            for i in ids:
                delete_asset(i)
            return {"deleted": len(ids)}
        if b.get("copyTo"):
            dest = _lib_or_404(b["copyTo"])
            n = 0
            for i in ids:
                a = get_asset(i)
                fields = {"title": a["title"], "description": a["description"], "category": a["category"], "tags": a["tags"],
                          "license": a["license"], "author": a["author"], "source_url": a["sourceUrl"], "meta": a["meta"]}
                _, st = add_file(dest["id"], file_of(a), a["path"], fields, added_by="you")
                n += st == "added"
            return {"copied": n}
        return {"updated": [update_asset(i, b.get("patch") or {}) for i in ids]}
    except ValueError as e:
        _err(e)


@router.patch("/items/{aid}")
async def item_patch(aid: str, req: Request):
    if not get_asset(aid):
        raise HTTPException(404)
    try:
        return update_asset(aid, await req.json())
    except ValueError as e:
        _err(e)


@router.post("/items/{aid}/replace")
async def item_replace(aid: str, file: UploadFile = File(...)):
    a = get_asset(aid)
    if not a:
        raise HTTPException(404)
    tmp = Path(tempfile.mkdtemp(dir=TMP))
    try:
        p = tmp / re.sub(r"[^\w.\- ]+", "_", Path(file.filename or "file").name)
        p.write_bytes(await file.read())
        path = a["path"] if Path(a["path"]).suffix.lower() == p.suffix.lower() else str(Path(a["path"]).with_suffix(p.suffix))
        if path != a["path"]:
            update_asset(aid, {"path": path})
        new, _ = await asyncio.to_thread(add_file, a["libId"], p, path, None, "you", None, True, True)
        return new
    except ValueError as e:
        _err(e)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@router.delete("/items/{aid}")
def item_delete(aid: str):
    delete_asset(aid)
    return {"ok": True}


ACTIVE_TYPES = (".html", ".htm", ".svg", ".xml", ".xhtml")


@router.get("/file/{lid}/{path:path}")
def item_file(lid: str, path: str, download: bool = False):
    root = lib_dir(lid).resolve()
    p = (root / path).resolve()
    if not str(p).startswith(str(root) + "/") or not p.is_file():
        raise HTTPException(404)
    if download:
        return FileResponse(p, filename=p.name)
    # artifacts and Studio pages use library files directly (fonts need CORS from their opaque-origin frames)
    headers = {"X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*"}
    if p.suffix.lower() in ACTIVE_TYPES:
        headers["Content-Security-Policy"] = "sandbox"
    return FileResponse(p, headers=headers)


@router.get("/thumb/{aid}")
async def item_thumb(aid: str):
    a = get_asset(aid)
    if not a:
        raise HTTPException(404)
    t = await asyncio.to_thread(thumb, a)
    if not t:
        raise HTTPException(404)
    headers = {"Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff"}
    if t[1] == "image/svg+xml":
        headers["Content-Security-Policy"] = "sandbox"
    return Response(t[0], media_type=t[1], headers=headers)


@router.get("/libs/{lid}/zip")
async def libs_zip(lid: str, ids: str = ""):
    lib = _lib_or_404(lid)
    rows = list_assets(lid)
    if ids:
        keep = set(ids.split(","))
        rows = [a for a in rows if a["id"] in keep]

    def build():
        fd, name = tempfile.mkstemp(dir=TMP, suffix=".zip")
        with open(fd, "wb") as fh, zipfile.ZipFile(fh, "w", zipfile.ZIP_DEFLATED) as z:
            for a in rows:
                p = file_of(a)
                if p.is_file():
                    z.write(p, a["path"], compress_type=zipfile.ZIP_STORED if a["kind"] in ("image", "audio", "video") else zipfile.ZIP_DEFLATED)
            m = manifest(lid)
            if ids:
                paths = {a["path"] for a in rows}
                m["assets"] = [x for x in m["assets"] if x["path"] in paths]
            z.writestr(MANIFEST, json.dumps(m, indent=1))
            z.writestr("CREDITS.md", credits(rows))
        return name

    name = await asyncio.to_thread(build)
    return FileResponse(name, filename=f"{slug(lib['name'])}.zip", media_type="application/zip",
                        background=BackgroundTask(lambda: Path(name).unlink(missing_ok=True)))


@router.post("/libs/{lid}/to-project")
async def libs_to_project(lid: str, req: Request):
    """Copy assets into a Studio or Code project (default folder assets/), with a CREDITS.md, and commit."""
    import projects as P
    _lib_or_404(lid)
    b = await req.json()
    pid = b.get("projectId")
    if not pid or not db.get_project(pid):
        raise HTTPException(404, "No such project.")
    rows = [a for a in (get_asset(i) for i in b.get("ids") or []) if a and a["libId"] == lid]
    folder = str(b.get("dir") or "assets").strip("/") or "assets"
    flat = bool(b.get("flatten"))

    def copy():
        out = []
        for a in rows:
            dest = P.safe_path(pid, f"{folder}/{Path(a['path']).name if flat else a['path']}")
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file_of(a), dest)
            out.append(str(dest.relative_to(P.root(pid))))
        if any(a["license"] or a["author"] for a in rows):
            cred = P.safe_path(pid, f"{folder}/CREDITS.md")
            prev = cred.read_text() if cred.exists() else ""
            new = credits(rows)
            cred.write_text(new if not prev else prev.rstrip() + "\n" + "\n".join(new.splitlines()[2:]) + "\n")
        return out

    saved = await asyncio.to_thread(copy)
    sha = await asyncio.to_thread(P.commit, pid, f"Add {len(saved)} asset(s) from the asset library")
    return {"saved": saved, "commit": sha}


@router.get("/jobs")
def jobs_list(lib: str = ""):
    return list_jobs(lib or None)


@router.post("/jobs")
async def jobs_create(req: Request):
    b = await req.json()
    try:
        lid = b.get("libId")
        if not lid:
            lid = create_lib(b.get("libName") or "Scouted assets", b.get("libDescription") or "", b.get("tags"))["id"]
        return create_job(lid, b.get("brief", ""), b.get("sources") or [], b.get("agentId") or "magpie",
                          int(b.get("maxAssets") or 40), b.get("license") or "open")
    except ValueError as e:
        _err(e)


@router.post("/jobs/{jid}/stop")
def jobs_stop(jid: str):
    try:
        return stop_job(jid)
    except ValueError as e:
        _err(e)


@router.post("/jobs/{jid}/retry")
async def jobs_retry(jid: str):  # async: _wake is an asyncio.Event the worker waits on
    j = get_job(jid)
    if not j:
        raise HTTPException(404)
    if j["status"] in ("queued", "running"):
        raise HTTPException(409, "It's already queued or running.")
    with db.conn() as c:
        c.execute("UPDATE asset_jobs SET status='queued', error='', result='', conv_id=NULL, started=NULL, finished=NULL WHERE id=?", (jid,))
    if _wake:
        _wake.set()
    return get_job(jid)


@router.delete("/jobs/{jid}")
def jobs_delete(jid: str):
    try:
        delete_job(jid)
    except ValueError as e:
        _err(e)
    return {"ok": True}


@router.get("/search")
def search(q: str = "", tags: str = "", category: str = "", kind: str = "", limit: int = 300):
    names = {l["id"]: l["name"] for l in list_libs()}
    rows = list_assets(None, q, [t for t in tags.split(",") if t], category, kind)
    return {"total": len(rows), "assets": [{**a, "libName": names.get(a["libId"], "")} for a in rows[:max(1, min(limit, 1000))]]}


@router.get("/meta")
def meta_lists():
    return {"categories": CATEGORIES, "licenses": LICENSES, "mount": MOUNT}
