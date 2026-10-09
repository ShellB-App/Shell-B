"""Notes for Shell:B Guest: each guest's own Markdown notes, kept in guest_notes (never the owner's Codex).

The guest app (guest_app.py) mounts this router at the Codex paths the Notes page already calls (/api/codex,
/api/codex/entries…, /api/codex/notes/titles), so ui/src/components/Notes.tsx works unchanged. Only notes exist here:
no collections, links, files, contacts, events or secrets. Each call checks the guest's session and reaches only that
guest's rows. [[Title]] links, backlinks and relinking after a rename follow codex.py's rules (codex.WIKI).
"""
import json
import re
import time

from fastapi import APIRouter, HTTPException, Request

import codex
import db
import guests

router = APIRouter(prefix="/api/codex")

MAX_NOTES = 2000
MAX_BODY = 500_000
MAX_TAGS = 20


def init():
    with db.conn() as c:
        c.executescript("""
CREATE TABLE IF NOT EXISTS guest_notes(
  id TEXT PRIMARY KEY, guest_id TEXT, title TEXT, body TEXT, tags TEXT DEFAULT '[]', pinned INTEGER DEFAULT 0,
  draft INTEGER DEFAULT 0, created REAL, updated REAL);
CREATE INDEX IF NOT EXISTS guest_notes_guest ON guest_notes(guest_id, updated);
""")


def _tags(v) -> list[str]:
    tags = v if isinstance(v, list) else []
    out = []
    for t in tags:
        t = " ".join(str(t).split())[:40]
        if t and t not in out:
            out.append(t)
    return out[:MAX_TAGS]


