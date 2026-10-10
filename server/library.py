"""The shared library: everything Shell:B has made, visible to every agent wherever it works.

One `library` tool lets any agent, in any chat, Studio design, Code workspace, chat Project, scheduled run, to-do or
mega plan step, find, read, look at and import the work stored elsewhere. That covers Studio and Code projects (their files),
research notebooks (sources, notes, findings, generated outputs), chat Projects (knowledge files), chat artifacts and
generated media. Imports copy files into the current project (or the chat's /work). A design stays self-contained and
its export keeps working. run_code also sees the same stores read-only under /library (see sandbox_mounts).

Refs: proj-… (Studio/Code project), rb-… (research notebook), grp-… (chat Project), conv-…/<artifact id> (chat
artifact), media (generated images/music). A unique title fragment also works.
"""
import asyncio
import os
import re
import shutil
from pathlib import Path

import db
import groups
import projects as P
import providers
import research
from tools import FILES, TOOLS, WORKSPACES, ToolResult, _fn

TEXT_LIMIT = 60_000
IMPORT_LIMIT = 200 * 1024 * 1024
TEXT_KINDS = ("text", "html", "svg", "markdown")
DOC_EXT = {".pdf", ".docx", ".xlsx", ".xlsm", ".pptx", ".doc", ".rtf", ".odt", ".ods", ".odp", ".epub", ".xls", ".ppt"}
ART_EXT = {"html": ".html", "svg": ".svg", "markdown": ".md", "mermaid": ".mmd"}
CODE_EXT = {"python": ".py", "javascript": ".js", "typescript": ".ts", "tsx": ".tsx", "jsx": ".jsx", "css": ".css",
            "json": ".json", "bash": ".sh", "shell": ".sh", "sql": ".sql", "rust": ".rs", "go": ".go", "c": ".c",
            "cpp": ".cpp", "java": ".java", "yaml": ".yaml", "qml": ".qml"}
MOUNT = "/library"


def allowed(agent: dict, settings: dict) -> bool:
    """Cloud agents see the library only when the owner allows it, like long-term memory."""
    return not providers.is_cloud(agent.get("model", "")) or bool(settings.get("cloudLibrary", False))


def sandbox_mounts() -> list[str]:
    """docker -v flags that put every store read-only under /library in run_code."""
    dirs = {"projects": P.PROJECTS, "research": db.DATA / "research", "chat-projects": groups.GROUPS, "media": FILES,
            "assets": db.DATA / "assets"}
    out = []
    for name, d in dirs.items():
        if d.is_dir():
            out += ["-v", f"{d}:{MOUNT}/{name}:ro"]
    return out


# ── catalog ─────────────────────────────────────────────────────────────────

def _proj_kind(p):
    return "code" if p["kind"] == "code" else "studio"


def entries(kind: str | None = None) -> list[dict]:
    """Every library item, newest first: {ref, kind, sub, title, about, updated}."""
    out = []
    if kind in (None, "studio", "code", "project"):
        for p in db.list_projects():
            k = _proj_kind(p)
            if kind in (None, "project", k):
                out.append({"ref": p["id"], "kind": k, "sub": p["kind"], "title": p["name"],
                            "about": p["description"], "updated": p["updatedAt"]})
    if kind in (None, "research"):
        for b in research.list_boards():
            c = b.get("counts", {})
            out.append({"ref": b["id"], "kind": "research", "sub": f"{c.get('source', 0)} sources, {c.get('output', 0)} outputs",
                        "title": b["title"] or "(untitled notebook)", "about": b["question"], "updated": b["updatedAt"]})
    if kind in (None, "chat-project"):
        for g in groups.list_groups():
            out.append({"ref": g["id"], "kind": "chat-project", "sub": f"{g.get('fileCount', 0)} knowledge files",
                        "title": g.get("name") or "(untitled project)", "about": (g.get("description") or "")[:200],
                        "updated": g.get("updatedAt", 0)})
    if kind in (None, "artifact"):
        for a in db.all_artifacts():
            out.append({"ref": f"{a['convId']}/{a['id']}", "kind": "artifact", "sub": a["type"], "title": a["title"],
                        "about": f"in chat \"{a['convTitle']}\"", "updated": a["timestamp"]})
    if kind in (None, "media") and FILES.is_dir():
        n = sum(1 for f in FILES.iterdir() if f.is_file())
        if n:
            out.append({"ref": "media", "kind": "media", "sub": f"{n} files", "title": "Generated media (images, music)",
                        "about": "", "updated": max(f.stat().st_mtime for f in FILES.iterdir() if f.is_file()) * 1000})
    return sorted(out, key=lambda e: -(e["updated"] or 0))


