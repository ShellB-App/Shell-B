"""Projects for chats ("groups" internally, so they don't collide with Studio's design projects).

A project groups conversations and gives them shared context:
- instructions added to every chat's system prompt
- knowledge files (PDF, Word, Excel, PowerPoint, text, code…): inlined into the prompt when small, otherwise searched
  semantically with the memory embedding model; also mounted read-only at /project in the code sandbox
- its chats can read each other (project_read_chat), and their artifacts show on the project page
Files live in data/groups/<id>/files; extracted text and the chunk index sit beside them.
"""
import asyncio
import json
import re
import shutil
import time
from pathlib import Path

import numpy as np
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

import db
from tools import TOOLS, ToolResult, _fn, embed

GROUPS = db.DATA / "groups"
GROUPS.mkdir(exist_ok=True)
INLINE_LIMIT = 40_000      # characters of knowledge put straight into the system prompt
CHUNK, OVERLAP = 1600, 200
MAX_FILE = 100 * 1024 * 1024
TEXT_EXT = {".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".html", ".htm", ".css", ".js",
            ".ts", ".tsx", ".jsx", ".py", ".c", ".h", ".cpp", ".hpp", ".cs", ".java", ".kt", ".go", ".rs", ".rb", ".php",
            ".sh", ".bat", ".ps1", ".sql", ".ini", ".cfg", ".toml", ".log", ".qml", ".cmake", ".tex", ".rst", ".srt", ".svg"}

router = APIRouter()
_TASKS: set = set()


# ── storage ─────────────────────────────────────────────────────────────────

def _row(r, counts=None):
    out = {"id": r["id"], "name": r["name"], "description": r["description"] or "", "instructions": r["instructions"] or "",
           "emoji": r["emoji"] or "", "color": r["color"] or "", "pinned": bool(r["pinned"]),
           "createdAt": r["created"] * 1000, "updatedAt": r["updated"] * 1000}
    if counts is not None:
        out.update(counts)
    return out


def get(gid: str) -> dict | None:
    with db.conn() as c:
        r = c.execute("SELECT * FROM groups WHERE id=?", (gid,)).fetchone()
    return _row(r) if r else None


def list_groups() -> list[dict]:
    with db.conn() as c:
        rows = c.execute("SELECT * FROM groups ORDER BY pinned DESC, updated DESC").fetchall()
        counts = {r["group_id"]: (r["n"], r["last"]) for r in c.execute(
            "SELECT group_id, COUNT(*) n, MAX(updated) last FROM conversations WHERE group_id IS NOT NULL GROUP BY group_id")}
    out = []
    for r in rows:
        n, last = counts.get(r["id"], (0, None))
        g = _row(r, {"chatCount": n, "fileCount": len(_meta(r["id"]))})
        if last:
            g["updatedAt"] = max(g["updatedAt"], last * 1000)
        out.append(g)
    return out


def touch(gid):
    with db.conn() as c:
        c.execute("UPDATE groups SET updated=? WHERE id=?", (time.time(), gid))


def _dir(gid) -> Path:
    if not re.match(r"^grp-[0-9a-f]{12}$", gid or ""):
        raise HTTPException(404, "No such project")
    return GROUPS / gid


def _files_dir(gid) -> Path:
    d = _dir(gid) / "files"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _meta(gid) -> dict:
    p = GROUPS / gid / "meta.json"
    try:
        return json.loads(p.read_text()) if p.exists() else {}
    except json.JSONDecodeError:
        return {}


def _save_meta(gid, meta):
    p = GROUPS / gid / "meta.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(meta, indent=1))


def _update(gid, name, **fields):
    """Read-modify-write one file's entry with no await in between, so concurrent index tasks don't clobber each other."""
    meta = _meta(gid)
    if name in meta:
        meta[name].update(fields)
        _save_meta(gid, meta)


def _safe_name(name: str) -> str:
    name = re.sub(r"[^\w.\- ()]+", "_", Path(name or "file").name).strip(" .") or "file"
    return name[:120]


def file_text(gid, name) -> str:
    p = GROUPS / gid / "text" / f"{name}.txt"
    return p.read_text(errors="replace") if p.exists() else ""


