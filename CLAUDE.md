# Shell:B Web — Local DGX Spark Workstation

You are working on the Shell:B private AI stack.

## Crucial Architecture Rules
- **Backend Stack**: **Python 3.12 + FastAPI**. Never write Node.js/Express backend scripts. Backend files live in `server/`.
- **Frontend Stack**: **React 19 + TypeScript (`.tsx`) + Tailwind CSS + Vite**. Never write loose untyped `.jsx`. Frontend lives in `ui/`.
- **Sandbox vs Codebase**: Chat sandbox execution writes to an ephemeral `/work` container mount. To modify Shell:B, edit files directly in `~/shellb/web/` (or via `shellb_self` within chats).
- **Build & Verification**:
  - Frontend: `cd ~/shellb/web/ui && npm run build` (outputs to `ui/dist`)
  - Server restart: `systemctl --user restart shellb-web`
  - Health check: `curl -s http://localhost:8200/api/status`

## Local Services
- Shell:B Web: `:8200` (LAN) / `:8443` (Tailscale HTTPS)
- GAIA (`:8100`): retired 2026-10-08 (unit disabled, files kept)
- HERMES (STT/TTS): `:8001` & `:8004` (Qwen3-TTS)
- ORPHEUS (MusicGen): `:8002`
- Stable Audio (SFX): `:8003`
- NYX (ComfyUI / FLUX): `:8188`
- Ollama: `:11434`
- SearXNG: `:8080`
- ChromaDB (`:8000`): retired 2026-10-08 (stopped; Shell:B Web keeps memory in SQLite)
- Checks before any restart/build: `~/shellb/web/scripts/check.sh` (py_compile, pyflakes, tests, tsc)

Be direct, verify before concluding, and budget tool rounds efficiently.