def _line(e):
    about = f" — {e['about'][:120]}" if e["about"] else ""
    return f"- `{e['ref']}` · {e['kind']} ({e['sub']}) · {e['title']}{about}"


def catalog(exclude: str | None = None, limit: int = 20) -> str:
    """Compact list of recent work for the system prompt, so agents know what exists without a tool call."""
    es = [e for e in entries() if e["ref"] != exclude and e["kind"] != "artifact"][:limit]
    return "\n".join(_line(e) for e in es)


def resolve(ref: str) -> dict:
    """A ref (or a unique title fragment) → its entry."""
    ref = str(ref or "").strip().strip("`")
    if not ref:
        raise ValueError("Pass ref: an id from action=list, e.g. proj-…, rb-…, grp-…, conv-…/artifact-id or media.")
    ref = re.sub(r"^(artifact|board|plan|project):", "", ref)
    es = entries()
    for e in es:
        if e["ref"] == ref:
            return e
    low = ref.lower()
    hits = [e for e in es if e["title"].lower() == low] or [e for e in es if low in e["title"].lower()]
    if len(hits) == 1:
        return hits[0]
    if hits:
        raise ValueError(f"{ref!r} matches {len(hits)} items; use one of these refs:\n" + "\n".join(_line(e) for e in hits[:10]))
    raise ValueError(f"Nothing in the library matches {ref!r}. action=list shows everything.")


# ── files of an item ────────────────────────────────────────────────────────

def _research_file(bid, it) -> Path | None:
    import notebook
    m = it["meta"]
    if m.get("file"):
        p = notebook._bdir(bid) / "files" / m["file"]
        if p.is_file():
            return p
    for d in ("audio", "files"):
        hit = next((notebook._bdir(bid) / d).glob(f"{it['id']}*"), None) if (notebook._bdir(bid) / d).is_dir() else None
        if hit:
            return hit
    return None


def _item_name(it):
    base = re.sub(r"[^\w\-]+", "-", (it["title"] or it["id"]).lower()).strip("-")[:60] or it["id"]
    return f"S{it['ref']}-{base}" if it["kind"] == "source" else base


def listing(e: dict, sub: str = "") -> str:
    k, ref = e["kind"], e["ref"]
    if k in ("studio", "code"):
        files = [f for f in P.list_files(ref) if not sub or f["path"].startswith(sub.strip("/"))]
        if not files:
            return "(no files)"
        lines = [f"{f['path']}  ({f['kind']}, {f['size']:,} bytes"
                 + (f", {P.image_info(P.safe_path(ref, f['path']))}" if f["kind"] == "image" else "") + ")" for f in files[:400]]
        return "\n".join(lines) + (f"\n…and {len(files) - 400} more (pass path= to narrow)" if len(files) > 400 else "")
    if k == "research":
        d = research.board_detail(ref)
        out = [research.render_text(d)]
        files = [f"- S{it['ref']}: {_research_file(ref, it).name}" for it in d["items"]
                 if it["kind"] == "source" and _research_file(ref, it)]
        outs = [f"- {it['id']}: {it['title']} ({it['meta'].get('type', 'output')})" for it in d["items"] if it["kind"] == "output"]
        if outs:
            out.append("## Generated outputs (read with path=<id>)\n" + "\n".join(outs))
        if files:
            out.append("## Original source files (import with path=S#)\n" + "\n".join(files))
        out.append("Read a source's full text with path=S#, or any note/finding/output with path=<item id>.")
        return "\n\n".join(out)
    if k == "chat-project":
        meta = groups._meta(ref)
        if not meta:
            return "(no knowledge files)"
        return "\n".join(f"{n}  ({m.get('size', 0):,} bytes, {m.get('chars', 0):,} chars of text)" for n, m in sorted(meta.items()))
    if k == "artifact":
        conv, aid = ref.split("/", 1)
        a = next(x for x in db.latest_artifacts(conv) if x["id"] == aid)
        return f"Artifact {aid} v{a['version']} ({a['type']}{', ' + a['language'] if a['language'] else ''}), {len(a['content']):,} chars. Read it with action=read."
    if k == "media":
        fs = sorted((f for f in FILES.iterdir() if f.is_file()), key=lambda f: -f.stat().st_mtime)
        return "\n".join(f"{f.name}  ({f.stat().st_size:,} bytes)" for f in fs[:200])
    return ""