# ── text extraction and indexing ────────────────────────────────────────────

DOC_OCR_EXT = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp", ".doc", ".rtf", ".odt", ".xls", ".ods",
               ".ppt", ".odp", ".epub"}

def extract(path: Path) -> str:
    ext = path.suffix.lower()
    if ext == ".pdf":
        from pypdf import PdfReader
        r = PdfReader(str(path))
        return "\n\n".join(f"[page {i + 1}]\n{(pg.extract_text() or '').strip()}" for i, pg in enumerate(r.pages))
    if ext == ".docx":
        import docx
        d = docx.Document(str(path))
        parts = [p.text for p in d.paragraphs]
        for t in d.tables:
            for row in t.rows:
                parts.append(" | ".join(c.text.strip() for c in row.cells))
        return "\n".join(parts)
    if ext in (".xlsx", ".xlsm"):
        import openpyxl
        wb = openpyxl.load_workbook(str(path), read_only=True, data_only=True)
        out = []
        for ws in wb.worksheets:
            out.append(f"## Sheet: {ws.title}")
            for i, row in enumerate(ws.iter_rows(values_only=True)):
                if i >= 5000:
                    out.append("…[rows truncated]")
                    break
                if any(v is not None for v in row):
                    out.append(" | ".join("" if v is None else str(v) for v in row))
        return "\n".join(out)
    if ext == ".pptx":
        import pptx
        prs = pptx.Presentation(str(path))
        out = []
        for i, slide in enumerate(prs.slides, 1):
            out.append(f"## Slide {i}")
            for sh in slide.shapes:
                if sh.has_text_frame:
                    out.append(sh.text_frame.text)
            if slide.has_notes_slide and slide.notes_slide.notes_text_frame:
                out.append("Notes: " + slide.notes_slide.notes_text_frame.text)
        return "\n".join(out)
    if ext in TEXT_EXT or not ext:
        data = path.read_bytes()
        if b"\0" in data[:4096]:
            return ""
        return data.decode("utf-8", errors="replace")
    return ""


def _chunks(text: str) -> list[str]:
    out, i = [], 0
    while i < len(text):
        piece = text[i:i + CHUNK]
        if i + CHUNK < len(text):  # end on a paragraph or sentence boundary when possible
            cut = max(piece.rfind("\n\n"), piece.rfind(". "))
            if cut > CHUNK * 0.5:
                piece = piece[:cut + 1]
        if piece.strip():
            out.append(piece.strip())
        if i + len(piece) >= len(text):
            break
        i += max(len(piece) - OVERLAP, 1)
    return out


async def index_file(gid: str, name: str):
    try:
        text = await asyncio.to_thread(extract, _files_dir(gid) / name)
        if not text.strip() or Path(name).suffix.lower() in DOC_OCR_EXT:
            # scans, pictures and legacy Office formats: the document reader converts and OCRs them
            import doc_tools
            _, text, _ = await doc_tools.extract_any(_files_dir(gid) / name, ocr_cap=500)
        tdir = GROUPS / gid / "text"
        tdir.mkdir(exist_ok=True)
        (tdir / f"{name}.txt").write_text(text)
        _update(gid, name, chars=len(text), status="indexing", error="")
        chunks = _chunks(text)
        with db.conn() as c:
            c.execute("DELETE FROM group_chunks WHERE group_id=? AND file=?", (gid, name))
        if chunks:
            from app import get_settings
            model = get_settings()["embeddingModel"]
            for start in range(0, len(chunks), 32):
                batch = chunks[start:start + 32]
                vecs = await embed(batch, model)
                with db.conn() as c:
                    c.executemany("INSERT OR REPLACE INTO group_chunks(group_id, file, idx, text, embedding) VALUES(?,?,?,?,?)",
                                  [(gid, name, start + j, t, np.asarray(v, dtype=np.float32).tobytes()) for j, (t, v) in enumerate(zip(batch, vecs))])
        _update(gid, name, status="ready" if text.strip() else "no-text", chunks=len(chunks))
    except Exception as e:
        _update(gid, name, status="error", error=f"{type(e).__name__}: {e}"[:300])


