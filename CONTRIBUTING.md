# 贡献指南

本仓库接收 Feishu App 接入、Agent 能力、Binding 路由、会话运行时、受控工具、WorkspaceGuard 和运维改进。涉及飞书写权限、审批策略、跨会话读取、模型凭据下放或任意命令执行的变更，必须单独说明威胁场景、默认值和回滚方式。

## 开发环境

- Node.js `>=22.19.0`，建议使用 `.nvmrc` 指定的 Node.js 24；
- npm 版本以 `package.json#packageManager` 为准；
- Docker 只在容器构建或部署验证时需要。

```bash
npm ci --no-audit --no-fund
npm run check
npm run build

cp .env.example .env
for file in config/apps/*.yaml.example \
            config/agents/*.yaml.example \
            config/bindings/*.yaml.example; do
  cp "$file" "${file%.example}"
done
npm run platformctl -- validate
```

真实 `.env` 和去掉 `.example` 后的配置文件不得提交。

## 变更要求

1. 配置、接口、环境变量或部署方式变化时，同步更新文档和三类示例配置。
2. `FeishuApp` 只承载 App 身份、接入、OAuth、准入和附件策略；`AgentDefinition` 只承载模型、Prompt、Skills、工具和 Workspace 策略。
3. `AppAgentBinding` 是 App 与 Agent 的唯一关联边；路由必须确定且可审计，禁止依赖文件顺序或随机选择。
4. `ConversationSession` 必须按 `appKey + agentId + tenantKey + chatId + topicKey` 隔离。
5. Pi Worker 只能使用 Host Model Broker 的短期 capability，不得接收 Cloudflare、飞书、OAuth 或管理凭据。
6. 新增飞书能力优先实现 typed tool；外部写操作必须声明 effect/approval，高风险删除只允许 admin。`lark-cli` 使用固定 operation/flags，不接受任意 argv。
7. Workspace 访问必须经过 WorkspaceGuard；不得增加 Shell、PTY、命令执行或把外部文件系统挂入会话目录。

## 提交前检查

```bash
npm run platformctl -- doctor
npm run platformctl -- validate
npm run check
npm run build
```

涉及容器时再运行：

```bash
docker build -t feishu-agent-platform:dev .
```

涉及真实飞书、Cloudflare AI Gateway 或 Hugging Face Space 的验证，应在 PR 中区分本地检查、外部联调和部署验收，不得用静态检查代替线上结论。

## Pull Request

PR 应写明问题与目标、改动范围、权限和凭据影响、验证命令与结果、配置迁移以及回滚方式。Issue、PR、日志和测试数据中不得包含真实聊天内容、用户资料、App Secret、OAuth Token、Cloudflare Token 或模型正文。
