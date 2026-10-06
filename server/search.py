"""Search everything: GET /api/search for the command palette (Ctrl+K).

The palette already finds commands, apps, chats by title and chat messages (/api/chats/search, episodes_search.py).
This adds the owner's other content, one group per source:

  Codex      notes, contacts, events, links, snippets, files, secrets (by name only): word match on title, body, url,
             tags (and the contact/event details), merged with the Codex's semantic search when it answers in time
  Follow-ups open and done commitments (commitments.py), by text and note
  Library    Studio/Code projects, research notebooks and chat artifacts, by title (and description)
  Files      chat /work files (data/workspaces/<conv>/…) by name, from a filename index rebuilt every INDEX_TTL seconds
  Media      generated pictures, music and sounds (media.py), by prompt
  Wiki       offline Kiwix articles titled exactly like the query (wiki.py) plus a "search the wiki" row, only when
             an archive is installed (see _wiki_lookup for why not libzim's fuzzy suggestions)

Every source runs at once and gets BUDGET seconds; one that hasn't answered by then is dropped from this response (not
awaited), so a cold wiki archive never holds the palette up. Wiki lookups run on their own small pool, at most
WIKI_INFLIGHT at a time, and a late answer is cached for the next identical query. Measured on the live data
(~40k /work files, 43 archives): word-match sources 5-10 ms, Codex semantic 50-110 ms, wiki 40-110 ms.

Incognito chats are invisible here like everywhere else (privacy.py): their files, artifacts, media and follow-ups
are never listed. Words are ANDed: every word has to appear somewhere in the item.
"""
import asyncio
import os
import re
import threading
import time
from collections import OrderedDict
from urllib.parse import quote
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter

import db
import privacy

router = APIRouter()

BUDGET = 0.3                 # seconds each request waits for its sources
MIN_LEN = 2
INDEX_TTL = 30.0             # seconds a /work filename index stays fresh
SKIP_DIRS = {"node_modules", "__pycache__", "venv", ".venv", "site-packages", "dist", "build", "target", ".next",
             ".cache", ".git", ".svn", ".tox", ".mypy_cache", ".pytest_cache", "bower_components"}
MAX_DEPTH = 8
PER_CONV_FILES = 8000        # a chat that unpacked a dataset doesn't crowd out the rest of the index
MAX_FILES = 80_000
WIKI_INFLIGHT = 2
KIND_LABEL = {"note": "Note", "contact": "Contact", "event": "Event", "link": "Link", "snippet": "Snippet",
              "file": "File", "secret": "Secret"}

_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="search")
_wiki_pool = ThreadPoolExecutor(max_workers=WIKI_INFLIGHT, thread_name_prefix="search-wiki")
_wiki_busy = 0
_wiki_cache: "OrderedDict[tuple, list]" = OrderedDict()
_lock = threading.Lock()
_files: dict = {"at": 0.0, "items": [], "building": False}


# ── text helpers ────────────────────────────────────────────────────────────

def words_of(q: str) -> list[str]:
    return [w for w in q.lower().split() if w][:8]


def _like(w: str) -> str:
    return "%" + w.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _where(words: list[str], cols: list[str]) -> tuple[str, list]:
    """Every word in at least one of the columns."""
    parts, args = [], []
    for w in words:
        parts.append("(" + " OR ".join(f"{c} LIKE ? ESCAPE '\\'" for c in cols) + ")")
        args += [_like(w)] * len(cols)
    return " AND ".join(parts) or "1", args


def _flat(text: str) -> str:
    s = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text or "")                      # [text](url) -> text
    s = re.sub(r"\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]*))?\]\]", lambda m: m.group(2) or m.group(1), s)  # [[Title|shown]]
    s = re.sub(r"[#*_`>|]+", "", s)
    return " ".join(s.split())


