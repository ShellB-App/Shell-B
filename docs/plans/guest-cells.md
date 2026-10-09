# Shell:B Guest cells: each guest gets a full, sandboxed Shell:B

## Context
Shell:B Guest is live at guest.eviemi.net. Guest turns currently run inside the owner's Shell:B process, fenced off
tool by tool, and phase 2 added Notes, Wiki, Worlds and Radio the same way.

Evie now wants guests to have Studio, Research, Shopping, Code and Codex too, with one rule: nothing guests do can
affect this machine. The only exception is themes and screensavers, which guests' agents may design and apply in the
guest's own app. Guests should see the full Shell:B UI.

Those apps touch the host in many ways: git on project trees, Docker dev servers, headless Firefox, web fetching,
file indexing, background jobs, model downloads and admin routes. Fencing all of that inside the owner's process is
fragile. The safe shape is one container per guest (a **cell**) running the unmodified Shell:B code in a "cell mode",
with no network at all. A host-side **broker** answers only safe requests to the model services, the web and the code
sandbox.

## Architecture
```
browser ── guest.eviemi.net ── gateway (guest_app, host :8220: sign-in, reports, limits)
                                   │ unix socket data/cells/<gid>/run/web.sock (+ gate secret header)
                                   ▼
            ┌──────────── cell container "shellb-cell-<gid>" ───────────────┐
            │ Shell:B (same code, SHELLB_CELL=1) as the guest's own instance │
            │ --network none, read-only root, cap-drop ALL, own uid, mem/cpu │
            │ forwarder: 127.0.0.1:{11434,8001,8002,8003,8188,8080,8230,3128}│
            └─────────────────────────────┬─────────────────────────────────┘
                     unix sockets data/cells/<gid>/run/<service>.sock
                                          ▼
              broker (host, server/cells.py): per-service allowlist, GPU queue
              with owner priority, SSRF-safe egress proxy, sandbox runner
```

- **Identity comes from the filesystem.** The broker serves each cell's sockets. Uvicorn reports the socket path in
  `scope["server"]` (checked: `uvicorn/protocols/utils.py:get_local_addr`), so the broker knows which cell and which
  service a request came from without trusting anything the cell sends.
- **Mounts:**
  - code `web/server` and `ui/dist`: read-only
  - `data/cells/<gid>` → `/app/data`: read-write, the guest's whole world
  - `~/shellb/{wiki,maps,legal}`: read-only
  - nothing else; no Docker socket and no home directory
- **Container settings:**
  - runs as a dedicated uid (61000+n, not 1000), so even a container escape doesn't land as Evie's user
  - limits `--memory 3g --cpus 4 --pids-limit 512`
  - stopped after 30 min idle, at most N running at once (setting, default 3), started on demand while the gateway
    shows "Starting your Shell:B…"

## Broker policy (server/cells.py)
Policies are taken from the service survey. JSON bodies are re-serialized, never passed through raw, and body size is
capped.

| Service | Allowed | Constraints |
|---|---|---|
| Ollama | `POST /api/chat`, `/api/generate`, `/api/embed`, `/v1/chat/completions`, `/api/show`; `GET /api/tags`, `/api/ps`, `/api/version` | Guest-model allowlist (incl. embedding + utility model); non-empty prompt; `keep_alive` never 0; clamp `num_ctx`/`num_predict`; drop `num_gpu`; tags/ps filtered. No pull, create, copy, delete or blobs. |
| ComfyUI | `POST /prompt`, `GET /history/{own pid}`, `GET /view` (own outputs), `POST /upload/image` | Every node checked against the class list that Shell:B's own image, sprite, texture and 3D graphs use; model names pinned to the FLUX schnell/Hunyuan3D/BiRefNet files; sizes, steps and batch clamped; `filename_prefix` forced per cell. Uploads PNG-only with a size cap and no subfolder. The broker calls `/free` itself. |
| HERMES | `POST /stt`, `POST /tts`, `GET /tts/voices`, `GET /tts/lexicon`, `POST /tts/lexicon/apply` | Kokoro voices only; drop fx/style. Blocked: `/tts/qwen/*` (voice cloning, RVC .pth installs), `PUT` lexicon, `/speaker_embed`, gibberlink. |
| ORPHEUS / Stable Audio | `POST /generate`, `/generate/sfx`; `GET /health` | Duration and steps clamped; no `/unload`. |
| SearXNG | `GET /search` | `q`, `format`, `pageno` and `categories` only; rate-limited. |
| Valhalla | `POST /route`, `GET /status` | Costing and location caps. |
| Egress (`:3128`) | HTTP CONNECT + plain HTTP | Resolve host-side, connect only to global addresses (reuse `tools._blocked_host`/`GUARD_HOOKS` logic), ports 80/443, per-cell rate and byte caps. Covers web_fetch, scrape, Shopping, Codex snapshots, Research sources and git clone. |
| Sandbox | `POST /run_code`, `POST /devserver/{start,stop}` | The cell sends a relative path, code and language. The broker builds the existing hardened `docker run` from `tools.run_code`/`devserver.py`, with mounts only inside `data/cells/<gid>` (realpath-checked, no symlinks out) and the cell's uid. Dev-server sockets live in the cell's dir, so the cell reaches them directly. |

