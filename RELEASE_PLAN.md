# GitHub 发布整理计划

更新时间：2026-08-03

## 当前进度

已完成：

- 检查项目结构、敏感文件和 Git 忽略规则。
- 确认代码中没有硬编码的 Gemini API Key、GitHub Token 或私钥。
- 将服务默认监听地址调整为 `127.0.0.1`。
- 增加浏览器来源限制，并保留 `ALLOWED_ORIGINS` 显式配置。
- 移除不再需要的开放式 `cors` 依赖。
- 增加来源限制单元测试。
- 增加 `.env.example`、`LICENSE`、`SECURITY.md` 和 `CHANGELOG.md`。
- 补充 `package.json` 的许可证、关键词和 `verify` 脚本。

验证结果：

- `npm run verify` 已通过：22 项测试全部通过。
- 临时服务验证已通过：默认监听 `127.0.0.1`，本地来源返回 200，陌生来源返回 403。
- 临时数据库、日志和快照缓存已清理；用户原有数据库与迁移备份未改动。

## 发布前清单

- README、WebUI 内置说明、`CHANGELOG.md` 和版本号均为 1.4.0。
- `LICENSE`、`SECURITY.md` 和 `.env.example` 已加入。
- `data/*.db*`、`data/snapshot-cache/`、`.env` 和常见日志已加入忽略规则。
- 尚未初始化 Git，也未创建或上传远程仓库。

## 发布前需要用户决定

- GitHub 仓库名称。
- 公开仓库还是私有仓库。
- 是否需要 README 截图或演示 GIF。
- 是否由 Codex 初始化 Git、创建首次提交并上传；任何远程上传操作都需要单独确认。
