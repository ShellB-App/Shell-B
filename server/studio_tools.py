"""File and vision tools for Shell:B Studio projects. Registered into tools.TOOLS with scope="project"."""
import asyncio
import shutil
from pathlib import Path

import db
import projects as P
import selfmod
from codemap import line_range
from tools import TOOLS, ToolResult, _fn

TEXT_LIMIT = 80_000


def _need_project(ctx):
    if not ctx.project_id:
        raise ValueError("This tool only works inside a Studio project.")
    return ctx.project_id


async def _changed(ctx, path, action):
    await ctx.emit({"type": "file", "path": path, "action": action})


async def list_files(args, ctx):
    pid = _need_project(ctx)
    files = P.list_files(pid)
    if not files:
        return ToolResult("The project is empty.")
    lines = []
    for f in files:
        extra = ""
        if f["kind"] in ("image",):
            dims = P.image_info(P.safe_path(pid, f["path"]))
            extra = f", {dims}" if dims else ""
        lines.append(f"{f['path']}  ({f['kind']}, {f['size']:,} bytes{extra})")
    return ToolResult("\n".join(lines))


async def read_file(args, ctx):
    pid = _need_project(ctx)
    rel = str(args.get("path", ""))
    p = P.safe_path(pid, rel)
    if not p.is_file():
        return ToolResult(f"{rel} does not exist.", error=True)
    kind = P.file_kind(p)
    if kind in ("image", "font", "pdf", "video", "audio", "binary"):
        hint = "use view_image to look at it" if kind == "image" else "use run_code to inspect binary files"
        return ToolResult(f"{rel} is a {kind} file ({p.stat().st_size:,} bytes) — {hint}.")
    text = p.read_text(errors="replace")
    start, end = line_range(args)
    lines = text.splitlines(keepends=True)
    total = len(lines)
    if start > total and total:
        return ToolResult(f"{rel} has only {total} lines; start_line={start} is past the end.", error=True)
    chunk = lines[start - 1:end or None]
    text, shown = "", 0
    for line in chunk:  # cut at a line boundary so the reader knows exactly where to continue
        if len(text) + len(line) > TEXT_LIMIT and shown:
            break
        text += line
        shown += 1
    last = start + shown - 1
    if start > 1 or last < total:  # a partial read says where it is, so the next call can't re-read the same lines
        more = f"; continue with start_line={last + 1}" if last < total else ""
        text += f"\n…[{rel}: lines {start}–{last} of {total}{more}]"
    return ToolResult(text)


async def write_file(args, ctx):
    pid = _need_project(ctx)
    rel = str(args.get("path", "")).strip()
    content = args.get("content")
    if not rel or content is None:
        return ToolResult("write_file needs path and content.", error=True)
    p = P.safe_path(pid, rel)
    existed = p.exists()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(str(content))
    await _changed(ctx, rel, "modified" if existed else "created")
    if selfmod.is_self(pid):
        db.audit_log("selfmod:write_file", {"path": rel, "pid": pid, "conv_id": getattr(ctx, "conv_id", None)})
    n = str(content).count("\n") + 1
    return ToolResult(f"{'Overwrote' if existed else 'Created'} {rel} ({n} lines). The preview has refreshed.",
                      {"file": {"path": rel, "action": "modified" if existed else "created"}})


async def edit_file(args, ctx):
    pid = _need_project(ctx)
    rel = str(args.get("path", "")).strip()
    old, new = args.get("old_string"), args.get("new_string")
    if old is None or new is None:
        return ToolResult("edit_file needs old_string and new_string.", error=True)
    p = P.safe_path(pid, rel)
    if not p.is_file():
        return ToolResult(f"{rel} does not exist — create it with write_file.", error=True)
    text = p.read_text(errors="replace")
    count = text.count(old)
    if count == 0:
        # help the model recover: show where the first line of its snippet does occur
        first = str(old).strip().splitlines()[0].strip() if str(old).strip() else ""
        near = [i + 1 for i, l in enumerate(text.splitlines()) if first and first in l][:5]
        hint = f" The first line of old_string appears on line(s) {near}; re-read the file and copy the text exactly." if near \
            else " Re-read the file with read_file and copy the exact text, including whitespace."
        return ToolResult(f"old_string was not found in {rel}.{hint}", error=True)
    if count > 1 and not args.get("replace_all"):
        return ToolResult(f"old_string occurs {count} times in {rel}. Add surrounding context to make it unique, "
                          f"or pass replace_all=true.", error=True)
    p.write_text(text.replace(old, new) if args.get("replace_all") else text.replace(old, new, 1))
    await _changed(ctx, rel, "modified")
    if selfmod.is_self(pid):
        db.audit_log("selfmod:edit_file", {"path": rel, "pid": pid, "conv_id": getattr(ctx, "conv_id", None)})
    return ToolResult(f"Edited {rel} ({count if args.get('replace_all') else 1} replacement). The preview has refreshed.",
                      {"file": {"path": rel, "action": "modified"}})