- **GPU fairness:** guest chat and generation calls queue behind the owner's active turns (`app.ACTIVE`), with a global
  guest slot count (existing guest setting).
- **Daily caps:** the per-guest picture and audio caps count at the broker (ComfyUI prompts, ORPHEUS and Stable Audio
  calls).
- **Storage quota:** checked from the size of `data/cells/<gid>`.

## Cell mode in the Shell:B code (`SHELLB_CELL=1`)
- **app.py: host features are not loaded.** These routers, tools and startup loops are not registered:
  - selfmod, selfreview, community/Discover, remote (SSH), screen, browsing, cli_agents, mcp_hub/mcp_router
  - modelhub, modelstore, datasets, backup scheduler, watchdog, network, sysinfo host probes
  - nightshift, adult, public_api, secretary, gibberlink, guests and guest_app themselves
- **Startup:** `cell_boot.py` sets cell defaults on first run: guest model roster (agents limited to the broker's
  models, Daedalus included now that Studio exists), cloud off, nightShift and suggestions off.
- **auth.py.** A request carrying `X-Shellb-Cell-Gate: <SHELLB_CELL_SECRET>` counts as an owner session. No other path
  is trusted. The gateway strips the incoming header and adds its own.
- **tools.run_code and devserver.py** call the broker's sandbox endpoints when in cell mode.
- **`tools._blocked_host` and scrape.py** go through the egress proxy in cell mode instead of local DNS checks. The
  broker enforces SSRF rules. `HTTP(S)_PROXY=127.0.0.1:3128`, with `NO_PROXY` set for the forwarded service ports.
- **Firefox in the image.** Covers and scrape use it via an env-overridable path instead of `/snap/bin/firefox`. If no
  arm64 non-snap Firefox is available, covers and scrape are disabled in cells.
- **Themes and screensavers.**
  - Themes: `design_theme` already works per instance, with an Apply card.
  - Screensavers: add a `set_screensaver` card next to it. The agent builds a screensaver Studio project, and the card
    applies it in the browser (`ambience.ts`).
  - Neither affects the owner's app.

## Gateway and UI
- **guest_app.py becomes an authenticating reverse proxy.**
  - Signed out, it serves the existing invite and sign-in page (GuestGate).
  - Signed in, it proxies everything, including SSE streams, to the guest's cell over its unix socket. It starts the
    cell if needed.
  - It handles only `/api/guest/*` itself: report, devices, sign-out and me.
- **UI cell mode.** `/api/status` in a cell returns `cell: {name}`. The owner's UI then:
  - hides host-only apps and settings: Models, Offline data, Secretary, Gibberlink, MCP/Discover/Cloud/Screen/API/
    Aphrodite/Guests tabs, Backups, Network
  - adds a **Report to Evie** entry (rail and message menu) that posts to the gateway
  - goes through files touched with exact-string edits: `App.tsx`, `apps.tsx`, `Integrations.tsx`, `Panels.tsx`
- **Owner Guests tab** gains:
  - cell status (running or stopped, memory, disk)
  - Start, Stop and Reset buttons
  - the running-cells limit
  - Delete removes the container and wipes `data/cells/<gid>` with a root helper container, since files are owned by
    the cell uid.
