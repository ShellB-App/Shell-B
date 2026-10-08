"""Skills: reusable playbooks (a SKILL.md plus optional scripts and reference files) that agents load on demand.

Same format as Claude's Agent Skills, so skills written for Claude Code or claude.ai work here:
    data/skills/<name>/SKILL.md      YAML front matter (name, description) + Markdown instructions
    data/skills/<name>/...           scripts, templates, references — mounted read-only at /skills/<name> in the sandbox
Agents see each enabled skill's name and description in their system prompt and call use_skill to load the full text.
"""
import io
import re
import shutil
import time
import zipfile
from pathlib import Path

import yaml

import db
from tools import TOOLS, ToolResult, _fn

SKILLS = db.DATA / "skills"
SKILLS.mkdir(exist_ok=True)
CLAUDE_HOME = Path.home() / ".claude"
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
MAX_SKILL_BYTES = 60 * 1024 * 1024
MAX_FILES = 3000
SKIP_DIRS = {"node_modules", "__pycache__", ".git", ".venv", "venv"}
CATALOG_BUDGET = 14000  # characters of skill descriptions in a system prompt


# ── parsing ─────────────────────────────────────────────────────────────────

def parse(md: str) -> tuple[dict, str]:
    """(front matter, body) of a SKILL.md."""
    m = re.match(r"^﻿?---\s*\n(.*?)\n---\s*\n?(.*)$", md, re.S)
    if not m:
        return {}, md
    try:
        meta = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError:
        meta = {}
        for line in m.group(1).splitlines():  # tolerate sloppy YAML: plain key: value lines
            if ":" in line and not line.startswith(" "):
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip().strip('"\'')
    return (meta if isinstance(meta, dict) else {}), m.group(2)


def slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9-]+", "-", str(name).lower()).strip("-")[:64]
    return s or "skill"


def compose(name: str, description: str, body: str, extra: dict | None = None) -> str:
    meta = {"name": name, "description": description.strip(), **(extra or {})}
    return "---\n" + yaml.safe_dump(meta, sort_keys=False, allow_unicode=True, width=10_000).strip() + "\n---\n\n" + body.lstrip()


def _dir(name: str) -> Path:
    if not NAME_RE.match(name or ""):
        raise ValueError(f"Invalid skill name {name!r}: use lowercase letters, digits and hyphens")
    return SKILLS / name


def _safe(root: Path, rel: str) -> Path:
    p = (root / rel.lstrip("/")).resolve()
    if not p.is_relative_to(root.resolve()):
        raise ValueError(f"{rel!r} is outside the skill")
    return p


# ── library ─────────────────────────────────────────────────────────────────

def switches() -> dict:
    return db.kv_get("skill_switches", {})


def _files(d: Path) -> list[dict]:
    out = []
    for p in sorted(d.rglob("*")):
        if p.is_file() and not any(part in SKIP_DIRS for part in p.relative_to(d).parts):
            out.append({"path": str(p.relative_to(d)), "size": p.stat().st_size})
    return out


def info(d: Path, with_files=False) -> dict | None:
    md = d / "SKILL.md"
    if not md.is_file():
        return None
    meta, body = parse(md.read_text(errors="replace"))
    origin = db.kv_get("skill_origins", {}).get(d.name, {})
    out = {"name": d.name, "title": str(meta.get("name") or d.name), "description": str(meta.get("description") or "").strip(),
           "enabled": switches().get(d.name, True), "updatedAt": md.stat().st_mtime * 1000,
           "source": origin.get("source", "local"), "words": len(body.split())}
    files = _files(d)
    out["fileCount"] = len(files)
    if with_files:
        out["files"] = files
        out["content"] = md.read_text(errors="replace")
    return out


def list_skills() -> list[dict]:
    return sorted(filter(None, (info(d) for d in SKILLS.iterdir() if d.is_dir())), key=lambda s: s["name"])


def get(name: str) -> dict:
    d = _dir(name)
    s = info(d, with_files=True)
    if s is None:
        raise KeyError(name)
    return s


