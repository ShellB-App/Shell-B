"""Codex: the long-term reference shelf. Shown at #/codex.

Memory (db.memories) holds short facts that are recalled into every prompt on their own. The Codex holds reference
material of any size that agents look up when they need it: notes (Markdown), links (with a saved copy of the page),
snippets (code, commands, config) and files (PDF, Office, images, text; extracted and OCRed). Entries sit in
collections, carry tags, and are chunked and embedded so a long document is searchable passage by passage.

Agents get the `codex` tool (search, read, list, add). What an agent adds is a draft until the owner accepts it on the
page, and agents can only edit their own drafts, so a prompt-injected page can't quietly rewrite the reference shelf.
Cloud agents get the tool only with the `cloudCodex` setting. Saved web pages are untrusted content, like web_fetch.

Files live in data/codex/<entry id>/ (the original, plus text.txt with the extracted or snapshot text).
"""
import asyncio
import json
import re
import shutil
import time
import uuid
from pathlib import Path

from datetime import datetime, timedelta, date

import httpx
import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

import db
import providers
from tools import TOOLS, ToolResult, _fn, embed

router = APIRouter(prefix="/api/codex")
ROOT = db.DATA / "codex"
KINDS = ("note", "link", "snippet", "file", "secret", "contact", "event")
MAX_FILE = 100 * 1024 * 1024
MAX_PAGE = 20 * 1024 * 1024
BODY_LIMIT = 500_000
READ_LIMIT = 12_000
# qwen3-embedding ranks much better when the query (not the documents) carries a task instruction
QUERY_PREFIX = "Instruct: Given a question, retrieve notes and documents that answer it\nQuery: "
MIN_SCORE = 0.4
_TASKS: set = set()
_index_ver = 0                       # bumped whenever chunks change, so the search matrix is rebuilt
_cache: dict = {"ver": -1}


def init():
    ROOT.mkdir(exist_ok=True)
    with db.conn() as c:
        c.executescript("""
CREATE TABLE IF NOT EXISTS codex_collections(
  id TEXT PRIMARY KEY, name TEXT, description TEXT, color TEXT, created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS codex_entries(
  id TEXT PRIMARY KEY, collection_id TEXT, kind TEXT, title TEXT, body TEXT, url TEXT, language TEXT, tags TEXT,
  pinned INTEGER DEFAULT 0, status TEXT DEFAULT 'ok', meta TEXT, created_by TEXT, created REAL, updated REAL);
CREATE INDEX IF NOT EXISTS codex_entries_coll ON codex_entries(collection_id, updated);
CREATE TABLE IF NOT EXISTS codex_chunks(
  entry_id TEXT, idx INTEGER, text TEXT, embedding BLOB, PRIMARY KEY(entry_id, idx));
""")
        # indexing that a restart cut short starts again
        stale = [r["id"] for r in c.execute("SELECT id, meta FROM codex_entries").fetchall()
                 if json.loads(r["meta"] or "{}").get("index") in ("pending", "indexing")
                 or json.loads(r["meta"] or "{}").get("snapshot", {}).get("status") == "pending"]
    _restart.extend(stale)
    import codex_secrets
    codex_secrets.init()


_restart: list[str] = []


_LOOP: asyncio.AbstractEventLoop | None = None


def start():
    global _LOOP
    _LOOP = asyncio.get_running_loop()
    for eid in _restart:
        e = get(eid)
        if e and e["kind"] == "link" and e["meta"].get("snapshot", {}).get("status") == "pending":
            _spawn(snapshot(eid))
        elif e:
            _spawn(index(eid))
    _restart.clear()


def allowed(agent: dict, settings: dict) -> bool:
    """Cloud agents see the Codex only when the owner allows it."""
    return not providers.is_cloud(agent.get("model", "")) or bool(settings.get("cloudCodex", False))


def _spawn(coro):
    try:
        asyncio.get_running_loop()
    except RuntimeError:  # a sync endpoint (worker thread), e.g. re-snapshot or relink
        _LOOP.call_soon_threadsafe(_spawn, coro)
        return
    t = asyncio.create_task(coro)
    _TASKS.add(t)
    t.add_done_callback(_TASKS.discard)


# ── rows ────────────────────────────────────────────────────────────────────

def _dir(eid) -> Path:
    if not re.fullmatch(r"cx-[0-9a-f]{12}", eid or ""):
        raise ValueError("bad entry id")
    return ROOT / eid


def _entry(r, full=False) -> dict:
    meta = json.loads(r["meta"] or "{}")
    body = r["body"] or ""
    e = {"id": r["id"], "collectionId": r["collection_id"], "kind": r["kind"], "title": r["title"] or "",
         "url": r["url"] or "", "language": r["language"] or "", "tags": json.loads(r["tags"] or "[]"),
         "pinned": bool(r["pinned"]), "draft": r["status"] == "draft", "meta": meta, "createdBy": r["created_by"] or "you",
         "createdAt": r["created"] * 1000, "updatedAt": r["updated"] * 1000}
    if full:
        e["body"] = body
        t = _dir(r["id"]) / "text.txt"
        e["text"] = t.read_text(errors="replace")[:200_000] if t.exists() else ""
    else:
        plain = body if r["kind"] == "snippet" else re.sub(r"[#*_`>|]+", "", re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", _unwiki(body)))
        if r["kind"] == "contact":
            parts = []
            if meta.get("role") or meta.get("company"):
                parts.append(" at ".join(p for p in (meta.get("role"), meta.get("company")) if p))
            if meta.get("email"):
                parts.append(meta["email"])
            if meta.get("phone"):
                parts.append(meta["phone"])
            if meta.get("location"):
                parts.append(meta["location"])
            prefix = " · ".join(parts)
            e["preview"] = f"{prefix} — {plain}".strip(" —") if prefix else " ".join(plain.split())[:240]
        elif r["kind"] == "event":
            parts = []
            if meta.get("date"):
                dt = meta["date"] + (f" {meta['time']}" if meta.get("time") and not meta.get("allDay") else "")
                parts.append(dt)
            if meta.get("location"):
                parts.append(meta["location"])
            if meta.get("attendees"):
                parts.append(", ".join(str(x) for x in meta["attendees"][:3]))
            prefix = " · ".join(parts)
            e["preview"] = f"{prefix} — {plain}".strip(" —") if prefix else " ".join(plain.split())[:240]
        elif r["kind"] == "secret":
            hosts = ", ".join(meta.get("hosts") or [])
            e["preview"] = f"{plain} · {hosts}" if (plain and hosts) else (plain or hosts or "No hosts configured yet")
        else:
            e["preview"] = " ".join(plain.split())[:240]
    if r["kind"] == "secret":
        import codex_secrets
        e["secret"] = {
            "set": codex_secrets.has_value(r["id"]),
            "hosts": meta.get("hosts") or [],
            "approval": meta.get("approval", "ask"),
            "uses": int(meta.get("uses", 0)),
            "lastUsed": meta.get("lastUsed"),
            "recent": [],
        }
    return e


def _unwiki(text: str) -> str:
    """[[Title|shown]] → shown, [[Title]] → Title: for previews."""
    return re.sub(r"\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]*))?\]\]", lambda m: (m.group(2) or m.group(1)).strip(), text)


def get(eid, full=False) -> dict | None:
    with db.conn() as c:
        r = c.execute("SELECT * FROM codex_entries WHERE id=?", (eid,)).fetchone()
    return _entry(r, full) if r else None


def _set_meta(eid, **kw):
    with db.conn() as c:
        r = c.execute("SELECT meta FROM codex_entries WHERE id=?", (eid,)).fetchone()
        if not r:
            return
        m = json.loads(r["meta"] or "{}")
        m.update(kw)
        c.execute("UPDATE codex_entries SET meta=? WHERE id=?", (json.dumps(m), eid))


def collections() -> list[dict]:
    with db.conn() as c:
        rows = c.execute("SELECT * FROM codex_collections ORDER BY lower(name)").fetchall()
        counts = {r["collection_id"]: r["n"] for r in
                  c.execute("SELECT collection_id, count(*) n FROM codex_entries GROUP BY collection_id")}
    return [{"id": r["id"], "name": r["name"], "description": r["description"] or "", "color": r["color"] or "",
             "count": counts.get(r["id"], 0), "updatedAt": r["updated"] * 1000} for r in rows]


def _collection_id(value) -> str | None:
    """A collection by id or (case-insensitive) name; None for unfiled."""
    v = str(value or "").strip()
    if not v:
        return None
    with db.conn() as c:
        r = c.execute("SELECT id FROM codex_collections WHERE id=? OR lower(name)=lower(?)", (v, v)).fetchone()
    if not r:
        raise ValueError(f"No Codex collection {v!r}. Collections: " + (", ".join(x["name"] for x in collections()) or "none yet"))
    return r["id"]


def _tags(value) -> list[str]:
    if isinstance(value, str):
        value = value.split(",")
    out = []
    for t in value or []:
        t = re.sub(r"\s+", "-", str(t).strip().lower().lstrip("#"))[:40]
        if t and t not in out:
            out.append(t)
    return out[:20]


def create(fields: dict, created_by="you", draft=False) -> dict:
    kind = fields.get("kind") or "note"
    if kind == "person":
        kind = "contact"
    if kind not in KINDS:
        raise ValueError(f"kind is one of {', '.join(KINDS)}")
    url = str(fields.get("url") or "").strip()
    if kind == "link":
        import scrape
        scrape._check_url(url)
    default_title = "New Contact" if kind == "contact" else "New Event" if kind == "event" else (url if kind == "link" else "Untitled")
    title = str(fields.get("title") or "").strip()[:200] or default_title
    eid, now = db.new_id("cx"), time.time()
    meta = dict(fields.get("meta") or {})
    meta["index"] = "pending"
    if kind == "link":
        meta["snapshot"] = {"status": "pending" if fields.get("snapshot", True) else "off"}
    with db.conn() as c:
        c.execute("INSERT INTO codex_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (eid, _collection_id(fields.get("collectionId") or fields.get("collection")), kind, title,
                   str(fields.get("body") or "")[:BODY_LIMIT], url, str(fields.get("language") or "")[:30],
                   json.dumps(_tags(fields.get("tags"))), int(bool(fields.get("pinned"))), "draft" if draft else "ok",
                   json.dumps(meta), created_by, now, now))
    _dir(eid).mkdir(parents=True, exist_ok=True)
    if kind != "file":   # files are indexed once the upload has landed (api_upload)
        _spawn(snapshot(eid) if kind == "link" and meta["snapshot"]["status"] == "pending" else index(eid))
    return get(eid)


