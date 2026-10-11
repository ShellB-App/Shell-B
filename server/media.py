"""Media: one gallery of everything Shell:B has generated. Shown in Library → Media (#/library/media).

Generation tools (generate_image, generate_music, generate_sfx, generate_voice, generate_sprite, generate_texture,
generate_3d, image edits…) all hand back their output in the tool result's display: images / audio / model URLs plus
the prompt. `record` is called by the agent loop for every tool result and files whatever carries a prompt, with the
chat, agent and project it came from. That rule leaves out run_code plots and screenshots, which have no prompt.
Notebook Audio Overviews are filed when they finish (notebook._notify).

Files live where the tools put them (data/files, a Studio/Code project, a notebook); this table only points at
them. Rows whose file has gone (deleted from a project, say) are skipped when listing. Hiding a row never deletes
the file, which may be part of a project.
"""
import json
import re
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

import db

router = APIRouter(prefix="/api/media")
FILES = db.DATA / "files"
IMAGE = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp"}
AUDIO = {".wav", ".mp3", ".ogg", ".flac", ".m4a", ".opus"}
MODEL = {".glb", ".gltf", ".obj", ".fbx", ".stl"}


def init():
    with db.conn() as c:
        c.executescript("""
CREATE TABLE IF NOT EXISTS media(
  id TEXT PRIMARY KEY, url TEXT UNIQUE, kind TEXT, tool TEXT, prompt TEXT, conv_id TEXT, agent_id TEXT,
  project_id TEXT, meta TEXT, created REAL, hidden INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS media_created ON media(created);
""")
    if not db.kv_get("media_backfilled"):
        try:
            _backfill()
            db.kv_set("media_backfilled", time.time())
        except Exception as e:  # noqa: BLE001 — a failed backfill must not stop the server
            print(f"media backfill failed: {type(e).__name__}: {e}")


def _kind(url: str) -> str | None:
    ext = Path(url.split("?")[0]).suffix.lower()
    return "image" if ext in IMAGE else "audio" if ext in AUDIO else "model" if ext in MODEL else None


def _insert(c, url, kind, tool, prompt, conv, agent, project, meta, created):
    c.execute("INSERT OR IGNORE INTO media VALUES(?,?,?,?,?,?,?,?,?,?,0)",
              (db.new_id("med"), url, kind, tool, (prompt or "")[:2000], conv, agent, project, json.dumps(meta or {}), created))


def _rows_from(tool: str, display: dict) -> list[tuple[str, str, dict]]:
    """(url, kind, meta) for each piece of generated media in a tool result's display."""
    if not isinstance(display, dict) or not display.get("prompt"):
        return []
    out = []
    if display.get("model"):  # a 3D model: its renders are its preview, not separate pictures
        out.append((display["model"], "model", {"previews": [u for u in display.get("images") or [] if isinstance(u, str)][:4]}))
    else:
        for u in display.get("images") or []:
            if isinstance(u, str):
                out.append((u, "image", {}))
    for u in display.get("audio") or []:
        if isinstance(u, str):
            out.append((u, "audio", {"audioInfo": display.get("audioInfo") or {}}))
    return out


def record(tool: str, display: dict, conv_id=None, agent_id=None, project_id=None):
    """Called by the agent loop after every tool result. Never raises."""
    try:
        rows = _rows_from(tool, display)
        if not rows:
            return
        import privacy
        if privacy.is_hidden(conv_id):  # incognito chats leave nothing behind in the gallery
            return
        now = time.time()
        with db.conn() as c:
            for url, kind, meta in rows:
                _insert(c, url, kind, tool, display["prompt"], conv_id, agent_id, project_id, meta, now)
    except Exception as e:  # noqa: BLE001
        print(f"media.record failed: {type(e).__name__}: {e}")


def record_notebook_audio(bid: str, iid: str, title: str):
    try:
        with db.conn() as c:
            _insert(c, f"/api/research/{bid}/outputs/{iid}/audio", "audio", "audio_overview", title, None, None, None,
                    {"board": bid, "item": iid}, time.time())
    except Exception as e:  # noqa: BLE001
        print(f"media.record_notebook_audio failed: {e}")


def _backfill():
    """First run: file what earlier chats generated, notebook Audio Overviews, and loose files in data/files."""
    with db.conn() as c:
        msgs = c.execute("SELECT m.conv_id, m.data, m.created, v.project_id FROM messages m "
                         "LEFT JOIN conversations v ON v.id=m.conv_id WHERE m.role='assistant' AND m.data LIKE '%\"prompt\"%'").fetchall()
        for m in msgs:
            try:
                d = json.loads(m["data"] or "{}")
            except ValueError:
                continue

            def walk(blocks, agent):
                for b in blocks or []:
                    if b.get("type") == "tool":
                        for url, kind, meta in _rows_from(b.get("name", ""), b.get("display") or {}):
                            _insert(c, url, kind, b.get("name"), b["display"]["prompt"], m["conv_id"], b.get("agentId") or agent,
                                    m["project_id"], meta, (b.get("startedAt") or m["created"] * 1000) / 1000)
                        walk(b.get("children"), b.get("agentId") or agent)
            walk(d.get("blocks"), d.get("agentId"))
        for r in c.execute("SELECT id, board_id, title, meta, created FROM research_items WHERE kind='output'").fetchall():
            meta = json.loads(r["meta"] or "{}")
            if meta.get("type") == "audio" and meta.get("audio"):
                _insert(c, f"/api/research/{r['board_id']}/outputs/{r['id']}/audio", "audio", "audio_overview", r["title"],
                        None, None, None, {"board": r["board_id"], "item": r["id"]}, r["created"])
        if FILES.exists():
            for p in FILES.iterdir():
                k = _kind(p.name)
                if p.is_file() and k:
                    _insert(c, f"/api/files/{p.name}", k, "", "", None, None, None, {}, p.stat().st_mtime)


