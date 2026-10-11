# Contributing to Shell:B 🐚

Thank you for being here. A bug fix, a clearer paragraph in the Manual, a French string, a new agent persona, a
ComfyUI pipeline, a UI polish: each one makes Shell:B better for everyone who runs it on their own hardware.

## Where things go

| You have… | Take it to |
| :--- | :--- |
| A fix or a feature for the app itself | A pull request here (read on) |
| A theme | [Shell-B-Themes](https://github.com/EveAeternam/Shell-B-Themes): `theme.json`, validator, one-screen checklist |
| A screensaver | [Shell-B-Screensavers](https://github.com/EveAeternam/Shell-B-Screensavers): one `index.html`, no network, no audio |
| An agent persona | [Shell-B-Agents](https://github.com/EveAeternam/Shell-B-Agents): `agent.json` for the Agent Lab |
| A Studio template, a skill, a world, a voice, an app, a translation | [Shell-B-Studio-Templates](https://github.com/EveAeternam/Shell-B-Studio-Templates), [Shell-B-Skills](https://github.com/EveAeternam/Shell-B-Skills), [Shell-B-Worlds](https://github.com/EveAeternam/Shell-B-Worlds), [Shell-B-Voices](https://github.com/EveAeternam/Shell-B-Voices), [Shell-B-Apps](https://github.com/EveAeternam/Shell-B-Apps), [Shell-B-Translations](https://github.com/EveAeternam/Shell-B-Translations) |
| A question, an idea, something to show | [Discussions](https://github.com/EveAeternam/Shell-B/discussions) |
| A bug | [Issues](https://github.com/EveAeternam/Shell-B/issues/new/choose), with the form filled in |
| A security hole | [SECURITY.md](SECURITY.md), privately. Please not an issue |

## 💛 The ethos

> **For Shelby.** *This project is named in honor of and dedicated to my best friend, Shelby.*

**Your AI assistant belongs to you, not to a corporation.** Everything here is licensed under the
[AGPL-3.0](LICENSE), so nobody can wrap this community's work in a proprietary cloud service and sell it back without
returning their changes to the commons.

A large part of Shell:B was written together with AI, and a good part of that by the Shell:B models themselves: she can
read her own source, propose a change and deploy it once the owner approves. So, naturally:

- **AI-assisted contributions are welcome and celebrated.** Pair with local Shell:B models, Claude, or any other coding
  agent. We only ask that you understand what you submit, that you ran it, and that you own the pull request.
- **Hardware agnostic.** Shell:B is developed on one machine but written to run on whatever you have, from a laptop to a
  multi-GPU box. Changes that make it lighter, faster or kinder to small machines are especially welcome.
- **Local first.** A feature that needs a mandatory cloud account will be looked at sceptically. Local or open-source
  alternatives always win ties.

### Companies

Individuals, students, hobbyists and researchers: welcome from anywhere. If you contribute on behalf of a company you
must be authorised to contribute under the AGPL-3.0, and your contribution must not gatekeep or enclose features for a
proprietary fork. Vendor lock-in gets declined.

## 🛠️ Development setup

Shell:B is a **FastAPI (Python 3.12)** server, a **React 19 + TypeScript + Vite + Tailwind 3** UI that the server
serves from `ui/dist`, and a **Docker** sandbox image for code execution. Models come from **Ollama**.

```bash
git clone https://github.com/EveAeternam/Shell-B.git ~/shellb/web
cd ~/shellb/web
python3 -m venv venv && venv/bin/pip install -r requirements.txt
cd ui && npm ci && npm run vendor && cd ..     # vendor: offline copies of tailwind, chart.js, mermaid, three
docker build -t shellb-sandbox sandbox/
venv/bin/python server/serve.py                # http://127.0.0.1:8200 ; data/admin.key on first sign-in
```

For UI work, `cd ui && npm run dev` gives hot reload on `:5173` and proxies `/api` to `:8200`. For server work,
restart the process (or `systemctl --user restart shellb-web` once you run it as a service, see the Manual).

Voice (HERMES), music (ORPHEUS), images (NYX / ComfyUI), private search (SearXNG) and the offline wiki are separate
local services. Shell:B runs without them; the tools that need them report they are unavailable.

### The map

```
server/app.py        routes and the static UI          server/agent.py   the loop, prompts, tool calls
server/tools.py      tool registry and runners         server/db.py      SQLite (data/shellb.db)
server/<thing>.py    one module per subsystem          ui/src/components one file per panel or app
ui/src/api.ts        the client for /api               ui/src/i18n/      t(), fr.json
tests/               unittest, *_test.py               docs/MANUAL.md    the reference, kept current
```

[AGENTS.md](AGENTS.md) is the short architecture brief Shell:B's own agents read before touching the code. It applies
to humans too.

## ✅ Before you open a pull request

1. **Run the checks.** `scripts/check.sh` compiles every server module, runs pyflakes for undefined names, runs the
   regression suite in `tests/` and type-checks the UI. CI runs the same compile, lint and type check on every pull
   request. A pull request that fails them won't be reviewed until it passes.
2. **Shipping something a user will notice?** Add an entry at the top of `docs/changelog.json` (`date`, `area`,
   `title`, `summary`). It feeds Settings → Changelog in the app and the notes of the next release.
3. **New UI text?** Wrap it in `t('…')` and add the French line to `ui/src/i18n/fr.json`. `tests/i18n_test.py` fails on
   any English string without a translation, and it tells you which.
4. **Touching a route, a tool or a table?** Update the matching section of `docs/MANUAL.md` (or `docs/API.md` for
   `/api/v1`). The Manual is the reference, not a brochure; it should still be true after your change.
5. **Tests** live in `tests/<area>_test.py` and start with `from smoke_test import client, shellb`, which gives a
   scratch copy of the app. Fake project IDs must look real (`proj-` + 12 hex characters) or the ID checks reject
   them.

### The rules that aren't up for discussion

- **Python + FastAPI on the server, TypeScript (`.tsx`) + Tailwind in the UI.** No Node back ends, no untyped `.jsx`.
- **No telemetry, ever.** No analytics, no beacons, no "anonymous usage statistics". Shell:B never phones home.
- **Nothing private in git.** No chats, keys, tokens, addresses, screenshots with personal data. `data/` is ignored
  for a reason. Scrub your screenshots before attaching them.
- **The sandbox stays sealed.** Code execution keeps `--network none` and the dropped capabilities. Guest cells stay
  separate containers. If a feature needs a hole, it needs an approval card and a line in SECURITY.md.
- **Approvals are the owner's.** Anything that leaves the machine or changes it (pushes, emails, deploys, browser form
  submissions) waits for the owner's approval. Don't add bypasses, even convenient ones.

### Design standards

Shell:B's UI is built to the standard in [AGENTS.md](AGENTS.md#4-legendary-front-end-design-standards). The short
version: one deliberate aesthetic per surface, a typographic scale, a 60/30/10 palette with WCAG AA contrast, spacing in
multiples of 4, crisp 1 px borders, real copy, and complete loading, empty and error states. No purple-blue gradient
buttons, no glassmorphism everywhere, no lorem ipsum.

## 🔀 Branches, commits, pull requests

```bash
git checkout -b worlds/wind-legend        # <area>/<what>
```

Commit messages are one sentence in the form the log already uses: `Area: what changed, in plain words`.

```
Worlds: wind layer in the earth.nullschool style, from GFS on AWS Open Data
Backups: skip sockets, archive guest cells' data through their own uid
Languages: French for the Aphrodite settings strings
```

The pull request template asks for what changed and why, screenshots for UI changes, new dependencies, and how you
tested it on your hardware. Small, focused pull requests get merged faster than big ones.

## 🚢 Releases

Shell:B ships continuously; releases are dated snapshots for people who want something to pin.

- Tags are calendar versions: `v2026.10.11`. A second release on the same day adds `.1`.
- `scripts/release_notes.py` renders the changelog entries since the previous tag as Markdown, grouped by area. The
  `release` workflow runs it when a tag is pushed and publishes the GitHub Release with those notes.

```bash
scripts/release_notes.py                 # preview the notes for the next release
git tag v2026.10.11 && git push origin v2026.10.11
```

## 🐛 Reporting bugs

Use the [bug report form](https://github.com/EveAeternam/Shell-B/issues/new/choose). It asks for the steps, what you
expected, your hardware and model engine, and redacted logs (`journalctl --user -u shellb-web -f`). Search first; a
thumbs-up on an existing issue helps more than a duplicate.

## 💡 Suggesting features

Open a thread in [Discussions → Ideas](https://github.com/EveAeternam/Shell-B/discussions). Say what problem you are
solving, how it fits a local-first workflow, and what it costs in memory or GPU. Once an idea has a shape it becomes an
issue.

## 🤝 Conduct

Be kind, assume good faith, and remember that people arrive with very different hardware, experience and backgrounds.
The full text is in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## 📜 License

Every contribution is made under the [AGPL-3.0](LICENSE). By opening a pull request you certify that you wrote the
contribution or have the right to submit it under that license, and that you grant everyone the right to use, modify
and distribute it under the same terms.

Thank you for helping keep personal AI open, local, and truly owned by the people who use it.