- **Retire the in-process guest chat:**
  - `ui/src/guest/GuestApp.tsx`, `guest_notes.py`
  - the guest-turn sealing in app.py/agent.py
  - the shared-reads routes in guest_app

  Only "Evie (test)" exists, so there's no data to migrate. Kept: accounts, invites, sessions, reports and limits in
  guests.py.

## Guest user accounts (requested 2026-10-09)
Today guests sign in with one-time invite links and 10-minute device codes. There are no passwords, and a device
stays signed in for 90 days. Replace this with real accounts in `server/guests.py`. The account lives on the
**gateway** (host), never inside the cell, so a compromised cell can't touch accounts.

- **Account.**
  - Username (unique, case-insensitive), optional email, display name.
  - Password hashed with scrypt like `auth._hash` (n=2^15, r=8, p=1, 16-byte salt; `auth.py:84`).
  - Minimum 10 characters, checked against a small common-password list.
  - New columns on `guests`: `username`, `email`, `pw_salt`, `pw_hash`, `pw_set`, `totp_secret`, `totp_on`,
    `failed`, `locked_until`.
- **Sign-up only by invite.**
  - The invite link (`/#invite=CODE`) now opens "Create your account": username + password (+ optional email). On
    submit the code is consumed and a session starts.
  - Existing invite-only guests ("Evie (test)") get "Set a password" on next sign-in.
  - No open registration.
- **Sign-in:** a username + password form at guest.eviemi.net. Then a TOTP code if two-step is on. Then the cell
  starts.
- **Sessions.**
  - Keep `guest_sessions` (HttpOnly, Secure, SameSite=Strict).
  - Shorten to 30 days sliding, plus a 12-hour idle re-check of the password for "Remember me" off.
  - List and revoke devices (existing UI).
  - Device codes stay as an optional convenience but now require a password-signed-in device to issue them.
- **Brute force.**
  - Per-IP and per-account throttles, kept apart from the owner's login counters (`guests._throttle` pattern).
  - Lock the account for 15 min after 8 failures, and post an Activity item to the owner (`notify` kind `guest`).
  - Constant-time compare, with a 0.5 s delay on failure.
- **Two-step (optional per guest):**
  - TOTP (RFC 6238), implemented with stdlib `hmac`/`base64` so there's no new dependency.
  - Setup shows an otpauth:// URI and a QR rendered client-side.
  - 10 recovery codes, stored hashed.
- **Password change and reset.**
  - Guests change it in their account panel; current password required, other sessions revoked.
  - Owner reset in Settings → Guests issues a one-time **reset link** (same mechanism as invites, 24 h) and signs the
    guest out everywhere.
  - No email sending; the owner passes the link on herself.
- **Owner controls (Guests tab):** username, last sign-in, two-step on/off, locked state with an unlock button,
  "Send reset link", and the existing pause/delete.
- **Audit.** `guest_auth_log` table recording sign-in success/failure, lockouts, password changes and resets
  (time, IP, user agent). It's shown per guest in the owner's tab and kept 90 days.
- **Cell link.** The gateway authenticates and only then proxies, adding the cell gate secret. Cells never see
  passwords. Inside the cell the guest is the instance owner, so the cell's own `/api/auth/*` password screens are
  hidden in cell mode and auth.py trusts only the gate header.
- **Tests:**
  - invite → create account → sign in
  - wrong password → throttle → lockout → owner unlock
  - TOTP happy path and recovery code
  - reset link works once and revokes sessions
  - device code needs a password session
  - nothing about accounts is reachable from inside a cell

## Handoff
This plan was written in one session and is to be **implemented by another agent**. State when it was written
(2026-10-09, ~20:30):

