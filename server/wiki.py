"""Wiki: offline Wikipedia (plus Wiktionary and Wikivoyage) from Kiwix ZIM archives, read in Shell:B's own reader.

The archives are datasets (datasets.py downloads, verifies and updates them); this module opens whichever are installed
with python-libzim and reopens them when datasets.py swaps in a new version.

Article HTML comes from mwoffliner and carries MediaWiki's scripts and styles. The reader never shows it raw: `_clean`
keeps the parser output only, drops scripts/styles/handlers with lxml_html_clean and an attribute allowlist, prefixes
ids (no DOM clobbering of the app), turns internal links into #/wiki/<source>/<path> routes, drops links to articles the
archive doesn't have, and points images at /api/wiki/res, which serves image types only, under a no-script CSP.
Snapshots are months old, so everything an agent gets says which snapshot it came from.
"""
import posixpath
import re
import threading
from urllib.parse import quote, unquote, urlsplit

import lxml.html
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from libzim.reader import Archive
from libzim.search import Query, Searcher
from libzim.suggestion import SuggestionSearcher
from lxml_html_clean import Cleaner

import datasets
from tools import TOOLS, ToolResult, _fn

router = APIRouter(prefix="/api/wiki")

ONLINE = {
    "wikipedia": "https://en.wikipedia.org/wiki/",
    "wiktionary": "https://en.wiktionary.org/wiki/",
    "wikivoyage": "https://en.wikivoyage.org/wiki/",
    "wikibooks": "https://en.wikibooks.org/wiki/",
    "wikisource": "https://en.wikisource.org/wiki/",
    "wikiquote": "https://en.wikiquote.org/wiki/",
    "stack_exchange": "https://stackexchange.com/",
    "ifixit": "https://www.ifixit.com/",
    "other": "https://wiki.archlinux.org/title/",
    "gutenberg": "https://www.gutenberg.org/",
}


def _online_url(did: str, project: str, path: str) -> str:
    """Best-effort live URL for the corresponding article/question online."""
    p = quote(path, safe="/")
    if did.startswith("devdocs_en_"):
        topic = did.replace("devdocs_en_", "")
        return f"https://devdocs.io/{topic}/{p}"
    if did.startswith("stackoverflow"):
        return f"https://stackoverflow.com/questions/{p}"
    if did.startswith("serverfault"):
        return f"https://serverfault.com/questions/{p}"
    if did.startswith("security.stackexchange"):
        return f"https://security.stackexchange.com/questions/{p}"
    if did.startswith("datascience.stackexchange"):
        return f"https://datascience.stackexchange.com/questions/{p}"
    if did.startswith("math.stackexchange"):
        return f"https://math.stackexchange.com/questions/{p}"
    if did.startswith("askubuntu"):
        return f"https://askubuntu.com/questions/{p}"
    if did.startswith("superuser"):
        return f"https://superuser.com/questions/{p}"
    if did.startswith("unix.stackexchange"):
        return f"https://unix.stackexchange.com/questions/{p}"
    if did.startswith("archlinux"):
        return f"https://wiki.archlinux.org/title/{p}"
    if did.startswith("alpinelinux"):
        return f"https://wiki.alpinelinux.org/wiki/{p}"
    if did.startswith("appropedia"):
        return f"https://www.appropedia.org/{p}"
    if did.startswith("phet"):
        return "https://phet.colorado.edu/"
    if did.startswith("ifixit"):
        return f"https://www.ifixit.com/Guide/{p}"
    if did.startswith("gutenberg"):
        return f"https://www.gutenberg.org/ebooks/{p}"
    base = ONLINE.get(project, "")
    return base + p if base else ""
DROP = ("script", "style", "link", "meta", "noscript", "button", "input")
DROP_CLASSES = ("mw-editsection", "navbox", "noprint", "mw-empty-elt", "sistersitebox", "mw-jump-link", "printfooter",
                "catlinks", "mw-cite-backlink", "shortdescription", "hatnote-navigation")
_cleaner = Cleaner(scripts=True, javascript=True, comments=True, style=True, inline_style=True, links=True, meta=True,
                   page_structure=False, processing_instructions=True, embedded=True, frames=True, forms=True,
                   annoying_tags=True, remove_unknown_tags=False, safe_attrs_only=True,
                   safe_attrs=frozenset({"href", "src", "alt", "title", "id", "class", "colspan", "rowspan", "width", "height"}))

