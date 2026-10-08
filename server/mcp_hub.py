"""MCP servers and connectors: Shell:B agents use tools from any Model Context Protocol server.

Each enabled server runs in its own long-lived task that holds the MCP session open (stdio servers are child
processes; HTTP servers are remote endpoints). Their tools join the agent tool list as `mcp__<server>__<tool>`;
an agent opts in to a whole server with the tool id `mcp:<server>`.
Connectors are presets: a form whose values fill in a server config.
"""
import asyncio
import base64
import os
import re
import shutil
import time
import uuid
from contextlib import AsyncExitStack
from pathlib import Path

import db

HOME = Path.home()
MCP_DIR = HOME / "shellb" / "mcp"
TOOLS_PY = str(HOME / "shellb" / "tools-venv" / "bin" / "python")
LOGS = db.DATA / "mcp-logs"
LOGS.mkdir(exist_ok=True)
NPX = shutil.which("npx") or str(HOME / ".local" / "bin" / "npx")
PATH = f"{HOME / '.local' / 'bin'}:{os.environ.get('PATH', '/usr/bin:/bin')}"
SECRET = "__secret__"  # stands in for stored secrets in API responses

# ── connector catalog ───────────────────────────────────────────────────────
# fields: key, label, kind (text|secret|bool|path), placeholder, required, hint

CONNECTORS = [
    {"id": "folder", "name": "Folder", "icon": "FolderOpen", "category": "Local", "local": True,
     "description": "Let agents browse, search and read a folder on this machine (optionally write to it).",
     "fields": [{"key": "path", "label": "Folder", "kind": "path", "placeholder": "/home/user/Documents", "required": True},
                {"key": "readOnly", "label": "Read-only", "kind": "bool", "default": True}]},
    {"id": "sql", "name": "SQL Database", "icon": "Database", "category": "Local", "local": True,
     "description": "Read-only queries against SQLite, PostgreSQL or MySQL. Writes are blocked.",
     "fields": [{"key": "url", "label": "Database URL", "kind": "secret", "required": True,
                 "placeholder": "postgresql+psycopg://user:pass@host/db",
                 "hint": "sqlite:////abs/path.db · postgresql+psycopg://… · mysql+pymysql://…"}]},
    {"id": "n8n", "name": "n8n Workflows", "icon": "Workflow", "category": "Local", "local": True,
     "description": "Call the n8n workflows on this machine (:5678) through an MCP Server Trigger node.",
     "fields": [{"key": "url", "label": "MCP URL", "kind": "text", "required": True,
                 "placeholder": "http://localhost:5678/mcp/<path>", "hint": "Copy the Production URL from the MCP Server Trigger node"},
                {"key": "token", "label": "Bearer token", "kind": "secret", "hint": "Only if the trigger uses Bearer auth"}]},
    {"id": "github", "name": "GitHub", "icon": "Github", "category": "Cloud", "local": False,
     "description": "Repositories, issues, pull requests and code search via GitHub's hosted MCP server.",
     "fields": [{"key": "token", "label": "Personal access token", "kind": "secret", "required": True,
                 "hint": "github.com → Settings → Developer settings → Fine-grained tokens"},
                {"key": "readOnly", "label": "Read-only", "kind": "bool", "default": True}]},
    {"id": "notion", "name": "Notion", "icon": "NotebookText", "category": "Cloud", "local": False,
     "description": "Search and edit Notion pages and databases shared with an integration.",
     "fields": [{"key": "token", "label": "Integration secret", "kind": "secret", "required": True,
                 "hint": "notion.so/profile/integrations → new internal integration; share pages with it"}]},
    {"id": "knowledge-graph", "name": "Knowledge Graph", "icon": "Share2", "category": "Local", "local": True,
     "description": "A persistent graph of entities and relations agents can build and query (stored on this machine).",
     "fields": []},
    {"id": "sequential-thinking", "name": "Sequential Thinking", "icon": "ListOrdered", "category": "Local", "local": True,
     "description": "A scratchpad tool for step-by-step problem solving with revisions and branches.",
     "fields": []},
    {"id": "custom-http", "name": "Custom MCP (URL)", "icon": "Link", "category": "Custom", "local": None,
     "description": "Any MCP server reachable over Streamable HTTP or SSE.",
     "fields": [{"key": "url", "label": "Server URL", "kind": "text", "required": True, "placeholder": "https://example.com/mcp"},
                {"key": "token", "label": "Bearer token", "kind": "secret"},
                {"key": "sse", "label": "Legacy SSE transport", "kind": "bool", "default": False}]},
    {"id": "custom-stdio", "name": "Custom MCP (command)", "icon": "SquareTerminal", "category": "Custom", "local": True,
     "description": "Launch an MCP server as a local process, e.g. `npx -y <package>`.",
     "fields": [{"key": "command", "label": "Command line", "kind": "text", "required": True,
                 "placeholder": "npx -y @modelcontextprotocol/server-everything"},
                {"key": "env", "label": "Environment (KEY=value per line)", "kind": "secret", "multiline": True}]},
]
# Installed from Discover (community.py): its form fields travel with the server config (cfg["community"]["fields"]).
CONNECTORS.append({"id": "community", "name": "Community MCP server", "icon": "Compass", "category": "Community",
                   "local": None, "hidden": True, "fields": []})