def locate(e: dict, path: str) -> tuple[Path | None, str | None, str]:
    """One thing inside an item → (file on disk or None, its text or None, a file name for imports).
    read prefers the text (already extracted/OCR'd), import prefers the file."""
    k, ref, path = e["kind"], e["ref"], str(path or "").strip().lstrip("/")
    if k in ("studio", "code"):
        if not path:
            raise ValueError("Pass path: a file or folder in that project (action=browse lists them).")
        p = P.safe_path(ref, path)
        if not p.exists():
            raise ValueError(f"{path} does not exist in {e['title']}.")
        return p, None, p.name
    if k == "research":
        import notebook
        if not path:
            d = research.board_detail(ref)
            return None, research.export_markdown(d), _item_name({"kind": "", "title": d["title"], "id": ref, "ref": 0}) + ".md"
        it = research.resolve_item(ref, path)
        if not it:
            raise ValueError(f"No item {path!r} in that notebook (use S#, or an item id from action=browse).")
        if it["kind"] == "source":
            f = _research_file(ref, it)  # read uses the extracted text, import copies the original file
            return f, notebook.source_text(ref, it["id"]) or it["body"] or None, (f.name if f else _item_name(it) + ".txt")
        f = _research_file(ref, it) if it["kind"] == "output" else None
        body = it["body"] or ""
        if it["meta"].get("data") and not body:
            import json
            body = json.dumps(it["meta"]["data"], indent=1)
        return f, (f"# {it['title']}\n\n{body}" if it["title"] else body), (f.name if f else _item_name(it) + ".md")
    if k == "chat-project":
        name = groups._safe_name(path)
        p = groups.GROUPS / ref / "files" / name
        if not p.is_file():
            raise ValueError(f"No knowledge file {path!r} in that Project.")
        return p, groups.file_text(ref, name) or None, name
    if k == "artifact":
        conv, aid = ref.split("/", 1)
        a = next(x for x in db.latest_artifacts(conv) if x["id"] == aid)
        ext = ART_EXT.get(a["type"]) or CODE_EXT.get((a["language"] or "").lower(), ".txt")
        return None, a["content"], f"{aid}{ext}"
    if k == "media":
        p = (FILES / Path(path).name)
        if not path or not p.is_file():
            raise ValueError("Pass path: a file name from action=browse ref=media.")
        return p, None, p.name
    raise ValueError("Unknown item.")


def _text_of(p: Path) -> str:
    if p.suffix.lower() in DOC_EXT:
        return groups.extract(p)
    return p.read_text(errors="replace")


# ── tool ────────────────────────────────────────────────────────────────────

def _dest_root(ctx) -> Path:
    if ctx.project_id:
        return P.root(ctx.project_id)
    ws = WORKSPACES / ctx.conv_id
    ws.mkdir(parents=True, exist_ok=True)
    return ws


def _dest(ctx, rel: str) -> Path:
    if ctx.project_id:
        return P.safe_path(ctx.project_id, rel)
    base = _dest_root(ctx).resolve()
    rel = re.sub(r"^/?work/", "", rel.strip()).lstrip("/")
    p = (base / rel).resolve()
    if p != base and not str(p).startswith(str(base) + "/"):
        raise ValueError(f"Path escapes /work: {rel!r}")
    return p


