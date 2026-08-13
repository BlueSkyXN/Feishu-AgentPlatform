# 常见问题

## 当前平台是什么技术栈？

TypeScript、Node.js ESM、飞书 Node SDK 与 Pi SDK。默认 Node.js 24，最低版本见 `package.json#engines`。

## 多个飞书应用和多个 Agent 如何关联？

`config/apps/` 定义 `FeishuApp`，`config/agents/` 定义可复用 `AgentDefinition`，`config/bindings/` 定义 N:N `AppAgentBinding`。每个 App 必须有且只有一个 default Binding，其他 Binding 通过命令或 allowlist 路由。

## 不同 App、Agent、群聊和话题会串上下文吗？

不会。`ConversationSession` key 包含 `appKey + agentId + tenantKey + chatId + topicKey`。同一 key 串行，不同 key 可以并行。

## 同一飞书 App 会为每个 Agent 建立一条 WebSocket 吗？

不会。每个 `FeishuAppRuntime` 只创建一套 Channel、OAuth、去重窗口和 App 凭据上下文，再由 Binding Router 把消息分配给 Agent。

## WS 与 HTTP 可以同时使用吗？

可以。常见组合是事件走 WS、卡片回调走 HTTP。事件也可选择 HTTP；公开路径必须全局唯一。

## WorkspaceGuard 能执行代码吗？

不能。它只提供当前会话 Workspace 的 list/read/search 和可选 write，没有 Shell、PTY、网络、包安装、子进程或后台服务。

## 为什么不提供任意命令执行？

当前产品目标是飞书内部 Agent 与受控文件工作区，不是通用 Coding Agent。需要执行不可信代码时，应在自建环境设计独立容器或 VM 执行服务，不扩大 Trusted Host 的文件工具。

## 飞书操作是否只能读？

V0.1 对飞书业务数据严格只读。typed Feishu write tool 和非只读 `lark-cli` operation 会在统一配置加载边界被拒绝；`workspace.write` 只作用于受限的本地 Conversation Workspace，不属于飞书业务写。

## 可以使用 `lark-cli` 和 Skill 吗？

可以。新配置使用 `AgentDefinition.larkCli.operations` 固定 command、flags、effect 和 approval；旧 `allowedCommands` 会在加载期被拒绝。Skill 只是模型说明，不授予飞书权限、身份或 Host 工具。

## 为什么 `/readyz` 显示 `setup_required` 但返回 200？

这表示空库时管理面已可访问，可通过 HTTPS `/admin` 创建并发布首个 active revision；业务 App 和 Broker 尚未 ready。发布配置后若 App/Broker 失败，`/readyz` 会返回 503。

## SQLite 备份后为什么 Vault 仍无法解密？

Vault master key 不存入 `/data/feishu-agent-platform/platform.db`。可用 `platformctl config backup [file]` 创建 SQLite 备份，并用 `platformctl config restore <file> --confirm=RESTORE` 校验后原子恢复，但 `PLATFORM_MASTER_KEY` 仍必须作为独立 Secret 备份；数据库和 key 应分开控制权限。丢失 key 后只能重新录入 credential。

## Cloudflare Token 会进入 Pi Worker 吗？

不会。Token 只留在 Host Model Broker；Worker 使用短期 capability 调用 loopback broker。

## HF Space 能长期保持飞书 WS 吗？

只有常驻实例才能可靠保持长连接。会休眠的实例会导致离线或回调失败，必须在目标 Space 实测。

## 为什么必须提交 `package-lock.json`？

锁文件固定传递依赖并使 `npm ci` 使用相同解析结果。`@larksuite/cli@1.0.79` 也是 exact production dependency，Docker 从 `/app/node_modules/.bin` 启动而非全局安装。仓库已经包含锁文件；升级依赖时必须同步提交并让 exact-head quality gate 复验。

## 为什么 Restore 拒绝当前数据库、WAL 或 SHM？

Restore 必须从独立 SQLite 备份恢复，不能使用目标本身或同 inode 文件；目标旁存在 `-wal/-shm` 时表示 Host 可能仍在写入，CLI 会直接拒绝。CLI 在目标同目录 temp 中验证 header、`schema_migrations` 记录、核心配置表和 `PRAGMA integrity_check`，fsync 后原子替换，并保留 `pre-restore-*` 旧库，避免半写入覆盖唯一可回滚副本。
