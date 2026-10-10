"""Shared shelf: documents the owner puts in every guest's Codex (a guest's own work, say, for all guests to read and research).

Each guest's cell has its own Codex, so the shelf lives on the host in ~/shellb/shelf and every cell mounts it read-only
(cells._run_args, next to wiki/maps/legal). One folder per item: item.json ({id, title, author, file, version, sha256,
description, tags, source, maintainers, updatedBy}), the original file, and text.txt (its extracted text, so the cell
doesn't re-extract it).

The owner shares a Codex file entry from its page ("Share with guests", PUT /api/shelf/entries/<id>) and picks the
guests who may publish new versions (maintainers: the author, typically). A cell copies new items into its Codex
(collection "Shared", credited to the author) at boot and every SYNC_EVERY seconds, and updates them in place when the
version changes. A guest who deletes an item doesn't get it back until a new version arrives.

A maintainer publishes from the entry in their own Codex: the cell extracts the text and hands file + text to the
host broker (cells._sandbox → POST /shelf/publish). The broker knows which cell is asking from the socket, so only a
maintainer's cell gets through. The new version replaces the shelf copy and the owner's own Codex entry (the old file
is kept in ~/shellb/shelf-history), and the owner hears about it in Activity.

Host CLI: `venv/bin/python server/shelf.py add <codex entry id> --author "Name" [--maintainer guest-…]`, `list`, `remove <id>`.
"""
import asyncio
import base64
import hashlib
import json
import mimetypes
import os
import re
import shutil
import sys
import time
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile

CELL = os.environ.get("SHELLB_CELL") == "1"
CELL_ID = os.environ.get("SHELLB_CELL_ID", "")  # the guest this cell belongs to (cells._run_args)
CELL_SHELF = Path("/home/cell/shellb/shelf")
HOST_SHELF = Path.home() / "shellb" / "shelf"
HISTORY = Path.home() / "shellb" / "shelf-history"  # earlier versions, host only (not mounted into cells)
ID_RX = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
GID_RX = re.compile(r"^guest-[0-9a-f]{12}$")
COLLECTION = "Shared"
MAX_FILE = 40 * 2**20  # under the gateway's 48 MB request cap
MAX_TEXT = 3_000_000
MAX_JSON = 96 * 2**20  # base64 file + JSON-escaped text
SYNC_EVERY = 600


def root() -> Path:
    return CELL_SHELF if CELL else HOST_SHELF


def items() -> list[dict]:
    out = []
    base = root()
    if not base.is_dir():
        return out
    for d in sorted(base.iterdir()):
        try:
            it = json.loads((d / "item.json").read_text())
        except (OSError, ValueError):
            continue
        if not ID_RX.match(str(it.get("id") or "")) or it["id"] != d.name:
            continue
        f = d / Path(str(it.get("file") or "")).name
        if not it.get("file") or not f.is_file():
            continue
        out.append({**it, "dir": d, "path": f})
    return out


def _mime(name: str) -> str:
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def _clean_name(name: str) -> str:
    return re.sub(r"[^\w.\- ()]+", "_", Path(name or "file").name).strip()[:160] or "file"


# ── cell: keep this guest's Codex in step with the shelf ────────────────────

def _collection_id() -> str:
    import db
    with db.conn() as c:
        r = c.execute("SELECT id FROM codex_collections WHERE name=?", (COLLECTION,)).fetchone()
        if r:
            return r["id"]
        cid, now = db.new_id("cxc"), time.time()
        c.execute("INSERT INTO codex_collections VALUES(?,?,?,?,?,?)",
                  (cid, COLLECTION, "Shared with every guest by the owner of this Shell:B.", "", now, now))
        return cid


def _shelf_meta(it: dict) -> dict:
    """The fields of a shelved entry's meta that follow the shelf (the rest belongs to the guest's Codex)."""
    return {"shelf": it["id"], "author": str(it.get("author") or "").strip()[:80], "shelfVersion": str(it.get("version") or "1"),
            "shelfTitle": str(it.get("title") or ""), "shelfCanPublish": bool(CELL_ID) and CELL_ID in (it.get("maintainers") or []),
            "shelfUpdatedBy": str(it.get("updatedBy") or ""), "shelfUpdated": it.get("updated")}


