"""Research boards: where an agent (Minerva, mainly) gathers sources, findings, quotes and open questions into one
cohesive, citable picture, shown at #/research/<id>.

A board belongs to no single chat: chats attach to it (one board per chat), and every agent turn in an attached chat
sees a compact view of the board in its system prompt, so research can carry on across sessions. Sources get stable
per-board numbers (S1, S2, …) that findings, quotes and the synthesis cite. Pages an agent reads with web_fetch (or
read_document on a URL) in an attached chat are captured as sources automatically, so nothing read goes untracked.
"""
import json
import re
import time
from urllib.parse import urlparse, urlunparse

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

import db
from tools import TOOLS, ToolResult, _fn

router = APIRouter()
KINDS = ("source", "finding", "quote", "question", "note", "figure", "output")
# set by notebook.start(): index a new or changed URL source; clean up after a deleted item
on_source = None
on_delete = None
LEVELS = ("high", "medium", "low")
SOURCE_TYPES = ("article", "paper", "report", "official", "news", "data", "docs", "forum", "book", "video", "other")


def init():
    with db.conn() as c:
        c.executescript("""
CREATE TABLE IF NOT EXISTS research_boards(
  id TEXT PRIMARY KEY, title TEXT, question TEXT, summary TEXT DEFAULT '', status TEXT DEFAULT 'active',
  created_by TEXT, created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS research_links(conv_id TEXT PRIMARY KEY, board_id TEXT, created REAL);
CREATE INDEX IF NOT EXISTS research_links_board ON research_links(board_id);
CREATE TABLE IF NOT EXISTS research_items(
  id TEXT PRIMARY KEY, board_id TEXT, kind TEXT, ref INTEGER, title TEXT, body TEXT, url TEXT, meta TEXT,
  pinned INTEGER DEFAULT 0, added_by TEXT, conv_id TEXT, created REAL, updated REAL);
CREATE INDEX IF NOT EXISTS research_items_board ON research_items(board_id, kind, created);
""")


# ── storage ─────────────────────────────────────────────────────────────────

def _board(row, counts=None):
    b = {"id": row["id"], "title": row["title"], "question": row["question"] or "", "summary": row["summary"] or "",
         "status": row["status"] or "active", "createdBy": row["created_by"] or "",
         "emoji": (row["emoji"] if "emoji" in row.keys() else None) or "",
         "guide": json.loads(row["guide"]) if "guide" in row.keys() and row["guide"] else {},
         "createdAt": row["created"] * 1000, "updatedAt": row["updated"] * 1000}
    if counts is not None:
        b["counts"] = counts
    return b


def _item(row):
    return {"id": row["id"], "kind": row["kind"], "ref": row["ref"], "title": row["title"] or "", "body": row["body"] or "",
            "url": row["url"] or "", "meta": json.loads(row["meta"] or "{}"), "pinned": bool(row["pinned"]),
            "addedBy": row["added_by"] or "", "convId": row["conv_id"],
            "createdAt": row["created"] * 1000, "updatedAt": row["updated"] * 1000}


def _counts(c, board_id):
    counts = {k: 0 for k in KINDS}
    for r in c.execute("SELECT kind, COUNT(*) n FROM research_items WHERE board_id=? GROUP BY kind", (board_id,)):
        counts[r["kind"]] = r["n"]
    counts["openQuestions"] = c.execute(
        "SELECT COUNT(*) FROM research_items WHERE board_id=? AND kind='question' AND json_extract(meta,'$.status') IS NOT 'answered'",
        (board_id,)).fetchone()[0]
    return counts


def touch(board_id):
    with db.conn() as c:
        c.execute("UPDATE research_boards SET updated=? WHERE id=?", (time.time(), board_id))


def list_boards():
    with db.conn() as c:
        rows = c.execute("SELECT * FROM research_boards ORDER BY updated DESC").fetchall()
        out = []
        for r in rows:
            b = _board(r, _counts(c, r["id"]))
            b["convIds"] = [x["conv_id"] for x in c.execute(
                "SELECT conv_id FROM research_links WHERE board_id=? ORDER BY created DESC", (r["id"],))]
            out.append(b)
    return out


def get_board(board_id):
    with db.conn() as c:
        row = c.execute("SELECT * FROM research_boards WHERE id=?", (board_id,)).fetchone()
        return _board(row, _counts(c, board_id)) if row else None


def board_detail(board_id):
    b = get_board(board_id)
    if not b:
        return None
    with db.conn() as c:
        items = [_item(r) for r in c.execute(
            "SELECT * FROM research_items WHERE board_id=? ORDER BY COALESCE(ref, 1e9), created", (board_id,))]
        convs = [{"id": r["id"], "title": r["title"], "agentId": r["agent_id"], "updatedAt": r["updated"] * 1000}
                 for r in c.execute("""SELECT v.* FROM research_links l JOIN conversations v ON v.id=l.conv_id
                                       WHERE l.board_id=? ORDER BY v.updated DESC""", (board_id,))]
    return {**b, "items": items, "conversations": convs}


