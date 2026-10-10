"""Shell:B Studio — projects are real folders of files, versioned with git, previewed live."""
import asyncio
import base64
import io
import math
import mimetypes
import os
import re
import shutil
import subprocess
import time
import uuid
import zipfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from PIL import Image

import db
import ids
import remote
from offline import localize

PROJECTS = db.DATA / "projects"
META = db.DATA / "project-meta"
for d in (PROJECTS, META):
    d.mkdir(exist_ok=True)

SELF = os.environ.get("SHELLB_SELF", "http://127.0.0.1:8200")
FIREFOX = "/snap/bin/firefox"
SNAP_TMP = Path.home() / "snap" / "firefox" / "common" / "tmp"   # snap Firefox can only write under its own dirs
MAX_UPLOAD = 80 * 1024 * 1024

KINDS = {
    "website": {
        "label": "Website", "blurb": "Landing pages, product pages, microsites", "viewport": [1440, 900],
        "guide": "A responsive website. Design desktop-first at 1440px, and make sure it holds up at 768px and 390px.",
    },
    "deck": {
        "label": "Slide deck", "blurb": "Presentations as HTML slides (16:9)", "viewport": [1920, 1080],
        "guide": "A slide deck. Each slide is a <section class=\"slide\"> exactly 1920×1080px, stacked vertically with no gaps "
                 "(body margin 0, overflow hidden per slide). Screenshots tile one slide per image. Keep one idea per slide, "
                 "big type (body ≥ 28px), and add arrow-key navigation with a small inline script.",
    },
    "print": {
        "label": "One-pager / flyer", "blurb": "Print layouts at US Letter size", "viewport": [816, 1056],
        "guide": "A print document at US Letter (8.5×11in = 816×1056px at 96dpi). Each page is a <section class=\"page\"> "
                 "816×1056px with internal margins of at least 48px; add `@page { size: letter; margin: 0 }`. Design for print: "
                 "no interactive elements, crisp hierarchy, CMYK-safe colors.",
    },
    "mobile": {
        "label": "Mobile app", "blurb": "App screens and flows at phone size", "viewport": [390, 844],
        "guide": "Mobile app screens for a 390×844 viewport (iPhone-class). One HTML file per screen (e.g. home.html, "
                 "detail.html), with index.html linking them all. Respect safe areas, 44px touch targets and thumb reach.",
    },
    "dashboard": {
        "label": "Dashboard / web app", "blurb": "Data-dense app UIs and admin tools", "viewport": [1440, 900],
        "guide": "A web app or dashboard UI at 1440×900. Use realistic sample data, clear information hierarchy and "
                 "tabular numerals. Charts can use /vendor/chart.js.",
    },
    "design-system": {
        "label": "Design system", "blurb": "Tokens, components and a living style guide", "viewport": [1440, 900],
        "guide": "A design system. Put every decision in tokens.css as CSS custom properties: color (brand, neutrals, semantic "
                 "success/warning/danger/info, with light and dark values via [data-theme] and prefers-color-scheme), a type scale, "
                 "spacing, radii, shadows, motion durations/easings and z-index. Mirror them in tokens.json (W3C Design Tokens "
                 "format: {\"$value\", \"$type\"}) for handoff. components.css builds on the tokens only, with no raw hex or px "
                 "values: buttons (primary/secondary/ghost/danger, sm/md/lg), inputs, select, checkbox/radio/switch, badges, "
                 "cards, alerts, tabs, modal, table, toast and nav. index.html is the living style guide: a sticky nav, swatches "
                 "with hex and contrast ratio against text, the type specimen, the spacing ruler, and every component in all "
                 "states (default, hover, focus-visible, active, disabled, error) with short do/don't usage notes. Add a "
                 "theme toggle. Optional extra pages (e.g. example.html) show the system composed into a real screen.",
    },
    "brand": {
        "label": "Logo & brand", "blurb": "Logo marks, wordmarks and brand boards", "viewport": [1440, 900],
        "guide": "A brand identity. Draw logos as hand-built, optimized SVG in assets/logo/ (no raster tracing): primary "
                 "lockup, symbol only, wordmark, a one-color version and a reversed version, all with a tight viewBox. Explore "
                 "2-3 distinct directions before refining one. index.html is the brand board: the logo on light, dark and "
                 "photo backgrounds, construction and clear-space diagram, minimum sizes, misuse examples, palette with "
                 "hex/RGB/CMYK, typography, and sample applications (business card, social avatar, app icon, favicon at 16px). "
                 "Check that the mark still reads at 16px and 32px.",
    },
    "social": {
        "label": "Social graphics", "blurb": "Posts, stories and banners at platform sizes", "viewport": [1080, 1350],
        "guide": "Social media graphics. Each graphic is a <section class=\"frame\"> at an exact platform size, stacked with "
                 "a 40px gap on a neutral background and labeled with its size above it. Standard sizes: portrait post "
                 "1080×1350 (default), square 1080×1080, story/reel cover 1080×1920 (keep text out of the top 250px and "
                 "bottom 340px), LinkedIn banner 1584×396, X/Twitter header 1500×500, link preview / OG 1200×630, YouTube "
                 "thumbnail 1280×720. Design for a phone feed: one message per frame, headline readable at thumbnail size "
                 "(≥ 64px on a 1080px frame), strong contrast, logo small and consistent. For a campaign, keep a shared "
                 "template so the set reads as a series.",
    },
    "email": {
        "label": "Email", "blurb": "Newsletters and transactional emails", "viewport": [700, 1000],
        "guide": "An HTML email that must survive Outlook, Gmail and Apple Mail. Build with nested <table role=\"presentation\"> "
                 "at 600px wide max, centered, with inline styles on every element (a <style> block only for media queries "
                 "and dark-mode overrides). No JavaScript, no flexbox/grid, no CSS custom properties, no web fonts beyond a "
                 "graceful fallback stack. Include a hidden preheader, bulletproof buttons (padded <a> in a table cell), "
                 "alt text on every image with explicit width/height, a plain-text-friendly hierarchy, a footer with address "
                 "and unsubscribe link, and <meta name=\"color-scheme\" content=\"light dark\">. Stack columns under 600px. "
                 "Also write a plain-text version as email.txt.",
    },
    "motion": {
        "label": "Motion", "blurb": "Animated intros, banners and loops", "viewport": [1920, 1080],
        "guide": "A motion piece: an animated title, banner, product intro or loop built with CSS keyframes, SVG, the Web "
                 "Animations API or <canvas>. Choreograph it: stagger entrances, ease with purpose (no linear except for "
                 "loops), keep the total timeline deliberate and note it in DESIGN.md. Add small replay and pause controls "
                 "that hide on idle, and respect prefers-reduced-motion with a static final frame. Screenshots freeze CSS "
                 "animations at their end state, so make sure the final frame is a strong composition on its own. For ads, "
                 "the frame size is the canvas (e.g. 300×250, 728×90, 1080×1080).",
    },
    "screensaver": {
        "label": "Screensaver", "blurb": "Idle-screen animations Shell:B can use as its screensaver", "viewport": [1920, 1080],
        "guide": "A screensaver for Shell:B: a full-window piece that animates forever with nobody touching it. When the "
                 "owner picks it (Settings → Appearance, or the Use as screensaver button in the Studio), Shell:B shows "
                 "index.html full screen in a sandboxed iframe whenever the computer is idle, and any key or mouse movement "
                 "dismisses it, so build no controls, no UI chrome, no hover states and no cursor. Shell:B may draw its own "
                 "clock over the lower-left (about 30% wide, 25% tall), so keep that corner calm and don't add a clock. "
                 "Rules: it fills any aspect ratio (resize handling, no letterboxing, from 4:3 to ultrawide and portrait); "
                 "<canvas> 2D, SVG or CSS (Canvas 2D preferred, there is no WebGL in the screenshot browser); a "
                 "requestAnimationFrame loop with dt clamped, devicePixelRatio capped at 2, no growth in memory or object "
                 "count over hours (reuse particle pools, never append DOM nodes in the loop); calm on the GPU; it must "
                 "look good dark, since it often runs at night; nothing static and bright, because it may run for hours "
                 "on an OLED: drift every element slowly; vary over minutes (seasons, palette shifts, new formations) so it "
                 "never feels looped; no audio, no network (only /vendor and files in the project); respect "
                 "prefers-reduced-motion by slowing to a gentle drift, not stopping. The first frame must already be a "
                 "strong composition, since screenshots and covers capture the first second. Keep tuning constants "
                 "(speeds, counts, palette) together at the top. Ideas: generative flow fields, starfields, aquariums, "
                 "weather, slow geometry, cellular automata, Lissajous and harmonographs, drifting landscapes.",
        "starter": {"index.html": '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Screensaver</title>\n<style>\n  html, body { margin: 0; height: 100%; background: #05060c; overflow: hidden; cursor: none; }\n  canvas { display: block; width: 100vw; height: 100vh; }\n</style>\n</head>\n<body>\n<canvas id="c"></canvas>\n<script>\n// Screensaver skeleton: a full-window canvas, a clamped-dt loop, resize, a reduced-motion slowdown and a pause while\n// hidden. Replace draw() with the piece. Shell:B shows this full screen when the computer is idle.\nconst cv = document.getElementById(\'c\'), g = cv.getContext(\'2d\');\nconst slow = matchMedia(\'(prefers-reduced-motion: reduce)\').matches ? 0.25 : 1;\nlet w = 0, h = 0, t = 0, last = performance.now();\nfunction size() {\n  const dpr = Math.min(2, devicePixelRatio || 1);\n  w = innerWidth; h = innerHeight; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);\n  g.setTransform(dpr, 0, 0, dpr, 0, 0);\n}\naddEventListener(\'resize\', size); size();\n\nfunction draw(dt) {\n  // a placeholder: three slow, drifting glows\n  g.fillStyle = \'rgba(5, 6, 12, 0.2)\'; g.fillRect(0, 0, w, h);\n  for (let i = 0; i < 3; i++) {\n    const x = w * (0.5 + 0.35 * Math.sin(t * (0.07 + i * 0.03) + i * 2)), y = h * (0.5 + 0.3 * Math.cos(t * (0.05 + i * 0.02) + i));\n    const r = Math.min(w, h) * 0.35, grd = g.createRadialGradient(x, y, 0, x, y, r);\n    grd.addColorStop(0, [\'#3d7bff33\', \'#ff3d7f2e\', \'#ffc23d26\'][i]); grd.addColorStop(1, \'#0000\');\n    g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);\n  }\n}\n\nfunction frame(now) {\n  const dt = Math.min(0.05, (now - last) / 1000) * slow; last = now; t += dt;\n  draw(dt);\n  requestAnimationFrame(frame);\n}\ng.fillStyle = \'#05060c\'; g.fillRect(0, 0, w, h);\nrequestAnimationFrame(frame);\n</script>\n</body>\n</html>\n'},
    },
    "game": {
        "label": "Game", "blurb": "Playable browser games with keyboard and touch", "viewport": [1280, 720],
        "guide": "A playable browser game. Use index.html plus game.js (split into modules once it grows), rendering to a "
                 "<canvas> sized to the window with letterboxing at a fixed logical resolution, or to three.js for 3D. Use a "
                 "requestAnimationFrame loop with a fixed-timestep update (dt clamped) separate from rendering. Include "
                 "states: title screen, playing, paused (P/Esc and on blur), game over with restart. Support keyboard "
                 "(arrows and WASD, Space) and touch (on-screen controls or gestures) and show the controls on the title "
                 "screen. Save the high score and settings in localStorage. Make it feel good: screen shake, particles, hit "
                 "pause, easing and sound. Make real assets: generate_sprite for characters, enemies, items and pickups "
                 "(transparent, trimmed; pixel_size for pixel art, same seed and style words across a set), generate_texture "
                 "for tiling ground/walls/backdrops, generate_image for parallax backgrounds and title art, generate_sfx for "
                 "effects (variations=3 for frequent sounds like hits and footsteps), generate_music loop=true for the "
                 "soundtrack, generate_voice for announcer or dialogue lines. Keep an asset manifest (assets.json or a "
                 "const at the top of game.js) and preload everything behind a loading bar; one WebAudio context with "
                 "music and sfx buses and a mute toggle. Search asset_library before generating. The first frame "
                 "must show the title screen immediately, never a blank canvas, because screenshots capture the first second. "
                 "Add ?demo to the URL for an attract mode where the game plays itself, so screenshot('index.html?demo') "
                 "shows real gameplay. Prefer Canvas 2D: the screenshot browser has no WebGL, so a WebGL or three.js game "
                 "screenshots as a blank canvas (draw the title and HUD in HTML so those still show). Keep game constants (speeds, spawn rates) together at the top so tuning is easy.",
    },
    "3d": {
        "label": "3D", "blurb": "Three.js scenes, product viewers and generated models", "viewport": [1440, 900],
        "guide": "A real-time 3D experience with three.js, which is vendored locally. Load it with an import map: "
                 "<script type=\"importmap\">{\"imports\":{\"three\":\"/vendor/three/three.module.js\",\"three/addons/\":"
                 "\"/vendor/three/addons/\"}}</script>, then `import * as THREE from 'three'` and addons such as "
                 "'three/addons/controls/OrbitControls.js', 'three/addons/loaders/GLTFLoader.js' and "
                 "'three/addons/environments/RoomEnvironment.js' in a <script type=\"module\">. Use a PMREM room environment "
                 "plus a key light for good default shading, ACES tone mapping, soft shadows, devicePixelRatio capped at 2, "
                 "and resize handling. Put models in assets/models/ (.glb preferred). generate_3d makes a .glb from a text "
                 "description or from a project image. generate_texture makes tiling materials with a normal map (map + "
                 "normalMap on MeshStandardMaterial) for floors, walls and terrain; recolor generated meshes in code. Open a .glb in the file tree to inspect it in the built-in viewer. "
                 "The screenshot browser has no WebGL, so screenshots show the HTML overlay but not the 3D canvas: judge "
                 "the overlay layout from screenshots, judge models from the mesh views generate_3d returns, and say so "
                 "honestly instead of claiming you saw the scene. Catch WebGL failures and show a friendly fallback "
                 "(the poster image or the generate_3d preview). Show a loading state and keep the overlay UI (titles, "
                 "hotspots, buttons) in HTML above the canvas.",
    },
    "fullstack": {
        "label": "Web app + back-end", "blurb": "Full-stack apps with a real API and database", "viewport": [1440, 900],
        "entry": "public/index.html",
        "guide": "A full-stack web app with a real back-end that runs live in the preview (dev_server). Layout: server/ holds "
                 "the API (FastAPI by default: server/main.py, routers per resource, SQLite in data/app.db through sqlite3 or "
                 "SQLModel, schema created on startup), public/ holds the front-end it serves (index.html, app.js, styles.css; "
                 "plain ES modules, no build step), assets/ (generated and uploaded media) is served at /assets/, so "
                 "reference it as /assets/sprites/x.png from the front-end, devserver.json says how to run it. Design the back-end like the front-end: "
                 "write the data model and the API contract into DESIGN.md first (resources, fields and types, endpoints, "
                 "status codes, error shape {\"error\": {\"code\", \"message\"}}), then build it. REST conventions: plural "
                 "nouns, 201 + Location on create, 204 on delete, 404/409/422 with the error shape, pagination with "
                 "limit/cursor, validation with Pydantic models, timestamps in UTC ISO 8601. Keep secrets out of code (env "
                 "in devserver.json). For logins, hash passwords with passlib bcrypt and use HttpOnly SameSite=Lax cookies. "
                 "Seed realistic sample data on first start so the UI is never empty. After back-end changes: dev_server "
                 "restart (unless --reload picks them up), test each endpoint with http_request, then screenshot(server=true) "
                 "to see the UI against real data. The front-end must handle loading, empty and error states. Node instead "
                 "of Python is fine when asked: express, sql.js (SQLite in WASM; persist with db.export() to data/) and ws are installed globally (require them). The "
                 "sandbox has no network, so never pip/npm install at runtime.",
        "starter": {
            "devserver.json": '{\n  "command": "uvicorn server.main:app --host 127.0.0.1 --port $PORT --reload --reload-dir server",\n'
                              '  "port": 8000,\n  "env": {}\n}\n',
            "server/__init__.py": "",
            "server/main.py": '''"""API + static front-end. Run by the Studio dev server (see devserver.json)."""
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "app.db"


def db() -> sqlite3.Connection:
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    return con


@asynccontextmanager
async def lifespan(app: FastAPI):
    DB.parent.mkdir(exist_ok=True)
    with db() as con:
        con.execute("create table if not exists meta (key text primary key, value text)")
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/api/health")
def health():
    return {"ok": True}


# generated and uploaded media live in the project's assets/ folder
(ROOT / "assets").mkdir(exist_ok=True)
app.mount("/assets", StaticFiles(directory=ROOT / "assets"), name="assets")
app.mount("/", StaticFiles(directory=ROOT / "public", html=True), name="public")
''',
            "public/index.html": "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
                                 "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>App</title>\n"
                                 "<link rel=\"stylesheet\" href=\"styles.css\">\n</head>\n<body>\n<main id=\"app\"></main>\n"
                                 "<script type=\"module\" src=\"app.js\"></script>\n</body>\n</html>\n",
            "public/app.js": "const res = await fetch('api/health');\n"
                             "document.querySelector('#app').textContent = res.ok ? 'API is up.' : 'API is down.';\n",
            "public/styles.css": "body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem; }\n",
            ".gitignore": ".DS_Store\n__pycache__/\ndata/*.db\ndata/*.db-*\nnode_modules/\n",
        },
    },
    "music": {
        "label": "Music & audio", "blurb": "Tracks, soundtracks, sound packs and podcasts", "viewport": [1440, 900],
        "guide": "A music or audio project: a single, an EP or soundtrack, a game sound pack, a podcast intro/outro, or a "
                 "sonic brand. The audio files are the deliverable; index.html is the listening room that presents them: "
                 "cover art (generate_image), a tracklist with real titles, durations and a custom player (play/pause, "
                 "seek, a canvas waveform drawn from decodeAudioData, keyboard space to play), credits and liner notes. "
                 "Plan first in DESIGN.md: concept, mood words, tempo (bpm) and key per cue, instrumentation, and a cue "
                 "sheet (id, use, length, loop or one-shot). generate_music makes up to 30 s per call (stereo, 32 kHz): "
                 "keep a consistent style phrase across calls, generate longer pieces as sections (intro, A, B, outro) and "
                 "join them with run_code (pydub/ffmpeg crossfades, pyloudnorm to -14 LUFS for music, -16 for podcasts), "
                 "and use loop=true for game/background loops. generate_sfx makes effects and ambiences; generate_voice "
                 "makes narration. MIDI is available too (mido, pretty_midi, midiutil, fluidsynth with a General MIDI "
                 "soundfont) for exact melodies, stingers and chiptune. Export finals as WAV plus MP3/OGG via ffmpeg in "
                 "assets/audio/. You can't hear: describe what to listen for and ask the user to audition the takes.",
    },
    "illustration": {
        "label": "Illustration & comics", "blurb": "Characters, comics, storyboards and art series", "viewport": [1440, 900],
        "guide": "An illustration project: character sheets, a comic or storyboard, a picture book spread, concept art or an "
                 "art series. Start with a style bible in DESIGN.md (medium, line, palette, lighting, recurring style phrase, "
                 "and per character a fixed description of face, hair, build and outfit) and reuse those exact words in every "
                 "prompt so characters stay consistent; keep seeds that worked. Use generate_image quality=high for finals. "
                 "Comics and storyboards: index.html lays panels out on a CSS grid page (gutters, borders, varied panel sizes "
                 "for pacing), with lettering as real HTML/SVG text in speech balloons, never text inside generated images. "
                 "Character sheets show turnarounds, expressions and a palette strip. generate_sprite gives cut-out "
                 "characters with transparent backgrounds for compositing.",
    },
    "blank": {
        "label": "Blank", "blurb": "Anything else: logos, SVG art, documents", "viewport": [1280, 800],
        "guide": "An open-ended design project. Pick the right format for what the user asks for.",
    },
    # not a design format: Code workspaces live in the same folders/git machinery but get their own UI and prompt
    "code": {
        "label": "Code workspace", "blurb": "A repository to build, test and debug with a coding partner", "viewport": [1280, 800],
        "guide": "A software repository.",
    },
}