def _origin(name, source, **extra):
    """Where a skill came from. Community installs also keep url, ref, sha and path, for update checks."""
    o = db.kv_get("skill_origins", {})
    o[name] = {"source": source, "at": time.time(), **extra}
    db.kv_set("skill_origins", o)


def origin(name: str) -> dict:
    return db.kv_get("skill_origins", {}).get(name, {})


def install_tree(src: Path, name: str, source: str, enabled: bool = True, **extra) -> str:
    """Copy a skill folder (holding SKILL.md) into the library as `name`, replacing any skill of that name."""
    if not (src / "SKILL.md").is_file():
        raise ValueError("That folder has no SKILL.md")
    files = [p for p in src.rglob("*") if p.is_file() and not any(part in SKIP_DIRS for part in p.relative_to(src).parts)]
    if len(files) > MAX_FILES or sum(p.stat().st_size for p in files) > MAX_SKILL_BYTES:
        raise ValueError("That skill is too large (60 MB / 3000 files max)")
    d = _dir(name)
    tmp = SKILLS / f".install-{name}-{time.time_ns()}"
    try:
        shutil.copytree(src, tmp, ignore=shutil.ignore_patterns(*SKIP_DIRS), symlinks=False)
        if d.exists():
            shutil.rmtree(d)
        tmp.rename(d)
    finally:
        if tmp.exists():
            shutil.rmtree(tmp)
    _origin(name, source, **extra)
    set_enabled(name, enabled)
    return name


def save(content: str, name: str | None = None, source="local") -> dict:
    """Create or update a skill from SKILL.md text. The name comes from `name` or the front matter."""
    meta, body = parse(content)
    if not meta.get("description"):
        raise ValueError("SKILL.md needs front matter with a description, e.g.\n---\nname: my-skill\ndescription: What it does and when to use it\n---")
    target = name or slug(meta.get("name") or "")
    d = _dir(target)
    if not meta.get("name"):
        content = compose(target, str(meta["description"]), body, {k: v for k, v in meta.items() if k not in ("name", "description")})
    d.mkdir(exist_ok=True)
    (d / "SKILL.md").write_text(content)
    if not db.kv_get("skill_origins", {}).get(target):
        _origin(target, source)
    return info(d)


def delete(name: str):
    d = _dir(name)
    if d.exists():
        shutil.rmtree(d)
    sw = switches()
    sw.pop(name, None)
    db.kv_set("skill_switches", sw)


def set_enabled(name: str, on: bool):
    _dir(name)
    sw = switches()
    sw[name] = bool(on)
    db.kv_set("skill_switches", sw)


def read_file(name: str, rel: str, limit=120_000) -> str:
    p = _safe(_dir(name), rel)
    if not p.is_file():
        raise FileNotFoundError(rel)
    data = p.read_bytes()
    if b"\0" in data[:4096]:
        return f"[binary file, {len(data):,} bytes — use it from /skills/{name}/{rel} in run_code]"
    text = data.decode("utf-8", errors="replace")
    return text if len(text) <= limit else text[:limit] + f"\n…[truncated; {len(text) - limit:,} more characters]"


def put_file(name: str, rel: str, data: bytes):
    d = _dir(name)
    if not (d / "SKILL.md").exists():
        raise KeyError(name)
    p = _safe(d, rel)
    if p.name == "SKILL.md" and p.parent == d.resolve():
        save(data.decode("utf-8", errors="replace"), name)
        return
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)


def delete_file(name: str, rel: str):
    d = _dir(name)
    p = _safe(d, rel)
    if p == (d / "SKILL.md").resolve():
        raise ValueError("Delete the skill instead of its SKILL.md")
    if p.is_file():
        p.unlink()


# ── import ──────────────────────────────────────────────────────────────────

