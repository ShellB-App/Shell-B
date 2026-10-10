"""Research notebooks, in the spirit of NotebookLM: the Research Board's sources become a grounded knowledge base.

Every source (an uploaded file, a web page, pasted text, or a page an agent read) is extracted, chunked and embedded;
it gets a source guide (summary + key topics), and the notebook gets an overview with suggested questions. The notebook
chat answers only from the selected sources, citing the exact passages. Studio turns the sources into briefing docs,
study guides, FAQs, timelines, mind maps, flashcards, quizzes and a two-host Audio Overview (script by the LLM, voices
by HERMES/Kokoro). Agent research (Minerva's research_board tool) keeps working and feeds the same notebook.
"""
import asyncio
import io
import logging
import json
import re
import shutil
import time
import wave
from pathlib import Path
from urllib.parse import urlparse

import httpx
import numpy as np
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

import db
import groups
import ids
import providers
import research
from tools import GUARD_HOOKS, OLLAMA, SEARXNG, UA, _blocked_host, embed

router = APIRouter()
log = logging.getLogger("shellb.notebook")
ROOT = db.DATA / "research"
HERMES = "http://localhost:8001"
MAX_FILE = 100 * 1024 * 1024
CONTEXT_BUDGET = 60_000      # characters of source text a Studio generation reads
VOICES = ("af_heart", "am_michael")   # Audio Overview hosts: Alex, Sam
_TASKS: set = set()
_LOOP: asyncio.AbstractEventLoop | None = None
_ingest_gate = asyncio.Semaphore(2)
# Ollama serves 2 requests at once: background work (Studio, guides) takes one slot, so chat always has the other
_llm_gate = asyncio.Semaphore(1)
_studio_gate = asyncio.Semaphore(1)
_guide_pending: set[str] = set()
_RUNNING: dict[str, str] = {}   # job key → what it is, for /api/status (so restarts can wait for them)


def running_now():
    return sorted(_RUNNING.values())


class _job:
    def __init__(self, key, what):
        self.key, self.what = key, what

    def __enter__(self):
        _RUNNING[self.key] = self.what

    def __exit__(self, *exc):
        _RUNNING.pop(self.key, None)


def init():
    with db.conn() as c:
        c.executescript("""
CREATE TABLE IF NOT EXISTS research_chunks(
  board_id TEXT, item_id TEXT, idx INTEGER, text TEXT, embedding BLOB, PRIMARY KEY(item_id, idx));
CREATE INDEX IF NOT EXISTS research_chunks_board ON research_chunks(board_id);
CREATE TABLE IF NOT EXISTS research_chat(
  id TEXT PRIMARY KEY, board_id TEXT, role TEXT, content TEXT, data TEXT, created REAL);
CREATE INDEX IF NOT EXISTS research_chat_board ON research_chat(board_id, created);
""")
        cols = {r["name"] for r in c.execute("PRAGMA table_info(research_boards)")}
        for col in ("guide", "emoji"):
            if col not in cols:
                c.execute(f"ALTER TABLE research_boards ADD COLUMN {col} TEXT")
        # work in flight when the server stopped: outputs failed, sources get indexed again on startup
        for r in c.execute("SELECT id, kind, meta FROM research_items WHERE kind IN ('output','source')").fetchall():
            m = json.loads(r["meta"] or "{}")
            if r["kind"] == "output" and m.get("status") in ("generating", "queued", "voicing"):
                m.update(status="error", error="Interrupted by a server restart.")
            elif r["kind"] == "source" and m.get("index") == "indexing":
                m["index"] = "pending"
            else:
                continue
            c.execute("UPDATE research_items SET meta=? WHERE id=?", (json.dumps(m), r["id"]))


def _spawn(coro):
    """Start a background job from async or threadpool code alike."""
    try:
        loop = asyncio.get_running_loop()
        t = loop.create_task(coro)
        _TASKS.add(t)
        t.add_done_callback(_TASKS.discard)
    except RuntimeError:
        if _LOOP:
            _LOOP.call_soon_threadsafe(_spawn, coro)  # re-enter on the loop so the task is kept in _TASKS
        else:
            coro.close()


def start():
    """Startup: remember the loop, wire research's hooks, and index sources that have no text yet."""
    global _LOOP
    _LOOP = asyncio.get_running_loop()
    research.on_source = lambda bid, iid: _spawn(ingest(bid, iid))
    research.on_delete = _forget
    with db.conn() as c:
        rows = c.execute("SELECT board_id, id, meta FROM research_items WHERE kind='source'").fetchall()
    for r in rows:
        if json.loads(r["meta"] or "{}").get("index") not in ("ready", "no-text", "error"):
            _spawn(ingest(r["board_id"], r["id"]))


# ── storage helpers ─────────────────────────────────────────────────────────

def _bdir(bid) -> Path:
    return ROOT / ids.check("board", bid, "research board")


def _text_path(bid, iid) -> Path:
    return _bdir(bid) / "text" / f"{iid}.txt"


def source_text(bid, iid) -> str:
    p = _text_path(bid, iid)
    return p.read_text(errors="replace") if p.exists() else ""


def _patch(iid, title=None, body=None, **meta):
    """Direct update (no validation): background jobs write status, text stats and results."""
    with db.conn() as c:
        row = c.execute("SELECT * FROM research_items WHERE id=?", (iid,)).fetchone()
        if not row:
            return None
        m = {**json.loads(row["meta"] or "{}"), **meta}
        c.execute("UPDATE research_items SET title=?, body=?, meta=?, updated=? WHERE id=?",
                  (row["title"] if title is None else title, row["body"] if body is None else body, json.dumps(m), time.time(), iid))
        c.execute("UPDATE research_boards SET updated=? WHERE id=?", (time.time(), row["board_id"]))
    return research.get_item(iid)


