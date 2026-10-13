"""Community gallery: themes, screensavers, Studio templates and agents other people published on GitHub, browsed and
installed from Settings, the Studio and the Agent Lab's Store.

Sources (kv `gallery_sources`, the owner can add more): a GitHub repository per kind, laid out like
ShellB-App/Shell-B-Themes (themes/<id>/theme.json), ShellB-App/Shell-B-Screensavers (screensavers/<id>/index.html
+ saver.json + preview image), ShellB-App/Shell-B-Studio-Templates (templates/<id>/template.json + project files) and
ShellB-App/Shell-B-Agents (agents/<id>/agent.json). Each is fetched the way the Community Hub fetches skill repositories: one tarball at a
pinned commit (community.fetch_repo, public-internet guard, tarfile "data" filter, size cap), kept under data/community/
repos, so browsing works offline once a source has been fetched. The catalogue (index.json, or the folders when a fork
has none) is cached in kv `gallery_<kind>` with the commit it came from.

Installing is owner-only and never silent (an admin key or owner session, audit-logged):
  - a theme goes through themes.clean, the same validator the design_theme tool uses, so a file from the internet can
    change colours, fonts and particles and nothing else; it joins the owner's custom themes with its provenance
  - a screensaver becomes a Screensaver project in the Studio (only the folder's files, allowed types, size caps, no
    dotfiles) and runs like any Studio screensaver: index.html in a sandboxed iframe, scripts only, no same-origin
  - a template becomes a new Studio project of its kind (same file rules), its brief in DESIGN.md; every use is a new
    project, so nothing is marked installed
  - an agent goes through clean_agent: only the persona fields the Agent Lab edits, within the format's limits, its
    tools cut to the agent tools this Shell:B has, never the adult flag; it runs on the owner's default chat model
    unless it names a local model that is installed, and never on a cloud model, so installing can't send chats out
Nothing here is reachable by agents: there is no tool, so a chat can't install a look the owner didn't pick.
"""
import asyncio
import json
import re
import shutil
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

import auth
import community
import db
import themes

router = APIRouter(prefix="/api/gallery")
KINDS = ("theme", "screensaver", "template", "agent")
DEFAULT_SOURCES = [
    {"id": "shellb-themes", "kind": "theme", "repo": "ShellB-App/Shell-B-Themes", "ref": "main"},
    {"id": "shellb-screensavers", "kind": "screensaver", "repo": "ShellB-App/Shell-B-Screensavers", "ref": "main"},
    {"id": "shellb-templates", "kind": "template", "repo": "ShellB-App/Shell-B-Studio-Templates", "ref": "main"},
    {"id": "shellb-agents", "kind": "agent", "repo": "ShellB-App/Shell-B-Agents", "ref": "main"},
]
INSTALLED_KEY = "gallery_installed"
REFRESH_AFTER = 24 * 3600
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,39}$")
REPO_RE = re.compile(r"^[\w.-]+/[\w.-]+$")
URL_RE = re.compile(r"^https?://[^\s\"'<>]{1,200}$")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
MODEL_RE = re.compile(r"^[A-Za-z0-9][\w.\-/:]{0,99}$")
EFFORTS = ("off", "low", "medium", "high")
NEEDS = ("tools", "vision", "thinking")
SAVER_FILES = {".html", ".css", ".js", ".json", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".woff2", ".txt", ".md"}
TEMPLATE_FILES = SAVER_FILES | {".mjs", ".ts", ".ico", ".woff", ".ttf", ".otf", ".py", ".toml", ".yaml", ".yml", ".csv", ".glb", ".gltf", ".mp3", ".ogg", ".wav"}
TEMPLATE_MAX_FILE, TEMPLATE_MAX_FOLDER = 4 * 2**20, 16 * 2**20
PREVIEWS = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml"}
MAX_FILE, MAX_FOLDER = 2 * 2**20, 8 * 2**20
_locks: dict[str, asyncio.Lock] = {}


def sources() -> list[dict]:
    v = db.kv_get("gallery_sources")
    if not isinstance(v, list) or not v:
        return [dict(s) for s in DEFAULT_SOURCES]
    out = [s for s in v if isinstance(s, dict) and s.get("kind") in KINDS and REPO_RE.match(str(s.get("repo") or ""))]
    # a kind added after the owner saved their own list (agents, 2026-10) still gets its official source
    have = {s["kind"] for s in out}
    return out + [dict(s) for s in DEFAULT_SOURCES if s["kind"] not in have]