def _place_file(eid: str, it: dict, old_file: str = ""):
    import codex
    d, f = codex._dir(eid), it["path"]
    if old_file and old_file != f.name and old_file != "text.txt":
        (d / Path(old_file).name).unlink(missing_ok=True)
    shutil.copyfile(f, d / f.name)
    if (it["dir"] / "text.txt").is_file():
        shutil.copyfile(it["dir"] / "text.txt", d / "text.txt")
    else:
        (d / "text.txt").unlink(missing_ok=True)  # codex.index extracts it again
    codex._set_meta(eid, file=f.name, size=f.stat().st_size, mime=_mime(f.name))
    codex._spawn(codex.index(eid))


def sync() -> list[str]:
    """Add new shelf items to this cell's Codex and update the ones whose version changed; returns the entry ids it
    added or replaced the file of."""
    import codex
    import db
    seen = dict(db.kv_get("shelf_seen", {}) or {})
    changed = []
    for it in items():
        sm = _shelf_meta(it)
        version = sm["shelfVersion"]
        prev = seen.get(it["id"]) or {}
        e = codex.get(prev.get("eid") or "") if prev.get("eid") else None
        if e:
            if e["meta"].get("shelfTitle") != sm["shelfTitle"] and sm["shelfTitle"]:
                with db.conn() as c:
                    c.execute("UPDATE codex_entries SET title=?, updated=? WHERE id=?", (sm["shelfTitle"][:200], time.time(), e["id"]))
            if any(e["meta"].get(k) != v for k, v in sm.items()):
                codex._set_meta(e["id"], **sm)
            if prev.get("version") != version:
                _place_file(e["id"], it, e["meta"].get("file", ""))
                changed.append(e["id"])
            elif e["meta"].get("index") == "error":  # e.g. the broker was busy last time: try again
                codex._spawn(codex.index(e["id"]))
            seen[it["id"]] = {"version": version, "eid": e["id"]}
            continue
        if prev.get("version") == version:
            continue  # removed by the guest: back only with a new version
        body = str(it.get("description") or "").strip()
        if sm["author"]:
            body = (f"By {sm['author']}.\n\n" + body).strip()
        e = codex.create({"kind": "file", "title": sm["shelfTitle"] or it["path"].stem, "body": body, "collectionId": _collection_id(),
                          "tags": list(it.get("tags") or []) + ["shared"], "meta": sm}, created_by=sm["author"] or "you")
        _place_file(e["id"], it)
        seen[it["id"]] = {"version": version, "eid": e["id"]}
        changed.append(e["id"])
    db.kv_set("shelf_seen", seen)
    return changed


_task: asyncio.Task | None = None


def start():
    """Cell startup: sync now, then every SYNC_EVERY seconds, so a new version reaches running cells too."""
    global _task

    async def loop():
        while True:
            try:
                sync()
            except Exception as e:  # noqa: BLE001
                print(f"shelf sync: {type(e).__name__}: {e}")
            await asyncio.sleep(SYNC_EVERY)
    _task = asyncio.get_running_loop().create_task(loop())


cell_router = APIRouter(prefix="/api/codex")


@cell_router.post("/entries/{eid}/publish")
async def api_publish(eid: str, file: UploadFile = File(...)):
    """A maintainer's new version of a shelved entry: extracted here, checked and stored by the host."""
    import tempfile

    import httpx

    import cell_boot
    import codex
    e = codex.get(eid)
    if not e or not e["meta"].get("shelf"):
        raise HTTPException(404, "This entry isn't shared from the shelf.")
    if not e["meta"].get("shelfCanPublish"):
        raise HTTPException(403, "Only the people the owner chose can publish new versions of this.")
    name = _clean_name(file.filename or e["meta"].get("file") or "file")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / name
        size = 0
        with path.open("wb") as fh:
            while chunk := await file.read(1 << 20):
                size += len(chunk)
                if size > MAX_FILE:
                    raise HTTPException(413, f"{name} is larger than 40 MB.")
                fh.write(chunk)
        if not size:
            raise HTTPException(400, "That file is empty.")
        text = (await codex._extract(path))[:MAX_TEXT]
        data = base64.b64encode(path.read_bytes()).decode()
    async with httpx.AsyncClient(trust_env=False, timeout=300) as cl:
        r = await cl.post(f"{cell_boot.SANDBOX_URL}/shelf/publish", json={"item": e["meta"]["shelf"], "name": name, "data": data, "text": text})
    if r.status_code != 200:
        try:
            msg = r.json().get("error") or r.text
        except ValueError:
            msg = r.text
        raise HTTPException(403 if r.status_code == 403 else 502, msg[:300])
    sync()
    return {**(codex.get(eid) or {}), "published": r.json()}


# ── host: the owner's side and the broker's ─────────────────────────────────

