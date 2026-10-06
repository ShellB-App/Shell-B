<div align="center">

# 🐚 SHELL : B

**Local-first AI workstation, autonomous multi-agent cockpit, and creative operating system.**

*Built here. Runs here. Stays here. Nothing leaves your machine.*

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL%20v3-blue.svg?style=for-the-badge&logo=gnu" alt="License: AGPL v3" /></a>
  <a href="https://python.org"><img src="https://img.shields.io/badge/Python-3.12-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python 3.12" /></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React 19" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.0-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://tailwindcss.com"><img src="https://img.shields.io/badge/Tailwind-3.4-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white" alt="Tailwind CSS" /></a>
  <a href="https://ollama.ai"><img src="https://img.shields.io/badge/Ollama-Native%20Local-black?style=for-the-badge&logo=ollama&logoColor=white" alt="Ollama" /></a>
  <a href="https://docker.com"><img src="https://img.shields.io/badge/Docker-Sandboxed%20Execution-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker Sandbox" /></a>
  <a href="https://tailscale.com"><img src="https://img.shields.io/badge/Tailscale-Mesh%20TLS-2563EB?style=for-the-badge&logo=tailscale&logoColor=white" alt="Tailscale" /></a>
  <img src="https://img.shields.io/badge/Zero-Cloud%20Telemetry-10b981?style=for-the-badge&logo=shield" alt="Zero Telemetry" />
</p>

---

<p align="center">
  <img src="screenshots/hero-dark.png" alt="Shell:B Cockpit" width="100%" />
</p>

<p align="center">
  <b><a href="#-dedication--the-ethos">Dedication & Ethos</a></b> •
  <b><a href="#-the-agent-swarm">Agent Swarm</a></b> •
  <b><a href="#-interface-showcase">Showcase</a></b> •
  <b><a href="#what-it-does">Features</a></b> •
  <b><a href="#%EF%B8%8F-architecture">Architecture</a></b> •
  <b><a href="#-access--networking">Networking</a></b>
</p>

</div>

---

The Shell:B chat interface: a local, Claude-desktop-style web app over the Shell:B stack. Everything runs entirely on your own local hardware — whether a multi-GPU workstation, home server, desktop, or laptop. Nothing leaves the building unless you explicitly switch on Cloud AI or an online connector.

## 💛 Dedication & The Ethos

> **For Shelby.**  
> *This project is named in honor of and dedicated to my best friend, Shelby.*

A significant portion of Shell:B was coded in collaboration with AI — notably driven by the **Shell:B** models themselves. This recursive craftsmanship is fundamental to the ethos of the application: **the app evolves according to the needs and self-reflection of the AI**.

Shell:B is not a rigid or prescriptive appliance; it is a **living, extensible scaffold** designed for you to make entirely your own.

---

## 🤖 The Agent Swarm

Shell:B is not a single generic chatbot; it is a collaborative swarm of specialized agents. Each persona has its own tuned system prompt, temperature, reasoning effort, tool permissions, and context configuration — all editable on the fly in the **Agent Lab**.

| Agent | Glyph | Domain & Specialty | Core Model | Tools & Capabilities |
| :--- | :---: | :--- | :--- | :--- |
| **Shell:B** | `✦` | **The Orchestrator**<br>Central intelligence, complex multi-step orchestration, tool delegation, and general problem solving. | `ShellB-Swift` | Web search & fetch, document OCR, Python sandbox, artifacts, audio/visual generation, memory, sub-agent delegation. |
| **Hephaestus** | `⚒` | **Engineering & Code Forge**<br>Writes, executes, tests, and debugs production-quality software. Inspects git diffs and commits code. | `ShellB-Forge`<br>*(Qwen3-Coder-Next)* | Isolated Docker sandbox execution, artifact generation, code verification, multi-file editing. |
| **Daedalus** | `◭` | **Creative Studio & Product Design**<br>Architects interactive web apps, slide decks, playable games, Three.js 3D scenes, and branding with legendary design standards. | `ShellB-Swift` | Full-stack project generation, live preview canvas, asset creation, Three.js/HTML5 game synthesis. |
| **Minerva** | `◈` | **Deep Research & Analysis**<br>Autonomous web research, primary source triangulation, citation formatting, and Research Board curation. | `ShellB-Swift` | VASSAGO web search, Trafilatura page extraction, quantitative computing, persistent research boards. |
| **Mimir** | `◇` | **Knowledge & Reference Desk**<br>Zero-internet factual reference. Consults local Kiwix ZIM Wikipedia, personal Codex, and past conversation memory. | `ShellB-Swift` | Offline Kiwix ZIM reader, episodic FTS5 message search, semantic memory recall, strict source attribution. |
| **Heimdall** | `◉` | **Sensory Cortex & Vision**<br>Document inspection, blueprint and diagram analysis, screenshot review, and high-precision character transcription. | `ShellB-Swift` | Dual-engine OCR (RapidOCR for part numbers/code, vision model for handwriting/tables), PyMuPDF rendering. |
| **NYX** | `✿` | **Generative Visuals & Audio**<br>Digital artist and sound studio. Produces high-fidelity imagery, textures, sprite sheets, and musical compositions. | `ShellB-Swift` | FLUX via ComfyUI, sprite/texture generators, 3D asset generation, MusicGen & AudioCraft pipelines. |
| **Atlas** | `🧭` | **Worlds & Cartography**<br>Planetary cartographer, orbital navigator, and expedition planner across 22 solar system bodies. | `ShellB-Swift` | 15,700+ IAU planetary gazetteer, orbital ephemeris, geodesic routes, offline Valhalla turn-by-turn navigation. |
| **Magpie** | `◆` | **Asset Scout & Librarian**<br>Collects, verifies, and catalogs reusable sounds, textures, sprites, models, and fonts into shared asset libraries. | `ShellB-Swift` | Web scraping, asset pack unpacking, automated metadata tagging, licensing and credits attribution. |
| **Spark** | `⚡` | **Instant Reflex**<br>Zero-deliberation instant answers for quick rewrites, code conversions, regex, and rapid lookups. | `ShellB-Swift` | Fast-path text processing with minimal latency and no chain-of-thought overhead. |

---

## 📸 Interface Showcase

