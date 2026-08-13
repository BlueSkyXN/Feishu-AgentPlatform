# 配置参考

## Host 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PLATFORM_CONFIG_ROOT` | `./config` | `apps/agents/bindings` 根目录 |
| `DATA_ROOT` | 本地 `./data`，生产镜像 `/data/feishu-agent-platform` | SQLite、Session、Workspace、OAuth、附件和 lark-cli profile 的持久根 |
| `PLATFORM_DATABASE_PATH` | `<DATA_ROOT>/platform.db` | revision、audit 与 Credential Vault SQLite 文件；容器/HF 固定 `/data/feishu-agent-platform/platform.db` |
| `PLATFORM_MASTER_KEY` | 无 | Vault AES-GCM master key；只允许部署 Secret，必须独立备份 |
| `PUBLIC_HTTP_HOST/PORT` | `0.0.0.0/7860` | 公网入口 |
| `ADMIN_TRUSTED_PROXY_ADDRESSES` | 空 | 逗号分隔的精确代理 IPv4/IPv6 地址；仅在 socket peer 命中后读取 XFF 第一跳，不支持 CIDR/通配符 |
| `INTERNAL_HTTP_HOST/PORT` | `127.0.0.1/8788` | 管理面；Host 强制 loopback |
| `ADMIN_TOKEN` | 空 | Internal API Bearer Token 与 Public `/admin` bootstrap 登录；至少 16 字符，生产使用随机 32-byte 以上值 |
| `ADMIN_OPEN_IDS` | 空 | 逗号分隔的飞书管理员 open_id，仅用于 admin tool approval/SSO allowlist |
| `TOOL_APPROVAL_TTL_MS` | `300000` | 历史/未来兼容审批记录 TTL；V0.1 不发布外部写能力 |
| `MODEL_BROKER_ENABLED` | 上游配置完整时自动启用 | Host 模型代理 |
| `MODEL_BROKER_HOST/PORT` | `127.0.0.1/8790` | 强制 loopback |
| `MODEL_BROKER_UPSTREAM_BASE_URL` | 自动拼 Cloudflare URL | 可选完整上游根地址，只允许 HTTPS |
| `CLOUDFLARE_ACCOUNT_ID` | 无 | Cloudflare Account ID |
| `CLOUDFLARE_GATEWAY_ID` | 无 | AI Gateway slug |
| `CLOUDFLARE_API_KEY` | 无 | 仅 Host 持有的 Gateway Token |
| `MODEL_PROVIDER_POLICY` | `host-broker-only` | 生产只允许 Agent 使用 `host-broker` |
| `MODEL_CAPABILITY_TTL_MS` | `900000` | Worker capability 滑动 TTL |
| `MODEL_CAPABILITY_MAX_LIFETIME_MS` | `21600000` | capability 绝对最长生命周期 |
| `MODEL_BROKER_ALLOW_NON_CLOUDFLARE_UPSTREAM` | `false` | 仅受控开发覆盖；生产保持 false |
| `MAX_CONCURRENT_TURNS_GLOBAL` | `16` | 全局 Turn 上限 |
| `MAX_RESIDENT_PI_WORKERS` | `24` | 全局驻留 Pi Worker 上限 |
| `MAX_CONCURRENT_WORKER_STARTS` | `4` | 并发 Worker 启动上限 |
| `APP_SHARD_COUNT/INDEX` | `1/0` | App 确定性分片 |
| `APP_LEASE_*` | 见 `.env.example` | App 活动实例租约 |

## FeishuApp

文件：`config/apps/<id>.yaml`。

```yaml
id: primary
appIdEnv: FEISHU_PRIMARY_APP_ID
appSecretEnv: FEISHU_PRIMARY_APP_SECRET
verificationTokenEnv: FEISHU_PRIMARY_VERIFICATION_TOKEN
encryptKeyEnv: FEISHU_PRIMARY_ENCRYPT_KEY
domain: feishu

events:
  transport: websocket
  path: /public/feishu/primary/events
callbacks:
  transport: http
  path: /public/feishu/primary/callbacks

policy:
  requireMention: true
  dmMode: open
  dmAllowlist: []
  groupAllowlist: []
  respondToMentionAll: false
```