def create_board(title, question="", created_by="user", conv_id=None):
    title = (title or "").strip() or (question or "").strip()[:80] or "Untitled notebook"
    now = time.time()
    bid = db.new_id("rb")
    with db.conn() as c:
        c.execute("INSERT INTO research_boards(id, title, question, summary, status, created_by, created, updated) "
                  "VALUES(?,?,?,?,?,?,?,?)",
                  (bid, title[:160], (question or "").strip(), "", "active", created_by, now, now))
    if conv_id:
        link(conv_id, bid)
    return get_board(bid)


def update_board(board_id, **fields):
    allowed = {"title": "title", "question": "question", "summary": "summary", "status": "status"}
    sets = [(allowed[k], v) for k, v in fields.items() if k in allowed and v is not None]
    if fields.get("status") not in (None, "active", "complete"):
        raise ValueError("status must be active or complete")
    with db.conn() as c:
        if sets:
            c.execute(f"UPDATE research_boards SET {', '.join(k + '=?' for k, _ in sets)}, updated=? WHERE id=?",
                      (*[v for _, v in sets], time.time(), board_id))
    return get_board(board_id)


def delete_board(board_id):
    import notebook
    notebook.delete_board_data(board_id)
    with db.conn() as c:
        c.execute("DELETE FROM research_items WHERE board_id=?", (board_id,))
        c.execute("DELETE FROM research_links WHERE board_id=?", (board_id,))
        c.execute("DELETE FROM research_boards WHERE id=?", (board_id,))


def link(conv_id, board_id):
    with db.conn() as c:
        c.execute("INSERT OR REPLACE INTO research_links VALUES(?,?,?)", (conv_id, board_id, time.time()))


def unlink(conv_id):
    with db.conn() as c:
        c.execute("DELETE FROM research_links WHERE conv_id=?", (conv_id,))


def board_of(conv_id):
    if not conv_id:
        return None
    with db.conn() as c:
        row = c.execute("SELECT board_id FROM research_links WHERE conv_id=?", (conv_id,)).fetchone()
    return row["board_id"] if row else None


def board_brief(conv_id):
    """{id, title} of the chat's board, for the chat header."""
    bid = board_of(conv_id)
    b = get_board(bid) if bid else None
    return {"id": b["id"], "title": b["title"]} if b else None


# ── items ───────────────────────────────────────────────────────────────────

def norm_url(url):
    """Same page, same source: drop fragments, tracking parameters, trailing slashes and the www. prefix."""
    try:
        p = urlparse(url.strip())
    except ValueError:
        return url.strip()
    if p.scheme not in ("http", "https"):
        return url.strip()
    q = "&".join(kv for kv in p.query.split("&") if kv and not re.match(r"(utm_[a-z]+|fbclid|gclid|ref|mc_[a-z]+)=", kv))
    host = (p.hostname or "").removeprefix("www.")
    return urlunparse(("https", host + (f":{p.port}" if p.port else ""), p.path.rstrip("/") or "/", "", q, ""))


def _domain(url):
    try:
        return (urlparse(url).hostname or "").removeprefix("www.")
    except ValueError:
        return ""


def _refs(value):
    """Source references as the model writes them ("S3", 3, "[S1, S4]", ["S2","5"]) → sorted unique ints."""
    if value is None:
        return []
    vals = value if isinstance(value, list) else re.split(r"[,\s;]+", str(value))
    out = set()
    for v in vals:
        m = re.search(r"\d+", str(v))
        if m:
            out.add(int(m.group()))
    return sorted(out)


def _level(v, default="medium"):
    v = str(v or "").strip().lower()
    return v if v in LEVELS else default


def find_source(board_id, url):
    key = norm_url(url)
    with db.conn() as c:
        for r in c.execute("SELECT * FROM research_items WHERE board_id=? AND kind='source'", (board_id,)):
            if norm_url(r["url"] or "") == key:
                return _item(r)
    return None