async def delete_file(args, ctx):
    pid = _need_project(ctx)
    rel = str(args.get("path", "")).strip()
    p = P.safe_path(pid, rel)
    if not p.exists():
        return ToolResult(f"{rel} does not exist.", error=True)
    shutil.rmtree(p) if p.is_dir() else p.unlink()
    await _changed(ctx, rel, "deleted")
    if selfmod.is_self(pid):
        db.audit_log("selfmod:delete_file", {"path": rel, "pid": pid, "conv_id": getattr(ctx, "conv_id", None)})
    return ToolResult(f"Deleted {rel}. (It can be restored from version history.)", {"file": {"path": rel, "action": "deleted"}})


async def rename_file(args, ctx):
    pid = _need_project(ctx)
    src, dst = str(args.get("from", "")).strip(), str(args.get("to", "")).strip()
    ps, pd = P.safe_path(pid, src), P.safe_path(pid, dst)
    if not ps.exists():
        return ToolResult(f"{src} does not exist.", error=True)
    pd.parent.mkdir(parents=True, exist_ok=True)
    ps.rename(pd)
    await _changed(ctx, src, "deleted")
    await _changed(ctx, dst, "created")
    if selfmod.is_self(pid):
        db.audit_log("selfmod:rename_file", {"from": src, "to": dst, "pid": pid, "conv_id": getattr(ctx, "conv_id", None)})
    return ToolResult(f"Renamed {src} → {dst}. Update any references to the old path.")


async def _vision_review(images_b64, instruction, ctx):
    """For agents on text-only models: have the vision model describe what's on screen."""
    import httpx
    from agent import model_info
    from tools import OLLAMA
    model = ctx.settings.get("visionFallbackModel", "ShellB-Swift")
    payload = {"model": model, "stream": False, "keep_alive": "2h", "options": {"temperature": 0.2},
               "messages": [{"role": "user", "content": instruction, "images": images_b64}]}
    if "thinking" in (await model_info(model))["capabilities"]:
        payload["think"] = False
    async with httpx.AsyncClient(timeout=300) as c:
        r = await c.post(f"{OLLAMA}/api/chat", json=payload)
        r.raise_for_status()
    return r.json()["message"]["content"]


async def _deliver_images(ctx, pngs: list[bytes], caption: str, review_prompt: str):
    """Return images to a vision model directly, or a written review for text-only models."""
    from agent import model_info
    imgs = [P.b64(P.downscale(png, 1280)) for png in pngs]
    vision = "vision" in (await model_info(ctx.agent.get("model", "")))["capabilities"]
    if vision or not imgs:
        return caption, imgs
    review = await _vision_review(imgs, review_prompt, ctx)
    return f"{caption}\n\nYou can't see images, so a vision reviewer looked for you:\n{review}", []


async def view_image(args, ctx):
    pid = _need_project(ctx)
    rel = str(args.get("path", "")).strip()
    p = P.safe_path(pid, rel)
    if not p.is_file():
        return ToolResult(f"{rel} does not exist.", error=True)
    kind = P.file_kind(p)
    if kind == "svg":
        png = await _render_svg(pid, rel)
    elif kind == "image":
        png = p.read_bytes()
    else:
        return ToolResult(f"{rel} is not an image (it's {kind}).", error=True)
    if not png:
        return ToolResult(f"Couldn't render {rel}.", error=True)
    text, imgs = await _deliver_images(ctx, [png], f"Here is {rel} ({P.image_info(p) or 'svg'}).",
                                       f"Describe this image ({rel}) precisely for a designer: subject, composition, colors (hex if you can), "
                                       "typography, style, and anything notable.")
    return ToolResult(text, model_images=imgs)


async def _render_svg(pid, rel):
    import io
    tiles = await P.screenshot(pid, rel, 1024, 1024, 1, hold_ms=300)
    return tiles[0] if tiles else None