BRIEF_TEMPLATE = """# {name}

## Brief
{brief}

## Audience & goals
_To be defined._

## Brand
- Palette: _to be defined_
- Typography: _to be defined_
- Voice: _to be defined_

## Decisions log
"""

README_TEMPLATE = """# {name}

{brief}

## Notes for the coding partner
- How to run: _to be defined_
- How to test: _to be defined_
"""

CODE_GITIGNORE = """.DS_Store
__pycache__/
*.pyc
.pytest_cache/
.mypy_cache/
.ruff_cache/
.venv/
venv/
node_modules/
dist/
build/
*.o
*.so
*.egg-info/
.coverage
"""

router = APIRouter(prefix="/api/projects")
_bg: set = set()


def cover_later(pid: str):
    """Re-render the project thumbnail in the background after a change."""
    t = asyncio.get_running_loop().create_task(refresh_cover(pid))
    _bg.add(t)
    t.add_done_callback(_bg.discard)


# ── filesystem + git ────────────────────────────────────────────────────────

def root(pid: str) -> Path:
    p = PROJECTS / ids.check("project", pid, "project")
    if not p.is_dir():
        raise HTTPException(404, "No such project")
    return p


def safe_path(pid: str, rel: str, allow_root=True) -> Path:
    """`allow_root=False` for deletes and moves: "" or "." would otherwise mean the whole project, .git included."""
    base = root(pid).resolve()
    rel = (rel or "").strip().lstrip("/")
    p = (base / rel).resolve()
    if p != base and not str(p).startswith(str(base) + os.sep):
        raise ValueError(f"Path escapes the project: {rel!r}")
    if p == base and not allow_root:
        raise ValueError("That path is the project itself; name a file or folder inside it")
    if ".git" in p.relative_to(base).parts:
        raise ValueError("The .git folder is off limits")
    return p