def _load(item_id: str) -> dict | None:
    if not ID_RX.match(item_id or ""):
        return None
    try:
        return json.loads((HOST_SHELF / item_id / "item.json").read_text())
    except (OSError, ValueError):
        return None


def _write_json(d: Path, it: dict):
    (d / "item.json").write_text(json.dumps(it, ensure_ascii=False, indent=2))


def _perms(d: Path):
    for p in [d, *d.iterdir()]:  # cells run as their own uid: world-readable, owner-writable
        p.chmod(0o755 if p.is_dir() else 0o644)


def _commit(it: dict, file_name: str, data: bytes | Path, text: str | Path | None):
    """Write a new version of an item: built in a temporary folder, then swapped in."""
    HOST_SHELF.mkdir(parents=True, exist_ok=True)
    HOST_SHELF.chmod(0o755)
    item_id = it["id"]
    tmp, old, d = HOST_SHELF / f".{item_id}.new", HOST_SHELF / f".{item_id}.old", HOST_SHELF / item_id
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    if isinstance(data, Path):
        shutil.copyfile(data, tmp / file_name)
    else:
        (tmp / file_name).write_bytes(data)
    if isinstance(text, Path):
        shutil.copyfile(text, tmp / "text.txt")
    elif text:
        (tmp / "text.txt").write_text(text)
    _write_json(tmp, it)
    _perms(tmp)
    shutil.rmtree(old, ignore_errors=True)
    if d.exists():
        d.rename(old)
    tmp.rename(d)
    shutil.rmtree(old, ignore_errors=True)


def _sha(data: bytes | Path) -> str:
    return hashlib.sha256(data.read_bytes() if isinstance(data, Path) else data).hexdigest()


def _maintainers(value) -> list[str]:
    import guests
    out = []
    for g in value or []:
        g = str(g)
        if GID_RX.match(g) and guests.get_guest(g) and g not in out:
            out.append(g)
    return out


def for_source(eid: str) -> dict | None:
    return next((it for it in items() if it.get("source") == eid), None)


def public(it: dict) -> dict:
    import guests
    out = {k: v for k, v in it.items() if k not in ("dir", "path")}
    out["maintainerNames"] = {g: (guests.get_guest(g) or {}).get("name", g) for g in it.get("maintainers") or []}
    return out


def share(eid: str, author: str | None = None, title: str = "", description: str | None = None, maintainers=None,
          item_id: str = "") -> dict:
    """Share (or re-share) an owner Codex file entry. A changed file is a new version; the rest updates in place."""
    import codex
    e = codex.get(eid, full=True)
    if not e or e["kind"] != "file" or not e["meta"].get("file"):
        raise ValueError("Only Codex files can be shared with guests.")
    src = codex._dir(eid)
    f = src / e["meta"]["file"]
    if not f.is_file():
        raise ValueError("This entry's file is missing.")
    cur = for_source(eid) or (_load(item_id) if item_id else None)
    item_id = (cur or {}).get("id") or item_id or _slug(title or e["title"])
    if not ID_RX.match(item_id):
        raise ValueError(f"bad shelf id {item_id!r}")
    if not cur and _load(item_id):
        item_id = f"{item_id[:50]}-{eid[3:9]}"
    cur = {k: v for k, v in (cur or {}).items() if k not in ("dir", "path")}
    it = {**cur, "id": item_id, "title": (title or cur.get("title") or e["title"]).strip()[:200],
          "author": (author if author is not None else cur.get("author", "")).strip()[:80],
          "description": (description if description is not None else cur.get("description", "")).strip()[:4000],
          "tags": [t for t in e["tags"] if t != "shared"], "source": eid,
          "maintainers": _maintainers(maintainers if maintainers is not None else cur.get("maintainers"))}
    sha = _sha(f)
    if cur and cur.get("sha256") == sha and cur.get("file") == f.name:
        _write_json(HOST_SHELF / item_id, it)  # same file: details only, no new version
        _perms(HOST_SHELF / item_id)
    else:
        it.update(file=f.name, sha256=sha, version=str(int(cur.get("version") or 0) + 1), updated=time.time(), updatedBy="")
        _commit(it, f.name, f, src / "text.txt" if (src / "text.txt").is_file() else None)
    codex._set_meta(eid, sharedShelf=item_id)
    return it


def unshare(item_id: str):
    import codex
    it = _load(item_id)
    if not it:
        raise ValueError("Not on the shelf.")
    shutil.rmtree(HOST_SHELF / item_id)
    if it.get("source") and codex.get(it["source"]):
        codex._set_meta(it["source"], sharedShelf=None)


