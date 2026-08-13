# 可观测性

## 健康与就绪

| 路径 | 平面 | 用途 |
|---|---|---|
| `/healthz` | Public/Internal | HTTP Server 存活 |
| `/readyz` | Public | 简化就绪状态，不暴露内部细节 |
| `/readyz` | Internal | 完整 Host、App、Agent、Binding 与 Model Broker 快照 |

Public `/readyz` 只返回：

```json
{
  "status": "ready",
  "activeApps": 2,
  "failedApps": 0
}
```

空库时 Public `/readyz` 返回 HTTP 200 和 `status=setup_required`；这是管理面可用状态，不能计为业务 ready。存在 active revision 后，App/Broker 失败应返回 HTTP 503。告警必须区分这三种状态，避免 setup 环境误报正常业务。

## 内部状态 API

```bash
curl -sS \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8788/api/v1/status
```

状态应覆盖版本、实例、启动时间、App 分片与租约、active/standby/failed App、Agent、Binding、全局并发、Model Broker、Session 和队列。

可分别读取：

```text
GET /api/v1/apps
GET /api/v1/agents
GET /api/v1/bindings
GET /api/v1/apps/:appKey/sessions
```

## Prometheus

```bash
curl -sS \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8788/metrics
```

8788 固定为 loopback。远程采集应由同机 sidecar、受控代理或平台本地采集器转发，不能直接公开管理端口。

重点监控：

- 飞书 HTTP/WS 错误、重复和拒绝；
- Binding 路由命中、无匹配和歧义拒绝；
- Turn 成功、失败、超时和中止；
- 工具调用失败和超时；
- 活跃与驻留 ConversationSession；
- 全局和 Binding 并发等待、队列满和排队过期；
- Model Broker 认证失败、上游 429/5xx 和延迟；
- App lease 丢失与接管；
- Session、Workspace 总字节/文件数和附件目录容量；
- 附件 Content-Length 提前拒绝、流中超限、stream destroy 与每 Turn remaining-total 耗尽；
- SQLite 主库/WAL 容量、active/draft revision、审计增长和 Vault 解密失败；
- 历史审批记录与异常出现的新 pending 外部写审批（V0.1 应告警），以及管理登录 rate limit；反向代理场景还应区分 trusted peer 命中与共享 proxy peer 限流。

## 日志

结构化日志可包含：

```text
instanceId
appKey
agentId
bindingId
conversationKey（哈希或截断）
messageId
eventId
operation
status
durationMs
```

禁止记录 App Secret、Verification Token、Encrypt Key、OAuth Token、Cloudflare Token、Model Broker capability、完整模型请求/响应、真实聊天或文档正文、附件内容。

生产环境应对 `conversationKey`、`open_id`、`chat_id` 做不可逆哈希或截断，并避免把 allowlist 原值写入日志。

## 告警建议

| 条件 | 建议级别 |
|---|---|
| active revision 环境中 `/readyz` 连续 5 分钟 503 | 紧急 |
| 生产目标持续处于 `setup_required` | 高 |
| 任意 App 连续启动失败或 lease 抖动 | 高 |
| WS 频繁重连或飞书 HTTP 5xx 超过阈值 | 高 |
| Binding 歧义或无路由突然增加 | 高 |
| Model Broker 认证失败或上游 5xx | 高 |
| 模型 429、队列等待或超时持续增长 | 中 |
| 数据目录接近容量上限 | 高 |
