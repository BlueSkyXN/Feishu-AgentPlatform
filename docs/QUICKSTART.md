# 快速开始

## 1. 安装并检查源码树

```bash
node --version
npm ci --no-audit --no-fund
npm run check
npm run build
```

Node.js 必须 `>=22.19.0`，生产镜像使用 Node.js 24。启用 `lark-cli` 时还应确认：

```bash
./node_modules/.bin/lark-cli --version
# 期望 1.0.79
```

`@larksuite/cli@1.0.79` 由根 `package-lock.json` 作为 production dependency 固定，不要求也不建议全局安装。

先执行仓库检查，再创建 `.env` 和 active manifests。`repository:check` 会主动拒绝源码树中的 `.env` 与 `config/**/*.yaml`，因此反过来的命令顺序必然失败。

## 2. 选择首次配置方式

### 方式 A：setup mode 管理台

```bash
cp .env.example .env
```

先在 `.env` 中设置：

```dotenv
ADMIN_TOKEN=<openssl rand -hex 32 的结果>
PLATFORM_MASTER_KEY=<另一份独立随机值>
DATA_ROOT=./data
PLATFORM_DATABASE_PATH=./data/platform.db
```

显式配置 Agent 的 `workspace.root/sessionRoot` 时，两者经 `resolve` 后必须等于或位于 resolved `DATA_ROOT` 内；默认 Workspace 持久总量为 `maxTotalBytes=268435456`、`maxFiles=10000`。

数据库为空时启动：

```bash
npm start
```

服务进入 setup mode。用 `ADMIN_TOKEN` 登录 `/admin`，创建 Draft、配置 Credential Vault 并发布 active revision。管理 Cookie 固定为 `Secure`；生产访问必须使用 TLS 反向代理或 HF Space HTTPS。Chromium 等浏览器通常把 loopback 视为安全上下文，可用于本机开发，但不能把这一例外外推到普通明文域名。同机 nginx 还应设置 `ADMIN_TRUSTED_PROXY_ADDRESSES=127.0.0.1,::1` 并覆盖 `X-Forwarded-For` 为 `$remote_addr`；不要信任客户端传入的 XFF。

### 方式 B：受控 YAML seed

在完成源码检查之后复制 examples：

```bash
cp .env.example .env
for file in config/apps/*.yaml.example \
            config/agents/*.yaml.example \
            config/bindings/*.yaml.example; do
  cp "$file" "${file%.example}"
done
```

如只准备一个 App，可删除不需要的 active App 和 Binding YAML；每个启用 App 必须恰好有一个 default Binding。examples 不固定 Workspace、Session、OAuth 或 lark-cli 数据路径，它们会回落到 `DATA_ROOT`。

至少为 seed 准备：

```dotenv
FEISHU_PRIMARY_APP_ID=cli_xxx
FEISHU_PRIMARY_APP_SECRET=xxx
FEISHU_PRIMARY_VERIFICATION_TOKEN=xxx
CLOUDFLARE_ACCOUNT_ID=xxx
CLOUDFLARE_GATEWAY_ID=xxx
CLOUDFLARE_API_KEY=xxx
ADMIN_TOKEN=xxx
PLATFORM_MASTER_KEY=xxx
```

然后执行文件配置校验：

```bash
npm run platformctl -- doctor
npm run platformctl -- validate
npm run platformctl -- list
```

`list` 不输出 App Secret、OAuth Token 或 Cloudflare Token。文件 seed 是否被导入 SQLite，应以启动日志、`/api/admin/v1/config` 和 revision 审计回读为准；不要只凭 YAML 存在作结论。

## 3. 健康与就绪

```bash
curl -fsS http://127.0.0.1:7860/healthz
curl -i http://127.0.0.1:7860/readyz
```

- `/healthz=200`：Public HTTP 进程存活；
- 空库 setup mode：`/readyz=200` 且 `status=setup_required`，只代表管理面可用；
- active revision 且业务 App/Broker 成功：`/readyz=200` 且 `status=ready`；
- active revision 存在但 App/Broker 失败：`/readyz=503`。

Internal API 保持 loopback：

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8788/api/v1/status
```

## 4. 只读工具检查

`lark-cli@1.0.79` 的 Host profile 会使用 App 凭据初始化为 strict bot/default bot。V0.1 中每个 `AgentDefinition.larkCli.operations` 必须固定为只读 command、`effect: read` 和 `approval: never`；服务端拒绝 typed Feishu write tool 和非只读 CLI operation。

## 5. 真实飞书验收

1. 私聊 default Agent；
2. 群聊 `@机器人`；
3. 在 primary App 发送 `/office 查询今天日程`；
4. 验证不同话题、App、Agent 的 Session 不混用；
5. 验证 `/status`、`/reset`、`/abort`；
6. 验证 typed Feishu write tool 和非只读 `lark-cli` operation 无法通过配置校验；
7. 验证 WorkspaceGuard 只接受相对路径且没有 Shell/exec；
8. 重启后回读 `/data/feishu-agent-platform/platform.db`、active revision、Vault fingerprint、Session 和 Workspace。

自动化测试、静态配置校验、容器启动和上述真实验收是不同证据层；任一层通过都不能替代其他层。

## 6. HF Space 配置边界

GitHub HF workflow 在 exact-head source 上构建 artifact payload，并只通过 `git archive` 导出瘦 `hfs/` wrapper；它保持 `config/{apps,agents,bindings}/*.yaml.example` 为示例，不生成 active YAML。空数据库从 Space HTTPS 域名的 `/admin` 完成首次配置；持久存储必须覆盖 `/data`，应用数据位于 `/data/feishu-agent-platform`，其中 SQLite 固定为 `/data/feishu-agent-platform/platform.db`。
