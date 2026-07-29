# Hugging Face Docker Space

## 推荐形态

- SDK：Docker；
- 公网端口：7860；
- 可见性：Protected 或符合数据治理要求的设置；
- 硬件：不会自动休眠的 CPU 实例；
- 持久化：挂载 `/data`；
- 首次部署使用单实例。

根 README 已声明 `sdk: docker` 与 `app_port: 7860`。

## 部署

1. 创建 Docker Space；
2. 使用 GitHub `CI/CD` workflow 部署 exact-head source；
3. 至少在 HF Secrets 中设置独立的 `ADMIN_TOKEN` 与 `PLATFORM_MASTER_KEY`，再按配置方式填写飞书、Cloudflare 和 OAuth Secret；
4. 在 Variables 中填写非敏感 ID 与容量策略；
5. 配置 `/data` 持久化；
6. 部署后检查 `/healthz`、`/readyz` 和 HTTPS `/admin`。

源码仓库默认只提交 `config/{apps,agents,bindings}/*.yaml.example`。GitHub workflow 不会把示例复制成 active manifest；空数据库部署后进入 setup mode，再通过 `/admin` 创建 App、Agent、Binding、Vault credential 和 active revision。

YAML seed 是显式的替代入口：只有运维人员主动准备 active `*.yaml` 且所有引用凭据就绪时才导入。不能让 CD 自动把示例变成生产配置。

空数据库时 Space 进入 setup mode：`/healthz=200`，`/readyz=200` 且 `status=setup_required`，可经 Space HTTPS 登录 `/admin`。这只证明管理面可访问，不表示飞书 App 或 Model Broker 已启动。发布 active revision 后，再以 `ready`/503 和真实外部 smoke 分层验收。

## 网络平面

```text
0.0.0.0:7860    Public plane
127.0.0.1:8788  Internal plane
127.0.0.1:8790  Host Model Broker
```

只有 7860 对外。Internal API 与 Model Broker 不得通过 Space、代理或附加服务暴露。

HF HTTPS ingress 属于外部代理。`ADMIN_TRUSTED_PROXY_ADDRESSES` 只接受运行时实际观察并由平台契约确认稳定的精确 socket peer；不能填 CIDR、通配符或猜测地址。无法确认时保持空值，并把 bootstrap 登录限流按代理 peer 共享视为残余风险，不能无条件信任 XFF。

## Secret 与 Variable

Secrets：

```text
FEISHU_*_APP_SECRET
FEISHU_*_VERIFICATION_TOKEN
FEISHU_*_ENCRYPT_KEY
CLOUDFLARE_API_KEY
ADMIN_TOKEN
PLATFORM_MASTER_KEY
OAUTH_TOKEN_ENCRYPTION_KEY
```

Variables 或非敏感配置：

```text
FEISHU_*_APP_ID
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_GATEWAY_ID
MODEL_PROVIDER_POLICY
MAX_CONCURRENT_TURNS_GLOBAL
MAX_RESIDENT_PI_WORKERS
MAX_CONCURRENT_WORKER_STARTS
APP_SHARD_COUNT
APP_SHARD_INDEX
```

App ID 虽通常不是 Secret，也不应无必要公开完整租户和应用清单。任何 Secret 都不得写入 Variable、YAML、Prompt、Skill、附件或日志。

## 持久化

镜像中的持久根和 SQLite 路径为：

```text
DATA_ROOT=/data/feishu-agent-platform
PLATFORM_DATABASE_PATH=/data/feishu-agent-platform/platform.db
```

显式 `workspace.root/sessionRoot` 经 `resolve` 后必须等于或位于 `/data/feishu-agent-platform` 内。Workspace 默认 `maxTotalBytes=268435456`、`maxFiles=10000`；附件每 Turn 的 item/bytes 限制另行计算。

需要保留：

- 按 appKey/agentId 隔离的 Pi Session；
- `platform.db` 及 SQLite WAL/checkpoint 状态；
- active/draft revisions、审计和 Credential Vault 密文；
- ConversationSession Workspace；
- OAuth 加密 Token 与 state；
- App lease；
- 附件和必要状态文件。

`PLATFORM_MASTER_KEY` 不在 `/data` 中，必须作为 HF Secret 独立保留。数据库持久化但 key 丢失时，Vault credential 仍不可恢复。

Model Broker capability 是进程内短期状态，不应持久化。Space 重启后由 Host 为新 Worker 重新签发。

## 常驻与单实例

WebSocket 需要长连接，HTTP callback 也需要持续可达。会休眠的实例会导致离线或回调失败。

首版建议单实例。需要多实例时，按 `APP_SHARD_COUNT/INDEX` 分片，并确保 lease、Session 与 Workspace 位于具备可靠原子文件语义的共享存储；不要让多个实例同时消费同一飞书 App。

SQLite 配置库首版也按单写实例设计。不要让多个 Space/副本同时写同一个持久 `platform.db`。

## GitHub Actions 同步

仓库提供 HF Space workflow。GitHub 中配置：

```text
Repository variable: HF_SPACE_ID=owner/space-name
Environment secret (huggingface-space): HF_TOKEN=hf_xxx
```

只在 `huggingface-space` Environment 中保存该 Token，不要再配置同名 Repository secret。自动部署只在明确设置 `HF_AUTO_DEPLOY=true` 后启用。同步使用干净 Git 归档，保持 setup mode，通过 HTTPS 推送；Token 不进入 YAML、remote URL、Commit 或日志。

部署 job 不在 `git push` 后立即成功：它继续等待 Space repo/runtime SHA 一致、`RUNNING`、域名 `READY`，并验证 `/healthz`、`/readyz` 与 `/admin`。映射信息写入 Space 的 `DEPLOYMENT_SOURCE.json` 和 GitHub Actions deployment evidence artifact。

## HFS v2 登记

根目录 `hfs-dev.toml` 将本项目登记为：

```text
project_class=production
target_role=primary
sovereignty=sovereign
lane=source
version_source=commit
```

本地 HFS 设置事实源固定为 `local/hfs-targets/production.env`，权限必须是 `0600`，不进入 Git。`hfs-dev diff` 负责比较登记的 Space Secrets/Variables；GitHub Actions 负责 exact-head source 构建和部署。两者职责不同，不能用本地 env 文件代替 GitHub Environment Secret，也不能用 workflow 声明代替 HF Settings 回读。

## 部署后验收

1. 私聊和群聊 `@`；
2. WS 重连与重复事件；
3. HTTP challenge、event 和卡片 callback；
4. default、命令与 allowlist Binding；
5. 当前用户资料、聊天历史、只读工具，以及受控写操作的 requester/admin 审批、拒绝和过期；
6. Worker 经 Model Broker 完成 Cloudflare 流式调用；
7. 同一 Agent 跨 App 复用且凭据、Session、Workspace 不串用；
8. lockfile 固定的 `@larksuite/cli@1.0.79` bot profile、固定 operation/flags 和实际飞书 scope；
9. Space 重启后的 `/data/feishu-agent-platform/platform.db`、active revision、Vault fingerprint、Session 和 Workspace 恢复。

使用[部署检查表](DEPLOYMENT_CHECKLIST.md)记录 Commit、镜像 digest、配置和验收结果。