<table width="100%">
  <tr>
    <td width="50%" valign="top">
      <h3 align="center">🎨 Studio with Daedalus</h3>
      <a href="screenshots/studio-daedalus.png"><img src="screenshots/studio-daedalus.png" alt="Studio with Daedalus" /></a>
      <p align="center"><i>Interactive design studio: web apps, slide decks, playable games, and Three.js 3D scenes.</i></p>
    </td>
    <td width="50%" valign="top">
      <h3 align="center">⚡ Code with Hephaestus</h3>
      <a href="screenshots/code-hephaestus.png"><img src="screenshots/code-hephaestus.png" alt="Code with Hephaestus" /></a>
      <p align="center"><i>Git-backed workspace: agent edits, sandboxed testing, diff review, and rollback commits.</i></p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3 align="center">📻 Shell:B FM · Live DJ Workstation</h3>
      <a href="screenshots/radio-workstation.png"><img src="screenshots/radio-workstation.png" alt="Radio and DJ Rig" /></a>
      <p align="center"><i>Procedural neural radio stations, dual-deck DJ rig, stem mixer, and track forge.</i></p>
    </td>
    <td width="50%" valign="top">
      <h3 align="center">🧠 Unified Memory & Models</h3>
      <a href="screenshots/models-memory.png"><img src="screenshots/models-memory.png" alt="Models and VRAM Dashboard" /></a>
      <p align="center"><i>Live hardware resource management, one-click GGUF model downloader, and VRAM eviction.</i></p>
    </td>
  </tr>
</table>

<details>
  <summary><b>☀️ Click to view Light Mode interface</b></summary>
  <br />
  <img src="screenshots/hero-light.png" alt="Shell:B Light Theme" width="100%" />
</details>

---

## 🌐 Access & Networking

**URL:** `https://<tailscale-device>.<tailnet>.ts.net:8443` (Tailscale HTTPS: needed for mic, clipboard and
notifications) or `http://localhost:8200` (LAN) · service `shellb-web` (systemd user unit, port 8200)

**HTTPS** is configured via `tailscale serve` (tailnet only, Tailscale's certificate, persists across reboots): `--https=8443` →
`http://127.0.0.1:8200`, and Studio dev-server previews `--https=8410…8417` → `http://127.0.0.1:8210…8217` (82xx is
already bound on all interfaces by the preview proxy, so HTTPS uses 84xx; `ui/src/studio/Canvas.tsx` adds 200 when the
page is HTTPS). tailscale serve sets `X-Forwarded-For`, so auth.py treats these requests as remote and they need the
owner login; cookies get the Secure flag from `X-Forwarded-Proto`. On plain http the mic button reopens the chat on
the HTTPS address (`ui/src/secureUrl.ts`). The certificate covers only the full name: `https://<device>:8443`
fails with ERR_SSL_PROTOCOL_ERROR, so `http://<device>:8200` (MagicDNS short name) redirects page loads to the HTTPS
address (`_ShortNameRedirect` in app.py). Check with `tailscale serve status`; remove with `tailscale serve --https=8443 off`.

---

## 🏛️ Architecture

```mermaid
flowchart TD
    User(["Client Browser / Tailscale Device"]) <-->|Tailscale HTTPS :8443 / Loopback :8200| Web["Shell:B Web Server\n(FastAPI / React 19 / Uvicorn)"]
    
    subgraph Local Hardware & Service Stack
        Web <-->|Streaming Tokens & Prompts| Ollama["Ollama Serving\n(Qwen3.6 / Swift / Coder)"]
        Web <-->|Isolated Execution (/work)| Sandbox["Docker Sandbox\n(--network none)"]
        Web <-->|Private Web Search| Vassago["VASSAGO\n(SearXNG :8080)"]
        Web <-->|Whisper VAD & Kokoro TTS| Hermes["HERMES Voice\n(Port :8001)"]
        Web <-->|MusicGen / AudioCraft| Orpheus["ORPHEUS Audio\n(Port :8002)"]
        Web <-->|FLUX / ComfyUI Pipelines| Nyx["NYX Visuals\n(Port :8188)"]
        Web <-->|ZIM Offline Wikipedia & Maps| Kiwix["Kiwix & Protomaps\n(Local Archives)"]
        Web <-->|FTS5 Search, Vectors, State| DB[("SQLite DB\nshellb.db + Embeddings")]
    end
```

---

## What it does

- **Agents** (edit them in the Agent Lab): Shell:B (orchestrator, Qwen3.6), Hephaestus (engineering, Qwen3-Coder-Next),
  Minerva (research and analysis), Heimdall (vision), NYX (images and music), Spark (instant answers). Each has its own
  model, prompt, tools, temperature, reasoning effort and context size.
- **Real agent loop**: streams reasoning and text from Ollama, runs tool calls in parallel, and loops until the model
  answers (`maxToolRounds` caps it). Sub-agent delegation goes through `ask_agent`.
- **Tools**: web search through VASSAGO/SearXNG; page reading via trafilatura, with local addresses blocked; a Python/Bash
  sandbox (Docker, `--network none`, with a per-conversation `/work` folder); versioned artifacts (HTML, SVG, Markdown,
  Mermaid, code); FLUX images via NYX/ComfyUI, which evicts idle models if memory is tight; MusicGen via ORPHEUS; and
  long-term memory (see **Memory** below).
- **Memory** (`server/memory.py`, `ui/src/components/MemoryManager.tsx`; Settings → Memory, the Memory app, `#/memory`):
  what Shell:B knows about the owner. Each memory has a category, origin, source chat, optional expiry and a status
  (active / pending / retired). **Always known** memories (identity, work, preference, or pinned) go into every prompt
  as a profile; the rest are recalled by similarity (qwen3-embedding, ≥ 0.5, top 6). After every interactive turn the
  utility model reads the user's message and proposes add / update / retire actions (`memoryLearning`: auto applies
  them and shows "Remembered …" with Undo under the reply; review queues them for the owner and posts to Activity;
  off). Only the user's own words count: pasted text, task instructions and the reply are ignored, and update/retire
  can only target memories the learner was shown. Corrections retire the old memory ("replaced"), so everything can be
  restored. Agents get `memory_save` (`category`, `replaces`, `expires`), `memory_forget` and `memory_search`. **Learn
  from past chats** reads earlier chats (not Studio/Code, to-dos or plan steps) and proposes memories for review.
  API: `/api/memory` (list, add, `PATCH /{id}`, `POST /{id}/{forget|restore|accept|reject|undo}`, `/accept-all`,
  `/learned/{msg}`, `/backfill`); `/api/status` reports `memoryPending`.
- **Past conversations** (`server/episodes.py`): episodic memory. An FTS5 index (`msg_fts`, kept in sync by triggers on
  `messages`) covers every message, and a background sweep has the utility model write a 1-3 sentence summary of each
  conversation once it has been quiet for a minute (`conv_summary`, with an embedding; it waits while anyone is
  chatting). Agents with memory get `recall_conversations` (`search` merges full text and summary similarity; `read`
  returns the transcript, optionally around a message id), and their prompt lists the six latest substantial
  conversations with summaries. Scouts don't get it: they read untrusted pages. The sidebar search also searches inside
  messages ("In messages", with highlighted snippets) and jumps to the matching message (`ui/src/jump.ts`).
  API: `/api/chats/search?q=`, `/api/chats/summary-status`.