def _clean(kind, d):
    """Validate one item from the agent or the UI into (title, body, url, meta)."""
    title = str(d.get("title") or "").strip()[:300]
    url = str(d.get("url") or "").strip()
    body = str(d.get("body") or d.get("text") or d.get("summary") or d.get("content") or "").strip()
    meta = dict(d.get("meta") or {})
    if kind == "source":
        if not url and not title:
            raise ValueError("a source needs a url or a title")
        if url and urlparse(url).scheme not in ("http", "https", ""):
            raise ValueError(f"unsupported url {url!r}")
        for k in ("author", "published", "publisher"):
            if d.get(k):
                meta[k] = str(d[k])[:200]
        stype = str(d.get("type") or meta.get("type") or "").lower()
        meta["type"] = stype if stype in SOURCE_TYPES else meta.get("type", "other")
        meta["credibility"] = _level(d.get("credibility") or meta.get("credibility"))
        meta["domain"] = _domain(url) if url else meta.get("domain", "")
        meta.setdefault("status", "read" if body else "seen")
    elif kind == "finding":
        if not body:
            raise ValueError("a finding needs text")
        meta["confidence"] = _level(d.get("confidence") or meta.get("confidence"))
        meta["sources"] = _refs(d.get("sources") if d.get("sources") is not None else meta.get("sources"))
        theme = str(d.get("theme") or meta.get("theme") or "").strip()
        if theme:
            meta["theme"] = theme[:80]
        if d.get("contested") or meta.get("contested"):
            meta["contested"] = True
    elif kind == "quote":
        if not body:
            raise ValueError("a quote needs its text")
        src = _refs(d.get("source") if d.get("source") is not None else (d.get("sources") or meta.get("source")))
        meta["source"] = src[0] if src else None
        if d.get("location") or meta.get("location"):
            meta["location"] = str(d.get("location") or meta.get("location"))[:80]
    elif kind == "question":
        if not body:
            raise ValueError("a question needs text")
        status = str(d.get("status") or meta.get("status") or "open").lower()
        meta["status"] = "answered" if status in ("answered", "resolved", "closed", "done") else "open"
        if d.get("answer") or meta.get("answer"):
            meta["answer"] = str(d.get("answer") or meta.get("answer"))
    elif kind == "figure":
        url = url or str(d.get("image") or "").strip()
        if not url:
            raise ValueError("a figure needs an image url")
        src = _refs(d.get("source") if d.get("source") is not None else meta.get("source"))
        meta["source"] = src[0] if src else None
    elif kind == "note":
        if not body and not title:
            raise ValueError("a note needs text")
    elif kind == "output":
        pass  # Studio results: notebook.py fills body/meta
    return title, body, url, meta


def add_item(board_id, kind, d, added_by="user", conv_id=None):
    """Add an item; a source whose URL is already on the board is merged into the existing one instead."""
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(KINDS)}")
    title, body, url, meta = _clean(kind, d)
    now = time.time()
    if kind == "source" and url:
        old = find_source(board_id, url)
        if old:  # merge: fill blanks, upgrade seen → read, keep the stable S-number
            m = {**old["meta"], **{k: v for k, v in meta.items() if v not in (None, "", "other") or k not in old["meta"]}}
            if old["meta"].get("status") == "read" or body:
                m["status"] = "read"
            explicit = d.get("credibility") or (d.get("meta") or {}).get("credibility")
            m["credibility"] = meta["credibility"] if explicit or old["addedBy"] == "auto" else old["meta"].get("credibility", "medium")
            new_title = title if title and (not old["title"] or old["addedBy"] == "auto" or old["title"] == old["url"]) else old["title"]
            with db.conn() as c:
                c.execute("UPDATE research_items SET title=?, body=?, meta=?, added_by=?, updated=? WHERE id=?",
                          (new_title, body or old["body"], json.dumps(m),
                           added_by if old["addedBy"] == "auto" else old["addedBy"], now, old["id"]))
            touch(board_id)
            if on_source and old["meta"].get("index") not in ("ready", "indexing", "pending"):
                on_source(board_id, old["id"])
            return get_item(old["id"]), False
    iid = db.new_id("ri")
    with db.conn() as c:
        ref = None
        if kind == "source":
            ref = (c.execute("SELECT MAX(ref) FROM research_items WHERE board_id=? AND kind='source'", (board_id,)).fetchone()[0] or 0) + 1
        c.execute("INSERT INTO research_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (iid, board_id, kind, ref, title, body, url, json.dumps(meta), int(bool(d.get("pinned"))),
                   added_by, conv_id, now, now))
    touch(board_id)
    if kind == "source" and url and on_source:
        on_source(board_id, iid)
    return get_item(iid), True


def get_item(item_id):
    with db.conn() as c:
        row = c.execute("SELECT * FROM research_items WHERE id=?", (item_id,)).fetchone()
    return _item(row) if row else None


def resolve_item(board_id, key):
    """An item by id, or a source by its S-number."""
    key = str(key or "").strip()
    with db.conn() as c:
        row = c.execute("SELECT * FROM research_items WHERE board_id=? AND id=?", (board_id, key)).fetchone()
        if not row and re.fullmatch(r"[Ss]?\d+", key):
            row = c.execute("SELECT * FROM research_items WHERE board_id=? AND kind='source' AND ref=?",
                            (board_id, int(key.lstrip("Ss")))).fetchone()
    return _item(row) if row else None


