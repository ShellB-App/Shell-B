# Contributing to Shell:B 🐚

First off: thank you for being here. Every contribution — whether a bug fix, documentation refinement, a new agent persona, a voice model, or a UI enhancement — makes this project better for everyone who runs it on their own hardware.

---

## 💛 Dedication & The Ethos

> **For Shelby.**  
> *This project is named in honor of and dedicated to my best friend, Shelby.*

Shell:B is built on an unwavering foundation: **your AI assistant belongs to you, not to a corporation.** Everything in this repository is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE) so that no company can take this community's work, wrap it in a proprietary cloud SaaS, and sell it back to users without returning everything to the open-source commons.

### The Recursive AI-Collaborative Scaffold

A significant portion of Shell:B was coded in close collaboration with AI — notably driven by the **Shell:B** models themselves. This recursive craftsmanship is fundamental to the philosophy of the application:

- **The app evolves according to the needs and self-reflection of the AI and its human collaborator.**
- Shell:B is not a rigid, finished appliance; it is a **living, extensible scaffold** designed for you to inspect, modify, and make entirely your own.
- **AI-assisted contributions are welcome and celebrated**: Whether you pair with local Shell:B models, Claude, or other coding agents, we embrace AI-augmented engineering. We only ask that you understand the code you submit, verify that it runs cleanly, uphold our design standards, and take full ownership of your pull request.
- **Hardware Agnostic**: Shell:B is designed to run locally on whatever hardware you have — whether a laptop, desktop, homelab server, or multi-GPU workstation. We actively welcome optimizations that make Shell:B lighter, faster, and more accessible on lower-spec machines.

---

## 🧭 What Kind of Contributions Are Welcome?

- **Core Engine & Server Improvements** — FastAPI backend optimizations, streaming response enhancements, SQLite schema migrations, and tool runner reliability.
- **Dashboard & Studio UI** — React 19 + TypeScript components, responsive layouts, theme refinements, accessibility fixes, and canvas tools.
- **The Agent Swarm** — Tuned system prompts, new agent archetypes in the Agent Lab, and novel reasoning strategies.
- **Skills & MCP Connectors** — Claude-compatible `SKILL.md` skills, custom Model Context Protocol (MCP) servers, and local tool integrations.
- **Multimodal Workflows & Assets** — ComfyUI image pipelines, Kokoro/Piper TTS voices, Whisper STT models, and MusicGen audio workflows.
- **Hardware & Deployment Optimization** — Docker compose improvements, resource optimization, quantization guides, and VRAM management.
- **Documentation & Networking** — Step-by-step guides for Tailscale mesh TLS, reverse proxies, offline deployments, and setup troubleshooting.
- **Translations & Localization** — i18n support for the web cockpit.

---

## 🏢 Corporate Contributions Policy

We welcome individual contributors from anywhere. If you are contributing on behalf of a company:

1. You must have explicit authorization to contribute under the **AGPL-3.0** license.
2. You must confirm your contribution will not be used to gatekeep, enclose, or restrict features in proprietary forks.
3. We reserve the right to decline any contribution that appears designed to introduce vendor lock-in or extract value without contributing back.

**TL;DR:** Individuals, students, hobbyists, independent researchers — absolutely welcome. Corporate attempts to turn this project into a proprietary conduit — we will spot it and decline.

---

## 🛠️ Development Setup

Shell:B consists of a **FastAPI (Python 3.12)** backend, a **React 19 + TypeScript + Vite + Tailwind CSS** frontend, and an isolated **Docker** sandbox for code execution.

### Prerequisites

- **Python 3.12+**
- **Node.js 20+ & npm**
- **Docker & Docker Compose** (for sandboxed code execution)
- **Ollama** (for local LLM inference)
- **Git**

### 1. Clone the Repository

```bash
git clone https://github.com/EveAeternam/Shell-B.git
cd Shell-B
```

### 2. Backend Setup (`server/`)

Backend code lives in `server/`:

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt  # or install fastapi uvicorn httpx etc.

# Verify Python syntax:
python3 -m py_compile server/app.py
```

### 3. Frontend Setup (`ui/`)

Frontend code lives in `ui/`:

```bash
cd ui
npm install

# Run hot-reloading dev server on :5173 (proxies /api to :8200):
npm run dev