- **Voice mode** (`ui/src/components/VoiceMode.tsx`; the waveform button beside the mic in the chat box, HTTPS only):
  a hands-free conversation. The mic stays open (browser echo cancellation and noise suppression); a simple energy
  VAD learns the room's noise floor, starts an utterance after 160 ms of speech and ends it after 900 ms of quiet; the
  clip goes to HERMES Whisper and is sent with `voice: true`. The server then adds `VOICE_NOTE` to the system prompt
  and `VOICE_REMINDER` to the message (the model ignored the system note alone), so the reply is a few spoken sentences.
  The reply is read aloud sentence by sentence as it streams (HERMES Kokoro, prefetched in order; `speakable()` drops
  code, tables, links and Markdown). Talking over it (a higher threshold while audio plays) stops playback and an
  unfinished reply; what you said is sent once the turn has stopped. Pause mic, Skip, Esc to end. Spoken messages
  are stored with `voice: true` and shown as "Spoken".
- **Feedback** (`server/feedback.py`, `ui/src/components/Feedback.tsx`): thumbs up/down under every finished reply.
  Thumbs down opens "What should be different?" (quick reasons plus a note); either thumb can carry a note. With
  "Remember this for next time", the utility model turns it into at most one lasting preference rule (a `preference`
  memory, origin `feedback`, so it is in every prompt from the next message on), possibly replacing an older rule. It
  learns nothing from feedback about this one answer ("wrong date") or from vague feedback (a bare "wrong tone" with no
  note), and it says so. "Try again with this feedback" sends the complaint as a follow-up. Ratings are stored in
  table `feedback` (one per message) and in the message's `feedback` data. API: `POST /api/feedback`
  (`msgId`, `rating` up|down|null, `reasons`, `note`, `remember`), `GET /api/feedback/stats?days=`.
- **Nightly reflection** (`server/reflection.py`; Memory page → "Tidy up now", "Every night at"): once a night
  (`memoryReflection`, `memoryReflectionHour`, default 3 AM local, only while nobody is chatting) Shell:B expires dated
  memories, rewords first-person ones in the third person, merges near-duplicates (cosine ≥ 0.72, model decides; pairs
  judged separate are not asked about again) and asks about facts older than 21 days that look temporary ("about to",
  plans whose dates passed) as "Forget?" items in the review queue (never re-asked within 90 days). Rewrites and merges
  keep the original date, follow `memoryLearning` (auto applies, review queues), and retire the originals, so they can
  be restored; `replaces` may list several ids. Weekly, an Activity digest lists what was learned, forgotten, tidied,
  what waits for review, and the week's thumbs with repeated complaints per agent. API: `GET /api/memory/reflection`,
  `POST /api/memory/reflection/run?digest=`.
- **Documents, pictures and OCR** (`server/doc_tools.py`): `read_document` extracts text from PDF, DOCX/DOC, XLSX/XLS,
  PPTX/PPT, ODT/ODS/ODP, RTF, EPUB, HTML and images (PyMuPDF; LibreOffice converts legacy formats), OCRing pages that
  have no text layer; `view_document` renders pages or pictures for the vision model (text-only agents get a written
  description instead); `ocr` identifies text with RapidOCR (PP-OCR on ONNX, CPU, with confidences, boxes, regions and
  en/latin/japanese/chinese/korean/cyrillic models) or `engine=vision` for tables, forms and handwriting. All three take
  `/work/…`, `/project/…` or an http(s) URL; `web_fetch` hands PDFs and images to `read_document`. Uploaded PDFs and
  Office files arrive with their text layer inlined, and Project knowledge OCRs scans and images when it indexes them.
- **Rich links** (`ui/src/components/RichLinks.tsx`): agents can hyperlink words in a reply. `[w](tip: …)` shows a
  Markdown/math tooltip; `[w](widget:#key)` plus a ```` ```widget key ```` fence pops up a live, sandboxed HTML control
  (`shellb.ask()` inside it sends a follow-up); `[w](artifact:id)` previews an artifact on hover and opens it on click;
  `[w](ask: …)` is a one-click follow-up chip; `[w](file:path)` opens a Studio file. The agents learn the syntax from
  `RICH_LINKS` in `server/agent.py`.
- **Composer shortcuts** (`server/composer.py`, `ui/src/components/ComposerShortcuts.tsx`): in any chat box, `/` at the
  start opens commands: `/new`, `/effort instant|low|think|deep`, `/agent X` (switches the chat), tool nudges (`/image`,
  `/music`, `/search`, `/fetch`, `/run`, `/artifact`, `/remember`, `/recall`, `/library` add a "use this tool" note to the
  turn), skills (`/<skill>`), and saved prompt templates, whose `{{blanks}}` you fill in by pressing Tab to jump between them
  (`{{date}}`, `{{clipboard}}`… fill in on their own). `@Agent` anywhere answers that one message as that agent (`routeOnly`;
  the chat keeps its agent; edits and regenerations re-read the mention). `#` inserts variables (`#date`, `#time`, `#now`,
  `#weekday`, `#clipboard`, `#agent`, plus saved ones; typed `#name`s expand on send) or references a chat artifact, a
  library item or a URL. A reference becomes an attachment of kind `ref`, and the server inlines it when the turn starts
  (artifact text, a listing plus a pointer to the `library` tool, or the fetched page). Saved variables and prompts live in
  kv `composer_vars`/`composer_prompts` and are managed in Settings → Shortcuts. API: `/api/composer`,
  `/api/composer/{variables,prompts}`, `/api/composer/refs?q=&conv=`.
- **Plan mode** (`server/planmode.py`): the **Plan** button in the chat box (or Shift+Tab, or `/plan`; `/plan <request>`
  plans just that one message) makes the agent research with read-only tools and reply with a `## Plan` instead of doing
  the work. This is enforced, not just asked for: write tools are left out, calls whose action writes (`library import`,
  `codex add`, `http_request POST`…) are refused, MCP tools are dropped, and sub-agents reached through `ask_agent`
  inherit the mode. The reply gets a card with **Approve and run**, which turns plan mode off and has the agent that
  wrote the plan carry it out, and **Keep planning**. It works in chats and in the Studio/Code chat. Messages carry
  `mode: "plan"` (request body `mode`), and unattended turns ignore it.
- **Library** (`#/library`, sidebar → Library, or Ctrl K): one gallery of everything Shell:B has built. It shows the latest
  version of every chat artifact across all conversations, plus every Studio project and every Code workspace that has an
  `index.html`, with live thumbnails, search, an All/Artifacts/Web apps switch and type filters (`GET /api/library`). An
  artifact opens in its chat with the panel showing, or full-window in a new tab (`#/view/<conv>/<artifact>`, still
  sandboxed). A web app launches in a new tab, or opens in Studio or Code for editing. Code is in `ui/src/components/Library.tsx`.