def update_item(board_id, item_id, patch):
    old = resolve_item(board_id, item_id)
    if not old:
        raise KeyError(item_id)
    merged = {"title": old["title"], "body": old["body"], "url": old["url"], "meta": old["meta"], "pinned": old["pinned"]}
    for k in ("title", "body", "url", "pinned"):
        if k in patch and patch[k] is not None:
            merged[k] = patch[k]
    for k in ("text", "summary", "content"):
        if patch.get(k):
            merged["body"] = patch[k]
    meta_patch = {**(patch.get("meta") or {}),
                  **{k: patch[k] for k in ("confidence", "sources", "theme", "contested", "credibility", "type", "status",
                                           "answer", "source", "location", "author", "published") if k in patch}}
    title, body, url, meta = _clean(old["kind"], {**merged, "meta": {**old["meta"], **meta_patch}, **meta_patch})
    with db.conn() as c:
        c.execute("UPDATE research_items SET title=?, body=?, url=?, meta=?, pinned=?, updated=? WHERE id=?",
                  (title, body, url, json.dumps(meta), int(bool(merged["pinned"])), time.time(), old["id"]))
    touch(board_id)
    return get_item(old["id"])


def delete_item(board_id, item_id):
    it = resolve_item(board_id, item_id)
    if not it:
        raise KeyError(item_id)
    with db.conn() as c:
        c.execute("DELETE FROM research_items WHERE id=?", (it["id"],))
    touch(board_id)
    if on_delete:
        on_delete(board_id, it)
    return it


# ── auto-capture ────────────────────────────────────────────────────────────

def auto_capture(conv_id, tool_name, args, res):
    """A page an agent read in a chat attached to a board becomes a source on it (merged if already there)."""
    if res.error or tool_name not in ("web_fetch", "read_document", "view_document", "ocr"):
        return None
    url = str((args or {}).get("url") or (args or {}).get("path") or "").strip() if isinstance(args, dict) else ""
    if not url.startswith(("http://", "https://")):
        return None
    if isinstance(args, dict) and int(args.get("start") or 0) > 0:
        return None  # a continuation of a page already captured
    bid = board_of(conv_id)
    if not bid:
        return None
    title = ""
    m = re.search(r"^#{1,2} (?!https?://)(.{3,200})$", res.text[:4000], re.M)
    if m:
        title = m.group(1).strip()
    old = find_source(bid, url)
    if old and old["addedBy"] != "auto":
        if old["meta"].get("status") != "read":
            update_item(bid, old["id"], {"status": "read"})
        return old
    try:
        item, _ = add_item(bid, "source", {"url": url, "title": title or _domain(url), "meta": {"status": "read"}},
                           added_by="auto", conv_id=conv_id)
        return item
    except ValueError:
        return None


# ── what the agent sees ─────────────────────────────────────────────────────

GUIDE = """- research_board keeps a Research Board: a page where the user browses everything you found, laid out as one
  cohesive picture. The board is the deliverable for research, not a side note. Work in this order:
  1. `start` a board (title, question), unless one is already attached to this chat. A board is the user's research
     notebook: they may already have added files and pages to it; `search` reads their full text before you go to the web.
  2. Search and read. Pages you web_fetch land on the board as sources automatically (marked auto); `add` them as
     proper sources (url, title, 1-3 sentence summary of what it says, type, credibility) when you rely on them.
  3. `add` findings: one claim per finding, citing sources as ["S1","S3"], with confidence (high/medium/low) and a short
     theme so related findings group together. Every number or conclusion you give the user should be a finding.
     Add exact quotes worth keeping (with source) and open questions you could not settle.
  4. `synthesize` before you reply: a well-structured Markdown write-up citing sources inline as [S1], [S2].
  5. Reply in chat with a short summary and link the board: [the research board](board:<board id>). Don't skip
     steps 3-4."""


