"""Community Hub: find MCP servers and Agent Skills other people published, and install them for review.

Sources (kv `community_sources`; the owner can add more):
  registry     the official MCP Registry (registry.modelcontextprotocol.io/v0/servers), searched live
  github       a repository of skill folders (each with a SKILL.md), e.g. anthropics/skills
  marketplace  a Claude plugin marketplace (.claude-plugin/marketplace.json); a plugin's skills are listed when it's opened

Repositories are fetched as one tarball at a pinned commit (git ls-remote, then codeload.github.com) through the same
public-internet-only guard as web_fetch, unpacked with tarfile's "data" filter, and cached in data/community/repos.
Their SKILL.md files go into the `community_items` table, so browsing works offline once a source has been fetched.

Installing needs admin and is never silent:
  - a skill is copied into data/skills (provenance: source, repo, commit, path) and starts switched OFF
  - an MCP server becomes a `community` server in mcp_hub, switched OFF until the owner reviews it and fills in its
    secrets. Package servers (npm, PyPI, OCI) run in a throwaway Docker container (no capabilities, 1 GB, on their own
    network) instead of on this machine; remote servers are plain HTTP/SSE connections.
Agents get `find_capability` to search these sources; `propose` puts an install in front of the owner as an approval
card (agent.py), and nothing is installed without it.
"""
import asyncio
import hashlib
import json
import re
import shutil
import subprocess
import tarfile
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request

import auth
import db
import skills
from tools import GUARD_HOOKS, TOOLS, UA, ToolResult, _fn

router = APIRouter(prefix="/api/community")
ROOT = db.DATA / "community"
REPOS = ROOT / "repos"
REG_CACHE = ROOT / "registry"
REGISTRY = "https://registry.modelcontextprotocol.io"
MAX_TARBALL = 200 * 1024 * 1024
MCP_NETWORK, MCP_SUBNET = "shellb-mcp", "192.168.250.0/24"  # outside ufw's Docker allowance: can't reach host ports
NODE_IMAGE, UV_IMAGE = "node:22-slim", "ghcr.io/astral-sh/uv:python3.12-bookworm-slim"
GH = re.compile(r"^(?:https?://github\.com/)?([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$")

