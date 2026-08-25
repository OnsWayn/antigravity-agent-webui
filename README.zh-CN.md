# Antigravity Studio

[English](README.md) | 简体中文

面向 Google Gemini `antigravity-preview-05-2026` 托管智能体的 **OpenAI / Gemini 协议中转网关** 与 **运维管理控制台**。它将 Google 云端远程 Linux 沙盒桥接为标准 OpenAI / Gemini 接口，支持多 Key 轮换池、TPM 避让、故障平滑迁移、会话隔离、细粒度 Token 控制与全链路日志审计。

> 非官方社区项目。Antigravity managed agents 和 Gemini Interactions API 均为预览功能，接口可能随时变化。

当前版本：**1.7.0** · Node.js **22.5+** · License **Apache-2.0**

## 这个项目解决什么问题

官方 API 可以运行 Agent，但原始交互不包含完整的本地工作台体验。本项目补上了这些能力：

- 在浏览器中提交任务并查看最终输出、工具步骤、Token 用量和错误详情。
- 使用 SQLite 保存会话、每轮交互、执行步骤、用量、错误和产物元数据。
- 同一个 `environment_id` 可以拥有多个独立本地会话：共享远程文件，但可以不继承旧的对话上下文。
- 从 Gemini Files API 下载完整环境 TAR 快照，并在服务端安全提取单个文件。
- 支持只输入文件名自动定位文件、快照缓存、强制刷新和二进制下载。
- 保留 Agent Base64 分块、file.io 和 catbox 作为兼容性备用通道。

WebUI 仍然是 Antigravity Agent 控制台。同一进程可以额外开启 OpenAI / Gemini 外形的协议网关，给其他客户端调用这个托管 Agent。它不是远程桌面；Agent 仍然跑在 Google 托管的 Linux 沙盒里，而不是调用方本机。

## 工作方式

```text
浏览器 WebUI
   │  本地 HTTP API
   ▼
Express 服务 ───────────────► Gemini Interactions API
   │                               │
   ├── SQLite 会话库               └── Google 托管 Linux 沙盒
   └── TAR 快照缓存/安全文件提取
```

`environment_id` 表示远程文件系统，`previous_interaction_id` 表示对话上下文，两者是不同概念：

- “新沙盒”创建新的远程环境和新的会话。
- “当前沙盒新会话”保留环境及文件，但不发送旧的 `previous_interaction_id`。
- 从历史会话继续时，会同时复用选中的本地会话和对应的交互链。

## 快速开始

### 1. 环境要求

- Node.js 22.5 或更高版本（使用 Node.js 内置 SQLite 和 `.env` 加载能力）。
- 能够访问 Gemini API 的网络环境；必要时配置 HTTP/HTTPS 代理。
- 已获得 Antigravity managed agent 权限的 Gemini API Key。

### 2. 安装

```bash
npm install
```

可选：复制 `.env.example` 为 `.env`，根据需要修改端口、数据库和代理配置。`.env` 已被 Git 忽略。

### 3. 启动

```bash
npm start
```

浏览器访问 <http://localhost:3000>，点击右上角“配置 API Key”。

WebUI 使用 React。本地热更新开发：

```bash
npm run dev
```

会同时启动 3000 端口的 API 和 5173 端口的 Vite。生产静态文件由 `npm run build` 输出到 `public/`。API Key 只保存在当前浏览器的 `localStorage`，不会写入 SQLite。

如果服务之前已经运行，修改代码后需要重启 Node.js 服务，再对页面执行一次强制刷新。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址。`0.0.0.0` 允许局域网访问；只想本机访问时改回 `127.0.0.1`。 |
| `PORT` | `3000` | Web 服务端口。 |
| `ANTIGRAVITY_DB_PATH` | `data/antigravity.db` | SQLite 数据库路径。 |
| `SNAPSHOT_CACHE_DIR` | `data/snapshot-cache` | 环境 TAR 快照缓存目录。 |
| `SNAPSHOT_CACHE_TTL_MS` | `60000` | 快照缓存有效期，单位毫秒。 |
| `HTTPS_PROXY` | 空 | 服务端访问 Gemini API 时使用的 HTTPS 代理。 |
| `HTTP_PROXY` | 空 | 未设置 `HTTPS_PROXY` 时使用的 HTTP 代理。 |
| `PROXY_URL` | 空 | 兼容的备用代理变量。 |
| `ALLOWED_ORIGINS` | 本机来源 | 额外允许的浏览器来源，多个来源用逗号分隔。 |
| `GATEWAY_ENABLED` | `true` | 设为 `false` 时关闭 `/v1` 和 `/v1beta` 协议路由。 |
| `GATEWAY_MASTER_KEY` | 空 | 加密上游 Gemini Key 并启用中转站，必填。 |
| `GATEWAY_ADMIN_TOKEN` | 空 | 中转站管理 API / WebUI 面板的 Bearer Token。 |
| `GATEWAY_ENFORCE_SESSION_HEADER` | `false` | 设为 `true` 时强制要求客户端提供 `x-session-id`，缺失时返回 400，防止多对话串台。 |

