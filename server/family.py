"""The Shell:B family: the GitHub repositories Shell:B installs community work from, listed in Settings → Community.

The official repositories (EveAeternam/Shell-B-*) are always listed and can't be removed. Anyone can run their own
collection: a repository laid out like the official one of the same kind (folder per item, index.json) that the owner
adds here with its kind. Adding a theme, screensaver or template repository also registers it as a gallery source
(server/gallery.py) and a skills repository as a Community Hub source (server/community.py), so the matching picker
starts browsing it; the kinds without an installer yet (agents, worlds, voices, apps, translations) are listed with
where they will show up and a link, and their index is still fetched and counted.

Fetching reuses community.fetch_repo (one tarball at a pinned commit, public-internet guard, size cap). Stats per
repository (commit, item count, when) live in kv `family_stats`; custom repositories in kv `family_repos`.
"""
import asyncio
import json
import re
import time

from fastapi import APIRouter, HTTPException, Request

import auth
import community
import db

router = APIRouter(prefix="/api/family")
GITHUB = "EveAeternam"
KINDS = {  # kind → how it is laid out and where it shows up in the app
    "theme": {"label": "Themes", "folder": "themes", "where": "Settings → Appearance → Community themes", "installs": True},
    "screensaver": {"label": "Screensavers", "folder": "screensavers", "where": "Settings → Appearance → Screensaver → Browse community", "installs": True},
    "template": {"label": "Studio templates", "folder": "templates", "where": "Studio → New project → Start from a template", "installs": True},
    "skill": {"label": "Skills", "folder": "skills", "where": "Tools & Connectors → Community, then Skills", "installs": True},
    "agent": {"label": "Agents", "folder": "agents", "where": "Agent Lab → New agent (one-click install planned)", "installs": False},
    "world": {"label": "Worlds", "folder": "worlds", "where": "Worlds, via a map block in chat (one-click install planned)", "installs": False},
    "voice": {"label": "Voices", "folder": "voices", "where": "Settings → Speech → Describe (one-click install planned)", "installs": False},
    "app": {"label": "Apps", "folder": "apps", "where": "Studio → New project (one-click install planned)", "installs": False},
    "translation": {"label": "Translations", "folder": "locales", "where": "A pull request to ui/src/i18n (not loaded at run time yet)", "installs": False},
}
OFFICIAL = [
    {"id": "shellb-themes", "kind": "theme", "repo": f"{GITHUB}/Shell-B-Themes", "name": "Shell:B Themes", "blurb": "Palette, fonts, backdrop and particles as data, contrast-checked on install."},
    {"id": "shellb-screensavers", "kind": "screensaver", "repo": f"{GITHUB}/Shell-B-Screensavers", "name": "Shell:B Screensavers", "blurb": "Self-contained HTML pieces that run in a sandboxed frame when you're idle."},
    {"id": "shellb-templates", "kind": "template", "repo": f"{GITHUB}/Shell-B-Studio-Templates", "name": "Shell:B Studio Templates", "blurb": "Starting points for Studio projects: a launch page, a deck, a dashboard, a full-stack starter."},
    {"id": "shellb-skills", "kind": "skill", "repo": f"{GITHUB}/Shell-B-Skills", "name": "Shell:B Skills", "blurb": "Agent skills in the Claude Agent Skills format: a SKILL.md with references."},
    {"id": "shellb-agents", "kind": "agent", "repo": f"{GITHUB}/Shell-B-Agents", "name": "Shell:B Agents", "blurb": "Agent personas for the Agent Lab: prompt, model hints, temperature, effort and tool list."},
    {"id": "shellb-worlds", "kind": "world", "repo": f"{GITHUB}/Shell-B-Worlds", "name": "Shell:B Worlds", "blurb": "Guided tours, places with cards and GeoJSON overlays for the Worlds app."},
    {"id": "shellb-voices", "kind": "voice", "repo": f"{GITHUB}/Shell-B-Voices", "name": "Shell:B Voices", "blurb": "Voice descriptions HERMES designs into expressive voices on your machine. No recordings."},
    {"id": "shellb-apps", "kind": "app", "repo": f"{GITHUB}/Shell-B-Apps", "name": "Shell:B Apps", "blurb": "Finished Studio projects that run offline in the preview: a timer, a notebook, a converter, a board."},
    {"id": "shellb-translations", "kind": "translation", "repo": f"{GITHUB}/Shell-B-Translations", "name": "Shell:B Translations", "blurb": "Interface catalogues, one file per language."},
]
REPO_RE = re.compile(r"^[\w.-]+/[\w.-]+$")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,79}$")
REFRESH_AFTER = 24 * 3600


def custom() -> list[dict]:
    v = db.kv_get("family_repos")
    if not isinstance(v, list):
        return []
    return [r for r in v if isinstance(r, dict) and r.get("kind") in KINDS and REPO_RE.match(str(r.get("repo") or "")) and ID_RE.match(str(r.get("id") or ""))]


def repos() -> list[dict]:
    """Official first, then the owner's own, each with its kind's label and where it shows up."""
    out = [{**r, "ref": "main", "official": True} for r in OFFICIAL] + [{**r, "official": False} for r in custom()]
    stats = db.kv_get("family_stats") or {}
    return [{**r, "kindLabel": KINDS[r["kind"]]["label"], "where": KINDS[r["kind"]]["where"], "installs": KINDS[r["kind"]]["installs"],
             "url": f"https://github.com/{r['repo']}", "stats": stats.get(r["id"]) if isinstance(stats, dict) else None} for r in out]