def update(eid, fields: dict) -> dict:
    e = get(eid)
    if not e:
        raise KeyError(eid)
    sets, vals = [], []
    if e["kind"] == "secret":
        fields = {k: v for k, v in fields.items() if k in ("body", "tags", "pinned", "collectionId", "draft")}
    if "title" in fields:
        sets.append("title=?"); vals.append(str(fields["title"] or "").strip()[:200] or "Untitled")
    if "body" in fields:
        sets.append("body=?"); vals.append(str(fields["body"] or "")[:BODY_LIMIT])
    if "language" in fields:
        sets.append("language=?"); vals.append(str(fields["language"] or "")[:30])
    if "tags" in fields:
        sets.append("tags=?"); vals.append(json.dumps(_tags(fields["tags"])))
    if "pinned" in fields:
        sets.append("pinned=?"); vals.append(int(bool(fields["pinned"])))
    if "collectionId" in fields:
        sets.append("collection_id=?"); vals.append(_collection_id(fields["collectionId"]))
    if "draft" in fields and not fields["draft"]:
        sets.append("status='ok'")
    if "meta" in fields and isinstance(fields["meta"], dict):
        with db.conn() as c:
            r = c.execute("SELECT meta FROM codex_entries WHERE id=?", (eid,)).fetchone()
        m = json.loads(r["meta"] or "{}") if r else {}
        m.update(fields["meta"])
        sets.append("meta=?"); vals.append(json.dumps(m))
    new_url = None
    if "url" in fields and e["kind"] == "link" and str(fields["url"] or "").strip() != e["url"]:
        import scrape
        new_url = scrape._check_url(str(fields["url"]).strip())
        sets.append("url=?"); vals.append(new_url)
    if sets:
        with db.conn() as c:
            c.execute(f"UPDATE codex_entries SET {', '.join(sets)}, updated=? WHERE id=?", (*vals, time.time(), eid))
    if new_url:
        _set_meta(eid, snapshot={"status": "pending"})
        _spawn(snapshot(eid))
    elif any(k in fields for k in ("title", "body", "tags", "language", "meta")):
        _set_meta(eid, index="pending")
        _spawn(_index_soon(eid))
    return get(eid)


_edits: dict[str, int] = {}
REINDEX_QUIET = 4.0


async def _index_soon(eid):
    """Re-index once edits stop for a few seconds. The Notes page autosaves while you type, and each save would
    otherwise embed the whole note again."""
    n = _edits[eid] = _edits.get(eid, 0) + 1
    await asyncio.sleep(REINDEX_QUIET)
    if _edits.get(eid) != n:
        return
    del _edits[eid]
    await index(eid)


def delete(eid):
    global _index_ver
    with db.conn() as c:
        c.execute("DELETE FROM codex_entries WHERE id=?", (eid,))
        c.execute("DELETE FROM codex_chunks WHERE entry_id=?", (eid,))
    import codex_secrets
    codex_secrets.forget(eid)
    shutil.rmtree(_dir(eid), ignore_errors=True)
    _index_ver += 1


# ── indexing ────────────────────────────────────────────────────────────────

async def _extract(path: Path) -> str:
    import groups
    text = await asyncio.to_thread(groups.extract, path)
    if not text.strip() or path.suffix.lower() in groups.DOC_OCR_EXT:
        import doc_tools
        _, text, _ = await doc_tools.extract_any(path, ocr_cap=300)
    return text


def _index_text(e: dict) -> str:
    head = [e["title"]]
    if e["url"]:
        head.append(e["url"])
    if e["tags"]:
        head.append("Tags: " + ", ".join(e["tags"]))
    m = e.get("meta") or {}
    if e["kind"] == "secret":  # the name, description and hosts; the value never gets near the index
        head[0] = f"Secret {e['title']} ({{{{secret:{e['title']}}}}})"
        head.append("Used with: " + ", ".join(m.get("hosts") or []))
    elif e["kind"] == "contact":
        head[0] = f"Contact: {e['title']}"
        details = []
        if m.get("aka"):
            details.append("Also known as: " + ", ".join(str(x) for x in m["aka"] if x))
        if m.get("role") or m.get("company"):
            role_parts = [p for p in (m.get("role"), m.get("company")) if p]
            details.append("Role: " + " at ".join(role_parts))
        emails = m.get("emails") or ([m.get("email")] if m.get("email") else [])
        if emails:
            details.append("Email: " + ", ".join(str(x) for x in emails if x))
        phones = m.get("phones") or ([m.get("phone")] if m.get("phone") else [])
        if phones:
            details.append("Phone: " + ", ".join(str(x) for x in phones if x))
        if m.get("location"):
            details.append(f"Location: {m['location']}")
        if m.get("birthday"):
            details.append(f"Birthday: {m['birthday']}")
        if m.get("pronouns"):
            details.append(f"Pronouns: {m['pronouns']}")
        if m.get("urls"):
            details.append("Links: " + ", ".join(str(x) for x in m["urls"] if x))
        if details:
            head.append("\n".join(details))
    elif e["kind"] == "event":
        head[0] = f"Event: {e['title']}"
        details = []
        d = m.get("date") or ""
        if d:
            time_part = f" {m['time']}" if m.get("time") and not m.get("allDay") else ""
            end_d = m.get("endDate") or ""
            end_t = f" {m['endTime']}" if m.get("endTime") and not m.get("allDay") else ""
            if end_d and end_d != d:
                details.append(f"Date: {d}{time_part} to {end_d}{end_t}")
            elif end_t:
                details.append(f"Date & Time: {d}{time_part} to{end_t}")
            else:
                details.append(f"Date & Time: {d}{time_part}" + (" (all day)" if m.get("allDay") else ""))
        if m.get("location"):
            details.append(f"Location: {m['location']}")
        attendees = m.get("attendees") or []
        if attendees:
            details.append("Attendees: " + ", ".join(str(x) for x in attendees if x))
        if m.get("status") and m.get("status") != "confirmed":
            details.append(f"Status: {m['status']}")
        if m.get("recurrence") and m.get("recurrence") != "none":
            details.append(f"Recurrence: {m['recurrence']}")
        if details:
            head.append("\n".join(details))
    return "\n".join(head) + "\n\n" + (e["body"] or "") + ("\n\n" + e["text"] if e["text"] else "")