def git_env(base: Path) -> dict:
    """Pin git to the project's own repository. Without GIT_DIR, a project whose .git is missing resolves to the
    repository above it (Shell:B Web's own, since data/ sits inside it), and `add -A` would stage the app's code.
    GIT_OPTIONAL_LOCKS=0: reads like the Code page's status poll must not take index.lock and break a concurrent commit."""
    return {**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_DIR": str(base / ".git"), "GIT_WORK_TREE": str(base),
            "GIT_CEILING_DIRECTORIES": str(PROJECTS)}


def ensure_repo(pid: str) -> bool:
    """Start a fresh history for a project whose .git is gone (older backups left it out); True if it had to."""
    base = root(pid)
    if (base / ".git").is_dir():
        return False
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=base, check=True, env=git_env(base), capture_output=True)
    commit(pid, "Recovered: earlier history was lost in a backup restore; it starts again here")
    return True


def git(pid: str, *args: str, check=True) -> str:
    base = root(pid)
    if not (base / ".git").is_dir():
        ensure_repo(pid)
    env = git_env(base)
    for attempt in range(5):
        r = subprocess.run(["git", "-c", "user.name=Shell:B Studio", "-c", "user.email=studio@shellb.local",
                            "-c", "core.quotepath=off", *args], cwd=base, capture_output=True, text=True, env=env)
        if r.returncode == 0 or "index.lock" not in r.stderr:
            break
        time.sleep(0.2 * (attempt + 1))  # another git process holds the lock; it is usually gone in a moment
    if check and r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or r.stdout.strip())
    return r.stdout


