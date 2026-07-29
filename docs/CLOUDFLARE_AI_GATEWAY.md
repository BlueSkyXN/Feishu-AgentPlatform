# Cloudflare AI Gateway

## 作用

Cloudflare AI Gateway 负责上游模型 API 转发、Provider Key 托管、路由、限流、预算和观测。Feishu Agent Platform 通过 Host Model Broker 访问 Gateway：

```text
Pi Worker -> loopback Model Broker -> Cloudflare AI Gateway -> Model Provider
```

Pi Worker 只得到短期 session capability 和 loopback broker 地址，不接收 Cloudflare Gateway Token。

## Host 配置

```dotenv
CLOUDFLARE_ACCOUNT_ID=replace-me
CLOUDFLARE_GATEWAY_ID=replace-me
CLOUDFLARE_API_KEY=replace-with-run-token
MODEL_BROKER_ENABLED=true
MODEL_BROKER_HOST=127.0.0.1
MODEL_BROKER_PORT=8790
MODEL_PROVIDER_POLICY=host-broker-only
```

也可以通过 `MODEL_BROKER_UPSTREAM_BASE_URL` 设置完整 HTTPS 上游根地址。Broker host 必须是 loopback；显式上游必须使用 HTTPS。

`AgentDefinition` 只描述模型协议和 Gateway passthrough 路径：

```yaml
provider: host-broker
model: claude-sonnet-4-6
modelApi: anthropic-messages
upstreamPath: /anthropic
```

当前支持的 `modelApi` 见 [配置参考](CONFIGURATION.md)。模型名、协议和 `upstreamPath` 必须与 Cloudflare Gateway 的实际上游契约一致。

## 凭据分布

| 凭据 | 位置 |
|---|---|
| 上游 Provider Key | Cloudflare BYOK/Secrets Store |
| Cloudflare Gateway Token | Trusted Host / 部署 Secret |
| 飞书 App Secret | 对应 `FeishuAppRuntime` |
| OAuth Token | 对应 App 的 Host 加密存储 |
| Pi Worker | 仅短期 Model Broker capability |
| Workspace、Prompt、Skill、工具参数 | 不包含以上凭据 |

## 验收边界

本地配置检查不能证明 Gateway 路由可用。上线前至少验证流式响应、模型协议、超时、429/5xx、预算、限流、日志脱敏，以及 Worker 环境中不存在 `CLOUDFLARE_*` 值。
