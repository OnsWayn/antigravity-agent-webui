# Antigravity Studio

[English](README.md) | 简体中文

面向 Google Gemini `antigravity-preview-05-2026` 托管智能体的 **OpenAI / Gemini 协议中转网关** 与 **运维管理控制台**。它将 Google 云端远程 Linux 沙盒桥接为标准 OpenAI / Gemini 接口，支持多 Key 轮换池、TPM 避让、故障平滑迁移、会话隔离、细粒度 Token 控制与全链路日志审计。

> 非官方社区项目。Antigravity managed agents 和 Gemini Interactions API 均为预览功能，接口可能随时变化。

当前版本：**1.7.6** · Node.js **22.5+** · License **Apache-2.0**

> **免费档使用建议。** Gemini / Antigravity 免费层级大约只有 **100,000 TPM**，适合当作轻量聊天 API，不适合高并发或重度 Agent 循环。建议在下游 Token 上关闭沙盒三项内置工具（代码执行、谷歌搜索、网页抓取），把工具执行交给调用方自己的 Agent 框架。
>
> 若调用方已经提供工具，建议在系统提示中加入下面这段，避免模型把「自己所在沙盒」和「调用方工具环境」混为一谈：
>
> ```text
> 工具环境说明：请区分模型自身执行环境与调用方提供的工具执行环境。访问 URL、IP 或端口时，以当前可见工具的实际返回为准，不要仅因目标是私有 IP 就判定无法访问；没有可用工具就如实说明。
> ```

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
| `GATEWAY_TPM_STRATEGY` | `clone` | `clone`（旧名 `frok`）立即换热 Key；`pace` 同一把 Key 上等到下一轮能严格塞进窗口。 |
| `GATEWAY_TPM_LIMIT` | `100000` | 策略 A：滑动窗口 TPM 上限，到达后主动换 Key 并迁移上下文。 |
| `GATEWAY_TPM_THRESHOLD_RATIO` | `0.8` | 策略 A：用量达到 `上限 × 比例` 时触发避让 / 迁移。 |
| `GATEWAY_TPM_PACE_LIMIT` | `100000` | 策略 B：仅当 `已用量 + 本轮预估 < 此窗口` 才立刻上传。 |
| `GATEWAY_TPM_WINDOW_MS` | `60000` | TPM 滑动窗口，毫秒（两套策略共用）。 |
| `GATEWAY_TPM_PACE_MAX_WAIT_MS` | `20000` | 策略 B：预计等待超过此时长则仍 clone。 |
| `GATEWAY_TPM_PACE_DELAY_MS` | `5000` | 策略 B：窗口已能塞下后再额外延迟。 |
| `GATEWAY_TPM_RESERVE_TTL_MS` | 跟随窗口 | 策略 B：预约超时自动释放，防止异常占额度。 |
| `GATEWAY_MIGRATION_MAX_INPUT_TOKENS` | `24000` | Key 轮换重建上下文时的估算 token 上限。 |
| `GATEWAY_INTERNAL_ERROR_RETRY_LIMIT` | `2` | 同一会话连续命中 `Internal error encountered` 后熔断，后续请求 HTTP 400、不再打上游。 |
| `GATEWAY_HASH_IGNORE_PREFIXES` | `["<RAG-Faiss-Memory>"]` | 算 `prefix_hash` 前剥离的字面量前缀。JSON 数组或换行分隔。 |
| `GATEWAY_MODELS` | 四个 Flash 底层型号 | `/v1/models` 默认目录。JSON 数组或换行分隔。可在 WebUI 运行时覆盖，不必改代码。 |

以上 TPM / 迁移项是启动默认值。WebUI「协议中转站」和 `GET/PATCH /api/gateway/settings` 可在运行时覆盖，不必重启。优先级：WebUI / 管理 API > 环境变量 > 代码默认。每把上游 Key 还会显示本分钟 RPM（内存）和今日 RPD（SQLite，洛杉矶午夜对齐 Google AI Studio）。

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
| `GET` | `/v1/models` | 网关模型目录（WebUI 里添加的名字，无 Antigravity 前缀）。 |

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

在 `.env` 中设置 `GATEWAY_MASTER_KEY` 和 `GATEWAY_ADMIN_TOKEN`，重启后打开「协议中转站」面板。添加加密保存的上游 Gemini Key（面板里一直显示、可复制），再创建下游 `ag-` Token（发行后也会一直显示、可复制）。其他应用只应使用该 Token，不要再传 Gemini Key。TPM 策略、限额、排队等待、迁移 input 预算和对外模型目录也在同一面板修改。

网关始终调用 Interactions：`agent: "antigravity-preview-05-2026"`，`environment: "remote"`（或复用已有环境 ID）。不会走 `generateContent`（对该 agent 会 400）。下游请求里的 `model` 会原样写入 `agent_config.model`。Google 更新型号时，在「对外模型目录」里添加即可，不必改项目。

