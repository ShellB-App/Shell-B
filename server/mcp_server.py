"""Shell:B as an MCP server: Claude Code, Claude Desktop, Cursor and other MCP clients can ask Shell:B's agents.

Streamable HTTP at /api/v1/mcp, stateless: every POST carries one JSON-RPC message (or a batch) and gets a JSON reply,
no session and no server-sent stream. It sits behind the same API keys as the rest of /api/v1 (public_api.py): the key
goes in `Authorization: Bearer sbk_…`, and its agent list, chats, rate limit and unattended-turn rules all apply.

    claude mcp add --transport http shellb https://<spark>:8443/api/v1/mcp --header "Authorization: Bearer sbk_…"
"""
import asyncio
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response

import db
import public_api as api

router = APIRouter(prefix="/api/v1/mcp")

VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
INFO = {"name": "shellb", "title": "Shell:B", "version": "1.0"}
INSTRUCTIONS = ("Shell:B is a private AI workstation with a team of agents, each with its own model, tools and memory. "
                "Use shellb_ask to hand one a question or task; shellb_agents lists who is there and what they do. "
                "Pass the returned conversation id to continue the same chat.")

TOOLS = [
    {"name": "shellb_agents", "title": "List Shell:B agents",
     "description": "The Shell:B agents this key may use: id, name, what each is for, its model, and whether it runs locally or in the cloud.",
     "inputSchema": {"type": "object", "properties": {}},
     "annotations": {"readOnlyHint": True, "openWorldHint": False}},
    {"name": "shellb_ask", "title": "Ask a Shell:B agent",
     "description": ("Send a message to a Shell:B agent and get its reply. The agent runs a full turn with its own tools "
                     "(web search, code sandbox, documents, memory, …), so a task can take a while. Omit `agent` for the "
                     "default agent; pass `conversation` from an earlier reply to continue that chat. With wait=false it "
                     "returns at once and shellb_read shows the reply later."),
     "inputSchema": {"type": "object", "required": ["message"], "properties": {
         "message": {"type": "string", "description": "What to ask or ask for"},
         "agent": {"type": "string", "description": "Agent id from shellb_agents"},
         "conversation": {"type": "string", "description": "Continue this chat (id from an earlier shellb_ask)"},
         "instructions": {"type": "string", "description": "Extra instructions for this turn only"},
         "wait": {"type": "boolean", "description": "Wait for the reply (default true)"}}},
     "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": True}},
    {"name": "shellb_conversations", "title": "List my Shell:B chats",
     "description": "Chats this key started, newest first, with whether a reply is still running.",
     "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 200}}},
     "annotations": {"readOnlyHint": True, "openWorldHint": False}},
    {"name": "shellb_read", "title": "Read a Shell:B chat",
     "description": "One chat's messages (only chats this key started). A reply still being written shows as the last message.",
     "inputSchema": {"type": "object", "required": ["conversation"], "properties": {
         "conversation": {"type": "string"}, "last": {"type": "integer", "minimum": 1, "description": "Only the last N messages"}}},
     "annotations": {"readOnlyHint": True, "openWorldHint": False}},
    {"name": "shellb_stop", "title": "Stop a Shell:B reply",
     "description": "Stop the reply running in one of this key's chats.",
     "inputSchema": {"type": "object", "required": ["conversation"], "properties": {"conversation": {"type": "string"}}},
     "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False}},
]


def _result(rid, result):
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def _error(rid, code, message):
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def _text(obj, error=False) -> dict:
    out = {"content": [{"type": "text", "text": obj if isinstance(obj, str) else json.dumps(obj, indent=1)}]}
    if not isinstance(obj, str):
        out["structuredContent"] = obj if isinstance(obj, dict) else {"items": obj}
    if error:
        out["isError"] = True
    return out