_lock = threading.Lock()
_open: dict[str, tuple[str, Archive]] = {}   # dataset id → (file, archive)


def _reset(did: str):
    with _lock:
        _open.pop(did, None)


datasets.on_change(_reset)


def sources() -> list[dict]:
    """Installed archives, Wikipedia first. Each: {id, project, name, version, archive}."""
    out = []
    for did, spec in datasets.CATALOG.items():
        if spec["kind"] != "kiwix":
            continue
        inst = datasets.installed(did)
        if not inst:
            continue
        with _lock:
            cur = _open.get(did)
            if not cur or cur[0] != inst["file"]:
                try:
                    cur = (inst["file"], Archive(inst["file"]))
                except RuntimeError as e:
                    print(f"wiki: can't open {inst['file']}: {e}")
                    continue
                _open[did] = cur
        out.append({"id": did, "project": spec["project"], "name": spec["name"], "version": inst["version"], "archive": cur[1]})
    return out


def available() -> bool:
    return any(datasets.installed(d) for d, s in datasets.CATALOG.items() if s["kind"] == "kiwix")


def _source(sid: str | None, project: str | None = None) -> dict:
    srcs = sources()
    target = (sid or project or "").lower().strip()
    if target:
        for s in srcs:
            if (s["id"].lower() == target or
                s["id"].lower().startswith(target) or
                s["project"].lower() == target or
                target in s["name"].lower()):
                return s
        raise HTTPException(404, "that archive isn't installed")
    if srcs:
        return srcs[0]
    raise HTTPException(404, "no wiki archives installed yet")


def _meta(a: Archive, key: str) -> str:
    try:
        return a.get_metadata(key).decode()
    except (RuntimeError, KeyError):
        return ""


_STUB = re.compile(rb'<body>\s*<a href="([^"]+)">[^<]*</a>\s*</body>')


def _follow(a: Archive, path: str) -> tuple:
    """(entry, fragment): follows real redirects and mwoffliner's stub pages for redirects to a section, which are a
    tiny HTML file holding one link (Louvre → Paris/1st_arrondissement#Museums_and_galleries)."""
    e, frag = a.get_entry_by_path(path), None
    for _ in range(5):
        if e.is_redirect:
            e = e.get_redirect_entry()
            continue
        item = e.get_item()
        m = _STUB.search(bytes(item.content)) if item.size < 1024 and item.mimetype.startswith("text/html") else None
        if not m:
            break
        u = urlsplit(m.group(1).decode())
        target = posixpath.normpath(posixpath.join(posixpath.dirname(e.path), unquote(u.path))).lstrip("/")
        if not a.has_entry_by_path(target):
            break
        e, frag = a.get_entry_by_path(target), unquote(u.fragment) or None
    return e, frag


def _entry(a: Archive, path: str):
    return _follow(a, path)[0]


def _resolve(a: Archive, title: str) -> str | None:
    """A path for a title or path the way people (and models) write it: exact path, exact title, else the top suggestion."""
    t = title.strip()
    for p in (t, t.replace(" ", "_"), t[:1].upper() + t[1:].replace(" ", "_")):
        if p and a.has_entry_by_path(p):
            return p
    if a.has_entry_by_title(t):
        return a.get_entry_by_title(t).path
    hits = list(SuggestionSearcher(a).suggest(t).getResults(0, 1))
    return hits[0] if hits else None


# ── cleaning ────────────────────────────────────────────────────────────────

def _body(html: bytes):
    tree = lxml.html.fromstring(html)
    title = (tree.findtext(".//title") or "").strip()
    root = (tree.xpath('//*[contains(concat(" ", @class, " "), " mw-parser-output ")]')
            or tree.xpath('//*[@id="mw-content-text"]') or tree.xpath("//body") or [tree])[0]
    for el in root.xpath(" | ".join(f"descendant::{t}" for t in DROP)):
        el.drop_tree()
    for el in root.xpath('descendant::*[contains(translate(@style, " ", ""), "display:none")]'):
        el.drop_tree()  # hidden microformats (bday spans, sort keys); the cleaner strips styles, which would show them
    for c in DROP_CLASSES:
        for el in root.xpath(f'descendant::*[contains(concat(" ", @class, " "), " {c} ")]'):
            el.drop_tree()
    return title, root


