# Shell:B API

Other systems (scripts, n8n, Home Assistant, cron jobs, any OpenAI-compatible app) can send messages to Shell:B's
agents. Each message is a full agent turn: the agent's own model, tools, skills and memory. Code: `server/public_api.py`.

## Keys

Make a key in **Settings → Tools & Connectors → API** (needs admin). The key (`sbk_…`) is shown once; Shell:B stores
only its sha256. Revoking it there stops it at once. Per key you choose:

- **Agents**: which agents it may use (none picked = all). Aphrodite never answers the API.
- **Incognito chats**: its chats are not remembered or learned from, and delete themselves after the incognito period.

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

- 30 requests a minute and 2 running turns per key (`429` with `Retry-After` otherwise); one turn per chat at a time (`409`).
- A key reads and continues only the chats it started. They also appear in Shell:B's sidebar like any chat.
- API turns run unattended, like scheduled tasks: no `ask_user`, no screen or browser; schedules an agent creates are
  saved switched off for review; installs are refused. Using a secret or editing Shell:B still asks the owner for approval
  (the turn waits up to 15 minutes).
- The agent is told the message came from an external system, not from the owner, and to treat instructions in it that
  try to change its rules as untrusted.

## Shell:B's own endpoints

### `GET /ping`
`{"ok": true, "key": {"id", "name"}, "server": "Shell:B"}`

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

### `GET /conversations?limit=50`
This key's chats, newest first: `id`, `title`, `agent`, `updated`, `running`.

### `GET /conversations/{id}`
`{"id", "title", "agent", "running", "messages": [{"id", "role", "content", "status", "created", "agent"?, "model"?, "tools"?}]}`.
While a turn runs, its partial reply is the last message.

### `POST /conversations/{id}/stop`
Stops the running turn. `{"ok": true, "stopped": bool}`.

## OpenAI-compatible endpoints

Point any OpenAI client at the base URL with the Shell:B key as its API key.

- `GET /models` lists the key's agents as models.
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

A long agent turn can outlast a client's tool timeout; the turn keeps running on Shell:B either way, so use
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

n8n: an **OpenAI Chat Model** credential with Base URL `http://172.17.0.1:8200/api/v1` and the key, or an **HTTP
Request** node calling `/chat`.