async def index(eid):
    """Chunk and embed an entry (title, tags, body, plus extracted file or page text)."""
    global _index_ver
    try:
        e = get(eid, full=True)
        if not e:
            return
        _set_meta(eid, index="indexing", indexError="")
        if e["kind"] == "file" and e["meta"].get("file") and not (_dir(eid) / "text.txt").exists():
            text = await _extract(_dir(eid) / e["meta"]["file"])
            (_dir(eid) / "text.txt").write_text(text)
            e["text"] = text[:200_000]
            _set_meta(eid, chars=len(text))
        import groups
        from app import get_settings
        full = _index_text(e)
        if (_dir(eid) / "text.txt").exists():   # index the whole extracted text, not the 200k preview
            full = _index_text({**e, "text": (_dir(eid) / "text.txt").read_text(errors="replace")})
        chunks = groups._chunks(full)
        model = get_settings()["embeddingModel"]
        rows = []
        for s in range(0, len(chunks), 32):
            batch = chunks[s:s + 32]
            vecs = await embed(batch, model)
            rows += [(eid, s + j, t, np.asarray(v, dtype=np.float32).tobytes()) for j, (t, v) in enumerate(zip(batch, vecs))]
        with db.conn() as c:
            c.execute("DELETE FROM codex_chunks WHERE entry_id=?", (eid,))
            c.executemany("INSERT INTO codex_chunks VALUES(?,?,?,?)", rows)
        _index_ver += 1
        _set_meta(eid, index="ready", chunks=len(rows))
    except Exception as ex:  # noqa: BLE001
        _set_meta(eid, index="error", indexError=f"{type(ex).__name__}: {ex}"[:300])


async def snapshot(eid):
    """Save a copy of a link's page (readable text; PDFs and documents are extracted), then index it."""
    e = get(eid)
    if not e:
        return
    try:
        import scrape
        import trafilatura
        async with scrape.client(timeout=45) as c:
            async with c.stream("GET", scrape._check_url(e["url"])) as r:
                r.raise_for_status()
                data = b""
                async for part in r.aiter_bytes():
                    data += part
                    if len(data) > MAX_PAGE:
                        raise ValueError("the page is larger than 20 MB")
                ctype, final = r.headers.get("content-type", ""), str(r.url)
        d = _dir(eid)
        title = ""
        if "html" in ctype or (not ctype and data.lstrip()[:1] == b"<"):
            html = data.decode(r.encoding or "utf-8", errors="replace")
            text = await asyncio.to_thread(trafilatura.extract, html, output_format="markdown", include_links=True,
                                           include_tables=True, url=final) or ""
            m = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
            title = " ".join(m.group(1).split())[:200] if m else ""
        elif ctype.startswith("text/") or "json" in ctype or "xml" in ctype:
            text = data.decode("utf-8", errors="replace")
        else:
            ext = {"application/pdf": ".pdf"}.get(ctype.split(";")[0].strip(), Path(final.split("?")[0]).suffix[:8] or ".bin")
            (d / f"page{ext}").write_bytes(data)
            text = await _extract(d / f"page{ext}")
        (d / "text.txt").write_text(text)
        with db.conn() as c:
            if title and e["title"] in ("", e["url"]):
                c.execute("UPDATE codex_entries SET title=? WHERE id=?", (title, eid))
        _set_meta(eid, snapshot={"status": "ok", "at": time.time() * 1000, "url": final, "chars": len(text)})
    except Exception as ex:  # noqa: BLE001
        _set_meta(eid, snapshot={"status": "error", "at": time.time() * 1000, "error": f"{type(ex).__name__}: {ex}"[:300]})
    await index(eid)


# ── search ──────────────────────────────────────────────────────────────────

def _matrix():
    if _cache["ver"] != _index_ver:
        with db.conn() as c:
            rows = c.execute("SELECT entry_id, idx, embedding FROM codex_chunks").fetchall()
        _cache.update(ver=_index_ver, keys=[(r["entry_id"], r["idx"]) for r in rows],
                      mat=np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows]) if rows else None)
    return _cache["keys"], _cache["mat"]


def _filtered(collection=None, kind=None, tag=None, drafts=True) -> dict[str, dict]:
    where, args = [], []
    if collection:
        where.append("collection_id=?"); args.append(collection)
    if kind in KINDS:
        where.append("kind=?"); args.append(kind)
    if not drafts:
        where.append("status='ok'")
    with db.conn() as c:
        rows = c.execute("SELECT * FROM codex_entries" + (" WHERE " + " AND ".join(where) if where else ""), args).fetchall()
    out = {r["id"]: _entry(r) for r in rows}
    if tag:
        out = {k: v for k, v in out.items() if tag in v["tags"]}
    return out


async def search(query: str, k=8, collection=None, kind=None, tag=None, drafts=True) -> list[dict]:
    """Semantic search over chunks, nudged by plain word matches in titles, tags and bodies."""
    pool = _filtered(collection, kind, tag, drafts)
    if not pool or not query.strip():
        return []
    words = [w for w in re.findall(r"\w+", query.lower()) if len(w) > 2]
    best: dict[str, tuple[float, str]] = {}
    try:
        keys, mat = _matrix()
        if mat is not None:
            from app import get_settings
            q = (await embed([QUERY_PREFIX + query], get_settings()["embeddingModel"]))[0]
            scores = mat @ q
            for i in np.argsort(-scores)[:400]:
                eid = keys[i][0]
                if eid in pool and eid not in best:
                    best[eid] = (float(scores[i]), keys[i])
    except Exception as ex:  # noqa: BLE001 — Ollama down: words still work
        print(f"codex search: embedding failed ({ex}); using word matches only")
    hits = []
    for eid, e in pool.items():
        sem, key = best.get(eid, (0.0, None))
        hay_title = (e["title"] + " " + " ".join(e["tags"])).lower()
        kw = sum(0.12 for w in words if w in hay_title) + sum(0.04 for w in words if w in e["preview"].lower())
        score = sem + min(kw, 0.3)
        if score >= MIN_SCORE or kw:
            hits.append((score, eid, key))
    hits.sort(reverse=True)
    if hits:  # drop the long tail of vaguely related entries
        hits = [h for h in hits if h[0] >= hits[0][0] - 0.3]
    out = []
    with db.conn() as c:
        for score, eid, key in hits[:k]:
            passage = ""
            if key:
                r = c.execute("SELECT text FROM codex_chunks WHERE entry_id=? AND idx=?", key).fetchone()
                passage = r["text"] if r else ""
            out.append({**pool[eid], "score": round(score, 3), "passage": passage[:1600]})
    return out


# ── agent tool & context integration ────────────────────────────────────────

GUIDE = ("- codex is the owner's long-term reference shelf: notes, saved links (with a copy of the page), snippets "
         "(commands, code, config), files, contacts (people: roles, emails, phones, locations, notes) and calendar events "
         "(meetings, dates, times, locations, attendees). Upcoming calendar events and relevant contacts are automatically "
         "recalled into your context. Use codex to search, inspect or record reference information. "
         "Actions: search (query) · read (id) · list (collection, kind, tag) · collections · add "
         "(kind note|link|snippet|contact|event, title, body, url, tags, collection, meta) · "
         "auto_populate (populate contacts and calendar events from memories). What you add is a draft "
         "until the owner accepts it; add only what they asked you to keep or clearly will want again. For contacts, put "
         "details in meta (e.g. role, company, email, phone, location, birthday). For events, put date, time, location, "
         "attendees in meta. In notes, [[Title]] links to the note or person with that title (read it with search or list).\n"
         "  Secrets (kind secret: API keys, tokens, passwords) show only their NAME; you never see the value and must "
         "never ask the user to paste one into the chat. To call an API with one, use codex action=request (https url, "
         "method, headers, body) and write {{secret:NAME}} where the value goes, e.g. headers {\"Authorization\": "
         "\"Bearer {{secret:GITHUB_TOKEN}}\"}. The server fills it in only for the hosts the owner allowed for that "
         "secret, usually after the owner approves, and blanks it out of the response. Agents can't create secrets; "
         "point the owner to the Codex if one is missing.")