def publish(gid: str, body: dict) -> dict:
    """A new version from a maintainer's cell (cells._sandbox). `gid` comes from the broker socket, not the request."""
    import activity
    import codex
    import guests
    it = _load(str(body.get("item") or ""))
    if not it:
        raise ValueError("That isn't on the shelf any more.")
    if gid not in (it.get("maintainers") or []):
        raise ValueError("Only the people the owner chose can publish new versions of this.")
    try:
        data = base64.b64decode(str(body.get("data") or ""), validate=True)
    except ValueError:
        raise ValueError("send the file as base64")
    if not data or len(data) > MAX_FILE:
        raise ValueError("The file is empty or larger than 40 MB.")
    name = _clean_name(str(body.get("name") or it["file"]))
    text = str(body.get("text") or "")[:MAX_TEXT]
    sha = _sha(data)
    if sha == it.get("sha256"):
        return {"version": it["version"], "unchanged": True}
    who = (guests.get_guest(gid) or {}).get("name") or "A guest"
    old = HOST_SHELF / it["id"] / it["file"]
    if old.is_file():  # keep the version being replaced
        h = HISTORY / it["id"] / f"v{it.get('version', '1')}"
        h.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(old, h / old.name)
    it.update(file=name, sha256=sha, version=str(int(it.get("version") or 0) + 1), updated=time.time(), updatedBy=who)
    _commit(it, name, data, text)
    src = it.get("source")
    if src and codex.get(src):  # the owner's own copy follows
        d = codex._dir(src)
        prev = codex.get(src)["meta"].get("file", "")
        if prev and prev != name:
            (d / Path(prev).name).unlink(missing_ok=True)
        (d / name).write_bytes(data)
        if text:
            (d / "text.txt").write_text(text)
        else:
            (d / "text.txt").unlink(missing_ok=True)
        codex._set_meta(src, file=name, size=len(data), mime=_mime(name), shelfUpdatedBy=who, shelfVersion=it["version"])
        codex._spawn(codex.index(src))
    activity.post("guest", "done", f"{who} published version {it['version']} of “{it['title']}”",
                  body="Every guest's Codex gets it within a few minutes; the previous file is in ~/shellb/shelf-history.",
                  link=f"#/codex/e/{src}" if src else "", ref=f"shelf:{it['id']}:{it['version']}")
    return {"version": it["version"]}


router = APIRouter(prefix="/api/shelf")


def _owner(req: Request):
    import auth
    if not (auth.is_owner(req) or auth.is_admin(req)):  # sharing publishes to every guest
        raise HTTPException(401, "login-required")


@router.get("")
def api_list(req: Request):
    import guests
    _owner(req)
    return {"items": [public(it) for it in items()], "guests": [{"id": g["id"], "name": g["name"]} for g in guests.list_guests()]}


@router.put("/entries/{eid}")
async def api_share(eid: str, req: Request):
    _owner(req)
    body = await req.json()
    try:
        it = share(eid, author=body.get("author"), title=body.get("title") or "", description=body.get("description"),
                   maintainers=body.get("maintainers"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return public(it)


@router.delete("/items/{item_id}")
def api_unshare(item_id: str, req: Request):
    _owner(req)
    try:
        unshare(item_id)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"ok": True}


def _slug(text: str) -> str:
    import unicodedata
    s = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:64] or "item"


def main(argv: list[str]):
    import argparse
    p = argparse.ArgumentParser(prog="shelf.py", description="The shared shelf every guest's Codex gets.")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add", help="share (or update) an owner Codex file entry")
    a.add_argument("eid")
    a.add_argument("--author")
    a.add_argument("--id", default="")
    a.add_argument("--title", default="")
    a.add_argument("--description")
    a.add_argument("--maintainer", action="append", help="a guest id who may publish new versions (repeatable)")
    sub.add_parser("list")
    r = sub.add_parser("remove")
    r.add_argument("id")
    args = p.parse_args(argv)
    import codex
    codex.init()
    if args.cmd == "add":
        it = share(args.eid, args.author, args.title, args.description, args.maintainer, args.id)
        print(json.dumps(it, ensure_ascii=False, indent=2))
    elif args.cmd == "list":
        for it in items():
            print(f"{it['id']}  v{it.get('version')}  {it.get('title')}  — {it.get('author') or '?'}  ({it['path'].name})"
                  f"  maintainers: {', '.join(it.get('maintainers') or []) or 'none'}")
    elif args.cmd == "remove":
        unshare(args.id)
        print(f"removed {args.id} (guests who already have it keep their copy)")


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main(sys.argv[1:])