- **Live today (uncommitted in ~/shellb/web, mixed with other sessions' work):** the in-process guest system.
  - `server/guests.py`, `guest_app.py`, `guest_notes.py`
  - `ui/src/guest/*`, `ui/src/components/GuestsTab.tsx`
  - hooks in `app.py` (begin_turn guest mode), `agent.py` (`Turn.tenant`, `_guest_tool`), `db.py` (`tenant`
    column), `privacy.py`, `notify.py`, `tools.py` (`ctx.tenant` mounts), `serve.py` (guest port 8220)
  - tests: `tests/guest_test.py` (31)
  - Memory note: `shellb-guest.md`.
- **Deployment:** `guest.eviemi.net` → cloudflared → `host.docker.internal:8220`, no Access policy; guest address
  setting already set. Restart only when `/api/status` is idle (memory note `shellb-restart-etiquette`).
- **Service and host-touchpoint facts:** this plan's tables come from three surveys. Key facts:
  - ComfyUI `/prompt` accepts any graph
  - HERMES `/tts/qwen/*` passthrough allows voice cloning and RVC .pth install
  - `run_code`/devserver need the Docker socket
  - Several service URLs are hard-coded to localhost (hence the in-cell forwarder on the same ports)
  - `db.DATA` is fixed at `<code>/../data`
- **Testing gotchas:**
  - Snap Docker can't see `/tmp`, so a scratch copy needs a data dir under `$HOME` for the sandbox.
  - Snap headless Firefox writes only under `~/snap/firefox/common` (`shot.sh`).
  - Test scratch servers with `lifespan="off"`, so startup hooks (backups, datasets, nightshift, dev-server ports)
    don't run.
- **Unrelated finding to file separately:**
  - Owner-side project cover screenshots (`projects.py:527-575`) load untrusted project HTML in host Firefox with no
    proxy restriction, over loopback.
  - `scrape.Browser` blocks local hosts; covers don't.
- **Owner decisions so far:**
  - local agents only for guests, no Aphrodite
  - full Shell:B UI per guest
  - themes and screensavers affect only the guest's own app
  - messages and tokens unlimited by default, picture/audio/storage caps per guest
  - Report to Evie everywhere
- **First step for the next agent:** read this file, then `docs/MANUAL.md` § Shell:B Guest and the memory note, then
  start Phase 1. Ask the owner before the `docker build`, creating `data/cells`, and restarts.

## Files
- **New:**
  - `server/cells.py`: lifecycle, broker policies, egress proxy, sandbox runner
  - `server/cell_boot.py`: cell-mode defaults
  - `cell/Dockerfile`, `cell/requirements.txt` (from `pip freeze`), `cell/forward.py` (in-cell TCP→uds forwarder)
  - `tests/cells_test.py`
- **Changed:** `app.py`, `auth.py`, `tools.py`, `devserver.py`, `scrape.py`, `projects.py`, `themes.py`, `guest_app.py`,
  `guests.py`, `serve.py`, UI cell-mode bits, `GuestsTab.tsx`, `docs/MANUAL.md`, changelog.

## Phases
1. **Chat in a cell, end to end.** Image, forwarder, broker for Ollama/HERMES/ComfyUI/audio/SearXNG, cell-mode
   app/auth, gateway proxy. Chat, images and voice working inside a cell.
2. **Sandbox and egress.** run_code, dev servers, web egress, git clone. This enables Studio, Code, Research,
   Shopping and Codex.
3. **UI.** Cell-mode UI, Report to Evie, screensaver card, Guests tab cell controls, retire the old guest app.
4. **Ship.** Hardening tests, docs, deploy.

Guest accounts (the section above) can be built first or alongside Phase 1, since they only touch the gateway.

Host operations needing approval at deploy: `docker build` of shellb-cell, creating `data/cells`, restarting
shellb-web.

## Verification
- **Unit tests (`tests/cells_test.py`):**
  - Ollama pull, delete and create are refused, as are non-allowlisted models and keep_alive 0
  - ComfyUI graphs with CheckpointSave, unknown nodes or foreign model names are refused
  - `/tts/qwen/*` and `PUT` lexicon are refused
  - egress to 10.x, 100.64/10, 127.x, 169.254.x and the host's own ports is refused
  - sandbox paths escaping the cell dir are refused, including via symlinks
  - cell-mode app has none of the host routers
  - the gate header is required and stripped at the gateway
- **Escape drill from inside a running cell (`docker exec`):**
  - no route to the LAN, tailnet or host without the proxy
  - `curl 127.0.0.1:11434/api/pull` refused
  - can't read `/home`, the Docker socket or the owner's data
  - run_code sees only its own `/work`
  - memory and pid limits hold
- **End to end through guest.eviemi.net with a test guest:** invite → cell starts → chat, image, Studio project with a
  dev server preview, Code workspace with git clone, Research board, Shopping search, Codex link snapshot, theme and
  screensaver generated and applied.
- **Checks:** owner's sidebar, Codex and memory untouched; cell idles out and restarts cleanly; `scripts/check.sh`
  green.