async def _ask(key: dict, args: dict) -> dict:
    conv_id = args.get("conversation") or None
    conv0 = db.get_conversation(conv_id) if conv_id and api._owns(key, conv_id) else None
    agent = api._agent(key, args.get("agent") or (conv0 or {}).get("agentId"))
    conv = api._conversation(key, conv_id, agent)
    queue, task = api._start(key, conv, agent, str(args.get("message") or ""), str(args.get("instructions") or ""))
    drain = asyncio.create_task(api._drain(queue))
    if args.get("wait") is False:
        task.add_done_callback(lambda _: drain)
        return _text({"conversation": conv["id"], "agent": agent["id"], "status": "running",
                      "note": "Call shellb_read with this conversation for the reply."})
    final = await asyncio.shield(task)  # a client giving up doesn't cancel the turn
    await asyncio.shield(drain)
    out = api._final_out(conv["id"], final)
    m = out["message"]
    text = m.get("content") or m.get("error") or "(no reply)"
    meta = f"\n\n— {m.get('agent')} · conversation {conv['id']} · {m.get('status')}"
    if out["artifacts"]:
        meta += " · artifacts: " + ", ".join(str(a.get("title")) for a in out["artifacts"])
    return {"content": [{"type": "text", "text": text + meta}], "structuredContent": out,
            **({"isError": True} if m.get("status") == "error" else {})}


async def _call(key: dict, name: str, args: dict, req: Request) -> dict:
    if name == "shellb_agents":
        return _text(api.agents(req))
    if name == "shellb_ask":
        return await _ask(key, args)
    if name == "shellb_conversations":
        return _text(api.conversations(req, limit=int(args.get("limit") or 50)))
    if name == "shellb_read":
        out = api.conversation(str(args.get("conversation") or ""), req)
        if args.get("last"):
            out["messages"] = out["messages"][-int(args["last"]):]
        return _text(out)
    if name == "shellb_stop":
        return _text(api.stop(str(args.get("conversation") or ""), req))
    raise KeyError(name)


async def _handle(key: dict, msg, req: Request) -> dict | None:
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
        return _error(msg.get("id") if isinstance(msg, dict) else None, -32600, "Invalid request")
    rid, method, params = msg.get("id"), msg["method"], msg.get("params") or {}
    if "id" not in msg:  # a notification (initialized, cancelled, …): nothing to answer
        return None
    if method == "initialize":
        want = params.get("protocolVersion")
        return _result(rid, {"protocolVersion": want if want in VERSIONS else VERSIONS[0],
                             "capabilities": {"tools": {"listChanged": False}}, "serverInfo": INFO, "instructions": INSTRUCTIONS})
    if method == "ping":
        return _result(rid, {})
    if method == "tools/list":
        return _result(rid, {"tools": TOOLS})
    if method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        if not isinstance(args, dict):
            return _error(rid, -32602, "arguments must be an object")
        try:
            return _result(rid, await _call(key, name, args, req))
        except KeyError:
            return _error(rid, -32602, f"Unknown tool: {name}")
        except HTTPException as e:  # the API's own refusals (busy chat, unknown agent, …) are tool errors the model can read
            return _result(rid, _text(f"Shell:B: {e.detail}", error=True))
    if method in ("resources/list", "prompts/list"):
        return _result(rid, {method.split("/")[0]: []})
    return _error(rid, -32601, f"Method not found: {method}")


@router.post("")
async def mcp(req: Request):
    key = api._caller(req)  # 401 for a missing or wrong key, before anything is read
    try:
        body = await req.json()
    except Exception:
        return JSONResponse(_error(None, -32700, "Parse error"), status_code=400)
    if isinstance(body, list):
        out = [r for r in [await _handle(key, m, req) for m in body] if r is not None]
        return JSONResponse(out) if out else Response(status_code=202)
    out = await _handle(key, body, req)
    return JSONResponse(out) if out is not None else Response(status_code=202)


@router.get("")
def mcp_stream(req: Request):
    api._caller(req)
    return Response(status_code=405, headers={"Allow": "POST"})  # stateless: no server-initiated stream


@router.delete("")
def mcp_end(req: Request):
    api._caller(req)
    return Response(status_code=405, headers={"Allow": "POST"})  # no sessions to end
