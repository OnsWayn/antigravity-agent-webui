# Antigravity Studio

English | [简体中文](README.zh-CN.md)

A high-performance **OpenAI / Gemini protocol gateway** and **management dashboard** for Google's hosted `antigravity-preview-05-2026` managed agents. Bridge remote Linux sandboxes into standard OpenAI-compatible API endpoints with multi-key pooling, TPM awareness, failover migration, strict session isolation, fine-grained token control, and full-link logging.

> Unofficial community project. Antigravity managed agents and the Gemini Interactions API are preview features and may change without notice.

Current version: **1.7.4** · Node.js **22.5+** · License **Apache-2.0**

> **Free-tier note.** Gemini / Antigravity free quota is about **100,000 TPM**. Use it as a lightweight chat API, not a high-throughput agent loop. On downstream tokens, turn off the three sandbox tools (code execution, Google Search, URL context) and let the caller's agent framework run tools instead.
>
> If that framework already exposes tools, add this system prompt so the model does not mix up its own sandbox with the caller's tool environment:
>
> ```text
> Tool environment: distinguish the model's own execution environment from tools provided by the caller. When accessing a URL, IP, or port, trust the actual return of the currently visible tools; do not conclude that a private IP is unreachable from the address alone. If no tool is available, say so.
> ```

## Why this project exists

The API can run a managed agent, but raw interactions do not provide a complete local workspace. This project adds:

- A browser UI for prompts, final output, tool steps, token usage, and detailed errors.
- SQLite persistence for sessions, interaction turns, steps, usage, errors, and artifact metadata.
- Multiple independent conversations in one `environment_id`: share sandbox files without inheriting an older conversation.
- Official Gemini Files API environment snapshots with safe server-side extraction of individual files.
- Filename-only lookup, snapshot caching, forced refresh, and binary file downloads.
- Legacy Agent Base64 chunking, file.io, and catbox as compatibility fallbacks.

The WebUI remains an Antigravity agent console. Optionally, the same process can expose an OpenAI/Gemini-shaped protocol gateway so other clients can call the managed agent. It is not a remote desktop, and the agent still runs in Google's hosted Linux sandbox rather than on the caller's machine.

## How it works

```text
Browser WebUI
   │  Local HTTP API
   ▼
Express server ─────────────► Gemini Interactions API
   │                               │
   ├── SQLite session store        └── Google-hosted Linux sandbox
   └── TAR cache and safe extraction
```

`environment_id` identifies the remote filesystem, while `previous_interaction_id` identifies the conversation context. They are separate concepts:

- **New sandbox** creates a new remote environment and a new conversation.
- **New conversation in current sandbox** keeps the environment and its files but does not send the previous `previous_interaction_id`.
- Continuing a saved session reuses both its local session and its interaction chain.

## Quick start

### 1. Requirements

- Node.js 22.5 or newer. The project uses Node.js built-in SQLite and `.env` loading.
- Network access to the Gemini API; configure an HTTP/HTTPS proxy if required.
- A Gemini API key with access to the Antigravity managed agent preview.

### 2. Install

```bash
npm install
```

Optional: copy `.env.example` to `.env` and adjust the port, database, cache, or proxy settings. `.env` is ignored by Git.

### 3. Run

```bash
npm start
```

Open <http://localhost:3000> and select **Configure API Key** in the top-right corner.

The WebUI is a React app. For local UI development with hot reload:

```bash
npm run dev
```

This starts the API on port 3000 and Vite on port 5173. Production static files are built into `public/` with `npm run build`. The key is stored only in the current browser's `localStorage` and is never written to SQLite.