def upcoming_schedule_prompt(now=None, days=14) -> str:
    """Formats upcoming calendar events from the Codex into a markdown block for the agent's system prompt."""
    try:
        from zoneinfo import ZoneInfo
        if now is None:
            settings = {**db.kv_get("settings", {})}
            tz = settings.get("timeZone")
            now = datetime.now(ZoneInfo(tz)) if tz else datetime.now().astimezone()
    except Exception:
        now = datetime.now().astimezone()

    today = now.date() if hasattr(now, "date") else now
    end_date = today + timedelta(days=days)

    try:
        with db.conn() as c:
            rows = c.execute("SELECT id, title, meta, body FROM codex_entries WHERE kind='event' AND status IN ('ok', 'draft')").fetchall()
    except Exception:
        return ""

    if not rows:
        return ""

    upcoming = []
    annual_milestones = []

    for r in rows:
        meta = json.loads(r["meta"] or "{}")
        title = r["title"] or "Untitled Event"
        start_str = str(meta.get("startDate") or meta.get("date") or "").strip()
        recurrence = str(meta.get("recurrence") or "").lower()
        time_str = ""
        if not meta.get("allDay"):
            t = str(meta.get("startTime") or meta.get("time") or "").strip()
            end_t = str(meta.get("endTime") or "").strip()
            if t:
                time_str = f" at {t}{(' - ' + end_t) if end_t else ''}"

        loc = str(meta.get("location") or "").strip()
        loc_str = f" [{loc}]" if loc else ""
        attendees = meta.get("attendees") or []
        att_str = f" (with {', '.join(attendees)})" if attendees else ""

        if not start_str:
            continue

        parts = start_str.split("-")
        try:
            if len(parts) == 3:
                y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
                ev_date = date(y, m, d)
            elif len(parts) == 2:
                m, d = int(parts[0]), int(parts[1])
                ev_date = date(today.year, m, d)
            else:
                continue
        except (ValueError, TypeError):
            continue

        if recurrence == "yearly":
            try:
                this_year_date = date(today.year, m, d)
            except ValueError:
                continue
            if today <= this_year_date <= end_date:
                upcoming.append((this_year_date, f"{title}{time_str}{loc_str}{att_str} (Yearly)"))
            elif len(annual_milestones) < 3:
                annual_milestones.append(f"{title} ({this_year_date.strftime('%b %d')}){att_str}")
        elif recurrence in ("daily", "weekly", "monthly", "custom"):
            import codex_sync  # dateutil expands the rule (daily/weekly/monthly, or the stored RRULE)
            label = {"custom": "Repeats"}.get(recurrence, recurrence.capitalize())
            for occ in codex_sync.occurrences(meta, today, end_date, limit=8):
                upcoming.append((occ, f"{title}{time_str}{loc_str}{att_str} ({label})"))
        else:
            if today <= ev_date <= end_date:
                upcoming.append((ev_date, f"{title}{time_str}{loc_str}{att_str}"))

    if not upcoming and not annual_milestones:
        return ""

    upcoming.sort(key=lambda x: x[0])
    lines = ["## Upcoming Schedule (Codex Calendar)"]
    for ev_date, desc in upcoming[:8]:
        if ev_date == today:
            day_label = "Today"
        elif ev_date == today + timedelta(days=1):
            day_label = "Tomorrow"
        else:
            day_label = ev_date.strftime("%a, %b %d")
        lines.append(f"- **{day_label}**: {desc}")

    if annual_milestones and len(lines) < 6:
        lines.append(f"- **Notable Milestones**: {'; '.join(annual_milestones[:3])}")

    return "\n".join(lines)


def relevant_contacts_prompt(text: str, settings: dict | None = None) -> str:
    """Finds contacts mentioned or relevant to the user's message and formats them for the agent's context."""
    if not text or len(text.strip()) < 3:
        return ""

    text_lower = text.lower()
    try:
        with db.conn() as c:
            rows = c.execute("SELECT id, title, meta, body FROM codex_entries WHERE kind='contact' AND status IN ('ok', 'draft')").fetchall()
    except Exception:
        return ""

    if not rows:
        return ""

    general_query = bool(re.search(r"\b(contacts?|address\s*book|people|friends?|family|coworkers?|sister|brother|husband|mother|father)\b", text_lower))

    matched = []
    for r in rows:
        title = (r["title"] or "").strip()
        if not title:
            continue
        meta = json.loads(r["meta"] or "{}")
        body = (r["body"] or "").strip()
        role = str(meta.get("role") or "").strip()
        comp = str(meta.get("company") or "").strip()

        tokens = [t.lower() for t in re.split(r"[\s,\.\-_]+", title) if len(t) >= 3]
        tokens += [str(a).strip().lower() for a in meta.get("aka") or [] if len(str(a).strip()) >= 3]
        if role and len(role) >= 4:
            tokens.append(role.lower())
        if comp and len(comp) >= 3:
            tokens.append(comp.lower())

        is_match = False
        if title.lower() in text_lower:
            is_match = True
        else:
            for t in tokens:
                if re.search(r"\b" + re.escape(t) + r"\b", text_lower):
                    is_match = True
                    break

        if is_match or (general_query and len(matched) < 6):
            role_comp = " at ".join(p for p in (role, comp) if p)
            bits = []
            if role_comp:
                bits.append(role_comp)
            if meta.get("email"):
                bits.append(f"email: {meta['email']}")
            if meta.get("phone"):
                bits.append(f"phone: {meta['phone']}")
            if meta.get("location"):
                bits.append(f"location: {meta['location']}")
            if meta.get("birthday"):
                bits.append(f"birthday: {meta['birthday']}")

            desc = " · ".join(bits)
            body_snippet = f" — {body[:140]}" if body else ""
            matched.append(f"- **{title}**" + (f" ({desc})" if desc else "") + body_snippet)

    if not matched:
        return ""

    return "## Relevant Contacts (from Codex)\n" + "\n".join(matched[:6])


def _is_owner_name(name: str) -> bool:
    nl = name.strip().lower()
    if nl in ("user", "owner", "self", "me", "i"):
        return True
    try:
        from feedback import _owner_name
        owner = _owner_name().strip().lower()
        if owner and (nl == owner or owner in nl or nl in owner):
            return True
    except Exception:
        pass
    return False


def auto_save_contact(c: dict, mode: str = "auto", source: str | None = None) -> dict | None:
    name = str(c.get("name") or c.get("title") or "").strip()
    if not name or len(name) < 2:
        return None
    if _is_owner_name(name):
        return None

    meta = {k: str(c[k]).strip() for k in ("role", "company", "email", "phone", "location", "birthday", "pronouns", "avatar")
            if c.get(k) and str(c[k]).strip()}
    body = str(c.get("notes") or c.get("body") or "").strip()
    tags = list(c.get("tags") or ["auto"])

    with db.conn() as conn:
        existing = conn.execute("SELECT id, title, meta, body FROM codex_entries WHERE kind='contact' AND lower(trim(title))=?",
                                (name.lower(),)).fetchone()
        if not existing:  # a nickname kept on another contact ("Maika" on Dunja) is that person, not someone new
            for r in conn.execute("SELECT id, title, meta, body FROM codex_entries WHERE kind='contact' AND meta LIKE '%\"aka\"%'"):
                if name.lower() in (str(a).strip().lower() for a in json.loads(r["meta"] or "{}").get("aka") or []):
                    existing = r
                    break

    if existing:
        old_meta = json.loads(existing["meta"] or "{}")
        updated_meta = {**old_meta, **{k: v for k, v in meta.items() if not old_meta.get(k)}}
        updated_body = existing["body"] or ""
        if body and body not in updated_body:
            updated_body = (updated_body + "\n\n" + body).strip()
        update(existing["id"], {"meta": updated_meta, "body": updated_body})
        return get(existing["id"])

    draft = (mode == "review")
    entry = create({"kind": "contact", "title": name, "meta": meta, "body": body, "tags": tags},
                   created_by="auto", draft=draft)
    if draft:
        import activity
        activity.post("codex", "review", f"Contact draft: {name}", entry.get("preview") or "",
                      "#/codex/drafts", ref=f"codex-draft:{entry['id']}")
    return entry


def auto_save_event(e: dict, mode: str = "auto", source: str | None = None) -> dict | None:
    title = str(e.get("title") or "").strip()
    if not title:
        return None
    start_date = str(e.get("startDate") or e.get("date") or "").strip()
    meta = {
        "startDate": start_date,
        "startTime": str(e.get("startTime") or e.get("time") or "").strip(),
        "endDate": str(e.get("endDate") or "").strip(),
        "endTime": str(e.get("endTime") or "").strip(),
        "allDay": bool(e.get("allDay", not (e.get("startTime") or e.get("time")))),
        "location": str(e.get("location") or "").strip(),
        "attendees": list(e.get("attendees") or []),
        "recurrence": str(e.get("recurrence") or "none").strip(),
        "status": str(e.get("status") or "confirmed").strip(),
    }
    meta = {k: v for k, v in meta.items() if v}
    body = str(e.get("notes") or e.get("body") or "").strip()
    tags = list(e.get("tags") or ["auto"])

    with db.conn() as conn:
        existing = conn.execute("SELECT id, title, meta, body FROM codex_entries WHERE kind='event' AND lower(trim(title))=?",
                                (title.lower(),)).fetchone()

    if existing:
        old_meta = json.loads(existing["meta"] or "{}")
        updated_meta = {**old_meta, **{k: v for k, v in meta.items() if not old_meta.get(k)}}
        update(existing["id"], {"meta": updated_meta})
        return get(existing["id"])

    draft = (mode == "review")
    entry = create({"kind": "event", "title": title, "meta": meta, "body": body, "tags": tags},
                   created_by="auto", draft=draft)
    if draft:
        import activity
        activity.post("codex", "review", f"Calendar draft: {title}", entry.get("preview") or "",
                      "#/codex/drafts", ref=f"codex-draft:{entry['id']}")
    return entry


