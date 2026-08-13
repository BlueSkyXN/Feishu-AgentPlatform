# 管理台与 setup mode

管理台直接挂在 Public `7860`：

```text
GET  /admin
POST /api/admin/v1/auth/login
GET  /api/admin/v1/auth/sso/start?appKey=<id>
GET  /api/admin/v1/auth/sso/callback
GET  /api/admin/v1/auth/session
POST /api/admin/v1/auth/logout
GET  /api/admin/v1/overview
GET  /api/admin/v1/apps|agents|bindings
GET|POST /api/admin/v1/draft/apps|agents|bindings
PUT|DELETE /api/admin/v1/draft/<kind>/<id>
POST /api/admin/v1/draft/<kind>/<id>/copy|disable
GET  /api/admin/v1/config
PUT  /api/admin/v1/config/draft
POST /api/admin/v1/draft/validate
POST /api/admin/v1/config/publish|rollback
GET  /api/admin/v1/revisions[/<id>]
GET  /api/admin/v1/credentials
GET|PUT /api/admin/v1/apps/<appKey>/credentials
PUT|DELETE /api/admin/v1/credentials/<name>
GET  /api/admin/v1/sessions
POST /api/admin/v1/sessions/<storageId>/abort|reset
DELETE /api/admin/v1/sessions/<storageId>
GET  /api/admin/v1/approvals
POST /api/admin/v1/approvals/<id>/approve|deny
GET  /api/admin/v1/diagnostics/lark-cli
GET  /api/admin/v1/audit
```

## 首次启动

至少通过部署 Secret 设置：

```dotenv
ADMIN_TOKEN=<随机 32-byte 以上值>
PLATFORM_MASTER_KEY=<独立随机 32-byte 以上值>
PLATFORM_DATABASE_PATH=/data/feishu-agent-platform/platform.db
```

数据库没有 active revision 时，Host 进入 setup mode：

- `/healthz` 返回 HTTP 200，表示 HTTP 进程可用；
- `/readyz` 返回 HTTP 200 和 `status=setup_required`，表示管理面可用但尚无业务 App；
- `/admin` 可登录、保存 Draft、配置凭据并发布；
- 不应把 setup mode 当作飞书 App 或 Model Broker 已可用。

存在 active revision 后，Host 才按配置启动 App 与 Broker。此后 App/Broker 启动失败时 `/readyz` 返回 HTTP 503。

## HF 首次配置步骤

### 1. 部署控制面

首次 CD 只要求 HF Space 已保存：

```text
ADMIN_TOKEN
PLATFORM_MASTER_KEY
```

GitHub 侧另行保存部署专用 `HF_TOKEN` 和 `HF_SPACE_ID`；它们不进入应用 runtime。部署完成后先确认 `/readyz` 为 `setup_required`，管理台总览应显示“待首次配置”。

### 2. 配置模型 Host

发布任何启用的 App 前，在 HF Space Secrets/Variables 配置 Cloudflare Host 参数并重启 Space：

```text
CLOUDFLARE_API_KEY          Secret
CLOUDFLARE_ACCOUNT_ID       Variable
CLOUDFLARE_GATEWAY_ID       Variable
MODEL_PROVIDER_POLICY       Variable，保持 host-broker-only
```

Cloudflare credential 不能在管理台 Vault 中配置，因为 Host 在启动时从环境变量读取。

### 3. 创建 Draft

在管理台分别创建 App、Agent 和 Binding。下面是最小结构；ID 和路径可按实际测试 App 调整，Secret 明文不要写入 JSON：