DEFAULT_SOURCES = [
    {"id": "mcp-registry", "kind": "registry", "name": "Official MCP Registry", "url": REGISTRY},
    {"id": "anthropic-skills", "kind": "github", "name": "Anthropic skills", "repo": "anthropics/skills", "ref": "HEAD",
     "subdir": "skills"},
    {"id": "claude-plugins", "kind": "marketplace", "name": "Claude plugins (official marketplace)",
     "repo": "anthropics/claude-plugins-official", "ref": "HEAD"},
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS community_items(
  id TEXT PRIMARY KEY, source_id TEXT, kind TEXT, name TEXT, description TEXT, license TEXT, path TEXT,
  repo TEXT, sha TEXT, fetched REAL, meta TEXT);
CREATE INDEX IF NOT EXISTS community_items_source ON community_items(source_id, kind);
"""
_locks: dict[str, asyncio.Lock] = {}
COLS = ["id", "source_id", "kind", "name", "description", "license", "path", "repo", "sha", "fetched", "meta"]


def init():
    ROOT.mkdir(exist_ok=True)
    REPOS.mkdir(exist_ok=True)
    REG_CACHE.mkdir(exist_ok=True)
    with db.conn() as c:
        c.executescript(SCHEMA)


# ── sources ─────────────────────────────────────────────────────────────────

def sources() -> list[dict]:
    stored = db.kv_get("community_sources")
    return stored if stored is not None else [dict(s) for s in DEFAULT_SOURCES]


def _source(sid: str) -> dict:
    s = next((s for s in sources() if s["id"] == sid), None)
    if not s:
        raise KeyError(sid)
    return s


def add_source(spec: str, name: str = "") -> dict:
    """`owner/repo`, `owner/repo@ref`, `owner/repo/sub/dir` or a github.com URL. A repo with a
    .claude-plugin/marketplace.json is treated as a marketplace when it's first refreshed."""
    spec = spec.strip()
    ref = "HEAD"
    if "@" in spec:
        spec, ref = spec.rsplit("@", 1)
    parts = spec.removeprefix("https://github.com/").strip("/").split("/")
    if len(parts) < 2 or not GH.match("/".join(parts[:2])):
        raise ValueError("Give a GitHub repository: owner/repo, owner/repo@branch or owner/repo/folder")
    repo, subdir = "/".join(parts[:2]).removesuffix(".git"), "/".join(parts[2:])
    sid = re.sub(r"[^a-z0-9]+", "-", f"{repo}-{subdir}".lower()).strip("-")[:60]
    cur = sources()
    if any(s["id"] == sid for s in cur):
        raise ValueError("That source is already listed")
    src = {"id": sid, "kind": "github", "name": name.strip() or repo + (f"/{subdir}" if subdir else ""), "repo": repo,
           "ref": ref or "HEAD", "subdir": subdir, "custom": True}
    db.kv_set("community_sources", cur + [src])
    return src


def remove_source(sid: str):
    db.kv_set("community_sources", [s for s in sources() if s["id"] != sid])
    with db.conn() as c:
        c.execute("DELETE FROM community_items WHERE source_id=?", (sid,))


# ── fetching repositories ───────────────────────────────────────────────────

async def _ls_remote(repo: str, ref: str) -> str:
    if re.fullmatch(r"[0-9a-f]{40}", ref or ""):
        return ref
    def run():
        r = subprocess.run(["git", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "ls-remote",
                            f"https://github.com/{repo}.git", ref or "HEAD"], capture_output=True, text=True, timeout=30)
        if r.returncode != 0 or not r.stdout.strip():
            raise ValueError(f"Couldn't reach github.com/{repo} ({(r.stderr or 'no such ref').strip()[:200]})")
        lines = r.stdout.split("\n")
        exact = [l for l in lines if l.endswith(f"refs/heads/{ref}") or l.endswith(f"refs/tags/{ref}^{{}}")]
        return (exact or lines)[0].split()[0]
    return await asyncio.to_thread(run)


def _repo_dir(repo: str, sha: str) -> Path:
    return REPOS / repo.replace("/", "__") / sha


async def fetch_repo(repo: str, sha: str) -> Path:
    """The repository's files at `sha`, downloaded once (tarball), kept for the two most recent commits."""
    dest = _repo_dir(repo, sha)
    if (dest / ".complete").exists():
        return dest
    lock = _locks.setdefault(f"{repo}@{sha}", asyncio.Lock())
    async with lock:
        if (dest / ".complete").exists():
            return dest
        tmp = dest.with_name(dest.name + ".part")
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        tgz = tmp / "repo.tgz"
        size = 0
        async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=20), follow_redirects=True,
                                     headers={"User-Agent": UA}, event_hooks=GUARD_HOOKS) as c:
            async with c.stream("GET", f"https://codeload.github.com/{repo}/tar.gz/{sha}") as r:
                r.raise_for_status()
                with tgz.open("wb") as f:
                    async for part in r.aiter_bytes():
                        size += len(part)
                        if size > MAX_TARBALL:
                            raise ValueError(f"{repo} is larger than {MAX_TARBALL // 2**20} MB; too big to browse here")
                        f.write(part)

        def unpack():
            out = tmp / "files"
            with tarfile.open(tgz) as t:
                members = [m for m in t.getmembers() if m.isfile() or m.isdir()]  # no links, devices or fifos
                if sum(m.size for m in members) > 4 * MAX_TARBALL:
                    raise ValueError(f"{repo} unpacks to too much data")
                for m in members:  # strip GitHub's "<repo>-<sha>/" top folder
                    m.name = m.name.split("/", 1)[1] if "/" in m.name else ""
                t.extractall(out, members=[m for m in members if m.name], filter="data")
            tgz.unlink()
            return out
        files = await asyncio.to_thread(unpack)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(dest, ignore_errors=True)
        files.rename(dest)
        shutil.rmtree(tmp, ignore_errors=True)
        (dest / ".complete").write_text(str(time.time()))
        for old in sorted((p for p in dest.parent.iterdir() if p.is_dir() and p != dest),
                          key=lambda p: p.stat().st_mtime)[:-1]:
            shutil.rmtree(old, ignore_errors=True)
    return dest


def _skill_items(source_id: str, repo: str, sha: str, root: Path, base: str = "", plugin: str = "") -> list[tuple]:
    out = []
    start = root / base if base else root
    if not start.is_dir():
        return out
    for md in sorted(start.rglob("SKILL.md")):
        rel = str(md.parent.relative_to(root))
        if any(part.startswith(".") and part not in (".claude",) or part in skills.SKIP_DIRS for part in Path(rel).parts):
            continue
        try:
            meta, body = skills.parse(md.read_text(errors="replace"))
        except OSError:
            continue
        name = skills.slug(str(meta.get("name") or md.parent.name))
        lic = str(meta.get("license") or "")
        out.append((f"skill:{source_id}:{rel}", source_id, "skill", name, str(meta.get("description") or "")[:600], lic,
                    rel, repo, sha, time.time(), json.dumps({"plugin": plugin, "words": len(body.split())})))
    return out