def _size(p: Path) -> int:
    return p.stat().st_size if p.is_file() else sum(f.stat().st_size for f in p.rglob("*") if f.is_file() and ".git" not in f.parts)


async def _search(query: str, kind: str | None, ctx) -> str:
    words = [w for w in re.findall(r"\w+", query.lower()) if len(w) > 1]
    if not words:
        raise ValueError("Pass a query.")
    phrase = re.compile(re.escape(query.strip()), re.I)

    def hit(s):
        s = (s or "").lower()
        return all(w in s for w in words)

    found = [f"{_line(e)}  [title/description match]" for e in entries(kind) if hit(f"{e['title']} {e['about']}")][:15]
    lines: list[str] = []

    def scan():
        for e in entries(kind):
            if len(lines) >= 60:
                return
            if e["kind"] in ("studio", "code"):
                for f in P.list_files(e["ref"]):
                    if hit(f["path"]):
                        lines.append(f"`{e['ref']}` {f['path']}  [file name] ({e['title']})")
                    if f["kind"] not in TEXT_KINDS or f["size"] > 400_000:
                        continue
                    text = P.safe_path(e["ref"], f["path"]).read_text(errors="replace")
                    for i, ln in enumerate(text.splitlines()):
                        if phrase.search(ln) or hit(ln):
                            lines.append(f"`{e['ref']}` {f['path']}:{i + 1}: {ln.strip()[:200]}")
                            break
            elif e["kind"] == "chat-project":
                for name in groups._meta(e["ref"]):
                    t = groups.file_text(e["ref"], name)
                    m = phrase.search(t)
                    if m or hit(name):
                        snip = t[max(0, m.start() - 80):m.end() + 120].replace("\n", " ") if m else ""
                        lines.append(f"`{e['ref']}` {name}: …{snip}…  ({e['title']})")
            elif e["kind"] == "artifact":
                conv, aid = e["ref"].split("/", 1)
                a = next((x for x in db.latest_artifacts(conv) if x["id"] == aid), None)
                m = phrase.search(a["content"]) if a else None
                if m:
                    lines.append(f"`{e['ref']}` artifact \"{e['title']}\": …{a['content'][max(0, m.start() - 80):m.end() + 120]}…".replace("\n", " "))
            elif e["kind"] == "research":
                for it in research.board_detail(e["ref"])["items"]:
                    if it["kind"] != "source" and hit(f"{it['title']} {it['body']}"):
                        lines.append(f"`{e['ref']}` {it['kind']} {it['id']}: {it['title'] or it['body'][:120]}  ({e['title']})")

    await asyncio.to_thread(scan)
    sem = []
    if kind in (None, "research"):  # meaning-based search over every notebook's indexed source text
        import notebook
        for e in [x for x in entries("research")][:8]:
            srcs = {s["id"]: s for s in notebook.sources(e["ref"], ids=None)}
            try:
                hits = await notebook.retrieve(e["ref"], query, list(srcs), k=3)
            except Exception:  # embedding model unavailable: keyword results still stand
                hits = []
            sem += [(h["score"], f"`{e['ref']}` S{srcs[h['itemId']]['ref']} {srcs[h['itemId']]['title']} (score {h['score']:.2f}): "
                                 f"{h['text'][:300]}".replace("\n", " ")) for h in hits if h["score"] >= 0.45]
    sem = [s for _, s in sorted(sem, key=lambda x: -x[0])[:8]]
    if not (found or lines or sem):
        return f"Nothing in the library matches {query!r}."
    out = []
    if found:
        out.append("Items:\n" + "\n".join(found))
    if lines:
        out.append("Inside files:\n" + "\n".join(lines[:60]))
    if sem:
        out.append("Research sources (by meaning):\n" + "\n".join(sem))
    return "\n\n".join(out)


