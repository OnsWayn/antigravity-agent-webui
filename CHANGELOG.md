# Changelog

All notable changes to this project are documented in this file.

## [1.7.0] - 2026-08-25

### Added

- **独立日志控制台 (Log Dashboard)**:
  - 完整记录下游客户端请求、网关调度、上游 Google Interactions Payload / 响应、执行耗时与 Token 消耗。
  - 支持按请求状态（成功 / 错误 / 限流 / 进行中）、下游 Token、会话标识过滤，以及关键字全字段检索。
  - 三栏独立折叠/展开 Payload 代码块（下游请求体、上游请求体、上游响应体），支持一键无缝复制。
  - 错误与 429 限流高对比度告警面板，精准显示状态码、错误信息及故障排查指引。
  - 自动持久化至 SQLite `gateway_request_logs` 表，提供 5 天滚动保留与每日 20MB 超额清理机制。
- **项目结构与 UI 布局重组 (API 优先架构)**:
  - 调整前端导航顺序为「协议中转 ➔ 日志控制台 ➔ 沙盒调试 ➔ 文件提取 ➔ 说明」，默认直接展示中转站面板。
  - 顶部导航栏新增全局网关运行状态指示器、就绪 Key 数量统计与连接指示灯。
  - 将单文件架构全面拆分为 `LogDashboard.jsx`、`GatewayPanel.jsx`、`ChatSidebar.jsx`、`TraceView.jsx`、`ArtifactsView.jsx` 模块化组件。
- **单个下游 Token 精细控制 (Fine-Grained Token Control)**:
  - 扩展 SQLite `client_tokens` Schema V5，支持为每个客户端 Token 配置独立权限。
  - 支持限制可用模型白名单 (`allowed_models`) 与指定默认回退模型 (`default_model`)。
  - 支持三项沙盒工具独立开关控制：代码执行 (`tool_code_execution`)、谷歌搜索 (`tool_google_search`)、网页抓取 (`tool_url_context`)。
- **云端沙盒自定义模型支持 (Pass-Through Custom Models)**:
  - 后端模型解析器升级为 Pass-Through 模式，允许客户端直接请求任意未预设的 Gemini 模型。
  - 前端调试面板与 Token 发行界面支持直接输入自定义模型名称。
- **上下文丢失诊断与高可用平滑迁移 (TPM Awareness & Context Recovery)**:
  - 引入 `TpmTracker` 60 秒滑动窗口用量追踪器，当 Key 接近 100k TPM 上限时主动避让至空闲 Key。
  - 优化 `prefix_hash` 判定逻辑，避免因 System Prompt 细微调整误判为 fork 导致的上下文丢失。
  - 强化 Key 轮换沙盒平滑迁移 (`migrateConversationForKeyChange`)，通过 `transcript_json` 重建完整的对话历史。

## [1.6.0] - 2026-08-25

### Added

- **Strict Session Isolation**: Support for `x-session-id` and `x-ag-session-id` headers with configurable enforcement (`GATEWAY_ENFORCE_SESSION_HEADER`). Eliminates cross-session context collisions when multiple chat windows share the same API key.
- **In-Flight Key Migration Context Recovery**: Enhanced `migrateConversationForKeyChange` and `buildToolRecoveryContext` to preserve `function_result` structures and tool `call_id`s during upstream key failover, preventing orphan tool results and broken Interaction chains.
- **Per-Session Concurrency Lock**: Added `gateway/lock.js` with promise-based queuing per session, queue limit rejection (`429 session_busy`), and timeout protection.
- **Structured Logging & Sanitization**: Added `gateway/logger.js` with end-to-end `request_id` tracking, event categorization, and recursive redaction of secrets, API keys, system instructions, and large Base64 image payloads.
- **Database Optimistic Concurrency & Audit**: Added `context_version` auto-increment and `created_at` timestamp tracking to `gateway_conversations` in SQLite schema v4.

### Fixed

- Fixed stream mode `environment_id` extraction from nested Interaction completion events.
- Fixed potential data collision in fallback conversation keys.

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