def add_source(kind: str, repo: str, ref: str = "main") -> dict:
    repo = repo.strip().removeprefix("https://github.com/").removesuffix(".git").strip("/")
    if kind not in KINDS or not REPO_RE.match(repo):
        raise ValueError("A source is a kind (theme or screensaver) and a GitHub repository, owner/name")
    src = {"id": re.sub(r"[^a-z0-9]+", "-", repo.lower()).strip("-"), "kind": kind, "repo": repo, "ref": (ref or "main").strip()[:64]}
    cur = [s for s in sources() if s["id"] != src["id"]]
    db.kv_set("gallery_sources", cur + [src])
    return src


def remove_source(sid: str):
    cur = [s for s in sources() if s["id"] != sid]
    if len(cur) == len(sources()):
        raise KeyError(sid)
    db.kv_set("gallery_sources", cur)
    for kind in KINDS:
        cache = db.kv_get(f"gallery_{kind}") or {}
        if isinstance(cache, dict) and sid in cache:
            del cache[sid]
            db.kv_set(f"gallery_{kind}", cache)


# ── reading a fetched repository ─────────────────────────────────────────────

def _url(v) -> str:
    return v if isinstance(v, str) and URL_RE.match(v) else ""


def _rel_ok(rel: str) -> bool:
    parts = rel.replace("\\", "/").split("/")
    return bool(rel) and all(p and p not in (".", "..") and not p.startswith(".") for p in parts)


def _theme_items(root: Path) -> list[dict]:
    items = []
    for f in sorted(root.glob("themes/*/theme.json")):
        tid = f.parent.name
        if not ID_RE.match(tid):
            continue
        try:
            spec = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(spec, dict) or not isinstance(spec.get("palette"), dict):
            continue
        theme, _ = themes.clean(spec)
        pal = theme["palette"]
        items.append({"id": tid, "name": theme["name"], "blurb": theme["blurb"], "mode": theme["mode"],
                      "author": str(spec.get("author") or "")[:80], "authorUrl": _url(spec.get("authorUrl")), "license": str(spec.get("license") or "")[:40],
                      "version": str(spec.get("version") or "1.0")[:20], "tags": [str(t)[:24] for t in (spec.get("tags") or [])[:8] if isinstance(t, str)],
                      "path": f"themes/{tid}/theme.json", "theme": theme,
                      "swatch": {"bg": pal["bg"], "panel": pal["panel"], "text": pal["text"], "inks": pal["inks"]}})
    return items


def _saver_items(root: Path) -> list[dict]:
    items = []
    for d in sorted(p for p in root.glob("screensavers/*") if p.is_dir()):
        sid = d.name
        if not ID_RE.match(sid) or not (d / "index.html").is_file():
            continue
        try:
            meta = json.loads((d / "saver.json").read_text()) if (d / "saver.json").is_file() else {}
        except (OSError, ValueError):
            meta = {}
        if not isinstance(meta, dict):
            meta = {}
        preview = next((p.name for p in (d / "preview.jpg", d / "preview.png", d / "preview.webp") if p.is_file()), None)
        files, total = [], 0
        for p in d.rglob("*"):
            if p.is_symlink() or not p.is_file() or p.name == "saver.json" or p.name == preview:
                continue
            rel = p.relative_to(d).as_posix()
            if not _rel_ok(rel) or p.suffix.lower() not in SAVER_FILES or p.stat().st_size > MAX_FILE:
                continue
            files.append(rel)
            total += p.stat().st_size
        if total > MAX_FOLDER:
            continue
        items.append({"id": sid, "name": str(meta.get("name") or sid.replace("-", " ").title())[:40],
                      "blurb": str(meta.get("blurb") or "")[:200], "author": str(meta.get("author") or "")[:80], "authorUrl": _url(meta.get("authorUrl")),
                      "license": str(meta.get("license") or "")[:40], "version": str(meta.get("version") or "1.0")[:20],
                      "tags": [str(t)[:24] for t in (meta.get("tags") or [])[:8] if isinstance(t, str)],
                      "clockSafe": meta.get("clockSafe") is not False, "path": f"screensavers/{sid}",
                      "preview": f"screensavers/{sid}/{preview}" if preview else None, "files": sorted(files)})
    return items