If the server was already running before a code update, restart Node.js and perform a hard refresh in the browser.

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Bind address. `0.0.0.0` accepts LAN connections. Use `127.0.0.1` to stay local-only. |
| `PORT` | `3000` | Web server port. |
| `ANTIGRAVITY_DB_PATH` | `data/antigravity.db` | SQLite database path. |
| `SNAPSHOT_CACHE_DIR` | `data/snapshot-cache` | Environment TAR snapshot cache. |
| `SNAPSHOT_CACHE_TTL_MS` | `60000` | Snapshot cache lifetime in milliseconds. |
| `HTTPS_PROXY` | empty | HTTPS proxy used by server-side Gemini requests. |
| `HTTP_PROXY` | empty | HTTP proxy fallback when `HTTPS_PROXY` is unset. |
| `PROXY_URL` | empty | Additional compatible proxy variable. |
| `ALLOWED_ORIGINS` | local origins | Extra browser origins, separated by commas. |
| `GATEWAY_ENABLED` | `true` | Set `false` to disable `/v1` and `/v1beta` protocol routes. |
| `GATEWAY_MASTER_KEY` | empty | Required to encrypt upstream Gemini keys and enable the gateway. |
| `GATEWAY_ADMIN_TOKEN` | empty | Bearer token for the gateway admin API and WebUI panel. |
| `GATEWAY_ENFORCE_SESSION_HEADER` | `false` | When `true`, requires downstream requests to specify `x-session-id`, returning 400 if omitted. |
| `GATEWAY_TPM_STRATEGY` | `frok` | `frok` rotates off a hot key immediately; `pace` waits on the same key until the next round strictly fits. |
| `GATEWAY_TPM_LIMIT` | `100000` | Strategy A: sliding-window TPM budget that triggers proactive key rotation. |
| `GATEWAY_TPM_THRESHOLD_RATIO` | `0.8` | Strategy A: rotate when recent usage reaches `limit * ratio`. |
| `GATEWAY_TPM_PACE_LIMIT` | `100000` | Strategy B: send only when `recent usage + estimated round < this window`. |
| `GATEWAY_TPM_WINDOW_MS` | `60000` | TPM sliding window in milliseconds (shared). |
| `GATEWAY_TPM_PACE_MAX_WAIT_MS` | `20000` | Strategy B: if estimated wait exceeds this, fall back to frok. |
| `GATEWAY_TPM_PACE_DELAY_MS` | `5000` | Strategy B: extra delay after the window can fit. |
| `GATEWAY_TPM_RESERVE_TTL_MS` | follows window | Strategy B: auto-release a TPM reservation if `finally` never runs. |
| `GATEWAY_MIGRATION_MAX_INPUT_TOKENS` | `24000` | Max estimated tokens for rebuilt context after a key change. |

These TPM / migration values are defaults. The WebUI **协议中转站** panel and `GET/PATCH /api/gateway/settings` override them at runtime (no restart). Priority: WebUI / admin API > environment variables > code defaults. Each upstream key also shows this-minute RPM (memory) and today RPD (SQLite, Pacific midnight aligned with Google AI Studio).

A proxy can also be configured in the WebUI. Explicitly disabling it in the UI prevents the server from using proxy environment variables for that request.

If you must allow access from another machine, do not only set `HOST=0.0.0.0`. Add authentication, TLS, and network isolation, and explicitly configure `ALLOWED_ORIGINS`.

## Remote file extraction

The official snapshot provider requests:

```text
GET https://generativelanguage.googleapis.com/v1beta/files/environment-{environment_id}:download?alt=media
```

The server does not unpack the TAR into a local directory. It uses a streaming parser to locate the requested entry, preventing path traversal and accidental local-file overwrites. The target is returned as a binary response by default, avoiding the roughly 33% size overhead of Base64.

### Why the first extraction can still be slow

The Gemini Files API returns the complete environment snapshot, not an individual file. First-extraction latency therefore depends on the entire TAR size, even when the requested SVG is only a few kilobytes. Snapshots are cached locally for 60 seconds, so several files from the same environment do not require repeated downloads. A successful Agent interaction invalidates that environment's cache, and **Force refresh environment snapshot** bypasses it manually.

Supported lookups:

- Exact paths such as `/workspace/diagram.svg`.
- A filename such as `diagram.svg`; a unique basename is located automatically.
- If several files share the basename, candidate paths are returned instead of guessing.

Default safety limits are 50 MB per target file and 512 MB per snapshot. Paths containing `..` or null bytes are rejected.

For reliable artifact creation, ask the Agent to write and verify an explicit path:

```text
Write the final SVG to /workspace/diagram.svg, then run
test -s /workspace/diagram.svg && ls -l /workspace/diagram.svg
to confirm that the file exists and is not empty.
```