```json
{
  "schemaVersion": 1,
  "apps": [
    {
      "id": "primary",
      "enabled": true,
      "appIdEnv": "FEISHU_PRIMARY_APP_ID",
      "appSecretEnv": "FEISHU_PRIMARY_APP_SECRET",
      "verificationTokenEnv": "FEISHU_PRIMARY_VERIFICATION_TOKEN",
      "domain": "feishu",
      "events": { "transport": "websocket", "path": "/public/feishu/primary/events" },
      "callbacks": { "transport": "http", "path": "/public/feishu/primary/callbacks" },
      "policy": {
        "requireMention": true,
        "dmMode": "open",
        "dmAllowlist": [],
        "groupAllowlist": [],
        "respondToMentionAll": false
      },
      "attachments": {
        "enabled": true,
        "maxItems": 6,
        "maxBytesPerItem": 12582912,
        "maxTotalBytes": 31457280,
        "passImagesToModel": true,
        "persistFiles": true
      },
      "identity": { "resolveUserProfile": true, "profileCacheTtlSeconds": 86400 },
      "oauth": {
        "enabled": false,
        "publicBaseUrlEnv": "PUBLIC_BASE_URL",
        "redirectPath": "/public/oauth/primary/callback",
        "scopes": [],
        "stateTtlSeconds": 600,
        "encryptionKeyEnv": "OAUTH_TOKEN_ENCRYPTION_KEY"
      }
    }
  ],
  "agents": [
    {
      "id": "general",
      "enabled": true,
      "systemPromptFile": "prompts/general.md",
      "provider": "host-broker",
      "model": "gpt-5.1",
      "modelApi": "openai-responses",
      "upstreamPath": "/openai",
      "modelOptions": {
        "reasoning": true,
        "input": ["text", "image"],
        "contextWindow": 400000,
        "maxTokens": 32768
      },
      "thinkingLevel": "medium",
      "runtime": { "isolation": "process", "workerShutdownGraceSeconds": 10 },
      "workspace": {
        "mode": "read-only",
        "maxReadBytes": 2097152,
        "maxWriteBytes": 2097152,
        "maxTotalBytes": 268435456,
        "maxFiles": 10000
      },
      "tools": {
        "defaultIdentity": "app",
        "allowCrossChatRead": false,
        "feishu": ["user.profile", "chat.info", "message.history", "doc.read"],
        "workspace": ["workspace.list", "workspace.read", "workspace.search"],
        "openApiReadAllowlist": []
      },
      "skillPaths": [],
      "larkCli": {
        "enabled": false,
        "executable": "lark-cli",
        "expectedVersion": "1.0.79",
        "timeoutMs": 60000,
        "operations": [],
        "skills": []
      }
    }
  ],
  "bindings": [
    {
      "id": "primary-general",
      "enabled": true,
      "app": "primary",
      "agent": "general",
      "route": {
        "default": true,
        "priority": 0,
        "commandPrefixes": [],
        "chatAllowlist": [],
        "userAllowlist": [],
        "threadAllowlist": []
      },
      "conversation": {
        "scope": "thread",
        "maxPendingTurns": 8,
        "idleTtlSeconds": 1800,
        "turnTimeoutSeconds": 300,
        "toolTimeoutSeconds": 60,
        "queuedTurnTtlSeconds": 300,
        "maxResidentSessions": 64,
        "maxConcurrentTurns": 4,
        "recentHistory": {
          "enabled": true,
          "maxMessages": 20,
          "maxCharacters": 30000,
          "currentThreadOnly": true
        }
      }
    }
  ]
}
```

### 4. 写入 App Vault

Vault 名称必须与 Draft 的 `*Env` 字段逐字一致：

| 名称 | kind | 值来源 |
|---|---|---|
| `FEISHU_PRIMARY_APP_ID` | `feishu-app-id` | 飞书测试应用 App ID |
| `FEISHU_PRIMARY_APP_SECRET` | `feishu-app-secret` | 飞书测试应用 App Secret |
| `FEISHU_PRIMARY_VERIFICATION_TOKEN` | `feishu-verification-token` | 飞书事件/卡片 Verification Token |

保存后只检查 `configured=true` 和 fingerprint；前端、API、日志与截图都不应再次显示明文。

### 5. Validate、Publish、回读

依次执行：

1. Validate Draft；
2. Publish 当前 Draft；
3. 重新读取 `/api/admin/v1/config`；
4. 记录 active revision ID、content SHA-256 和 audit event；
5. 检查 `/readyz`。成功运行应为 `ready`；`503 not_ready` 或 `runtime_apply_failed` 必须保留 active revision 回读和错误日志，不得只看前端提示。

## 认证与浏览器边界

`ADMIN_TOKEN` 是首次登录凭据，同时可供 loopback Internal API Bearer 认证。登录成功后使用随机内存 session；Cookie 固定为 `HttpOnly; Secure; SameSite=Strict`，写请求还必须携带 CSRF token。登录失败有速率限制，session 有 TTL，进程重启后需要重新登录。

