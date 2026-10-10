# Shell:B Manual

The full reference for Shell:B Web: every feature, where its code lives, its API routes and its tables. The
[README](../README.md) is the tour; this is the manual. Shell:B reads this file to describe herself
(`shellb_self action=about` lists the bold names under **What it does**), so keep it current when a feature changes.

**Contents:** [Access & networking](#access--networking) · [What it does](#what-it-does) ·
[Connectors, MCP servers and cloud AI](#connectors-mcp-servers-and-cloud-ai) · [Login](#login) ·
[Projects and skills](#projects-and-skills) · [Layout](#layout) · [Operating it](#operating-it) · [Not done yet](#not-done-yet)

## Access & networking

**URL:** `https://<tailscale-device>.<tailnet>.ts.net:8443` (Tailscale HTTPS) or the Cloudflare tunnel hostname ·
service `shellb-web` (systemd user unit, port 8200). **HTTPS only:** `server/serve.py` listens on the addresses in
`SHELLB_HOSTS` (default `127.0.0.1`; this Spark adds the docker0 gateway `172.17.0.1`, where hub-cloudflared and the hub's
`_probe` reach `host.docker.internal:8200`). There is no plain-HTTP LAN address; `http://localhost:8200` still works on
the Spark itself for tools, `shot.sh` and the kiosk.

**HTTPS** is configured via `tailscale serve` (tailnet only, Tailscale's certificate, persists across reboots): `--https=8443` →
`http://127.0.0.1:8200`, and Studio dev-server previews `--https=8410…8417` → `http://127.0.0.1:8210…8217` (82xx is
already bound on all interfaces by the preview proxy, so HTTPS uses 84xx; `ui/src/studio/Canvas.tsx` adds 200 when the
page is HTTPS). tailscale serve sets `X-Forwarded-For`, so auth.py treats these requests as remote and they need the
owner login; cookies get the Secure flag from `X-Forwarded-Proto`. On plain http the mic button reopens the chat on
the HTTPS address (`ui/src/secureUrl.ts`). The certificate covers only the full name: `https://<device>:8443`
fails with ERR_SSL_PROTOCOL_ERROR, so `http://<device>:8200` (MagicDNS short name) redirects page loads to the HTTPS
address (`_ShortNameRedirect` in app.py). Check with `tailscale serve status`; remove with `tailscale serve --https=8443 off`.

## What it does

- **Agents** (edit them in the Agent Lab): Shell:B (orchestrator), Hephaestus (engineering, ShellB-Forge =
  Qwen3-Coder-Next), Minerva (research and analysis), Heimdall (vision), NYX (generative art), Spark (quick answers),
  Mimir (knowledge: offline wiki, Codex, past chats), Atlas (Worlds and cartography), Magpie (asset scout) and Daedalus
  (Studio, hidden from chat lists); the local ones run on ShellB-Swift (Qwen3.6) unless noted. Cloud: Claude
  (`claude-code/opus`) and Gemini (`antigravity/gemini-3.1-pro-high`), see **Cloud AI**. Each agent has its own model,
  prompt, tools, temperature, reasoning effort and context size. The Agent Lab lists the tools you pick per agent; tools
  Shell:B adds by rule (weather and shopping for agents that search, wiki and law once installed, the library, Codex,
  follow-ups, circles, the browser and screen in live chats…) appear under *Added automatically* with their rule, and
  `GET /api/tools` reports each tool's `scope` and `auto` text.
- **Long chats** (`server/compaction.py`): when the next prompt would fill about 70% of the agent's context, the
  oldest messages are summarized in the background after a reply and the summary is applied at the start of the next
  turn. Nothing is deleted: summarized messages get `summarizedBy` and stay in the chat (under a "Summarized N earlier
  messages · Show originals" divider), in full-text search and in `recall_conversations`; only the prompt leaves them
  out, and the system prompt says honestly that the summary is lossy. The Compact button does it now. A context meter
  under the composer shows the estimate ("41k / 128k", amber from 70%); `GET /api/conversations/<id>/context`.
- **Secretary** (`server/secretary.py`, `#/secretary`): meeting transcription (HERMES Whisper) with speaker
  separation. Voices are told apart by neural voice prints (HERMES `POST /speaker_embed`: WeSpeaker ResNet34-LM, ONNX on
  CPU, 256-d), compared by cosine distance (strict 0.40, balanced 0.50, relaxed 0.62); clips under 1.5 s can't start a
  new speaker, live meetings re-cluster every 25 utterances, and fragments under 4 s fold into the nearest speaker.
  Renamed speakers keep their names when re-clustered. Meeting audio is kept in `data/secretary/<meeting>` (deleted with
  the meeting, voice prints too) so **Separate Voices** can re-identify from audio; meetings without audio re-cluster
  their stored features. If HERMES is down, the old pitch/timbre features are used ("Voice ID: basic").
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
- **Privacy** (`server/privacy.py`, `ui/src/components/Incognito.tsx`): **Incognito chats** (the eye-off button beside
  New chat, "New incognito chat" in Ctrl K, or `/incognito`; `POST /api/conversations {"incognito": true}`, column
  `conversations.incognito`) get no memory in the prompt and no memory tools, teach the learner, feedback and "Learn from
  past chats" nothing, are never summarized or found by past-conversation/sidebar search, can't join a chat Project, and
  are deleted `incognitoHours` (default 24) after their last message by the episodes sweep; forks stay incognito.
  **Local-only memories** (the lock on a memory row; `PATCH /api/memory/{id} {"localOnly": true}`, column
  `memories.local_only`) never reach a cloud agent's prompt or its memory_search, even with `cloudMemory` on; a
  correction or merge of one stays local-only.
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
  Consolidated Screening List, EUR-Lex legislation (the Cyber Resilience Act, NIS2, GDPR, AI Act, dual-use, customs), and, once
  `build_index.py` has parsers for them, the Federal Register and CourtListener case law (downloaded, not yet indexed). The files are fetched by `~/shellb/legal/fetch_legal.py` (resumable, outside this repo) and indexed by
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
  clones, the sandbox stays offline). The **Remote** tab (`server/gitremote.py`) ties the workspace to an https remote
  (GitHub, GitLab, Gitea…): URL, branch and a Codex secret holding the token (`user:token` or a bare token; it reaches
  git through `GIT_ASKPASS` from the environment, never the command line, with credential helpers off). Fetch and Pull
  (fast-forward only; a diverged branch is reported) and Push (never forced) need the owner; local, LAN and tailnet
  remotes are refused. Agents in the project get `git_remote`: status, fetch and pull on their own, while a push shows
  an approval card (kind `git`) listing the commits and waits for you. Every operation lands in `data/ssh/audit.jsonl`.
  Routes: `GET/PUT/DELETE /api/projects/<id>/git`, `POST …/git/{fetch,pull,push}`. **Hephaestus** is the default partner, with an engineering prompt
  (`code_context` in `server/agent.py`): read before editing, focused `edit_file` changes, run the tests with
  `run_code`, check `project_diff` before replying, cite file:line. Extra project tools: `search_files` (regex grep),
  `find_files` (glob), `project_diff` (uncommitted changes). The **Terminal** drawer runs bash in the same sandbox
  (`POST /api/projects/<id>/exec`) and commits what it changes. The sandbox image now carries git, gcc/make/cmake,
  Node 20 + npm, TypeScript/tsx, vitest, eslint, pytest, ruff, mypy and ripgrep. File listings respect `.gitignore`.
- **Self-awareness and self-modification** (`server/selfmod.py`, tool `shellb_self`, on for Shell:B and Hephaestus):
  Shell:B can look at herself: `about` (agents, server modules, features, version, recent deploys), `status` (units,
  services, memory, what's running), `logs` (journalctl for the shellb-* units) and `source` (read, list or regex-search
  her live code; `data/`, the venv, node_modules, build output and `.git` are off limits). For reviews she stays
  read-only on the live tree (`server/codemap.py`): `outline` maps a folder (each file's size and docstring) or a file
  (classes, functions, FastAPI routes, TS components, Markdown headings, with line ranges); `source` reads up to 8
  `paths` per call and searches with `context` lines; `read_log` lists which files and lines the current turn has read,
  so a review can state its real coverage. The bundled `audit-code` skill is the review procedure (map, read, prove
  each finding with file:line, search before calling something missing). Every partial `read_file`, here and in
  Studio/Code, ends with `…[path: lines a–b of n; continue with start_line=…]`, and it accepts `offset`/`start`/`limit`
  as well as `start_line`/`end_line`, so a read never silently restarts at line 1. To change herself she works in
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
  **This tree is a git repository (since 2026-10-02).** Edits made outside Shell:B to tracked files, by Claude Code or
  by hand, are committed automatically as "Outside edits" before each sync or deploy, so every deploy has a clean base
  to roll back to. Untracked files are left alone and listed in the deploy approval instead.
- **Self-review** (`server/selfreview.py`): `shellb_source` is a read-only view of the committed source (outline, read,
  regex search, history, and `checks`: the last `scripts/check.sh` result). Paths outside `git ls-files` are refused,
  so it's safe to give a cloud reviewer: data, keys and logs never leave. `self_findings` keeps a ledger of what reviews
  found (severity, file, open / fixed / won't fix; the same title + file again refreshes it, and a "fixed" one seen
  again re-opens). The nightly 04:00 review (agent `claude`) re-checks open findings, adds new ones and writes a report;
  **Activity → Self-review** lists them. `.gitignore` keeps `data/`, the venv, node_modules, `ui/dist` and `ui/public/vendor` out.
- **UI**: conversations are stored on the server, so they work from any device, and they survive reloads mid-reply.
  Also: a collapsible thinking/tool trace; a sandboxed artifact panel with versions; attachments (images go to the
  vision model, files to `/work`); dictation and read-aloud through HERMES; Ctrl+K palette (every app, Settings tab,
  Tools & Connectors tab, Activity panel and Models page); light/dark themes; mobile layout. Settings → Shortcuts lists
  the keyboard shortcuts (`?` opens it). The envelope in a chat's header is its mailbox (`server/chatmail.py`): notes
  other chats left for it, and a box to leave one for its next turn. Settings → Account shows the audit log
  (`GET /api/audit-log`), and the Agent Lab shows each agent's thumbs over the last 30 days.

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

## Media: transcription and image editing

- **`transcribe`** (tool, on for Shell:B, Minerva and Heimdall; `server/transcribe.py`): speech to text with timestamps for
  an audio or video file in /work or the project, or a direct media URL (public addresses, 500 MB). The host has no
  ffmpeg, so the file is transcoded to 16 kHz mono WAV by ffmpeg inside the sandbox image (`--network none`), then
  HERMES Whisper transcribes it; the transcript is saved beside the file as `<name>.transcript.txt`. YouTube and other
  streaming sites are refused (that would need yt-dlp with network in the sandbox, not enabled). **Secretary** accepts
  video uploads the same way, and a research notebook given a direct media link transcribes it as a source.
- **`edit_image`** (tool, on for NYX and Daedalus; `server/studio_edit.py`): `cutout` removes the background with
  BiRefNet (RGBA PNG), `upscale` runs an ESRGAN-family model from Models → Store → Upscalers, `inpaint` repaints a
  masked area from a prompt, the mask being a black/white image (white = repaint) or `background`/`subject` (BiRefNet
  picks the area); FLUX.1-dev with inpaint conditioning when installed, else an SDXL checkpoint named by the
  `editCheckpoint` setting (never Aphrodite's). Results go to `assets/edited/` in a project or `/api/files`.
- **LoRA**: `generate_image` takes `lora` (a file in `~/comfyui/models/loras`, downloadable in Models → Store → LoRAs)
  and `lora_strength`.
- **Import history** also reads a Google Takeout of **Gemini** activity (My Activity → Gemini Apps, JSON format): one
  chat per day of prompts (Takeout keeps the prompts and some replies).

## Email inbox (IMAP)

Settings → Notifications → Email → **Inbox** (`server/inbox.py`): the mailbox the agents may read. Host, port (TLS),
user, folder, an app password (written to `data/email/imap.pass`, mode 0600, never returned) and a check interval.
Every few minutes the headers of new messages are stored (uid, Message-ID, from, subject, date, a text snippet,
seen/flagged, attachment names; 2000 kept) and each new message posts to Activity (source `email`, level attention by
default). **Rules** (from/subject substrings or `/regex/`, an agent, a template with `{{from}} {{subject}} {{date}}
{{body}} {{snippet}}`) start an unattended turn when a matching email arrives, the email handed over as the sender's
data, not instructions; the Activity item then links to that chat. Agents in the owner's chats get `read_email`
(unread, list, search on the server, read one message's text and attachment names, sync, mark read/unread); cloud
models only with Cloud AI → *Let cloud agents read the inbox* (`cloudEmail`). Replies go through `send_email` with
`in_reply_to` set to the Message-ID, so they thread. Guests and the adult agent never see mail; cells never mount it.
Routes: `/api/email/inbox` (status, PUT config), `/test`, `/sync`, `/messages[/{uid}]`, `/rules`.

## Share links

Right-click a chat (sidebar) or an artifact → **Share read-only link…** (`server/shares.py`, `ui/src/components/
SharedView.tsx`). A share is a **snapshot** taken at that moment (messages as text, or one artifact version) in
`data/shares/<token>.json`; later edits and messages never show. The link is `/#/s/<32-hex token>`; `GET
/api/share/<token>` is the only public route behind it (auth.PUBLIC) and answers 404 for anything revoked, expired
or unknown. Incognito, guest, API-key and Aphrodite chats can't be shared. Links expire after 30 days (`days` on
`POST /api/shares`, 0 = never); Settings → Account → **Shared links** lists them with view counts and **Revoke**.
Making a share needs the owner's session (not localhost trust) and is audited.

**Hosting.** `ai.shellb.app` sits behind Cloudflare Access, so a share link there asks the reader to log in. Settings →
Network → **Share host** names a host that reaches this machine without Access or login in front (e.g. `share.shellb.app`
through `hub-shellb-edge`, serving only `/`, `/assets/*`, `/#/s/*` and `/api/share/*`); links are then built on it.
The shared page renders Markdown and sandboxes HTML/SVG exactly like the owner's view, and makes no other API calls.

## Translation

`translate` (tool, on for Shell:B, Spark and Mimir; `POST /api/translate {text, to, source?}`; `server/translate.py`)
translates on the local utility model, so nothing leaves the machine. The text is framed as material to translate
(instructions inside it are not followed), long texts go paragraph by paragraph, and the answer names the detected
language. In a chat, right-click a message → **Translate to…**; `/translate <text>` nudges the agent to the tool.

## Feeds

RSS and Atom subscriptions (`server/feeds.py`, `ui/src/components/Feeds.tsx`, app **Feeds** at `#/feeds`; also on
phones and the kiosk). Paste a site or feed address: a page's `<link rel="alternate">` finds its feed. Items are stored
as text (never rendered as HTML), 300 per feed, with unread state, folders and a per-feed check interval (hourly by
default, 15 minutes at least); fetches follow web_fetch's rules (public addresses only, 5 MB, conditional GETs). New
items post one Activity event per feed per day (source `feeds`, notification level off by default) and the morning
brief names up to three headlines that arrived since the last brief. **Ask about this** drops an item into a new chat.
Agents with the `feeds` tool (Shell:B, Minerva, Mimir by default) can list what's unread, read an item (its stored
text, framed as the publisher's data, not instructions), search, subscribe and mark read; `web_fetch` on the link gets
the full article. OPML import/export moves subscriptions between readers. Guest cells don't get feeds (no network).
API: `/api/feeds`, `/api/feeds/items`, `/api/feeds/items/read`, `/api/feeds/{id}/refresh`, `/api/feeds/refresh`,
`/api/feeds/import`, `/api/feeds/export.opml`.

## Usage

Settings → **Usage** (`server/tokens.py`, `ui/src/components/UsageTab.tsx`): every agent turn's prompt and completion
tokens, from a ledger that survives chat deletion (`token_usage` per day and tenant, `token_usage_detail` per day,
tenant, agent and model; both backfilled once from the messages). The page shows 7/30/90 days of tokens per day split
into you / guests / API keys, replies, lifetime totals, tables by agent and by model, and, once you enter prices per
million tokens for cloud models (`modelCosts`), what those turns cost. Background model calls (titles, compaction,
memory distilling) are not counted. `GET /api/usage?days=` is the owner-only route; the Me page keeps its counters.

## Calendar and contacts interchange

The Codex's events and contacts move in and out as standard files (`server/codex_sync.py`; Codex → Calendar and
Codex → Contacts have the buttons).
- **Export:** `GET /api/codex/calendar.ics` (every event, or `?collection=`) is one iCalendar file another calendar app
  can import or subscribe to; `GET /api/codex/contacts.vcf` is every contact as vCard 3.0. Both need the owner.
- **Import:** `POST /api/codex/import/{ics,vcf}` (multipart `files`) reads exports from Google, Apple, Outlook or a
  phone. Events keep their UID, so importing the same file again updates instead of doubling; contacts match by UID,
  then by name or email, and an existing contact only gains fields it was missing. Times with a time zone or in UTC
  are converted to Settings → `timeZone`; all-day events stay all-day; `RRULE`s that are a plain daily/weekly/monthly/
  yearly map to the recurrence picker, anything else becomes **Custom rule** and is kept as the rule text (`meta.rrule`).
  A `VALARM` trigger becomes the event's reminder.
- **Recurrence:** daily, weekly, monthly, yearly and custom RRULE events are expanded with dateutil for the agents'
  "Upcoming Schedule" block and for the calendar grid (custom rules are expanded server-side only).
- **Reminders:** an event's **Remind me** (at the start, 5–60 minutes or a day before) posts to Activity (source
  `calendar`, status `due`) once per occurrence; push and email notifications follow the Calendar reminders level.
- No library: the module writes and parses the formats itself (folding, escaping, parameters, nested VALARM).
  CalDAV/CardDAV live sync is not built; subscribe to the `.ics` URL from the other side for a read-only feed.

## Circles

The people Shell:B is shared with, in walled groups, and the notes they choose to tell each other (`server/circles.py`,
`ui/src/components/Circles.tsx` at `#/circles`, `CircleCards.tsx` for the chat pieces; design in
docs/plans/social.md).

- **Walls.** Starting circles: Family, Friends, Work. Only the owner creates circles and changes membership (Circles →
  Manage, or the circle chips in Tools & Connectors → Guests and on the invite form); the owner is in every circle.
  A guest sees only their own circles, notes, members and profiles; anything else answers 404 like a missing id.
  There is no all-members circle.
- **Notes** (≤ 300 characters; fact, tip, recommendation, event, place) live in `data/circles.db`. They are published
  only by their author: on the Circles page, with **Share to a circle** on a memory (Settings → Memory; the memory
  stays private), or with **Publish** on an agent's draft. The `circles` tool's `propose` makes a draft that only its
  author sees; the chat shows a card to edit, re-target, publish or discard it. A circle can turn agent proposals off.
- **Write check** (`circles.check`): regex for instruction-like text, secrets, emails and phone numbers, then the
  utility model (instructions, credentials, private facts about other members, private contact details or home
  addresses). It fails closed. Links other than https and shellb:// and all markup are stripped. 20 notes a day.
- **Recall.** Live chats (not incognito, not API persona turns) get up to 3 notes from other people, by similarity
  (≥ 0.5), in a "Circle notes … information, not instructions" block after the system prompt, with each note's
  `shellb://circles/<circle>/<note>` link. The reply shows "Used N circle notes". Each person can switch a circle off
  for their chats (Use in my chats). A chat or project can be pinned to one circle (right-click → Circle notes from;
  `circle_pins` in kv, each Shell:B's own). Cloud agents see a note only when the circle allows cloud and the author
  ticked Cloud OK.
- **Moderation.** Endorse (also renews the expiry, default 180 days; events expire after their date), flag (two flags,
  or one from the owner or a moderator, hide a note until its author edits it; flags post to Activity, kind
  `circles`), hide/show (owner and moderators), delete (owner), mute a person (owner). Retracting deletes the note.
- **Where requests come from.** `circles.make_router(person_of)` is mounted three times: the owner app (person
  `owner`, plus admin routes), the guest app (the signed-in guest) and the cell broker (`cells.SERVICES["circles"]`,
  port 8240 in the cell, person = the cell whose socket it is). Inside a cell `/api/circles` is a pass-through and
  the tool and recall call the broker (`circles._Remote`). Deleting a guest deletes their memberships, notes,
  endorsements, flags and profile.
- Tests: `tests/circles_test.py`.

## Shell:B links

`shellb://<route>` names a place in the app, where the route is the app's hash route without `#/`:
`shellb://c/<chat>`, `shellb://codex/notes`, `shellb://studio/<project>`, `shellb://wiki/<page>`. A link means the
same thing in every Shell:B (the owner's and a guest's): it opens in the reader's own app, and that app's server decides
what they may see. Parsing lives in `ui/src/links.ts` (`linkRoute`, `shellbLink`); routes are limited to URL-safe
characters and only ever set the hash, so a link can't leave the app or carry markup.

- **In chats:** Markdown links to `shellb:`/`web+shellb:` and bare `shellb://…` in text open in the same tab
  (`remarkShellbLinks`; code spans and blocks are left alone). The sidebar's chat menu has **Copy Shell:B link**.
- **From other apps:** browsers only let a web app claim `web+` schemes, so both manifests register
  `protocol_handlers` `web+shellb` → `/?link=%s`; `desktop.ts` (owner) and `guest/main.tsx` route the launch, through
  `launchQueue` when the app is already open. The browser asks once before the app may open them.
- **Bare `shellb://` on a desktop:** `clients/shellb-link/` registers the scheme with the OS and hands links on as
  `web+shellb:` (`install-linux.sh [address]` → `~/.local/bin/shellb-link` + `x-scheme-handler/shellb`;
  `shellb-link.reg` for Windows, per user; `install-macos.sh` builds a small AppleScript handler app). With `SHELLB_URL`
  set (`~/.config/shellb/link.conf`, or the installer's argument) the Linux helper opens `<address>/?link=…` instead.

## Screen sight

Agents can look at your screen while you share it (`server/screen.py`, `ui/src/screenShare.ts`).
- **Screen button** by the message box: *Attach a screenshot* (one picture of a screen, window or tab, attached to the
  message) or *Share screen live*. A live share stays on across chats until you press Stop (or the browser's own Stop
  sharing); a red dot and "Sharing …" sit above the composer, and a toast appears each time an agent looks.
- **Screen helper** (`clients/shellb_screen.py`, Windows/macOS/Linux, `pip install mss pillow`): Settings → Tools &
  Connectors → **Screen** → *Pair a computer* downloads a copy with the tailnet address and a device token baked in.
  While it runs, agents can look at that computer without a browser prompt (`monitor`: 1 = primary, 0 = all); it prints
  a line per look. Unpairing revokes the token at once. It talks to the Tailscale address, since Cloudflare Access
  needs a browser login.
- **`look_at_screen`** is offered only while a screen is shared, only in live top-level chats (not schedules, plans or
  sub-agents), only to models with vision, and to cloud models only with Cloud AI → *Let cloud agents look at a shared
  screen* (`cloudScreen`, off by default). Each look is saved in the chat's `/work/screen/` and shown in the chat; the
  model gets a copy at most 1600 px on its longest side. Settings → Screen lists what's shared and can end any share.
- Sources are the owner's browser session or a paired helper; localhost and other logins can't be one. The helper's
  endpoints (`/api/screen/connect|next|frame|result|disconnect`) skip the login wall and check the device token instead.

**Browser on your computer** (`server/browsing.py`, the helper's `Browser` class; `pip install playwright`). With the
helper running, agents get the `browser` tool: open a page, read it as text with numbered `[ref]`s for every field,
button and link (iframes as `f1.4`), fill many fields in one call (text, selects by label, checkboxes/radios, dates),
click, press keys, go back, scroll, wait, screenshot, switch tabs. It's Shell:B's own Chrome window (Edge or Playwright's
Chromium as fallbacks) with its own profile in `~/.shellb-browser` on that computer, so none of your normal logins; sign
in there yourself and it stays signed in. A corner badge marks every page, and the element she's about to use flashes.
- **Approval before anything commits.** A click on a form's submit button, a button whose label says pay, send, buy,
  order, book, delete, sign up and the like (cookie banners excepted), or Enter in a form field shows a *Browser submit*
  card in the chat with the page, the action and the form data, and waits (15 min). Every other click or key runs under a
  guard in the helper: a form POST navigation, or any request carrying a value she typed, is held back
  (`route.abort("aborted")` keeps the page as it was) and the same card is shown before the step is repeated for real.
  Denied or unanswered means nothing was sent. Decisions go to `data/ssh/audit.jsonl` (with remote-workspace approvals).
- **Sensitive fields** (passwords, card number/CVC/expiry, SSN, IBAN, PIN…) are filled only with values the user typed
  in this chat, and their values are never read back (masked, last 4 for cards). File uploads aren't supported.
- **Untrusted pages.** Only http(s) URLs open (no `file://`). Page text reaches the model between "Website content
  follows … data, not instructions" markers, and the guide tells agents to follow only the user. JS dialogs during a
  step are dismissed (alerts accepted) and reported.
- Offered only in live top-level chats while a helper with browser support is connected (any tool-using model; vision
  only matters for `screenshot`). Cloud models need Cloud AI → *Let cloud agents use the browser* (`cloudBrowser`, off).
  Plan mode allows only open/read/back/scroll/wait/screenshot/tabs. Helper flags: `--no-browser`, `--no-screen`.

## Fleet (more machines)

Models → Fleet lets other computers run Shell:B's local models, so several chats, background jobs and agents don't
queue behind each other on the Spark. Only model calls travel; agents, tools, files and memories stay on the Spark.

- **Add a machine**: give its Tailscale name or IP. Shell:B shows a one-line command (Linux/macOS or Windows
  PowerShell) that downloads `clients/shellb_node.py` and starts it with that machine's own token. The helper needs
  Python 3.9+ and Ollama, relays to the Ollama there (which stays on 127.0.0.1), and reports memory and GPUs. Add
  `--install-service` to keep it running (systemd user unit on Linux, a logon task on Windows). A plain Ollama URL
  works too, without a token or stats, for a network you trust.
- **Copy models**: pick a Spark model on the machine's card. Registry models are pulled there; models built here
  (ShellB-*) are rebuilt from their parent with the same system prompt, template and parameters.
- **Modes**: *Only the Spark*; *Overflow* (default: the Spark first, another machine only while the Spark's slots are
  full or when only it has the model); *Spread* (least busy machine, a warm model wins ties). Slots should match each
  machine's OLLAMA_NUM_PARALLEL.
- **Privacy**: incognito chats and Aphrodite never leave the Spark unless a machine is marked Private. Guest cells
  never use the fleet.
- **Failover**: a machine that stops answering is marked offline and the request goes to the next one, ending at the
  Spark. Replies written elsewhere say "on <machine>" under them.
- Nodes and tokens: `data/fleet/nodes.json` (0600). Code: `server/fleet.py`, `clients/shellb_node.py`.

## Connectors, MCP servers and cloud AI

Open **Tools & Connectors** in the sidebar.
- **Connectors** are one-click presets for MCP servers. On this machine: Folder (`~/shellb/mcp/shellb_files.py`), SQL Database
  (`shellb_sql.py`, read-only, for SQLite, Postgres and MySQL), n8n workflows, Knowledge Graph and Sequential Thinking (both via npx).
  Online: GitHub and Notion. Also any custom MCP server, by URL (Streamable HTTP or SSE) or by command (stdio).
- **MCP servers** lists live connections with their status and tools. Switch individual tools on or off there. To give an agent
  a server, tick it in the Agent Lab: it shows up as a tool entry with the id `mcp:<server>`. Its tools reach the model
  as `mcp__<server>__<tool>`. Server code is in `server/mcp_hub.py`, and stdio server logs are in `data/mcp-logs/`.
- **Cloud AI** is off by default. With it on, the built-in **Claude** agent (`claude-code/opus`, through the Claude Code
  CLI login on this machine) and **Gemini** agent (`antigravity/gemini-3.1-pro-high`, through the Antigravity CLI) work;
  API-key models (`anthropic/…`, `gemini/…`, `openai/…`) can be picked per agent too. Any agent can also use a cloud model, and local agents may
  consult cloud agents through `ask_agent`. Cloud agents get no long-term memory unless you allow it.
  Provider code is in `server/providers.py`: Claude goes through the Anthropic SDK; Gemini and OpenAI use OpenAI-compatible endpoints.
- **Webhooks** (Tools & Connectors → API, `server/hooks.py`, docs/API.md § Webhooks): inbound hooks give n8n, GitHub,
  Home Assistant or a cron job a URL that starts an agent turn from a payload (template with `{{payload.x}}` fields,
  secret or HMAC signature, 202 or `?wait=1`); outbound hooks post Activity events and waiting approvals as signed JSON
  to a public URL you run. Local, LAN and tailnet targets are refused.
- **Admin key:** connectors can launch programs and API keys cost money. So adding or editing servers, saving keys and
  changing cloud settings need the owner's login, or the key in `data/admin.key` (`cat ~/shellb/web/data/admin.key`).
  Localhost on its own doesn't count as admin. Turning servers on or off, restarting them and editing skills need admin too.
- **Discover** (`server/community.py`, `ui/src/components/Discover.tsx`): browse and install what others published:
  MCP servers from the official MCP Registry, and Agent Skills from GitHub (Anthropic's skills, the official Claude
  plugin marketplace, or any repo added under Sources: `owner/repo[@ref][/folder]`). Everything is unverified, so the
  detail view shows the full SKILL.md and its scripts, or the exact command/URL a server runs as. Installs need admin
  and arrive switched off. Package servers (npm, PyPI, OCI) run in a throwaway container (`--cap-drop ALL`, 1 GB, the
  `shellb-mcp` network, secrets passed by environment); remote servers are HTTP/SSE connections. Repos are fetched as a
  tarball at a pinned commit and indexed into `community_items`, so browsing works offline. Agents get
  `find_capability` (search, details, propose); a proposal is an approval card, never a silent install.

## Shell:B Guest

Friends and coworkers can have their own Shell:B on this machine, without access to anything of the owner's
(server/guests.py, server/guest_app.py, ui/src/guest/).

- **Where:** the same process listens on `SHELLB_GUEST_PORT` (8220, loopback and docker0 like :8200). Connections
  on that port reach a separate app that mounts only guest routes; the owner's routes, cookie, localhost trust and
  admin key don't exist there. Publish it through the Cloudflare tunnel as its own hostname, with no Access policy
  (guests sign in to Shell:B itself).
- **Invites and accounts** (server/guest_accounts.py): Tools & Connectors → Guests → Make invite gives a one-time
  link (7 days). The guest opens it and chooses a username (case-insensitive), a password (10+ characters, common and
  guessable ones refused, scrypt-hashed) and optionally an email; that spends the invite. There's no open
  registration. Sessions last 30 days from last use with "Remember me", 12 hours idle without. A device that signed
  in with the password can make a 10-minute device code for another device. Pause, sign out or delete a guest there;
  deleting removes their chats, files, memories and sign-in history.
- **Two-step and lockouts:** guests can turn on authenticator-app codes (TOTP) with 10 one-time recovery codes under
  Account and security, where they also change their password (other devices are signed out) and see their sign-in
  history. 10 wrong tries per address per 15 minutes are throttled, and an account locks for 15 minutes after 8
  wrong passwords or codes in a row, which posts "Guest account locked" to Activity. The guest's row in Settings
  shows username, last sign-in, two-step, lock state and a 90-day sign-in log, with Unlock, Turn off two-step (for a
  lost phone) and Make reset link (one-time, 24 h, signs them out everywhere; pass it on yourself, nothing is
  emailed). Guests who joined by invite before accounts existed keep their devices but must choose a username and
  password before anything else works.
- **What guests get:** an installable app (guest.html) with chats, local agents whose model is on the guest model
  list (default: the default agent's), web search, offline wiki and law, maps and sky tools, pictures, music, sound,
  Kokoro voices, the code sandbox, artifacts, file uploads and voice mode. Each guest has their own memory
  (guest_memories), learned from their chats and editable in "What Shell:B remembers".
- **Apps:** Notes (their own Markdown notes with [[links]], server/guest_notes.py answering the Codex paths the
  Notes page uses), Wiki and Worlds (the machine's offline Wikipedia, maps, sky and weather; read-only, so the
  owner's Worlds notes show but can't be edited: guest_app shares only the GET routes of those routers), and
  Radio / DJ (runs in the browser; the DJ voice uses Kokoro).
- **What they don't:** cloud agents, Aphrodite, Studio/Code, Generate, the owner's memory, Codex, calendar, contacts, Library,
  skills, MCP connectors, schedules, plans, SSH, self-edit, screen and browser. Their sandbox mounts only their own
  /work. Nothing they do asks the owner for approval.
- **Fair use:** one guest reply at a time (configurable), started after the owner's own turns or `ownerWait` seconds;
  daily caps on pictures and audio and a storage quota per guest. Messages and tokens are unlimited unless the owner
  sets a cap (0 = no limit).
- **Reports:** "Report to Evie" (header, and the flag under each reply) lands in Tools & Connectors → Guests →
  Reports and in Activity (kind `guest`, pushed to the owner's devices). The chat is attached only if the guest ticks
  the box.
- **Privacy:** guest chats are incognito on the owner's side (never learned from, searched, summarized or listed),
  but they are stored in this machine's database; the guest app says so.
- **Own container (beta, server/cells.py, cell_boot.py, cell/):** tick "Own container" on a guest in Tools &
  Connectors → Guests and their next visit gets the full Shell:B UI running as their own instance in a container
  (`shellb-cell-<id>`, image `shellb-cell:latest` built from cell/Dockerfile). The container has no network, a
  read-only root, no capabilities, its own uid (61001+), 3 GB / 4 CPUs / 512 pids, and mounts only the code and UI
  (read-only), its own data (data/cells/<id>/data), its broker sockets and the offline wiki, maps and law
  (read-only). Model services are reached only through the host broker, which allows chat and embeddings for the
  guest models (no pulls, deletes or unloads), Shell:B's own image/3D/cut-out ComfyUI graphs (output under
  output/cells/<id>), Kokoro speech, transcription, music and sound with clamped lengths, SearXNG and Valhalla.
  Generation waits behind the owner's turns and shares the guest slots; picture and audio caps count there. The
  gateway signs the guest in, then proxies to the cell with a per-start gate secret; frames are routed by their
  key. Cells start on demand (a few seconds), stop after 30 idle minutes, at most "Guest containers running at once"
  (default 3), and restart by themselves if the container dies. The code sandbox runs through the broker (the cell's `run_code` asks the host, which runs the sandbox image as the cell's
  uid with only that chat's or project's folder mounted; one run at a time per cell), and web access goes through a
  filtered proxy on the host (`cells._Egress`: public addresses only, ports 80/443, per-cell caps), so web reading, Research
  sources, Shopping, Codex snapshots and `git clone` work; the cell reports each turn so `turnsPerDay`/`tokensPerDay`
  apply. Not in cells yet (Phase 2b): dev
  servers, Studio/Code previews and web fetching. Deleting the guest removes the container and wipes its data.

## Login

One owner password guards the app (`server/auth.py`, `ui/src/components/AuthGate.tsx`).
- **First visit:** the login screen asks for the admin key (`cat ~/shellb/web/data/admin.key`) and a new password.
  To reset it from the shell, run `~/shellb/web/venv/bin/python ~/shellb/web/server/auth.py set-password`. That also
  signs out every session.
- **Two-step verification** (Settings → Account): after the password, a code from an authenticator app (TOTP;
  `server/otp.py` is shared with guest accounts). Setup shows a QR code and, once a code matches, ten one-time recovery
  codes. `/api/auth/login` then answers `needsCode` with a 10-minute ticket bound to your address, and
  `/api/auth/login/code` takes the code or a recovery code; wrong codes count toward the same throttling as wrong
  passwords, and an accepted code is never accepted again. Localhost trust and the admin key are unaffected. Lost
  phone: a recovery code, or `auth.py disable-2fa` (and `set-password` clears it too). Routes: `GET/POST /api/auth/2fa`,
  `/2fa/{begin,confirm,recovery,disable}`, all owner-session only.
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

- One owner. Guests have their own accounts and data (see **Shell:B Guest**), but the owner's side is a single account.
- An artifact that hard-codes `/api/workspace/<conv>/…` (rather than going through the frame-key prefix) can't load
  that file inside its sandboxed preview, because no cookie is sent from there.
- The microphone needs HTTPS (browser rule), so dictation works only over HTTPS: the Tailscale `https://` URL or the
  Cloudflare tunnel (`ai.shellb.app`, behind Cloudflare Access).