def commit(pid: str, message: str) -> str | None:
    git(pid, "add", "-A")
    if not git(pid, "status", "--porcelain").strip():
        return None
    git(pid, "commit", "-q", "-m", message[:200])
    db.update_project(pid)
    return git(pid, "rev-parse", "--short", "HEAD").strip()


def _tracked_paths(base: Path) -> list[Path]:
    """Files git would track (respects .gitignore); falls back to a plain walk if git is unhappy (or the .git is gone)."""
    r = subprocess.run(["git", "-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                       cwd=base, capture_output=True, env=git_env(base))
    if r.returncode != 0:
        return sorted(p for p in base.rglob("*") if ".git" not in p.relative_to(base).parts)
    return sorted({base / n for n in r.stdout.decode(errors="replace").split("\0") if n})


def is_code(pid: str) -> bool:
    proj = db.get_project(pid)
    return bool(proj) and proj["kind"] == "code"


def list_files(pid: str) -> list[dict]:
    base = root(pid)
    show_dot = is_code(pid)
    out = []
    for p in _tracked_paths(base):
        rel = p.relative_to(base)
        if not p.is_file() or ".git" in rel.parts or (not show_dot and any(part.startswith(".") for part in rel.parts)):
            continue
        st = p.stat()
        out.append({"path": str(rel), "size": st.st_size, "mtime": st.st_mtime * 1000, "kind": file_kind(p)})
    return out


def file_kind(p: Path) -> str:
    ext = p.suffix.lower()
    if ext in (".html", ".htm"):
        return "html"
    if ext in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico"):
        return "image"
    if ext == ".svg":
        return "svg"
    if ext in (".woff", ".woff2", ".ttf", ".otf"):
        return "font"
    if ext == ".pdf":
        return "pdf"
    if ext in (".md", ".markdown"):
        return "markdown"
    if ext in (".mp4", ".webm", ".mov"):
        return "video"
    if ext in (".mp3", ".wav", ".ogg", ".m4a"):
        return "audio"
    if ext in (".glb", ".gltf", ".obj", ".stl"):
        return "model"
    if ext in TEXT_EXT or p.name in TEXT_NAMES:
        return "text"
    if ext in BINARY_EXT:
        return "binary"
    try:  # unknown extension: text unless the first 4 KB contain NUL bytes
        with open(p, "rb") as f:
            head = f.read(4096)
        return "binary" if b"\0" in head else "text"
    except OSError:
        return "binary"


TEXT_EXT = {
    ".css", ".scss", ".less", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".json", ".jsonc", ".txt", ".csv", ".tsv",
    ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".py", ".pyi", ".sh", ".bash", ".zsh", ".ps1",
    ".bat", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".rs", ".go", ".java", ".kt", ".kts", ".swift", ".m",
    ".rb", ".php", ".pl", ".lua", ".r", ".jl", ".scala", ".cs", ".fs", ".dart", ".sql", ".graphql", ".proto",
    ".qml", ".cmake", ".mk", ".make", ".gradle", ".vue", ".svelte", ".astro", ".tex", ".rst", ".log", ".diff",
    ".patch", ".lock", ".gitignore", ".dockerignore", ".editorconfig",
}
TEXT_NAMES = {"Makefile", "Dockerfile", "Containerfile", "CMakeLists.txt", "LICENSE", "Procfile", "Gemfile", "Rakefile",
              "Justfile", ".gitignore", ".dockerignore", ".editorconfig", ".env.example", ".prettierrc", ".eslintrc"}
BINARY_EXT = {".zip", ".gz", ".tgz", ".xz", ".bz2", ".7z", ".tar", ".exe", ".dll", ".bin", ".o", ".a", ".so", ".dylib",
              ".class", ".jar", ".pyc", ".whl", ".db", ".sqlite", ".parquet", ".npy", ".pkl", ".docx", ".xlsx", ".pptx"}


def create_project_files(pid: str, name: str, brief: str, kind: str = "website", readme: bool = True):
    base = PROJECTS / pid
    base.mkdir(parents=True, exist_ok=True)
    if kind == "code":
        if readme:
            (base / "README.md").write_text(README_TEMPLATE.format(name=name, brief=brief.strip() or "_What does this do, and for whom?_"))
        (base / ".gitignore").write_text(CODE_GITIGNORE)
    else:
        (base / "assets").mkdir(parents=True, exist_ok=True)
        (base / "assets" / ".gitkeep").write_text("")
        (base / "DESIGN.md").write_text(BRIEF_TEMPLATE.format(name=name, brief=brief.strip() or "_What are we making, for whom, and why?_"))
        (base / ".gitignore").write_text(".DS_Store\n")
        for rel, text in KINDS.get(kind, {}).get("starter", {}).items():
            (base / rel).parent.mkdir(parents=True, exist_ok=True)
            (base / rel).write_text(text)
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=base, check=True, env=git_env(base))
    commit(pid, "Create project")


# ── screenshots (headless Firefox, tiled by scrolling) ──────────────────────

_shot_heights: dict[str, tuple[float, int]] = {}


@router.post("/_shotinfo/{token}")
async def shot_info(token: str, req: Request):
    try:
        _shot_heights[token] = (time.time(), int(float((await req.body()).decode() or 0)))
    except ValueError:
        pass
    for k, (t, _) in list(_shot_heights.items()):
        if time.time() - t > 300:
            _shot_heights.pop(k, None)
    return Response(status_code=204)


SHOT_SNIPPET = """<style>*,*::before,*::after{{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important}}html{{scroll-behavior:auto!important}}</style>
<script>(function(){{var y={y};function go(){{setTimeout(function(){{var d=document.documentElement,b=document.body;
var h=Math.max(d.scrollHeight,b?b.scrollHeight:0);try{{navigator.sendBeacon('/api/projects/_shotinfo/{token}',String(h))}}catch(e){{}}
/* Firefox --screenshot always captures from the document origin, so shift the page up instead of scrolling */
if(y){{d.style.overflow='hidden';d.style.transform='translateY(-'+y+'px)';}}}},250)}}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go);else go();}})();</script>"""
SHOT_HOLD = '<img src="/api/_hold?ms={ms}" alt="" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none">'
INSPECTOR = '<script src="/studio-inspector.js"></script>'
APPSTATE = '<script src="{api}/appstate/boot.js?s=proj:{pid}{ro}"></script>'
PAGE_SANDBOX = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock"


def inject(html: str, head: str = "", body_end: str = "") -> str:
    if head:
        m = re.search(r"<head[^>]*>", html, re.I)
        html = html[:m.end()] + head + html[m.end():] if m else head + html
    if body_end:
        i = html.lower().rfind("</body>")
        html = html[:i] + body_end + html[i:] if i >= 0 else html + body_end
    return html


async def _firefox_shot(url: str, w: int, h: int) -> bytes | None:
    SNAP_TMP.mkdir(parents=True, exist_ok=True)
    prof = Path(SNAP_TMP / f"prof-{uuid.uuid4().hex[:8]}")
    prof.mkdir()
    out = SNAP_TMP / f"shot-{uuid.uuid4().hex[:8]}.png"
    try:
        proc = await asyncio.create_subprocess_exec(
            FIREFOX, "--headless", "--no-remote", "--profile", str(prof), f"--window-size={w},{h}", "--screenshot", str(out), url,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        try:
            await asyncio.wait_for(proc.wait(), timeout=35)
        except asyncio.TimeoutError:
            proc.kill()
            return None
        return out.read_bytes() if out.exists() else None
    finally:
        shutil.rmtree(prof, ignore_errors=True)
        out.unlink(missing_ok=True)


async def screenshot(pid: str, rel: str, width: int, height: int, max_tiles: int = 1, hold_ms: int = 900) -> list[bytes]:
    """Viewport-sized PNG tiles of a page, top to bottom (scrolling keeps 100vh layouts honest)."""
    from urllib.parse import quote
    import cell_boot
    if cell_boot.CELL:  # no Firefox in a guest's container: the host renders the page through the gateway (cells.shot)
        import devserver
        return await devserver.cell_shot({"pid": pid, "path": rel, "width": width, "height": height, "pages": max_tiles,
                                          "live": False, "hold": hold_ms})
    rel, _, qs = rel.partition("?")
    return await shoot(f"{SELF}/api/projects/{pid}/raw/{quote(rel)}?" + (qs + "&" if qs else ""), width, height, max_tiles, hold_ms)


async def shoot(base: str, width: int, height: int, max_tiles: int = 1, hold_ms: int = 900) -> list[bytes]:
    """Tiles of the page at `base` (a URL ending in `?` or `&`, ready for the shot parameters) in headless Firefox. The
    page's injected snippet (SHOT_SNIPPET) reports its height for the token, which decides how many tiles follow."""
    def url(y, t):
        return f"{base}__shot={t}&__y={y}&__hold={hold_ms}"

    token = shot_token()
    first = await _firefox_shot(url(0, token), width, height)
    if not first:  # snap Firefox occasionally hangs on startup; one retry clears it
        token = shot_token()
        first = await _firefox_shot(url(0, token), width, height)
    if not first:
        return []
    tiles = [first]
    page_h = _shot_heights.pop(token, (0, height))[1] or height
    n = max(1, min(max_tiles, math.ceil((page_h - 2) / height)))
    if n > 1:
        rest = await asyncio.gather(*(_firefox_shot(url(k * height, shot_token()), width, height) for k in range(1, n)))
        tiles += [t for t in rest if t]
    return tiles


def shot_token() -> str:
    """A token for one rendering; the guest gateway accepts a page's height report only for a token made here."""
    token = uuid.uuid4().hex
    _shot_tokens.add(token)
    if len(_shot_tokens) > 200:
        _shot_tokens.clear()
    return token


_shot_tokens: set[str] = set()


def record_height(token: str, raw: bytes) -> bool:
    """The height a rendering page reported (SHOT_SNIPPET's beacon); False for a token that isn't a rendering's."""
    if token not in _shot_tokens:
        return False
    try:
        _shot_heights[token] = (time.time(), int(float(raw.decode() or 0)))
    except ValueError:
        pass
    for k, (t, _) in list(_shot_heights.items()):
        if time.time() - t > 300:
            _shot_heights.pop(k, None)
    return True


MIN_SIDE = 128  # Qwen-VL in Ollama panics (killing the model runner) on images under 32 px, e.g. pixel-art sprites


def downscale(png: bytes, max_w=1280, fmt="PNG") -> bytes:
    """Fit an image for a vision model: shrink wide ones, and blow tiny ones up (nearest-neighbour keeps pixel art crisp)."""
    im = Image.open(io.BytesIO(png))
    if im.mode in ("RGBA", "LA", "P"):  # transparency onto mid-grey, so cut-outs stay visible
        rgba = im.convert("RGBA")
        im = Image.new("RGB", rgba.size, (128, 128, 128))
        im.paste(rgba, mask=rgba.split()[3])
    else:
        im = im.convert("RGB")
    if min(im.size) < MIN_SIDE:
        k = -(-MIN_SIDE // max(1, min(im.size)))
        im = im.resize((im.width * k, im.height * k), Image.NEAREST)
    if im.width > max_w:
        im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, fmt, **({"quality": 88} if fmt == "JPEG" else {}))
    return buf.getvalue()


def save_shot(pid: str, png: bytes) -> str:
    d = META / pid / "shots"
    d.mkdir(parents=True, exist_ok=True)
    name = f"{int(time.time())}-{uuid.uuid4().hex[:6]}.png"
    (d / name).write_bytes(png)
    return f"/api/projects/{pid}/shots/{name}"


async def refresh_cover(pid: str):
    proj = db.get_project(pid)
    if not proj or proj["kind"] == "code":
        return
    entry = proj["entry"] or "index.html"
    if not (PROJECTS / pid / entry).is_file():
        htmls = [f["path"] for f in list_files(pid) if f["kind"] == "html"]
        if not htmls:
            return
        entry = htmls[0]
    w, h = KINDS.get(proj["kind"], KINDS["blank"])["viewport"]
    tiles = await screenshot(pid, entry, w, h, 1, hold_ms=700)
    if tiles:
        (META / pid).mkdir(parents=True, exist_ok=True)
        (META / pid / "cover.jpg").write_bytes(downscale(tiles[0], 720, "JPEG"))


def image_info(p: Path) -> str:
    try:
        with Image.open(p) as im:
            return f"{im.width}×{im.height}"
    except Exception:
        return ""


# ── routes ──────────────────────────────────────────────────────────────────

def project_summary(p: dict) -> dict:
    files = list_files(p["id"]) if (PROJECTS / p["id"]).is_dir() else []
    cover = META / p["id"] / "cover.jpg"
    return {**p, "fileCount": len(files), "remote": remote_view(p["id"]),
            "cover": f"/api/projects/{p['id']}/cover?v={int(cover.stat().st_mtime)}" if cover.exists() else None}


@router.get("")
def projects_list():
    return [project_summary(p) for p in db.list_projects()]


@router.get("/kinds")
def kinds():
    return {k: {kk: vv for kk, vv in v.items() if kk not in ("guide", "starter")} for k, v in KINDS.items()}


@router.post("")
async def project_create(req: Request):
    body = await req.json()
    kind = body.get("kind") if body.get("kind") in KINDS else "website"
    name = (body.get("name") or "Untitled project").strip()[:80]
    proj = db.create_project(name, kind, "README.md" if kind == "code" else KINDS[kind].get("entry", "index.html"),
                             (body.get("brief") or "").strip())
    create_project_files(proj["id"], name, body.get("brief") or "", kind)
    return project_summary(proj)


def _guess_kind(entry_html: str) -> str:
    """Pick a Studio kind from a Claude Design file's markup."""
    h = entry_html.lower()
    if re.search(r'class="[^"]*\bslide\b', h) or "1920" in h and "1080" in h:
        return "deck"
    if re.search(r'class="[^"]*\bpage\b', h) and "@page" in h:
        return "print"
    if "390" in h and "844" in h:
        return "mobile"
    return "website"


def _read_import(name: str, data: bytes, keep_dotfiles: bool = False) -> tuple[dict[str, bytes], str]:
    """Return ({relative path: bytes}, project name) from a Claude Design .zip or a lone .html file."""
    stem = Path(name).stem or "Imported design"
    if not name.lower().endswith(".zip"):
        return {Path(name).name: data}, stem
    out: dict[str, bytes] = {}
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for info in z.infolist():
            parts = Path(info.filename).parts
            if (info.is_dir() or info.filename.startswith("__MACOSX") or ".git" in parts or ".." in parts
                    or Path(info.filename).is_absolute() or (parts[-1].startswith(".") and not keep_dotfiles)
                    or (keep_dotfiles and parts[-1] == ".DS_Store")):
                continue
            out[info.filename] = z.read(info)
    # drop a single wrapper folder, e.g. "my-design/index.html"
    tops = {Path(p).parts[0] for p in out}
    if len(tops) == 1 and all(len(Path(p).parts) > 1 for p in out):
        out = {str(Path(*Path(p).parts[1:])): b for p, b in out.items()}
    return out, stem


def _find_entry(files: dict[str, bytes]) -> str | None:
    """manifest.json entry → artifact.html → index.html → shallowest .html."""
    import json
    man = files.get("manifest.json")
    if man:
        try:
            m = json.loads(man)
            for key in ("entry", "main", "index", "artifact", "html"):
                v = m.get(key) if isinstance(m, dict) else None
                if isinstance(v, str) and v.lstrip("./") in files:
                    return v.lstrip("./")
        except ValueError:
            pass
    for cand in ("artifact.html", "index.html"):
        if cand in files:
            return cand
    htmls = sorted((p for p in files if p.lower().endswith((".html", ".htm"))), key=lambda p: (len(Path(p).parts), p))
    return htmls[0] if htmls else None


@router.post("/import")
async def project_import(file: UploadFile = File(...), name: str = Form(""), kind: str = Form("")):
    """Create a project from a Claude Design export (.zip bundle or single .html)."""
    data = await file.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, f"File is larger than {MAX_UPLOAD // 1024 // 1024} MB")
    try:
        files, stem = _read_import(file.filename or "design.html", data)
    except zipfile.BadZipFile:
        raise HTTPException(400, "That isn't a valid .zip file")
    if not files:
        raise HTTPException(400, "The file is empty")
    entry = _find_entry(files)
    if not entry:
        raise HTTPException(400, "No HTML file found. Export the design from Claude Design as an HTML bundle or .zip.")
    html = files[entry].decode("utf-8", "replace")
    if kind not in KINDS:
        kind = _guess_kind(html)
    title = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
    pname = (name.strip() or (title.group(1).strip() if title and title.group(1).strip() else "") or stem).replace("_", " ")[:80]
    proj = db.create_project(pname, kind, entry, "Imported from Claude Design")
    pid = proj["id"]
    create_project_files(pid, pname, "Imported from Claude Design. Source file: " + (file.filename or entry))
    for rel, content in files.items():
        dest = safe_path(pid, rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)
    await asyncio.to_thread(commit, pid, f"Import {file.filename or entry} from Claude Design ({len(files)} files)")
    cover_later(pid)
    return {**project_summary(db.get_project(pid)), "entry": entry, "imported": len(files)}


def _code_entry(pid: str) -> str:
    files = {f["path"] for f in list_files(pid)}
    return next((c for c in ("README.md", "readme.md", "README.rst", "README") if c in files), sorted(files)[0] if files else "README.md")


@router.post("/import-code")
async def code_import(file: UploadFile = File(...), name: str = Form("")):
    """Create a Code workspace from a .zip of a repository (or a single source file)."""
    data = await file.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, f"File is larger than {MAX_UPLOAD // 1024 // 1024} MB")
    try:
        files, stem = _read_import(file.filename or "code.zip", data, keep_dotfiles=True)
    except zipfile.BadZipFile:
        raise HTTPException(400, "That isn't a valid .zip file")
    if not files:
        raise HTTPException(400, "The file is empty")
    pname = (name.strip() or stem).replace("_", " ")[:80]
    proj = db.create_project(pname, "code", "README.md", f"Imported from {file.filename or 'an upload'}")
    pid = proj["id"]
    PROJECTS.joinpath(pid).mkdir(parents=True)
    for rel, content in files.items():
        dest = safe_path(pid, rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)
    if not (PROJECTS / pid / ".gitignore").exists():
        (PROJECTS / pid / ".gitignore").write_text(CODE_GITIGNORE)
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=PROJECTS / pid, check=True, env=git_env(PROJECTS / pid))
    await asyncio.to_thread(commit, pid, f"Import {file.filename or 'upload'} ({len(files)} files)")
    db.update_project(pid, entry=_code_entry(pid))
    return project_summary(db.get_project(pid))


