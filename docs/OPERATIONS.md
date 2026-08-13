# 运维

## 启动前

先在 clean checkout 中、创建 `.env` 和 active YAML 之前执行源码交付检查：

```bash
npm run repository:check
npm run hf:preflight
```

准备本机/部署环境和 active manifests 后，再执行 Host 配置检查：

```bash
npm run platformctl -- doctor
npm run platformctl -- validate
npm run platformctl -- list
```

`doctor` 检查 Host 环境，`validate` 加载 apps、agents、bindings；它们不替代 SQLite 发布回读、飞书、Cloudflare 或 HF 的真实联调。

## 运行信号

- Public `/healthz`：HTTP 进程存活；
- Public `/readyz`：空库时 HTTP 200 + `setup_required`；业务配置已发布且 App/Broker 成功时 HTTP 200 + `ready`；已有 active revision 但启动失败时 HTTP 503；
- Public `/admin`：setup 和 revision/Vault 管理台，只能经 HTTPS 使用；
- Internal `/metrics`：Prometheus 指标；
- Internal `/api/v1/status`：App、Agent、Binding、Session、队列和 Broker 状态。

详见[可观测性](OBSERVABILITY.md)。

## 容量控制

- 全局：`MAX_CONCURRENT_TURNS_GLOBAL`；
- Worker 驻留与启动风暴：`MAX_RESIDENT_PI_WORKERS`、`MAX_CONCURRENT_WORKER_STARTS`；
- 每 Binding：`conversation.maxConcurrentTurns`；
- 每 ConversationSession：串行执行、`maxPendingTurns`、`queuedTurnTtlSeconds`；
- Session 驻留：`maxResidentSessions` 与 `idleTtlSeconds`；
- 工具和单 Turn：各自 timeout；
- Workspace 持久目录：单次读写限制，以及 `maxTotalBytes=268435456`、`maxFiles=10000` 总量边界；
- 附件：每 Turn 的 `maxItems/maxBytesPerItem/maxTotalBytes`，独立于 Workspace 总容量。

容量规划至少考虑 Pi Worker 内存、模型并发和 Token 预算、每个 App 的飞书限流、Binding 队列、附件、Session、Workspace、lark-cli profile、SQLite WAL 和审计增长。

Workspace 总量是 Host 受控写入口的应用层限制，不是 filesystem quota。多进程共享同一 `DATA_ROOT` 时必须维持单 App/单 Workspace 写者；需要抵御所有进程级磁盘写入时，应另配卷配额和平台级磁盘告警。

## setup mode 与发布

空库 `setup_required` 是可运维状态，不是业务 ready。至少检查：

1. `/admin` 经 HTTPS 可访问且 `ADMIN_TOKEN` 登录成功；
2. `PLATFORM_DATABASE_PATH` 位于持久卷，容器/HF 为 `/data/feishu-agent-platform/platform.db`；
3. `PLATFORM_MASTER_KEY` 已从 Secret 注入且有独立备份；
4. Draft 校验、Publish、active revision 和 audit 均能读回；
5. Publish 后再次检查 `/readyz`，并对真实 App/Broker 单独验收。

Rollback 会创建并发布新的 revision，不会抹掉历史。Publish/Rollback 返回 `runtime_apply_failed` 时，数据库 active revision 已切换但运行时应用失败，并已记录 `config.runtime_apply_failed`；应先读回 config/audit，再决定修正或再次回滚。实际 reload/restart 方式和业务 smoke 必须另行记录。

## V0.1 飞书只读策略

- 读取操作固定 `approval=never`；
- typed Feishu write tool、`lark-cli effect=write` 与 `high-risk-write` 均在配置加载时拒绝；
- `workspace.write` 仅修改当前 Conversation Workspace，仍受 mode、路径、symlink 和配额限制；
- 审批记录和管理页面仅为历史/未来兼容保留，V0.1 不应产生外部写审批。

## ConversationSession 生命周期

- 消息路由到 Binding 后构造 v2 conversation key；
- Turn 开始时保留 Session 引用；
- Turn 结束后保留到 `idleTtlSeconds`；
- Maintenance 只回收空闲 Worker，持久 Session 与 Workspace 继续保留；
- `/reset` 删除当前会话历史；
- `/abort` 中止当前模型和工具调用。

Reset/abort 必须校验 key 的 appKey 与 agentId 属于目标 App 和 Binding。Agent 已从 active 配置删除时，持久索引中的 orphan Session 仍可永久清理；清理继续要求完整 `storageId` 二次确认、Session 路径匹配和 `DATA_ROOT` containment。

