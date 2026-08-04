# Security Policy

## Supported versions

Security fixes are applied to the latest release on the default branch.

## Local-only defaults

The server listens on `127.0.0.1` by default and accepts browser requests only from its matching local origins. Exposing it to a LAN or the public internet is not a supported deployment mode unless you add your own authentication, TLS and network controls.

If you intentionally use a separate frontend origin, list it explicitly in `ALLOWED_ORIGINS`. Setting `HOST=0.0.0.0` makes the service reachable from other machines and should be treated as an advanced, security-sensitive configuration.

## Sensitive local data

- The Gemini API key is stored in the browser's `localStorage`; it is sent through the local server to Google but is not written to SQLite.
- SQLite stores prompts, model outputs, execution steps, usage, artifact paths and error summaries. Treat `data/antigravity.db` as private.
- Environment snapshot TAR files may contain remote sandbox data. They are stored temporarily under `data/snapshot-cache/` and are ignored by Git.
- Do not commit `.env`, database files, snapshot caches, logs or exported artifacts that contain private information.

## Reporting a vulnerability

After the repository is published, please use GitHub's private security-advisory feature when available. Avoid posting API keys, database contents, prompts or environment snapshots in public issues.