def _clean(src: dict, path: str, html: bytes) -> dict:
    a = src["archive"]
    title, root = _body(html)
    root = _cleaner.clean_html(root)
    here = posixpath.dirname(path)
    for el in root.iter():
        if not isinstance(el.tag, str):
            continue
        if el.get("id"):
            el.set("id", "w-" + el.get("id"))
        if el.tag == "a":
            href = el.attrib.pop("href", None)
            if not href:
                continue
            u = urlsplit(href)
            if u.scheme in ("http", "https"):
                el.set("href", href)
                el.set("target", "_blank")
                el.set("rel", "noopener noreferrer")
                el.set("class", "ext")
            elif href.startswith("#"):
                el.set("data-sec", "w-" + unquote(href[1:]))
            elif not u.scheme:
                target = posixpath.normpath(posixpath.join(here, unquote(u.path))).lstrip("/")
                if target and not target.startswith("..") and a.has_entry_by_path(target):
                    el.set("href", f"#/wiki/{src['id']}/{quote(target, safe='/')}")
                    if u.fragment:
                        el.set("data-frag", "w-" + unquote(u.fragment))
                else:
                    el.drop_tag()  # a red link: the archive doesn't have it
            else:
                el.drop_tag()
        elif el.tag == "img":
            s = el.attrib.pop("src", "")
            target = posixpath.normpath(posixpath.join(here, unquote(urlsplit(s).path))).lstrip("/") if s and not urlsplit(s).scheme else ""
            if target and a.has_entry_by_path(target):
                el.set("src", f"/api/wiki/res/{src['id']}/{quote(target, safe='/')}")
                el.set("loading", "lazy")
            else:
                el.drop_tree()
    for fig in [f for f in root.iter("figure") if not f.xpath("descendant::img")]:
        fig.drop_tree()  # text-only archives: a caption with no picture
    toc = [{"id": h.get("id"), "title": h.text_content().strip(), "level": int(h.tag[1])}
           for h in root.iter("h2", "h3") if h.get("id")]
    return {"title": title, "html": lxml.html.tostring(root, encoding="unicode"), "toc": toc}


# ── plain text for agents ───────────────────────────────────────────────────

def _text(el) -> str:
    return re.sub(r"\s+", " ", el.text_content()).strip()


def _sections(html: bytes) -> tuple[str, list[tuple[str, str]]]:
    """(title, [(heading, text)]) with the lead as heading ''. Paragraphs, lists and infobox rows; other tables skipped."""
    title, root = _body(html)
    for sup in root.xpath('descendant::sup[contains(@class,"reference")]'):
        sup.drop_tree()
    out: list[tuple[str, list[str]]] = [("", [])]
    for el in root.iter("h2", "h3", "h4", "p", "li", "dd", "dt", "tr", "blockquote"):
        if el.tag in ("h2", "h3", "h4"):
            out.append((("  " * (int(el.tag[1]) - 2)) + _text(el), []))
            continue
        if el.tag == "li" and el.xpath("ancestor::li | ancestor::table"):
            continue
        if el.tag in ("p", "dd", "dt", "blockquote") and el.xpath("ancestor::li | ancestor::table | ancestor::blockquote"):
            continue
        if el.tag == "tr":
            if not el.xpath('ancestor::table[contains(@class,"infobox")]'):
                continue
            th, td = el.find("th"), el.find("td")
            line = f"{_text(th)}: {_text(td)}" if th is not None and td is not None else _text(el)
        else:
            line = ("- " if el.tag == "li" else "") + _text(el)
        if line.strip(" -:"):
            out[-1][1].append(line)
    return title, [(h, "\n".join(ls)) for h, ls in out if ls or h]


def _snippet(a: Archive, path: str, words: list[str], n: int = 220) -> str:
    try:
        _, secs = _sections(bytes(_entry(a, path).get_item().content))
    except Exception:  # noqa: BLE001
        return ""
    paras = [p for _, t in secs for p in t.split("\n") if len(p) > 60]
    low = [w.lower() for w in words if len(w) > 2]
    best = next((p for p in paras if low and all(w in p.lower() for w in low)), None) \
        or next((p for p in paras if any(w in p.lower() for w in low)), None) or (paras[0] if paras else "")
    return best if len(best) <= n else best[:n].rsplit(" ", 1)[0] + "…"


