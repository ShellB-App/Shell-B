"""Shared shelf: documents the owner puts in every guest's Codex (a guest's own work, say, for all guests to read and research).

Each guest's cell has its own Codex, so the shelf lives on the host in ~/shellb/shelf and every cell mounts it read-only
(cells._run_args, next to wiki/maps/legal). One folder per item: item.json ({id, title, author, file, version,
description, tags}), the original file, and text.txt (its extracted text, so the cell doesn't re-extract it).

At boot a cell copies new or updated items into its Codex (collection "Shared", credited to the author) and indexes
them, so agents find them with the `codex` tool and the guest can read or download them on the Codex page. A guest
who deletes an item doesn't get it back until the owner publishes a new version.

Host side: `venv/bin/python server/shelf.py add <codex entry id> --author "Name"` shelves an owner Codex file entry;
`list` and `remove <id>` manage the shelf. Running cells pick changes up when they next start.
"""
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

CELL_SHELF = Path("/home/cell/shellb/shelf")
HOST_SHELF = Path.home() / "shellb" / "shelf"
ID_RX = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
COLLECTION = "Shared"


def root() -> Path:
    return CELL_SHELF if os.environ.get("SHELLB_CELL") == "1" else HOST_SHELF


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


# ── cell: copy the shelf into this guest's Codex ────────────────────────────

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


def sync() -> list[str]:
    """Add new or updated shelf items to this cell's Codex; returns the entry ids it (re)created."""
    import mimetypes

    import codex
    import db
    seen = dict(db.kv_get("shelf_seen", {}) or {})
    added = []
    for it in items():
        version = str(it.get("version") or "1")
        prev = seen.get(it["id"]) or {}
        if prev.get("version") == version:  # already here, or removed by the guest
            e = codex.get(prev.get("eid") or "")
            if e and e["meta"].get("index") == "error":  # e.g. the broker was busy last boot: try again
                codex._spawn(codex.index(e["id"]))
            continue
        if prev.get("eid") and codex.get(prev["eid"]):
            codex.delete(prev["eid"])
        author = str(it.get("author") or "").strip()[:80]
        body = str(it.get("description") or "").strip()
        if author:
            body = (f"By {author}.\n\n" + body).strip()
        f = it["path"]
        e = codex.create({"kind": "file", "title": it.get("title") or f.stem, "body": body, "collectionId": _collection_id(),
                          "tags": list(it.get("tags") or []) + ["shared"],
                          "meta": {"file": f.name, "size": f.stat().st_size,
                                   "mime": mimetypes.guess_type(f.name)[0] or "application/octet-stream",
                                   "shelf": it["id"], "author": author}},
                         created_by=author or "you")
        d = codex._dir(e["id"])
        shutil.copyfile(f, d / f.name)
        if (it["dir"] / "text.txt").is_file():
            shutil.copyfile(it["dir"] / "text.txt", d / "text.txt")
        codex._spawn(codex.index(e["id"]))
        seen[it["id"]] = {"version": version, "eid": e["id"]}
        added.append(e["id"])
    db.kv_set("shelf_seen", seen)
    return added


# ── host: manage the shelf ──────────────────────────────────────────────────

def _slug(text: str) -> str:
    import unicodedata
    s = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:64] or "item"


def add(eid: str, author: str = "", item_id: str = "", description: str = "", title: str = "") -> dict:
    """Shelve an owner Codex file entry (copies the original and its extracted text); re-adding bumps the version."""
    import codex
    codex.init()
    e = codex.get(eid, full=True)
    if not e or e["kind"] != "file" or not e["meta"].get("file"):
        raise SystemExit(f"{eid}: not a Codex file entry")
    src = codex._dir(eid)
    item_id = item_id or _slug(e["title"])
    if not ID_RX.match(item_id):
        raise SystemExit(f"bad shelf id {item_id!r}")
    d = HOST_SHELF / item_id
    old = {}
    if (d / "item.json").exists():
        old = json.loads((d / "item.json").read_text())
    tmp = HOST_SHELF / f".{item_id}.new"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    shutil.copyfile(src / e["meta"]["file"], tmp / e["meta"]["file"])
    if (src / "text.txt").exists():
        shutil.copyfile(src / "text.txt", tmp / "text.txt")
    it = {"id": item_id, "title": title or old.get("title") or e["title"], "author": author or old.get("author", ""), "file": e["meta"]["file"],
          "version": str(int(old.get("version", "0")) + 1), "description": description or old.get("description", ""),
          "tags": [t for t in e["tags"] if t != "shared"], "source": eid, "updated": time.time()}
    (tmp / "item.json").write_text(json.dumps(it, ensure_ascii=False, indent=2))
    for p in [tmp, *tmp.iterdir()]:  # cells run as their own uid: world-readable, owner-writable
        p.chmod(0o755 if p.is_dir() else 0o644)
    shutil.rmtree(d, ignore_errors=True)
    tmp.rename(d)
    HOST_SHELF.chmod(0o755)
    return it


def main(argv: list[str]):
    import argparse
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    p = argparse.ArgumentParser(prog="shelf.py", description="The shared shelf every guest's Codex gets.")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add", help="shelve (or update) an owner Codex file entry")
    a.add_argument("eid")
    a.add_argument("--author", default="")
    a.add_argument("--id", default="")
    a.add_argument("--description", default="")
    a.add_argument("--title", default="")
    sub.add_parser("list")
    r = sub.add_parser("remove")
    r.add_argument("id")
    args = p.parse_args(argv)
    if args.cmd == "add":
        print(json.dumps(add(args.eid, args.author, args.id, args.description, args.title), ensure_ascii=False, indent=2))
    elif args.cmd == "list":
        for it in items():
            print(f"{it['id']}  v{it.get('version')}  {it.get('title')}  — {it.get('author') or '?'}  ({it['path'].name})")
    elif args.cmd == "remove":
        if not ID_RX.match(args.id):
            raise SystemExit("bad id")
        shutil.rmtree(HOST_SHELF / args.id)
        print(f"removed {args.id} (guests who already have it keep their copy)")


if __name__ == "__main__":
    main(sys.argv[1:])