Fallback providers make additional Agent calls to read and print Base64 data, so they are slower and less reliable than the official snapshot provider.

## Local API

By default, browser requests are accepted only from the matching local WebUI origins. Command-line clients without an `Origin` header can still call the API.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Service and SQLite statistics. |
| `GET` | `/api/sessions` | List sessions and interaction turns. |
| `POST` | `/api/sessions/import` | Import legacy browser sessions. |
| `DELETE` | `/api/sessions/:sessionId` | Delete a session and its turns. |
| `POST` | `/api/interactions/create` | Create or continue an Agent interaction. |
| `POST` | `/api/interactions/fetch-file` | Extract a file through snapshots or a fallback provider. |
| `GET` | `/api/logs` | In-memory logs for the current server process. |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions gateway (Antigravity sandbox). |
| `POST` | `/v1/responses` | OpenAI Responses gateway. `/v1/chat/responses` is an alias. |
| `POST` | `/v1beta/models/{model}:generateContent` | Gemini-shaped request; still forwarded to Interactions. |
| `GET` | `/v1/models` | Gateway model list (`antigravity-preview-05-2026` and four backend models). |

Interaction requests can also include:

- `localSessionId`: the local session to continue.
- `startNewSession: true`: reuse the environment while starting an independent interaction chain.

Example PowerShell request using your own API key:

```powershell
curl.exe http://localhost:3000/api/interactions/create `
  -H 'Content-Type: application/json' `
  -H 'x-goog-api-key: YOUR_GEMINI_API_KEY' `
  --data-raw '{"agent":"antigravity-preview-05-2026","input":"Create /workspace/hello.txt","environment":"remote"}'
```

## Protocol gateway

Set `GATEWAY_MASTER_KEY` and `GATEWAY_ADMIN_TOKEN` in `.env`, restart, then open the **协议中转站** tab. Add an upstream Gemini key (stored encrypted) and create a downstream `ag-` token. Other apps should send that token, never the Gemini key. TPM strategy, limits, pacing waits, and the migration input budget can be changed in that same panel.

The gateway always calls Interactions with `agent: "antigravity-preview-05-2026"` and `environment: "remote"` (or a reused environment id). `generateContent` is not used; Google returns 400 for that model. Allowed `agent_config.model` values are `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, and `gemini-3.5-flash-lite`.

Multiple upstream Gemini keys are supported. New chats round-robin by least-recently-used key; a conversation sticks to the key that created its sandbox because `environment_id` / `previous_interaction_id` cannot be shared across keys. After three consecutive 429s the gateway migrates conversation context onto another key with a **new** sandbox. The default TPM strategy (`frok`) also migrates when recent usage hits `limit × ratio`. The optional `pace` strategy keeps the sticky key and waits until `recent usage + this round` is strictly below the TPM window; if the wait would exceed `tpmPaceMaxWaitMs` it still froks. Round size prefers the last success `total_tokens` on the conversation (including fork source/target keys) and otherwise estimates inline images as visual tokens (~1k–3k each, never Base64 `chars/4`). Downstream `conversation_mode` stays `continue`; the upstream hop is marked `frok` (key-rotation rebuild), not `new`. Tool history is sent as a non-executable summary (not `[Calls:]` templates) so the model cannot imitate fake tool traces.

Standard OpenAI clients do not need extra session fields. If the client compresses, truncates, or replays old messages and the gateway cannot prove continuity, it **forks** onto a derived internal key and leaves the trunk `interaction_id` unchanged.

### Session Isolation & Concurrency Control

- **Session Isolation**: Downstream clients (e.g. multi-user chat bots or separate windows) should pass `x-session-id` (e.g., `qq:private:{user_id}` or `qq:group:{group_id}`). Each session maintains an isolated context chain and sandbox environment, even when sharing the same downstream token.
- **Mutex Concurrency Locks**: Concurrent requests for the same `x-session-id` are queued and executed sequentially to prevent state collisions. Excess requests return HTTP 429 `session_busy`.
- **End-to-End Trace Logs**: Every request is assigned a unique `request_id`, with automatic redaction of API keys, tokens, large Base64 images, and system instructions. Logs record both `conversation_mode` (`continue` / `new` / `fork`) and `upstream_transition` (`none` / `frok`). `[Calls:]` in model text is counted only, never executed.