def _forget(bid, item):
    """research.delete_item hook: drop a source's chunks and files, or an output's audio."""
    with db.conn() as c:
        c.execute("DELETE FROM research_chunks WHERE item_id=?", (item["id"],))
    for p in (_text_path(bid, item["id"]), *(_bdir(bid) / "files").glob(f"{item['id']}*"), *(_bdir(bid) / "audio").glob(f"{item['id']}*")):
        p.unlink(missing_ok=True)
    if item["kind"] == "source":
        _schedule_guide(bid)


def delete_board_data(bid):
    with db.conn() as c:
        c.execute("DELETE FROM research_chunks WHERE board_id=?", (bid,))
        c.execute("DELETE FROM research_chat WHERE board_id=?", (bid,))
    shutil.rmtree(_bdir(bid), ignore_errors=True)


def sources(bid, ids=None, ready=True):
    """Sources of a board, optionally only the given ids (else the selected ones), optionally only indexed ones."""
    out = []
    for it in research.board_detail(bid)["items"]:
        if it["kind"] != "source":
            continue
        if ids is not None and it["id"] not in ids:
            continue
        if ids is None and it["meta"].get("selected") is False:
            continue
        if ready and it["meta"].get("index") != "ready":
            continue
        out.append(it)
    return out


# ── models ──────────────────────────────────────────────────────────────────

def _agent():
    from app import find_agent
    a, _ = find_agent("minerva")
    return a


async def _opts(model):
    from agent import model_info
    info = await model_info(model)
    a = _agent()
    num_ctx = int((a.get("numCtx") if a.get("model") == model else 0) or info.get("numCtx") or 32768)
    return info, num_ctx


def _skeleton(schema):
    """A JSON-shaped example of a schema, which local models follow far better than the schema itself."""
    t = schema.get("type")
    if t == "object":
        return {k: _skeleton(v) for k, v in schema.get("properties", {}).items()}
    if t == "array":
        return [_skeleton(schema.get("items", {}))]
    if "enum" in schema:
        return "|".join(schema["enum"])
    return {"string": "…", "integer": 0, "number": 0, "boolean": False}.get(t, "…")


def _missing(data, schema):
    return [k for k in schema.get("required", []) if not isinstance(data, dict) or k not in data]


async def llm(messages, on_text=None, temperature=0.4, schema=None, max_tokens=None, priority=False):
    """One completion from Minerva's model (local or cloud). With a schema, returns parsed JSON in that shape."""
    if schema:
        shape = json.dumps(_skeleton(schema), ensure_ascii=False)
        ask = messages[:-1] + [{**messages[-1], "content": messages[-1]["content"] + "\n\nReply with ONLY a JSON object, no "
                                f"code fences or commentary, using exactly these keys and this shape:\n{shape}"}]
        for attempt in range(2):
            text = await _complete(ask, None, temperature, schema, max_tokens, priority)
            try:
                data = _json(text)
                if not _missing(data, schema):
                    return data
                err = "it is missing the keys " + ", ".join(_missing(data, schema))
            except (ValueError, json.JSONDecodeError) as e:
                err = f"it is not valid JSON ({e})"
            ask = ask + [{"role": "assistant", "content": text[:4000]},
                         {"role": "user", "content": f"That reply can't be used: {err}. Send the JSON object again with exactly "
                                                     f"these keys: {shape}"}]
        raise ValueError(f"the model did not return the expected JSON: {err}")
    return await _complete(messages, on_text, temperature, None, max_tokens, priority)


async def _complete(messages, on_text, temperature, schema, max_tokens, priority=False):
    # chat answers someone who is waiting, so it doesn't queue behind Studio jobs (Ollama interleaves them)
    async with (_nogate() if priority else _llm_gate):
        return await _complete_now(messages, on_text, temperature, schema, max_tokens)


class _nogate:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


async def _complete_now(messages, on_text, temperature, schema, max_tokens):
    model = _agent().get("model") or "ShellB-Swift"
    if providers.is_cloud(model):
        async def cb(t):
            if on_text:
                await on_text(t)
        out = await providers.stream(model, messages, None, "low", temperature, lambda t: _noop(), cb, asyncio.Event())
        return out.content
    info, num_ctx = await _opts(model)
    payload = {"model": model, "messages": messages, "stream": bool(on_text), "keep_alive": "2h",
               "options": {"temperature": temperature, "num_ctx": num_ctx, **({"num_predict": max_tokens} if max_tokens else {})}}
    if "thinking" in info["capabilities"]:
        payload["think"] = False
    if schema:
        payload["format"] = schema  # honoured by some models; the prompt carries the shape for the rest
    async with httpx.AsyncClient(timeout=httpx.Timeout(900, connect=10)) as c:
        if not on_text:
            r = await c.post(f"{OLLAMA}/api/chat", json=payload)
            r.raise_for_status()
            return r.json()["message"]["content"]
        text = ""
        async with c.stream("POST", f"{OLLAMA}/api/chat", json=payload) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line.strip():
                    continue
                piece = json.loads(line).get("message", {}).get("content", "")
                if piece:
                    text += piece
                    await on_text(piece)
        return text


async def _noop():
    return None


