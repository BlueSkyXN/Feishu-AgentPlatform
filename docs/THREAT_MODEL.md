# 威胁模型

## 保护目标

- 飞书 App、HTTP 校验、OAuth、Cloudflare 和管理凭据；
- 用户身份、聊天历史、文档、附件和工具结果；
- App、Agent、Binding、租户、聊天和话题之间的会话隔离；
- SQLite revision/audit/Vault、Session、Workspace 与备份数据；
- Public、Internal 与 Model Broker 三个网络平面；
- 配置、依赖、镜像和发布供应链。

## 信任边界

```text
Internet / Feishu / model output / user content（不可信）
  -> Public ingress / authenticated Admin / FeishuAppRuntime（可信 Host）
  -> BindingRouter / AppAgentBindingRuntime（可信 Host）
  -> Pi Worker（受限子进程，不持有长期凭据）
  -> Host Tool Broker / WorkspaceGuard / Model Broker（可信 Host）
  -> Feishu API / Cloudflare AI Gateway（外部系统）
```

Prompt、Skill、聊天、文档、附件和模型输出都不是权限来源。真正权限来自 FeishuApp 身份、Agent 工具 allowlist、Binding 会话上下文与 Host 参数校验。

## 攻击者模型

考虑恶意或被污染的用户消息、群成员、文档、附件、Skill、模型输出、配置 PR、依赖和外部 API 响应。也考虑错误运维导致的跨 App 路由、公开管理端口、Secret 误提交和数据目录混用。

当前平台不执行不可信代码。WorkspaceGuard 不是容器或 VM，Pi Worker 也不是 OS 级强隔离环境。

## 已实现控制

### 领域与会话隔离

- FeishuApp、AgentDefinition 与 AppAgentBinding 分离；
- App 与 Agent 只通过显式 Binding 关联；
- 每个 App 必须有唯一 default Binding，路由并列时拒绝；
- ConversationSession key 包含 appKey、agentId、tenantKey、chatId、topicKey；
- Session 与 Workspace 按 appKey/agentId/storageId 分目录；
- configured `workspace.root/sessionRoot` 必须位于 resolved `DATA_ROOT` 内，Workspace 总量与附件 per-Turn 预算分别受限；
- 同会话串行，Binding 和全局并发受限。

### 凭据边界

- App Secret 与 OAuth Token 只存在对应 FeishuAppRuntime；
- Cloudflare Token 只存在 Host Model Broker；
- Pi Worker 只接收短期 capability、隔离目录和明确工具描述；
- Worker 释放时撤销 capability；
- Prompt、Skill、Workspace、`lark-cli` 参数和工具结果不接收长期凭据。
- 共享 Pi SDK session core 强制 `PI_OFFLINE=1` 与 `PI_TELEMETRY=0`，process Worker 子进程环境也固定相同值，并关闭 install telemetry/provider attribution 和 create-time model catalog network refresh；业务模型流量只经 Host Model Broker。

### 飞书与工具

- V0.1 配置加载器拒绝 typed Feishu write tool 和非只读 `lark-cli` operation；
- `openapi.get` 仅允许 GET 与路径前缀 allowlist；
- lockfile 固定的 `@larksuite/cli@1.0.79` 使用独立 strict bot profile、固定 operation/flags、`shell=false`、最小环境和输出脱敏；
- 附件下载按 header 提前拒绝并逐 chunk 执行 per-item/remaining-total 硬限制，超限立即销毁 stream，只以安全 Workspace 相对路径落盘；
- dormant 写协议和审批基础设施不构成 V0.1 可发布能力；
- Host 负责回复当前入站消息，Agent 没有通用跨聊天发送工具。

### WorkspaceGuard

- 只接受相对路径，拒绝绝对路径、父穿越和 NUL；
- 逐级校验真实路径与 symlink；
- 读写大小受限，写入使用私有临时文件和原子替换；
- 不提供 exec、Shell、PTY、网络、包安装或后台服务。

### 网络与供应链

- Public 只暴露 7860；Public Admin 使用 Secure Cookie、CSRF、TTL 和限流；Internal 8788 与 Model Broker 8790 强制 loopback；
- 只有精确 trusted proxy socket peer 才能提供 XFF 第一跳，默认不信任转发头；
- Internal 管理使用 Bearer Token；
- Vault 使用 AES-GCM，管理面不回显 Secret，master key 由独立部署 Secret 注入；
- npm 使用锁文件和 `npm ci`，锁定 Pi 与 `@larksuite/cli` production dependency，并在 CI 执行 production `npm audit`；
- CI/Container/HF/Release 复用 exact-head quality gate，执行 production dependency audit、仓库策略、文档、类型、测试、构建和镜像 setup smoke；CodeQL、PR Dependency Review 与定时 Dependency Audit 由独立 workflow 执行；
- 发布归档由 deterministic Node ZIP writer 生成 SHA-256 和逐文件 manifest，已存在 Release 只接受 byte-identical 资产。

## 不保证与残余风险

- Pi Worker 与 Host 仍共享容器、内核和部分 OS 资源；
- 同 UID 或依赖漏洞可能尝试窃取尚未撤销的短期 capability；
- WorkspaceGuard 防路径逃逸，不提供恶意代码隔离；
- 外部飞书和模型 API 的权限、限流、可用性与内容安全不由本地测试保证；
- 文件 lease 依赖共享存储的原子语义；
- HF 休眠、网络和持久化行为必须在目标 Space 验收；
- SQLite 文件不是全库加密，WAL/备份一致性和 master key 生命周期需要独立运维；
- 管理台位于 Public plane，TLS/反向代理或 allowlist 误配会扩大攻击面；
- 内存审批和 admin session 在重启时丢失，多实例需要额外协调；
- 日志、备份、CI artifact 和运维脚本仍可能因配置错误泄漏敏感数据。

## 安全变更原则

以下变更必须单独安全评审：新增飞书写工具、允许跨聊天读取、改变 Binding 路由、修改会话键或存储布局、扩大 Workspace 能力、把长期凭据传入 Worker、公开 Internal/Model Broker、放宽 Secret 或日志策略。