async def screenshot(args, ctx):
    pid = _need_project(ctx)
    proj = P.db.get_project(pid)
    vw, vh = P.KINDS.get(proj["kind"], P.KINDS["blank"])["viewport"]
    live = bool(args.get("server"))
    rel = str(args.get("path") or ("/" if live else proj["entry"] or "index.html")).strip()
    if live:
        import devserver
        if not await devserver.running(pid):
            return ToolResult("The dev server isn't running: call dev_server action=start first.", error=True)
    elif not P.safe_path(pid, rel.partition("?")[0]).is_file():  # a query string (e.g. game.html?demo) is passed through
        return ToolResult(f"{rel} does not exist yet.", error=True)
    w, h = int(args.get("width") or vw), int(args.get("height") or vh)
    pages = max(1, min(6, int(args.get("pages") or (3 if proj["kind"] in ("website", "deck", "print", "social", "email", "design-system", "brand") else 1))))
    tiles = await (devserver.screenshot(pid, rel, w, h, pages) if live else P.screenshot(pid, rel, w, h, pages))
    if not tiles:
        return ToolResult("Rendering failed (headless Firefox produced no image).", error=True)
    urls = [P.save_shot(pid, t) for t in tiles]
    ask = (ctx.user_request or "").strip()
    check = (f"\n\nThe user's latest request was: «{ask}»\nBefore replying, list each requirement in that request and state "
             "pass/fail against what you SEE in these images (not what you intended in the code). Fix every fail.") if ask else ""
    caption = (f"Rendered {rel} at {w}×{h}: {len(tiles)} viewport{'s' if len(tiles) > 1 else ''} from the top. "
               "Look critically: hierarchy, alignment, spacing rhythm, padding inside buttons and pills, contrast, overflow, "
               "broken images, and whether it matches DESIGN.md. (The user sees these screenshots too.)" + check)
    text, imgs = await _deliver_images(
        ctx, tiles, caption,
        f"These are screenshots of {rel} at {w}×{h}, top to bottom. Act as an exacting senior visual designer. "
        "List concrete problems (with locations): broken or missing images, overflow/clipping, misalignment, inconsistent "
        "spacing, weak hierarchy, poor contrast, awkward line breaks, empty areas. Then name the 2-3 highest-impact fixes.")
    return ToolResult(text, {"images": urls, "shot": {"path": rel, "width": w, "height": h}}, model_images=imgs)


async def search_files(args, ctx):
    """grep for the project: regex over text files, with line numbers."""
    import fnmatch
    import re
    pid = _need_project(ctx)
    pattern = str(args.get("pattern") or "")
    if not pattern:
        return ToolResult("search_files needs a pattern.", error=True)
    try:
        rx = re.compile(pattern, 0 if args.get("case_sensitive") else re.I)
    except re.error as e:
        return ToolResult(f"Bad regex: {e}. Escape special characters or use a plain word.", error=True)
    glob = str(args.get("glob") or "").strip()
    ctx_lines = max(0, min(5, int(args.get("context") or 0)))
    hits, files_hit, limit = [], 0, 200

    def scan():
        nonlocal files_hit
        for f in P.list_files(pid):
            if f["kind"] not in ("text", "html", "svg", "markdown") or f["size"] > 2_000_000:
                continue
            if glob and not (fnmatch.fnmatch(f["path"], glob) or fnmatch.fnmatch(Path(f["path"]).name, glob)):
                continue
            lines = P.safe_path(pid, f["path"]).read_text(errors="replace").splitlines()
            found = [i for i, line in enumerate(lines) if rx.search(line)]
            if not found:
                continue
            files_hit += 1
            for i in found:
                if len(hits) >= limit:
                    return
                if ctx_lines:
                    lo, hi = max(0, i - ctx_lines), min(len(lines), i + ctx_lines + 1)
                    hits.append("\n".join(f"{f['path']}:{k + 1}{':' if k == i else '-'} {lines[k][:300]}" for k in range(lo, hi)) + "\n--")
                else:
                    hits.append(f"{f['path']}:{i + 1}: {lines[i][:300]}")

    await asyncio.to_thread(scan)
    if not hits:
        return ToolResult(f"No matches for /{pattern}/" + (f" in {glob}" if glob else "") + ".")
    more = f"\n…stopped at {limit} matches; narrow the pattern or add a glob." if len(hits) >= limit else ""
    return ToolResult(f"{len(hits)} match{'es' if len(hits) != 1 else ''} in {files_hit} file{'s' if files_hit != 1 else ''}:\n"
                      + "\n".join(hits) + more)


async def find_files(args, ctx):
    import fnmatch
    pid = _need_project(ctx)
    glob = str(args.get("glob") or "*").strip()
    paths = [f["path"] for f in P.list_files(pid) if fnmatch.fnmatch(f["path"], glob) or fnmatch.fnmatch(Path(f["path"]).name, glob)]
    if not paths:
        return ToolResult(f"No files match {glob!r}.")
    return ToolResult("\n".join(paths[:500]) + (f"\n…and {len(paths) - 500} more" if len(paths) > 500 else ""))