def _json(text):
    text = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", text or "")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        for pat in (r"\{[\s\S]*\}", r"\[[\s\S]*\]"):
            m = re.search(pat, text)
            if m:
                try:
                    return json.loads(m.group())
                except json.JSONDecodeError:
                    continue
        raise ValueError("no JSON object in the reply")


# ── ingestion ───────────────────────────────────────────────────────────────

def _is_youtube(url):
    return re.match(r"https?://(www\.|m\.)?(youtube\.com|youtu\.be)/", url or "") is not None


async def _fetch(url) -> tuple[str, str]:
    """(title, text) of a web page or online document; a direct media link is transcribed instead."""
    import transcribe
    if _is_youtube(url) or transcribe.STREAMING.match(url) or transcribe.is_media(urlparse(url).path):
        import tempfile
        tmp = Path(tempfile.mkdtemp(prefix="nb-media-", dir=db.DATA / "cells"))
        try:
            src = await transcribe.download(url, tmp)
            out = await transcribe.transcribe_path(src)
            return Path(urlparse(url).path).name, out["body"] or out["text"]
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname or _blocked_host(p.hostname):
        raise ValueError("only public http(s) addresses can be added")
    async with httpx.AsyncClient(timeout=45, follow_redirects=True, headers={"User-Agent": UA},
                                 event_hooks=GUARD_HOOKS) as c:
        r = await c.get(url)
        r.raise_for_status()
    ctype = r.headers.get("content-type", "")
    if "html" in ctype:
        import trafilatura
        meta = await asyncio.to_thread(trafilatura.extract_metadata, r.text)
        text = await asyncio.to_thread(trafilatura.extract, r.text, output_format="markdown", include_links=False,
                                       include_tables=True, url=str(r.url))
        title = (meta.title if meta and meta.title else "") or ""
        # trafilatura keeps some inline HTML (Wikipedia's <sup>[1]</sup> footnote marks); it's noise for reading and search
        text = re.sub(r"<sup\b[^>]*>.*?</sup>", "", text or "", flags=re.S)
        text = re.sub(r"</?[a-zA-Z][^>\n]{0,200}>", "", text)
        return title.strip(), text.strip()
    if ctype.startswith("text/") or "json" in ctype or "xml" in ctype:
        return "", r.text
    # PDFs, Office files and pictures: save and run them through the document reader (OCR included)
    import doc_tools
    ext = {"pdf": ".pdf", "msword": ".doc", "wordprocessingml": ".docx", "spreadsheetml": ".xlsx", "ms-excel": ".xls",
           "presentationml": ".pptx", "ms-powerpoint": ".ppt", "png": ".png", "jpeg": ".jpg", "webp": ".webp"}
    suffix = next((v for k, v in ext.items() if k in ctype), Path(p.path).suffix or ".bin")
    tmp = ROOT / "_dl" / f"{time.time_ns()}{suffix}"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_bytes(r.content)
    try:
        _, text, _ = await doc_tools.extract_any(tmp, ocr_cap=200)
    finally:
        tmp.unlink(missing_ok=True)
    return Path(p.path).name, text


async def ingest(bid, iid):
    with _job(f"ingest:{iid}", f"indexing source {iid} in {bid}"):
        await _ingest(bid, iid)


async def _ingest(bid, iid):
    """Extract, chunk, embed and summarize one source."""
    async with _ingest_gate:
        it = research.get_item(iid)
        if not it or it["kind"] != "source":
            return
        m = it["meta"]
        _patch(iid, index="indexing", error="")
        try:
            title = ""
            origin = m.get("origin") or ("url" if it["url"] else "text")
            if origin == "file":
                path = _bdir(bid) / "files" / m["file"]
                text = await asyncio.to_thread(groups.extract, path)
                if not text.strip() or path.suffix.lower() in groups.DOC_OCR_EXT:
                    import doc_tools
                    _, text, _ = await doc_tools.extract_any(path, ocr_cap=300)
            elif origin == "text":
                text = source_text(bid, iid)
            else:
                title, text = await _fetch(it["url"])
            text = (text or "").strip()
            _text_path(bid, iid).parent.mkdir(parents=True, exist_ok=True)
            _text_path(bid, iid).write_text(text)
            chunks = groups._chunks(text)
            with db.conn() as c:
                c.execute("DELETE FROM research_chunks WHERE item_id=?", (iid,))
            if chunks:
                from app import get_settings
                model = get_settings()["embeddingModel"]
                for s in range(0, len(chunks), 32):
                    batch = chunks[s:s + 32]
                    vecs = await embed(batch, model)
                    with db.conn() as c:
                        c.executemany("INSERT OR REPLACE INTO research_chunks VALUES(?,?,?,?,?)",
                                      [(bid, iid, s + j, t, np.asarray(v, dtype=np.float32).tobytes())
                                       for j, (t, v) in enumerate(zip(batch, vecs))])
            it = research.get_item(iid)
            weak_title = not it["title"] or it["title"] == it["url"] or it["addedBy"] == "auto" and "." in it["title"] and " " not in it["title"]
            _patch(iid, title=(title or it["title"]) if weak_title else None,
                   index="ready" if text else "no-text", chars=len(text), chunks=len(chunks), origin=origin)
            if text:
                await source_guide(bid, iid)
        except Exception as e:
            _patch(iid, index="error", error=f"{type(e).__name__}: {e}"[:300])
    _schedule_guide(bid)


GUIDE_SCHEMA = {"type": "object", "properties": {
    "title": {"type": "string"}, "summary": {"type": "string"},
    "topics": {"type": "array", "items": {"type": "string"}}}, "required": ["title", "summary", "topics"]}