def context(conv_id):
    """The attached board, compactly, for the system prompt."""
    bid = board_of(conv_id)
    d = board_detail(bid) if bid else None
    if not d:
        return ""
    items = d["items"]
    src = [i for i in items if i["kind"] == "source"]
    finds = [i for i in items if i["kind"] == "finding"]
    qs = [i for i in items if i["kind"] == "question"]
    lines = [f"## Research board attached to this chat: \"{d['title']}\" (id {d['id']}, {d['status']})"]
    if d["question"]:
        lines.append(f"Research question: {d['question']}")
    if src:
        lines.append(f"Sources ({len(src)}):")
        for s in src[-60:]:
            flag = " [auto-captured, unreviewed]" if s["addedBy"] == "auto" else ""
            lines.append(f"- S{s['ref']}: {s['title'] or s['url']} — {s['meta'].get('domain') or ''}{flag}")
    if finds:
        lines.append(f"Findings so far ({len(finds)}):")
        for f in finds[-40:]:
            refs = ", ".join(f"S{r}" for r in f["meta"].get("sources", []))
            lines.append(f"- [{f['id']}] ({f['meta'].get('confidence')}) {f['body'][:220]}" + (f" [{refs}]" if refs else ""))
    open_q = [q for q in qs if q["meta"].get("status") != "answered"]
    if open_q:
        lines.append("Open questions:\n" + "\n".join(f"- [{q['id']}] {q['body'][:200]}" for q in open_q[:20]))
    if d["summary"]:
        s = d["summary"]
        lines.append("Current synthesis (replace it with `synthesize` when you have more):\n" + (s if len(s) < 2500 else s[:2500] + "\n…"))
    lines.append("Build on this board rather than starting over; cite existing sources by their S-numbers. "
                 "Before you reply, put what you learn on it as findings and update the synthesis. " + _next_steps(bid))
    return "\n".join(lines)


def render_text(d, full=False):
    """A board as plain text for the agent's `view` action."""
    out = [f"# {d['title']} ({d['status']})", f"Question: {d['question'] or '—'}", ""]
    by = {k: [i for i in d["items"] if i["kind"] == k] for k in KINDS}
    if by["source"]:
        out.append("## Sources")
        for s in by["source"]:
            out.append(f"S{s['ref']}. {s['title'] or s['url']} <{s['url']}> · {s['meta'].get('type')} · credibility "
                       f"{s['meta'].get('credibility')}" + (" · auto" if s["addedBy"] == "auto" else "")
                       + (f"\n    {s['body'][:400 if full else 160]}" if s["body"] else ""))
    if by["finding"]:
        out.append("\n## Findings")
        for f in by["finding"]:
            refs = ", ".join(f"S{r}" for r in f["meta"].get("sources", []))
            out.append(f"- [{f['id']}] {f['meta'].get('theme', '') + ': ' if f['meta'].get('theme') else ''}{f['body']} "
                       f"(confidence {f['meta'].get('confidence')}{'; ' + refs if refs else ''})")
    if by["quote"]:
        out.append("\n## Quotes")
        out += [f"- [{q['id']}] \"{q['body'][:300]}\" — S{q['meta'].get('source') or '?'}" for q in by["quote"]]
    if by["question"]:
        out.append("\n## Questions")
        out += [f"- [{q['id']}] ({q['meta'].get('status')}) {q['body']}" + (f" → {q['meta']['answer']}" if q["meta"].get("answer") else "")
                for q in by["question"]]
    if by["note"]:
        out.append("\n## Notes")
        out += [f"- [{n['id']}] {n['title'] + ': ' if n['title'] else ''}{n['body'][:400]}" for n in by["note"]]
    if by["figure"]:
        out.append("\n## Figures")
        out += [f"- [{f['id']}] {f['title']} <{f['url']}>" for f in by["figure"]]
    if d["summary"]:
        out.append("\n## Synthesis\n" + (d["summary"] if full else d["summary"][:1500]))
    return "\n".join(out)


def _n(n, word):
    return f"{n} {word}{'' if n == 1 else 's'}"


def export_markdown(d):
    """The board as a standalone Markdown report with a numbered bibliography."""
    by = {k: [i for i in d["items"] if i["kind"] == k] for k in KINDS}
    out = [f"# {d['title']}", ""]
    if d["question"]:
        out += [f"> **Research question:** {d['question']}", ""]
    out += [f"_Research board exported from Shell:B · {time.strftime('%Y-%m-%d')} · {_n(len(by['source']), 'source')}, "
            f"{_n(len(by['finding']), 'finding')}_", ""]
    if d["summary"]:
        out += ["## Synthesis", "", d["summary"].strip(), ""]
    if by["finding"]:
        out += ["## Findings", ""]
        themes: dict[str, list] = {}
        for f in by["finding"]:
            themes.setdefault(f["meta"].get("theme") or "General", []).append(f)
        for theme, fs in themes.items():
            if len(themes) > 1:
                out += [f"### {theme}", ""]
            for f in fs:
                refs = "".join(f"[S{r}]" for r in f["meta"].get("sources", []))
                out.append(f"- {f['body']} {refs} _(confidence: {f['meta'].get('confidence')}"
                           f"{', contested' if f['meta'].get('contested') else ''})_")
            out.append("")
    if by["quote"]:
        out += ["## Key quotes", ""]
        for q in by["quote"]:
            out += [f"> {q['body']}", f"> — [S{q['meta'].get('source') or '?'}]"
                    + (f", {q['meta']['location']}" if q["meta"].get("location") else ""), ""]
    if by["question"]:
        out += ["## Questions", ""]
        for q in by["question"]:
            done = q["meta"].get("status") == "answered"
            out.append(f"- [{'x' if done else ' '}] {q['body']}" + (f" — {q['meta']['answer']}" if q["meta"].get("answer") else ""))
        out.append("")
    if by["note"]:
        out += ["## Notes", ""]
        for n in by["note"]:
            out += ([f"**{n['title']}**", ""] if n["title"] else []) + [n["body"], ""]
    if by["source"]:
        out += ["## Sources", ""]
        for s in by["source"]:
            m = s["meta"]
            bits = [b for b in (m.get("author"), m.get("publisher") or m.get("domain"), m.get("published")) if b]
            out.append(f"{s['ref']}. **[S{s['ref']}]** [{s['title'] or s['url']}]({s['url']})" + (f" — {', '.join(bits)}" if bits else ""))
            if s["body"]:
                out.append(f"   {s['body']}")
        out.append("")
    return "\n".join(out)