def _spawn(coro):
    t = asyncio.create_task(coro)
    _TASKS.add(t)
    t.add_done_callback(_TASKS.discard)


async def search(gid: str, query: str, k=6) -> list[dict]:
    with db.conn() as c:
        rows = c.execute("SELECT file, idx, text, embedding FROM group_chunks WHERE group_id=?", (gid,)).fetchall()
    if not rows:
        return []
    from app import get_settings
    q = (await embed([query], get_settings()["embeddingModel"]))[0]
    q = np.asarray(q, dtype=np.float32)
    mat = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
    scores = mat @ q / (np.linalg.norm(mat, axis=1) * np.linalg.norm(q) + 1e-9)
    top = np.argsort(-scores)[:k]
    return [{"file": rows[i]["file"], "chunk": rows[i]["idx"], "score": float(scores[i]), "text": rows[i]["text"]} for i in top]


# ── agent context and tools ─────────────────────────────────────────────────

def group_of(conv_id: str) -> str | None:
    conv = db.get_conversation(conv_id) if conv_id else None
    return (conv or {}).get("groupId")


def context(gid: str, conv_id: str) -> str:
    g = get(gid)
    if not g:
        return ""
    parts = [f'## Project: "{g["name"]}"', "This conversation belongs to a project, which groups related chats and shares context between them."]
    if g["description"]:
        parts.append(f"About the project: {g['description']}")
    if g["instructions"].strip():
        parts.append("### Project instructions (from the user; follow them)\n" + g["instructions"].strip())
    meta = _meta(gid)
    total = sum(len(file_text(gid, n)) for n in meta)
    if meta:
        if total <= INLINE_LIMIT:
            docs = "\n\n".join(f'<document name="{n}">\n{file_text(gid, n)}\n</document>' for n in sorted(meta) if file_text(gid, n).strip())
            parts.append("### Project knowledge (full text)\n" + (docs or "(the files have no extractable text)")
                         + "\nThe original files are also at /project/<name> in run_code.")
        else:
            listing = "\n".join(f"- {n} ({m.get('chars', 0):,} chars)" for n, m in sorted(meta.items()))
            parts.append("### Project knowledge\nToo large to include here. Search it with project_search before answering questions it "
                         "might cover, and cite the file names. Read whole files with project_read_file. Originals are at "
                         f"/project/<name> in run_code.\n{listing}")
    with db.conn() as c:
        others = c.execute("SELECT id, title, updated FROM conversations WHERE group_id=? AND id!=? ORDER BY updated DESC LIMIT 20",
                           (gid, conv_id or "")).fetchall()
    if others:
        parts.append("### Other chats in this project\nRead one with project_read_chat if earlier work is relevant.\n"
                     + "\n".join(f"- `{r['id']}`: {r['title']}" for r in others))
    import todos
    if todo := todos.brief(gid, conv_id):
        parts.append(todo)
    return "\n\n".join(parts)


async def project_search(args, ctx):
    gid = group_of(ctx.conv_id)
    if not gid:
        return ToolResult("This chat is not in a project.", error=True)
    hits = await search(gid, str(args.get("query", "")), int(args.get("k") or 6))
    if not hits:
        return ToolResult("No indexed project knowledge matched (the project may have no files, or they are still indexing).")
    return ToolResult("\n\n".join(f"[{h['file']} · part {h['chunk'] + 1} · score {h['score']:.2f}]\n{h['text']}" for h in hits),
                      {"sources": [{"title": h["file"], "url": f"/api/chat-projects/{gid}/files/{h['file']}"} for h in hits[:4]]})


async def project_read_file(args, ctx):
    gid = group_of(ctx.conv_id)
    name = _safe_name(str(args.get("name", "")))
    if not gid or name not in _meta(gid):
        return ToolResult(f"No project file named {name!r}.", error=True)
    text = file_text(gid, name)
    start = int(args.get("start") or 0)
    chunk = text[start:start + 14000]  # tool results are capped near 16k characters
    more = len(text) - start - len(chunk)
    return ToolResult((chunk or "(no extractable text; the original is at /project/" + name + " in run_code)")
                      + (f"\n\n…[{more:,} more characters; call again with start={start + len(chunk)}]" if more > 0 else ""))