POPULATE_MEMORIES_PROMPT = """You are an expert personal data assistant. Read these memories about the user and extract all people (contacts) and notable calendar events/milestones (birthdays, anniversaries, memorials, recurring dates, appointments).

Memories:
{listing}

Rules:
1. Contacts: Real people mentioned (friends, family, coworkers, partners, specialists).
   - name: Full or known name
   - role: Relationship (e.g. Husband, Younger Sister, Best Friend, Mother, Father) or professional title
   - company: Company/organization if mentioned
   - email: Email address if mentioned
   - phone: Phone number if mentioned
   - location: City, state, country or address if mentioned
   - birthday: Birthday (YYYY-MM-DD or MM-DD) if mentioned
   - notes: Markdown description summarizing key facts known about them
2. Events: Specific dated events or recurring milestones (e.g. Wedding Anniversary, Birthdays, Memorials, meetings).
   - title: Event title
   - startDate: YYYY-MM-DD or MM-DD
   - recurrence: "yearly" for annual milestones (birthdays, anniversaries, memorials), "weekly", "monthly", or "none"
   - attendees: List of contact names who attend/are celebrated
   - location: Location if mentioned
   - notes: Description/context
3. Do not create a contact for the user/owner themselves.
4. Return JSON only with this exact shape:
{{"contacts": [{{"name": "...", "role": "...", "company": "...", "email": "...", "phone": "...", "location": "...", "birthday": "...", "notes": "..."}}],
  "events": [{{"title": "...", "startDate": "...", "recurrence": "...", "attendees": [...], "location": "...", "notes": "..."}}]}}"""


async def populate_from_memories(settings: dict | None = None, mode: str = "auto") -> dict:
    from agent import OLLAMA
    settings = settings or {**db.kv_get("settings", {})}
    model = settings.get("utilityModel", "ShellB-Swift")

    with db.conn() as c:
        rows = c.execute("SELECT id, category, text FROM memories WHERE status='active'").fetchall()

    keywords = {"husband", "wife", "sister", "brother", "friend", "father", "mother", "parent", "partner",
                "married", "wedding", "born", "birthday", "anniversary", "died", "memorial", "dr.", "doctor",
                "boss", "coworker", "colleague", "manager", "client", "dentist", "appointment", "meeting"}
    relevant = []
    for r in rows:
        cat = r["category"] or ""
        text_lower = (r["text"] or "").lower()
        if cat in ("person", "routine", "identity", "work") or any(k in text_lower for k in keywords):
            relevant.append(f"- [{cat}] {r['text']}")

    if not relevant:
        return {"created": {"contacts": 0, "events": 0}, "updated": {"contacts": 0, "events": 0}, "contacts": [], "events": []}

    prompt = POPULATE_MEMORIES_PROMPT.format(listing="\n".join(relevant))
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "format": "json",
        "think": False,
        "keep_alive": "2h",
        "options": {"temperature": 0.1, "num_predict": 2000}
    }

    try:
        async with httpx.AsyncClient(timeout=90) as client:
            res = await client.post(f"{OLLAMA}/api/chat", json=payload)
            res.raise_for_status()
        raw = res.json()["message"]["content"] or ""
    except Exception as e:
        print(f"codex.populate_from_memories LLM error: {e}")
        return {"error": str(e), "created": {"contacts": 0, "events": 0}, "updated": {"contacts": 0, "events": 0}}

    raw = re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.M).strip()
    try:
        data = json.loads(raw)
    except ValueError:
        m = re.search(r"\{.*\}", raw, re.S)
        data = json.loads(m.group(0)) if m else {}

    contacts = data.get("contacts", []) if isinstance(data.get("contacts"), list) else []
    events = data.get("events", []) if isinstance(data.get("events"), list) else []

    created_c, updated_c = [], []
    created_e, updated_e = [], []

    for c_item in contacts:
        if not isinstance(c_item, dict) or not c_item.get("name"):
            continue
        name = str(c_item["name"]).strip()
        if _is_owner_name(name):
            continue
        with db.conn() as conn:
            existing = conn.execute("SELECT id, title FROM codex_entries WHERE kind='contact' AND lower(trim(title))=?", (name.lower(),)).fetchone()
        entry = auto_save_contact(c_item, mode=mode)
        if entry:
            if existing:
                updated_c.append(entry)
            else:
                created_c.append(entry)

    for e_item in events:
        if not isinstance(e_item, dict) or not e_item.get("title"):
            continue
        title = str(e_item["title"]).strip()
        with db.conn() as conn:
            existing = conn.execute("SELECT id, title FROM codex_entries WHERE kind='event' AND lower(trim(title))=?", (title.lower(),)).fetchone()
        entry = auto_save_event(e_item, mode=mode)
        if entry:
            if existing:
                updated_e.append(entry)
            else:
                created_e.append(entry)

    if created_c or created_e or updated_c or updated_e:
        import activity
        activity.post("codex", "done" if mode == "auto" else "review",
                      f"Codex: Populated {len(created_c)} contacts and {len(created_e)} events from memories",
                      f"Updated {len(updated_c)} contacts and {len(updated_e)} events.",
                      "#/codex/contacts")

    return {
        "created": {"contacts": len(created_c), "events": len(created_e)},
        "updated": {"contacts": len(updated_c), "events": len(updated_e)},
        "contacts": created_c + updated_c,
        "events": created_e + updated_e
    }


def catalog() -> str:
    cols = collections()
    with db.conn() as c:
        unfiled = c.execute("SELECT count(*) FROM codex_entries WHERE collection_id IS NULL").fetchone()[0]
    parts = [f"{x['name']} ({x['count']})" for x in cols] + ([f"unfiled ({unfiled})"] if unfiled else [])
    return ", ".join(parts)


def _line(e) -> str:
    bits = [e["kind"], *(["draft"] if e["draft"] else []), *(f"#{t}" for t in e["tags"][:6])]
    return f"- {e['id']} · {e['title']} [{', '.join(bits)}]" + (f" {e['url']}" if e["url"] else "")


