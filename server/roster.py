"""Shell:B agent roster and settings management."""
import db
from defaults import DEFAULT_AGENTS, DEFAULT_SETTINGS


def get_settings():
    return {**DEFAULT_SETTINGS, **db.kv_get("settings", {})}


def get_agents():
    stored = db.kv_get("agents")
    if stored is None:
        return [dict(a) for a in DEFAULT_AGENTS]
    ids = {a["id"] for a in stored}
    # new built-ins shipped after the user customised their roster still appear
    return stored + [dict(a) for a in DEFAULT_AGENTS if a["id"] not in ids and a["id"] not in db.kv_get("deleted_agents", [])]


def grant_tools(flag: str, grants: dict[str, list[str]]) -> None:
    """Give stored (customised) agents tools that a newer default ships with, once: `flag` is the kv marker.

    The defaults only seed the roster, so an owner who has edited an agent in the Agent Lab keeps their copy and
    would otherwise never see a tool added later. Each entry appends the missing tools to that agent's list."""
    if db.kv_get(flag):
        return
    agents = db.kv_get("agents")
    if agents:
        for a in agents:
            extra = grants.get(a["id"])
            if extra:
                a["tools"] = list(dict.fromkeys(a.get("tools", []) + list(extra)))
        db.kv_set("agents", agents)
    db.kv_set(flag, True)


def find_agent(agent_id):
    agents = get_agents()
    return next((a for a in agents if a["id"] == agent_id), agents[0]), agents
