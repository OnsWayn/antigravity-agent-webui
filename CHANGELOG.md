# Changelog

All notable changes to this project are documented in this file.

## [1.5.2] - 2026-08-24

### Added

- Upstream key round-robin with per-conversation key affinity.
- After 3 consecutive 429s on one key, fail over to another key, flatten the current chat, and open a new sandbox instead of dropping context.

## [1.5.1] - 2026-08-24

### Changed

- Gateway `/v1/models` now lists only `antigravity-preview-05-2026` and `antigravity-preview-05-2026/<backend>`, not the API key's Gemini catalog.
- WebUI rewritten in React (Vite). The model picker is Antigravity `agent_config.model` only.
- Gemini native paths accept slashes in the model id (`.../antigravity-preview-05-2026/gemini-3.7-flash:generateContent`).

## [1.5.0] - 2026-08-24

### Added

- Optional protocol gateway exposing `/v1/chat/completions`, `/v1/responses` (`/v1/chat/responses` alias), and Gemini `generateContent` / `streamGenerateContent` shapes.
- Server-side upstream Gemini keys (AES-256-GCM) and downstream `ag-` tokens with quota tracking.
- Conversation delta handling via `previous_interaction_id`, image parts, OpenAI tools, and remote MCP URLs.
- WebUI「协议中转站」panel for keys, tokens, usage, and example curl commands.

### Security

- Gateway routes authenticate with downstream tokens instead of browser origin checks.
- Real Gemini keys are never accepted from gateway clients and are not returned by the admin API.

## [1.4.0] - 2026-07-27

### Added

- Multiple independent conversations can reuse the same remote environment.
- SQLite schema v2 separates environments from sessions and migrates v1 data in place.
- Official environment snapshot cache with a 60-second default TTL, concurrent-download deduplication and manual refresh.
- Binary snapshot file downloads and cache hit/miss feedback in the WebUI.
- Safe basename lookup when the exact sandbox file path is unknown.

### Fixed

- Long expanded session histories can scroll independently.
- Static assets no longer leave the WebUI stuck on stale browser cache entries.
- A stale local session ID can no longer move a session to another environment.

### Security

- The server now listens on `127.0.0.1` by default.
- Browser origins are restricted to the local WebUI unless explicitly allowed.
- API keys remain browser-local and are redacted from persisted request metadata.

## [1.3.2]

- Added official Gemini Files API environment snapshot downloads and safe TAR extraction.
- Added SQLite-backed session, interaction, artifact and error persistence.