async def codex_tool(args, ctx):
    action = str(args.get("action") or "").strip()
    try:
        if action == "collections":
            cols = collections()
            if not cols:
                return ToolResult("No collections yet; everything is unfiled. " + (catalog() or "The Codex is empty."))
            return ToolResult("\n".join(f"- {x['name']} ({x['count']} entries){': ' + x['description'] if x['description'] else ''}"
                                        for x in cols))
        if action == "list":
            cid = _collection_id(args.get("collection")) if args.get("collection") else None
            items = sorted(_filtered(cid, args.get("kind"), (_tags(args.get("tag")) or [None])[0]).values(),
                           key=lambda e: -e["updatedAt"])
            if not items:
                return ToolResult("Nothing matches.")
            return ToolResult("\n".join(_line(e) for e in items[:60]) + (f"\n…and {len(items) - 60} more; search instead."
                                                                         if len(items) > 60 else ""))
        if action == "search":
            q = str(args.get("query") or "").strip()
            if not q:
                return ToolResult("search needs `query`.", error=True)
            cid = _collection_id(args.get("collection")) if args.get("collection") else None
            hits = await search(q, int(args.get("k") or 6), cid, args.get("kind"))
            if not hits:
                return ToolResult("Nothing in the Codex matches. " + (f"Collections: {catalog()}" if catalog() else "The Codex is empty."))
            return ToolResult("\n\n".join(f"{_line(h)} (score {h['score']})\n{h['passage'] or h['preview']}" for h in hits)
                              + "\n\nRead an entry in full with codex action=read id=….",
                              {"codex": [{"id": h["id"], "title": h["title"]} for h in hits]})
        if action == "request":
            import codex_secrets
            plan = codex_secrets.prepare(args)
            if isinstance(plan, ToolResult):
                return plan
            if plan["ask"]:  # agent.py asks the owner before it gets here; anywhere else, refuse
                return ToolResult("This request needs the owner's approval, which isn't available here.", error=True)
            return await codex_secrets.perform(plan, ctx)
        if action == "read":
            e = get(str(args.get("id") or "").strip(), full=True)
            if not e:
                import codex_secrets
                e = codex_secrets.by_name(str(args.get("id") or "").strip())
                e = get(e["id"], full=True) if e else None
            if not e:
                return ToolResult("No such entry. Search or list first to get its id.", error=True)
            if e["kind"] == "secret":
                import codex_secrets
                return ToolResult(codex_secrets.describe(e))
            if e["kind"] == "contact":
                m = e.get("meta") or {}
                lines = [f"# {e['title']} [contact]", _line(e)]
                if m.get("role") or m.get("company"):
                    lines.append(f"- Role: {' at '.join(p for p in (m.get('role'), m.get('company')) if p)}")
                emails = m.get("emails") or ([m.get("email")] if m.get("email") else [])
                if emails:
                    lines.append(f"- Email: {', '.join(str(x) for x in emails if x)}")
                phones = m.get("phones") or ([m.get("phone")] if m.get("phone") else [])
                if phones:
                    lines.append(f"- Phone: {', '.join(str(x) for x in phones if x)}")
                if m.get("location"):
                    lines.append(f"- Location: {m['location']}")
                if m.get("birthday"):
                    lines.append(f"- Birthday: {m['birthday']}")
                if m.get("pronouns"):
                    lines.append(f"- Pronouns: {m['pronouns']}")
                if m.get("urls"):
                    lines.append(f"- Links: {', '.join(str(x) for x in m['urls'] if x)}")
                if e["body"]:
                    lines.append(f"\n## Notes\n{e['body']}")
                return ToolResult("\n".join(lines))
            if e["kind"] == "event":
                m = e.get("meta") or {}
                lines = [f"# {e['title']} [event]", _line(e)]
                d = m.get("date") or ""
                if d:
                    time_part = f" {m['time']}" if m.get("time") and not m.get("allDay") else ""
                    end_d = m.get("endDate") or ""
                    end_t = f" {m['endTime']}" if m.get("endTime") and not m.get("allDay") else ""
                    if end_d and end_d != d:
                        lines.append(f"- Date: {d}{time_part} to {end_d}{end_t}")
                    elif end_t:
                        lines.append(f"- Date & Time: {d}{time_part} to{end_t}")
                    else:
                        lines.append(f"- Date: {d}{time_part}" + (" (all day)" if m.get("allDay") else ""))
                if m.get("location"):
                    lines.append(f"- Location: {m['location']}")
                if m.get("attendees"):
                    lines.append(f"- Attendees: {', '.join(str(x) for x in m['attendees'] if x)}")
                if m.get("recurrence") and m.get("recurrence") != "none":
                    lines.append(f"- Recurrence: {m['recurrence']}")
                if m.get("status"):
                    lines.append(f"- Status: {m['status']}")
                if e["body"]:
                    lines.append(f"\n## Details / Agenda\n{e['body']}")
                return ToolResult("\n".join(lines))
            start = max(0, int(args.get("start") or 0))
            parts = [f"# {e['title']}", _line(e)]
            if e["body"]:
                parts.append(("```" + e["language"] + "\n" + e["body"] + "\n```") if e["kind"] == "snippet" else e["body"])
            if e["text"]:
                label = "Saved copy of the page (untrusted web content)" if e["kind"] == "link" else "Extracted text"
                parts.append(f"## {label}\n{e['text']}")
            text = "\n\n".join(parts)
            chunk = text[start:start + READ_LIMIT]
            more = len(text) - start - len(chunk)
            return ToolResult(chunk + (f"\n\n[… {more} more characters; read again with start={start + len(chunk)}]" if more > 0 else ""))
        if action in ("add", "update"):
            who = f"agent:{ctx.agent.get('id', '')}"
            fields = {k: args[k] for k in ("kind", "title", "body", "url", "language", "tags", "collection", "meta") if k in args}
            if fields.get("kind") == "person":
                fields["kind"] = "contact"
            if "collection" in fields:
                fields["collectionId"] = fields.pop("collection")
            if action == "add":
                if fields.get("kind") == "secret":
                    return ToolResult("Agents can't create secrets. Ask the owner to add it in the Codex (Secret), then use "
                                      "it by name.", error=True)
                k = fields.get("kind") or "note"
                if k not in ("contact", "event") and not (fields.get("body") or fields.get("url")):
                    return ToolResult("add needs `body` (or `url` for a link).", error=True)
                if not (fields.get("body") or fields.get("url") or fields.get("title")):
                    return ToolResult("add needs `title` or `body`.", error=True)
                e = create(fields, created_by=who, draft=True)
                import activity
                activity.post("codex", "review", f"Codex draft from {ctx.agent.get('name', 'an agent')}: {e['title']}",
                              e["preview"], f"#/codex/drafts", ref=f"codex-draft:{e['id']}")
                return ToolResult(f"Saved as a draft ({e['id']}); it shows in the Codex under Drafts until the owner accepts it.",
                                  {"codex": [{"id": e["id"], "title": e["title"]}]})
            e = get(str(args.get("id") or ""))
            if not e:
                return ToolResult("No such entry.", error=True)
            if not (e["draft"] and e["createdBy"] == who):
                return ToolResult("You can only change drafts you added. Ask the owner to edit accepted entries, or add a new draft.",
                                  error=True)
            fields.pop("kind", None)
            e = update(e["id"], fields)
            return ToolResult(f"Updated draft {e['id']}.")
        if action == "auto_populate":
            res = await populate_from_memories()
            created_c = res.get("created", {}).get("contacts", 0)
            created_e = res.get("created", {}).get("events", 0)
            updated_c = res.get("updated", {}).get("contacts", 0)
            updated_e = res.get("updated", {}).get("events", 0)
            return ToolResult(f"Auto-populated from memories: {created_c} contacts and {created_e} events created, {updated_c} contacts and {updated_e} events updated.")
        return ToolResult("action is one of search, read, list, collections, add, update, auto_populate, request.", error=True)
    except ValueError as ex:
        return ToolResult(str(ex), error=True)


def register():
    TOOLS["codex"] = {
        "fn": codex_tool, "service": None, "scope": "global", "auto": "for every agent (cloud agents need Cloud → Codex)",
        "ui": {"displayName": "Codex", "icon": "BookMarked", "category": "memory",
               "description": "The owner's long-term reference shelf: notes, saved links, snippets, files, contacts and calendar events. Agents search and "
                              "read it, and can add drafts for the owner to accept."},
        "schema": _fn("codex",
                      "The owner's long-term reference shelf (notes, saved links with page copies, snippets, files, contacts, events). "
                      "Upcoming calendar events and relevant contacts are automatically provided in context; search for deeper queries. "
                      "search (query) → matching entries with the best passage; read (id, start) → full text; list "
                      "(collection, kind, tag); collections; add (kind, title, body, url, language, tags, collection, meta) → a "
                      "draft the owner accepts; update (id, …) → only your own drafts; auto_populate → auto-extract contacts and events from memories; "
                      "request (url, method, headers, body) → an https API call where {{secret:NAME}} stands for a stored secret you never see.",
                      {"action": {"type": "string", "enum": ["search", "read", "list", "collections", "add", "update", "auto_populate", "request"]},
                       "query": {"type": "string"},
                       "id": {"type": "string", "description": "Entry id (cx-…)"},
                       "collection": {"type": "string", "description": "Collection name or id"},
                       "kind": {"type": "string", "enum": list(KINDS)},
                       "tag": {"type": "string"},
                       "title": {"type": "string"}, "body": {"type": "string", "description": "Markdown for notes/bio/agenda, the code for snippets"},
                       "url": {"type": "string"}, "language": {"type": "string", "description": "Snippet language"},
                       "tags": {"type": "array", "items": {"type": "string"}},
                       "meta": {"type": "object", "description": "Details for contacts (role, company, email, phone, location, birthday) or events (date, time, endDate, endTime, allDay, location, attendees)"},
                       "method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]},
                       "headers": {"type": "object", "description": "request: e.g. {\"Authorization\": \"Bearer {{secret:NAME}}\"}"},
                       "k": {"type": "integer"}, "start": {"type": "integer"}}, ["action"]),
    }


# ── HTTP ────────────────────────────────────────────────────────────────────

def _err(e):
    raise HTTPException(400, str(e))


@router.get("")
def api_index():
    with db.conn() as c:
        total = c.execute("SELECT count(*) FROM codex_entries").fetchone()[0]
        drafts = c.execute("SELECT count(*) FROM codex_entries WHERE status='draft'").fetchone()[0]
        pinned = c.execute("SELECT count(*) FROM codex_entries WHERE pinned=1").fetchone()[0]
        unfiled = c.execute("SELECT count(*) FROM codex_entries WHERE collection_id IS NULL").fetchone()[0]
        contacts = c.execute("SELECT count(*) FROM codex_entries WHERE kind='contact'").fetchone()[0]
        events = c.execute("SELECT count(*) FROM codex_entries WHERE kind='event'").fetchone()[0]
        secrets = c.execute("SELECT count(*) FROM codex_entries WHERE kind='secret'").fetchone()[0]
        tags: dict[str, int] = {}
        for r in c.execute("SELECT tags FROM codex_entries"):
            for t in json.loads(r["tags"] or "[]"):
                tags[t] = tags.get(t, 0) + 1
    return {"collections": collections(),
            "counts": {"all": total, "drafts": drafts, "pinned": pinned, "unfiled": unfiled, "contacts": contacts, "events": events, "secrets": secrets},
            "tags": sorted(tags.items(), key=lambda kv: (-kv[1], kv[0]))[:60]}