WebUI 左侧也可以配置代理。界面中明确关闭代理后，服务端不会使用环境变量中的代理。

如果必须让其他机器访问，不要只设置 `HOST=0.0.0.0`；还应自行提供身份认证、TLS 和网络隔离，并明确配置 `ALLOWED_ORIGINS`。

## 远程文件提取

官方快照通道会请求：

```text
GET https://generativelanguage.googleapis.com/v1beta/files/environment-{environment_id}:download?alt=media
```

服务端不会把 TAR 解压到本地目录，而是使用流式解析器查找目标条目，避免路径穿越和覆盖本地文件。默认以二进制响应返回目标文件，避免 Base64 约 33% 的体积膨胀。

### 为什么第一次可能仍然慢

Gemini Files API 返回的是完整环境快照，而不是单个文件。因此第一次提取耗时取决于整个环境 TAR 的大小，即使目标 SVG 只有几 KB。服务会在本地缓存快照 60 秒：同一环境连续提取多个文件时无需重复下载；每次 Agent 成功修改环境后会自动清除缓存。下载面板中的“强制刷新环境快照”可以绕过缓存。

支持：

- 完整路径，例如 `/workspace/diagram.svg`。
- 只输入文件名，例如 `diagram.svg`；快照中只有一个同名文件时会自动定位。
- 同名文件超过一个时返回候选路径，不会擅自选择。

安全上限：单个文件默认 50 MB，单次快照默认 512 MB；路径不能包含 `..` 或空字节。

建议让 Agent 明确写入并验证路径：

```text
将最终 SVG 写入 /workspace/diagram.svg，然后执行
test -s /workspace/diagram.svg && ls -l /workspace/diagram.svg，确认文件存在且不为空。
```

备用通道会额外调用 Agent 读取并输出 Base64，速度和稳定性都不如官方快照通道。

## 本地 API

所有 API 默认只接受本地 WebUI 来源；无 `Origin` 的命令行客户端仍可调用。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/health` | 服务和 SQLite 统计。 |
| `GET` | `/api/sessions` | 获取会话及交互轮次。 |
| `POST` | `/api/sessions/import` | 导入旧版浏览器会话。 |
| `DELETE` | `/api/sessions/:sessionId` | 删除会话及关联轮次。 |
| `POST` | `/api/interactions/create` | 创建或继续 Agent 任务。 |
| `POST` | `/api/interactions/fetch-file` | 从环境快照或备用通道提取文件。 |
| `GET` | `/api/logs` | 当前服务进程的内存日志。 |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions 网关（Antigravity 沙盒）。 |
| `POST` | `/v1/responses` | OpenAI Responses 网关；`/v1/chat/responses` 为别名。 |
| `POST` | `/v1beta/models/{model}:generateContent` | Gemini 请求外形，内部仍转发到 Interactions。 |
| `GET` | `/v1/models` | 网关模型列表（agent 以及 4 个底层型号）。 |

创建任务时可以提交：

- `localSessionId`：要继续的本地会话 ID。
- `startNewSession: true`：复用环境但创建不继承旧交互链的新会话。

示例请求（仍需在请求头中提供自己的 Key）：

```powershell
curl.exe http://localhost:3000/api/interactions/create `
  -H 'Content-Type: application/json' `
  -H 'x-goog-api-key: YOUR_GEMINI_API_KEY' `
  --data-raw '{"agent":"antigravity-preview-05-2026","input":"在 /workspace 生成 hello.txt","environment":"remote"}'