def search(q: str, sid: str | None = None, n: int = 10, snippets: bool = True) -> list[dict]:
    srcs = [_source(sid)] if sid else sources()
    out, seen = [], set()
    words = q.split()
    for s in srcs:
        a = s["archive"]
        found = []
        p = _resolve(a, q)  # an exact title first: "Paris" should open Paris, not the page that says Paris most
        if p:
            found.append(p)
        if a.has_fulltext_index:
            found += list(Searcher(a).search(Query().set_query(q)).getResults(0, n))
        for path in found:
            if (s["id"], path) in seen or len(out) >= n * len(srcs):
                continue
            seen.add((s["id"], path))
            try:
                e = _entry(a, path)
            except KeyError:
                continue
            out.append({"source": s["id"], "sourceName": s["name"], "path": e.path, "title": e.title,
                        "snippet": _snippet(a, e.path, words) if snippets else ""})
    return out


# ── HTTP ────────────────────────────────────────────────────────────────────

def _src_view(s: dict) -> dict:
    a = s["archive"]
    return {"id": s["id"], "project": s["project"], "name": s["name"], "version": s["version"],
            "articles": a.article_count, "date": _meta(a, "Date"), "mainPath": a.main_entry.get_item().path if a.has_main_entry else None}


@router.get("/sources")
def api_sources():
    return {"sources": [_src_view(s) for s in sources()]}


@router.get("/suggest")
def api_suggest(q: str, source: str = "", n: int = 8):
    out = []
    for s in [_source(source)] if source else sources():
        for path in SuggestionSearcher(s["archive"]).suggest(q).getResults(0, max(1, min(n, 20))):
            out.append({"source": s["id"], "sourceName": s["name"], "path": path,
                        "title": s["archive"].get_entry_by_path(path).title})
    return {"items": out[: max(1, min(n, 20)) * 2]}


@router.get("/search")
def api_search(q: str, source: str = "", n: int = 12):
    if not q.strip():
        return {"items": []}
    return {"items": search(q, source or None, max(1, min(n, 30)))}


@router.get("/random")
def api_random(source: str = ""):
    s = _source(source or None)
    for _ in range(20):
        e = s["archive"].get_random_entry()
        if not e.is_redirect and e.get_item().mimetype.startswith("text/html"):
            return {"source": s["id"], "path": e.path}
    raise HTTPException(500, "no article found")


@router.get("/article/{sid}/{path:path}")
def api_article(sid: str, path: str):
    s = _source(sid)
    a = s["archive"]
    if not path:
        if not a.has_main_entry:
            raise HTTPException(404, "this archive has no main page")
        path = a.main_entry.get_item().path
    try:
        e, frag = _follow(a, path)
    except KeyError:
        p = _resolve(a, path.replace("_", " "))
        if not p:
            raise HTTPException(404, "no such article in this archive") from None
        e, frag = _follow(a, p)
    item = e.get_item()
    if not item.mimetype.startswith("text/html"):
        raise HTTPException(415, "not an article")
    art = _clean(s, item.path, bytes(item.content))
    return {**art, "title": art["title"] or e.title, "source": s["id"], "sourceName": s["name"], "path": item.path,
            "redirectedFrom": path if item.path != path else None, "anchor": "w-" + frag if frag else None, "snapshot": _meta(a, "Date") or s["version"],
            "online": _online_url(s["id"], s["project"], item.path)}