async def source_guide(bid, iid):
    it = research.get_item(iid)
    text = source_text(bid, iid)
    if not it or not text:
        return
    try:
        g = await llm([{"role": "user", "content":
            "Read this source and write its guide.\n- title: the source's real title (short)\n- summary: 2-4 sentences on what "
            "it covers and its main points, in plain English; **bold** the 2-3 most important terms\n- topics: 4-6 key topics, "
            f"each 1-4 words\n\nSOURCE ({it['url'] or it['title']}):\n{text[:14000]}"}], schema=GUIDE_SCHEMA, temperature=0.2)
    except Exception:
        log.exception("source guide failed for %s", iid)
        return
    it = research.get_item(iid)
    keep_title = it["title"] and it["addedBy"] not in ("auto",) and it["title"] != it["url"] and not it["title"].startswith("Pasted text")
    _patch(iid, title=None if keep_title else (g.get("title") or it["title"])[:200],
           body=it["body"] if it["body"] and it["addedBy"] not in ("auto",) else g.get("summary", ""),
           guide=g.get("summary", ""), topics=[t for t in g.get("topics", []) if isinstance(t, str)][:6])


NB_SCHEMA = {"type": "object", "properties": {
    "title": {"type": "string"}, "emoji": {"type": "string"}, "summary": {"type": "string"},
    "questions": {"type": "array", "items": {"type": "string"}}}, "required": ["title", "emoji", "summary", "questions"]}


def _schedule_guide(bid):
    if bid in _guide_pending:
        return
    _guide_pending.add(bid)

    async def later():
        await asyncio.sleep(4)
        _guide_pending.discard(bid)
        if any(s["meta"].get("index") in ("indexing", "pending") for s in sources(bid, ids=None, ready=False)):
            _schedule_guide(bid)  # wait until the batch has finished indexing
            return
        await refresh_guide(bid)
    _spawn(later())


async def refresh_guide(bid):
    """Notebook overview: a summary across all sources and a few questions worth asking."""
    b = research.get_board(bid)
    srcs = [s for s in research.board_detail(bid)["items"] if s["kind"] == "source" and s["meta"].get("index") == "ready"]
    if not b or not srcs:
        _set_board(bid, guide=json.dumps({}))
        return
    digest = "\n\n".join(f"[S{s['ref']}] {s['title']}\n{s['meta'].get('guide') or s['body'] or source_text(bid, s['id'])[:1500]}"
                         for s in srcs[:40])
    try:
        g = await llm([{"role": "user", "content":
            f"These are the sources in a research notebook{' about: ' + b['question'] if b['question'] else ''}.\n\n{digest}\n\n"
            "Write the notebook overview:\n- title: a short notebook title (3-7 words)\n- emoji: one emoji that fits\n"
            "- summary: one paragraph (4-6 sentences) synthesizing what the sources cover together; **bold** key terms; "
            "cite like [S1]\n- questions: 3 specific, interesting questions these sources can answer"}],
            schema=NB_SCHEMA, temperature=0.3)
    except Exception:
        log.exception("notebook guide failed for %s", bid)
        return
    questions = [re.sub(r"\*\*|__", "", q) for q in g.get("questions", []) if isinstance(q, str)][:4]
    fields = {"guide": json.dumps({"summary": g.get("summary", ""), "questions": questions, "at": time.time()})}
    if not b.get("emoji"):
        fields["emoji"] = (g.get("emoji") or "📓")[:4]
    if b["title"] in ("Untitled notebook", "Untitled research") or b["title"] == b["question"][:160] and len(b["title"]) > 70:
        fields["title"] = (g.get("title") or b["title"])[:120]
    _set_board(bid, **fields)


def _set_board(bid, **fields):
    with db.conn() as c:
        c.execute(f"UPDATE research_boards SET {', '.join(k + '=?' for k in fields)}, updated=? WHERE id=?",
                  (*fields.values(), time.time(), bid))


# ── retrieval + grounded chat ───────────────────────────────────────────────

async def retrieve(bid, query, item_ids, k=8):
    if not item_ids:
        return []
    q_marks = ",".join("?" * len(item_ids))
    with db.conn() as c:
        rows = c.execute(f"SELECT item_id, idx, text, embedding FROM research_chunks WHERE board_id=? AND item_id IN ({q_marks})",
                         (bid, *item_ids)).fetchall()
    if not rows:
        return []
    from app import get_settings
    q = np.asarray((await embed([query], get_settings()["embeddingModel"]))[0], dtype=np.float32)
    mat = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
    scores = mat @ q / (np.linalg.norm(mat, axis=1) * np.linalg.norm(q) + 1e-9)
    picked, per = [], {}
    for i in np.argsort(-scores):
        r = rows[i]
        if per.get(r["item_id"], 0) >= 4:  # keep one long source from crowding out the rest
            continue
        per[r["item_id"]] = per.get(r["item_id"], 0) + 1
        picked.append({"itemId": r["item_id"], "chunk": r["idx"], "text": r["text"], "score": float(scores[i])})
        if len(picked) >= k:
            break
    return picked


def chat_history(bid, limit=200):
    with db.conn() as c:
        rows = c.execute("SELECT * FROM research_chat WHERE board_id=? ORDER BY created", (bid,)).fetchall()
    return [{"id": r["id"], "role": r["role"], "content": r["content"], **json.loads(r["data"] or "{}"),
             "createdAt": r["created"] * 1000} for r in rows][-limit:]