async def library(args, ctx):
    action = str(args.get("action") or "list").lower()
    kind = str(args.get("kind") or "").strip() or None
    path = str(args.get("path") or "").strip()
    try:
        if action == "list":
            es = [e for e in entries(kind) if not args.get("query") or str(args["query"]).lower() in f"{e['title']} {e['about']}".lower()]
            if not es:
                return ToolResult("The library is empty" + (f" for kind={kind}" if kind else "") + ".")
            here = f"\n(You are working in `{ctx.project_id}`.)" if ctx.project_id else ""
            return ToolResult(f"{len(es)} item(s), newest first:\n" + "\n".join(_line(e) for e in es[:150]) + here)
        if action == "search":
            return ToolResult(await _search(str(args.get("query") or ""), kind, ctx))
        e = resolve(args.get("ref"))
        if action == "browse":
            body = await asyncio.to_thread(listing, e, path)
            return ToolResult(f"{e['title']} (`{e['ref']}`, {e['kind']}):\n{body}")
        if action == "read":
            f, text, _ = await asyncio.to_thread(locate, e, path)
            if f is not None and f.is_dir():
                return ToolResult(f"{path} is a folder:\n" + await asyncio.to_thread(listing, e, path))
            if text is None and f is not None:
                kind_ = P.file_kind(f)
                if kind_ in ("image", "font", "video", "audio", "binary") and f.suffix.lower() not in DOC_EXT:
                    hint = "use action=view to look at it" if kind_ == "image" else "import it, or open it in run_code under /library"
                    return ToolResult(f"{path or f.name} is a {kind_} file ({f.stat().st_size:,} bytes): {hint}.")
                text = await asyncio.to_thread(_text_of, f)
            start, end = max(1, int(args.get("start_line") or 1)), int(args.get("end_line") or 0)
            if start > 1 or end:
                text = "".join(text.splitlines(keepends=True)[start - 1:end or None])
            if len(text) > TEXT_LIMIT:
                text = text[:TEXT_LIMIT] + f"\n…[truncated at {TEXT_LIMIT} chars; continue with start_line/end_line]"
            return ToolResult(text or "(empty)")
        if action == "view":
            from studio_tools import _deliver_images, _render_svg
            f, _, _ = locate(e, path)
            if f is None or not f.is_file():
                return ToolResult("action=view needs an image file.", error=True)
            k = P.file_kind(f)
            if k == "svg" and e["kind"] in ("studio", "code"):
                png = await _render_svg(e["ref"], path)
            elif k == "image":
                png = f.read_bytes()
            else:
                return ToolResult(f"{path} is not an image (it's {k}).", error=True)
            if not png:
                return ToolResult(f"Couldn't render {path}.", error=True)
            text, imgs = await _deliver_images(ctx, [png], f"Here is {path} from {e['title']} ({P.image_info(f) or k}).",
                                               f"Describe this image ({path}) precisely for a designer: subject, composition, "
                                               "colors (hex if you can), typography, style, and anything notable.")
            return ToolResult(text, model_images=imgs)
        if action == "import":
            if e["kind"] in ("studio", "code") and e["ref"] == ctx.project_id:
                return ToolResult("That is the project you're in; use rename_file or run_code to copy within it.", error=True)
            f, text, name = await asyncio.to_thread(locate, e, path)
            to = str(args.get("to") or "").strip()
            if not to:
                to = (f"assets/{name}" if ctx.project_id and not P.is_code(ctx.project_id) else name)
            dest = _dest(ctx, to)
            if dest.exists() and not args.get("overwrite"):
                return ToolResult(f"{to} already exists here. Pass overwrite=true or a different `to`.", error=True)
            if f is not None and _size(f) > IMPORT_LIMIT:
                return ToolResult(f"That is over {IMPORT_LIMIT // 2**20} MB; import a smaller part.", error=True)
            dest.parent.mkdir(parents=True, exist_ok=True)

            def copy():
                if f is None:
                    dest.write_text(text)
                elif f.is_dir():
                    shutil.rmtree(dest, ignore_errors=True)
                    skip = shutil.ignore_patterns(".git", "node_modules", "__pycache__")
                    # symlinks are dropped: copytree would follow them and copy host files out of /work
                    shutil.copytree(f, dest, ignore=lambda d, names: set(skip(d, names)) | {n for n in names if os.path.islink(os.path.join(d, n))})
                else:
                    shutil.copy2(f, dest)
                return [dest] if dest.is_file() else [p for p in dest.rglob("*") if p.is_file()]

            copied = await asyncio.to_thread(copy)
            base = _dest_root(ctx)
            rels = [str(p.relative_to(base)) for p in copied]
            if ctx.project_id:
                for r in rels:
                    await ctx.emit({"type": "file", "path": r, "action": "created"})
                where = "this project"
                ref_hint = (f" Reference it relative to the page that uses it, e.g. `{rels[0]}` from the project root."
                            if len(rels) == 1 else "")
            else:
                where = "/work"
                ref_hint = f" Link it for the user as [{name}](file:/work/{rels[0]})." if len(rels) == 1 else ""
            src = f"{e['title']} (`{e['ref']}`" + (f" {path}" if path else "") + ")"
            shown = ", ".join(rels[:20]) + (f" …and {len(rels) - 20} more" if len(rels) > 20 else "")
            return ToolResult(f"Copied {len(rels)} file(s) from {src} into {where}: {shown}.{ref_hint} It's a copy, so later "
                              "changes to the original won't show up here; import again to refresh.",
                              {"file": {"path": rels[0], "action": "created"}} if ctx.project_id and rels else {})
        return ToolResult("Unknown action. Use list, search, browse, read, view or import.", error=True)
    except (ValueError, StopIteration) as ex:
        return ToolResult(str(ex) or "Not found.", error=True)


