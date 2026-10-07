"""Fresh starter suggestions for the empty-chat screen.

The UIs ship four static cards per agent (QUICK). Every SUGGEST_EVERY hours, once nobody is chatting, the utility model
writes a new set per agent from its role and the date (never memories: the cards sit on a screen others can see); the empty chat shows the newest
set and falls back to the static cards when none exists. Local model only, like reflection.py.
"""
import asyncio
import time

from fastapi import APIRouter

import db
import memory
import roster
from reflection import _ask_json

router = APIRouter(prefix="/api/suggestions")

SUGGEST_EVERY = 12 * 3600
COUNT = 4
KEEP_TITLES = 24  # recent titles remembered per agent so a new set doesn't repeat the last ones
busy = lambda: False  # noqa: E731  set by app.py
_task = None
_running = False

PROMPT = """Write {n} fresh starter prompts for the empty-chat screen of an AI assistant called {name}.
Its role: {role}
Today is {today}.
Each is a card: a title of 2-4 words in sentence case, and a prompt (one or two sentences, under 220 characters) the user
could send as-is. Make them concrete, varied (research, build, analysis, learning) and something this assistant can actually
do with its tools. Keep them general-interest (science, engineering, software, writing, everyday curiosity), nothing personal. Never ask the user to attach something. Do not reuse these titles: {avoid}.

Reply with JSON only: {{"suggestions": [{{"title": "…", "prompt": "…"}}, …]}}"""


def _state() -> dict:
    return db.kv_get("suggestions", {}) or {}


def _clean(items, n=COUNT) -> list[dict]:
    out, seen = [], set()
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        title, prompt = str(it.get("title") or "").strip(), str(it.get("prompt") or "").strip()
        if not (2 <= len(title) <= 40 and 10 <= len(prompt) <= 260) or title.lower() in seen:
            continue
        seen.add(title.lower())
        out.append({"title": title, "prompt": prompt})
    return out[:n]


async def generate(agent: dict, settings: dict) -> list[dict]:
    data = await _ask_json(PROMPT.format(
        n=COUNT, name=agent.get("name", agent["id"]), role=agent.get("description", ""),
        today=memory._now(settings).strftime("%A %d %B %Y"),
        avoid=", ".join(sorted({t for v in _state().values() for t in v.get("recent", [])[-KEEP_TITLES:]})) or "none"),
        settings, n=700)
    return _clean(data.get("suggestions"))


async def refresh(agent_id: str | None = None, force=False) -> dict:
    global _running
    _running = True
    try:
        settings = memory._settings()
        done = {}
        for agent in roster.get_agents():
            if agent_id and agent["id"] != agent_id:
                continue
            st = _state().get(agent["id"], {})
            if not force and time.time() - st.get("ts", 0) < SUGGEST_EVERY:
                continue
            try:
                items = await generate(agent, settings)
            except Exception as e:  # noqa: BLE001
                print(f"suggestions: {agent['id']}: {type(e).__name__}: {e}")
                continue
            if len(items) < COUNT:
                continue
            state = _state()
            state[agent["id"]] = {"items": items, "ts": time.time(),
                                  "recent": (st.get("recent", []) + [i["title"] for i in items])[-KEEP_TITLES:]}
            db.kv_set("suggestions", state)
            done[agent["id"]] = items
        return done
    finally:
        _running = False


async def _loop():
    await asyncio.sleep(120)
    while True:
        try:
            if not busy() and memory._settings().get("suggestionsRefresh", True):
                await refresh()
        except Exception as e:  # noqa: BLE001
            print(f"suggestions: {type(e).__name__}: {e}")
        await asyncio.sleep(1800)


def start():
    global _task
    if _task is None:
        _task = asyncio.create_task(_loop())


def stop():
    global _task
    if _task and not _task.done():
        _task.cancel()
        _task = None


@router.get("")
def api_get(agent: str = "shellb"):
    st = _state().get(agent) or {}
    return {"items": st.get("items", []), "ts": st.get("ts", 0) * 1000}


@router.post("/refresh")
async def api_refresh(agent: str | None = None):
    if _running:
        return {"running": True}
    return {"items": await refresh(agent, force=True)}