def _add_chat(bid, role, content, data=None):
    mid = db.new_id("rmsg")
    with db.conn() as c:
        c.execute("INSERT INTO research_chat VALUES(?,?,?,?,?,?)", (mid, bid, role, content, json.dumps(data or {}), time.time()))
    return mid


CHAT_SYSTEM = """You are Minerva, the research assistant inside a notebook. Answer the user's question using ONLY the numbered
source passages provided with it. Put a citation right after each claim, like [1] or [2][5], using the passage numbers.
If the passages don't contain the answer, say so plainly and suggest what source would help; don't fill gaps from
general knowledge unless the user asks, and then label it clearly as not from the sources. Be clear and well organized:
lead with the direct answer, use short paragraphs, bullet lists or a table when they help, and **bold** key terms.
Answer in the language of the question."""


@router.get("/api/research/{bid}/chat")
def api_chat_history(bid: str):
    return chat_history(bid)


@router.delete("/api/research/{bid}/chat")
def api_chat_clear(bid: str):
    with db.conn() as c:
        c.execute("DELETE FROM research_chat WHERE board_id=?", (bid,))
    return {"ok": True}


@router.post("/api/research/{bid}/chat")
async def api_chat(bid: str, req: Request):
    if not research.get_board(bid):
        raise HTTPException(404, "No such notebook")
    body = await req.json()
    question = str(body.get("message") or "").strip()
    if not question:
        raise HTTPException(400, "Empty message")
    ids = body.get("sourceIds")
    srcs = sources(bid, ids=ids)
    queue: asyncio.Queue = asyncio.Queue()

    async def run():
        with _job(f"chat:{bid}:{time.time_ns()}", f"answering in notebook {bid}"):
            await answer()

    async def answer():
        try:
            _add_chat(bid, "user", question)
            if not srcs:
                text = ("There are no indexed sources selected yet. Add a source (a file, a web page or pasted text) or tick "
                        "some on the left, and ask again.")
                await queue.put({"type": "delta", "text": text})
                mid = _add_chat(bid, "assistant", text, {"citations": {}})
                await queue.put({"type": "done", "id": mid, "citations": {}})
                return
            by_id = {s["id"]: s for s in srcs}
            hist = [m for m in chat_history(bid)[:-1] if m["role"] in ("user", "assistant")][-6:]
            query = question if not hist else f"{hist[-1]['content'][-300:]}\n{question}" if len(question) < 40 else question
            passages = await retrieve(bid, query, list(by_id), k=10)
            cites = {}
            for n, p in enumerate(passages, 1):
                s = by_id[p["itemId"]]
                cites[str(n)] = {"itemId": s["id"], "ref": s["ref"], "title": s["title"] or s["url"], "chunk": p["chunk"],
                                 "text": p["text"]}
            await queue.put({"type": "citations", "citations": cites})
            block = "\n\n".join(f"[{n}] (from \"{c['title']}\")\n{c['text']}" for n, c in cites.items())
            msgs = [{"role": "system", "content": CHAT_SYSTEM}]
            for m in hist:
                msgs.append({"role": m["role"], "content": re.sub(r"\[\d+\]", "", m["content"])[:3000]})
            msgs.append({"role": "user", "content": f"SOURCE PASSAGES:\n\n{block}\n\nQUESTION: {question}"})

            async def on_text(t):
                await queue.put({"type": "delta", "text": t})
            text = await llm(msgs, on_text=on_text, temperature=0.3, priority=True)
            used = {n: c for n, c in cites.items() if f"[{n}]" in text}
            mid = _add_chat(bid, "assistant", text, {"citations": used})
            research.touch(bid)
            await queue.put({"type": "done", "id": mid, "citations": used})
        except Exception as e:
            await queue.put({"type": "error", "error": f"{type(e).__name__}: {e}"})
        finally:
            await queue.put(None)

    _spawn(run())

    async def stream():
        while True:
            ev = await queue.get()
            if ev is None:
                break
            yield f"data: {json.dumps(ev)}\n\n"
    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── studio ──────────────────────────────────────────────────────────────────

def _context(bid, ids):
    """The selected sources' text, fairly shared within the budget, each headed by its S-number."""
    srcs = sources(bid, ids=ids)
    if not srcs:
        return "", []
    texts = {s["id"]: source_text(bid, s["id"]) for s in srcs}
    share, spare = CONTEXT_BUDGET // len(srcs), 0
    for s in srcs:  # short sources give their unused share to long ones
        spare += max(0, share - len(texts[s["id"]]))
    long_n = sum(1 for s in srcs if len(texts[s["id"]]) > share) or 1
    cap = share + spare // long_n
    parts = []
    for s in srcs:
        t = texts[s["id"]]
        parts.append(f"=== [S{s['ref']}] {s['title'] or s['url']} ===\n{t[:cap]}{' […]' if len(t) > cap else ''}")
    return "\n\n".join(parts), srcs


MD_RULES = ("Write in Markdown with clear headings. Cite the sources inline as [S1], [S2] using the S-numbers shown. "
            "Use only what the sources say.")
