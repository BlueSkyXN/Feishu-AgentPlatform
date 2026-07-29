# 用户 OAuth

OAuth 是 `FeishuApp` 的可选能力，仅在 typed tool 必须以当前飞书用户身份读取数据时启用。`AgentDefinition` 和 `AppAgentBinding` 不保存 OAuth 配置或 Token。

在 `config/apps/<id>.yaml` 的 `oauth` 段启用，并配置 `PUBLIC_BASE_URL` 与至少 32 个字符的独立 `OAUTH_TOKEN_ENCRYPTION_KEY`。回调地址为：

```text
<PUBLIC_BASE_URL><oauth.redirectPath>
```

同一个 OAuth-enabled App 还可用于管理员飞书 SSO。飞书后台必须另行登记固定回调：

```text
<PUBLIC_BASE_URL>/api/admin/v1/auth/sso/callback
```

普通用户 OAuth 与 Admin SSO 使用不同 state 类型和不同 redirect URI；两者不能互相消费。Admin SSO 只接受 Token 响应中的 `open_id`，并在创建 Cookie session 前匹配 `ADMIN_OPEN_IDS`。

只在私聊中处理以下命令：

- `/oauth`：生成带签名、一次性授权 URL；
- `/oauth-status`：查看当前用户授权状态；
- `/oauth-logout`：删除当前用户的加密 Token 记录。

安全属性：

- state 使用 HMAC、TTL、一次性消费和相对 `returnTo`；
- callback 校验返回用户与发起人一致；
- access/refresh token 使用 AES-256-GCM 加密落盘；
- 同一用户的 refresh 请求去重；
- Token 只留在 Trusted Host，不传给 Pi Worker、Model Broker capability、Workspace 或 `lark-cli` 参数；
- 同一 Agent 跨 App 复用时，各 App 的 OAuth 身份与 Token 仍完全独立。
