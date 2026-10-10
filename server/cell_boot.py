"""Cell mode (SHELLB_CELL=1): Shell:B running as one guest's own instance inside a container (server/cells.py).

The container is the boundary: no network, read-only code, its own unprivileged uid, every capability dropped, and
model services reached only through the host broker's sockets, which allow only safe requests. Cell mode removes what
can't work or must not exist there, so the guest's UI and agents never offer it:
- host routers (self-modification, self-review, Discover, SSH, screen, Models and the Model Store, offline datasets,
  backups, the watchdog, network and host stats, night shift, the public API and its MCP server, the Secretary,
  Gibberlink, MCP connectors, and the owner's guest management) and the owner's login routes. `guard` keeps them from
  being added at all; the cell answers /api/auth/me itself.
- app.py routes for cloud CLI agents, the CLI bridge, cloud provider keys and Aphrodite.
- host tools (shellb_self, shellb_source, self_findings, find_capability, look_at_screen, browser, night_shift,
  generate_adult_image) and the SSH tools. `apply` prunes them once everything has registered.
- host loops: app.py's startup skips them when CELL is set.

The guest is this instance's owner. auth.py trusts the gateway's X-Shellb-Cell-Gate header and nothing else, and
every boot re-applies the settings a cell can't change (cloud, night shift, Aphrodite) and trims the agent roster to
the models the broker serves (SHELLB_CELL_MODELS, from guests.allowed_models on the host).
"""
import json
import os

CELL = os.environ.get("SHELLB_CELL") == "1"
GUEST = os.environ.get("SHELLB_CELL_GUEST", "")  # the guest's display name
FRAME_SECRET = os.environ.get("SHELLB_CELL_FRAME_SECRET", "")

# modules whose routers a cell never mounts (matched by the module of the router's endpoints)
HOST_ROUTERS = frozenset({
    "auth", "backup", "community", "datasets", "feeds", "gibberlink", "guest_accounts", "guests", "hooks", "inbox", "mcp_router", "mcp_server",
    "modelhub", "modelstore", "network", "nightshift", "public_api", "remote", "screen", "secretary", "selfmod", "shares",
    "selfreview", "sysinfo", "watchdog",
})
HOST_TOOL_MODULES = frozenset({"adult", "browsing", "community", "devserver", "feeds", "inbox", "nightshift", "screen", "selfmod",
                               "selfreview"})  # devserver: live dev servers need Docker on the host (phase 2b)
HOST_PATHS = ("/api/cli-agents", "/api/cli-bridge/", "/api/adult/")
# settings re-applied at every boot, because a cell can't do these whatever the guest sets
FORCED = {"cloudEnabled": False, "nightShift": False, "adultEnabled": False}
# first boot only: background work that would take the shared GPU for little gain
FIRST_BOOT = {"promptSuggestions": False, "suggestionsRefresh": False, "morningBrief": False}


def _router_module(router) -> str:
    return next((getattr(r.endpoint, "__module__", "") for r in router.routes if hasattr(r, "endpoint")), "")


SANDBOX_URL = "http://127.0.0.1:8250"  # forwarded by cell/entry.py to the host broker's sandbox socket (cells.py)


def report_usage(usage: dict | None):
    """Tell the host what a turn cost, so turnsPerDay/tokensPerDay apply to cells too (cells._sandbox → guests._bump)."""
    if not CELL or not usage:
        return
    import threading

    def post():
        try:
            import httpx
            httpx.post(f"{SANDBOX_URL}/usage", json={"prompt": int(usage.get("prompt") or 0), "completion": int(usage.get("completion") or 0)},
                       timeout=10, trust_env=False)
        except Exception as e:  # noqa: BLE001
            print(f"cell usage report: {type(e).__name__}: {e}")
    threading.Thread(target=post, name="cell-usage", daemon=True).start()


def auth_me():
    """What the UI asks first: signed in (the gateway only forwards signed-in guests), and the frame key."""
    import db
    return {"authenticated": True, "via": "session", "passwordSet": True, "frameKey": FRAME_SECRET,
            "cell": {"guest": GUEST}, "language": (db.kv_get("settings", {}) or {}).get("language", "")}


def not_here(rest: str):
    """A host-only API path inside a cell: a JSON 404, not the UI page the SPA catch-all would send."""
    from fastapi import HTTPException
    raise HTTPException(404, "That isn't part of your Shell:B")


def finish(app):
    """Called by app.py just before its SPA catch-all, once every route exists: whatever /api path is left unanswered
    belongs to the host (the routers `guard` skipped), and the UI gets a 404 it can read instead of index.html."""
    app.router.add_api_route("/api/{rest:path}", not_here, methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
                             include_in_schema=False)


def guard(app):
    """Called right after the FastAPI app is made: host routers and routes are never added."""
    include, add = app.include_router, app.router.add_api_route

    def include_router(router, *args, **kwargs):
        if _router_module(router) not in HOST_ROUTERS:
            include(router, *args, **kwargs)

    def add_api_route(path, endpoint, *args, **kwargs):
        methods = {m.upper() for m in kwargs.get("methods") or ()}
        if path.startswith(HOST_PATHS) or (path.startswith("/api/providers/") and methods - {"GET", "HEAD"}):
            return
        add(path, endpoint, *args, **kwargs)

    add("/api/auth/me", auth_me, methods=["GET"])
    app.include_router, app.router.add_api_route = include_router, add_api_route


def apply():
    """Called once every module has registered its tools: drop the host ones, then set the cell's defaults."""
    import remote
    from tools import TOOLS
    for name in [n for n, t in TOOLS.items() if getattr(t.get("fn"), "__module__", "") in HOST_TOOL_MODULES]:
        del TOOLS[name]
    remote.TOOLS.clear()
    boot()


def boot():
    import db
    import providers
    from defaults import DEFAULT_AGENTS
    cfg = json.loads(os.environ.get("SHELLB_CELL_MODELS") or "{}")
    models = set(cfg.get("models") or [])
    settings = dict(db.kv_get("settings", {}) or {})
    if not db.kv_get("cell_booted"):
        settings.update(FIRST_BOOT)
        db.kv_set("cell_booted", True)
    settings.update(FORCED)
    for key in ("embeddingModel", "utilityModel", "visionFallbackModel"):
        if cfg.get(key):
            settings[key] = cfg[key]
    if cfg.get("language") and not settings.get("language"):  # the owner's choice for this guest, until the guest picks their own
        settings["language"] = cfg["language"]

    def ok(a: dict) -> bool:
        return a.get("model") in models and not a.get("adult") and not providers.is_cloud(a.get("model", ""))

    stored = db.kv_get("agents")
    agents = [a for a in (stored if stored is not None else DEFAULT_AGENTS) if ok(a)]
    db.kv_set("agents", [dict(a) for a in agents])
    deleted = set(db.kv_get("deleted_agents", []) or []) | {a["id"] for a in DEFAULT_AGENTS if not ok(a)}
    db.kv_set("deleted_agents", sorted(deleted))
    if agents and settings.get("defaultAgent", "shellb") not in {a["id"] for a in agents}:
        settings["defaultAgent"] = agents[0]["id"]
    db.kv_set("settings", settings)