async def project_diff(args, ctx):
    """Uncommitted changes: what this turn has changed so far (every finished turn is committed)."""
    pid = _need_project(ctx)
    path = str(args.get("path") or "").strip()

    def run():
        P.git(pid, "add", "-A", "-N")  # intent-to-add, so new files show up in the diff too
        return P.git(pid, "diff", "--stat", "--patch", "--no-color", "HEAD", *(["--", path] if path else []), check=False)

    text = await asyncio.to_thread(run)
    if not text.strip():
        return ToolResult("No changes since the last saved version.")
    return ToolResult(text if len(text) <= 30000 else text[:30000] + "\n…[diff truncated; pass path to see one file]")


def register():
    specs = {
        "list_files": (list_files, "List every file in the project with type and size (images include pixel dimensions).", {}, []),
        "read_file": (read_file, "Read a text file from the project. Use start_line/end_line for long files; a partial "
                                 "read ends with the line range shown and where to continue.",
                      {"path": {"type": "string"}, "start_line": {"type": "integer"}, "end_line": {"type": "integer"}}, ["path"]),
        "write_file": (write_file, "Create or overwrite a text file (HTML, CSS, JS, SVG, Markdown…) with complete content. "
                                   "Prefer edit_file for small changes to existing files.",
                       {"path": {"type": "string", "description": "Relative path, e.g. index.html or css/styles.css"},
                        "content": {"type": "string", "description": "The complete file content"}}, ["path", "content"]),
        "edit_file": (edit_file, "Replace an exact snippet in a file. old_string must match the file exactly (including "
                                 "whitespace) and be unique unless replace_all is true. Best for targeted changes.",
                      {"path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"},
                       "replace_all": {"type": "boolean"}}, ["path", "old_string", "new_string"]),
        "delete_file": (delete_file, "Delete a file or folder from the project (recoverable from history).",
                        {"path": {"type": "string"}}, ["path"]),
        "rename_file": (rename_file, "Move or rename a file in the project.",
                        {"from": {"type": "string"}, "to": {"type": "string"}}, ["from", "to"]),
        "view_image": (view_image, "Look at an image or SVG file in the project, e.g. an uploaded logo, photo or reference.",
                       {"path": {"type": "string"}}, ["path"]),
        "screenshot": (screenshot, "Render an HTML file in a real browser and look at the result. Use it after visual "
                                   "changes to check your work. Defaults to the entry file at the project's viewport.",
                       {"path": {"type": "string", "description": "Page to render; may carry a query string, e.g. index.html?demo"}, "width": {"type": "integer"}, "height": {"type": "integer"},
                        "pages": {"type": "integer", "description": "How many viewport-heights to capture from the top (1-6)"},
                        "server": {"type": "boolean", "description": "Render through the running dev server (path is then a URL path "
                                   "like / or /admin), so the page talks to its real back-end"}},
                       []),
        "search_files": (search_files, "Search the project's text files with a regular expression (like grep -rn). Returns "
                                       "path:line: text for each match. Use it to find definitions, usages and strings before editing.",
                         {"pattern": {"type": "string", "description": "Python regex, e.g. def parse_|TODO|class \\w+Error"},
                          "glob": {"type": "string", "description": "Only search matching files, e.g. *.py or src/**/*.ts"},
                          "context": {"type": "integer", "description": "Lines of context around each match (0-5)"},
                          "case_sensitive": {"type": "boolean"}}, ["pattern"]),
        "find_files": (find_files, "List project files whose path or name matches a glob, e.g. *.test.ts, src/*.py, Makefile.",
                       {"glob": {"type": "string"}}, ["glob"]),
        "project_diff": (project_diff, "Show the unified diff of everything changed since the last saved version (i.e. "
                                       "your changes this turn). Use it to review your work before replying.",
                         {"path": {"type": "string", "description": "Limit to one file or folder"}}, []),
    }
    ui = {
        "list_files": ("List Files", "FolderTree"), "read_file": ("Read File", "FileText"), "write_file": ("Write File", "FilePlus"),
        "edit_file": ("Edit File", "FilePen"), "delete_file": ("Delete File", "Trash2"), "rename_file": ("Rename File", "FileSymlink"),
        "view_image": ("View Image", "Eye"), "screenshot": ("Screenshot", "Camera"),
        "search_files": ("Search Files", "Search"), "find_files": ("Find Files", "FolderSearch"), "project_diff": ("Review Diff", "GitCompare"),
    }
    for name, (fn, desc, props, req) in specs.items():
        TOOLS[name] = {"fn": fn, "service": "studio", "scope": "project",
                       "ui": {"displayName": ui[name][0], "icon": ui[name][1], "category": "studio",
                              "description": desc.split(". ")[0] + "."},
                       "schema": _fn(name, desc, props, req)}