# Build production bundle (runs tsc -b and vite build to ui/dist):
npm run build
```

### 4. Code Sandbox (`sandbox/`)

Chat sandbox execution runs inside an isolated container:

```bash
docker build -t shellb-sandbox sandbox/
```

---

## 📐 Architecture & Standards

### Crucial Engineering Rules

1. **Backend Stack**: **Python 3.12 + FastAPI**. Never write Node.js/Express backend scripts. All server logic lives in `server/`.
2. **Frontend Stack**: **React 19 + TypeScript (`.tsx`) + Tailwind CSS 3 + Vite**. Never write loose untyped `.jsx`. All UI lives in `ui/`.
3. **Sandbox vs Codebase**: Ephemeral chat execution writes to `/work` in the sandbox container. Never confuse sandbox scripts with core application files.
4. **Zero Telemetry**: Shell:B never phones home. Do not add tracking, third-party analytics scripts, or telemetry beacons.
5. **Privacy First**: Never commit private personal chats, emails, API keys, tokens, or credentials.

### Legendary Front-End Design Standards

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
   - 1px crisp borders (`border border-zinc-800/80` or `border-[var(--border-subtle)]`) over heavy muddy drop shadows.
   - Meaningful interactive states: distinct `:hover`, `:active`, and keyboard `:focus-visible` rings.
   - Design complete states: skeleton loading states, informative empty states, and constructive error states.
6. **Content Authenticity**:
   - Real, domain-specific copy. Never lorem ipsum or generic filler.
   - Actionable CTAs: "Export report", "Deploy changes", "Run tests" — never vague labels like "Submit".

---

## 🚀 How to Submit a Contribution

### 1. Create a Topic Branch

```bash
git checkout -b feat/your-feature-name
# or
git checkout -b fix/what-you-fixed
```

### 2. Make Your Changes & Test

- **Backend**: Test syntax with `python3 -m py_compile server/<file>.py` and test endpoints against `http://localhost:8200/api/...`.
- **Frontend**: Run `npm run build` inside `ui/` to verify zero TypeScript compiler errors.
- **Docker**: Verify container builds with `docker build -t shellb-sandbox sandbox/`.

### 3. Commit with Conventional Messages

Follow clear, imperative commit messages:

```bash
git commit -m "feat(voice): add Kokoro voice model support for Korean"
git commit -m "fix(websocket): resolve disconnect on high GPU memory pressure"
git commit -m "docs(networking): clarify Tailscale TLS setup for non-standard ports"
```

### 4. Open a Pull Request

- **Title & Summary**: Clearly explain what changed and why.
- **Visuals**: Include before/after screenshots or recordings for any UI changes.
- **Dependencies**: Explicitly call out any new Python packages or npm dependencies.
- **Testing**: Describe how you tested the change on your hardware.

---

## 🐛 Reporting Bugs

Before opening an issue:

1. Search existing issues to ensure it hasn't already been reported.
2. Check your service logs (`journalctl --user -u shellb-web -f` or docker logs).
3. Try reproducing in a clean environment.

**Bug Report Template:**

```markdown
### Summary
A clear, concise description of what happened.

### Steps to Reproduce
1. Go to '...'
2. Click on '....'
3. Scroll down to '....'
4. See error

### Expected Behavior
What you expected to happen.

### Environment & Specs
- **OS**: Linux / macOS / Windows (WSL)
- **Hardware**: CPU / RAM / GPU (e.g., RTX 4090, Apple Silicon M-series, CPU-only)
- **Python Version**: `python3 --version`
- **Node Version**: `node --version`
- **Docker Version**: `docker --version`
- **LLM Engine**: Ollama (model tag) / llama.cpp / Cloud AI

### Relevant Logs
```
[Paste redacted logs here — ensure no API keys or personal data are included]
```
```

---

## 💡 Suggesting Features

We welcome ideas that reinforce Shell:B's core ethos: **local-first, privacy-preserving, and user-owned**.

When submitting a feature suggestion:
- Describe the actual problem you are trying to solve.
- Explain how it benefits local AI workflows.
- Note any hardware or resource implications.
- Keep in mind: features that require mandatory cloud dependencies or third-party accounts will be evaluated skeptically; local and open-source alternatives are always preferred.

---

## 🤝 Code of Conduct

- **Be kind and respectful**: We are all building together.
- **Assume good faith**: People have varied hardware setups, experience levels, and backgrounds.
- **Zero tolerance for toxicity**: Harassment, derogatory comments, or abusive behavior will result in a permanent ban.
- **Respect the license**: If you prefer a different licensing philosophy, you are free to fork under AGPL-3.0. Do not harass maintainers over licensing choices.

---

## 📜 License Agreement

All contributions to Shell:B are made under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE). By opening a pull request, you certify that:

1. You authored the contribution or have the legal right to submit it under AGPL-3.0.
2. You grant the community the right to use, modify, and distribute your contribution under the terms of the AGPL-3.0.
3. You will not retroactively claim proprietary exclusivity over contributed code.

---

## 💬 Questions & Community

Have questions or need help setting up? Open an [Issue](https://github.com/EveAeternam/Shell-B/issues) or start a [Discussion](https://github.com/EveAeternam/Shell-B/discussions).

Thank you for helping keep personal AI open, local, and truly owned by the people who use it.