def _gh_source(src) -> tuple[str, str, str] | None:
    """(repo, ref, path) of a marketplace plugin entry's source, if it lives on github.com."""
    s = src
    if isinstance(s, str):
        return None
    url = s.get("url") or (f"https://github.com/{s['repo']}" if s.get("repo") else "")
    m = GH.match(url.removesuffix("/"))
    if not m:
        return None
    return f"{m.group(1)}/{m.group(2)}", s.get("sha") or s.get("ref") or "HEAD", s.get("path") or ""


async def refresh(source_id: str) -> dict:
    """Fetch a source again and rebuild its index. Returns {"items": n, "sha": ...}."""
    src = _source(source_id)
    if src["kind"] == "registry":
        return {"items": 0, "note": "the registry is searched live"}
    sha = await _ls_remote(src["repo"], src.get("ref") or "HEAD")
    root = await fetch_repo(src["repo"], sha)
    rows = []
    market = root / ".claude-plugin" / "marketplace.json"
    if src["kind"] == "marketplace" or market.is_file():
        if src["kind"] != "marketplace":
            src["kind"] = "marketplace"
            db.kv_set("community_sources", [src if s["id"] == source_id else s for s in sources()])
        data = json.loads(market.read_text())
        for p in data.get("plugins", []):
            name = str(p.get("name") or "")
            if not name:
                continue
            ps = p.get("source")
            meta = {"source": ps, "author": (p.get("author") or {}).get("name", ""), "category": p.get("category", ""),
                    "homepage": p.get("homepage", "")}
            if isinstance(ps, str):  # the plugin lives in this repo: list its skills now
                base = ps.removeprefix("./").strip("/")
                rows += _skill_items(source_id, src["repo"], sha, root, base, plugin=name)
                meta["local"] = base
            rows.append((f"plugin:{source_id}:{name}", source_id, "plugin", name, str(p.get("description") or "")[:600],
                         "", "", src["repo"], sha, time.time(), json.dumps(meta)))
    else:
        rows = _skill_items(source_id, src["repo"], sha, root, src.get("subdir") or "")
    with db.conn() as c:
        c.execute("DELETE FROM community_items WHERE source_id=?", (source_id,))
        c.executemany("INSERT OR REPLACE INTO community_items VALUES(?,?,?,?,?,?,?,?,?,?,?)", rows)
    return {"items": len(rows), "sha": sha}


# ── the MCP registry ────────────────────────────────────────────────────────

def _reg_item(entry: dict) -> dict | None:
    s = entry.get("server") or {}
    off = (entry.get("_meta") or {}).get("io.modelcontextprotocol.registry/official") or {}
    if off.get("status", "active") != "active" or off.get("isLatest") is False or not s.get("name"):
        return None
    repo = (s.get("repository") or {}).get("url", "")
    return {"id": f"mcp:{s['name']}@{s.get('version', '')}", "kind": "mcp", "name": s["name"],
            "title": s.get("title") or s["name"].split("/")[-1], "description": (s.get("description") or "")[:600],
            "source": "mcp-registry", "repo": repo, "version": s.get("version", ""),
            "publisher": s["name"].split("/")[0], "server": s}


async def registry_search(q: str, cursor: str = "", limit: int = 30) -> dict:
    params = {"limit": str(limit)} | ({"search": q} if q else {}) | ({"cursor": cursor} if cursor else {})
    key = hashlib.sha1(json.dumps(params, sort_keys=True).encode()).hexdigest()
    cache = REG_CACHE / f"{key}.json"
    stale = False
    try:
        async with httpx.AsyncClient(timeout=15, headers={"User-Agent": UA}, event_hooks=GUARD_HOOKS) as c:
            r = await c.get(f"{REGISTRY}/v0/servers", params=params)
            r.raise_for_status()
            data = r.json()
        cache.write_text(json.dumps(data))
    except (httpx.HTTPError, ValueError):
        if not cache.is_file():
            return {"items": [], "nextCursor": None, "stale": True, "offline": True}
        data, stale = json.loads(cache.read_text()), True
    items = [i for i in (_reg_item(e) for e in data.get("servers", [])) if i]
    with db.conn() as c:  # remembered, so details and installs work from the id alone (and offline)
        c.executemany("INSERT OR REPLACE INTO community_items VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                      [(i["id"], "mcp-registry", "mcp", i["name"], i["description"], "", "", i["repo"], i["version"],
                        time.time(), json.dumps(i["server"])) for i in items])
    return {"items": items, "nextCursor": (data.get("metadata") or {}).get("nextCursor"), "stale": stale}