async def project_read_chat(args, ctx):
    gid = group_of(ctx.conv_id)
    cid = str(args.get("chat_id", ""))
    conv = db.get_conversation(cid)
    if not gid or not conv or conv.get("groupId") != gid:
        return ToolResult("No chat with that id in this project.", error=True)
    lines = [f"# {conv['title']}"]
    for m in db.list_messages(cid):
        lines.append(f"\n**{'User' if m['role'] == 'user' else 'Assistant'}:** {m['content']}")
    text = "\n".join(lines)
    return ToolResult(text if len(text) <= 40000 else text[:40000] + "\n…[truncated]")


async def project_save_file(args, ctx):
    gid = group_of(ctx.conv_id)
    if not gid:
        return ToolResult("This chat is not in a project.", error=True)
    name = _safe_name(str(args.get("name", "notes.md")))
    if Path(name).suffix.lower() not in TEXT_EXT:
        name += ".md"
    (_files_dir(gid) / name).write_text(str(args.get("content", "")))
    meta = _meta(gid)
    meta[name] = {"size": (_files_dir(gid) / name).stat().st_size, "uploadedAt": time.time() * 1000, "status": "indexing", "source": "agent"}
    _save_meta(gid, meta)
    await index_file(gid, name)
    touch(gid)
    return ToolResult(f"Saved {name} to the project's knowledge.")


def register():
    common = {"service": None, "scope": "group", "auto": "in chats inside a chat Project"}
    TOOLS["project_search"] = {**common, "fn": project_search,
        "ui": {"displayName": "Search Project", "icon": "FolderSearch", "category": "project",
               "description": "Semantic search over the project's knowledge files. Added in project chats."},
        "schema": _fn("project_search", "Search this project's knowledge files for passages relevant to a query.",
                      {"query": {"type": "string"}, "k": {"type": "integer", "description": "Passages to return (default 6)"}}, ["query"])}
    TOOLS["project_read_file"] = {**common, "fn": project_read_file,
        "ui": {"displayName": "Read Project File", "icon": "FileText", "category": "project",
               "description": "Reads the extracted text of a project file. Added in project chats."},
        "schema": _fn("project_read_file", "Read the full extracted text of one of this project's knowledge files.",
                      {"name": {"type": "string"}, "start": {"type": "integer", "description": "Character offset to continue"}}, ["name"])}
    TOOLS["project_read_chat"] = {**common, "fn": project_read_chat,
        "ui": {"displayName": "Read Project Chat", "icon": "MessagesSquare", "category": "project",
               "description": "Reads another chat in the same project. Added in project chats."},
        "schema": _fn("project_read_chat", "Read the transcript of another chat in this project (ids are listed in your instructions).",
                      {"chat_id": {"type": "string"}}, ["chat_id"])}
    TOOLS["project_save_file"] = {**common, "fn": project_save_file,
        "ui": {"displayName": "Save to Project", "icon": "FilePlus", "category": "project",
               "description": "Saves notes or a document into the project's knowledge. Added in project chats."},
        "schema": _fn("project_save_file", "Save a text document (notes, decisions, a summary, a draft) into this project's knowledge so "
                      "future chats in the project can use it. Use when the user asks to keep or remember something for the project.",
                      {"name": {"type": "string", "description": "File name, e.g. decisions.md"}, "content": {"type": "string"}},
                      ["name", "content"])}


PROJECT_TOOLS = ("project_search", "project_read_file", "project_read_chat", "project_save_file", "project_todos")


# ── API ─────────────────────────────────────────────────────────────────────

@router.get("/api/chat-projects")
def api_list():
    return list_groups()


@router.post("/api/chat-projects")
async def api_create(req: Request):
    body = await req.json()
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Give the project a name")
    gid, now = f"grp-{db.new_id('x')[2:]}", time.time()
    with db.conn() as c:
        c.execute("INSERT INTO groups(id, name, description, instructions, emoji, color, pinned, created, updated) VALUES(?,?,?,?,?,?,0,?,?)",
                  (gid, name[:120], str(body.get("description") or "")[:2000], str(body.get("instructions") or ""),
                   str(body.get("emoji") or "")[:4], str(body.get("color") or "")[:20], now, now))
    _files_dir(gid)
    return get(gid)