def import_upload(filename: str, data: bytes, source="upload") -> list[str]:
    """A .zip/.skill archive holding one or more skill folders, or a bare SKILL.md / .md file."""
    if not zipfile.is_zipfile(io.BytesIO(data)):
        return [save(data.decode("utf-8", errors="replace"), source=source)["name"]]
    z = zipfile.ZipFile(io.BytesIO(data))
    entries = [i for i in z.infolist() if not i.is_dir() and "__MACOSX" not in i.filename]
    if len(entries) > MAX_FILES or sum(i.file_size for i in entries) > MAX_SKILL_BYTES:
        raise ValueError("Archive is too large (60 MB / 3000 files max)")
    roots = sorted({str(Path(i.filename).parent) for i in entries if Path(i.filename).name == "SKILL.md"}, key=len)
    if not roots:
        raise ValueError("No SKILL.md in the archive")
    imported = []
    for root in roots:
        if any(root != r and root.startswith(r + "/") for r in roots):
            continue  # nested skill inside another skill: it travels with its parent
        prefix = "" if root == "." else root + "/"
        meta, _ = parse(z.read(prefix + "SKILL.md").decode("utf-8", errors="replace"))
        name = slug(meta.get("name") or (Path(root).name if root != "." else Path(filename).stem))
        d = _dir(name)
        tmp = SKILLS / f".import-{name}-{time.time_ns()}"
        tmp.mkdir()
        try:
            for i in entries:
                if not i.filename.startswith(prefix):
                    continue
                rel = i.filename[len(prefix):]
                if any(part in SKIP_DIRS or part == ".." for part in Path(rel).parts) or rel.startswith("/"):
                    continue
                out = _safe(tmp, rel)
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(z.read(i))
            if d.exists():
                shutil.rmtree(d)
            tmp.rename(d)
        finally:
            if tmp.exists():
                shutil.rmtree(tmp)
        _origin(name, source)
        imported.append(name)
    return imported


def claude_candidates() -> list[dict]:
    """Skills installed for Claude on this machine (~/.claude), newest copy of each name."""
    best: dict[str, dict] = {}
    if not CLAUDE_HOME.exists():
        return []
    have = {s["name"] for s in list_skills()}
    for md in CLAUDE_HOME.rglob("SKILL.md"):
        if any(part in SKIP_DIRS for part in md.parts):
            continue
        try:
            meta, _ = parse(md.read_text(errors="replace"))
        except OSError:
            continue
        name = slug(meta.get("name") or md.parent.name)
        mtime = md.stat().st_mtime
        if name in best and best[name]["mtime"] >= mtime:
            continue
        plugin = md.parent.parent.parent.name if md.parent.parent.name == "skills" else ""
        best[name] = {"name": name, "description": str(meta.get("description") or "").strip()[:500], "path": str(md.parent),
                      "mtime": mtime, "plugin": plugin, "imported": name in have}
    return sorted(best.values(), key=lambda c: c["name"])


def import_claude(names: list[str]) -> list[str]:
    cands = {c["name"]: c for c in claude_candidates()}
    done = []
    for n in names:
        c = cands.get(n)
        if not c:
            continue
        src = Path(c["path"])
        if not src.resolve().is_relative_to(CLAUDE_HOME.resolve()):
            continue
        d = _dir(n)
        if d.exists():
            shutil.rmtree(d)
        shutil.copytree(src, d, ignore=shutil.ignore_patterns(*SKIP_DIRS), symlinks=False)
        _origin(n, "claude")
        done.append(n)
    return done


# ── agents ──────────────────────────────────────────────────────────────────

def for_agent(agent: dict) -> list[dict]:
    """Enabled skills this agent may use. agent['skills']: missing/'all' → all, a list → those, [] → none."""
    pick = agent.get("skills", "all")
    out = [s for s in list_skills() if s["enabled"]]
    if isinstance(pick, list):
        out = [s for s in out if s["name"] in pick]
    return out


def catalog(skills: list[dict]) -> str:
    lines, used = [], 0
    for s in skills:
        desc = re.sub(r"\s+", " ", s["description"])
        line = f"- `{s['name']}`: {desc[:420] + ('…' if len(desc) > 420 else '')}"
        if used + len(line) > CATALOG_BUDGET:
            lines.append("- Also: " + ", ".join(f"`{x['name']}`" for x in skills[len(lines):]))
            break
        lines.append(line)
        used += len(line)
    return f"""## Skills
Skills are expert playbooks kept on this machine. When a request matches a skill's description, call use_skill with
its name before you start, then follow it. Skills can bundle scripts, templates and references: in run_code they are
read-only under /skills/<name>/ (copy files to /work to change them); read text files with read_skill_file.
Some skills were written for other assistants and mention tools you don't have. Use your own equivalents (run_code
for shell or Python, create_artifact for documents and pages, web_fetch for URLs) and tell the user about any step
you can't do.
{chr(10).join(lines)}"""


