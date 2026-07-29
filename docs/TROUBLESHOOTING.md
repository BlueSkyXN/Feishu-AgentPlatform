# 故障排查

## 启动即退出

先执行：

```bash
npm run platformctl -- doctor
npm run platformctl -- validate
npm run platformctl -- list
```

常见原因：环境变量缺失、App ID 重复、Agent 或 App 引用不存在、每个 App 没有且仅有一个 default Binding、非 default Binding 无路由条件、公开路径重复、`workspace.root/sessionRoot` 逃出 resolved `DATA_ROOT`、端口冲突，或 Model Broker 配置不完整。

## `/healthz` 正常但 `/readyz` 为 503

`healthz` 只表示 HTTP 进程存活。检查 Internal status：

```bash
curl -sS \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8788/api/v1/status
```

重点查看 App 启动错误、分片/lease 状态、Binding 数量和 Model Broker。`MODEL_PROVIDER_POLICY=host-broker-only` 时，Broker 必须启用且上游配置完整。

## 飞书 WebSocket 无消息

- `FeishuApp.events.transport` 是否为 `websocket`；
- App 已发布并开启机器人能力；
- 事件订阅、权限和测试范围正确；
- 当前实例拥有该 App lease，不是 standby；
- App policy 允许当前私聊/群聊且满足 mention；
- 消息是否因 Binding 无匹配或歧义被拒绝。

## HTTP 回调 404 或校验失败

- 飞书 URL 与 `config/apps/<id>.yaml` 的 path 完全一致；
- Public 7860 可达，反向代理未改写路径；
- App 的 Verification Token 环境变量存在；
- 启用加密时 Encrypt Key 正确；
- 多个 App 的 events、callbacks、OAuth path 全局唯一；
- body 未超过 `PUBLIC_HTTP_BODY_LIMIT_BYTES`。

## Binding 路由不符合预期

- 每个 App 恰有一个 `route.default: true`；
- 命令前缀、chat/user/thread allowlist 使用飞书实际 ID；
- 同一 Binding 的非空 allowlist 是 AND 关系；
- 检查 `priority`、命令前缀长度和条件数量；
- 并列最高优先级会被拒绝，不按文件顺序兜底；
- 命令前缀进入 Pi 前会被 Host 去除。

## 模型调用失败

检查：

```dotenv
MODEL_BROKER_ENABLED=true
MODEL_BROKER_HOST=127.0.0.1
MODEL_BROKER_PORT=8790
MODEL_PROVIDER_POLICY=host-broker-only
```

然后确认 Cloudflare Account/Gateway ID、Gateway Token、`AgentDefinition.provider=host-broker`、`modelApi` 和 `upstreamPath`。区分 capability 认证失败、上游 401/403、429、5xx、超时和模型协议不匹配。

不要把 Cloudflare Token 写入 Agent 配置或 Worker 环境作为临时修复。

## `lark-cli` 工具失败

- `AgentDefinition.tools.feishu` 包含 `larkcli.run`；
- `larkCli.enabled=true` 且目标 operation ID 存在；
- `lark-cli --version` 精确为 `1.0.79`，与 `expectedVersion` 一致；
- executable 在 Host 可执行；
- 固定 command、requiredFlags、allowedFlags、effect 和 approval 正确；
- bot profile 能在 `<DATA_ROOT>/lark-cli/<appKey>` 初始化，且持久卷可写；
- 写操作的 HTTP card callbacks、requester/admin operator 和 `ADMIN_OPEN_IDS` 已配置；
- 固定 CLI 版本的实际命令、scope 和输出 shape 已在真实飞书身份下验收。

## Workspace 文件无法读取或写入

- Agent 的 `workspace.mode` 与 `tools.workspace` 一致；
- 使用相对路径，不包含 `..`、NUL 或绝对路径；
- 目标及父目录不是 symlink；
- 文件大小未超过 `maxReadBytes/maxWriteBytes`；
- 当前 Session 的 appKey、agentId 和 storageId 正确；
- 读写失败不代表可以绕过 WorkspaceGuard 直接访问 Host 文件。

Workspace 默认持久总量为 `maxTotalBytes=268435456`、`maxFiles=10000`。它们与附件单 Turn 的 `maxBytesPerItem/maxTotalBytes` 是不同限制；排查时先确认是哪一层拒绝。

## 附件下载被拒绝或中断