# ── agent tool ──────────────────────────────────────────────────────────────

def _next_steps(bid):
    """What the board still lacks, so the model keeps going instead of stopping at sources."""
    c = get_board(bid)["counts"]
    summary = bool(get_board(bid)["summary"])
    todo = []
    if c["source"] and not c["finding"]:
        todo.append("add findings (one claim each, citing sources like [\"S1\",\"S2\"], with confidence and theme)")
    if c["finding"] and not summary:
        todo.append("call synthesize with a Markdown write-up citing [S1]… before you reply")
    status = (f"Board now: {c['source']} sources, {c['finding']} findings, {c['quote']} quotes, "
              f"{c['openQuestions']} open questions, synthesis {'written' if summary else 'not written yet'}.")
    return status + (" Next: " + "; ".join(todo) + "." if todo else "")


def _display(bid, **extra):
    b = get_board(bid)
    return {"board": {"id": b["id"], "title": b["title"], "counts": b["counts"], **extra}}


async def research_board(args, ctx):
    action = str(args.get("action") or "view").lower()
    by = f"agent:{ctx.agent.get('id')}"
    bid = board_of(ctx.conv_id)

    if action == "list":
        bs = list_boards()
        if not bs:
            return ToolResult("No research boards yet. Use action=start to create one.")
        return ToolResult("\n".join(f"- {b['id']} · {b['title']} · {b['counts']['source']} sources, {b['counts']['finding']} findings"
                                    f" · {b['status']}" + (" (attached here)" if b["id"] == bid else "") for b in bs))
    if action == "start":
        if bid and not args.get("new"):
            b = get_board(bid)
            return ToolResult(f"This chat already has the board \"{b['title']}\" ({bid}); keep adding to it. "
                              "(Pass new=true to start a separate board.)", _display(bid))
        b = create_board(args.get("title") or "", args.get("question") or "", created_by=by, conv_id=ctx.conv_id)
        return ToolResult(f"Started research board \"{b['title']}\" ({b['id']}) and attached it to this chat. "
                          "Pages you read with web_fetch now land on it automatically. As you learn things, add findings "
                          "(citing S-numbers), quotes and open questions with action=add, and finish with synthesize.",
                          _display(b["id"], started=True))
    if action == "open":
        target = str(args.get("board_id") or "")
        if not get_board(target):
            return ToolResult("No board with that id; action=list shows them.", error=True)
        link(ctx.conv_id, target)
        return ToolResult(f"Attached this chat to board {target}.\n\n" + render_text(board_detail(target)), _display(target))

    if not bid:
        return ToolResult("No research board is attached to this chat. Call action=start (title, question) first, "
                          "or action=open with a board_id.", error=True)

    if action == "search":
        import notebook
        q = str(args.get("query") or "").strip()
        if not q:
            return ToolResult("Pass a query.", error=True)
        srcs = {s["id"]: s for s in notebook.sources(bid, ids=None)}
        hits = await notebook.retrieve(bid, q, list(srcs), k=int(args.get("k") or 8))
        if not hits:
            return ToolResult("No indexed source text matches (sources may still be indexing).")
        return ToolResult("\n\n".join(f"[S{srcs[h['itemId']]['ref']}] {srcs[h['itemId']]['title']} (score {h['score']:.2f})\n{h['text']}"
                                       for h in hits))
    if action == "view":
        return ToolResult(render_text(board_detail(bid), full=bool(args.get("full"))) + "\n\n" + _next_steps(bid))
    if action == "add":
        items = args.get("items")
        if isinstance(items, str):
            try:
                items = json.loads(items)
            except json.JSONDecodeError:
                return ToolResult("items must be a JSON array of objects.", error=True)
        if isinstance(items, dict):
            items = [items]
        if not items and args.get("kind"):
            items = [{k: v for k, v in args.items() if k != "action"}]
        if not items:
            return ToolResult("Nothing to add: pass items=[{kind, …}, …].", error=True)
        done, errors = [], []
        for n, it in enumerate(items[:60], 1):
            if not isinstance(it, dict):
                errors.append(f"#{n}: not an object")
                continue
            kind = str(it.get("kind") or ("source" if it.get("url") else "finding")).lower().removesuffix("s")
            try:
                item, new = add_item(bid, kind, it, added_by=by, conv_id=ctx.conv_id)
            except ValueError as e:
                errors.append(f"#{n} ({kind}): {e}")
                continue
            label = f"S{item['ref']}" if kind == "source" else item["id"]
            done.append(f"{'added' if new else 'updated'} {kind} {label}" + (f": {item['title'][:60]}" if kind == "source" else ""))
        msg = "\n".join(done) or "Nothing added."
        if errors:
            msg += "\nProblems:\n" + "\n".join(errors)
        msg += "\n" + _next_steps(bid)
        return ToolResult(msg, _display(bid, added=len(done)), error=not done)
    if action == "update":
        try:
            it = update_item(bid, args.get("id") or args.get("ref"), {k: v for k, v in args.items() if k not in ("action", "id", "ref")})
        except KeyError:
            return ToolResult("No item with that id (sources can also be named S3).", error=True)
        except ValueError as e:
            return ToolResult(f"Couldn't update: {e}", error=True)
        return ToolResult(f"Updated {it['kind']} {it['id']}.", _display(bid))
    if action == "remove":
        try:
            it = delete_item(bid, args.get("id") or args.get("ref"))
        except KeyError:
            return ToolResult("No item with that id.", error=True)
        return ToolResult(f"Removed {it['kind']} {it['id']}." + (" Its S-number stays retired." if it["kind"] == "source" else ""),
                          _display(bid))
    if action == "synthesize":
        summary = str(args.get("summary") or args.get("text") or "").strip()
        if not summary:
            return ToolResult("Pass the synthesis as `summary` (Markdown, citing [S1] etc.).", error=True)
        known = {i["ref"] for i in board_detail(bid)["items"] if i["kind"] == "source"}
        missing = sorted({int(m) for m in re.findall(r"\[S(\d+)", summary)} - known)
        fields = {"summary": summary}
        if args.get("status") in ("active", "complete"):
            fields["status"] = args["status"]
        if args.get("title"):
            fields["title"] = str(args["title"])[:160]
        update_board(bid, **fields)
        note = f" Warning: it cites S{', S'.join(map(str, missing))}, which aren't on the board — add them." if missing else ""
        return ToolResult("Synthesis saved; the user can read it at the top of the board." + note, _display(bid, synthesized=True))
    return ToolResult("action must be start, add, update, remove, synthesize, view, list or open.", error=True)


ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "kind": {"type": "string", "enum": list(KINDS)},
        "url": {"type": "string", "description": "source: page URL; figure: image URL"},
        "title": {"type": "string"},
        "text": {"type": "string", "description": "finding: the claim; quote: exact words; question; note; source: 1-3 sentence summary"},
        "sources": {"type": "array", "items": {"type": "string"}, "description": "finding: cited sources, e.g. [\"S1\",\"S4\"]"},
        "source": {"type": "string", "description": "quote/figure: the one source, e.g. \"S2\""},
        "confidence": {"type": "string", "enum": list(LEVELS)},
        "theme": {"type": "string", "description": "finding: short theme that groups related findings"},
        "contested": {"type": "boolean", "description": "finding: sources disagree"},
        "type": {"type": "string", "enum": list(SOURCE_TYPES)},
        "credibility": {"type": "string", "enum": list(LEVELS)},
        "author": {"type": "string"}, "published": {"type": "string"},
        "location": {"type": "string", "description": "quote: page/section"},
    },
    "required": ["kind"],
}