def _field(name, label, secret=False, required=False, hint="", default=""):
    return {"key": name, "label": label, "kind": "secret" if secret else "text", "required": bool(required),
            "hint": hint[:300], **({"default": default} if default else {})}


def install_options(server: dict) -> list[dict]:
    """The ways to run a registry server here, each with the form fields it needs and the exact command or URL."""
    out = []
    for i, rem in enumerate(server.get("remotes") or []):
        t = rem.get("type")
        if t not in ("streamable-http", "sse") or not rem.get("url"):
            continue
        fields, headers = [], {}
        for h in rem.get("headers") or []:
            val = str(h.get("value") or "")
            for var in re.findall(r"\{([A-Za-z0-9_]+)\}", val) or ([] if val else [h["name"]]):
                fields.append(_field(var, var.replace("_", " "), secret=h.get("isSecret", True), required=True,
                                     hint=h.get("description", "")))
            headers[h["name"]] = val or "{" + h["name"] + "}"
        out.append({"key": f"remote{i}", "kind": "remote", "label": f"Remote ({'SSE' if t == 'sse' else 'HTTP'}) · {rem['url']}",
                    "transport": "sse" if t == "sse" else "http", "url": rem["url"], "headers": headers, "fields": fields,
                    "preview": f"{'SSE' if t == 'sse' else 'Streamable HTTP'} {rem['url']}", "local": False})
    for i, pkg in enumerate(server.get("packages") or []):
        kind = pkg.get("registryType") or pkg.get("registry_type")
        ident, ver = pkg.get("identifier") or pkg.get("name"), pkg.get("version") or ""
        if kind not in ("npm", "pypi", "oci") or not ident or (pkg.get("transport") or {}).get("type", "stdio") != "stdio":
            continue
        fields = [_field(e["name"], e["name"], secret=e.get("isSecret", False), required=e.get("isRequired", False),
                         hint=e.get("description", ""), default=str(e.get("default") or ""))
                  for e in pkg.get("environmentVariables") or [] if e.get("name")]
        args = [str(a.get("value") or a.get("default")) for a in pkg.get("packageArguments") or []
                if a.get("type", "positional") == "positional" and (a.get("value") or a.get("default"))]
        spec = {"key": f"{kind}{i}", "kind": kind, "identifier": ident, "version": ver, "args": args, "fields": fields,
                "label": f"{ {'npm': 'npm', 'pypi': 'PyPI', 'oci': 'Container'}[kind]} · {ident}{('@' + ver) if ver else ''}",
                "local": True}
        spec["preview"] = " ".join(_docker_cmd("<id>", spec)[1:])
        out.append(spec)
    return out


def _docker_cmd(sid: str, opt: dict) -> list[str]:
    base = [shutil.which("docker") or "docker", "run", "--rm", "-i", "--init", "--name", f"shellb-mcp-{sid}",
            "--cap-drop", "ALL", "--memory", "1g", "--pids-limit", "256", "--network", MCP_NETWORK]
    env = [x for f in opt.get("fields") or [] for x in ("-e", f["key"])]  # values come from the environment, not argv
    ident, ver = opt["identifier"], opt.get("version") or ""
    if opt["kind"] == "npm":
        return base + env + ["-v", "shellb-mcp-npm:/root/.npm", NODE_IMAGE, "npx", "-y", f"{ident}@{ver}" if ver else ident,
                             *opt.get("args", [])]
    if opt["kind"] == "pypi":
        return base + env + ["-v", "shellb-mcp-uv:/root/.cache/uv", UV_IMAGE, "uvx", f"{ident}=={ver}" if ver else ident,
                             *opt.get("args", [])]
    image = ident if ":" in ident.rsplit("/", 1)[-1] or not ver else f"{ident}:{ver}"
    return base + env + [image, *opt.get("args", [])]


def build(spec: dict, values: dict) -> dict:
    """mcp_hub.build_config for connector "community": the transport part of the server config."""
    opt = spec.get("option") or {}
    if opt.get("kind") == "remote":
        headers = {}
        for k, v in (opt.get("headers") or {}).items():
            filled = re.sub(r"\{([A-Za-z0-9_]+)\}", lambda m: str(values.get(m.group(1), "")), v)
            if filled.strip() and filled.strip() != "Bearer":
                headers[k] = filled
        return {"transport": opt.get("transport", "http"), "url": opt["url"], "headers": headers}
    if opt.get("kind") in ("npm", "pypi", "oci"):
        cmd = _docker_cmd(spec.get("sid") or "x", opt)
        env = {f["key"]: str(values.get(f["key"]) or f.get("default") or "") for f in opt.get("fields") or []}
        return {"transport": "stdio", "command": cmd[0], "args": cmd[1:], "env": {k: v for k, v in env.items() if v}}
    raise ValueError("This community server has no install option Shell:B can run")