def _template_items(root: Path) -> list[dict]:
    import projects
    items = []
    for d in sorted(p for p in root.glob("templates/*") if p.is_dir()):
        tid = d.name
        if not ID_RE.match(tid):
            continue
        try:
            meta = json.loads((d / "template.json").read_text())
        except (OSError, ValueError):
            continue
        kind = meta.get("kind") if isinstance(meta, dict) else None
        if kind not in projects.KINDS:
            continue
        entry = "README.md" if kind == "code" else projects.KINDS[kind].get("entry", "index.html")
        if not (d / entry).is_file():
            continue
        preview = next((p.name for p in (d / "preview.jpg", d / "preview.png", d / "preview.webp") if p.is_file()), None)
        files, total = [], 0
        for p in d.rglob("*"):
            if p.is_symlink() or not p.is_file() or p.name == "template.json" or p.name == preview:
                continue
            rel = p.relative_to(d).as_posix()
            if rel != ".gitignore" and (not _rel_ok(rel) or p.suffix.lower() not in TEMPLATE_FILES) or p.stat().st_size > TEMPLATE_MAX_FILE:
                continue
            files.append(rel)
            total += p.stat().st_size
        if total > TEMPLATE_MAX_FOLDER or not files:
            continue
        items.append({"id": tid, "name": str(meta.get("name") or tid.replace("-", " ").title())[:60], "kind": kind, "entry": entry,
                      "blurb": str(meta.get("blurb") or "")[:200], "brief": str(meta.get("brief") or "")[:2000],
                      "author": str(meta.get("author") or "")[:80], "authorUrl": _url(meta.get("authorUrl")),
                      "license": str(meta.get("license") or "")[:40], "version": str(meta.get("version") or "1.0")[:20],
                      "tags": [str(t)[:24] for t in (meta.get("tags") or [])[:8] if isinstance(t, str)],
                      "path": f"templates/{tid}", "preview": f"templates/{tid}/{preview}" if preview else None, "files": sorted(files)})
    return items


def clean_agent(spec: dict) -> tuple[dict, list[str], str]:
    """An agent.json from the internet → the persona fields the Agent Lab stores, notes on what was changed, and the
    model it asks for ("default" or a tag).
    Raises ValueError when it isn't an agent at all. Anything outside the format (an id, adult, skills…) is dropped."""
    from tools import TOOLS
    if not isinstance(spec, dict):
        raise ValueError("not an agent file")
    notes = []
    s = lambda k, n: str(spec.get(k) or "").strip()[:n]
    name, title, prompt = s("name", 32), s("title", 40), str(spec.get("systemPrompt") or "").strip()
    if not name or len(prompt) < 80:
        raise ValueError("an agent needs a name and a system prompt of at least 80 characters")
    if len(prompt) > 12000:
        prompt = prompt[:12000]
        notes.append("The system prompt was cut to 12,000 characters.")
    color = spec.get("color")
    if not (isinstance(color, list) and len(color) == 2 and all(isinstance(c, str) and HEX_RE.match(c) for c in color)):
        color = ["#475569", "#1e293b"]
    try:
        temperature = min(2.0, max(0.0, float(spec.get("temperature", 0.6))))
    except (TypeError, ValueError):
        temperature = 0.6
    effort = spec.get("effort") if spec.get("effort") in EFFORTS else "medium"
    wanted = [t for t in (spec.get("tools") or []) if isinstance(t, str)][:40]
    usable = {tid for tid, t in TOOLS.items() if not t.get("hidden") and t.get("scope", "agent") == "agent"}
    tools = list(dict.fromkeys(t for t in wanted if t in usable))
    missing = [t for t in wanted if t not in usable]
    if missing:
        notes.append(f"Left out tools this Shell:B doesn't have: {', '.join(missing[:8])}.")
    model = s("model", 100) or "default"
    agent = {"name": name, "title": title or "Specialist", "avatar": s("avatar", 8) or "◆", "color": color,
             "description": s("description", 200), "systemPrompt": prompt, "temperature": round(temperature, 2),
             "effort": effort, "tools": tools, "builtin": False}
    return agent, notes, (model if model == "default" or MODEL_RE.match(model) else "default")