def register():
    TOOLS["research_board"] = {
        "fn": research_board, "service": None,
        "ui": {"displayName": "Research Board", "icon": "Telescope", "category": "research",
               "description": "Gathers sources, findings, quotes and open questions onto a board the user can browse, with a cited synthesis."},
        "schema": _fn("research_board",
                      "Keep a Research Board for this chat: a page the user browses with every source, finding, quote and open "
                      "question you gathered, plus your cited synthesis. Actions: start (title, question) · add (items: batch "
                      "of sources/findings/quotes/questions/notes/figures) · update (id or S-number + changed fields, e.g. "
                      "status=answered + answer for a question) · remove (id) · synthesize (summary: Markdown citing [S1], "
                      "[S2]; status=complete when done) · view · list · open (board_id) · search (query: semantic search over the full "
                      "text of every source in the notebook, including files the user uploaded). Sources are numbered S1, S2… in the "
                      "order added; cite them by those numbers.",
                      {"action": {"type": "string", "enum": ["start", "add", "update", "remove", "synthesize", "view", "list", "open", "search"]},
                       "query": {"type": "string", "description": "search: what to look up in the notebook's source text"},
                       "title": {"type": "string", "description": "start: short board title"},
                       "question": {"type": "string", "description": "start: the research question being answered"},
                       "items": {"type": "array", "items": ITEM_SCHEMA, "description": "add: the items to add"},
                       "id": {"type": "string", "description": "update/remove: item id, or a source's S-number"},
                       "status": {"type": "string", "description": "update: question open/answered; synthesize: active/complete"},
                       "answer": {"type": "string", "description": "update: answer to a question"},
                       "summary": {"type": "string", "description": "synthesize: the full Markdown synthesis"},
                       "board_id": {"type": "string", "description": "open: board to attach"},
                       "new": {"type": "boolean", "description": "start: make a new board even if one is attached"},
                       "full": {"type": "boolean", "description": "view: untruncated"}}, ["action"]),
    }
    _give_minerva()