`events.transport` 支持 `websocket/http/disabled`；`callbacks.transport` 支持 `http/disabled`。启用任意 HTTP 飞书入口时必须配置 `verificationTokenEnv`。所有 Public path 全局唯一。

App 还负责 `attachments`、`identity` 和 `oauth`。凭据字段只引用环境变量名，不直接写 Secret。

`attachments` 使用四个独立边界：`maxItems`、`maxBytesPerItem`、`maxTotalBytes` 和 Workspace 持久容量。真实 Lark Channel 优先通过 `rawClient.im.v1.image.get/file.get` 获取响应；`Content-Length`（大小写两种键）只用于提前拒绝，实际下载始终逐 chunk 累计。每项硬上限为 `min(maxBytesPerItem, maxTotalBytes - 本轮已接受字节数)`；超过剩余额度立即销毁 stream，只有完整下载且通过检查的资源才计入本轮 total。成功资源落到当前 Conversation Workspace 的 `attachments/<safe-message-id>/<序号>-<sanitized-name>` 相对路径，Prompt 和日志不返回 Host 绝对路径。Node Readable 可能预取一个 chunk，但不会继续消费完整超限流。

## AgentDefinition

文件：`config/agents/<id>.yaml`。

```yaml
id: office
systemPromptFile: prompts/office-assistant.md
provider: host-broker
model: claude-sonnet-4-6
modelApi: anthropic-messages
upstreamPath: /anthropic
modelOptions:
  reasoning: true
  input: [text, image]
  contextWindow: 200000
  maxTokens: 32768
thinkingLevel: medium

runtime:
  isolation: process

workspace:
  mode: read-only
  maxReadBytes: 2097152
  maxWriteBytes: 2097152
  maxTotalBytes: 268435456
  maxFiles: 10000
```

`modelApi` 支持 Pi 的 `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`。Cloudflare passthrough 的 `upstreamPath` 通常分别为 `/openai`、`/anthropic`、`/google-ai-studio`。

工具配置：

```yaml
tools:
  defaultIdentity: app
  allowCrossChatRead: false
  feishu: [user.profile, chat.info, message.history, doc.read]
  workspace: [workspace.list, workspace.read, workspace.search]
  openApiReadAllowlist: []
```

省略 `workspace.root/sessionRoot` 时分别使用 `<DATA_ROOT>/workspaces` 和 `<DATA_ROOT>/sessions`；显式值经 `resolve` 后必须等于或位于 resolved `DATA_ROOT` 内。公开 examples 有意省略，避免容器把数据错误写到只读 `/app/data`。`maxTotalBytes=268435456` 和 `maxFiles=10000` 是 Workspace 持久总量边界，不等同于单 Turn 附件的 `maxBytesPerItem/maxTotalBytes`。

`workspace.write` 只允许 `workspace.mode=read-write`，它只修改当前 Conversation Workspace，不属于飞书业务写。`openapi.get` 必须同时配置路径前缀 allowlist。V0.1 禁止在 `tools.feishu` 中配置任何写工具。

模型调用参数不包含 `identity`；身份始终由 `tools.grants` 决定。`approval.instance.detail` 与 `approval.instance.create` 是用户身份 API，启用时 grant 必须为 `identity: user`，并为当前消息发送者完成 OAuth。`approval.instance.get` 则是按 `instance_id` 的另一套 SDK endpoint，不要与按 `instance_code` 的 detail 契约混用。

```yaml
tools:
  feishu: [doc.read, base.records.list]
  grants:
    - name: doc.read
      identity: app
      effect: read
      approval: never
    - name: base.records.list
      identity: app
      effect: read
      approval: never
```

`larkcli.run` 优先使用结构化 operations，而不是让模型提交整条命令：