def _entry(r, full=False) -> dict:
    """The CodexEntry shape the Notes page reads."""
    body = r["body"] or ""
    e = {"id": r["id"], "collectionId": None, "kind": "note", "title": r["title"] or "Untitled", "url": "", "language": "",
         "tags": json.loads(r["tags"] or "[]"), "pinned": bool(r["pinned"]), "draft": bool(r["draft"]), "meta": {},
         "createdBy": "you", "createdAt": r["created"] * 1000, "updatedAt": r["updated"] * 1000}
    if full:
        e["body"], e["text"] = body, ""
    else:
        plain = re.sub(r"[#*_`>|]+", "", re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", codex._unwiki(body)))
        e["preview"] = " ".join(plain.split())[:240]
    return e


def _row(gid: str, nid: str):
    with db.conn() as c:
        r = c.execute("SELECT * FROM guest_notes WHERE id=? AND guest_id=?", (nid, gid)).fetchone()
    if not r:
        raise HTTPException(404, "No such note.")
    return r


def _update(gid: str, nid: str, b: dict) -> dict:
    r = _row(gid, nid)
    title = " ".join(str(b["title"]).split())[:200] if "title" in b else r["title"]
    body = str(b["body"])[:MAX_BODY] if "body" in b else r["body"]
    tags = json.dumps(_tags(b["tags"])) if "tags" in b else r["tags"]
    pinned = int(bool(b["pinned"])) if "pinned" in b else r["pinned"]
    draft = int(bool(b["draft"])) if "draft" in b else r["draft"]
    with db.conn() as c:
        c.execute("UPDATE guest_notes SET title=?, body=?, tags=?, pinned=?, draft=?, updated=? WHERE id=? AND guest_id=?",
                  (title or "Untitled", body, tags, pinned, draft, time.time(), nid, gid))
    return _entry(_row(gid, nid), full=True)


def wipe(gid: str):
    with db.conn() as c:
        c.execute("DELETE FROM guest_notes WHERE guest_id=?", (gid,))


@router.get("")
def index(req: Request):
    g = guests.require(req)
    with db.conn() as c:
        rows = c.execute("SELECT pinned, draft, tags FROM guest_notes WHERE guest_id=?", (g["id"],)).fetchall()
    tags: dict[str, int] = {}
    for r in rows:
        for t in json.loads(r["tags"] or "[]"):
            tags[t] = tags.get(t, 0) + 1
    return {"collections": [],
            "counts": {"all": len(rows), "drafts": sum(r["draft"] for r in rows), "pinned": sum(r["pinned"] for r in rows),
                       "unfiled": len(rows)},
            "tags": sorted(tags.items(), key=lambda kv: (-kv[1], kv[0]))[:60]}


@router.get("/notes/titles")
def titles(req: Request):
    g = guests.require(req)
    with db.conn() as c:
        rows = c.execute("SELECT id, title FROM guest_notes WHERE guest_id=? ORDER BY updated DESC", (g["id"],)).fetchall()
    return [{"id": r["id"], "title": r["title"] or "Untitled"} for r in rows]


@router.get("/entries")
def entries(req: Request, kind: str = "", tag: str = "", q: str = "", view: str = ""):
    g = guests.require(req)
    if kind and kind != "note":
        return []
    sql, args = "SELECT * FROM guest_notes WHERE guest_id=?", [g["id"]]
    if q.strip():
        like = f"%{q.strip()}%"
        sql += " AND (title LIKE ? OR body LIKE ?)"
        args += [like, like]
    if view == "pinned":
        sql += " AND pinned=1"
    elif view == "drafts":
        sql += " AND draft=1"
    with db.conn() as c:
        rows = c.execute(sql + " ORDER BY pinned DESC, updated DESC LIMIT 500", args).fetchall()
    out = [_entry(r) for r in rows]
    return [e for e in out if tag in e["tags"]] if tag else out


@router.post("/entries")
async def create(req: Request):
    g = guests.require(req)
    b = await req.json()
    if b.get("kind", "note") != "note":
        raise HTTPException(400, "Only notes here.")
    with db.conn() as c:
        if c.execute("SELECT count(*) FROM guest_notes WHERE guest_id=?", (g["id"],)).fetchone()[0] >= MAX_NOTES:
            raise HTTPException(429, f"That's {MAX_NOTES} notes: delete some first.")
        nid, now = db.new_id("gnote"), time.time()
        c.execute("INSERT INTO guest_notes VALUES(?,?,?,?,?,?,?,?,?)",
                  (nid, g["id"], " ".join(str(b.get("title") or "").split())[:200] or "Untitled",
                   str(b.get("body") or "")[:MAX_BODY], json.dumps(_tags(b.get("tags"))), int(bool(b.get("pinned"))),
                   int(bool(b.get("draft"))), now, now))
    return _entry(_row(g["id"], nid), full=True)


@router.get("/entries/{nid}")
def entry(nid: str, req: Request):
    return _entry(_row(guests.require(req)["id"], nid), full=True)


@router.patch("/entries/{nid}")
async def patch(nid: str, req: Request):
    g = guests.require(req)
    return _update(g["id"], nid, await req.json())


@router.delete("/entries/{nid}")
def delete(nid: str, req: Request):
    g = guests.require(req)
    with db.conn() as c:
        c.execute("DELETE FROM guest_notes WHERE id=? AND guest_id=?", (nid, g["id"]))
    return {"ok": True}


@router.get("/entries/{nid}/backlinks")
def backlinks(nid: str, req: Request):
    g = guests.require(req)
    want = (_row(g["id"], nid)["title"] or "").strip().lower()
    with db.conn() as c:
        rows = c.execute("SELECT * FROM guest_notes WHERE guest_id=? AND id<>? AND body LIKE '%[[%' ORDER BY updated DESC",
                         (g["id"], nid)).fetchall()
    out = []
    for r in rows:
        body = r["body"] or ""
        if want not in codex.wiki_targets(body):
            continue
        line = next((ln.strip() for ln in body.splitlines()
                     if any(m.group(1).strip().lower() == want for m in codex.WIKI.finditer(ln))), "")
        out.append({"id": r["id"], "title": r["title"] or "Untitled", "line": line[:240], "updatedAt": r["updated"] * 1000})
    return out


@router.post("/entries/{nid}/relink")
async def relink(nid: str, req: Request):
    """After a rename, points [[old]] links in this guest's other notes at the new title (codex.relink's rules)."""
    g = guests.require(req)
    b = await req.json()
    r = _row(g["id"], nid)
    old, new = str(b.get("from") or "").strip(), str(b.get("to") or r["title"] or "").strip()
    if not old or not new or old.lower() == new.lower():
        return {"updated": []}
    with db.conn() as c:
        clash = c.execute("SELECT title FROM guest_notes WHERE guest_id=? AND id<>? AND lower(trim(title)) IN (?, ?)",
                          (g["id"], nid, old.lower(), new.lower())).fetchone()
        rows = c.execute("SELECT id, title, body FROM guest_notes WHERE guest_id=? AND id<>? AND body LIKE '%[[%'",
                         (g["id"], nid)).fetchall()
    if clash:
        return {"updated": [], "skipped": f"another note is called {clash['title']}"}

    def fix(m):
        if m.group(1).strip().lower() != old.lower():
            return m.group(0)
        return f"[[{new}{m.group(0)[2 + len(m.group(1)):-2]}]]"

    updated = []
    for row in rows:
        parts = re.split(f"({codex._CODE.pattern})", row["body"] or "", flags=re.S)
        body = "".join(p if i % 2 else codex.WIKI.sub(fix, p) for i, p in enumerate(parts))
        if body != row["body"]:
            _update(g["id"], row["id"], {"body": body})
            updated.append({"id": row["id"], "title": row["title"] or "Untitled"})
    return {"updated": updated}
