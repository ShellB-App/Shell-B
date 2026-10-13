# AGENTS.md — Shell:B Web Architecture & Guidelines

This directory (`~/shellb/web`) houses the web frontend, agent runtime server, database, and sandbox tooling for Shell:B.

---

## Architecture

- **Backend (`server/`)**: Python 3.12, FastAPI, Uvicorn, SQLite.
  - Core app: `server/app.py`
  - Agent runner: `server/agent.py`
  - Tool definitions: `server/tools.py`
  - Database access: `server/db.py` (`data/shellb.db`)
  - Subsystems: `sysinfo.py`, `network.py`, `memory.py`, `episodes.py`, `activity.py`, `codex.py`, `projects.py`, etc.
  - Python venv: `~/shellb/web/venv/bin/python`

- **Frontend (`ui/`)**: React 19, TypeScript, Tailwind CSS 3, Vite, Lucide icons.
  - Components: `ui/src/components/`
  - Client API: `ui/src/api.ts`
  - Main app & layout: `ui/src/App.tsx`, `ui/src/components/Panels.tsx`
  - Styles: `ui/src/index.css`, `ui/src/themes/`
  - Build output: `ui/dist/` (served as static files by `server/app.py`)

---

## Development Workflow

1. **Backend Changes**:
   - Write code in Python only.
   - Verify syntax: `~/shellb/web/venv/bin/python -m py_compile server/<file>.py`
   - Restart service: `systemctl --user restart shellb-web`
   - Test endpoints: `curl -s http://localhost:8200/api/<route>`

2. **Frontend Changes**:
   - Write TypeScript components (`.tsx`).
   - Rebuild bundle: `cd ~/shellb/web/ui && npm run build` (runs `tsc -b && vite build`)
   - Ensure zero TypeScript compiler errors.
   - No service restart required for static UI changes, but reload browser.

3. **Rules for Agents**:
   - **Shipping a user-visible feature? Add an entry (newest first) to `docs/changelog.json`** — it feeds Settings → Changelog. If everyone (a light user included) would notice and care, add a `news` line too: one plain sentence, shown once on the What's new card, with its French in `ui/src/i18n/fr.json`.
   - **Do not create Node.js backend files.**
   - **Do not create untyped `.jsx` files.**
   - **Files written to `/work` in sandbox do not affect the web application.**

---

## 4. Legendary Front-End Design Standards

Every interface built for or inside Shell:B must uphold world-class design standards:

1. **No "AI Slop"**: Avoid generic purple-blue gradient buttons, floating glassmorphism everywhere, uniform border-radius on every container, and centered-everything layouts.
2. **Domain-Specific Identity**: Design specifically for the subject matter. Choose a deliberate aesthetic direction (Swiss minimal, tactile instrument, brutalist editorial, quiet utility).
3. **Typographic Hierarchy**:
   - Strict scale (1.25x or 1.33x ratio).
   - Tighter tracking on display headlines (`tracking-tight`), slightly loosened tracking on small metadata badges (`tracking-wider`).
   - Line length bounded to 55–75 characters (`max-w-[65ch]`). Never stretch body paragraphs edge-to-edge.
   - Tight headline line-heights (`1.1–1.25`), comfortable body line-heights (`1.5–1.65`). Avoid headline widows.
4. **Restrained Color & Contrast**:
   - 60-30-10 palette rule: 60% dominant neutral surface, 30% structural borders/cards, 10% purposeful accent.
   - In dark mode, use deep tinted neutrals (zinc, slate, dark obsidian) rather than dead `#000000` or washed grey `#222222`.
   - Strict WCAG AA contrast compliance (minimum 4.5:1 for body text, 3:1 for large display headers).
5. **Spatial Rhythm & Micro-Interactions**:
   - Multiples of 4 and 8 for all spacing (`gap-2`, `gap-4`, `p-4`, `p-6`).
   - 1px crisp borders (`border border-[var(--border-subtle)]` or `border-zinc-800/80`) over heavy muddy drop shadows.
   - Meaningful interactive states: distinct `:hover`, `:active`, and keyboard `:focus-visible` rings.
   - Design complete states: skeleton loading states, informative empty states, and constructive error states.
6. **Content Authenticity**:
   - Real, domain-specific copy. Never lorem ipsum or generic filler.
   - Actionable CTAs: "Export report", "Deploy changes", "Run tests" — never "Submit".