GUIDE = ("- library reaches everything Shell:B has made, from any chat or project: Studio designs and Code workspaces (their "
         "files), research notebooks (sources, notes, findings, outputs), chat Projects (knowledge files), chat artifacts and "
         "generated media. Actions: list · search (query) · browse (ref) · read (ref, path) · view (ref, path; images) · "
         "import (ref, path, to) copies a file or folder into where you're working. When the user mentions earlier work "
         "(\"use the logo from the launch page\", \"follow the brand system\", \"what did the research find\"), look it up "
         "here instead of asking or redrawing it. Import assets rather than hot-linking them, so the design stays "
         f"self-contained. In run_code the same stores are read-only under {MOUNT}/ (projects/<proj-id>/…, "
         "research/<rb-id>/files, chat-projects/<grp-id>/files, media/, assets/<asset library id>/).")


def register():
    TOOLS["library"] = {
        "fn": library, "service": None, "scope": "global", "auto": "for every agent (cloud agents need Cloud → Library)",
        "ui": {"displayName": "Shared Library", "icon": "Library", "category": "library",
               "description": "Every agent can find, read, view and import work from any Studio design, Code workspace, "
                              "research notebook, chat Project or artifact."},
        "schema": _fn("library",
                      "Find and reuse anything Shell:B has made elsewhere: Studio designs, Code workspaces, research notebooks, "
                      "chat Projects, chat artifacts and generated media. list → refs; search (query) → matching items, "
                      "files and passages; browse (ref) → its files or contents; read (ref, path) → text (PDF/Office "
                      "extracted); view (ref, path) → look at an image; import (ref, path, to) → copy a file or whole "
                      "folder (e.g. assets, tokens.css, a component) into the current project or /work. For research "
                      "notebooks, path is S# (a source) or an item id; for artifacts, leave path empty.",
                      {"action": {"type": "string", "enum": ["list", "search", "browse", "read", "view", "import"]},
                       "ref": {"type": "string", "description": "Item from list: proj-…, rb-…, grp-…, conv-…/<artifact id>, media, or a unique title"},
                       "path": {"type": "string", "description": "File or folder inside the item (S# or item id for research)"},
                       "query": {"type": "string", "description": "search: words to look for; list: filter titles"},
                       "kind": {"type": "string", "enum": ["studio", "code", "research", "chat-project", "artifact", "media"],
                                "description": "Limit list/search to one kind"},
                       "to": {"type": "string", "description": "import: destination path (default assets/<name> in Studio, <name> elsewhere)"},
                       "overwrite": {"type": "boolean"},
                       "start_line": {"type": "integer"}, "end_line": {"type": "integer"}}, ["action"]),
    }