@router.get("/api/chat-projects/{gid}")
def api_get(gid: str):
    g = get(gid)
    if not g:
        raise HTTPException(404, "No such project")
    meta = _meta(gid)
    g["files"] = [{"name": n, **m} for n, m in sorted(meta.items(), key=lambda kv: -kv[1].get("uploadedAt", 0))]
    g["knowledgeChars"] = sum(m.get("chars", 0) for m in meta.values())
    g["inline"] = g["knowledgeChars"] <= INLINE_LIMIT
    convs = db.list_conversations(group_id=gid)
    g["chats"] = convs
    arts = []
    for cv in convs[:60]:
        for a in db.latest_artifacts(cv["id"]):
            arts.append({"id": a["id"], "title": a["title"], "type": a["type"], "version": a["version"], "convId": cv["id"],
                         "chatTitle": cv["title"]})
    g["artifacts"] = arts
    return g


@router.patch("/api/chat-projects/{gid}")
async def api_patch(gid: str, req: Request):
    if not get(gid):
        raise HTTPException(404, "No such project")
    body = await req.json()
    cols = {"name": "name", "description": "description", "instructions": "instructions", "emoji": "emoji", "color": "color", "pinned": "pinned"}
    sets, vals = [], []
    for k, col in cols.items():
        if k in body:
            sets.append(f"{col}=?")
            vals.append(int(bool(body[k])) if k == "pinned" else str(body[k] or ""))
    if sets:
        with db.conn() as c:
            c.execute(f"UPDATE groups SET {', '.join(sets)}, updated=? WHERE id=?", (*vals, time.time(), gid))
    return get(gid)


@router.delete("/api/chat-projects/{gid}")
def api_delete(gid: str, deleteChats: bool = False):
    if not get(gid):
        raise HTTPException(404, "No such project")
    with db.conn() as c:
        ids = [r["id"] for r in c.execute("SELECT id FROM conversations WHERE group_id=?", (gid,))]
        c.execute("DELETE FROM groups WHERE id=?", (gid,))
        c.execute("DELETE FROM group_chunks WHERE group_id=?", (gid,))
        if not deleteChats:
            c.execute("UPDATE conversations SET group_id=NULL WHERE group_id=?", (gid,))
    import todos
    todos.stop_list(gid)
    todos.delete_group(gid)
    if deleteChats:
        for cid in ids:
            db.delete_conversation(cid)
    shutil.rmtree(_dir(gid), ignore_errors=True)
    return {"ok": True}


@router.post("/api/chat-projects/{gid}/files")
async def api_upload(gid: str, files: list[UploadFile] = File(...)):
    if not get(gid):
        raise HTTPException(404, "No such project")
    d = _files_dir(gid)
    meta = _meta(gid)
    saved = []
    for f in files:
        data = await f.read()
        if len(data) > MAX_FILE:
            raise HTTPException(413, f"{f.filename} is over 100 MB")
        name = _safe_name(f.filename or "file")
        (d / name).write_bytes(data)
        meta[name] = {"size": len(data), "uploadedAt": time.time() * 1000, "status": "indexing", "source": "upload"}
        saved.append(name)
    _save_meta(gid, meta)
    for name in saved:
        _spawn(index_file(gid, name))
    touch(gid)
    return {"saved": saved}


@router.get("/api/chat-projects/{gid}/files/{name}")
def api_file(gid: str, name: str):
    p = _files_dir(gid) / _safe_name(name)
    if not p.is_file():
        raise HTTPException(404, "No such file")
    return FileResponse(p, filename=p.name)


@router.delete("/api/chat-projects/{gid}/files/{name}")
def api_file_delete(gid: str, name: str):
    name = _safe_name(name)
    meta = _meta(gid)
    meta.pop(name, None)
    _save_meta(gid, meta)
    for p in (_files_dir(gid) / name, GROUPS / gid / "text" / f"{name}.txt"):
        p.unlink(missing_ok=True)
    with db.conn() as c:
        c.execute("DELETE FROM group_chunks WHERE group_id=? AND file=?", (gid, name))
    return {"ok": True}