@router.post("/collections")
async def api_new_collection(req: Request):
    b = await req.json()
    name = str(b.get("name") or "").strip()[:80]
    if not name:
        _err("A collection needs a name.")
    with db.conn() as c:
        if c.execute("SELECT 1 FROM codex_collections WHERE lower(name)=lower(?)", (name,)).fetchone():
            _err(f"There is already a collection called {name}.")
        cid, now = db.new_id("cxc"), time.time()
        c.execute("INSERT INTO codex_collections VALUES(?,?,?,?,?,?)",
                  (cid, name, str(b.get("description") or "")[:400], str(b.get("color") or "")[:20], now, now))
    return next(x for x in collections() if x["id"] == cid)


@router.patch("/collections/{cid}")
async def api_edit_collection(cid: str, req: Request):
    b = await req.json()
    with db.conn() as c:
        for k in ("name", "description", "color"):
            if k in b:
                v = str(b[k] or "").strip()[:400]
                if k == "name" and not v:
                    _err("A collection needs a name.")
                c.execute(f"UPDATE codex_collections SET {k}=?, updated=? WHERE id=?", (v, time.time(), cid))
    return {"collections": collections()}


@router.delete("/collections/{cid}")
def api_delete_collection(cid: str, entries: bool = False):
    """Deletes a collection; its entries become unfiled unless `entries` is set."""
    with db.conn() as c:
        ids = [r["id"] for r in c.execute("SELECT id FROM codex_entries WHERE collection_id=?", (cid,))]
        c.execute("DELETE FROM codex_collections WHERE id=?", (cid,))
        if not entries:
            c.execute("UPDATE codex_entries SET collection_id=NULL WHERE collection_id=?", (cid,))
    if entries:
        for eid in ids:
            delete(eid)
    return {"collections": collections()}


@router.get("/entries")
async def api_entries(collection: str = "", kind: str = "", tag: str = "", q: str = "", view: str = ""):
    """`collection` is an id, or 'unfiled'; `view` is pinned, drafts, contacts, events, calendar or secrets."""
    if view == "contacts":
        kind = "contact"
    elif view in ("calendar", "events"):
        kind = "event"
    elif view == "secrets":
        kind = "secret"
    if q.strip():
        cid = None if collection in ("", "unfiled") else collection
        items = await search(q, 60, cid, kind or None, tag or None)
        if collection == "unfiled":
            items = [i for i in items if not i["collectionId"]]
    else:
        if kind == "event" or view in ("calendar", "events"):
            def event_key(e):
                m = e.get("meta") or {}
                d = m.get("date") or "9999-99-99"
                t = m.get("time") or "00:00" if not m.get("allDay") else "00:00"
                return (not e["pinned"], d, t)
            items = sorted(_filtered(None if collection in ("", "unfiled") else collection, kind or None, tag or None).values(),
                           key=event_key)
        elif kind == "contact" or view == "contacts":
            items = sorted(_filtered(None if collection in ("", "unfiled") else collection, kind or None, tag or None).values(),
                           key=lambda e: (not e["pinned"], e["title"].lower()))
        elif kind == "secret" or view == "secrets":
            items = sorted(_filtered(None if collection in ("", "unfiled") else collection, kind or None, tag or None).values(),
                           key=lambda e: (not e["pinned"], e["title"].lower()))
        else:
            items = sorted(_filtered(None if collection in ("", "unfiled") else collection, kind or None, tag or None).values(),
                           key=lambda e: (-e["pinned"], -e["updatedAt"]))
        if collection == "unfiled":
            items = [i for i in items if not i["collectionId"]]
    if view == "pinned":
        items = [i for i in items if i["pinned"]]
    elif view == "drafts":
        items = [i for i in items if i["draft"]]
    return items[:500]


@router.post("/entries")
async def api_create(req: Request):
    b = await req.json()
    if b.get("kind") == "secret":
        raise HTTPException(400, "Secrets are created through /api/codex/secrets.")
    try:
        return create(b)
    except ValueError as e:
        _err(e)


# ── note links ──────────────────────────────────────────────────────────────
# Notes link to each other with [[Title]] or [[Title|shown text]], matched to note titles ignoring case. Code spans
# and fences don't count, so a note about the syntax itself doesn't link anywhere.

WIKI = re.compile(r"\[\[([^\[\]|\n]+?)(?:\|[^\[\]\n]*)?\]\]")
_CODE = re.compile(r"```.*?(?:```|$)|`[^`\n]*`", re.S)


def wiki_targets(body: str) -> set[str]:
    return {m.group(1).strip().lower() for m in WIKI.finditer(_CODE.sub("", body or ""))}


@router.get("/notes/titles")
def api_note_titles():
    """Every note and contact's id and title, newest first: the [[ autocomplete and link resolution on the Notes page."""
    with db.conn() as c:
        rows = c.execute("SELECT id, title FROM codex_entries WHERE kind IN ('note', 'contact') ORDER BY updated DESC").fetchall()
    return [{"id": r["id"], "title": r["title"] or "Untitled"} for r in rows]


@router.get("/entries/{eid}/backlinks")
def api_backlinks(eid: str):
    """Notes that link here with [[Title]], each with the line the link sits on."""
    e = get(eid)
    if not e:
        raise HTTPException(404, "No such entry.")
    want = e["title"].strip().lower()
    out = []
    with db.conn() as c:
        rows = c.execute("SELECT * FROM codex_entries WHERE kind='note' AND id<>? AND body LIKE '%[[%' "
                         "ORDER BY updated DESC", (eid,)).fetchall()
    for r in rows:
        body = r["body"] or ""
        if want not in wiki_targets(body):
            continue
        line = next((ln.strip() for ln in body.splitlines()
                     if any(m.group(1).strip().lower() == want for m in WIKI.finditer(ln))), "")
        out.append({"id": r["id"], "title": r["title"] or "Untitled", "line": line[:240], "updatedAt": r["updated"] * 1000})
    return out


def relink(eid: str, old: str, new: str) -> dict:
    """After a note is renamed, points [[old]] and [[old|text]] in other notes at the new title. Skipped when another
    note still has the old title (the links may mean that one) or already has the new one (they would merge)."""
    old, new = old.strip(), new.strip()
    if not old or not new or old.lower() == new.lower():
        return {"updated": []}
    with db.conn() as c:
        clash = c.execute("SELECT title FROM codex_entries WHERE kind='note' AND id<>? AND lower(trim(title)) IN (?, ?)",
                          (eid, old.lower(), new.lower())).fetchone()
        rows = c.execute("SELECT id, title, body FROM codex_entries WHERE kind='note' AND id<>? AND body LIKE '%[[%'",
                         (eid,)).fetchall()
    if clash:
        return {"updated": [], "skipped": f"another note is called {clash['title']}"}

    def fix(m):
        if m.group(1).strip().lower() != old.lower():
            return m.group(0)
        alias = m.group(0)[2 + len(m.group(1)):-2]   # "|text" or ""
        return f"[[{new}{alias}]]"

    updated = []
    for r in rows:
        parts = re.split(f"({_CODE.pattern})", r["body"] or "", flags=re.S)
        body = "".join(p if i % 2 else WIKI.sub(fix, p) for i, p in enumerate(parts))
        if body != r["body"]:
            update(r["id"], {"body": body})
            updated.append({"id": r["id"], "title": r["title"] or "Untitled"})
    return {"updated": updated}


@router.post("/entries/{eid}/relink")
async def api_relink(eid: str, req: Request):
    """`from` is the title the note had; `to` is its new one (sent with the save that renames it, so both can go out as
    the tab closes)."""
    b = await req.json()
    e = get(eid)
    if not e or e["kind"] != "note":
        raise HTTPException(404, "No such note.")
    return relink(eid, str(b.get("from") or ""), str(b.get("to") or e["title"]))


@router.get("/entries/{eid}")
def api_entry(eid: str):
    e = get(eid, full=True)
    if not e:
        raise HTTPException(404, "No such entry.")
    return e


@router.patch("/entries/{eid}")
async def api_patch(eid: str, req: Request):
    try:
        return update(eid, await req.json())
    except KeyError:
        raise HTTPException(404, "No such entry.")
    except ValueError as e:
        _err(e)


@router.delete("/entries/{eid}")
def api_delete(eid: str):
    delete(eid)
    return {"ok": True}


@router.post("/entries/{eid}/snapshot")
def api_resnap(eid: str):
    e = get(eid)
    if not e or e["kind"] != "link":
        raise HTTPException(404, "No such link.")
    _set_meta(eid, snapshot={"status": "pending"})
    _spawn(snapshot(eid))
    return get(eid)