def _give_minerva():
    """One-time: a roster saved before research boards existed doesn't list the tool for Minerva yet."""
    if db.kv_get("migr_research_board"):
        return
    agents = db.kv_get("agents")
    if agents:
        for a in agents:
            if a.get("id") == "minerva" and "research_board" not in a.get("tools", []):
                a["tools"] = [*a.get("tools", []), "research_board"]
        db.kv_set("agents", agents)
    db.kv_set("migr_research_board", True)


# ── API ─────────────────────────────────────────────────────────────────────

def _need(board_id):
    b = get_board(board_id)
    if not b:
        raise HTTPException(404, "No such research board")
    return b


@router.get("/api/research")
def api_list():
    return list_boards()


@router.post("/api/research")
async def api_create(req: Request):
    body = await req.json()
    b = create_board(body.get("title") or "", body.get("question") or "", created_by="user")
    return b


@router.get("/api/research/{board_id}")
def api_get(board_id: str):
    d = board_detail(board_id)
    if not d:
        raise HTTPException(404, "No such research board")
    return d


@router.patch("/api/research/{board_id}")
async def api_patch(board_id: str, req: Request):
    _need(board_id)
    body = await req.json()
    try:
        return update_board(board_id, **{k: body.get(k) for k in ("title", "question", "summary", "status") if k in body})
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/api/research/{board_id}")
def api_delete(board_id: str):
    _need(board_id)
    delete_board(board_id)
    return {"ok": True}


@router.post("/api/research/{board_id}/items")
async def api_add(board_id: str, req: Request):
    _need(board_id)
    body = await req.json()
    try:
        item, _ = add_item(board_id, str(body.get("kind") or ""), body, added_by="user")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return item


@router.patch("/api/research/{board_id}/items/{item_id}")
async def api_item_patch(board_id: str, item_id: str, req: Request):
    try:
        return update_item(board_id, item_id, await req.json())
    except KeyError:
        raise HTTPException(404, "No such item")
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/api/research/{board_id}/items/{item_id}")
def api_item_delete(board_id: str, item_id: str):
    try:
        delete_item(board_id, item_id)
    except KeyError:
        raise HTTPException(404, "No such item")
    return {"ok": True}


@router.post("/api/research/{board_id}/link")
async def api_link(board_id: str, req: Request):
    """Attach a chat to the board (convId given) or start a new chat with an agent already attached to it."""
    b = _need(board_id)
    body = await req.json()
    conv_id = body.get("convId")
    if conv_id:
        if not db.get_conversation(conv_id):
            raise HTTPException(404, "No such conversation")
    else:
        conv_id = db.create_conversation(body.get("agentId") or "minerva", title=f"Research: {b['title']}"[:80])["id"]
    link(conv_id, board_id)
    touch(board_id)
    return db.get_conversation(conv_id)


@router.delete("/api/research/links/{conv_id}")
def api_unlink(conv_id: str):
    unlink(conv_id)
    return {"ok": True}


@router.get("/api/research/{board_id}/export.md")
def api_export(board_id: str):
    d = board_detail(board_id)
    if not d:
        raise HTTPException(404, "No such research board")
    name = re.sub(r"[^\w-]+", "-", d["title"].lower()).strip("-")[:60] or "research"
    return Response(export_markdown(d), media_type="text/markdown; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}.md"'})
