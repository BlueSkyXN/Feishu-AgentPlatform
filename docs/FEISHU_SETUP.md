# 飞书应用设置

## 应用与平台配置

每个需要独立名称、头像、权限、可用范围或 OAuth 身份的机器人创建一个企业自建飞书应用，并在 `config/apps/<id>.yaml` 定义一个 `FeishuApp`。App 负责凭据、WS/HTTP、OAuth、准入和附件策略；Agent 能力放在 `config/agents/`，两者通过 `config/bindings/` 显式关联。

同一 App 可以按命令、群聊、用户或话题路由到多个 Agent；同一 Agent 也可以被多个 App 复用。

## 事件与回调

推荐消息事件走 WebSocket，卡片交互走 HTTP：

```yaml
events:
  transport: websocket
  path: /public/feishu/primary/events
callbacks:
  transport: http
  path: /public/feishu/primary/callbacks
```

- WebSocket 适合企业自建应用的消息事件，本地和 HF 只需主动出站连接；
- HTTP 用于卡片交互、HTTP event、OAuth 和其他需要公网地址的场景；
- HTTP URL 必须与 `FeishuApp` 配置完全一致，例如 `https://<domain>/public/feishu/primary/callbacks`；
- Verification Token 和可选 Encrypt Key 通过 Secret 注入，YAML 只保存环境变量名；
- 同一类事件不建议同时从 WS 与 HTTP 双投递；迁移期间的重复事件由 App runtime 有界去重。

附件下载不占用 Public callback JSON body 的同一预算。Host 通过 Lark image/file API 取得响应，先按 `Content-Length` 提前拒绝，并在流中逐 chunk 执行 `maxBytesPerItem` 与本 Turn 剩余 `maxTotalBytes` 的硬限制；超限立即中止，只有完整资源才计入总量。落盘只使用当前 Conversation Workspace 下的安全相对路径。

## 事件订阅与权限

至少订阅机器人接收消息事件。按绑定到该 App 的所有 Agent 实际启用工具授予最小权限，例如：

- 消息接收、当前聊天历史、群信息和用户基础资料；
- 文档、Base、日历、任务或审批中被 AgentDefinition 明确启用的只读权限；
- Host 回复当前入站消息所需权限。

V0.1 严格只读：typed Feishu write tool 和非只读 `lark-cli` operation 会在服务端配置加载时被拒绝。飞书 App scope 也应只申请已启用读取工具实际需要的最小集合。

## 发布与验收

1. 复制并填写 `config/apps`、`config/agents`、`config/bindings` 示例；
2. 配置环境变量；
3. 运行 `npm run platformctl -- validate`；
4. 在飞书开放平台发布应用版本并加入测试范围；
5. 启动后检查 `/readyz`；
6. 验证私聊、群聊 `@`、默认 Binding、命令 Binding、线程隔离和重复事件；
7. 分别验证 WS、HTTP challenge、卡片回调和 OAuth（如启用）；
8. 验证任何飞书写工具或非只读 CLI operation 都无法发布；
9. 使用同一 Agent 跨两个 App 时，确认 App 凭据、lark-cli bot profile、会话和 Workspace 不串用；
10. 用超限 `Content-Length`、缺失/不可信长度及实际流超限三种情况验证附件被提前或流中拒绝，且 Prompt/日志不出现 Host 绝对路径。

若该 App 同时承担管理员飞书 SSO，还要在安全设置中登记固定回调 `<PUBLIC_BASE_URL>/api/admin/v1/auth/sso/callback`。它与普通用户 OAuth 的 `<PUBLIC_BASE_URL><oauth.redirectPath>` 是两条不同 redirect URI，均需按实际启用范围登记。

配置校验只证明本地 schema 和引用关系有效，不证明飞书权限、事件投递或应用发布已经成功。
