"""FastAPI route handlers for MCP server and connector management."""
import asyncio
from fastapi import APIRouter, HTTPException, Request

import auth
import db
import mcp_hub
from roster import get_agents

router = APIRouter(prefix="/api/mcp")


def _server_out(cfg):
    return {**mcp_hub.public(cfg), **mcp_hub.server_status(cfg["id"])}


@router.get("/connectors")
def mcp_connectors():
    return [c for c in mcp_hub.CONNECTORS if not c.get("hidden")]


@router.get("/servers")
def mcp_servers():
    return [_server_out(c) for c in mcp_hub.configs()]


@router.post("/servers")
async def mcp_server_create(req: Request):
    auth.require_admin(req)
    body = await req.json()
    body.pop("id", None)
    try:
        cfg = mcp_hub.upsert(body)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await mcp_hub.sync()
    return _server_out(cfg)


@router.put("/servers/{sid}")
async def mcp_server_update(sid: str, req: Request):
    auth.require_admin(req)
    try:
        cfg = mcp_hub.upsert({**(await req.json()), "id": sid})
    except ValueError as e:
        raise HTTPException(400, str(e))
    await mcp_hub.sync()
    return _server_out(cfg)


@router.patch("/servers/{sid}")
async def mcp_server_patch(sid: str, req: Request):
    auth.require_admin(req)  # switching a server on starts a process on this machine
    body = {k: v for k, v in (await req.json()).items() if k in ("enabled", "disabledTools")}
    try:
        cfg = mcp_hub.patch(sid, body)
    except KeyError:
        raise HTTPException(404, "No such server")
    await mcp_hub.sync()
    return _server_out(cfg)


@router.delete("/servers/{sid}")
async def mcp_server_delete(sid: str, req: Request):
    auth.require_admin(req)
    mcp_hub.remove(sid)
    await mcp_hub.sync()
    agents = get_agents()  # drop the server from agents that used it
    if any(f"mcp:{sid}" in a.get("tools", []) for a in agents):
        for a in agents:
            a["tools"] = [t for t in a.get("tools", []) if t != f"mcp:{sid}"]
        db.kv_set("agents", agents)
    return {"ok": True}


@router.post("/servers/{sid}/restart")
async def mcp_server_restart(sid: str, req: Request):
    auth.require_admin(req)
    await mcp_hub.restart(sid)
    conn = mcp_hub.CONNS.get(sid)
    if conn:
        try:
            await asyncio.wait_for(conn.ready.wait(), 60)
        except asyncio.TimeoutError:
            pass
    cfg = next((c for c in mcp_hub.configs() if c["id"] == sid), None)
    if cfg is None:
        raise HTTPException(404, "No such server")
    return _server_out(cfg)