async def use_skill(args, ctx):
    name = slug(args.get("name", ""))
    allowed = {s["name"] for s in for_agent(ctx.agent)}
    if name not in allowed:
        return ToolResult(f"No skill named {name!r} is available. Available: {', '.join(sorted(allowed)) or 'none'}.", error=True)
    s = get(name)
    _, body = parse(s["content"])
    files = [f for f in s["files"] if f["path"] != "SKILL.md"]
    listing = "\n".join(f"  /skills/{name}/{f['path']} ({f['size']:,} B)" for f in files[:200])
    if len(files) > 200:
        listing += f"\n  …and {len(files) - 200} more"
    return ToolResult(f"# Skill: {name}\n\n{body.strip()}" + (f"\n\n---\nBundled files (read-only in run_code; text files via read_skill_file):\n{listing}" if files else ""),
                      {"skill": name})


async def read_skill_file(args, ctx):
    name = slug(args.get("name", ""))
    if name not in {s["name"] for s in for_agent(ctx.agent)}:
        return ToolResult(f"No skill named {name!r} is available.", error=True)
    try:
        return ToolResult(read_file(name, str(args.get("path", ""))), {"skill": name})
    except (FileNotFoundError, ValueError) as e:
        return ToolResult(f"Can't read that file: {e}", error=True)


async def save_skill(args, ctx):
    name = slug(args.get("name", ""))
    desc = str(args.get("description", "")).strip()
    body = str(args.get("instructions", "")).strip()
    if not desc or not body:
        return ToolResult("save_skill needs a description and instructions.", error=True)
    existed = (SKILLS / name / "SKILL.md").exists()
    s = save(compose(name, desc, body), name, source=f"agent:{ctx.agent.get('id', '?')}")
    return ToolResult(f"{'Updated' if existed else 'Created'} skill `{s['name']}`. It is available to agents from the next message.",
                      {"skill": s["name"]})


def register():
    TOOLS["use_skill"] = {
        "fn": use_skill, "service": None, "scope": "skills",
        "ui": {"displayName": "Use Skill", "icon": "Sparkles", "category": "skills",
               "description": "Loads a skill's instructions. Added automatically for agents that have skills."},
        "schema": _fn("use_skill", "Load the full instructions of a skill listed under Skills in your instructions. "
                      "Call it before starting a task that matches the skill's description.",
                      {"name": {"type": "string", "description": "The skill name, e.g. 'brand-voice'"}}, ["name"]),
    }
    TOOLS["read_skill_file"] = {
        "fn": read_skill_file, "service": None, "scope": "skills",
        "ui": {"displayName": "Read Skill File", "icon": "FileText", "category": "skills",
               "description": "Reads a reference file bundled with a skill."},
        "schema": _fn("read_skill_file", "Read a text file bundled with a skill (paths as listed by use_skill, relative to the skill).",
                      {"name": {"type": "string"}, "path": {"type": "string", "description": "e.g. reference/forms.md"}}, ["name", "path"]),
    }
    TOOLS["save_skill"] = {
        "fn": save_skill, "service": None,
        "ui": {"displayName": "Create Skills", "icon": "WandSparkles", "category": "skills",
               "description": "Lets the agent turn a workflow into a reusable skill for every agent."},
        "schema": _fn("save_skill", "Save a reusable skill (a playbook other agents can load with use_skill) when the user asks to "
                      "capture a workflow, procedure or house style. Reusing a name replaces that skill.",
                      {"name": {"type": "string", "description": "kebab-case, e.g. 'quarterly-report'"},
                       "description": {"type": "string", "description": "What it does AND when to use it: the trigger agents match on"},
                       "instructions": {"type": "string", "description": "The full Markdown playbook: steps, rules, examples"}},
                      ["name", "description", "instructions"]),
    }


def __getattr__(name):
    if name == "router":
        import skills_router
        return skills_router.router
    raise AttributeError(f"module '{__name__}' has no attribute '{name}'")

