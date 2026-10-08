"""FastAPI route handlers for skills management and file access."""
from fastapi import APIRouter, File, HTTPException, Request, UploadFile

import auth
import db
import skills
from roster import get_agents

router = APIRouter()


def _skill_error(e: Exception) -> HTTPException:
    if isinstance(e, KeyError):
        return HTTPException(404, "No such skill")
    return HTTPException(400, str(e))


@router.get("/api/skills")
def skills_list():
    return skills.list_skills()


@router.post("/api/skills")
async def skill_create(req: Request):
    auth.require_admin(req)  # a skill is text in every agent's prompt and scripts it may run
    body = await req.json()
    meta, _ = skills.parse(body.get("content", ""))
    name = skills.slug(body.get("name") or meta.get("name") or "")
    if (skills.SKILLS / name / "SKILL.md").exists():
        raise HTTPException(409, f"A skill named {name} already exists")
    try:
        return skills.save(body.get("content", ""), name)
    except (ValueError, KeyError) as e:
        raise _skill_error(e)


@router.post("/api/skills/upload")
async def skill_upload(req: Request, file: UploadFile = File(...)):
    auth.require_admin(req)
    data = await file.read()
    if len(data) > skills.MAX_SKILL_BYTES:
        raise HTTPException(413, "File too large (60 MB max)")
    try:
        return {"imported": skills.import_upload(file.filename or "skill.zip", data)}
    except (ValueError, KeyError, UnicodeDecodeError) as e:
        raise _skill_error(e)


@router.get("/api/skill-import/claude")
def skill_claude_candidates(req: Request):
    auth.require_admin(req)  # reads skills installed for Claude on this machine
    return skills.claude_candidates()


@router.post("/api/skill-import/claude")
async def skill_claude_import(req: Request):
    auth.require_admin(req)
    return {"imported": skills.import_claude((await req.json()).get("names", []))}


@router.get("/api/skills/{name}")
def skill_get(name: str):
    try:
        return skills.get(name)
    except (ValueError, KeyError) as e:
        raise _skill_error(e)


@router.put("/api/skills/{name}")
async def skill_put(name: str, req: Request):
    auth.require_admin(req)
    try:
        return skills.save((await req.json()).get("content", ""), name)
    except (ValueError, KeyError) as e:
        raise _skill_error(e)


@router.patch("/api/skills/{name}")
async def skill_patch(name: str, req: Request):
    auth.require_admin(req)
    body = await req.json()
    try:
        if "enabled" in body:
            skills.set_enabled(name, body["enabled"])
        return skills.get(name)
    except (ValueError, KeyError) as e:
        raise _skill_error(e)


@router.delete("/api/skills/{name}")
def skill_delete(name: str, req: Request):
    auth.require_admin(req)
    try:
        skills.delete(name)
    except ValueError as e:
        raise _skill_error(e)
    agents = get_agents()  # forget it in agents that picked skills explicitly
    if any(isinstance(a.get("skills"), list) and name in a["skills"] for a in agents):
        for a in agents:
            if isinstance(a.get("skills"), list):
                a["skills"] = [s for s in a["skills"] if s != name]
        db.kv_set("agents", agents)
    return {"ok": True}


@router.get("/api/skills/{name}/files/{path:path}")
def skill_file(name: str, path: str):
    try:
        return {"path": path, "content": skills.read_file(name, path, limit=400_000)}
    except FileNotFoundError:
        raise HTTPException(404, "No such file")
    except (ValueError, KeyError) as e:
        raise _skill_error(e)


@router.put("/api/skills/{name}/files/{path:path}")
async def skill_file_put(name: str, path: str, req: Request, file: UploadFile = File(...)):
    auth.require_admin(req)
    try:
        skills.put_file(name, path, await file.read())
        return skills.get(name)
    except (ValueError, KeyError) as e:
        raise _skill_error(e)


@router.delete("/api/skills/{name}/files/{path:path}")
def skill_file_delete(name: str, path: str, req: Request):
    auth.require_admin(req)
    try:
        skills.delete_file(name, path)
        return skills.get(name)
    except (ValueError, KeyError) as e:
        raise _skill_error(e)