- **Shared library** (`server/library.py`): every agent, wherever it works (chats, Studio, Code, chat Projects, scheduled
  runs, to-dos, mega plan steps), gets the `library` tool. It reaches everything Shell:B has made: Studio designs and Code
  workspaces (files), research notebooks (sources by S#, notes, findings, outputs, original files), chat Projects
  (knowledge files), chat artifacts and generated media. Actions: `list`, `search` (titles, file names, file contents,
  plus semantic search over notebook sources), `browse`, `read` (PDF/Office text extracted), `view` (images to the vision
  model) and `import`, which copies a file or whole folder into the current project (default `assets/<name>`) or the chat's
  `/work`. It copies rather than hot-links, so designs and exports stay self-contained. Refs are `proj-…`, `rb-…`, `grp-…`,
  `conv-…/<artifact>`, `media`, or a unique title. The system prompt lists the 20 most recent items. `run_code` sees the
  same stores read-only under `/library/{projects,research,chat-projects,media}`. Cloud agents get none of this unless
  **Share the library with cloud agents** (`cloudLibrary`) is on. Turn it off for everyone with the `library` tool switch.
- **Wiki** (`#/wiki`; `server/wiki.py`, `ui/src/components/Wiki.tsx`): offline Wikipedia, Wiktionary and Wikivoyage from
  Kiwix ZIM archives in `~/shellb/wiki`, read with python-libzim. Title suggestions, full-text search and a native reader.
  The article HTML is never shown raw: only the parser output is kept, lxml_html_clean plus an attribute allowlist strip
  scripts and styles, ids get a `w-` prefix, internal links become `#/wiki/<source>/<path>`, and red links are unwrapped.
  Images come from `/api/wiki/res` (image types only, under a no-script CSP). Kiwix's tiny stub pages for redirects to a
  section are followed. Every agent gets the `wiki` tool (search / read with an optional section) once an archive is
  installed, which is read-only in plan mode. Its output names the snapshot date and gives a `[Title](#/wiki/...)` link.
- **Offline data** (`#/data`, gear menu; `server/datasets.py`, `ui/src/components/OfflineData.tsx`): the big downloaded
  files behind Worlds and Wiki, with their size, build, download date and history (state in `data/datasets.json`). The
  Earth basemap (Protomaps daily build, `~/shellb/maps/<YYYYMMDD>.pmtiles` behind the `planet.pmtiles` symlink) and the
  Kiwix archives can each be updated **off / weekly / monthly** (monthly by default). The loop checks a dataset when its
  period has passed since the last check (or the download) and queues the newer build. Downloads run one at a time in a
  thread, resume from `<file>.part` with Range requests (including after a restart), refuse to start without room for the
  file plus 10 GB, verify Protomaps' md5 or Kiwix's `.sha256`, then swap atomically and delete the old copy. Results go to
  Activity (source `data`). Installing, scheduling, cancelling and deleting need the owner. The planet mosaics and map fonts
  are built locally, so they are only measured.
- **Legal** (`server/legal.py`; tool `legal`, `/api/legal/{sources,search,read}`): offline US and EU law from a full-text index,
  `~/shellb/legal/index.db` (SQLite FTS5; one row per section, article, recital, annex chunk, tariff heading or screening-list entry).
  Sources: US Code, eCFR (EAR/CCL in 15 CFR 730-774, ITAR, OFAC, Customs), Statutes at Large, Public Laws, HTS, the trade.gov
  Consolidated Screening List, EUR-Lex legislation (the Cyber Resilience Act, NIS2, GDPR, AI Act, dual-use, customs), later the Federal
  Register and case law. The files are fetched by `~/shellb/legal/fetch_legal.py` (resumable, outside this repo) and indexed by
  `~/shellb/legal/build_index.py` (per-file, skips what is already indexed, so re-run it after a download). The tool opens the index
  read-only per call and is added to every agent once it exists (`tool_switches.legal` turns it off). Results carry the cite and the
  snapshot date; the model is told it is reference, not legal advice. `search` ranks heading > act title > text, puts an explicit
  citation first (`15 CFR 740.2`, `9 USC 2`, `HTS 8471`) and ranks non-legislative EU documents below acts; `read` takes a cite
  or a whole-act name/CELEX number (outline).
- **Downloads indicator** (`ui/src/components/Downloads.tsx`, top bar): a progress ring that appears while anything large is
  downloading (offline data and its queue, Ollama model pulls), from `downloads` in `/api/status`. While something is
  running it polls `/api/datasets/downloads` every few seconds. Click it for per-item bars, speed and time left.
- **Mimir** (built-in agent `mimir`, "Knowledge"): the reference desk. It answers factual questions from sources in this
  order: the owner's Codex/memory/past chats/Library, then the offline wiki, then the web (only for things newer than the
  snapshot). Every fact is attributed and dated against the snapshot. Other agents reach it through `ask_agent` for fact-checks.
- **Asset libraries** (`#/assets`, sidebar → Assets; `server/assets.py`, `ui/src/components/Assets.tsx`): reusable,
  editable sets of sounds, music, textures, sprites, tilesets, pictures, icons, models and fonts, shared by every chat,
  Studio design and Code workspace. Files live in `data/assets/<lib id>/` (each library also gets a `library.json`
  manifest); metadata lives in tables `asset_libs` and `assets`: title, category, tags, description, license, author,
  source URL and free-form `meta` (`frameWidth`/`frameHeight`/`fps` animates a sprite sheet's preview; `bpm`, `loop`…).
  On the page you can upload files or .zip packs (unpacked into separate assets; identical files are detected by SHA-256),
  filter by text, category, type and tag, preview (pixel-crisp sprites, audio, video, three.js models, font specimens),
  edit one asset in the side drawer or many at once (tags, category, license, copy to another library, delete), fork or
  lock a library, download it as a .zip with `library.json` and `CREDITS.md`, and copy assets into a Studio or Code
  project. The Studio/Code file pane has an **Add from an asset library** button (the shapes icon) for the same thing.
  Every agent gets the `asset_library` tool (switch: `asset_library`; cloud agents only with `cloudLibrary`): search,
  list, info, view (images to the vision model), import (copies into the project or /work, with a CREDITS.md), create,
  fork, add (files/globs from the working folder, URLs, or per-file items), update, remove, edit_library, dispatch and
  jobs. **Locked** libraries are read-only to agents, which fork them instead. `run_code` sees the libraries read-only at
  `/library/assets/<lib id>/`.
  **Asset scouts**: a scout job (Send a scout, or `asset_library action=dispatch`) runs an agent unattended in a new chat
  titled "Asset scout: <library>" with 60 tool rounds, one job at a time (it waits while someone is chatting). The
  default scout is **Magpie** (built-in agent). Scout runs get `scrape` (`server/scrape.py`), `web_search`, `web_fetch`,
  `run_code` and `view_document` whatever agent you pick. `scrape` lists a page's files and links (`browser=true` renders
  the page in headless Firefox, driven over Marionette with a throwaway profile whose proxy settings block local and
  private addresses; it can scroll and press "load more"), downloads up to 60 URLs per call (300 MB per file; local
  addresses refused on every redirect) and unpacks zip/tar packs. A job's license policy (CC0 only / open / any) goes
  into its instructions, and every asset records its license, author and source page. API: `/api/assets/libs[/{id}]`,
  `…/upload`, `…/bulk`, `…/fork`, `…/zip`, `…/to-project`, `/api/assets/items/{id}`, `/api/assets/search`,
  `/api/assets/jobs`, `/api/assets/file/{lib}/{path}`, `/api/assets/thumb/{id}`. `/api/status` shows a running job as
  `assetJob`.