def _agent_items(root: Path) -> list[dict]:
    items = []
    for f in sorted(root.glob("agents/*/agent.json")):
        aid = f.parent.name
        if not ID_RE.match(aid):
            continue
        try:
            spec = json.loads(f.read_text())
            agent, _, model = clean_agent(spec)
        except (OSError, ValueError):
            continue
        items.append({"id": aid, "name": agent["name"], "title": agent["title"], "avatar": agent["avatar"], "color": agent["color"],
                      "blurb": agent["description"], "author": str(spec.get("author") or "")[:80], "authorUrl": _url(spec.get("homepage")),
                      "license": str(spec.get("license") or "")[:40], "version": str(spec.get("version") or "1.0")[:20],
                      "tags": [str(t)[:24] for t in (spec.get("tags") or [])[:8] if isinstance(t, str)],
                      "needs": [n for n in (spec.get("needs") or []) if n in NEEDS], "model": model, "effort": agent["effort"],
                      "tools": agent["tools"], "path": f"agents/{aid}/agent.json"})
    return items


async def refresh_source(src: dict) -> dict:
    """Fetch the source at its current commit and rebuild its part of the catalogue."""
    repo = await community.resolve_repo(src["repo"])
    sha = await community._ls_remote(repo, src.get("ref") or "main")
    root = await community.fetch_repo(repo, sha)
    items = {"theme": _theme_items, "screensaver": _saver_items, "template": _template_items, "agent": _agent_items}[src["kind"]](root)
    entry = {"repo": repo, "ref": src.get("ref") or "main", "sha": sha, "fetched": time.time(), "items": items}
    cache = db.kv_get(f"gallery_{src['kind']}") or {}
    if not isinstance(cache, dict):
        cache = {}
    cache[src["id"]] = entry
    db.kv_set(f"gallery_{src['kind']}", cache)
    return entry


def _cached(kind: str) -> dict:
    v = db.kv_get(f"gallery_{kind}") or {}
    return v if isinstance(v, dict) else {}


def installed() -> dict:
    v = db.kv_get(INSTALLED_KEY) or {}
    return v if isinstance(v, dict) else {}


def _remember(kind: str, source: str, item: str, target: str, sha: str, version: str):
    cur = installed()
    cur[f"{kind}:{source}:{item}"] = {"target": target, "sha": sha, "version": version, "at": time.time()}
    db.kv_set(INSTALLED_KEY, cur)


async def listing(kind: str, refresh: bool = False) -> dict:
    """Every source of this kind with its items; stale sources are refreshed (errors keep the cache and are reported)."""
    if kind not in KINDS:
        raise KeyError(kind)
    out, errors, cache = [], [], _cached(kind)
    for src in (s for s in sources() if s["kind"] == kind):
        entry = cache.get(src["id"])
        if refresh or not entry or time.time() - float(entry.get("fetched") or 0) > REFRESH_AFTER:
            lock = _locks.setdefault(f"{kind}:{src['id']}", asyncio.Lock())
            async with lock:
                try:
                    entry = await refresh_source(src)
                except (ValueError, OSError, httpx.HTTPError, asyncio.TimeoutError) as e:
                    errors.append(f"{src['repo']}: {str(e)[:160]}")
                    entry = _cached(kind).get(src["id"])
        if entry:
            out.append({"source": src["id"], "repo": entry["repo"], "sha": entry["sha"], "fetched": entry["fetched"],
                        "url": f"https://github.com/{entry['repo']}", "items": entry["items"]})
    # what's already installed, keyed the same way the UI keys its tiles
    done = installed()
    for s in out:
        for it in s["items"]:
            rec = done.get(f"{kind}:{s['source']}:{it['id']}")
            if rec:
                it["installed"] = rec["target"]
                it["installedVersion"] = rec.get("version")
                # a theme the owner deleted, or a project that's gone, isn't installed any more
                if kind == "theme" and not any(t.get("id") == rec["target"] for t in themes.all_themes()):
                    it["installed"] = None
                if kind == "screensaver" and not db.get_project(rec["target"]):
                    it["installed"] = None
                if kind == "agent":
                    from roster import get_agents
                    if not any(a["id"] == rec["target"] for a in get_agents()):
                        it["installed"] = None
                if kind == "template":  # a template is a starting point: every use makes a new project, nothing to mark
                    it.pop("installed", None); it.pop("installedVersion", None)
    return {"kind": kind, "sources": out, "errors": errors}


