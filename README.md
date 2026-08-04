# Antigravity Agent Web UI

English | [简体中文](README.zh-CN.md)

A local Gemini Interactions API console for Google's hosted `antigravity-preview-05-2026` managed agent. Create or reuse remote Linux environments, inspect execution traces, persist local conversations, and safely extract files from the sandbox.

> Unofficial community project. Antigravity managed agents and the Gemini Interactions API are preview features and may change without notice.

Current version: **1.4.0** · Node.js **22.5+** · License **Apache-2.0**

## Why this project exists

The API can run a managed agent, but raw interactions do not provide a complete local workspace. This project adds:

- A browser UI for prompts, final output, tool steps, token usage, and detailed errors.
- SQLite persistence for sessions, interaction turns, steps, usage, errors, and artifact metadata.
- Multiple independent conversations in one `environment_id`: share sandbox files without inheriting an older conversation.
- Official Gemini Files API environment snapshots with safe server-side extraction of individual files.
- Filename-only lookup, snapshot caching, forced refresh, and binary file downloads.
- Legacy Agent Base64 chunking, file.io, and catbox as compatibility fallbacks.

This project is not an OpenAI `/v1/chat/completions` compatible proxy, a remote desktop, or a general-purpose sandbox hosting platform.

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

Open <http://localhost:3000> and select **Configure API Key** in the top-right corner. The key is stored only in the current browser's `localStorage` and is never written to SQLite.

If the server was already running before a code update, restart Node.js and perform a hard refresh in the browser.

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Keep the default to avoid LAN exposure. |
| `PORT` | `3000` | Web server port. |
| `ANTIGRAVITY_DB_PATH` | `data/antigravity.db` | SQLite database path. |
| `SNAPSHOT_CACHE_DIR` | `data/snapshot-cache` | Environment TAR snapshot cache. |
| `SNAPSHOT_CACHE_TTL_MS` | `60000` | Snapshot cache lifetime in milliseconds. |
| `HTTPS_PROXY` | empty | HTTPS proxy used by server-side Gemini requests. |
| `HTTP_PROXY` | empty | HTTP proxy fallback when `HTTPS_PROXY` is unset. |
| `PROXY_URL` | empty | Additional compatible proxy variable. |
| `ALLOWED_ORIGINS` | local origins | Extra browser origins, separated by commas. |

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

## Data and privacy

SQLite is stored at `data/antigravity.db` by default. It contains prompts, model output, execution steps, token usage, error summaries, and artifact paths. API keys are not stored, but the database content itself may be sensitive and must not be committed to a public repository.

Environment TAR files are cached temporarily in `data/snapshot-cache/`. Databases, WAL files, caches, `.env`, logs, and local artifacts are covered by `.gitignore`.

See [SECURITY.md](SECURITY.md) for the complete security policy.

## Project structure

```text
server.js             Express API, Gemini requests, and file routes
database.js           SQLite schema, migrations, and session persistence
environment-files.js  TAR path normalization and safe extraction
snapshot-cache.js     Snapshot cache and concurrent-download deduplication
http-security.js      Local-origin restrictions and CORS response headers
public/               WebUI, styles, and browser-side application logic
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