- **Saved app data** (`server/appstate.py`): HTML artifacts and Studio/Code web apps run in sandboxed iframes with an
  opaque origin, where the browser's `localStorage` throws. Every such page instead loads
  `/api/appstate/boot.js?s=<scope>` first in `<head>`, a blocking script that installs a `localStorage` preloaded with the
  saved data (plus an in-memory `sessionStorage` and an async JSON `window.shellb.storage`) and sends writes back,
  batched, with a beacon on page hide. Scopes are `art:<conv>:<artifact>` (shared by all versions) and `proj:<project>`
  (shared by every page, injected by `/raw/` into page loads only, never into `?__src` or `fetch()` source reads).
  Library thumbnails load read-only (`ro=1`). The data is stored in table `app_state(scope, key, value)` (10 MB per scope)
  and deleted with its chat or project. The artifact panel's eraser button clears it. API: `GET/POST/DELETE /api/appstate?s=`.
- **Favorites** (`#/library/favorites`, the sidebar's Favorites section, or Ctrl K): one starred list across chats,
  artifacts, Studio/Code projects, chat Projects, research notebooks and mega plans. Click the ☆ on a sidebar chat, the
  chat header, the artifact panel, Library cards, Studio/Code workspace cards, and Project, notebook and plan cards and
  pages. Drag to reorder on the Favorites page. Titles resolve live, so renames show up right away, and a favorite
  whose target was deleted drops out. API: `GET/POST/DELETE /api/favorites`, `POST /api/favorites/order`; table
  `favorites(kind, ref, sub)` (`sub` = artifact id). Code: `server/favorites.py`, `ui/src/favorites.ts` (shared store),
  `ui/src/components/Favorites.tsx` (`FavoriteStar`, page).
- **Studio** (`#/studio`): a design environment in the spirit of Claude Design. Each project is a real folder of files
  (`data/projects/<id>/`, git-versioned: every agent turn, manual save, upload and restore is a commit). The
  three-pane workspace has files/history, a live canvas and the agent chat. The canvas does device sizes and fit-zoom,
  and has a CodeMirror editor plus viewers for images, fonts, PDFs and media. **Comment** mode
  (`ui/public/studio-inspector.js`) lets you click any element and say what to change; the selector and HTML go to
  the agent. **Daedalus** (Qwen3.6, vision) gets file tools (`server/studio_tools.py`: list/read/write/edit/rename/delete,
  `view_image`, `screenshot`), `generate_image` saving into `assets/generated/`, and the sandbox mounted on the
  project (`.git` read-only). Every agent works this way inside a project. `screenshot` renders the page with
  headless Firefox in viewport tiles: Firefox `--screenshot` can't scroll, so later tiles shift the page with a transform.
  The images go straight to vision models; text-only models get a written review from the vision fallback instead.
  The review lists each requirement from your latest message and checks it pass/fail. Kinds: website, deck (1920×1080
  slides), print (US Letter), mobile (390×844), dashboard, design system (tokens.css/tokens.json + living style guide),
  logo & brand (SVG marks + brand board), social graphics (platform-size frames), email (table-based, inline styles),
  motion, game (canvas game loop, `?demo` attract mode for screenshots), 3D (three.js) and blank. Export is a zip.
  three.js is vendored at `/vendor/three/` (import map: `three` → `three.module.js`, `three/addons/` → `addons/`), and
  `.glb/.gltf/.obj/.stl` files open in `/vendor/three/viewer.html?src=…` in the canvas.
  **generate_3d** (`server/tools.py`, every Studio agent gets it) is text- or image-to-3D on NYX: FLUX reference image →
  BiRefNet cut-out (`models/background_removal/birefnet.safetensors`) → Hunyuan3D-2 (`models/checkpoints/
  hunyuan3d-dit-v2.safetensors`) → GLB, with smooth normals and a material added afterwards. Takes about 2-3 minutes.
  Output is untextured geometry in `assets/models/`, plus `-ref.png` and a numpy-rendered `-preview.png` (front, 3/4
  and side views). Headless Firefox has no WebGL, so `screenshot` can't show WebGL canvases. That preview is how agents
  see their meshes.
- **Creative asset tools** (`server/studio_assets.py`; every tool saves into the Studio project, else `/api/files`):
  `generate_sprite` (FLUX on a plain backdrop → BiRefNet mask → trimmed RGBA PNG in `assets/sprites/`; `pixel_size` +
  `colors` snap it to a pixel-art grid and palette), `generate_texture` (FLUX → half-offset cross-blend so it tiles,
  plus a brightness-derived `-normal.png`, in `assets/textures/`), `generate_sfx` (engine auto/stable/audiogen.
  Stable Audio Open 1.0 runs on `shellb-stableaudio` at 127.0.0.1:8003: 44.1 kHz stereo, up to 46 s, ~17 s per take, and it
  unloads after each call. It has its own venv, `~/shellb/stableaudio/venv`, which reuses the main venv's torch and
  transformers through a .pth file. It replaces diffusers' torchsde noise sampler, which recurses forever on this build,
  with plain Gaussian noise. The fallback is AudioGen-medium on ORPHEUS
  `POST /generate/sfx`, 16 kHz mono; one-shots are trimmed and peak-normalized, `loop=true` crossfades, `variations`
  1-4, in `assets/audio/sfx|ambience/`) and `generate_voice` (Kokoro on HERMES, single line or a batch of `lines`, in
  `assets/audio/voice/`). `generate_music` now saves into the project too (`assets/audio/music/`, `loop=true`), and
  `generate_image`/`generate_sprite`/`generate_texture` take `quality=high` for FLUX.1-dev
  (`models/checkpoints/flux1-dev-fp8.safetensors`, Comfy-Org repack, ~1 min) instead of schnell. Licenses: FLUX.1-schnell
  is Apache-2.0; FLUX.1-dev, MusicGen and AudioGen weights are non-commercial licenses, which fit Shell:B's personal,
  non-commercial use. ORPHEUS also has `POST /unload`.
- **Live dev servers** (`server/devserver.py`): Studio projects with a `devserver.json` (`{"command", "port", "env"}`;
  the **Web app + back-end** kind scaffolds FastAPI + SQLite in `server/`, front-end in `public/`) get a real back-end.
  It runs in the sandbox image with `--network none` (no route to the host's unauthenticated services) and socat
  bridges `data/devservers/<pid>/app.sock` to the app's port. A proxy inside shellb-web listens on :8210-8217 (one stable
  port per project, `kv devserver_ports`), so each app has its own browser origin. The proxy needs the owner session or
  localhost, strips `shellb_session` from requests and drops `Set-Cookie`s that would overwrite it. It also proxies
  WebSockets and injects the screenshot snippet and inspector (`/__shellb/inspector.js`). Servers stop after 30 min
  idle, at most 4 run at once, and they are removed with the project. API: `GET/POST /api/projects/<pid>/dev`
  (`{action: start|stop|restart}`), `GET …/dev/logs`. Agent tools: `dev_server`, `http_request`, `screenshot(server=true)`.
  The canvas shows a Server control (live/files toggle, start/restart/stop, logs, and "Ask to fix"). auth.py now refuses
  localhost writes that carry a foreign `Origin`, so a preview page can't use localhost trust against the main app.
  The sandbox image (`sandbox/Dockerfile`) added ffmpeg, sox, fluidsynth + GM soundfont, socat, soundfile/pydub/mido/
  pretty_midi/pyloudnorm, trimesh, uvicorn/SQLModel/passlib/pyjwt, and global express/sql.js/ws/zod (`NODE_PATH`). The
  previous image is tagged `shellb-sandbox:prev`.
- **Studio kinds added**: Web app + back-end (`fullstack`), Music & audio (`music`), Illustration & comics
  (`illustration`). **Daedalus** is now the all-round creative studio (front-end, back-end, games, audio, art) with every
  generation tool. NYX gets the new asset tools too.
- **Code** (`#/code`): a coding partner in the spirit of Claude Code. A workspace is a real git repository in the same
  `data/projects/<id>/` machinery as Studio (kind `code`), so it shares the file tree, editor, history/diff/restore,
  uploads and export. Start empty, upload a `.zip`, or clone a public https repo (`POST /api/projects/clone`; the server
  clones, the sandbox stays offline). **Hephaestus** is the default partner, with an engineering prompt
  (`code_context` in `server/agent.py`): read before editing, focused `edit_file` changes, run the tests with
  `run_code`, check `project_diff` before replying, cite file:line. Extra project tools: `search_files` (regex grep),
  `find_files` (glob), `project_diff` (uncommitted changes). The **Terminal** drawer runs bash in the same sandbox
  (`POST /api/projects/<id>/exec`) and commits what it changes. The sandbox image now carries git, gcc/make/cmake,
  Node 20 + npm, TypeScript/tsx, vitest, eslint, pytest, ruff, mypy and ripgrep. File listings respect `.gitignore`.
- **Self-awareness and self-modification** (`server/selfmod.py`, tool `shellb_self`, on for Shell:B and Hephaestus):
  Shell:B can look at herself: `about` (agents, server modules, features, version, recent deploys), `status` (units,
  services, memory, what's running), `logs` (journalctl for the shellb-* units) and `source` (read, list or regex-search
  her live code; `data/`, the venv, node_modules, build output and `.git` are off limits). To change herself she works in
  the **Shell:B (self)** Code workspace (`action=workspace`; kv `self_project`), a git clone of this tree. Its sandbox
  gets the live `ui/node_modules` read-only, so `tsc` runs there. She never edits the live tree directly. From any
  chat she edits that workspace through `shellb_self` itself: `read_file`, `search_files`, `find_files`, `edit_file`,
  `write_file`, `delete_file`, `run` (bash in the workspace sandbox) and `diff` (what a deploy would ship, compared
  with live) call the project tools on the workspace and commit each change. Inside the workspace's own Code page she
  has the normal project tools.
  `action=deploy` merges the latest live code into the workspace, then runs the checks in a scratch clone:
  `py_compile`, importing `app.py` against a copy of the database and requesting a few routes, and, when ui/ changed,
  `tsc` and `vite build`. Only after the checks pass does she ask the owner. The chat shows an approval card with the
  summary, the check results and the colored diff, and only an owner session or the admin key can approve it.
  Once approved, the change is merged into the live tree as one `Self-deploy <id>` commit and the UI is rebuilt. If
  server/ changed, a transient systemd unit (`shellb-selfdeploy-<id>-deploy`, script `data/selfmod/runner.py`) waits
  until `/api/status` is idle, restarts shellb-web and health-checks it. If the server doesn't come back, the runner
  restores the previous files, rebuilds and restarts again.
  `action=rollback` (also approved by the owner) undoes a deploy. `action=history` and `GET /api/self` list deploys,
  which are kept in `data/selfmod/deploys.json`.
  **This tree is a git repository (since 2026-10-02).** Edits made outside Shell:B, by Claude Code or by hand, are
  committed automatically as "Outside edits" before each sync or deploy, so every deploy has a clean base to roll back
  to. `.gitignore` keeps `data/`, the venv, node_modules, `ui/dist` and `ui/public/vendor` out.
- **UI**: conversations are stored on the server, so they work from any device, and they survive reloads mid-reply.
  Also: a collapsible thinking/tool trace; a sandboxed artifact panel with versions; attachments (images go to the
  vision model, files to `/work`); dictation and read-aloud through HERMES; Ctrl+K palette; light/dark themes; mobile layout.

- **Scheduled** (`#/scheduled`, sidebar → Scheduled): prompts that run on their own, once at a set time or on a repeat
  (daily, chosen weekdays, monthly, every N minutes/hours, or any 5-field cron). Each run starts a new chat titled
  "<task> · <date>" with the chosen agent, optionally inside a chat Project, and the agent is told nobody is watching.
  Times are wall-clock in the task's IANA time zone, so DST doesn't shift them. Runs go one at a time; a run missed while
  the server was down fires once on startup (marked "ran late") and missed runs never pile up. Cron schedules can't fire
  more often than every 5 minutes, and at most 50 tasks can be active. Agents with the **Schedule Tasks** tool
  (`schedule_task`, on for Shell:B by default) can create, list and delete tasks from chat. Settings → `timeZone` drives
  this and the agents' clock; the UI fills it in from the browser. Code is in `server/schedules.py` and
  `ui/src/components/Scheduled.tsx`; the tables are `schedules` and `schedule_runs`.

- **Research** (`#/research`, sidebar → Research): research notebooks in the spirit of NotebookLM. A notebook has three
  panes. **Sources**: upload files (PDF, Office, text, e-books, images; scans are OCR'd), add web pages, paste text, or
  **Discover** them with a private web search. Every source is extracted, chunked and embedded (qwen3-embedding), and gets
  a *source guide* (summary plus key topics). Checkboxes choose which sources the chat and Studio use. **Chat** answers
  only from the selected sources, citing exact passages as numbered chips: hover to read the passage, click to open the
  source with it highlighted. "Save to note" keeps an answer, with its citations turned into `[S#]` source links. The
  notebook also gets an overview, a title and emoji, and suggested questions. **Studio** generates, from the selected
  sources: an **Audio Overview** (a two-host podcast; the LLM writes the script, HERMES/Kokoro voices Alex and Sam, saved as
  MP3 with a seekable transcript), a briefing doc, study guide, FAQ, timeline, report, an interactive **mind map** (click a
  topic to ask about it), **flashcards** and a scored **quiz**. Each can be customized with a focus, and the podcast with a
  length. Notes hold saved answers, your own notes, and Minerva's findings and research report.
  **Deep research** hands the question to Minerva in her own chat. Her `research_board` tool adds the pages she reads as
  sources (auto-captured fetches included), plus findings and a cited report, and `search` lets her read the notebook's
  indexed text. Agent chats link to a notebook with `[text](board:<id>)`. Deep links: `#/research/<id>/view/<output>`,
  `#/research/<id>/source/<source>`. Generation uses Minerva's model. Background work (Studio, source guides) takes one
  Ollama slot, so chat stays responsive. Running jobs show under `notebook` in `/api/status`. Files live in
  `data/research/<id>/` (originals, extracted text, audio). Code: `server/research.py` (board, items, agent tool),
  `server/notebook.py` (ingestion, retrieval, chat, Studio, audio), `ui/src/components/research/`. Tables:
  `research_boards`, `research_items`, `research_links`, `research_chunks`, `research_chat`.

- **Mega Plans** (`#/plans`, sidebar → Mega Plans): for jobs too big for one chat. Describe the goal, and an
  orchestrator agent (Shell:B by default) breaks it into sequential steps. Each step has a brief, acceptance criteria,
  the agent that does it, an optional phase label, and an optional checkpoint. You review and edit the steps on the
  board, then start the plan. From then on the plan runs by itself:
  - each step runs in **its own chat** with its worker agent. The worker sees the goal, the plan outline, and the
    handoff notes from earlier steps, and ends its reply with a `## Handoff` report;
  - the orchestrator then **reviews** the step in its own chat. It gets the brief, the criteria, the worker's report and
    the step's git diff, and can read files and run tests. It calls `mega_plan action=review` with `accept` (plus a
    handoff summary later steps rely on), `revise` (the feedback goes back to the worker, up to the plan's attempt limit)
    or `fail`;
  - the plan **pauses for you** on a checkpoint step, a failure, a step that runs out of attempts, or a review with
    no verdict. You can accept or send back a step yourself, redo, skip, edit, reorder or add steps, then resume;
  - when every step is done, the orchestrator checks the whole result and writes a final report onto the board.

  Plans are built for **long unattended jobs on one box, trading speed for quality**:
  - **Automated checks.** A step can have a `check` command (e.g. `pytest -q tests/test_x.py`), and the plan can have
    a regression check (e.g. `pytest -q`). After every attempt the plan runs these itself, in the offline sandbox, from
    the workspace root. A failure goes straight back to the worker with the output, without spending a review turn. The
    orchestrator only reviews work whose checks pass, and it can't accept a step whose checks fail (you can override).
    The planner is told to set up a test runner first and to give each step a check.
  - **Quality** (per plan). *Thorough*, the default, runs every turn at high reasoning effort and gives workers 48 tool
    rounds instead of 16, so they can iterate until the work is right. The planner prefers more, smaller steps (8-40),
    because local models do excellent work on focused steps. *Standard* uses each agent's own settings.
  - **Fresh-context reviews.** Each review, phase review and final report starts from a clean slate: the plan's state is
    in the system prompt, and the step's evidence is in the message. A 40-step plan's history never crowds out the diff.
    The orchestrator chat still shows everything.
  - **Phase reviews.** When a phase ends, the orchestrator runs the regression check, checks that the phase's steps fit
    together, and can add fix-up steps or reshape the steps ahead before the next phase starts. Each phase is reviewed once.
  - **Resilience.** A turn that errors (model crash, out of memory) is retried after 30 s and again after 2 min before
    the plan pauses. Plan turns wait while a person is chatting with any agent, so the box stays responsive. Plans pick
    up again afterwards.

  By default a plan gets a new git-versioned Code workspace that every step works in, so you can see each step's changes
  as a commit. You can also point a plan at an existing Studio/Code project, or run it with no shared workspace. The
  board has a Board (kanban) view, a Timeline view, the orchestrator's live status and an activity log. Like scheduled
  tasks, only one agent turn runs at a time. A restart pauses running plans, and you resume them from the board. Agents with the
  **Mega Plans** tool (`mega_plan`, on for Shell:B) can create plans from chat and link them with `[text](plan:<id>)`.
  The orchestrator always gets the tool in its plan chat. Code is in `server/megaplan.py` and
  `ui/src/components/MegaPlans.tsx`; the tables are `mega_plans`, `mega_steps`, `mega_events` and `mega_links`.

## Connectors, MCP servers and cloud AI

Open **Tools & Connectors** in the sidebar.
- **Connectors** are one-click presets for MCP servers. On this machine: Folder (`~/shellb/mcp/shellb_files.py`), SQL Database
  (`shellb_sql.py`, read-only, for SQLite, Postgres and MySQL), n8n workflows, Knowledge Graph and Sequential Thinking (both via npx).
  Online: GitHub and Notion. Also any custom MCP server, by URL (Streamable HTTP or SSE) or by command (stdio).
- **MCP servers** lists live connections with their status and tools. Switch individual tools on or off there. To give an agent
  a server, tick it in the Agent Lab: it shows up as a tool entry with the id `mcp:<server>`. Its tools reach the model
  as `mcp__<server>__<tool>`. Server code is in `server/mcp_hub.py`, and stdio server logs are in `data/mcp-logs/`.
- **Cloud AI** is off by default. With it on and a key set, the built-in **Claude** agent (`anthropic/claude-opus-5-5`)
  and **Gemini** agent (`gemini/gemini-3.1-pro-preview`) work. Any agent can also use a cloud model, and local agents may
  consult cloud agents through `ask_agent`. Cloud agents get no long-term memory unless you allow it.
  Provider code is in `server/providers.py`: Claude goes through the Anthropic SDK; Gemini and OpenAI use OpenAI-compatible endpoints.
- **Admin key:** connectors can launch programs and API keys cost money. So adding or editing servers, saving keys and
  changing cloud settings need the owner's login, or the key in `data/admin.key` (`cat ~/shellb/web/data/admin.key`).
  Localhost on its own doesn't count as admin.

## Login

One owner password guards the app (`server/auth.py`, `ui/src/components/AuthGate.tsx`).
- **First visit:** the login screen asks for the admin key (`cat ~/shellb/web/data/admin.key`) and a new password.
  To reset it from the shell, run `~/shellb/web/venv/bin/python ~/shellb/web/server/auth.py set-password`. That also
  signs out every session.
- **Sessions** are an HttpOnly `shellb_session` cookie (SameSite=Lax, Secure over https) that lasts 30 days from your last
  visit. They're stored hashed in the `auth_sessions` table. Settings → **Account** signs you out, changes the password
  (which signs out every other device) and lists the signed-in devices. Five wrong passwords from one IP slow further
  attempts down, with an increasing wait of up to 15 minutes.
- **Localhost is trusted.** A request from 127.0.0.1/::1 with no `X-Forwarded-For`/`Forwarded` header needs no login,
  so headless-Firefox screenshots, `shot.sh` and `curl localhost:8200/api/status` work as before. The LAN, Tailscale
  and the Vite dev server (`xfwd: true`) must log in.
- **Cookie-authenticated writes must come from the same origin.** Other apps on this host (`:80`, `:3000`, …) count as
  "same-site" to the browser, so the `Origin` header is checked as well.
- **Sandboxed frames** (artifacts, Studio canvases, Library thumbnails) have an opaque origin, and browsers don't send the
  cookie from them. So each session has a **frame key**, and `/api/k/<frameKey>/…` stands in for `/api/…`, but only for
  project pages (`projects/<id>/raw/…`), chat workspace files, `/api/files` and app state (`appstate`, `boot.js`). It
  never grants admin, and it dies with its session. A Studio page framed with the cookie gets a 302 under that prefix, so
  its relative links and assets keep working. `srcDoc` in `ArtifactPanel.tsx` loads `boot.js` through `frameApi()`.
- **Public:** the UI shell and static assets, `/api/auth/*`, `/api/_hold`, and `/api/files/<name>` (generated media with
  random names).

## Projects and skills

- **Projects** (sidebar → Projects) group chats with shared **instructions** and **knowledge files** (PDF, Word, Excel,
  PowerPoint, text, code). Knowledge under 40k characters goes into every chat's prompt; anything larger is chunked,
  embedded with the memory model and searched with `project_search`. Files are also read-only at `/project` in the sandbox.
  Chats in a project can read each other (`project_read_chat`) and save notes back (`project_save_file`). Use the
  folder icon on any chat in the sidebar to move it into or out of a project. Internally these are called "groups"
  (`server/groups.py`, `/api/chat-projects`, `conversations.group_id`) so they don't collide with Studio's design projects.
  Data lives in `data/groups/<id>/`.
- **To-dos** (on each project's page): tasks you preload for agents to run on their own. Give each a title, optional
  detailed instructions, an agent and a priority (high, normal or low; click an item's flag to change it); paste a list to
  add one per line. The list is sorted by priority and, within a priority, by the order you arrange it. **Run list** works
  through the open items in that order, one at a time, each in a new chat in the project titled "To-do #n: …", with nobody watching. The run's system prompt
  shows the whole list with earlier items' results, so later items build on earlier ones (save shared output with
  `project_save_file` or artifacts). The agent ends by calling `project_todos` with `action=finish` and a status of
  done, blocked (needs you) or failed, plus a summary; a turn that completes without reporting counts as done. A blocked or
  failed item stops the list. You can also run one item now, re-open, skip, reorder or edit items, or press Stop to abort.
  Project chats get the `project_todos` tool, so you can also say "add these to the to-do list and start it". A
  restart puts the running item back in the queue. Code is in `server/todos.py` and `ui/src/components/ProjectTodos.tsx`;
  the tables are `project_todos` and `project_todo_lists`.
- **Skills** (Tools & Connectors → Skills) use Claude's SKILL.md format: write one, upload a `.zip`/`.skill`/`.md`, or import
  the skills installed for Claude in `~/.claude`. Agents see each enabled skill's description and load it with `use_skill`.
  Bundled files are read-only at `/skills/<name>` in the sandbox. Starting a message with `/skill-name` invokes a skill
  directly. Narrow an agent's skills in the Agent Lab; the opt-in `save_skill` tool lets an agent write new skills.
  Code is in `server/skills.py` and data in `data/skills/`.

## Layout

```
server/   FastAPI: app.py (HTTP API + static UI), agent.py (loop, prompt assembly), tools.py, db.py, defaults.py
ui/       React 19 + Vite + Tailwind 3; `npm run build` → ui/dist (served by the server)
sandbox/  Dockerfile for the code sandbox image
data/     shellb.db (SQLite), files/ (generated media), workspaces/<conv>/ (sandbox /work), cells/,
          projects/<id>/ (Studio files + .git), project-meta/<id>/ (cover.jpg, shots/)
```

## Operating it

```bash
systemctl --user restart shellb-web          # after editing server/
cd ~/shellb/web/ui && npm run build           # after editing ui/ (no restart needed)
cd ~/shellb/web/ui && npm run dev             # hot-reload dev server on :5173, proxies /api to :8200
docker build -t shellb-sandbox ~/shellb/web/sandbox   # (re)build the code sandbox
journalctl --user -u shellb-web -f
```

Node is a user-local install at `~/.local/lib/nodejs` (symlinked into `~/.local/bin`).
HTML artifacts can load `/vendor/{tailwind,chart,mermaid,marked}.js`; refresh them with `npm run vendor`.

`./shot.sh 'http://localhost:8200/?shot=5000#/c/<conv>/<artifact>' out.png 1440 900` takes a headless Firefox
screenshot. `?shot` holds the page's load event so the screenshot captures a settled page, `&theme=light`
switches theme, `&peek=N` opens the Nth rich-link popover, and `&modal=agents|tools|settings|memory|system` opens a panel.

## Not done yet

- One owner account only. There are no per-user accounts or private data.
- An artifact that hard-codes `/api/workspace/<conv>/…` (rather than going through the frame-key prefix) can't load
  that file inside its sandboxed preview, because no cookie is sent from there.
- The microphone needs HTTPS (browser rule), so dictation works only through a Tailscale `https://` URL.