@router.post("/upload")
async def api_upload(files: list[UploadFile] = File(...), collectionId: str = Form(""), tags: str = Form("")):
    out = []
    for f in files:
        name = re.sub(r"[^\w.\- ()]+", "_", Path(f.filename or "file").name).strip() or "file"
        e = create({"kind": "file", "title": Path(name).stem[:200], "collectionId": collectionId, "tags": tags})
        dest = _dir(e["id"]) / name
        size = 0
        with dest.open("wb") as fh:
            while chunk := await f.read(1 << 20):
                size += len(chunk)
                if size > MAX_FILE:
                    fh.close()
                    delete(e["id"])
                    raise HTTPException(413, f"{name} is larger than 100 MB.")
                fh.write(chunk)
        _set_meta(e["id"], file=name, size=size, mime=f.content_type or "")
        _spawn(index(e["id"]))
        out.append(get(e["id"]))
    return out


INLINE = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".pdf"}


@router.get("/file/{eid}")
def api_file(eid: str, download: bool = False):
    e = get(eid)
    if not e or not e["meta"].get("file"):
        raise HTTPException(404, "No file.")
    path = _dir(eid) / e["meta"]["file"]
    if not path.exists():
        raise HTTPException(404, "No file.")
    inline = path.suffix.lower() in INLINE and not download
    # never let an uploaded HTML/SVG file run as a page at the app's origin
    return FileResponse(path, filename=path.name, content_disposition_type="inline" if inline else "attachment",
                        headers={"Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff"})


AVATAR_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"}


@router.post("/avatar")
async def api_upload_avatar(file: UploadFile = File(...)):
    """Uploads a standalone avatar file (e.g. for a new contact before saving)."""
    name = Path(file.filename or "avatar.png").name
    ext = Path(name).suffix.lower()
    if ext not in AVATAR_EXTS:
        ext = ".png"
    avid = f"av-{uuid.uuid4().hex[:12]}{ext}"
    avatars_dir = ROOT / "avatars"
    avatars_dir.mkdir(parents=True, exist_ok=True)
    dest = avatars_dir / avid
    size = 0
    with dest.open("wb") as fh:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > 10 * 1024 * 1024:
                fh.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(413, "Avatar file exceeds 10 MB limit.")
            fh.write(chunk)
    return {"ok": True, "url": f"/api/codex/avatars/{avid}"}


@router.get("/avatars/{filename}")
def api_get_avatar(filename: str):
    """Serves a standalone avatar image."""
    if not re.fullmatch(r"av-[0-9a-f]{12}\.(png|jpg|jpeg|webp|gif|avif)", filename):
        raise HTTPException(404, "Invalid avatar filename.")
    path = ROOT / "avatars" / filename
    if not path.is_file():
        raise HTTPException(404, "Avatar not found.")
    return FileResponse(path, headers={"Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff"})


@router.post("/entries/{eid}/avatar")
async def api_entry_avatar(eid: str, req: Request, file: UploadFile = File(None)):
    """Uploads a photo file or sets an avatar URL for a contact."""
    e = get(eid)
    if not e:
        raise HTTPException(404, "No such entry.")

    avatar_url = None
    if file and file.filename:
        ext = Path(file.filename).suffix.lower()
        if ext not in AVATAR_EXTS:
            ext = ".png"
        dest_name = f"avatar{ext}"
        entry_dir = _dir(eid)
        entry_dir.mkdir(parents=True, exist_ok=True)
        for p in entry_dir.glob("avatar.*"):
            p.unlink(missing_ok=True)
        dest = entry_dir / dest_name
        size = 0
        with dest.open("wb") as fh:
            while chunk := await file.read(1 << 20):
                size += len(chunk)
                if size > 10 * 1024 * 1024:
                    fh.close()
                    dest.unlink(missing_ok=True)
                    raise HTTPException(413, "Avatar file exceeds 10 MB limit.")
                fh.write(chunk)
        avatar_url = f"/api/codex/entries/{eid}/avatar?v={int(time.time())}"
    else:
        try:
            body = await req.json()
            avatar_url = str(body.get("url") or "").strip()
        except Exception:
            pass

    if not avatar_url:
        raise HTTPException(400, "No file or image URL provided.")

    updated = update(eid, {"meta": {"avatar": avatar_url}})
    return {"ok": True, "avatar": avatar_url, "entry": updated}


@router.get("/entries/{eid}/avatar")
def api_get_entry_avatar(eid: str):
    """Serves the avatar image for an entry."""
    entry_dir = _dir(eid)
    files = list(entry_dir.glob("avatar.*"))
    if not files:
        raise HTTPException(404, "No avatar for this entry.")
    return FileResponse(files[0], headers={"Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff"})


@router.delete("/entries/{eid}/avatar")
async def api_delete_entry_avatar(eid: str):
    """Removes the avatar image from an entry."""
    e = get(eid)
    if not e:
        raise HTTPException(404, "No such entry.")
    entry_dir = _dir(eid)
    for p in entry_dir.glob("avatar.*"):
        p.unlink(missing_ok=True)
    updated = update(eid, {"meta": {"avatar": ""}})
    return {"ok": True, "entry": updated}


@router.post("/generate-portrait")
async def api_generate_portrait(req: Request):
    """Generates an AI portrait headshot for a contact using NYX / ComfyUI FLUX."""
    body = await req.json()
    prompt = str(body.get("prompt") or "").strip()
    name = str(body.get("name") or "").strip()
    role = str(body.get("role") or "").strip()
    eid = str(body.get("entryId") or "").strip()

    if not prompt:
        details = [f"name {name}" if name else "", f"role {role}" if role else ""]
        details_str = ", ".join(d for d in details if d)
        prompt = f"Professional studio headshot portrait photography of a person ({details_str}), clean sharp focus, cinematic soft studio lighting, high resolution, 8k uhd, masterpiece"

    try:
        from tools import COMFY, _flux_workflow, make_room
        keep = set()
        await make_room(28, keep)

        seed = int(time.time() * 1000) % (2**32 - 1)
        wf = _flux_workflow(prompt, 1024, 1024, seed, quality="draft")

        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(f"{COMFY}/prompt", json={"prompt": wf, "client_id": uuid.uuid4().hex})
            r.raise_for_status()
            pid = r.json().get("prompt_id")

            deadline = time.time() + 180
            outputs = None
            while time.time() < deadline:
                await asyncio.sleep(1.0)
                try:
                    h = (await c.get(f"{COMFY}/history/{pid}")).json()
                except Exception:
                    continue
                if pid in h:
                    outputs = h[pid].get("outputs")
                    if outputs:
                        break

            if not outputs:
                raise HTTPException(504, "Portrait generation timed out.")

            img_item = None
            for node in outputs.values():
                for img in node.get("images", []):
                    img_item = img
                    break
                if img_item:
                    break

            if not img_item:
                raise HTTPException(500, "No image generated by NYX.")

            view_res = await c.get(f"{COMFY}/view", params={"filename": img_item["filename"],
                                                            "subfolder": img_item.get("subfolder", ""),
                                                            "type": img_item.get("type", "output")})
            img_data = view_res.content
    except HTTPException:
        raise
    except Exception as err:
        raise HTTPException(503, f"NYX portrait generation failed: {err}")

    if eid and re.fullmatch(r"cx-[0-9a-f]{12}", eid):
        entry_dir = _dir(eid)
        entry_dir.mkdir(parents=True, exist_ok=True)
        for p in entry_dir.glob("avatar.*"):
            p.unlink(missing_ok=True)
        dest = entry_dir / "avatar.png"
        dest.write_bytes(img_data)
        avatar_url = f"/api/codex/entries/{eid}/avatar?v={int(time.time())}"
        updated = update(eid, {"meta": {"avatar": avatar_url}})
        return {"ok": True, "url": avatar_url, "entry": updated}
    else:
        avid = f"av-{uuid.uuid4().hex[:12]}.png"
        avatars_dir = ROOT / "avatars"
        avatars_dir.mkdir(parents=True, exist_ok=True)
        dest = avatars_dir / avid
        dest.write_bytes(img_data)
        return {"ok": True, "url": f"/api/codex/avatars/{avid}"}


@router.post("/from-memory")
async def api_from_memory(req: Request):
    """Moves a memory into the Codex as a note, and forgets the memory."""
    b = await req.json()
    mem = next((m for m in db.all_memories() if m["id"] == b.get("memoryId")), None)
    if not mem:
        raise HTTPException(404, "No such memory.")
    try:
        e = create({"kind": "note", "title": str(b.get("title") or mem["text"][:80]).strip(), "body": mem["text"],
                    "tags": mem.get("tags") or [], "collectionId": b.get("collectionId") or ""})
    except ValueError as ex:
        _err(ex)
    db.delete_memory(mem["id"])
    return e


@router.post("/populate-from-memories")
async def api_populate_from_memories(req: Request):
    """Auto-populates contacts and events into the Codex from user memories."""
    try:
        b = await req.json()
    except Exception:
        b = {}
    mode = str(b.get("mode") or "auto")
    return await populate_from_memories(mode=mode)