@router.post("/clone")
async def code_clone(req: Request):
    """Create a Code workspace by cloning a public https git repository (the server has network; the sandbox doesn't)."""
    from urllib.parse import urlparse
    from tools import _blocked_host
    body = await req.json()
    url = str(body.get("url") or "").strip()
    u = urlparse(url)
    if u.scheme != "https" or not u.hostname or u.username or u.password:
        raise HTTPException(400, "Use an https:// URL without credentials, e.g. https://github.com/owner/repo")
    if _blocked_host(u.hostname):
        raise HTTPException(400, "Local addresses are off limits")
    stem = Path(u.path.rstrip("/")).name.removesuffix(".git") or "repository"
    pname = (str(body.get("name") or "").strip() or stem)[:80]
    proj = db.create_project(pname, "code", "README.md", f"Cloned from {url}")
    pid = proj["id"]
    proc = await asyncio.create_subprocess_exec(
        "git", "clone", "-q", "--depth", "200", "--no-recurse-submodules", "-c", "protocol.allow=never",
        "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false", url, str(PROJECTS / pid),
        # no LFS smudge: a repo's .lfsconfig could point git-lfs at any host, past the _blocked_host check
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_LFS_SKIP_SMUDGE": "1"}, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        _, err = await asyncio.wait_for(proc.communicate(), timeout=180)
    except asyncio.TimeoutError:
        proc.kill()
        err = b"timed out after 180 s"
    if proc.returncode != 0:
        db.delete_project(pid)
        shutil.rmtree(PROJECTS / pid, ignore_errors=True)
        raise HTTPException(400, f"git clone failed: {err.decode(errors='replace').strip()[:400]}")
    db.update_project(pid, entry=_code_entry(pid))
    return project_summary(db.get_project(pid))


DUPLICATE_SKIP = shutil.ignore_patterns("node_modules", "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", ".ruff_cache")


@router.post("/{pid}/duplicate")
async def project_duplicate(pid: str, req: Request):
    """Fork a project or workspace: its files and git history, under a new id. Chats stay with the original."""
    src = db.get_project(pid)
    if not src:
        raise HTTPException(404, "No such project")
    if remote.config(pid):
        raise HTTPException(400, "Remote workspaces live on another host and can't be duplicated here")
    body = await req.json() if (await req.body()) else {}
    name = (str(body.get("name") or "").strip() or f"{src['name']} (copy)")[:80]
    await asyncio.to_thread(commit, pid, "Snapshot before duplicating")
    proj = db.create_project(name, src["kind"], src["entry"], src.get("description") or "")
    new = proj["id"]
    try:
        await asyncio.to_thread(shutil.copytree, PROJECTS / pid, PROJECTS / new, symlinks=True, ignore=DUPLICATE_SKIP)
        cover = META / pid / "cover.jpg"
        if cover.is_file():
            (META / new).mkdir(parents=True, exist_ok=True)
            shutil.copy2(cover, META / new / "cover.jpg")
    except Exception as e:
        db.delete_project(new)
        shutil.rmtree(PROJECTS / new, ignore_errors=True)
        shutil.rmtree(META / new, ignore_errors=True)
        raise HTTPException(500, f"Couldn't copy the files: {e}")
    return project_summary(db.get_project(new))


@router.post("/{pid}/exec")
async def code_exec(pid: str, req: Request):
    """The workspace terminal: run a shell command in the project's sandbox (same container rules as run_code)."""
    from tools import ToolContext, run_code
    root(pid)
    body = await req.json()
    cmd = str(body.get("command") or "").strip()
    if not cmd:
        raise HTTPException(400, "Empty command")
    if remote.config(pid):  # a remote workspace's terminal is a shell on that host: owner only
        remote.require_admin(req)
        code, out, err, timed_out = await remote.run(pid, cmd, who="terminal")
        text = "\n".join(x for x in (out.rstrip(), err.rstrip(), "Timed out." if timed_out else "") if x)
        return {"output": text or "(no output)", "error": bool(code or timed_out), "exitCode": code, "commit": None}

    async def nothing(_):
        pass

    ctx = ToolContext(conv_id="", message_id="", agent={}, settings={}, emit=nothing, project_id=pid)
    res = await run_code({"language": "bash", "code": cmd}, ctx)
    sha = await asyncio.to_thread(commit, pid, f"Terminal: {cmd.splitlines()[0][:90]}")
    return {"output": res.text, "error": res.error, "exitCode": res.display.get("exitCode"), "commit": sha}


@router.get("/{pid}")
async def project_get(pid: str, req: Request):
    proj = db.get_project(pid)
    if not proj:
        raise HTTPException(404, "No such project")
    files = await _remote_files(pid, req) if remote.config(pid) else list_files(pid)
    return {**project_summary(proj), "files": files, "remote": remote_view(pid), "threads": db.list_conversations(project_id=pid),
            "viewport": KINDS.get(proj["kind"], KINDS["blank"])["viewport"]}


@router.patch("/{pid}")
async def project_patch(pid: str, req: Request):
    body = await req.json()
    return project_summary(db.update_project(pid, name=body.get("name"), entry=body.get("entry"),
                                             description=body.get("description"), kind=body.get("kind")))


@router.delete("/{pid}")
def project_delete(pid: str):
    if not db.get_project(ids.check("project", pid, "project")):
        raise HTTPException(404, "No such project")
    subprocess.run(["docker", "rm", "-f", f"shellb-dev-{pid}"], capture_output=True)  # its live dev server, if any
    db.delete_project(pid)
    shutil.rmtree(PROJECTS / pid, ignore_errors=True)
    shutil.rmtree(META / pid, ignore_errors=True)
    return {"ok": True}


@router.post("/{pid}/threads")
async def thread_create(pid: str, req: Request):
    root(pid)
    body = await req.json() if (await req.body()) else {}
    code = is_code(pid)
    return db.create_conversation(body.get("agentId") or ("hephaestus" if code else "daedalus"),
                                  "Coding session" if code else "Design session", project_id=pid)


@router.get("/{pid}/files")
async def files(pid: str, req: Request):
    return await _remote_files(pid, req) if remote.config(pid) else list_files(pid)


def remote_view(pid: str) -> dict | None:
    cfg = remote.config(pid)
    if not cfg:
        return None
    try:
        h = remote.get_host(cfg["hostId"])
        return {"hostId": h["id"], "host": h["name"], "target": f"{h['user']}@{h['host']}", "path": cfg["path"],
                "autoApprove": bool(h.get("autoApprove"))}
    except ValueError:
        return {"hostId": cfg["hostId"], "host": "(removed host)", "target": "", "path": cfg["path"], "autoApprove": False}


async def _remote_files(pid: str, req: Request) -> list[dict]:
    """The remote tree for the owner; others (localhost, frame keys) see an empty workspace."""
    if not remote.is_admin(req):
        return []
    try:
        return await remote.list_files(pid)
    except Exception:
        return []


# Unsaved editor text, by project then path. The Code/Studio preview loads pages from /draft/ instead of /raw/, which
# serves these over the saved files, so a page previews with every edited file (its CSS and scripts too) before it's
# saved. In memory only: the editor re-sends its drafts whenever it opens the preview.
DRAFTS: dict[str, dict[str, str]] = {}
MAX_DRAFT_BYTES = 20 * 1024 * 1024


@router.put("/{pid}/drafts")
async def drafts_put(pid: str, req: Request):
    """Replace this project's drafts with the editor's current set ({files: {path: text}}; {} clears them)."""
    files = (await req.json()).get("files") or {}
    if not isinstance(files, dict) or sum(len(str(v)) for v in files.values()) > MAX_DRAFT_BYTES:
        raise HTTPException(400, "Send files: {path: text}, 20 MB at most")
    clean = {}
    for rel, text in files.items():
        try:
            p = safe_path(pid, rel)
        except ValueError:
            raise HTTPException(400, f"Bad path {rel!r}")
        clean[p.relative_to(root(pid).resolve()).as_posix()] = str(text)
    if clean:
        DRAFTS[pid] = clean
    else:
        DRAFTS.pop(pid, None)
    return {"ok": True, "count": len(clean)}


@router.get("/{pid}/draft/{path:path}")
async def draft(pid: str, path: str, request: Request):
    return await _serve(pid, path, request, drafts=True)


@router.get("/{pid}/raw/{path:path}")
async def raw(pid: str, path: str, request: Request):
    return await _serve(pid, path, request)


async def _serve(pid: str, path: str, request: Request, drafts: bool = False):
    if remote.config(pid):  # remote files are only ever source text: never rendered at the app origin
        remote.require_admin(request)
        try:
            text = await remote.read_text(pid, path)
        except Exception as e:  # missing file, path outside the workspace, host down
            raise HTTPException(404, f"{type(e).__name__}: {e}")
        return Response(text, media_type="text/plain; charset=utf-8",
                        headers={"Cache-Control": "no-store", "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff"})
    try:
        p = safe_path(pid, path)
    except ValueError:
        raise HTTPException(400, "Bad path")
    if p.is_dir():
        p = p / "index.html"
    overlay = DRAFTS.get(pid, {}).get(p.relative_to(root(pid).resolve()).as_posix()) if drafts else None
    if overlay is None and not p.is_file():
        raise HTTPException(404, f"{path} not found")
    # Project pages are untrusted code: whether framed, opened in a tab or screenshotted, they run in an opaque origin,
    # so they never act with the owner's cookie or this origin's privileges. Their own fetches use the frame-key prefix
    # (auth.py redirects tabs there too); no-referrer keeps that key out of Referer headers on outbound links.
    headers = {"Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Content-Security-Policy": PAGE_SANDBOX,
               "Referrer-Policy": "no-referrer"}
    q = request.query_params
    # pages opened in a frame or tab only; source reads (?__src, or a fetch(): Sec-Fetch-Dest: empty) get the file untouched
    if p.suffix.lower() in (".html", ".htm") and "__src" not in q \
            and request.headers.get("sec-fetch-dest", "") in ("", "document", "iframe", "frame"):
        # saved localStorage for the app (server/appstate.py); first in <head> so it runs before the page's scripts
        html = inject(localize(overlay if overlay is not None else p.read_text(errors="replace")),
                      head=APPSTATE.format(api=request.scope.get("shellb_prefix", "/api"), pid=pid, ro="&ro=1" if "__ro" in q else ""))
        if "__shot" in q:
            y = int(q.get("__y", "0") or 0)
            html = inject(html, head=SHOT_SNIPPET.format(y=y, token=re.sub(r"\W", "", q["__shot"])),
                          body_end=SHOT_HOLD.format(ms=min(int(q.get("__hold", "900") or 900), 5000)))
        elif "__inspect" in q:
            html = inject(html, body_end=INSPECTOR)
        return Response(html, media_type="text/html; charset=utf-8", headers=headers)
    # stylesheets and scripts loaded by a page get the same CDN → /vendor rewrite; editor reads stay untouched
    if p.suffix.lower() in (".css", ".js", ".mjs") and "__src" not in q \
            and request.headers.get("sec-fetch-dest", "") in ("style", "script", "worker"):
        text = localize(overlay if overlay is not None else p.read_text(errors="replace"))
        return Response(text, media_type=("text/css" if p.suffix.lower() == ".css" else "text/javascript") + "; charset=utf-8",
                        headers=headers)
    if overlay is not None:
        mt = mimetypes.guess_type(p.name)[0] or "text/plain"
        return Response(overlay, media_type=f"{mt}; charset=utf-8" if mt.startswith("text/") or mt.endswith(("javascript", "json", "xml")) else mt,
                        headers=headers)
    return FileResponse(p, headers=headers, media_type=mimetypes.guess_type(p.name)[0])


@router.put("/{pid}/files/{path:path}")
async def file_put(pid: str, path: str, req: Request):
    body = await req.json()
    if remote.config(pid):
        remote.require_admin(req)
        await remote.write_text(pid, path, str(body.get("content", "")), who="editor")
        return {"ok": True, "commit": None}
    p = safe_path(pid, path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body.get("content", ""))
    import selfmod
    if selfmod.is_self(pid):
        db.audit_log("selfmod:write_file", {"path": path, "pid": pid, "source": "api"})
    sha = await asyncio.to_thread(commit, pid, f"Edit {path} (manual)")
    if sha:
        cover_later(pid)
    return {"ok": True, "commit": sha}


@router.delete("/{pid}/files/{path:path}")
async def file_delete(pid: str, path: str):
    if remote.config(pid):
        raise HTTPException(400, "Delete remote files from the terminal or ask the agent.")
    try:
        p = safe_path(pid, path, allow_root=False)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if p.is_dir():
        await asyncio.to_thread(shutil.rmtree, p)  # node_modules can take seconds
    elif p.exists():
        p.unlink()
    import selfmod
    if selfmod.is_self(pid):
        db.audit_log("selfmod:delete_file", {"path": path, "pid": pid, "source": "api"})
    sha = await asyncio.to_thread(commit, pid, f"Delete {path}")
    return {"ok": True, "commit": sha}


@router.post("/{pid}/move")
async def file_move(pid: str, req: Request):
    body = await req.json()
    try:
        src, dst = safe_path(pid, body["from"], allow_root=False), safe_path(pid, body["to"], allow_root=False)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not src.exists():
        raise HTTPException(404, "Source not found")
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    import selfmod
    if selfmod.is_self(pid):
        db.audit_log("selfmod:rename_file", {"from": body.get("from"), "to": body.get("to"), "pid": pid, "source": "api"})
    sha = await asyncio.to_thread(commit, pid, f"Move {body['from']} → {body['to']}")
    return {"ok": True, "commit": sha}


@router.post("/{pid}/upload")
async def upload(pid: str, files: list[UploadFile] = File(...), dir: str = Form("assets")):
    saved = []
    for f in files:
        data = await f.read()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, f"{f.filename} is larger than {MAX_UPLOAD // 1024 // 1024} MB")
        name = re.sub(r"[^\w.\- ]+", "_", Path(f.filename or "upload").name).strip() or "upload"
        if name.lower().endswith(".zip"):
            target = safe_path(pid, f"{dir}/{Path(name).stem}")
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                for info in z.infolist():
                    if info.is_dir() or info.filename.startswith("__MACOSX") or Path(info.filename).name.startswith("."):
                        continue
                    dest = (target / info.filename).resolve()
                    if not str(dest).startswith(str(target.resolve())):
                        continue
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(z.read(info))
                    saved.append(str(dest.relative_to(root(pid))))
            continue
        dest = safe_path(pid, f"{dir}/{name}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        stem, n = dest.stem, 1
        while dest.exists():
            dest = dest.with_name(f"{stem}-{n}{dest.suffix}")
            n += 1
        dest.write_bytes(data)
        saved.append(str(dest.relative_to(root(pid))))
    sha = await asyncio.to_thread(commit, pid, f"Upload {', '.join(Path(s).name for s in saved[:6])}"
                                  + (f" (+{len(saved) - 6})" if len(saved) > 6 else ""))
    return {"saved": saved, "commit": sha}


@router.get("/{pid}/history")
def history(pid: str, limit: int = 100):
    out = git(pid, "log", f"-n{limit}", "--name-status", "--format=@@%h%x1f%H%x1f%ct%x1f%s")
    commits = []
    for chunk in out.split("@@")[1:]:
        lines = chunk.strip().splitlines()
        short, full, ts, subject = lines[0].split("\x1f")
        changes = [l.split("\t", 1) for l in lines[1:] if "\t" in l]
        commits.append({"sha": short, "fullSha": full, "timestamp": int(ts) * 1000, "message": subject,
                        "changes": [{"status": s[0], "path": p.split("\t")[-1]} for s, p in changes]})
    return commits


@router.get("/{pid}/history/{sha}/diff")
def history_diff(pid: str, sha: str, path: str | None = None):
    if not re.fullmatch(r"[0-9a-f]{4,40}", sha):
        raise HTTPException(400, "Bad revision")
    args = ["show", "--format=", "--stat", "--patch", "--no-color", sha]
    if path:
        args += ["--", path]
    text = git(pid, *args)
    return Response(text[:400_000], media_type="text/plain; charset=utf-8")


@router.post("/{pid}/history/{sha}/restore")
async def history_restore(pid: str, sha: str):
    if not re.fullmatch(r"[0-9a-f]{4,40}", sha):
        raise HTTPException(400, "Bad revision")

    def do():
        git(pid, "rm", "-r", "-q", "--cached", ".", check=False)
        git(pid, "checkout", sha, "--", ".")
        git(pid, "clean", "-fdq")
        return commit(pid, f"Restore version {sha}")

    new = await asyncio.to_thread(do)
    cover_later(pid)
    return {"ok": True, "commit": new}


@router.get("/{pid}/export.zip")
def export(pid: str):
    proj = db.get_project(pid)
    base = root(pid)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in list_files(pid):
            p = base / f["path"]
            if p.is_symlink() or not p.resolve().is_relative_to(base.resolve()):
                continue  # an agent-made symlink would put host files in the zip
            z.write(p, f["path"])
    slug = re.sub(r"[^a-z0-9]+", "-", (proj or {}).get("name", "project").lower()).strip("-") or "project"
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{slug}.zip"'})


@router.get("/{pid}/cover")
def cover(pid: str):
    p = META / ids.check("project", pid, "project") / "cover.jpg"
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "public, max-age=86400"})


@router.get("/{pid}/shots/{name}")
def shot_file(pid: str, name: str):
    p = (META / ids.check("project", pid, "project") / "shots" / name).resolve()
    if p.parent != (META / pid / "shots").resolve() or not p.is_file():
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.post("/{pid}/screenshot")
async def screenshot_route(pid: str, req: Request):
    body = await req.json()
    proj = db.get_project(pid)
    w, h = body.get("width") or KINDS[proj["kind"]]["viewport"][0], body.get("height") or KINDS[proj["kind"]]["viewport"][1]
    tiles = await screenshot(pid, body.get("path") or proj["entry"], int(w), int(h), int(body.get("tiles") or 1))
    return {"images": [save_shot(pid, t) for t in tiles]}


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()