def snippet(text: str, words: list[str], n: int = 150) -> str:
    """A window of `text` around the first matched word, matches marked [[…]] like the chat-message search."""
    text = _flat(text)
    if not text:
        return ""
    low = text.lower()
    pos = min((p for p in (low.find(w) for w in words) if p >= 0), default=-1)
    start = max(0, pos - n // 3) if pos > n // 2 else 0
    if start:
        start = text.find(" ", start) + 1 or start
    out = text[start:start + n]
    if start + n < len(text):
        out = out.rsplit(" ", 1)[0] + "…"
    if start:
        out = "…" + out
    alt = "|".join(re.escape(w) for w in sorted(set(words), key=len, reverse=True))
    return re.sub(f"({alt})", r"[[\1]]", out, flags=re.I) if alt else out


def _rank(title: str, words: list[str]) -> int:
    t = (title or "").lower()
    q = " ".join(words)
    if t == q:
        return 0
    if t.startswith(q):
        return 1
    if all(w in t for w in words):
        return 2
    return 3


# ── sources ─────────────────────────────────────────────────────────────────

def _codex_route(kind: str, eid: str) -> str:
    if kind == "note":
        return f"#/codex/notes/{eid}"
    if kind == "secret":
        return "#/codex/secrets"
    return f"#/codex/e/{eid}"


def _codex_item(r: dict, words: list[str], text: str) -> dict:
    kind = r["kind"] or "note"
    hint = KIND_LABEL.get(kind, kind.title()) + (" · draft" if r.get("draft") else "")
    return {"id": f"codex:{r['id']}", "title": r["title"] or "Untitled", "snippet": snippet(text, words), "hint": hint,
            "route": _codex_route(kind, r["id"]), "kind": kind}


def codex_text(words: list[str], limit: int) -> list[dict]:
    import codex
    cols = ["title", "body", "url", "tags", "(CASE WHEN kind IN ('contact', 'event') THEN meta ELSE '' END)"]
    w_all, a_all = _where(words, cols)
    w_sec, a_sec = _where(words, ["title"])      # a secret matches by name only
    sql = (f"SELECT * FROM codex_entries WHERE (kind<>'secret' AND {w_all}) OR (kind='secret' AND {w_sec}) "
           "ORDER BY pinned DESC, updated DESC LIMIT 200")
    with db.conn() as c:
        rows = c.execute(sql, a_all + a_sec).fetchall()
    rows = sorted(rows, key=lambda r: _rank(r["title"], words))[:limit]
    out = []
    for r in rows:
        e = codex._entry(r)
        body = r["body"] or ""
        text = e.get("preview", "") if r["kind"] in ("contact", "event", "secret") or not any(
            w in body.lower() for w in words) else body
        out.append(_codex_item({**e, "kind": r["kind"]}, words, text or r["url"] or ""))
    return out


def codex_semantic(q: str, words: list[str], limit: int) -> list[dict]:
    """The Codex page's own search (embeddings + word nudges). Runs on a worker thread with its own event loop:
    codex.search does its row loading and matrix math synchronously, which would stall the server's loop."""
    import codex
    hits = asyncio.run(codex.search(q, k=limit))
    return [_codex_item(h, words, h.get("passage") or h.get("preview") or "") for h in hits]


def follow_ups(words: list[str], limit: int) -> list[dict]:
    w, a = _where(words, ["text", "note"])
    with db.conn() as c:
        rows = c.execute(f"SELECT * FROM commitments WHERE status IN ('open', 'done') AND {w} "
                         f"AND (conv_id IS NULL OR conv_id NOT IN ({privacy.HIDDEN_SQL})) "
                         "ORDER BY status='done', due IS NULL, due, created DESC LIMIT ?", (*a, limit)).fetchall()
    out = []
    for r in rows:
        bits = ["Done" if r["status"] == "done" else "Open"]
        if r["due"]:
            bits.append(f"due {r['due']}")
        if (r["who"] or "me") != "me":
            bits.append(f"waiting on {r['who']}")
        out.append({"id": f"fu:{r['id']}", "title": r["text"] or "", "snippet": snippet(r["note"] or "", words),
                    "hint": " · ".join(bits), "route": "#/activity/follow-ups",
                    "kind": "follow-up-done" if r["status"] == "done" else "follow-up"})
    return out


def library(words: list[str], limit: int) -> list[dict]:
    out = []
    with db.conn() as c:
        w, a = _where(words, ["name", "description"])
        for r in c.execute(f"SELECT id, name, description, kind, updated FROM projects WHERE {w} "
                           "ORDER BY updated DESC LIMIT 50", a):
            k = "code" if r["kind"] == "code" else "studio"
            out.append((_rank(r["name"], words), -(r["updated"] or 0),
                        {"id": f"proj:{r['id']}", "title": r["name"] or "Untitled project",
                         "snippet": snippet(r["description"] or "", words), "hint": "Code" if k == "code" else "Studio",
                         "route": f"#/{k}/{r['id']}", "kind": k}))
        if c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='research_boards'").fetchone():
            w, a = _where(words, ["title", "question"])
            for r in c.execute(f"SELECT id, title, question, updated FROM research_boards WHERE {w} "
                               "ORDER BY updated DESC LIMIT 50", a):
                out.append((_rank(r["title"], words), -(r["updated"] or 0),
                            {"id": f"rb:{r['id']}", "title": r["title"] or "Untitled notebook",
                             "snippet": snippet(r["question"] or "", words), "hint": "Notebook",
                             "route": f"#/research/{r['id']}", "kind": "research"}))
        # latest version of each artifact whose title matches, outside incognito chats
        w, a = _where(words, ["a.title"])
        for r in c.execute(
                f"SELECT a.conv_id, a.id, a.title, a.type, a.created, c.title conv_title FROM artifacts a "
                f"JOIN (SELECT conv_id, id, MAX(version) top FROM artifacts GROUP BY conv_id, id) n "
                f"ON a.conv_id=n.conv_id AND a.id=n.id AND a.version=n.top "
                f"JOIN conversations c ON c.id=a.conv_id "
                f"WHERE COALESCE(c.incognito, 0)=0 AND {w} ORDER BY a.created DESC LIMIT 50", a):
            out.append((_rank(r["title"], words), -(r["created"] or 0),
                        {"id": f"art:{r['conv_id']}/{r['id']}", "title": r["title"] or "Untitled artifact",
                         "snippet": f"in chat “{r['conv_title'] or 'Untitled'}”", "hint": f"Artifact · {r['type']}",
                         "route": f"#/view/{r['conv_id']}/{r['id']}", "kind": "artifact"}))
    out.sort(key=lambda t: (t[0], t[1]))
    return [t[2] for t in out[:limit]]


def _build_files() -> list[tuple]:
    """[(lowercase rel path, lowercase name, rel path, conv id, mtime)] for every visible chat's /work."""
    root = db.DATA / "workspaces"
    if not root.is_dir():
        return []
    with db.conn() as c:
        convs = {r["id"]: r for r in c.execute(
            "SELECT c.id, c.title, c.project_id, p.kind FROM conversations c LEFT JOIN projects p ON p.id=c.project_id "
            "WHERE COALESCE(c.incognito, 0)=0")}
    items: list[tuple] = []
    for conv in os.scandir(root):
        if conv.name not in convs or not conv.is_dir(follow_symlinks=False):
            continue
        base, n, stack = len(conv.path) + 1, 0, [(conv.path, 0)]
        while stack and n < PER_CONV_FILES and len(items) < MAX_FILES:
            d, depth = stack.pop()
            try:
                it = os.scandir(d)
            except OSError:
                continue
            with it:
                for e in it:
                    if e.name.startswith(".") or e.name in SKIP_DIRS:
                        continue
                    try:
                        if e.is_dir(follow_symlinks=False):
                            if depth < MAX_DEPTH:
                                stack.append((e.path, depth + 1))
                        elif e.is_file(follow_symlinks=False):
                            rel = e.path[base:]
                            items.append((rel.lower(), e.name.lower(), rel, conv.name, e.stat().st_mtime))
                            n += 1
                    except OSError:
                        continue
    return items


def _file_index() -> list[tuple]:
    with _lock:
        fresh = time.time() - _files["at"] < INDEX_TTL
        if fresh or (_files["building"] and _files["at"]):
            return _files["items"]
        _files["building"] = True
    try:
        items = _build_files()
        with _lock:
            _files.update(at=time.time(), items=items)
        return items
    finally:
        with _lock:
            _files["building"] = False


def files(words: list[str], limit: int) -> list[dict]:
    hits = [f for f in _file_index() if all(w in f[0] for w in words)]
    hits.sort(key=lambda f: (_rank(f[1], words), -f[4]))
    hits = hits[:limit]
    if not hits:
        return []
    ids = list({f[3] for f in hits})
    with db.conn() as c:
        meta = {r["id"]: r for r in c.execute(
            f"SELECT c.id, c.title, c.project_id, c.incognito, p.kind FROM conversations c "
            f"LEFT JOIN projects p ON p.id=c.project_id WHERE c.id IN ({','.join('?' * len(ids))})", ids)}
    out = []
    for low, name, rel, cid, mtime in hits:
        m = meta.get(cid)
        if not m or m["incognito"]:   # deleted or made incognito since the index was built
            continue
        route = f"#/{'code' if m['kind'] == 'code' else 'studio'}/{m['project_id']}" if m["project_id"] else f"#/c/{cid}"
        out.append({"id": f"file:{cid}/{rel}", "title": os.path.basename(rel), "snippet": f"/work/{rel}",
                    "hint": m["title"] or "Untitled chat", "route": route, "kind": "file",
                    "url": f"/api/workspace/{cid}/{quote(rel)}"})
    return out


def media(words: list[str], limit: int) -> list[dict]:
    w, a = _where(words, ["m.prompt"])
    with db.conn() as c:
        if not c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='media'").fetchone():
            return []
        rows = c.execute(f"SELECT m.id, m.kind, m.tool, m.prompt, m.url, m.created FROM media m WHERE m.hidden=0 AND {w} "
                         f"AND (m.conv_id IS NULL OR m.conv_id NOT IN ({privacy.HIDDEN_SQL})) "
                         "ORDER BY m.created DESC LIMIT ?", (*a, limit * 3)).fetchall()
    import media as M

    def present(url):
        try:
            p = M._path(url or "")
            return p is not None and p.exists()
        except Exception:  # noqa: BLE001
            return False
    rows = [r for r in rows if present(r["url"])][:limit]   # like the Media page: files deleted since don't show
    label = {"image": "Picture", "audio": "Audio", "model": "3D model"}
    return [{"id": f"media:{r['id']}", "title": " ".join((r["prompt"] or "").split())[:90] or "Untitled",
             "snippet": snippet(r["prompt"] or "", words) if len(r["prompt"] or "") > 90 else "",
             "hint": label.get(r["kind"], "Media") + (f" · {r['tool']}" if r["tool"] else ""),
             "route": "#/library/media", "kind": r["kind"] or "image", "url": r["url"]} for r in rows]


def _wiki_lookup(q: str, limit: int) -> list[dict]:
    """Articles whose title is exactly the query (as typed, Capitalized or Title Cased), in every installed archive.

    Exact title lookups take a few ms. libzim's SuggestionSearcher holds the GIL while it works (measured: 1-2 s on the
    Stack Overflow archive, seconds on a cold Wikipedia), which would freeze the whole server on every keystroke, so
    the palette leaves fuzzy matching to the Wiki page and offers a "search the wiki" row instead."""
    import wiki
    t = q.strip()
    variants = list(dict.fromkeys((t, t[:1].upper() + t[1:], t.title(), t.lower())))
    out = []
    for s in wiki.sources():
        a = s["archive"]
        for v in variants:
            try:
                if a.has_entry_by_title(v):
                    e = a.get_entry_by_title(v)
                    out.append({"id": f"wiki:{s['id']}/{e.path}", "title": e.title, "snippet": "", "hint": s["name"],
                                "route": f"#/wiki/{s['id']}/{quote(e.path, safe='/')}", "kind": "wiki"})
                    break
            except Exception:  # noqa: BLE001
                continue
        if len(out) >= limit - 1:
            break
    out = out[:max(0, limit - 1)]
    out.append({"id": f"wiki-search:{t}", "title": f"Search the offline wiki for “{t}”", "snippet": "",
                "hint": "Wiki", "route": f"#/wiki/search/{quote(t, safe='')}", "kind": "wiki-search"})
    return out


def _wiki_job(key: tuple):
    global _wiki_busy
    try:
        res = _wiki_lookup(*key)
        with _lock:
            _wiki_cache[key] = res
            while len(_wiki_cache) > 64:
                _wiki_cache.popitem(last=False)
        return res
    finally:
        with _lock:
            _wiki_busy -= 1


async def wiki_titles(q: str, limit: int) -> list[dict]:
    global _wiki_busy
    key = (q.strip().lower(), limit)
    with _lock:
        if key in _wiki_cache:
            _wiki_cache.move_to_end(key)
            return _wiki_cache[key]
        if _wiki_busy >= WIKI_INFLIGHT:   # earlier keystrokes still digging through a cold archive
            raise TimeoutError("wiki busy")
        _wiki_busy += 1
    try:
        fut = _wiki_pool.submit(_wiki_job, key)
    except Exception:
        with _lock:
            _wiki_busy -= 1
        raise
    return await asyncio.wrap_future(fut)


def _wiki_available() -> bool:
    try:
        import wiki
        return wiki.available()
    except Exception:  # noqa: BLE001  libzim missing or datasets broken: no wiki, no error
        return False


# ── endpoint ────────────────────────────────────────────────────────────────

# (key, group heading, what the palette's empty state says was searched)
GROUPS = [("codex", "Codex", "Codex"), ("follow-ups", "Follow-ups", "follow-ups"), ("library", "Library", "Library"),
          ("files", "Files", "chat files"), ("media", "Media", "generated media"), ("wiki", "Wiki", "offline wiki")]


async def search(q: str, limit: int = 5, budget: float = BUDGET) -> dict:
    q = " ".join((q or "").split())[:200]
    limit = max(1, min(int(limit or 5), 20))
    if len(q) < MIN_LEN:
        return {"query": q, "groups": [], "searched": [], "sources": {}, "ms": 0}
    words = words_of(q)
    loop = asyncio.get_running_loop()
    t0 = time.perf_counter()

    def sync(fn, *a):
        return loop.run_in_executor(_pool, fn, *a)

    jobs: dict[str, asyncio.Future] = {
        "codex": sync(codex_text, words, limit),
        "follow-ups": sync(follow_ups, words, limit),
        "library": sync(library, words, limit),
        "files": sync(files, words, limit),
        "media": sync(media, words, limit),
    }
    if len(q) >= 3:
        jobs["codex-semantic"] = sync(codex_semantic, q, words, limit)
    wiki_on = _wiki_available()
    if wiki_on:
        jobs["wiki"] = asyncio.ensure_future(wiki_titles(q, limit))
    done_at: dict[str, float] = {}
    for name, f in jobs.items():
        f.add_done_callback(lambda _f, n=name: done_at.setdefault(n, time.perf_counter()))
    await asyncio.wait(jobs.values(), timeout=budget)

    results, sources = {}, {}
    for name, f in jobs.items():
        if not f.done():
            f.cancel()   # a thread keeps running to completion; its answer is simply not used
            f.add_done_callback(lambda _f: _f.cancelled() or _f.exception())
            sources[name] = {"status": "timeout"}
        elif f.cancelled() or f.exception() is not None:
            err = None if f.cancelled() else f.exception()
            sources[name] = {"status": "busy" if isinstance(err, TimeoutError) else "error"}
            if err is not None and not isinstance(err, TimeoutError):
                print(f"search {name}: {type(err).__name__}: {err}")
        else:
            results[name] = f.result()
            sources[name] = {"status": "ok", "ms": round((done_at.get(name, time.perf_counter()) - t0) * 1000),
                             "count": len(results[name])}

    if "codex-semantic" in results:   # word matches first, then what only the meaning found
        seen = {i["id"] for i in results.get("codex", [])}
        results["codex"] = results.get("codex", []) + [i for i in results["codex-semantic"] if i["id"] not in seen]
        results["codex"] = results["codex"][:limit]

    groups = [{"group": label, "key": key, "items": results[key]} for key, label, _ in GROUPS if results.get(key)]
    searched = [about for key, _, about in GROUPS if key != "wiki" or wiki_on]
    return {"query": q, "groups": groups, "searched": searched, "sources": sources,
            "ms": round((time.perf_counter() - t0) * 1000)}


@router.get("/api/search")
async def api_search(q: str = "", limit: int = 5):
    return await search(q, limit)