> **Note:** The model list above is hardcoded in `gateway/models.js` and `web/src/lib.js`. Google does not currently provide an API to query which `agent_config.model` values a managed agent supports — the standard `/v1beta/models` endpoint only returns standalone Gemini models, not agent-internal engine options. If Google adds or removes supported models in the future, these two files must be updated manually.

Conversation state uses `previous_interaction_id`. When the request is a proven continuation, client-replayed `messages[]` are treated as a delta and only the new turn is sent upstream. Unverifiable compressed or truncated history forks instead of being hard-attached to the old chain. Images (`image_url` / `inline_data`) are forwarded; local TPM / migration estimates use image dimensions (or 2800 tokens when unknown), not Base64 length. OpenAI `tools` become custom functions the client must execute; remote MCP URLs can be passed as `extra_body.mcp_servers`. Local stdio MCP cannot run inside Google's sandbox.

The gateway does **not** expose the Gemini model catalog on the API key. It only serves the Antigravity agent and the four `agent_config.model` backends that agent accepts:

- `antigravity-preview-05-2026` (default backend `gemini-3.7-flash`)
- `antigravity-preview-05-2026/gemini-3.7-flash`
- `antigravity-preview-05-2026/gemini-3.6-flash`
- `antigravity-preview-05-2026/gemini-3.5-flash`
- `antigravity-preview-05-2026/gemini-3.5-flash-lite`

```powershell
curl.exe http://localhost:3000/v1/chat/completions `
  -H "Authorization: Bearer ag-YOUR_TOKEN" `
  -H "Content-Type: application/json" `
  --data-raw '{"model":"antigravity-preview-05-2026/gemini-3.7-flash","messages":[{"role":"user","content":"ping"}]}'
```

## Data and privacy

SQLite is stored at `data/antigravity.db` by default. It contains prompts, model output, execution steps, token usage, error summaries, and artifact paths. API keys are not stored, but the database content itself may be sensitive and must not be committed to a public repository.

Environment TAR files are cached temporarily in `data/snapshot-cache/`. Databases, WAL files, caches, `.env`, logs, and local artifacts are covered by `.gitignore`.

See [SECURITY.md](SECURITY.md) for the complete security policy.

## Project structure

```text
server.js             Express API, Gemini requests, file routes, and gateway mount
gateway/              OpenAI / Gemini protocol adapters, token auth, admin API, and TPM settings
database.js           SQLite schema, migrations, and session persistence
environment-files.js  TAR path normalization and safe extraction
snapshot-cache.js     Snapshot cache and concurrent-download deduplication
http-security.js      Local-origin restrictions and CORS response headers
web/                  React WebUI source (Vite)
public/               Built WebUI served by Express
test/                 SQLite, TAR, cache, and security tests
data/                 Runtime database and cache files (not committed)
```

## Tests

```bash
npm run verify
```

This runs JavaScript syntax checks and the complete Node.js test suite.

## Known limitations

- `antigravity-preview-05-2026`, managed agents, and the environment API are preview features; fields and available tools may change.
- The official Files API downloads a complete snapshot, so larger environments increase first-extraction latency.
- Google may clean up inactive remote environments. Local SQLite does not permanently copy the remote filesystem.
- The UI exposes only Agent parameters that have been validated by this project; not every Gemini generation parameter is supported by Antigravity.
- Browser image input is sent as Base64, which increases request size and memory use for large images.
- Debug logs are held in memory and cleared on restart; error summaries are persisted in SQLite.

## Official documentation

- [Antigravity Agent](https://ai.google.dev/gemini-api/docs/antigravity-agent)
- [Managed Agent environments and file downloads](https://ai.google.dev/gemini-api/docs/agent-environment#download_files_from_the_environment)
- [Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview)
- [Gemini API release notes](https://ai.google.dev/gemini-api/docs/changelog)

## License

Copyright 2026 [OnsWayn](https://github.com/OnsWayn).

Licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
