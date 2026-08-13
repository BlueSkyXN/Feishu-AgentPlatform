# HTTP API

程序使用 Public 与 Internal 两个独立监听器。两者不能共用端口，Internal Host 必须是 loopback。

## Public plane：`0.0.0.0:7860`

| Method | Path | 用途 | 认证 |
|---|---|---|---|
| `GET` | `/healthz` | HTTP 进程存活 | 无 |
| `GET` | `/readyz` | 简化就绪状态 | 无 |
| `GET` | `/admin` | setup/config/Vault 中文管理台 | 登录页公开；操作需管理 session |
| `*` | `/api/admin/v1/*` | 管理认证、配置 revision、credential 和 audit | HttpOnly Secure Cookie + CSRF |
| `POST` | `FeishuApp.events.path` | 飞书 HTTP event | Verification Token；加密时再使用 Encrypt Key |
| `POST` | `FeishuApp.callbacks.path` | 飞书 HTTP callback | Verification Token；加密时再使用 Encrypt Key |
| `GET` | `FeishuApp.oauth.redirectPath` | 用户 OAuth callback | 一次性 state + code |

Public 错误不返回堆栈，JSON body 受 `PUBLIC_HTTP_BODY_LIMIT_BYTES` 限制。

### Health 与 readiness

```http
GET /healthz
```

```json
{"status":"ok"}
```

```http
GET /readyz
```

业务成功响应：

```json
{
  "status": "ready",
  "activeApps": 2,
  "failedApps": 0
}
```

空库 setup mode 返回 HTTP 200：

```json
{
  "status": "setup_required",
  "activeApps": 0,
  "failedApps": 0
}
```

`setup_required` 只表示管理面可以完成首次配置，不表示业务 ready。已有 active revision 但 App 或必需 Broker 启动失败时返回 HTTP 503，`status` 为 `not_ready`。

### Public Admin

管理台和 API 与飞书 ingress 共用 Public 7860，但认证模型与 Internal Bearer API 不同：

- `POST /api/admin/v1/auth/login` 使用 `ADMIN_TOKEN` bootstrap；
- `GET /api/admin/v1/auth/sso/start?appKey=<id>` 与固定 `/api/admin/v1/auth/sso/callback` 完成飞书 SSO；
- session Cookie 固定 `HttpOnly; Secure; SameSite=Strict`，有 TTL；
- GET session 可取得本次 session 的 CSRF token；
- PUT/POST/DELETE 必须发送 `x-csrf-token`；
- credential list/status 只返回 configured/fingerprint，写入响应不回显 Secret；
- `/admin` 必须经 HTTPS 使用，Public 管理台不代表可以公开 Internal 8788。

登录限流默认使用 socket peer。只有 peer 精确匹配 `ADMIN_TRUSTED_PROXY_ADDRESSES` 中的地址时才读取 XFF 第一跳；该变量为空时不信任任何代理，不接受 CIDR/通配符。边缘代理必须覆盖而不是追加客户端提供的 `X-Forwarded-For`。

基础资源：

```text
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

Draft 实体 mutation 应提交 `expectedDraftRevisionId`。永久删除实体必须提交完整实体 ID，永久清理会话必须提交完整 `storageId`。已删除 Agent 的 orphan Session 仍可由同一端点清理，但服务端继续执行 `DATA_ROOT` containment 和 Session 路径匹配。审批端点为历史/未来兼容保留；V0.1 严格只读配置不产生新的外部写审批。

`GET /api/admin/v1/diagnostics/lark-cli` 的 `approvalCallbackConfigured` 只表示配置启用了 HTTP callback；`approvalCallbackReady` 才表示对应 App runtime callback 可用，两者不能互相替代。

### 飞书事件与回调

路径来自 `config/apps/*.yaml`，所有 App 的公开路径必须全局唯一：

```yaml
events:
  transport: websocket
  path: /public/feishu/primary/events
callbacks:
  transport: http
  path: /public/feishu/primary/callbacks
```

WebSocket 事件不经过 Public HTTP；选择 HTTP transport 时，Host 读取 JSON body 后交给当前 `FeishuAppRuntime` 验证和处理。消息引用的图片/文件随后通过 Lark Channel 流式读取：`Content-Length` 只做提前拒绝，实际字节逐 chunk 受 `maxBytesPerItem` 与本 Turn 剩余 `maxTotalBytes` 共同限制，超限立即销毁 stream。该预算与 `PUBLIC_HTTP_BODY_LIMIT_BYTES` 以及 Workspace 持久总量相互独立。

## Internal plane：`127.0.0.1:8788`

Internal plane 不得经 HF、Ingress、Service 或反向代理公开。配置 `ADMIN_TOKEN` 后，所有 Internal endpoint 都要求：

```http
Authorization: Bearer <token>
```

未配置 `ADMIN_TOKEN` 时仅依赖 loopback 边界，生产环境仍应配置随机 Token。

| Method | Path | 用途 |
|---|---|---|
| `GET` | `/healthz` | 内部存活 |
| `GET` | `/readyz` | 完整 Platform snapshot |
| `GET` | `/metrics` | Prometheus text format |
| `GET` | `/api/v1/status` | Host、分片、租约、并发和 Model Broker |
| `GET` | `/api/v1/apps` | FeishuApp runtime 快照 |
| `GET` | `/api/v1/agents` | AgentDefinition 快照 |
| `GET` | `/api/v1/bindings` | AppAgentBinding 快照 |
| `GET` | `/api/v1/apps/:appKey/sessions` | 指定 App 下的 ConversationSession |
| `POST` | `/api/v1/apps/:appKey/conversations/abort` | 中止当前 Turn |
| `POST` | `/api/v1/apps/:appKey/conversations/reset` | 重置会话 |
| `POST` | `/api/v1/apps/:appKey/policy` | 修改当前进程的 App 准入策略 |

### Abort 与 reset

```json
{
  "conversationKey": "<从 /api/v1/apps/:appKey/sessions 返回的完整 key>"
}
```

会话 key 的 6 个 segment 都使用 base64url 编码并以冒号分隔，请直接使用 Session API 返回值，不要自行拼接。响应分别为 `{"aborted":true}` 或 `{"reset":true}`。Host 会校验 key 中的 `appKey` 和 `agentId` 是否属于目标 App 与 Binding。

### Runtime policy

```json
{
  "groupAllowlist": ["oc_xxx"],
  "dmAllowlist": ["ou_xxx"],
  "requireMention": true,
  "dmMode": "allowlist",
  "respondToMentionAll": false
}
```

字段均可省略。变更仅存在于当前进程，不回写 `config/apps/*.yaml`，重启后恢复文件配置。

## 通用错误

```json
{"error":"not_found"}
{"error":"unauthorized"}
{"error":"invalid_request"}
{"error":"internal_error"}
{"error":"runtime_apply_failed"}
```

`runtime_apply_failed` 只用于 Publish/Rollback 已提交 active revision、但运行时应用失败的 HTTP 503；调用方必须先重新读取 `/api/admin/v1/config` 和 audit，不能原样重试。其他自动化客户端应根据 HTTP 状态和操作幂等性决定是否重试，不依赖错误正文的非契约字段。