STUDIO = {
    "briefing": ("Briefing doc", "Write a briefing document for a busy decision-maker: an executive summary (3-5 bullet "
                 "points), then the key themes and findings with the most important facts and figures, notable quotes, "
                 "disagreements or uncertainties between sources, and implications. " + MD_RULES),
    "study_guide": ("Study guide", "Write a study guide: a short overview, key concepts with clear definitions, a short-answer "
                    "quiz of 8-10 questions, then an answer key, 4-5 essay questions, and a glossary of key terms. " + MD_RULES),
    "faq": ("FAQ", "Write an FAQ of 8-12 questions a newcomer would actually ask about this material, each with a concise, "
            "well-cited answer. Use '### ' for each question. " + MD_RULES),
    "timeline": ("Timeline", "Build a timeline of the events in the sources: a chronological list (date — event, cited), then a "
                 "cast of characters (people and organizations, one line each on who they are and their role). If the "
                 "sources have few dated events, say so and give the sequence of developments instead. " + MD_RULES),
    "report": ("Report", "Write a thorough, well-structured report that answers the notebook's research question from the "
               "sources: introduction, sections per theme, a comparison table where useful, and a conclusion. " + MD_RULES),
    "mindmap": ("Mind map", None), "flashcards": ("Flashcards", None), "quiz": ("Quiz", None), "audio": ("Audio Overview", None),
}

_NODE3 = {"type": "object", "properties": {"label": {"type": "string"}}, "required": ["label"]}
_NODE2 = {"type": "object", "properties": {"label": {"type": "string"}, "children": {"type": "array", "items": _NODE3}}, "required": ["label"]}
_NODE1 = {"type": "object", "properties": {"label": {"type": "string"}, "children": {"type": "array", "items": _NODE2}}, "required": ["label"]}
SCHEMAS = {
    "mindmap": {"type": "object", "properties": {"label": {"type": "string"}, "children": {"type": "array", "items": _NODE1}},
                "required": ["label", "children"]},
    "flashcards": {"type": "object", "properties": {"cards": {"type": "array", "items": {"type": "object", "properties": {
        "front": {"type": "string"}, "back": {"type": "string"}, "source": {"type": "string"}}, "required": ["front", "back"]}}},
        "required": ["cards"]},
    "quiz": {"type": "object", "properties": {"questions": {"type": "array", "items": {"type": "object", "properties": {
        "question": {"type": "string"}, "options": {"type": "array", "items": {"type": "string"}},
        "answer": {"type": "integer"}, "explanation": {"type": "string"}, "source": {"type": "string"}},
        "required": ["question", "options", "answer", "explanation"]}}}, "required": ["questions"]},
    "audio": {"type": "object", "properties": {"title": {"type": "string"}, "lines": {"type": "array", "items": {
        "type": "object", "properties": {"speaker": {"type": "string", "enum": ["A", "B"]}, "text": {"type": "string"}},
        "required": ["speaker", "text"]}}}, "required": ["title", "lines"]},
}
JSON_PROMPTS = {
    "mindmap": "Build a mind map of the sources: the root is the central topic; 4-7 main branches; each with 2-5 sub-branches, "
               "and leaves where useful. Labels are short (1-6 words), specific and informative.",
    "flashcards": "Make 15-20 flashcards for learning this material: the front is a question or term, the back a concise answer "
                  "(one or two sentences). Cover the most important facts, numbers and concepts. source = the S-number it came from.",
    "quiz": "Write a 10-question multiple-choice quiz on the most important points. Each question has 4 options, exactly one "
            "correct (answer = its 0-based index), plausible distractors, and a one-sentence explanation. source = the S-number.",
    "audio": "Write the script of an Audio Overview: a lively, natural podcast conversation between two hosts, Alex (A) and Sam (B), "
             "doing a deep dive into these sources for a curious listener. Alex leads and frames; Sam asks the questions a "
             "listener would and adds insight. Open with a hook, explain the key ideas with concrete examples and analogies, "
             "surface surprising facts and tensions between sources, and close with the big takeaway. Sound human: short "
             "sentences, reactions ('Right.', 'Wait, really?'), no stage directions, no markdown, no citations read aloud, "
             "write numbers the way they are spoken. Each line at most 3 sentences.",
}
LENGTHS = {"short": "about 14 exchanges (~3 minutes)", "default": "about 28 exchanges (~6 minutes)", "long": "about 44 exchanges (~10 minutes)"}


async def generate(bid, iid):
    with _job(f"studio:{iid}", f"generating {iid} in {bid}"):
        _patch(iid, status="queued", error="")
        async with _studio_gate:  # one at a time; the rest wait as "queued"
            await _generate(bid, iid)


async def _generate(bid, iid):
    it = research.get_item(iid)
    if not it:
        return
    m = it["meta"]
    kind = m["type"]
    _patch(iid, status="generating", error="", startedAt=time.time() * 1000)
    try:
        ctx, srcs = _context(bid, m.get("sourceIds"))
        if not srcs:
            raise ValueError("no indexed sources are selected")
        b = research.get_board(bid)
        focus = f"\n\nThe user asked you to focus on: {m['focus']}" if m.get("focus") else ""
        topic = f"Notebook: {b['title']}" + (f"\nResearch question: {b['question']}" if b["question"] else "")
        head = f"{topic}\n\nSOURCES:\n\n{ctx}\n\n"
        if STUDIO[kind][1]:
            text = await llm([{"role": "user", "content": head + "TASK: " + STUDIO[kind][1] + focus}], temperature=0.35)
            text = re.sub(r"^\s*```(?:markdown|md)?\s*\n|\n```\s*$", "", text.strip())
            text = re.sub(r"^(#{1,6})\s+#{1,6}\s+", r"\1 ", text, flags=re.M)  # "## ## Question" → "## Question"
            _patch(iid, body=text.strip(), status="ready", finishedAt=time.time() * 1000)
        elif kind == "audio":
            length = LENGTHS.get(m.get("length") or "default", LENGTHS["default"])
            script = await llm([{"role": "user", "content": head + "TASK: " + JSON_PROMPTS["audio"] + f" Length: {length}." + focus}],
                               schema=SCHEMAS["audio"], temperature=0.7)
            lines = [ln for ln in script.get("lines", []) if isinstance(ln, dict) and str(ln.get("text", "")).strip()]
            if len(lines) < 4:
                raise ValueError("the script came back too short")
            _patch(iid, title=f"Audio Overview: {script.get('title') or b['title']}"[:160], transcript=lines, status="voicing")
            path, dur, marks = await _voice(bid, iid, lines, m.get("voices") or VOICES)
            _patch(iid, audio=path.name, duration=dur, marks=marks, status="ready", finishedAt=time.time() * 1000)
        else:
            data = await llm([{"role": "user", "content": head + "TASK: " + JSON_PROMPTS[kind] + focus}],
                             schema=SCHEMAS[kind], temperature=0.4)
            if kind == "quiz":
                data["questions"] = [_shuffle_options(q, n) for n, q in enumerate(data.get("questions", []))
                                     if isinstance(q, dict) and len(q.get("options") or []) >= 2]
            _patch(iid, data=data, status="ready", finishedAt=time.time() * 1000)
    except Exception as e:
        _patch(iid, status="error", error=f"{type(e).__name__}: {e}"[:300])
        _notify(bid, iid, f"{type(e).__name__}: {e}")
        return
    _notify(bid, iid)


