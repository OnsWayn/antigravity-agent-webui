# Changelog

All notable changes to this project are documented in this file.

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
