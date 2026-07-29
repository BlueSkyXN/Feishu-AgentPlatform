# Changelog

## 0.1.0 — 2026-07-29

- 建立 `FeishuApp`、`AgentDefinition`、`AppAgentBinding`、`ConversationSession` 四层模型，支持一个 App 绑定多个 Agent，以及一个 Agent 跨多个 App 复用。
- 为每个 App 只创建一套飞书 WS/HTTP Channel、OAuth、准入策略和去重窗口；支持 WS Events、HTTP Events 与 HTTP Callbacks。
- 增加确定性 Binding 路由：default、命令前缀、群聊、用户和话题条件；最高优先级并列时拒绝路由。
- 使用 V2 会话键隔离 App、Agent、租户、聊天和话题；同会话串行，不同会话并行，并提供全局与 Binding 并发、排队、Turn、Tool 和空闲回收限制。
- 集成 Pi SDK，每个活跃会话默认使用独立 Worker；关闭 Pi 内置工具和隐式 Skill 扫描，只加载 Host 批准的 typed tools 与 Skills。
- 增加 Host Model Broker。Pi Worker 只持有可撤销的 Session capability，Cloudflare AI Gateway Token 保留在 Host。
- 将 `lark-cli` 作为 Pi-facing tool、Host-executed runtime 接入；提供只读命令白名单、参数限制、独立 HOME、最小环境、超时、输出上限和凭据脱敏。
- 保留轻量 `WorkspaceGuard`，支持受限目录列举、读取、搜索和可选写入；拒绝绝对路径、父目录穿越、NUL 与 symlink 逃逸。
- 提供飞书只读 SDK tools、附件处理、用户资料、当前聊天历史、用户 OAuth、流式卡片、会话命令和内部控制面。
- 移除旧版 Code Runner、native sandbox、远程 Sandbox、Shell、PTY、SSH、MicroVM 与相关构建链路。
- 提供 Node.js 22.19/24 CI、TypeScript 与测试门禁、CodeQL、Dependency Review、容器构建、GHCR、Release 和 Hugging Face Space HTTPS 同步工作流。
- 提供 Docker、Docker Compose、Kubernetes、systemd、配置示例、运维文档和可复现源码 ZIP 打包脚本。
- 固定并回读 `brace-expansion@5.0.8`，修复 Pi 0.82.1 shrinkwrap 嵌套依赖的已知 DoS 公告。