def _notify(bid, iid, error=""):
    import activity
    b, it = research.get_board(bid), research.get_item(iid)
    if b and it and not error and it["meta"].get("type") == "audio":
        import media
        media.record_notebook_audio(bid, iid, it.get("title") or "Audio Overview")
    if b and it:
        activity.post("notebook", "failed" if error else "done",
                      f"{it.get('title') or 'Output'} {'failed' if error else 'is ready'} in {b['title']}", error[:300],
                      f"#/research/{bid}")


def _shuffle_options(q, seed):
    """Models put the right answer first far too often; shuffle each question's options (stably) and re-point the answer."""
    import random
    opts = [str(o) for o in q["options"]]
    try:
        right = opts[int(q.get("answer", 0))]
    except (ValueError, IndexError):
        right = opts[0]
    random.Random(seed * 7919 + len(q.get("question", ""))).shuffle(opts)
    return {**q, "options": opts, "answer": opts.index(right)}


async def _tts(text, voice):
    async with httpx.AsyncClient(timeout=180) as c:
        r = await c.post(f"{HERMES}/tts", json={"text": text, "voice": voice, "format": "wav", "speed": 1.05})
        r.raise_for_status()
    with wave.open(io.BytesIO(r.content)) as w:
        rate = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        if w.getnchannels() > 1:
            pcm = pcm.reshape(-1, w.getnchannels()).mean(axis=1).astype(np.int16)
    return rate, pcm


async def _voice(bid, iid, lines, voices):
    """Voice each line with its host's voice and stitch them with short, natural pauses. Returns (file, seconds, marks)."""
    gate = asyncio.Semaphore(3)

    async def one(ln):
        async with gate:
            return await _tts(str(ln["text"])[:900], voices[0] if ln.get("speaker") == "A" else voices[1])
    clips = await asyncio.gather(*(one(ln) for ln in lines))
    rate = clips[0][0]
    out, marks, t = [], [], 0.0
    for i, ((r, pcm), ln) in enumerate(zip(clips, lines)):
        if r != rate:  # Kokoro is always 24 kHz, but don't trust it blindly
            pcm = np.interp(np.linspace(0, len(pcm), int(len(pcm) * rate / r), endpoint=False), np.arange(len(pcm)), pcm).astype(np.int16)
        marks.append(round(t, 2))
        out.append(pcm)
        gap = 0.18 if i + 1 < len(lines) and lines[i + 1].get("speaker") != ln.get("speaker") else 0.35
        out.append(np.zeros(int(rate * gap), dtype=np.int16))
        t += (len(pcm) + int(rate * gap)) / rate
    audio = np.concatenate(out)
    adir = _bdir(bid) / "audio"
    adir.mkdir(parents=True, exist_ok=True)
    try:
        import soundfile as sf
        path = adir / f"{iid}.mp3"
        await asyncio.to_thread(sf.write, str(path), audio, rate, format="MP3")
    except Exception:
        path = adir / f"{iid}.wav"
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1), w.setsampwidth(2), w.setframerate(rate)
            w.writeframes(audio.tobytes())
    return path, round(len(audio) / rate, 1), marks


# ── API: sources ────────────────────────────────────────────────────────────

def _need(bid):
    b = research.get_board(bid)
    if not b:
        raise HTTPException(404, "No such notebook")
    return b


@router.post("/api/research/{bid}/sources")
async def api_add_sources(bid: str, req: Request):
    """{type:'url', urls:[…]} or {type:'text', title, text}."""
    _need(bid)
    body = await req.json()
    added = []
    if body.get("type") == "text":
        text = str(body.get("text") or "").strip()
        if not text:
            raise HTTPException(400, "Paste some text first")
        title = str(body.get("title") or "").strip() or f"Pasted text ({time.strftime('%b %-d, %H:%M')})"
        it, _ = research.add_item(bid, "source", {"title": title, "type": "other",
                                                   "meta": {"origin": "text", "index": "pending", "selected": True}}, added_by="user")
        _text_path(bid, it["id"]).parent.mkdir(parents=True, exist_ok=True)
        _text_path(bid, it["id"]).write_text(text)
        _spawn(ingest(bid, it["id"]))
        added.append(it)
    else:
        urls = body.get("urls") or ([body["url"]] if body.get("url") else [])
        for u in [str(u).strip() for u in urls if str(u).strip()][:25]:
            if not re.match(r"https?://", u):
                u = "https://" + u
            try:
                it, _ = research.add_item(bid, "source", {"url": u, "title": body.get("title") or "",
                                                           "meta": {"origin": "url", "selected": True}}, added_by="user")
            except ValueError as e:
                raise HTTPException(400, str(e))
            added.append(it)
    return added