```

## 协议中转站

在 `.env` 中设置 `GATEWAY_MASTER_KEY` 和 `GATEWAY_ADMIN_TOKEN`，重启后打开「协议中转站」面板。添加加密保存的上游 Gemini Key，再创建下游 `ag-` Token。其他应用只应使用该 Token，不要再传 Gemini Key。

网关始终调用 Interactions：`agent: "antigravity-preview-05-2026"`，`environment: "remote"`（或复用已有环境 ID）。不会走 `generateContent`（对该 agent 会 400）。允许的 `agent_config.model`：`gemini-3.7-flash`、`gemini-3.6-flash`、`gemini-3.5-flash`、`gemini-3.5-flash-lite`。

可配置多把上游 Gemini Key。新会话按最近最少使用轮询；同一会话会粘在原来的 Key 上，因为 `environment_id` / `previous_interaction_id` 不能跨 Key 复用。某把 Key 连续 3 次 429 后冷却 60 秒，并把当前对话全文（包括正在进行的工具调用结果）带到下一把 Key 上开**新沙盒**继续，通过任务恢复上下文无缝继续任务，不会丢失上下文或抛出孤立工具结果（旧沙盒里的文件带不过去）。

### 多会话隔离与并发控制

- **会话隔离**：客户端（如 QQ 机器人、多窗口聊天客户端）应在请求头中传入 `x-session-id`（例如 `qq:private:{user_id}` 或 `qq:group:{group_id}`）。每个会话拥有完全独立的上下文链与远程沙盒环境，共用同一把 API Key 也绝不会发生串台。
- **并发互斥锁**：同一 `x-session-id` 的并发请求会在服务端自动排队串行处理，防止旧请求覆盖新交互状态；超出排队上限时返回 HTTP 429 `session_busy`。
- **全链路诊断日志**：每个请求分配唯一 `request_id`，自动脱敏 API Key、Authorization 头、超大图片 Base64 与系统指令。

> **注意**：上述模型列表是在代码中硬编码的（`gateway/models.js` 和 `web/src/lib.js`）。Google 目前没有提供 API 来查询某个 managed agent 支持哪些 `agent_config.model` 值——标准的 `/v1beta/models` 接口只返回独立 Gemini 模型目录，不包含 Agent 内部引擎信息。如果 Google 将来新增或下线模型，需要手动更新这两个文件。

多轮对话使用服务端 `previous_interaction_id`。前端回传的完整 `messages[]` 只用来计算本轮增量，不会整段再发一遍。支持图片。OpenAI `tools` 会变成自定义函数并由客户端执行；远程 MCP URL 可通过 `extra_body.mcp_servers` 传递。本机 stdio MCP 无法在 Google 沙盒里运行。

网关**不会**列出该 API Key 名下的普通 Gemini 模型目录。它只提供 Antigravity Agent，以及这个 Agent 允许的 4 个 `agent_config.model`：

- `antigravity-preview-05-2026`（默认底层 `gemini-3.7-flash`）
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

## 数据与隐私

SQLite 默认位于 `data/antigravity.db`，会保存 Prompt、模型输出、执行步骤、Token 用量、错误摘要和产物路径。它不会保存 API Key，但这些内容本身可能敏感，请勿提交到公共仓库。

快照 TAR 临时位于 `data/snapshot-cache/`，数据库、WAL 文件、缓存、`.env`、日志和本地产物都已加入 `.gitignore`。

更多安全约束见 [SECURITY.md](SECURITY.md)。

## 项目结构

```text
server.js             Express API、Gemini 调用、文件提取和网关挂载
gateway/              OpenAI / Gemini 协议适配、Token 鉴额和管理 API
database.js           SQLite schema、迁移和会话持久化
environment-files.js  TAR 路径规范化与安全提取
snapshot-cache.js     环境快照缓存和并发下载合并
http-security.js      本地来源限制与 CORS 响应头
web/                  React WebUI 源码（Vite）
public/               Express 提供的构建产物
test/                 SQLite、TAR、缓存和安全测试
data/                 运行时数据库与缓存（不提交）
```

## 测试与检查

```bash
npm run verify
```

该命令会执行 JavaScript 语法检查和完整 Node.js 测试套件。

## 已知限制

- `antigravity-preview-05-2026`、managed agents 和环境 API 属于预览功能，字段和可用工具可能变化。
- 官方 Files API 下载完整快照；环境越大，首次文件提取越慢。
- 远程环境可能因长时间不活跃而被 Google 清理；本地 SQLite 不会永久复制远程文件系统。
- 当前 UI 只允许配置已经验证过的 Agent 参数；并非所有 Gemini 生成参数都适用于 Antigravity。
- 浏览器端图片输入会以 Base64 进入请求，大图片会增加请求体积和内存使用。
- 服务端调试日志保存在内存中，重启后清空；错误摘要会持久化到 SQLite。

## 官方资料

- [Antigravity Agent](https://ai.google.dev/gemini-api/docs/antigravity-agent)
- [Managed Agent 环境与文件下载](https://ai.google.dev/gemini-api/docs/agent-environment#download_files_from_the_environment)
- [Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview)
- [Gemini API Release notes](https://ai.google.dev/gemini-api/docs/changelog)

## 许可证

Copyright 2026 [OnsWayn](https://github.com/OnsWayn)。

本项目采用 Apache-2.0 许可证，详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