附件下载先检查响应 `Content-Length`，并始终逐 chunk 累计实际字节。每项硬上限是 `min(maxBytesPerItem, maxTotalBytes - 本轮已接受字节数)`；超限立即 destroy stream，失败或不完整资源不计入本轮 total。成功文件只写入 Conversation Workspace 的安全相对路径，日志不记录 Host 绝对路径。

## 多实例、分片与租约

- `APP_SHARD_COUNT/INDEX` 决定 App 的确定性分片；
- 同一飞书 App 的活动实例由 SQLite 中的 `feishu-app:<appId>` 租约控制；
- standby 实例不消费该 App 的事件；
- 所有候选实例必须一致访问 lease、Session 和 Workspace；
- 不具备可靠共享原子文件语义时使用单实例。

## Model Broker 故障

检查：

1. `/readyz` 与 Internal status 中的 broker 状态；
2. `MODEL_BROKER_ENABLED=true`；
3. `MODEL_BROKER_HOST` 为 loopback，端口未与其他监听器冲突；
4. 上游 URL 为 HTTPS；
5. Cloudflare Account/Gateway ID 和 Token 已通过部署 Secret 注入；
6. Agent 使用 `provider: host-broker`，`modelApi` 与 `upstreamPath` 匹配；
7. Worker capability 未过期或被提前撤销；
8. 上游 429/5xx、预算和限流状态。

不得把 Gateway Token 临时下放给 Worker 作为绕过方案。

## 备份

版本化配置可单独导出或导入：

```bash
npm run platformctl -- config export config-export.json --slot=active
npm run platformctl -- config import config-export.json
npm run platformctl -- config import config-export.json --publish --note='受控恢复'
```

普通 import 进入版本化配置流程；只有显式 `--publish` 才请求立即发布。它不导入 Credential Vault 明文，也不能替代数据库或持久文件备份。

SQLite 优先使用受控 CLI：

```bash
npm run platformctl -- config backup platform-backup.db
npm run platformctl -- config restore platform-backup.db --confirm=RESTORE
```

Restore 拒绝 source 与当前数据库相同路径/同 inode；目标数据库旁存在 `-wal/-shm` 时也会拒绝，必须先停止 Host。它先在目标同目录 temp 中验证 SQLite header、`schema_migrations` 记录、核心配置表和 `PRAGMA integrity_check`，fsync 后原子替换，旧数据库保留为 `pre-restore-*`。完成后必须回读 active/draft revision、audit 和 Vault fingerprint。

`platformctl config backup/restore` 只覆盖 SQLite。仍需一致性备份 `DATA_ROOT` 下的 Pi Session、OAuth 加密记录、附件、Workspace、lark-cli profile 和必要 lease/状态文件；持续写入时不要手工只复制 `platform.db`、WAL 或 SHM。

Credential Vault 恢复必须使用原 `PLATFORM_MASTER_KEY`，OAuth 恢复必须使用原 OAuth encryption key。数据库与 master key 应分开备份和授权；任一 key 丢失都不能靠数据库恢复明文凭据。

不要把 `.env`、HF Secrets、Model Broker capability 或运行中临时文件写入公开备份。

## 升级

1. 一致性备份 `/data/feishu-agent-platform/platform.db`、`DATA_ROOT` 和独立 encryption keys；
2. 固定新镜像 Tag/digest；
3. 阅读 CHANGELOG 和配置迁移；
4. 对 apps、agents、bindings 运行 validate，并记录 active revision ID；
5. 用测试 App 验证 WS、HTTP、Binding、模型和工具；
6. 小流量切换并观察 ready、错误率、队列和限流；
7. 保留上一镜像、兼容的数据库备份与历史 revision 用于回滚。

若会话键或目录布局变化，必须提供显式迁移和回滚验证，不能让新旧 Worker 同时写同一数据。

## Secret 轮换

飞书 App credential 和 OAuth credential 可通过 `/admin` 写入 Vault，接口只回读 configured/fingerprint；确认新凭据运行生效后再撤销旧值。Cloudflare Gateway credential、`ADMIN_TOKEN` 与 `PLATFORM_MASTER_KEY` 只来自部署 Secret/环境变量，不进入 Vault。Master key 轮换必须先提供显式重加密迁移和回滚，不能只替换环境变量。各类凭据应分别记录恢复策略；发现泄漏时同时检查 audit、访问记录、日志与异常调用。