@router.get("/res/{sid}/{path:path}")
def api_res(sid: str, path: str):
    s = _source(sid)
    try:
        item = _entry(s["archive"], path).get_item()
    except KeyError:
        raise HTTPException(404) from None
    if not item.mimetype.startswith("image/"):
        raise HTTPException(404)
    return Response(bytes(item.content), media_type=item.mimetype, headers={
        "Cache-Control": "public, max-age=604800", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox"})


# ── the agent tool ──────────────────────────────────────────────────────────

READ_LIMIT = 7000


def _link(s: dict, path: str, title: str) -> str:
    return f"[{title}](#/wiki/{s['id']}/{quote(path, safe='/')})"


def wiki_tool(args, ctx):
    action = str(args.get("action") or "search")
    project = str(args.get("source") or "").lower().strip() or None
    try:
        srcs = [_source(project)] if project else sources()
        if not srcs:
            return ToolResult("No offline wiki is installed. The owner can install one on the Offline data page (#/data).", error=True)
        if action == "search":
            q = str(args.get("query") or args.get("title") or "").strip()
            if not q:
                return ToolResult("query is required", error=True)
            hits = [h for s in srcs for h in search(q, s["id"], 6)]
            if not hits:
                return ToolResult(f"Nothing in {', '.join(s['name'] for s in srcs)} matches {q!r}.")
            lines = [f"- {h['title']} ({h['sourceName']}): {h['snippet']}" for h in hits]
            return ToolResult(f"Offline results for {q!r} (snapshots: "
                              + ", ".join(f"{s['name']} {s['version']}" for s in srcs) + "):\n" + "\n".join(lines)
                              + "\n\nRead one with action=read and its exact title.")
        if action == "read":
            want = str(args.get("title") or args.get("query") or "").strip()
            if not want:
                return ToolResult("title is required", error=True)
            for s in srcs:
                p = _resolve(s["archive"], want)
                if p:
                    break
            else:
                return ToolResult(f"No article titled {want!r}. Search first.", error=True)
            e, frag = _follow(s["archive"], p)
            title, secs = _sections(bytes(e.get_item().content))
            title = title or e.title
            head = (f"{s['name']} (offline snapshot {s['version']}; may be out of date): {title}\n"
                    f"Link for the user: {_link(s, e.path, title)}\n")
            sec = str(args.get("section") or (frag or "").replace("_", " ")).strip().lower()
            if sec:
                names = [h.strip().lower() for h, _ in secs]
                i = next((k for k, h in enumerate(names) if h == sec), None)
                if i is None:
                    i = next((k for k, h in enumerate(names) if h and sec in h), None)
                if i is None:
                    return ToolResult(head + "No such section. Sections: " + "; ".join(h.strip() for h, _ in secs if h), error=True)
                depth = len(secs[i][0]) - len(secs[i][0].lstrip())
                j = i + 1  # the section plus its subsections, up to the next heading at the same depth or above
                while j < len(secs) and len(secs[j][0]) - len(secs[j][0].lstrip()) > depth:
                    j += 1
                text = "\n\n".join(f"{'#' * (2 + (len(h) - len(h.lstrip())) // 2)} {h.strip()}\n{t}" for h, t in secs[i:j])
            else:
                text = secs[0][1] if secs and not secs[0][0] else ""
                rest = [h.strip() for h, _ in secs if h]
                if rest:
                    text += "\n\nSections (read one with section=…): " + "; ".join(rest)
            if len(text) > READ_LIMIT:
                text = text[:READ_LIMIT].rsplit(" ", 1)[0] + " … [cut; ask for a narrower section]"
            return ToolResult(head + "\n" + text)
        return ToolResult("action is search or read", error=True)
    except HTTPException as e:
        return ToolResult(str(e.detail), error=True)


async def _wiki(args, ctx):
    import asyncio
    return await asyncio.to_thread(wiki_tool, args, ctx)


def register():
    TOOLS["wiki"] = {
        "fn": _wiki, "service": None, "scope": "global", "auto": "when an offline wiki archive is installed",
        "ui": {"displayName": "Offline Wiki", "icon": "BookOpen", "category": "knowledge",
               "description": "Search and read offline Wikipedia, technical Q&A, textbooks, and reference archives."},
        "schema": _fn("wiki",
                      "Search and read offline snapshots of Wikipedia, Wiktionary, Wikivoyage, Wikibooks, Wikisource, "
                      "Stack Overflow, Unix & Linux, Ask Ubuntu, Super User, Arch Linux, iFixit, or Gutenberg. Works "
                      "without internet. Use it for factual reference, coding solutions, system administration, and repair "
                      "guides instead of answering from memory; use web search for recent events. search returns titles with "
                      "snippets; read returns an article's lead and section list, or one section.",
                      {"action": {"type": "string", "enum": ["search", "read"]},
                       "query": {"type": "string", "description": "search: what to look for"},
                       "title": {"type": "string", "description": "read: the article or question title"},
                       "section": {"type": "string", "description": "read: a section heading from the section list"},
                       "source": {"type": "string", "description": "only this archive (e.g. 'wikipedia', 'stackoverflow', 'unix', 'archlinux', 'wikibooks', 'wikisource', 'ifixit'; default: all installed)"}},
                      ["action"]),
    }