@router.post("/api/research/{bid}/sources/upload")
async def api_upload(bid: str, files: list[UploadFile] = File(...)):
    _need(bid)
    fdir = _bdir(bid) / "files"
    fdir.mkdir(parents=True, exist_ok=True)
    added = []
    for f in files:
        data = await f.read()
        if len(data) > MAX_FILE:
            raise HTTPException(413, f"{f.filename} is larger than 100 MB")
        name = Path(f.filename or "file").name
        it, _ = research.add_item(bid, "source", {"title": name, "type": "other",
                                                   "meta": {"origin": "file", "index": "pending", "selected": True,
                                                            "fileName": name, "size": len(data)}}, added_by="user")
        stored = f"{it['id']}{Path(name).suffix.lower()}"
        (fdir / stored).write_bytes(data)
        _patch(it["id"], file=stored)
        _spawn(ingest(bid, it["id"]))
        added.append(research.get_item(it["id"]))
    return added


@router.get("/api/research/{bid}/sources/{iid}/text")
def api_source_text(bid: str, iid: str):
    it = research.get_item(iid)
    if not it or it.get("kind") != "source":
        raise HTTPException(404, "No such source")
    return {"text": source_text(bid, iid)}


@router.get("/api/research/{bid}/sources/{iid}/file")
def api_source_file(bid: str, iid: str):
    it = research.get_item(iid)
    if not it or not it["meta"].get("file"):
        raise HTTPException(404, "No file")
    p = _bdir(bid) / "files" / it["meta"]["file"]
    return FileResponse(p, filename=it["meta"].get("fileName") or p.name, content_disposition_type="inline")


@router.post("/api/research/{bid}/sources/{iid}/reindex")
def api_reindex(bid: str, iid: str):
    _spawn(ingest(bid, iid))
    return {"ok": True}


@router.post("/api/research/{bid}/select")
async def api_select(bid: str, req: Request):
    """Tick or untick sources: {ids:[…] | all:true, selected:bool}."""
    _need(bid)
    body = await req.json()
    sel = bool(body.get("selected", True))
    ids = None if body.get("all") else set(body.get("ids") or [])
    for it in research.board_detail(bid)["items"]:
        if it["kind"] == "source" and (ids is None or it["id"] in ids):
            _patch(it["id"], selected=sel)
    return {"ok": True}


@router.post("/api/research/{bid}/discover")
async def api_discover(bid: str, req: Request):
    """Web search for sources to add: results marked when they're already in the notebook."""
    _need(bid)
    q = str((await req.json()).get("query") or "").strip()
    if not q:
        raise HTTPException(400, "Describe what to look for")
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(f"{SEARXNG}/search", params={"q": q, "format": "json"})
        r.raise_for_status()
    have = {research.norm_url(s["url"]) for s in sources(bid, ready=False) if s["url"]}
    out, seen = [], set()
    for h in r.json().get("results", []):
        u = h.get("url") or ""
        key = research.norm_url(u)
        if not u.startswith("http") or key in seen:
            continue
        seen.add(key)
        out.append({"url": u, "title": (h.get("title") or u).strip(), "snippet": (h.get("content") or "").strip()[:300],
                    "domain": (urlparse(u).hostname or "").removeprefix("www."), "added": key in have})
        if len(out) >= 12:
            break
    return out


@router.post("/api/research/{bid}/guide")
async def api_guide(bid: str):
    _need(bid)
    await refresh_guide(bid)
    return research.get_board(bid)


# ── API: studio ─────────────────────────────────────────────────────────────

@router.post("/api/research/{bid}/studio")
async def api_studio(bid: str, req: Request):
    _need(bid)
    body = await req.json()
    kind = body.get("type")
    if kind not in STUDIO:
        raise HTTPException(400, f"type must be one of {', '.join(STUDIO)}")
    ids = body.get("sourceIds") or [s["id"] for s in sources(bid)]
    if not ids:
        raise HTTPException(400, "Add or select an indexed source first")
    it, _ = research.add_item(bid, "output", {"title": STUDIO[kind][0], "meta": {
        "type": kind, "status": "queued", "sourceIds": ids, "focus": str(body.get("focus") or "")[:600],
        "length": body.get("length") or "default"}}, added_by="user")
    _spawn(generate(bid, it["id"]))
    return it


@router.post("/api/research/{bid}/outputs/{iid}/retry")
def api_retry(bid: str, iid: str):
    it = research.get_item(iid)
    if not it or it["kind"] != "output":
        raise HTTPException(404, "No such output")
    _spawn(generate(bid, iid))
    return {"ok": True}


@router.get("/api/research/{bid}/outputs/{iid}/audio")
def api_audio(bid: str, iid: str):
    it = research.get_item(iid)
    if not it or not it["meta"].get("audio"):
        raise HTTPException(404, "No audio")
    p = _bdir(bid) / "audio" / it["meta"]["audio"]
    return FileResponse(p, media_type="audio/mpeg" if p.suffix == ".mp3" else "audio/wav",
                        filename=re.sub(r"[^\w-]+", "-", it["title"]).strip("-")[:60] + p.suffix)