- 检查 `attachments.maxItems/maxBytesPerItem/maxTotalBytes`；
- 超限 `Content-Length` 会在读取前拒绝，但缺失、大小写变化或不可信长度仍会在逐 chunk 计数时受硬限制；
- 单项可用额度是 per-item 上限与本 Turn 剩余 total 的较小值，超过后 stream 会立即销毁；
- 失败或不完整资源不会计入已接受 total；Node Readable 最多可能预取一个 chunk，不会继续消费完整超限流；
- 成功路径应是当前 Workspace 下的 `attachments/<safe-message-id>/<序号>-<sanitized-name>`，日志和 Prompt 不应出现 Host 绝对路径。

## 会话串线或历史不正确

v2 key 必须包含：

```text
appKey + agentId + tenantKey + chatId + topicKey
```

检查 Binding 的 `conversation.scope`、飞书事件中的 thread/root、历史过滤、App 与 Agent 是否复用了错误的数据目录，以及升级时是否混用了旧布局。Internal sessions API 可按 appKey 查看运行态，但日志中应只记录 key 的哈希或截断值。

## HF Space 启动后找不到配置

源码仓库只提交 `*.yaml.example`。正式 GitHub HF workflow 不复制 active manifests，因此空数据库应进入 setup mode。只有显式选择 YAML seed 时才自行准备 `config/apps/*.yaml`、`config/agents/*.yaml`、`config/bindings/*.yaml`，并提前配置全部引用凭据。

默认 secondary App 关闭。启用它时同时启用对应 Binding、保证存在 default Binding，并配置第二组 Space Secrets。Secret 值不能写入 YAML。

## HF Space 重启后状态丢失

- `DATA_ROOT` 是否为 `/data/feishu-agent-platform`，`PLATFORM_DATABASE_PATH` 是否为 `/data/feishu-agent-platform/platform.db`；
- Space 是否已启用持久化；
- SQLite/WAL、Session、Workspace、OAuth、附件和 lark-cli profile 是否写入该根目录；
- 新旧版本的会话键和目录布局是否兼容；
- OAuth 恢复是否使用原 encryption key，Vault 是否使用原 `PLATFORM_MASTER_KEY`。

## `/admin` 登录后立即又变成未登录

管理 session Cookie 强制 `Secure`。生产访问应确认浏览器使用 HTTPS，而不是普通域名上的明文 HTTP；Chromium 的 loopback 安全上下文例外只用于本机开发。确认反向代理保留 Cookie 和同源路径，且没有公开 8788/8790。检查 socket peer 是否精确列入 `ADMIN_TRUSTED_PROXY_ADDRESSES`，nginx 是否用 `$remote_addr` 覆盖而不是 `$proxy_add_x_forwarded_for` 追加 XFF。未信任代理时所有请求按代理 peer 共享限流桶；信任追加式 XFF 又会允许客户端伪造第一跳。

## `platformctl config restore` 被拒绝

- source 不能与当前数据库是同一路径或同 inode；目标数据库旁存在 `-wal/-shm` 时必须先停止 Host 并完成一致性备份；
- source 必须通过 SQLite header、`schema_migrations` 记录、核心配置表和 `PRAGMA integrity_check`；
- restore 在目标同目录 temp 中完成校验和 fsync，再原子替换；成功后检查 `pre-restore-*` 旧库并回读 active/draft、audit 与 Vault fingerprint；
- SQLite restore 不包含 Session、OAuth、附件、Workspace、lark-cli profile 或 encryption keys。

## `/readyz` 返回 `setup_required`

这是空库的预期状态，不是故障。通过 HTTPS `/admin` 保存 Draft、配置 Vault、发布 active revision并回读 audit。若已经发布却仍显示 setup，检查 `PLATFORM_DATABASE_PATH` 是否指向同一持久文件；若改为 503，则检查 active revision validation、App 和 Broker 启动错误。

## HF Space 被平台暂停或 abuse-handler 拦截

先使用官方 `hf spaces info <owner/space> --expand sha,runtime,subdomain --json` 回读 `stage`、`errorMessage` 和 `abuse`。`PAUSED`、`Flagged as abusive` 属于平台状态，不等同于 Docker build error，也不能通过反复创建新 Space 规避。保留 GitHub source SHA、HF repository SHA、workflow run 与用途说明，按 Hugging Face 支持/申诉流程处理；解除前部署 job 应失败，不能把 Git push 成功写成可预览。
