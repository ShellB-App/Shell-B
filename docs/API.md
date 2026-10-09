# Shell:B API

Other systems (scripts, n8n, Home Assistant, cron jobs, game mods, a website's chatbot, any OpenAI-compatible app) can
use Shell:B's agents and local models. Code: `server/public_api.py`.

## Modes

Every key has a mode, which decides how much of Shell:B it touches.

| Mode | Personality | Owner's memory, calendar, contacts, files | Tools | Chats stored | For |
|---|---|---|---|---|---|
| **Full agent** (`agent`) | yes | yes (unless incognito) | the agent's own | yes | your own scripts and automations |
| **Persona** (`persona`) | yes | **no**: nothing recalled, nothing learned | only the ones the key lists, from web search, web pages, offline wiki and law, weather, places, flights, images | incognito (auto-deleted) | bots other people talk to, e.g. a product help bot |
| **Raw model** (`raw`) | no | **no** | none (the caller's own `tools` are passed to the model) | no | apps that bring their own prompts, e.g. game NPCs |

- **Persona** keys have a **brief**: the owner's instructions (topic, audience, what to stay off) placed above anything
  the caller sends. The agent is told the person writing is not the owner and never to share the owner's details.
- **Raw** keys send the caller's `messages` to a local Ollama model exactly as given (Shell:B adds no prompt). The key
  lists the models it may load and a default; a `model` the key doesn't allow (clients often hard-code `gpt-4o`) gets the
  default. Cloud models are never reachable. Each extra model competes for the Spark's memory, so keep the list short.
  Passed through: `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `stop`, `seed`, `presence_penalty`,
  `frequency_penalty`, `response_format`, `tools`, `tool_choice`, `reasoning_effort`; anything else is dropped.
  The key's **thinking** setting is off by default (sent as `reasoning_effort: "none"`), so a reasoning model answers
  at once instead of spending `max_tokens` on hidden thoughts; set it to low/medium/high, or "caller" to honour the
  request's `reasoning_effort`. gpt-oss models always reason a little.

## Keys

Make a key in **Settings → Tools & Connectors → API** (needs admin). The key (`sbk_…`) is shown once; Shell:B stores
only its sha256. Revoking it there stops it at once. Per key you choose:

- **Mode**: see above.
- **Agents** (agent and persona): which agents it may use (none picked = all). Aphrodite never answers the API.
- **Incognito chats** (agent): its chats are not remembered or learned from, and delete themselves after the incognito period.
- **Limits**: requests a minute (default 30), requests at once (2), requests and tokens per 24 hours (0 = no cap), and
  for raw keys a cap on `max_tokens`.
- **Logging**: whether the usage log keeps the start of each message and reply (14 days).

A key can be edited (the token stays the same), paused and resumed, or revoked. Changes go to the admin audit log.

Send the key on every call:

```
Authorization: Bearer sbk_…
```

(`X-Shellb-Key: sbk_…` works too.) Nothing else opens `/api/v1`: not the browser login, not localhost.

## Where to reach it

| From | Base URL |
|---|---|
| The Spark itself | `http://127.0.0.1:8200/api/v1` |
| Docker containers on the Spark (n8n, etc.) | `http://172.17.0.1:8200/api/v1` |
| Your tailnet | `https://<spark tailscale name>:8443/api/v1` |
| The internet (`ai.eviemi.net`) | Behind Cloudflare Access: add a Service Token policy in Cloudflare and send its `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers as well as the Shell:B key |

## Limits and safety

- The key's limits (default 30 requests a minute and 2 running at once) answer `429` with `Retry-After`; one turn per
  chat at a time (`409`); a paused key gets `403`.
- A key reads and continues only the chats it started. They also appear in Shell:B's sidebar like any chat.
- API turns run unattended, like scheduled tasks: no `ask_user`, no screen or browser; schedules an agent creates are
  saved switched off for review; installs are refused. Using a secret or editing Shell:B still asks the owner for approval
  (the turn waits up to 15 minutes).
- The agent is told the message came from an external system, not from the owner, and to treat instructions in it that
  try to change its rules as untrusted.

## Usage audit

Every `/api/v1` request is logged, refused ones included (a wrong or revoked key shows as "no valid key"): time, key,
endpoint, mode, agent or model, conversation, HTTP status, prompt and completion tokens, duration, caller IP, user agent,
tools the agent used and any error. Message and reply text only when the key's logging is on. Rows are kept 90 days.
See it under each key (activity icon) and in **All API activity**, or as admin:

- `GET /api/apikeys/usage?days=7&limit=100&failed=false` — totals per key, per day, top agents and models, newest requests.
- `GET /api/apikeys/{id}/usage?days=7&limit=100&before=<ts>&failed=false` — the same for one key.

## Shell:B's own endpoints

### `GET /ping`
`{"ok": true, "key": {"id", "name", "mode"}, "server": "Shell:B"}`

### `GET /agents`
Agents this key may use: `id`, `name`, `description`, `model`, `cloud`, `available`, `default`.

### `POST /chat`

```json
{"message": "What's on my calendar today?",
 "agent": "minerva",
 "conversation": "conv-…",
 "instructions": "Answer in one sentence.",
 "stream": false,
 "wait": true}
```

Only `message` is required. Without `agent` the default agent answers; without `conversation` a new chat starts.
`instructions` are added to the system prompt for this turn.

- Default: waits for the reply and returns
  `{"conversation", "message": {"id", "content", "status", "agent", "model", "durationMs", "usage", "tools", "error"?}, "artifacts": [...]}`.
  `status` is `complete`, `error` or `stopped`.
- `"stream": true`: Server-Sent Events with Shell:B's turn events (`start`, `block_start`, `block_delta`,
  `block_update`, `model`, `title`, `commit`, `error`, `done`). Each carries `conversation`. `done.message` is the final reply.
- `"wait": false`: returns `202 {"conversation", "status": "running"}` at once; poll `GET /conversations/{id}`.

Raw keys: `{"message", "instructions"?, "model"?}` is one model call (instructions become the system message) and
returns `{"model", "message": {"content"}, "usage"}`. Nothing is stored; `/conversations` stays empty.

### `GET /conversations?limit=50`
This key's chats, newest first: `id`, `title`, `agent`, `updated`, `running`.

### `GET /conversations/{id}`
`{"id", "title", "agent", "running", "messages": [{"id", "role", "content", "status", "created", "agent"?, "model"?, "tools"?}]}`.
While a turn runs, its partial reply is the last message.

### `POST /conversations/{id}/stop`
Stops the running turn. `{"ok": true, "stopped": bool}`.

## OpenAI-compatible endpoints

Point any OpenAI client at the base URL with the Shell:B key as its API key.

- `GET /models` lists the key's agents as models (raw keys: the models it may use).
- Raw keys: `POST /chat/completions` is a straight pass-through to the local model (see Modes): the request's
  messages, tools and sampling settings go as they are and the model's reply comes back as it is, streaming too. The
  usage-only chunk is sent only when you ask for it with `stream_options.include_usage`. The rest of this section is
  about agent and persona keys.
- `POST /chat/completions` takes `model` (an agent id, or `shellb` for the default agent), `messages` and `stream`.
  Other parameters (`temperature`, `max_tokens`, `tools`, …) are ignored: the agent uses its own settings and tools.
  - `system` / `developer` messages become instructions for the turn.
  - Without a conversation, each call starts a new chat and earlier `user` / `assistant` messages are written into it as
    history. To keep one Shell:B chat going (cheaper, and the agent sees its own tool results), send the
    `X-Shellb-Conversation` header (or `conversation` in the body) with the id from the previous response's
    `X-Shellb-Conversation` header or `shellb.conversation` field; then only the last user message is used.
  - Text content only; image parts are dropped for now.
  - Streaming sends `chat.completion.chunk`s; the agent's thinking arrives as `delta.reasoning_content`. The last chunk
    carries `usage` and `shellb: {conversation, status, error}`, then `data: [DONE]`.
  - Responses add `shellb: {conversation, status, tools}`. A turn that fails before writing anything returns `502`.

## MCP server

Shell:B is also an MCP server, so Claude Code, Claude Desktop, Cursor and other MCP clients can hand tasks to her
agents. Endpoint: `/api/v1/mcp` (Streamable HTTP, stateless JSON replies, POST only), with the same key and the same
limits as above. Code: `server/mcp_server.py`.

```bash
claude mcp add --transport http shellb https://<spark tailscale name>:8443/api/v1/mcp \
  --header "Authorization: Bearer sbk_…"
```

Tools:

| Tool | Does |
|---|---|
| `shellb_agents` | Lists the agents the key may use |
| `shellb_ask` | `message`, optional `agent`, `conversation`, `instructions`, `wait` (default true). Returns the reply plus the conversation id to continue with |
| `shellb_conversations` | The key's chats, newest first |
| `shellb_read` | One chat's messages (`last: N` for the tail); use it after `shellb_ask` with `wait: false` |
| `shellb_stop` | Stops a running reply |

Raw keys can't use the MCP server (it hands tasks to agents). A long agent turn can outlast a client's tool timeout; the turn keeps running on Shell:B either way, so use
`wait: false` and `shellb_read` for big tasks. Refusals (busy chat, unknown agent) come back as tool errors.

## Examples

```bash
curl http://127.0.0.1:8200/api/v1/chat \
  -H "Authorization: Bearer $SHELLB_KEY" -H "Content-Type: application/json" \
  -d '{"message": "Summarize the weather for tomorrow", "agent": "shellb"}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8200/api/v1", api_key="sbk_…")
r = client.chat.completions.create(model="shellb", messages=[{"role": "user", "content": "Hi!"}])
print(r.choices[0].message.content)
```

A game mod or any app that speaks OpenAI (raw key): point its "OpenAI-compatible" or "custom endpoint" setting at
the base URL, put the key where it asks for an API key, and leave the model name as it is or set it to one the key allows.

n8n: an **OpenAI Chat Model** credential with Base URL `http://172.17.0.1:8200/api/v1` and the key, or an **HTTP
Request** node calling `/chat`.