直接连接时限流 key 使用 socket peer。只有 peer 精确匹配 `ADMIN_TRUSTED_PROXY_ADDRESSES` 中的 IPv4/IPv6 地址时，服务才读取 `X-Forwarded-For` 第一跳；空值表示不信任任何代理，列表不支持 CIDR 或通配符，`::ffff:a.b.c.d` 会先规范化为 IPv4。同机 nginx 应配置 `127.0.0.1,::1`，并把 XFF 覆盖为 `$remote_addr`，不能追加客户端提供的 XFF。

因为 Cookie 强制 `Secure`，浏览器管理台必须位于 HTTPS 后。HF Space 自带 HTTPS；Compose、Kubernetes 和 systemd 部署应配置 TLS Ingress 或反向代理。不要为了方便把 Cookie 降级为非 Secure，也不要公开 Internal `8788` 或 Model Broker `8790`。

日常登录可使用真实飞书 OAuth SSO。启用条件是：

1. `ADMIN_OPEN_IDS` 配置精确 `open_id` allowlist；
2. 至少一个正在运行的 App 启用了 `oauth`；
3. 飞书应用后台同时登记普通用户 OAuth 地址 `<PUBLIC_BASE_URL><oauth.redirectPath>` 与管理员地址 `<PUBLIC_BASE_URL>/api/admin/v1/auth/sso/callback`；
4. 登录页向 `/api/admin/v1/auth/sso/start?appKey=<id>` 发起跳转。

Admin callback 先由 state 中的 `appKey` 路由到对应 App，再由该 App 校验签名、TTL、一次性 state，并使用固定 Admin redirect URI 换取 Token。管理员身份只取飞书 Token 响应中验证后的 `open_id`，随后再匹配 `ADMIN_OPEN_IDS`；未验证的 query、callback body 或前端字段不能创建管理 session。

## Revision 与发布

配置库区分 active/draft：

1. 保存 Draft 时校验版本化文档外形，并使用 `expectedDraftRevisionId` 做乐观并发；实体可分步编辑；
2. 显式 Validate 与 Publish 会解析凭据、引用、路由、审批 callback、工具和运行时依赖；
3. Rollback 基于历史内容创建新的 active revision，不改写历史；
4. seed、draft、publish、rollback 和 credential 变更写入审计。

Publish 和 Rollback 都先提交新的 active revision，再尝试应用运行时。若数据库已切换但 runtime apply 失败，API 返回 HTTP 503 + `runtime_apply_failed`，并记录 `config.runtime_apply_failed` 审计；这不是数据库事务回滚，管理台必须重新读回 active revision。App 热加载成功也不替代滚动重启和真实业务验收。

## Credential Vault

App ID、App Secret、Verification Token、Encrypt Key 与 OAuth 加密材料可通过 AES-256-GCM envelope 存入 SQLite；列表和 API 只返回 `configured`、类型、fingerprint 与更新时间。明文只允许 Trusted Host 在构造 runtime config 时通过内部 resolver 读取，禁止进入 Worker、响应、日志和审计详情。

`ADMIN_TOKEN`、`PLATFORM_MASTER_KEY` 与 Cloudflare Gateway 凭据仍只来自部署 Secret/环境变量，不进入配置 Vault，也不由管理 API 返回。

`PLATFORM_MASTER_KEY` 不存入 SQLite。丢失该 key 时 Vault 密文不可恢复，只能重新录入；备份数据库时必须把 key 作为独立 Secret 备份并分别控制访问。

## 会话、审批与诊断

- Sessions 支持按 App、Agent、Binding 查询；`abort` 只终止当前 Turn，`reset` 串行清理 Pi Session，永久 `delete` 还需要输入完整 `storageId` 二次确认。即使 active 配置已删除所属 Agent，orphan Session 仍可清理；服务端使用受约束的 Session 身份和路径，并要求 workspace/session root 位于 resolved `DATA_ROOT` 内。
- Approvals 列表保留历史/未来兼容记录。V0.1 飞书业务能力严格只读，不应产生新的外部写审批。
- `lark-cli` 诊断显示 App profile、固定版本、初始化状态及 read/write/high-risk operation 数量；V0.1 中 write/high-risk 数量必须为 0。配置为 HTTP 不等于运行时就绪；版本不一致或 profile 初始化失败会使对应 Binding 与平台 readiness 失败。