```yaml
larkCli:
  enabled: true
  executable: lark-cli
  expectedVersion: 1.0.79
  timeoutMs: 60000
  operations:
    - id: calendar-agenda
      command: [calendar, +agenda]
      effect: read
      approval: never
      allowedFlags:
        --calendar-id: {type: string, maxBytes: 256}
      requiredFlags: []
```

V0.1 的 `larkCli.operations` 只能使用 `effect: read` 和 `approval: never`；命令分类器也必须确认固定 command 为只读。

每个 operation 使用 bot identity；Host 固定 command、管理 `--as/--format` 等参数并校验 flags。`@larksuite/cli@1.0.79` 是精确 production dependency，由 `package-lock.json` 锁定；Docker 从 `/app/node_modules/.bin` 启动，不做 global install，运行诊断仍要求 executable 回读版本精确匹配。省略 `larkCli.root` 时使用 `<DATA_ROOT>/lark-cli`。

旧 `larkCli.allowedCommands` 不再兼容，加载时会直接失败；必须迁移为带固定 command、`allowedFlags`、effect 和 approval 的 `operations`。

`allowCrossChatRead=false` 时，`message.history` 只读当前聊天/话题，`openapi.get` 不允许通用 IM 路径，`larkcli.run` 的 IM 命令必须显式绑定当前 chat/thread/message。开启跨聊天读取前必须同时审核 App 权限和命令 allowlist。

## AppAgentBinding

文件：`config/bindings/<id>.yaml`。

```yaml
id: primary-office
app: primary
agent: office
route:
  default: false
  priority: 100
  commandPrefixes: [/office]
  chatAllowlist: []
  userAllowlist: []
  threadAllowlist: []
conversation:
  scope: thread
  maxPendingTurns: 8
  idleTtlSeconds: 1800
  turnTimeoutSeconds: 300
  toolTimeoutSeconds: 60
  queuedTurnTtlSeconds: 300
  maxResidentSessions: 64
  maxConcurrentTurns: 4
  recentHistory:
    enabled: true
    maxMessages: 30
    maxCharacters: 40000
    currentThreadOnly: true
```

约束：

- Binding 引用必须存在；
- 同一 `app + agent` 只允许一个 Binding；
- 每个 App 恰好一个无过滤条件的 default Binding；
- 同一 App 内命令前缀不可重复；
- 非 default Binding 至少一个路由条件。

## Secret 与实际配置

仓库只提交 `*.yaml.example`。实际 `.yaml` 和 `.env` 默认忽略。公开仓库不得提交真实 App ID、聊天/用户 allowlist、内部 URL、OAuth 数据或 Token。

## SQLite 配置与 Vault

SQLite 用两个 slot 表示 active/draft，并保留不可覆盖的历史 revisions。数据库空时进入 setup mode；管理台保存 Draft、校验、Publish 或基于历史 Rollback。Rollback 会创建新的 revision。`/api/admin/v1/config` 和 audit 回读才是数据库状态证据，YAML 或 UI 提交成功提示不能替代回读。

`platformctl` 提供受控导入、导出和数据库备份恢复：

```bash
npm run platformctl -- config import <file> [--publish] [--note=<text>]
npm run platformctl -- config export <file> [--slot=active|draft]
npm run platformctl -- config backup [file]
npm run platformctl -- config restore <file> --confirm=RESTORE
```

`config import/export` 操作版本化配置文档；`--publish` 才请求立即发布。`backup/restore` 操作 SQLite 数据库，不替代 Session、Workspace、OAuth、附件、lark-cli profile 或 encryption key 备份。Restore 拒绝 source 与目标相同路径/同 inode；目标数据库旁存在 `-wal/-shm` 时也会拒绝，要求先停止 Host。随后在目标同目录临时文件中验证 SQLite header、`schema_migrations` 记录、核心配置表与 `PRAGMA integrity_check`，fsync 后原子替换，并把旧库保留为 `pre-restore-*`。

Credential Vault 使用 `PLATFORM_MASTER_KEY` 加密。管理 API 只返回 configured/fingerprint；runtime resolver 才能在 Trusted Host 内部取明文。不得把 master key 写进 SQLite、YAML、Prompt、Skill、日志或 Worker 环境。