CONNECTOR_BY_ID = {c["id"]: c for c in CONNECTORS}


def fields_of(cfg_or_connector: dict, community: dict | None = None) -> list[dict]:
    """The form fields of a server: its connector's, or for a community install the ones stored with it."""
    if (cfg_or_connector.get("connector") or cfg_or_connector.get("id")) == "community":
        return list(((community or cfg_or_connector.get("community")) or {}).get("fields") or [])
    return CONNECTOR_BY_ID.get(cfg_or_connector.get("connector", ""), {}).get("fields", [])


def build_config(connector_id: str, v: dict, community: dict | None = None) -> dict:
    """Turn a connector form into the transport part of a server config."""
    if connector_id == "community":
        import community as hub
        return hub.build(community or {}, v)
    bearer = lambda t: {"Authorization": f"Bearer {t}"} if t else {}
    if connector_id == "folder":
        root = Path(str(v.get("path", "")).strip()).expanduser()
        if not root.is_dir():
            raise ValueError(f"{root} is not a folder on this machine")
        return {"transport": "stdio", "command": TOOLS_PY,
                "args": [str(MCP_DIR / "shellb_files.py"), str(root.resolve())] + (["--read-only"] if v.get("readOnly", True) else [])}
    if connector_id == "sql":
        return {"transport": "stdio", "command": TOOLS_PY, "args": [str(MCP_DIR / "shellb_sql.py")],
                "env": {"SHELLB_SQL_URL": str(v.get("url", "")).strip()}}
    if connector_id == "n8n":
        return {"transport": "http", "url": str(v["url"]).strip(), "headers": bearer(v.get("token"))}
    if connector_id == "github":
        h = bearer(v.get("token"))
        if v.get("readOnly", True):
            h["X-MCP-Readonly"] = "true"
        return {"transport": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": h}
    if connector_id == "notion":
        return {"transport": "stdio", "command": NPX, "args": ["-y", "@notionhq/notion-mcp-server"],
                "env": {"NOTION_TOKEN": str(v.get("token", "")).strip()}}
    if connector_id == "knowledge-graph":
        return {"transport": "stdio", "command": NPX, "args": ["-y", "@modelcontextprotocol/server-memory"],
                "env": {"MEMORY_FILE_PATH": str(db.DATA / "knowledge-graph.json")}}
    if connector_id == "sequential-thinking":
        return {"transport": "stdio", "command": NPX, "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]}
    if connector_id == "custom-http":
        return {"transport": "sse" if v.get("sse") else "http", "url": str(v["url"]).strip(), "headers": bearer(v.get("token"))}
    if connector_id == "custom-stdio":
        import shlex
        parts = shlex.split(str(v.get("command", "")))
        if not parts:
            raise ValueError("Enter a command")
        cmd = NPX if parts[0] == "npx" else (shutil.which(parts[0], path=PATH) or parts[0])
        env = {}
        for line in str(v.get("env") or "").splitlines():
            if "=" in line:
                k, val = line.split("=", 1)
                env[k.strip()] = val.strip()
        return {"transport": "stdio", "command": cmd, "args": parts[1:], "env": env}
    raise ValueError(f"Unknown connector {connector_id!r}")


# ── config storage ──────────────────────────────────────────────────────────

def configs() -> list[dict]:
    return db.kv_get("mcp_servers", [])


def _save(cfgs):
    db.kv_set("mcp_servers", cfgs)


def _secret_keys(cfg):
    return {f["key"] for f in fields_of(cfg) if f["kind"] == "secret"}


def public(cfg: dict) -> dict:
    """A config safe to send to the browser: secrets replaced by a placeholder."""
    out = {k: v for k, v in cfg.items()}
    out["env"] = {k: SECRET if v else "" for k, v in (cfg.get("env") or {}).items()}
    out["headers"] = {k: SECRET if v else "" for k, v in (cfg.get("headers") or {}).items()}
    sk = _secret_keys(cfg)
    out["values"] = {k: (SECRET if (k in sk and v) else v) for k, v in (cfg.get("values") or {}).items()}
    return out


def upsert(body: dict) -> dict:
    cfgs = configs()
    sid = body.get("id")
    old = next((c for c in cfgs if c["id"] == sid), None) if sid else None
    connector = body.get("connector") or (old or {}).get("connector") or "custom-http"
    if connector not in CONNECTOR_BY_ID:
        raise ValueError(f"Unknown connector {connector!r}")
    values = dict(body.get("values") or {})
    for k, v in list(values.items()):  # placeholders mean "keep what is stored"
        if v == SECRET:
            values[k] = ((old or {}).get("values") or {}).get(k, "")
    community = body.get("community") or (old or {}).get("community") if connector == "community" else None
    for f in fields_of({"connector": connector}, community):
        if f.get("required") and not str(values.get(f["key"], "")).strip():
            raise ValueError(f"{f['label']} is required")
    name = (body.get("name") or (old or {}).get("name") or CONNECTOR_BY_ID[connector]["name"]).strip()
    if not sid:
        base = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:20] or "server"
        sid, n = base, 2
        while any(c["id"] == sid for c in cfgs):
            sid, n = f"{base}{n}", n + 1
    cfg = {"id": sid, "name": name, "connector": connector, "values": values,
           "enabled": body.get("enabled", (old or {}).get("enabled", True)),
           "disabledTools": body.get("disabledTools", (old or {}).get("disabledTools", [])),
           "createdAt": (old or {}).get("createdAt", time.time() * 1000),
           **({"community": community} if community else {}),
           **build_config(connector, values, community)}
    cfgs = [c for c in cfgs if c["id"] != sid] + [cfg] if not old else [cfg if c["id"] == sid else c for c in cfgs]
    _save(cfgs)
    return cfg


def patch(sid: str, body: dict) -> dict:
    cfgs = configs()
    cfg = next((c for c in cfgs if c["id"] == sid), None)
    if cfg is None:
        raise KeyError(sid)
    for k in ("enabled", "disabledTools", "name"):
        if k in body:
            cfg[k] = body[k]
    _save(cfgs)
    return cfg


def remove(sid: str):
    _save([c for c in configs() if c["id"] != sid])


# ── live connections ────────────────────────────────────────────────────────

def _tool_key(sid: str, tool: str) -> str:
    return f"mcp__{sid}__{re.sub(r'[^A-Za-z0-9_-]', '_', tool)}"[:64]


class Conn:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.status = "stopped"  # stopped | starting | ready | error
        self.error = ""
        self.tools: list = []
        self.queue: asyncio.Queue = asyncio.Queue()
        self.task: asyncio.Task | None = None
        self.ready = asyncio.Event()
        self.log = LOGS / f"{cfg['id']}.log"

    def _container(self) -> str | None:
        """Community servers run as `docker run --name shellb-mcp-<id>`; the container can outlive its docker CLI."""
        args = self.cfg.get("args") or []
        return args[args.index("--name") + 1] if "--name" in args and self.cfg.get("command", "").endswith("docker") else None

    def start(self):
        if self.task and not self.task.done():
            return
        if self._container():  # a leftover from a crash would block the name
            import subprocess
            subprocess.run(["docker", "rm", "-f", self._container()], capture_output=True)
        self.ready = asyncio.Event()
        self.status, self.error = "starting", ""
        self.task = asyncio.create_task(self._main())

    async def stop(self):
        if self.task and not self.task.done():
            self.task.cancel()
            try:
                await self.task
            except BaseException:
                pass
        if self._container():
            proc = await asyncio.create_subprocess_exec("docker", "rm", "-f", self._container(),
                                                        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            await proc.wait()
        self.status = "stopped"

    def _transport(self, stack: AsyncExitStack):
        from mcp.client.sse import sse_client
        from mcp.client.stdio import StdioServerParameters, stdio_client
        from mcp.client.streamable_http import streamable_http_client
        from mcp.shared._httpx_utils import create_mcp_http_client
        c = self.cfg
        if c["transport"] == "stdio":
            errlog = stack.enter_context(open(self.log, "a"))
            errlog.write(f"\n── {time.strftime('%Y-%m-%d %H:%M:%S')} starting {c['command']} {' '.join(c.get('args', []))}\n")
            errlog.flush()
            params = StdioServerParameters(command=c["command"], args=c.get("args", []),
                                           env={"PATH": PATH, **(c.get("env") or {})}, cwd=str(HOME))
            return stdio_client(params, errlog=errlog)
        if c["transport"] == "sse":
            return sse_client(c["url"], headers=c.get("headers") or None)
        client = create_mcp_http_client(headers=c.get("headers") or None)
        stack.push_async_callback(client.aclose)
        return streamable_http_client(c["url"], http_client=client)

    async def _main(self):
        from mcp import Client
        try:
            async with AsyncExitStack() as stack:
                client = await stack.enter_async_context(Client(self._transport(stack), read_timeout_seconds=300))
                tools, cursor = [], None
                while True:
                    res = await client.list_tools(cursor=cursor) if cursor else await client.list_tools()
                    tools += res.tools
                    cursor = getattr(res, "next_cursor", None)
                    if not cursor:
                        break
                self.tools = tools
                self.status = "ready"
                self.ready.set()
                pending: set = set()
                while True:
                    name, args, fut = await self.queue.get()

                    async def run(name=name, args=args, fut=fut):
                        try:
                            r = await client.call_tool(name, args, read_timeout_seconds=300)
                            if not fut.done():
                                fut.set_result(r)
                        except Exception as e:
                            if not fut.done():
                                fut.set_exception(e)
                    t = asyncio.create_task(run())
                    pending.add(t)
                    t.add_done_callback(pending.discard)
        except asyncio.CancelledError:
            raise
        except BaseException as e:  # includes ExceptionGroups from anyio task groups
            self.status, self.error = "error", _describe(e)
            if self.log.exists():
                tail = self.log.read_text(errors="replace").strip().splitlines()[-6:]
                if tail and self.cfg["transport"] == "stdio":
                    self.error += "\n" + "\n".join(tail)
            self.ready.set()
            while not self.queue.empty():  # fail queued calls instead of leaving them hanging
                _, _, fut = self.queue.get_nowait()
                if not fut.done():
                    fut.set_exception(RuntimeError(self.error))

    async def call(self, tool: str, args: dict, timeout=300):
        if self.status in ("stopped", "error"):
            self.start()
        if not self.ready.is_set():
            try:
                await asyncio.wait_for(self.ready.wait(), 180)
            except asyncio.TimeoutError:
                raise RuntimeError(f"{self.cfg['name']} did not start within 3 minutes")
        if self.status != "ready":
            raise RuntimeError(f"{self.cfg['name']} is unavailable: {self.error}")
        fut = asyncio.get_running_loop().create_future()
        await self.queue.put((tool, args, fut))
        return await asyncio.wait_for(fut, timeout)


def _describe(e: BaseException) -> str:
    while isinstance(e, BaseExceptionGroup) and e.exceptions:
        e = e.exceptions[0]
    return f"{type(e).__name__}: {e}"[:600]


CONNS: dict[str, Conn] = {}


async def sync():
    """Bring live connections in line with the stored configs."""
    cfgs = {c["id"]: c for c in configs()}
    for sid in list(CONNS):
        cfg = cfgs.get(sid)
        if cfg is None or not cfg.get("enabled") or _transport_key(cfg) != _transport_key(CONNS[sid].cfg):
            await CONNS.pop(sid).stop()
    for sid, cfg in cfgs.items():
        if cfg.get("enabled"):
            if sid not in CONNS:
                CONNS[sid] = Conn(cfg)
                CONNS[sid].start()
            else:
                CONNS[sid].cfg = cfg


def _transport_key(cfg):
    return repr([cfg.get(k) for k in ("transport", "command", "args", "env", "url", "headers")])


async def restart(sid: str):
    if sid in CONNS:
        await CONNS.pop(sid).stop()
    await sync()


async def shutdown():
    for c in list(CONNS.values()):
        await c.stop()


def server_status(sid: str) -> dict:
    conn = CONNS.get(sid)
    if conn is None:
        return {"status": "stopped", "error": "", "tools": []}
    disabled = set(conn.cfg.get("disabledTools", []))
    return {"status": conn.status, "error": conn.error,
            "tools": [{"name": t.name, "description": (t.description or "").strip()[:400], "enabled": t.name not in disabled,
                       "readOnly": bool(getattr(t.annotations, "read_only_hint", False)) if t.annotations else False}
                      for t in conn.tools]}


# ── agent integration ──────────────────────────────────────────────────────

def tool_specs(server_ids) -> dict[str, dict]:
    """{tool_key: spec} for the ready, enabled tools of the given servers."""
    out = {}
    for sid in server_ids:
        conn = CONNS.get(sid)
        if conn is None or conn.status != "ready":
            continue
        disabled = set(conn.cfg.get("disabledTools", []))
        for t in conn.tools:
            if t.name in disabled:
                continue
            schema = dict(t.input_schema or {"type": "object", "properties": {}})
            schema.setdefault("type", "object")
            schema.setdefault("properties", {})
            desc = f"[{conn.cfg['name']}] " + (t.description or t.name).strip()
            out[_tool_key(sid, t.name)] = {"server": sid, "tool": t.name,
                                           "schema": {"type": "function", "function": {
                                               "name": _tool_key(sid, t.name), "description": desc[:1024],
                                               "parameters": schema}}}
    return out


def server_label(tool_key: str) -> tuple[str, str] | None:
    m = re.match(r"^mcp__([a-z0-9_]+?)__(.+)$", tool_key)
    if not m:
        return None
    conn = CONNS.get(m.group(1))
    return ((conn.cfg["name"] if conn else m.group(1)), m.group(2))


async def call(spec: dict, args: dict, ctx):
    """Run an MCP tool and convert its result into a ToolResult."""
    from tools import FILES, ToolResult
    conn = CONNS.get(spec["server"])
    if conn is None:
        return ToolResult(f"MCP server {spec['server']} is not running.", error=True)
    r = await conn.call(spec["tool"], args or {})
    texts, images, model_images = [], [], []
    for block in r.content:
        kind = getattr(block, "type", "")
        if kind == "text":
            texts.append(block.text)
        elif kind == "image":
            ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}.get(block.mime_type, ".png")
            name = f"mcp-{uuid.uuid4().hex[:10]}{ext}"
            (FILES / name).write_bytes(base64.b64decode(block.data))
            images.append(f"/api/files/{name}")
            model_images.append(block.data)
        elif kind == "resource":
            res = block.resource
            texts.append(getattr(res, "text", None) or f"[binary resource {res.uri}]")
        elif kind == "resource_link":
            texts.append(f"[resource: {block.name} {block.uri}]")
        elif kind == "audio":
            texts.append("[audio content omitted]")
    if not texts and r.structured_content is not None:
        import json
        texts.append(json.dumps(r.structured_content, indent=1)[:20000])
    display = {"images": images} if images else {}
    return ToolResult("\n\n".join(texts) or "(no output)", display=display, error=bool(r.is_error), model_images=model_images)


def __getattr__(name):
    if name == "router":
        import mcp_router
        return mcp_router.router
    raise AttributeError(f"module '{__name__}' has no attribute '{name}'")