def _find(kind: str, source: str, item_id: str) -> tuple[dict, dict]:
    entry = _cached(kind).get(source)
    if not entry:
        raise KeyError("That source hasn't been fetched yet")
    it = next((i for i in entry["items"] if i["id"] == item_id), None)
    if not it:
        raise KeyError(f"No {kind} {item_id!r} in {source}")
    return entry, it


# ── installing ────────────────────────────────────────────────────────────────

def install_theme(source: str, item_id: str) -> dict:
    entry, it = _find("theme", source, item_id)
    spec_path = community._repo_dir(entry["repo"], entry["sha"]) / it["path"]
    try:
        spec = json.loads(spec_path.read_text())
    except (OSError, ValueError):
        raise KeyError("The theme file is missing from the fetched copy; refresh the gallery")
    theme, notes = themes.clean(spec)
    prov = {"repo": entry["repo"], "path": it["path"], "sha": entry["sha"], "author": it["author"], "version": it["version"],
            "license": it["license"], "source": source, "item": item_id}
    # reinstalling replaces the earlier copy instead of adding a twin
    old = installed().get(f"theme:{source}:{item_id}")
    tid = old["target"] if old and any(t.get("id") == old["target"] for t in themes.all_themes()) else None
    saved = themes.save({**theme, "community": prov}, tid)
    _remember("theme", source, item_id, saved["id"], entry["sha"], it["version"])
    return {"kind": "theme", "theme": saved, "notes": notes}


