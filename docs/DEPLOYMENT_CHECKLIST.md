# 部署检查表

## 代码与镜像

- [ ] 使用明确 Commit、Tag 和镜像 digest；
- [ ] `npm ci`、`npm run check`、`npm run build` 通过；
- [ ] 目标 SHA 的 reusable exact-head quality gate、生产镜像和 setup-mode HTTP smoke 通过；
- [ ] 记录 GitHub source SHA、CI/CD run URL 和 `hf-deployment-<source_sha>` artifact；
- [ ] 生产镜像构建通过，运行用户为 `node`；
- [ ] 镜像包含 `web/`；`@larksuite/cli@1.0.79` 是 lockfile 固定的 production dependency，并从 `/app/node_modules/.bin` 启动；
- [ ] 源码 ZIP 由 deterministic Node writer 生成并经 `unzip` 独立复验；已存在 Release 只允许 byte-identical 幂等结果；
- [ ] 只暴露 7860；8788 与 8790 未公开；
- [ ] 未提交 `.env`、实际 YAML、数据目录或凭据；
- [ ] 根 GPLv3 与 `LICENSES/` 中历史来源声明保留。

## 四层配置

- [ ] `config/apps`、`config/agents`、`config/bindings` 均通过 validate；
- [ ] 每个 App 恰有一个 default Binding；
- [ ] 命令和 allowlist Binding 无相同优先级歧义；
- [ ] 同一 Agent 跨 App 复用时不包含 App 凭据或 OAuth 配置；
- [ ] 会话与 Workspace 路径按 appKey、agentId 和 storageId 隔离，configured `workspace.root/sessionRoot` 位于 resolved `DATA_ROOT` 内；
- [ ] Workspace `maxTotalBytes=268435456`、`maxFiles=10000` 与附件 per-Turn 预算分别生效；
- [ ] Binding 的并发、队列、TTL 和历史上限符合容量规划。

## 飞书

- [ ] App 为企业自建应用且机器人能力已开启；
- [ ] 事件 transport 与 `FeishuApp` 一致；
- [ ] HTTP URL、Verification Token 和可选 Encrypt Key 正确；
- [ ] 权限只覆盖绑定 Agent 实际使用的工具；写工具有 requester/admin 审批，高风险删除仅 admin；
- [ ] App 已发布并进入测试范围；
- [ ] mention、DM、群聊和附件策略已验证；附件覆盖 Content-Length 超限、无/不可信长度、流中超限、per-item/remaining-total 和安全相对落盘路径。

## 模型与凭据

- [ ] `MODEL_PROVIDER_POLICY=host-broker-only`；
- [ ] Model Broker 固定 loopback，Gateway 上游为 HTTPS；
- [ ] Provider Key 位于 Cloudflare BYOK/Secrets Store；
- [ ] Gateway Token 只注入 Host；
- [ ] Pi Worker 环境与日志不含 `CLOUDFLARE_*` 值；
- [ ] 模型协议、路径、预算、限流和超时已实测。

## HF Space

- [ ] Docker Space，`app_port: 7860`；
- [ ] 可见性符合业务要求；
- [ ] 使用不会休眠的运行配置；
- [ ] `/data` 持久化容量足够，`/data/feishu-agent-platform/platform.db`、Session、Workspace、OAuth、附件和 lark-cli profile 均落盘；
- [ ] `PLATFORM_MASTER_KEY` 作为独立 Secret 备份，未写入数据库或配置；
- [ ] Secrets 只通过 HF Secrets 注入；
- [ ] `/healthz` 与 `/readyz` 语义正确；`setup_required` 未误报为业务 ready；
- [ ] `DEPLOYMENT_SOURCE.json` 的 GitHub SHA 与 run 一致，HF repository SHA 与 runtime SHA 一致；
- [ ] 记录 active revision ID/content SHA；空库则明确记录 `setup_required`，不写成业务 ready；
- [ ] Space HTTPS `/admin` 登录、CSRF、Draft/Publish 和 credential fingerprint 回读；
- [ ] 重启后 Session、OAuth 和 Workspace 恢复符合预期。

## 管理与观测

- [ ] `INTERNAL_HTTP_HOST=127.0.0.1`；
- [ ] `ADMIN_TOKEN` 为随机 Secret；
- [ ] TLS 代理 peer 使用精确 `ADMIN_TRUSTED_PROXY_ADDRESSES`；代理覆盖而不是追加外部 XFF，不同真实客户端不会共享或伪造限流 key；
- [ ] `ADMIN_OPEN_IDS`、approval TTL 与审批人范围已复核；
- [ ] 运维脚本不打印 Token；
- [ ] abort、reset、policy 操作可追溯；
- [ ] 关键错误率、队列、Session、租约、Model Broker 和磁盘有告警。

## 上线后

- [ ] WS 消息和 HTTP event/callback 闭环；
- [ ] default、命令与 allowlist Binding 路由；
- [ ] 多 App 复用同一 Agent 且上下文不串用；
- [ ] 用户资料、当前聊天历史、读取工具和明确启用的写操作审批；
- [ ] Cloudflare 流式模型调用；
- [ ] `platformctl config backup` 与 `config restore <file> --confirm=RESTORE` 已演练；恢复后回读数据库并确认旧库保留为 `pre-restore-*`；
- [ ] SQLite、Vault key、Session、OAuth、附件、Workspace、lark-cli profile、重启恢复和 revision/镜像回滚分别验收。
