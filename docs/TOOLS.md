# 工具、审批、lark-cli 与 WorkspaceGuard

## 调用链

```text
Pi Worker
  -> typed custom tool
  -> IPC tool_request
  -> Host ToolBroker
  -> grant / approval
  -> Feishu SDK / lark-cli / WorkspaceGuard
```

Prompt 与 Skill 只提供操作说明，不授予权限。实际权限由 App scope、AgentDefinition allowlist、tool/operation grant、当前 TurnContext 和 Host 参数校验共同决定。

## 飞书 typed tools

读取能力包括当前用户、当前聊天、消息历史、文档、Base、日历、任务、审批实例和受限 `openapi.get`。审批详情明确区分两套契约：

- `approval.instance.get`：按 `instance_id` 调用 `/approval/v4/instances/:instance_id`；
- `approval.instance.detail`：按 `instance_code` 调用 `/approval/v4/instances/detail`，必须使用 `identity=user`。

写能力按资源显式拆分：

```text
doc.create
base.records.create/update/delete
calendar.events.create/update/delete
task.create/update/delete
approval.instance.create
```

工具只有被列入 `tools.feishu` 才会发布给 Agent。`tools.grants` 为启用的工具设置：

- `identity`: `app` 或 `user`；
- `effect`: `read`、`write`、`high-risk-write`；
- `approval`: `never`、`requester`、`admin`。

`identity` 是 Host 配置，不是模型参数；模型看到的 typed tool schema 不包含该字段。即使旧客户端额外提交 `identity`，也不能覆盖 Host grant。`approval.instance.detail` 与 `approval.instance.create` 必须显式使用用户身份和 OAuth。

约束是强制的：读取必须 `never`，普通外部写入至少 `requester`，删除等高风险操作必须 `admin`。`ADMIN_OPEN_IDS` 为空时 admin 操作直接拒绝。需要审批的 Binding 必须启用 HTTP card callbacks。

飞书卡片只允许正确 operator 决策：`requester` 由原消息发送者批准，`admin` 由 allowlist 管理员批准。审批带一次性随机 ID、参数 hash 和 TTL；批准只授权本次固定参数调用，不等于外部系统已经写入成功。

## lark-cli bot profile

`@larksuite/cli@1.0.79` 是由根 `package-lock.json` 固定的 production dependency；生产镜像从 `/app/node_modules/.bin` 启动，不做 global install。AgentDefinition 也必须设置：

```yaml
larkCli:
  enabled: true
  executable: lark-cli
  expectedVersion: 1.0.79
  timeoutMs: 60000
```

Host 首次使用每个 App profile 时：

1. 回读 `lark-cli --version` 并要求精确等于 `expectedVersion`；
2. 在 `<DATA_ROOT>/lark-cli/<appKey>` 创建 mode 0700 的独立 HOME/config/cache/tmp；
3. 用 `config init --app-id ... --app-secret-stdin` 初始化，Secret 不放 argv；
4. 设置 `config strict-mode bot` 和 `config default-as bot`；
5. 写入只含 credential fingerprint、version 和时间的 marker。

Profile 由 Trusted Host 持有，Pi Worker 看不到 App Secret、profile 文件或配置命令。

## lark-cli operations

`larkcli.run` 接收 operation ID 和结构化 parameters。模型不能直接提交完整 argv；Host 从配置取固定 command，并按 `allowedFlags` 渲染参数：

```yaml
larkCli:
  operations:
    - id: calendar-agenda
      command: [calendar, +agenda]
      effect: read
      approval: never
      allowedFlags:
        --calendar-id: {type: string, maxBytes: 256}
        --start: {type: string, maxBytes: 64}
        --end: {type: string, maxBytes: 64}
      requiredFlags: []
    - id: create-document
      command: [docs, +create]
      effect: write
      approval: requester
      allowedFlags:
        --title: {type: string, required: true, maxBytes: 800}
        --content: {type: content-file, required: true, maxBytes: 2000000}
      requiredFlags: [--title, --content]
```

Host 拒绝 operation 未声明的 flag，以及 `--as`、`--yes`、`--format`、profile/auth/config、身份与 Secret 参数。`content-file` 只在本次请求私有临时目录生成，不能引用 Host 任意路径。所有进程使用 `shell: false`、最小环境、超时和输出上限；stdout/stderr/JSON 再经过凭据脱敏。

旧 `allowedCommands` 已明确拒绝，不存在兼容执行路径；配置必须迁移为结构化 `operations`。

命令是否真实存在、所需 scope、bot identity 行为、审批卡片和输出 shape 必须在固定 `1.0.79` 与测试飞书 App 上实际验收；本地配置校验不证明外部调用成功。

## Skills

`larkcli.skill.read` 只能读取 AgentDefinition 明确列出的 skill。Skill 不扩大 operation、flag、identity、approval 或 Feishu scope。不要把真实数据、凭据或内部模板写入公开 Skill。

## WorkspaceGuard

- `workspace.list`
- `workspace.read`
- `workspace.search`
- `workspace.write`（仅 `read-write` mode）

WorkspaceGuard 只处理当前 Conversation Workspace 的相对路径和有限读写；没有 `workspace.exec`、Shell、PTY、网络执行、包安装或后台进程。它是路径 guard，不是 OS sandbox、容器或 VM。
