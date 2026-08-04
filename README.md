# Antigravity Agent Web UI

一个本地运行的 Gemini Interactions API Web 控制台，面向 Google 托管的 `antigravity-preview-05-2026` managed agent。它可以创建或复用远程 Linux 沙盒，查看执行轨迹，保存本地会话，并安全提取沙盒中的文件。

> Unofficial community project. Antigravity managed agents and the Gemini Interactions API are preview features and may change without notice.

当前版本：**1.4.0** · Node.js **22.5+** · License **Apache-2.0**

## 这个项目解决什么问题

官方 API 可以运行 Agent，但原始交互不包含完整的本地工作台体验。本项目补上了这些能力：

- 在浏览器中提交任务并查看最终输出、工具步骤、Token 用量和错误详情。
- 使用 SQLite 保存会话、每轮交互、执行步骤、用量、错误和产物元数据。
- 同一个 `environment_id` 可以拥有多个独立本地会话：共享远程文件，但可以不继承旧的对话上下文。
- 从 Gemini Files API 下载完整环境 TAR 快照，并在服务端安全提取单个文件。
- 支持只输入文件名自动定位文件、快照缓存、强制刷新和二进制下载。
- 保留 Agent Base64 分块、file.io 和 catbox 作为兼容性备用通道。

本项目不是 OpenAI `/v1/chat/completions` 兼容中转站，也不是远程桌面或通用沙盒托管平台。

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

浏览器访问 <http://localhost:3000>，点击右上角“配置 API Key”。API Key 只保存在当前浏览器的 `localStorage`，不会写入 SQLite。

如果服务之前已经运行，修改代码后需要重启 Node.js 服务，再对页面执行一次强制刷新。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址。保持默认值可避免局域网暴露。 |
| `PORT` | `3000` | Web 服务端口。 |
| `ANTIGRAVITY_DB_PATH` | `data/antigravity.db` | SQLite 数据库路径。 |
| `SNAPSHOT_CACHE_DIR` | `data/snapshot-cache` | 环境 TAR 快照缓存目录。 |
| `SNAPSHOT_CACHE_TTL_MS` | `60000` | 快照缓存有效期，单位毫秒。 |
| `HTTPS_PROXY` | 空 | 服务端访问 Gemini API 时使用的 HTTPS 代理。 |
| `HTTP_PROXY` | 空 | 未设置 `HTTPS_PROXY` 时使用的 HTTP 代理。 |
| `PROXY_URL` | 空 | 兼容的备用代理变量。 |
| `ALLOWED_ORIGINS` | 本机来源 | 额外允许的浏览器来源，多个来源用逗号分隔。 |

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

## 数据与隐私

SQLite 默认位于 `data/antigravity.db`，会保存 Prompt、模型输出、执行步骤、Token 用量、错误摘要和产物路径。它不会保存 API Key，但这些内容本身可能敏感，请勿提交到公共仓库。

快照 TAR 临时位于 `data/snapshot-cache/`，数据库、WAL 文件、缓存、`.env`、日志和本地产物都已加入 `.gitignore`。

更多安全约束见 [SECURITY.md](SECURITY.md)。

## 项目结构

```text
server.js             Express API、Gemini 调用和文件提取路由
database.js           SQLite schema、迁移和会话持久化
environment-files.js  TAR 路径规范化与安全提取
snapshot-cache.js     环境快照缓存和并发下载合并
http-security.js      本地来源限制与 CORS 响应头
public/               WebUI、样式和前端交互逻辑
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