def install_screensaver(source: str, item_id: str) -> dict:
    import projects
    entry, it = _find("screensaver", source, item_id)
    src_dir = community._repo_dir(entry["repo"], entry["sha"]) / it["path"]
    if not (src_dir / "index.html").is_file():
        raise KeyError("The screensaver's files are missing from the fetched copy; refresh the gallery")
    old = installed().get(f"screensaver:{source}:{item_id}")
    proj = db.get_project(old["target"]) if old else None
    desc = f"From the community gallery: {entry['repo']}/{it['path']} ({it['author'] or 'unknown author'}, {it['license'] or 'no license given'})"
    if proj and proj.get("kind") == "screensaver":
        pid = proj["id"]
    else:
        proj = db.create_project(it["name"], "screensaver", "index.html", desc)
        pid = proj["id"]
        projects.create_project_files(pid, it["name"], desc, "screensaver")
    base = projects.root(pid)
    total = 0
    for rel in it["files"]:
        src = src_dir / rel
        if src.is_symlink() or not src.is_file() or not _rel_ok(rel) or src.suffix.lower() not in SAVER_FILES:
            continue
        total += src.stat().st_size
        if src.stat().st_size > MAX_FILE or total > MAX_FOLDER:
            raise ValueError("The screensaver is larger than the gallery allows")
        dest = projects.safe_path(pid, rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
    (base / "DESIGN.md").write_text(f"# {it['name']}\n\n{it['blurb']}\n\n{desc}\n\nInstalled from the community gallery on "
                                    f"{time.strftime('%Y-%m-%d')} (version {it['version']}, commit {entry['sha'][:12]}).\n")
    projects.commit(pid, f"Install {it['name']} from {entry['repo']} ({entry['sha'][:12]})")
    _remember("screensaver", source, item_id, pid, entry["sha"], it["version"])
    return {"kind": "screensaver", "project": projects.project_summary(db.get_project(pid))}


def install_template(source: str, item_id: str, name: str = "") -> dict:
    """A new Studio project from a community template: its kind, a copy of its files, its brief in DESIGN.md."""
    import projects
    entry, it = _find("template", source, item_id)
    src_dir = community._repo_dir(entry["repo"], entry["sha"]) / it["path"]
    if not (src_dir / it["entry"]).is_file():
        raise KeyError("The template's files are missing from the fetched copy; refresh the gallery")
    pname = (name.strip() or it["name"])[:80]
    credit = f"{it['author'] or 'unknown author'}, {it['license'] or 'no license given'}"
    desc = it["brief"] or it["blurb"]
    proj = db.create_project(pname, it["kind"], it["entry"], desc)
    pid = proj["id"]
    projects.create_project_files(pid, pname, desc, it["kind"])
    total = 0
    for rel in it["files"]:
        src = src_dir / rel
        if src.is_symlink() or not src.is_file() or (rel != ".gitignore" and (not _rel_ok(rel) or src.suffix.lower() not in TEMPLATE_FILES)):
            continue
        total += src.stat().st_size
        if src.stat().st_size > TEMPLATE_MAX_FILE or total > TEMPLATE_MAX_FOLDER:
            raise ValueError("The template is larger than the gallery allows")
        dest = projects.safe_path(pid, rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
    base = projects.root(pid)
    design = base / "DESIGN.md"
    if design.is_file() and "DESIGN.md" not in it["files"]:
        design.write_text(f"# {pname}\n\n## Brief\n{desc}\n\n## Decisions log\n- Started from the community template "
                          f"\"{it['name']}\" ({entry['repo']}/{it['path']}, version {it['version']}, by {credit}).\n")
    projects.commit(pid, f"Start from template {it['name']} ({entry['repo']} {entry['sha'][:12]})")
    _remember("template", source, item_id, pid, entry["sha"], it["version"])
    return {"kind": "template", "project": projects.project_summary(db.get_project(pid))}


def install_agent(source: str, item_id: str, local_models: set[str] | None = None) -> dict:
    """The community agent joins the roster (a second install updates the same agent). `local_models` are the Ollama
    tags installed here: a named local model is used only when it is one of them, otherwise the default agent's model."""
    from roster import get_agents, get_settings
    entry, it = _find("agent", source, item_id)
    try:
        spec = json.loads((community._repo_dir(entry["repo"], entry["sha"]) / it["path"]).read_text())
    except (OSError, ValueError):
        raise KeyError("The agent file is missing from the fetched copy; refresh the store")
    agent, notes, wanted = clean_agent(spec)
    agents = get_agents()
    default = next((a for a in agents if a["id"] == get_settings().get("defaultAgent")), None) or next(iter(agents), {})
    base = default.get("model") or "ShellB-Swift"
    names = local_models or set()
    if wanted != "default" and (wanted in names or f"{wanted}:latest" in names):
        model = wanted
    else:
        model = base
        if wanted != "default":
            notes.append(f"{wanted} isn't installed here, so it uses {model}; change it in the Agent Lab.")
    old = installed().get(f"agent:{source}:{item_id}")
    ids = {a["id"] for a in agents}
    if old and old["target"] in ids:
        aid = old["target"]
    else:
        aid = item_id if item_id not in ids else next(f"{item_id}-{n}" for n in range(2, 100) if f"{item_id}-{n}" not in ids)
    prov = {"repo": entry["repo"], "path": it["path"], "sha": entry["sha"], "author": it["author"], "version": it["version"],
            "license": it["license"], "source": source, "item": item_id}
    saved = {**agent, "id": aid, "model": model, "community": prov}
    idx = next((i for i, a in enumerate(agents) if a["id"] == aid), None)
    if idx is None:
        agents.append(saved)
    else:  # an update keeps what the owner tuned that the file doesn't set: context size, skills, model choice
        keep = {k: agents[idx][k] for k in ("numCtx", "skills", "model") if k in agents[idx]}
        agents[idx] = {**saved, **keep}
        saved = agents[idx]
    db.kv_set("agents", agents)
    _remember("agent", source, item_id, aid, entry["sha"], it["version"])
    return {"kind": "agent", "agent": saved, "notes": notes}


# ── routes ────────────────────────────────────────────────────────────────────

@router.get("/sources")
def api_sources():
    return sources()


@router.post("/sources")
async def api_add_source(req: Request):
    auth.require_admin(req)
    b = await req.json()
    try:
        src = add_source(str(b.get("kind") or ""), str(b.get("repo") or ""), str(b.get("ref") or "main"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    db.audit_log("gallery:source", src)
    return src


@router.delete("/sources/{sid}")
def api_remove_source(sid: str, req: Request):
    auth.require_admin(req)
    try:
        remove_source(sid)
    except KeyError:
        raise HTTPException(404, "No such source")
    return {"ok": True}


@router.get("/{kind}")
async def api_list(kind: str, refresh: int = 0):
    try:
        return await listing(kind, refresh=bool(refresh))
    except KeyError:
        raise HTTPException(404, "kind is theme, screensaver, template or agent")


@router.get("/{kind}/{source}/{item_id}/preview")
def api_preview(kind: str, source: str, item_id: str):
    """The item's preview image out of the fetched repository (screensavers, templates; themes draw their own from the palette)."""
    try:
        entry, it = _find(kind, source, item_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    rel = it.get("preview")
    if not rel or not _rel_ok(rel) or Path(rel).suffix.lower() not in PREVIEWS:
        raise HTTPException(404, "No preview")
    p = community._repo_dir(entry["repo"], entry["sha"]) / rel
    if not p.is_file():
        raise HTTPException(404, "No preview")
    return FileResponse(p, media_type=PREVIEWS[p.suffix.lower()], headers={"Cache-Control": "private, max-age=86400"})


@router.post("/install")
async def api_install(req: Request):
    auth.require_admin(req)
    b = await req.json()
    kind, source, item_id = str(b.get("kind") or ""), str(b.get("source") or ""), str(b.get("id") or "")
    if kind not in KINDS or not ID_RE.match(item_id) or not re.fullmatch(r"[a-z0-9-]{1,80}", source):
        raise HTTPException(400, "kind, source and id are required")
    try:
        if kind == "template":
            res = await asyncio.to_thread(install_template, source, item_id, str(b.get("name") or ""))
        elif kind == "agent":
            res = await asyncio.to_thread(install_agent, source, item_id, await _local_models())
        else:
            res = await asyncio.to_thread(install_theme if kind == "theme" else install_screensaver, source, item_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    db.audit_log("gallery:install", {"kind": kind, "source": source, "id": item_id,
                                     "as": res.get("theme", {}).get("id") or res.get("project", {}).get("id") or res.get("agent", {}).get("id")})
    if kind in ("screensaver", "template"):
        import projects
        projects.cover_later(res["project"]["id"])  # needs the event loop, so here and not in the worker thread
    return res


async def _local_models() -> set[str]:
    """The Ollama tags installed here; empty when Ollama doesn't answer (the agent then uses the default model)."""
    from tools import OLLAMA
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            return {m["name"] for m in (await c.get(f"{OLLAMA}/api/tags")).json().get("models", [])}
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        return set()


def _owner_display() -> str:
    """The owner's display name from their Circles profile, for the author line of an exported theme (blank if unset)."""
    try:
        import circles
        name = str(circles.profile(circles.OWNER).get("display") or "").strip()
        return "" if name in ("Owner", "The user") else name[:80]
    except Exception:  # noqa: BLE001 — in a cell, or before Circles ran
        return ""


@router.get("/export/theme/{tid}")
def api_export_theme(tid: str):
    """A custom theme as a theme.json ready for a pull request to the themes repository."""
    t = next((t for t in themes.all_themes() if t.get("id") == tid), None)
    if not t:
        raise HTTPException(404, "No such theme")
    out = {k: t[k] for k in ("name", "blurb", "mode") if k in t}
    out.update({"author": _owner_display(), "authorUrl": "", "license": "MIT", "version": "1.0", "tags": []})
    pal = dict(t.get("palette") or {})
    inks = pal.pop("inks", None)
    for k in ("accentText", "accentSoft"):
        pal.pop(k, None)
    out["palette"] = pal
    if inks:
        out["inks"] = inks
    for k in ("fonts", "caps", "tracking", "shape", "backdrop", "particles"):
        if k in t:
            out[k] = t[k]
    name = re.sub(r"[^a-z0-9]+", "-", str(t.get("name") or "theme").lower()).strip("-") or "theme"
    from fastapi.responses import Response
    return Response(json.dumps(out, indent=2, ensure_ascii=False) + "\n", media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{name}.theme.json"'})