def _path(url: str) -> Path | None:
    """The file behind a media URL, or None if it can't be resolved to one."""
    if url.startswith("/api/files/"):
        return FILES / Path(url[len("/api/files/"):]).name
    m = re.match(r"^/api/projects/([\w-]+)/raw/(.+)$", url)
    if m:
        root = (db.DATA / "projects" / m.group(1)).resolve()
        p = (root / m.group(2)).resolve()
        return p if str(p).startswith(str(root) + "/") else None
    m = re.match(r"^/api/research/([\w-]+)/outputs/([\w-]+)/audio$", url)
    if m:
        import notebook
        import research
        it = research.get_item(m.group(2))
        a = (it or {}).get("meta", {}).get("audio")
        return notebook._bdir(m.group(1)) / "audio" / Path(a).name if a else None
    return None


# ── HTTP ────────────────────────────────────────────────────────────────────

@router.get("")
def api_list(kind: str = "", q: str = "", source: str = "", limit: int = 300):
    where, args = ["hidden=0"], []
    if kind in ("image", "audio", "model"):
        where.append("kind=?"); args.append(kind)
    if q.strip():
        where.append("(prompt LIKE ? OR tool LIKE ?)"); args += [f"%{q.strip()}%"] * 2
    if source == "notebook":
        where.append("tool='audio_overview'")
    elif source == "project":
        where.append("project_id IS NOT NULL")
    elif source == "chat":
        where.append("project_id IS NULL AND tool<>'audio_overview'")
    with db.conn() as c:
        rows = c.execute(f"SELECT * FROM media WHERE {' AND '.join(where)} ORDER BY created DESC LIMIT ?",
                         (*args, max(1, min(limit, 1000)))).fetchall()
        convs = {r["id"]: r["title"] for r in c.execute("SELECT id, title FROM conversations")}
        projs = {r["id"]: (r["name"], r["kind"]) for r in c.execute("SELECT id, name, kind FROM projects")}
        boards = {r["id"]: r["title"] for r in c.execute("SELECT id, title FROM research_boards")}
        counts = {r["kind"]: r["n"] for r in c.execute("SELECT kind, count(*) n FROM media WHERE hidden=0 GROUP BY kind")}
    out = []
    for r in rows:
        p = _path(r["url"])
        if p is None or not p.exists():
            continue
        meta = json.loads(r["meta"] or "{}")
        out.append({"id": r["id"], "url": r["url"], "kind": r["kind"], "tool": r["tool"] or "", "prompt": r["prompt"] or "",
                    "convId": r["conv_id"], "convTitle": convs.get(r["conv_id"], "") if r["conv_id"] else "",
                    "agentId": r["agent_id"], "projectId": r["project_id"], "projectName": projs.get(r["project_id"], ("", ""))[0],
                    "projectKind": projs.get(r["project_id"], ("", ""))[1],
                    "boardId": meta.get("board"), "boardTitle": boards.get(meta.get("board"), ""),
                    "name": p.name, "size": p.stat().st_size, "meta": meta, "createdAt": r["created"] * 1000})
    return {"items": out, "counts": counts}


@router.post("/{mid}/hide")
def api_hide(mid: str):
    with db.conn() as c:
        c.execute("UPDATE media SET hidden=1 WHERE id=?", (mid,))
    return {"ok": True}


@router.post("/{mid}/to-assets")
async def api_to_assets(mid: str, req: Request):
    """Copies the file into an asset library, with the prompt as its description."""
    import assets
    b = await req.json()
    with db.conn() as c:
        r = c.execute("SELECT * FROM media WHERE id=?", (mid,)).fetchone()
    if not r:
        raise HTTPException(404, "No such media.")
    p = _path(r["url"])
    if not p or not p.exists():
        raise HTTPException(404, "The file is gone.")
    lib = assets.get_lib(str(b.get("libId") or ""))
    if not lib:
        raise HTTPException(404, "No such asset library.")
    if lib.get("locked"):
        raise HTTPException(400, "That library is locked.")
    folder = {"image": "pictures", "audio": "sounds", "model": "models"}.get(r["kind"], "media")
    try:
        asset, status = assets.add_file(lib["id"], p, f"{folder}/{p.name}", {
            "title": " ".join((r["prompt"] or "").split())[:80], "description": r["prompt"] or "", "tags": ["generated"], "license": "own work",
            "author": "Shell:B", "meta": {"tool": r["tool"], "prompt": r["prompt"]}}, added_by="you")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"asset": asset, "status": status, "lib": {"id": lib["id"], "name": lib["name"]}}