可配置多把上游 Gemini Key。新会话按最近最少使用轮询；同一会话会粘在原来的 Key 上，因为 `environment_id` / `previous_interaction_id` 不能跨 Key 复用。某把 Key 连续 3 次 429 时，会把当前对话带到下一把 Key 上开**新沙盒**继续。默认 TPM 策略（`clone`，旧名 `frok`）在用量达到 `上限 × 比例` 时同样迁移。可选 `pace` 策略会钉住原 Key，等到 `已用量 + 本轮` 严格小于 TPM 窗口再发；预计等待超过 `tpmPaceMaxWaitMs` 仍 clone。本轮大小优先用该会话最近一次成功 `total_tokens`（含 fork 主干/分支 key），否则按视觉 token 估算 inline 图片（大约 1k–3k / 张，不再把 Base64 当 `chars/4`）。下游 `conversation_mode` 仍为 `continue`，上游记为 `clone`（Key 轮换重建），不是 `new`。工具历史以不可执行摘要迁移，不再生成 `[Calls:]` 模板，避免模型模仿假工具调用（旧沙盒里的文件带不过去）。

标准 OpenAI 客户端不必传私有会话字段。若客户端压缩、截断或重放旧消息，且网关无法证明与主干连续，会 **fork** 到内部派生 key，主干 `interaction_id` 保持不变。

### 多会话隔离与并发控制

- **会话隔离**：客户端（如 QQ 机器人、多窗口聊天客户端）应在请求头中传入 `x-session-id`（例如 `qq:private:{user_id}` 或 `qq:group:{group_id}`）。每个会话拥有完全独立的上下文链与远程沙盒环境，共用同一把 API Key 也绝不会发生串台。
- **并发互斥锁**：同一 `x-session-id` 的并发请求会在服务端自动排队串行处理，防止旧请求覆盖新交互状态；超出排队上限时返回 HTTP 429 `session_busy`。
- **全链路诊断日志**：每个请求分配唯一 `request_id`，自动脱敏 API Key、Authorization 头、超大图片 Base64 与系统指令。日志同时记录 `conversation_mode`（`continue` / `new` / `fork`）和 `upstream_transition`（`none` / `clone`）。模型文本中的 `[Calls:]` 只计数观测，不会被解析或执行。

> **注意**：Google 目前没有 API 查询 managed agent 支持哪些 `agent_config.model`。因此目录可在 WebUI 编辑（`PATCH /api/gateway/settings` 的 `gatewayModels`，或环境变量 `GATEWAY_MODELS`）。`/v1/models` 返回这些名字，没有 `antigravity-preview-05-2026/` 前缀。目录里没有的名字同样会透传到上游 `agent_config.model`。

多轮对话使用服务端 `previous_interaction_id`。能证明连续时，回传的 `messages[]` 只用来计算本轮增量，不会整段再发一遍；无法验证的压缩或截断历史会 fork，而不是硬接旧链。支持图片；TPM / 迁移预算按图片尺寸估算（解析不了时按 2800 token），不用 Base64 长度。OpenAI `tools` 会变成自定义函数并由客户端执行；远程 MCP URL 可通过 `extra_body.mcp_servers` 传递。本机 stdio MCP 无法在 Google 沙盒里运行。

网关**不会**列出该 API Key 名下的普通 Gemini 模型目录。`GET /v1/models` 返回你添加的名字（默认如下）。客户端应直接填这些名字，不要带 `antigravity-preview-05-2026/` 前缀：

- `gemini-3.7-flash`（请求未带 `model` 时的默认值）
- `gemini-3.6-flash`
- `gemini-3.5-flash`
- `gemini-3.5-flash-lite`

带前缀的旧写法如 `antigravity-preview-05-2026/gemini-3.7-flash` 仍然可用，发给上游前会去掉前缀。

```powershell
curl.exe http://localhost:3000/v1/chat/completions `
  -H "Authorization: Bearer ag-YOUR_TOKEN" `
  -H "Content-Type: application/json" `
  --data-raw '{"model":"gemini-3.7-flash","messages":[{"role":"user","content":"ping"}]}'
```

## 数据与隐私

SQLite 默认位于 `data/antigravity.db`，会保存 Prompt、模型输出、执行步骤、Token 用量、错误摘要和产物路径。它不会保存 API Key，但这些内容本身可能敏感，请勿提交到公共仓库。

快照 TAR 临时位于 `data/snapshot-cache/`，数据库、WAL 文件、缓存、`.env`、日志和本地产物都已加入 `.gitignore`。

更多安全约束见 [SECURITY.md](SECURITY.md)。

## 项目结构

```text
server.js             Express API、Gemini 调用、文件提取和网关挂载
gateway/              OpenAI / Gemini 协议适配、Token 鉴权、管理 API 与 TPM 设置
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