async def _ensure_network():
    proc = await asyncio.create_subprocess_exec("docker", "network", "inspect", MCP_NETWORK,
                                                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    if await proc.wait() != 0:
        proc = await asyncio.create_subprocess_exec("docker", "network", "create", "--subnet", MCP_SUBNET, MCP_NETWORK,
                                                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise ValueError(f"Couldn't create the {MCP_NETWORK} Docker network: {err.decode()[:200]}")


async def _pull(image: str):
    proc = await asyncio.create_subprocess_exec("docker", "pull", "-q", image, stdout=asyncio.subprocess.DEVNULL,
                                                stderr=asyncio.subprocess.PIPE)
    try:
        _, err = await asyncio.wait_for(proc.communicate(), 600)
    except asyncio.TimeoutError:
        proc.kill()
        raise ValueError(f"Pulling {image} took over 10 minutes")
    if proc.returncode != 0:
        raise ValueError(f"Couldn't pull {image}: {err.decode()[:300]}")


# ── search, details, install ────────────────────────────────────────────────

def _installed() -> dict:
    """item id -> what it became (skill name or MCP server id)."""
    out = {}
    for name, o in (db.kv_get("skill_origins", {}) or {}).items():
        if o.get("itemId") and (skills.SKILLS / name / "SKILL.md").is_file():
            out[o["itemId"]] = {"kind": "skill", "name": name, "sha": o.get("sha", "")}
    import mcp_hub
    for cfg in mcp_hub.configs():
        com = cfg.get("community") or {}
        if com.get("itemId"):
            out[com["itemId"]] = {"kind": "mcp", "name": cfg["id"], "version": com.get("version", ""),
                                  "enabled": bool(cfg.get("enabled"))}
    return out


def _row(r) -> dict:
    meta = json.loads(r["meta"] or "{}")
    return {"id": r["id"], "kind": r["kind"], "name": r["name"], "title": r["name"], "description": r["description"],
            "license": r["license"], "path": r["path"], "repo": r["repo"], "sha": r["sha"], "source": r["source_id"],
            "fetched": r["fetched"] * 1000, "plugin": meta.get("plugin", ""), "author": meta.get("author", ""),
            "publisher": "Anthropic" if (r["repo"] or "").startswith("anthropics/") else meta.get("author", "")}


async def search(q: str = "", kind: str = "all", source: str = "", cursor: str = "") -> dict:
    q = q.strip()
    out, next_cursor, stale = [], None, False
    if kind in ("all", "mcp") and source in ("", "mcp-registry"):
        reg = await registry_search(q, cursor)
        out += [{k: v for k, v in i.items() if k != "server"} for i in reg["items"]]
        next_cursor, stale = reg["nextCursor"], reg["stale"]
    if kind in ("all", "skill", "plugin") and not cursor:
        kinds = ("skill", "plugin") if kind == "all" else (kind,)
        where, args = [f"kind IN ({','.join('?' * len(kinds))})"], list(kinds)
        if source:
            where.append("source_id=?")
            args.append(source)
        if q:
            where.append("(name LIKE ? OR description LIKE ?)")
            args += [f"%{q}%", f"%{q}%"]
        with db.conn() as c:
            rows = c.execute(f"SELECT * FROM community_items WHERE {' AND '.join(where)} ORDER BY kind DESC, name LIMIT 200",
                             args).fetchall()
        out += [_row(r) for r in rows]
    inst = _installed()
    for i in out:
        i["installed"] = inst.get(i["id"])
    return {"items": out, "nextCursor": next_cursor, "stale": stale}


def _get_row(item_id: str):
    with db.conn() as c:
        r = c.execute("SELECT * FROM community_items WHERE id=?", (item_id,)).fetchone()
    if not r:
        raise KeyError(item_id)
    return r


async def details(item_id: str) -> dict:
    r = _get_row(item_id)
    if r["kind"] == "mcp":
        server = json.loads(r["meta"])
        return {"id": item_id, "kind": "mcp", "name": r["name"], "description": r["description"], "repo": r["repo"],
                "version": r["sha"], "options": install_options(server), "installed": _installed().get(item_id),
                "websiteUrl": server.get("websiteUrl", "")}
    if r["kind"] == "skill":
        root = await fetch_repo(r["repo"], r["sha"])
        d = root / r["path"]
        files = [{"path": str(p.relative_to(d)), "size": p.stat().st_size} for p in sorted(d.rglob("*")) if p.is_file()][:300]
        return {**_row(r), "content": (d / "SKILL.md").read_text(errors="replace")[:60000], "files": files,
                "scripts": [f["path"] for f in files if f["path"].endswith((".py", ".sh", ".js", ".ts", ".mjs"))],
                "url": f"https://github.com/{r['repo']}/tree/{r['sha']}/{r['path']}", "installed": _installed().get(item_id)}
    # a plugin: fetch where it lives and list the skills inside (installable one by one)
    meta = json.loads(r["meta"] or "{}")
    if meta.get("local") is not None:
        repo, sha, base = r["repo"], r["sha"], meta["local"]
    else:
        gh = _gh_source(meta.get("source"))
        if not gh:
            return {**_row(r), "skills": [], "note": "This plugin isn't hosted on GitHub; open its page to install it by hand.",
                    "url": meta.get("homepage", "")}
        repo, ref, base = gh
        sha = await _ls_remote(repo, ref)
    root = await fetch_repo(repo, sha)
    rows = _skill_items(r["source_id"], repo, sha, root, base, plugin=r["name"])
    with db.conn() as c:
        c.executemany("INSERT OR REPLACE INTO community_items VALUES(?,?,?,?,?,?,?,?,?,?,?)", rows)
    mcp = []
    mj = root / base / ".mcp.json" if base else root / ".mcp.json"
    if mj.is_file():
        try:
            mcp = list((json.loads(mj.read_text()).get("mcpServers") or {}).keys())
        except ValueError:
            pass
    inst = _installed()
    return {**_row(r), "skills": [{**_row(dict(zip(COLS, x))), "installed": inst.get(x[0])} for x in rows],
            "mcpServers": mcp, "url": f"https://github.com/{repo}/tree/{sha}/{base}"}


async def install(item_id: str, option: str = "", values: dict | None = None, name: str = "",
                  enable_skill: bool = False) -> dict:
    r = _get_row(item_id)
    if r["kind"] == "skill":
        root = await fetch_repo(r["repo"], r["sha"])
        src = root / r["path"]
        target = skills.slug(name or r["name"])
        mine = skills.origin(target)
        if (skills.SKILLS / target).exists() and mine.get("itemId") != item_id:
            raise ValueError(f"You already have a skill called {target!r}; give this one another name")
        h = hashlib.sha1((src / "SKILL.md").read_bytes()).hexdigest()
        await asyncio.to_thread(skills.install_tree, src, target, f"community:{r['source_id']}", enable_skill,
                                itemId=item_id, repo=r["repo"], sha=r["sha"], path=r["path"], hash=h)
        return {"kind": "skill", "name": target, "enabled": enable_skill}
    if r["kind"] != "mcp":
        raise ValueError("Install a plugin's skills one by one from its details")
    import mcp_hub
    server = json.loads(r["meta"])
    opts = {o["key"]: o for o in install_options(server)}
    opt = opts.get(option) or (next(iter(opts.values())) if len(opts) == 1 else None)
    if not opt:
        raise ValueError("Pick how to run it" if opts else "No install option Shell:B can run (it may need Windows or a desktop app)")
    sid = re.sub(r"[^a-z0-9]+", "_", (name or server["name"].split("/")[-1]).lower()).strip("_")[:20] or "community"
    base, n = sid, 2
    while any(c["id"] == sid for c in mcp_hub.configs()):
        sid, n = f"{base}{n}", n + 1
    if opt["kind"] in ("npm", "pypi", "oci"):
        await _ensure_network()
        await _pull({"npm": NODE_IMAGE, "pypi": UV_IMAGE}.get(opt["kind"]) or _docker_cmd(sid, opt)[-1 - len(opt.get("args", []))])
    community = {"itemId": item_id, "registryName": server["name"], "version": server.get("version", ""), "option": opt,
                 "fields": opt["fields"], "sid": sid, "installedAt": time.time() * 1000}
    vals = {f["key"]: (values or {}).get(f["key"], f.get("default", "")) for f in opt["fields"]}
    missing = [f["label"] for f in opt["fields"] if f.get("required") and not str(vals.get(f["key"]) or "").strip()]
    # it lands switched off, so a missing secret is fine now: the owner fills it in before turning it on
    cfg = mcp_hub.upsert({"id": sid, "name": name or server.get("title") or server["name"].split("/")[-1],
                          "connector": "community", "community": community, "values": vals, "enabled": False}) \
        if not missing else _save_incomplete(sid, name or server["name"].split("/")[-1], community, vals)
    return {"kind": "mcp", "name": cfg["id"], "enabled": False, "missing": missing}


def _save_incomplete(sid, name, community, vals) -> dict:
    """Store a community server whose required secrets aren't filled in yet (upsert would refuse it)."""
    import mcp_hub
    cfg = {"id": sid, "name": name, "connector": "community", "values": vals, "enabled": False, "disabledTools": [],
           "createdAt": time.time() * 1000, "community": community, "transport": "stdio", "command": "", "args": [],
           "env": {}, "incomplete": True}
    try:
        cfg.update(build(community, vals))
    except ValueError:
        pass
    mcp_hub._save(mcp_hub.configs() + [cfg])
    return cfg


async def check_updates() -> list[dict]:
    """Installed community items whose source has moved on."""
    out = []
    shas: dict[str, str] = {}
    for name, o in (db.kv_get("skill_origins", {}) or {}).items():
        if not o.get("itemId", "").startswith("skill:") or not o.get("repo"):
            continue
        src = next((s for s in sources() if s["id"] == o["itemId"].split(":")[1]), None)
        ref = (src or {}).get("ref") or "HEAD"
        try:
            sha = shas.get(o["repo"]) or await _ls_remote(o["repo"], ref)
        except ValueError:
            continue
        shas[o["repo"]] = sha
        if sha != o.get("sha"):
            md = skills.SKILLS / name / "SKILL.md"
            edited = md.is_file() and hashlib.sha1(md.read_bytes()).hexdigest() != o.get("hash")
            out.append({"kind": "skill", "name": name, "itemId": o["itemId"], "from": o.get("sha", "")[:7],
                        "to": sha[:7], "editedLocally": edited})
    return out


# ── the agent tool ──────────────────────────────────────────────────────────

async def find_capability(args, ctx) -> ToolResult:
    """search / details. `propose` is handled in agent.py, which asks the owner first."""
    action = str(args.get("action") or "search")
    try:
        if action == "search":
            res = await search(str(args.get("query") or ""), str(args.get("kind") or "all"))
            items = res["items"][:15]
            if not items:
                return ToolResult("Nothing found." + (" (Offline: showing cached results only.)" if res["stale"] else ""))
            return ToolResult("\n".join(
                f"- {i['id']} [{i['kind']}] {i.get('title') or i['name']}: {i['description'][:160]}"
                + (" (installed)" if i.get("installed") else "") for i in items)
                + ("\n(Offline: cached results.)" if res["stale"] else "")
                + "\nCommunity items are unverified. Use action=details before proposing one.")
        if action == "details":
            d = await details(str(args.get("id") or ""))
            if d["kind"] == "mcp":
                opts = "\n".join(f"  - {o['key']}: {o['label']} (needs: {', '.join(f['key'] for f in o['fields']) or 'nothing'})"
                                 for o in d["options"]) or "  (none Shell:B can run)"
                return ToolResult(f"{d['name']} {d['version']}: {d['description']}\nRepo: {d['repo']}\nOptions:\n{opts}")
            if d["kind"] == "skill":
                return ToolResult(f"Skill {d['name']} from {d['repo']}@{d['sha'][:7]} ({len(d['files'])} files"
                                  f"{', scripts: ' + ', '.join(d['scripts'][:6]) if d['scripts'] else ''})\n\n{d['content'][:6000]}")
            return ToolResult(f"Plugin {d['name']}: {d['description']}\nSkills inside:\n"
                              + ("\n".join(f"  - {s['id']}: {s['description'][:140]}" for s in d.get("skills", [])) or "  (none)"))
    except KeyError:
        return ToolResult("No such item; search first and use an id from the results.", error=True)
    except (ValueError, httpx.HTTPError) as e:
        return ToolResult(f"Couldn't do that: {e}", error=True)
    if action == "propose":
        return ToolResult("Proposals need the owner present (a live chat); say what you'd install and why instead.",
                          error=True)
    return ToolResult("action must be search, details or propose", error=True)


async def prepare_proposal(item_id: str, option: str = "") -> dict:
    """What the owner sees on the approval card."""
    d = await details(item_id)
    if d["kind"] == "skill":
        body = (f"Skill `{d['name']}` from github.com/{d['repo']} at {d['sha'][:7]} (unverified community content).\n"
                f"Files: {len(d['files'])}" + (f"; scripts (run only in the offline sandbox): {', '.join(d['scripts'][:8])}"
                                               if d["scripts"] else "") + f"\n\n{d['content'][:6000]}")
        return {"title": f"Install the skill “{d['name']}”", "detail": body}
    if d["kind"] == "mcp":
        opt = next((o for o in d["options"] if o["key"] == option), d["options"][0] if d["options"] else None)
        if not opt:
            raise ValueError("That server has no install option Shell:B can run")
        body = (f"MCP server {d['name']} {d['version']} (unverified community software)\nRepo: {d['repo']}\n"
                f"Runs as: {opt['preview']}\nNeeds: {', '.join(f['key'] for f in opt['fields']) or 'nothing'}\n\n"
                f"It will be installed switched OFF; you turn it on (and add any keys) under Tools → Servers.\n\n"
                f"{d['description']}")
        return {"title": f"Install the MCP server “{d['name'].split('/')[-1]}”", "detail": body, "option": opt["key"]}
    raise ValueError("Propose a plugin's skills one by one")


def register():
    TOOLS["find_capability"] = {
        "fn": find_capability, "service": None,
        "ui": {"displayName": "Find Capabilities", "icon": "Compass", "category": "skills",
               "description": "Search community MCP servers and skills, and propose installing one (the owner approves)."},
        "schema": _fn("find_capability",
                      "Find tools and skills other people published: MCP servers from the official MCP Registry and Agent "
                      "Skills from GitHub (Anthropic's skills, Claude plugin marketplaces). action=search (query, kind "
                      "mcp|skill|plugin|all), details (id), propose (id, option for MCP servers): asks the owner to install "
                      "it; nothing is installed without their approval, and MCP servers arrive switched off. Use it when "
                      "the owner wants a capability you don't have. Community items are unverified: read details first.",
                      {"action": {"type": "string", "enum": ["search", "details", "propose"]},
                       "query": {"type": "string"}, "kind": {"type": "string", "enum": ["all", "mcp", "skill", "plugin"]},
                       "id": {"type": "string"}, "option": {"type": "string", "description": "MCP install option key"},
                       "why": {"type": "string", "description": "propose: one sentence on why the owner wants it"}},
                      ["action"]),
    }


# ── HTTP ────────────────────────────────────────────────────────────────────

def _bad(e: Exception) -> HTTPException:
    if isinstance(e, KeyError):
        return HTTPException(404, "No such item or source")
    return HTTPException(400, str(e))


@router.get("/sources")
def api_sources():
    with db.conn() as c:
        counts = dict(c.execute("SELECT source_id, COUNT(*) FROM community_items GROUP BY source_id").fetchall())
        fetched = dict(c.execute("SELECT source_id, MAX(fetched) FROM community_items GROUP BY source_id").fetchall())
    return [{**s, "items": counts.get(s["id"], 0), "fetched": (fetched.get(s["id"]) or 0) * 1000} for s in sources()]


@router.post("/sources")
async def api_add_source(req: Request):
    auth.require_admin(req)
    body = await req.json()
    try:
        src = add_source(str(body.get("repo") or ""), str(body.get("name") or ""))
        return {**src, **(await refresh(src["id"]))}
    except (ValueError, httpx.HTTPError) as e:
        raise _bad(e)


@router.delete("/sources/{sid}")
def api_remove_source(sid: str, req: Request):
    auth.require_admin(req)
    remove_source(sid)
    return {"ok": True}


@router.post("/sources/{sid}/refresh")
async def api_refresh(sid: str):
    try:
        return await refresh(sid)
    except (KeyError, ValueError, httpx.HTTPError) as e:
        raise _bad(e)


@router.get("/search")
async def api_search(q: str = "", kind: str = "all", source: str = "", cursor: str = ""):
    # first visit: index the GitHub sources in the background-free simplest way (once each)
    for s in sources():
        if s["kind"] != "registry" and not db.kv_get(f"community_indexed:{s['id']}"):
            try:
                await refresh(s["id"])
                db.kv_set(f"community_indexed:{s['id']}", time.time())
            except (ValueError, httpx.HTTPError) as e:
                print(f"community: couldn't index {s['id']}: {e}")
    return await search(q, kind, source, cursor)


@router.get("/item")
async def api_item(id: str):
    try:
        return await details(id)
    except (KeyError, ValueError, httpx.HTTPError) as e:
        raise _bad(e)


@router.post("/install")
async def api_install(req: Request):
    auth.require_admin(req)
    body = await req.json()
    try:
        res = await install(str(body.get("id") or ""), str(body.get("option") or ""), body.get("values") or {},
                            str(body.get("name") or ""))
    except (KeyError, ValueError, httpx.HTTPError) as e:
        raise _bad(e)
    db.audit_log("community:install", {"id": body.get("id"), "as": res.get("name")})
    if res["kind"] == "mcp":
        import mcp_hub
        await mcp_hub.sync()
    return res


@router.post("/check-updates")
async def api_updates(req: Request):
    auth.require_admin(req)
    return await check_updates()