def _clean_repo(repo: str) -> str:
    repo = repo.strip().removeprefix("https://github.com/").removeprefix("http://github.com/").removesuffix(".git").strip("/")
    if not REPO_RE.match(repo) or repo.count("/") != 1:
        raise ValueError("A repository is owner/name on GitHub, or its https://github.com/owner/name address")
    return repo


def add(kind: str, repo: str, ref: str = "main", name: str = "") -> dict:
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(KINDS)}")
    repo = _clean_repo(repo)
    rid = re.sub(r"[^a-z0-9]+", "-", repo.lower()).strip("-")[:80]
    if any(o["repo"].lower() == repo.lower() for o in OFFICIAL) or any(c["id"] == rid for c in custom()):
        raise ValueError("That repository is already listed")
    ref = (ref or "main").strip()[:64]
    entry = {"id": rid, "kind": kind, "repo": repo, "ref": ref, "name": (name or repo.split("/")[1]).strip()[:60],
             "blurb": "", "added": time.time()}
    db.kv_set("family_repos", custom() + [entry])
    _register(entry)
    return entry


def _register(entry: dict):
    """Hand the repository to the picker that can install from it, when one exists."""
    try:
        if entry["kind"] in ("theme", "screensaver", "template"):
            import gallery
            if entry["kind"] in gallery.KINDS:
                gallery.add_source(entry["kind"], entry["repo"], entry["ref"])
        elif entry["kind"] == "skill":
            spec = entry["repo"] + ("" if entry["ref"] in ("main", "HEAD") else f"@{entry['ref']}")
            community.add_source(spec, entry["name"])
    except ValueError:
        pass  # already listed there


def remove(rid: str):
    cur = custom()
    entry = next((c for c in cur if c["id"] == rid), None)
    if not entry:
        raise KeyError(rid)
    db.kv_set("family_repos", [c for c in cur if c["id"] != rid])
    stats = db.kv_get("family_stats") or {}
    if isinstance(stats, dict) and rid in stats:
        del stats[rid]
        db.kv_set("family_stats", stats)
    try:
        if entry["kind"] in ("theme", "screensaver", "template"):
            import gallery
            gallery.remove_source(re.sub(r"[^a-z0-9]+", "-", entry["repo"].lower()).strip("-"))
    except (KeyError, ImportError):
        pass


async def refresh(entry: dict) -> dict:
    """Fetch the repository and count its items: index.json when it has one, else the kind's folder."""
    kind = KINDS[entry["kind"]]
    try:
        sha = await community._ls_remote(entry["repo"], entry.get("ref") or "main")
        root = await community.fetch_repo(entry["repo"], sha)
        count, names, note = 0, [], ""
        idx = root / "index.json"
        if idx.is_file():
            try:
                data = json.loads(idx.read_text())
            except ValueError:
                data = {}
            items = data.get("items") if isinstance(data, dict) else None
            if isinstance(items, list):
                count = len(items)
                names = [str(i.get("name") or i.get("id") or "")[:40] for i in items if isinstance(i, dict)][:12]
            if isinstance(data, dict) and data.get("kind") and data["kind"] != entry["kind"]:
                note = f"index.json says this repository holds {data['kind']}s, not {entry['kind']}s"
        elif (root / kind["folder"]).is_dir():
            folders = [p for p in (root / kind["folder"]).iterdir() if p.is_dir() and not p.name.startswith(".")]
            count, names = len(folders), sorted(p.name for p in folders)[:12]
        else:
            note = f"no index.json and no {kind['folder']}/ folder; is this a {kind['label'].lower()} repository?"
        stat = {"sha": sha, "fetched": time.time(), "count": count, "names": names, "error": note}
    except Exception as e:  # unreachable, private, too big: keep the last stats and say why
        old = (db.kv_get("family_stats") or {}).get(entry["id"]) or {}
        stat = {**old, "error": str(e)[:200], "tried": time.time()}
    stats = db.kv_get("family_stats") or {}
    if not isinstance(stats, dict):
        stats = {}
    stats[entry["id"]] = stat
    db.kv_set("family_stats", stats)
    return stat


async def refresh_all(force: bool = False) -> list[dict]:
    now = time.time()
    todo = [r for r in repos() if force or not r.get("stats") or now - float((r["stats"] or {}).get("fetched") or 0) > REFRESH_AFTER]
    await asyncio.gather(*(refresh(r) for r in todo))
    return repos()


# ── routes ────────────────────────────────────────────────────────────────────

@router.get("")
async def api_list(refresh: int = 0):
    if refresh:
        return {"repos": await refresh_all(force=True), "kinds": KINDS}
    return {"repos": repos(), "kinds": KINDS}


@router.post("")
async def api_add(req: Request):
    auth.require_admin(req)
    b = await req.json()
    try:
        entry = add(str(b.get("kind") or ""), str(b.get("repo") or ""), str(b.get("ref") or "main"), str(b.get("name") or ""))
    except ValueError as e:
        raise HTTPException(400, str(e))
    db.audit_log("family:add", entry)
    stat = await refresh(entry)
    return {**entry, "stats": stat}


@router.delete("/{rid}")
def api_remove(rid: str, req: Request):
    auth.require_admin(req)
    try:
        remove(rid)
    except KeyError:
        raise HTTPException(404, "No such repository, or it is an official one")
    db.audit_log("family:remove", {"id": rid})
    return {"ok": True}


@router.post("/{rid}/refresh")
async def api_refresh(rid: str):
    entry = next((r for r in repos() if r["id"] == rid), None)
    if not entry:
        raise HTTPException(404, "No such repository")
    return await refresh(entry)
