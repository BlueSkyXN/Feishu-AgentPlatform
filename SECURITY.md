# 安全边界

## 信任域

| 组件 | 信任级别 | 可持有内容 |
|---|---|---|
| Platform Host | 可信 | 飞书 App Secret、OAuth Token、Cloudflare Token、管理令牌 |
| FeishuAppRuntime | 可信 | 当前 App 的 SDK Client、OAuth、WS/HTTP 生命周期 |
| Host Tool Broker | 可信 | 当前 TurnContext、App 身份、工具与命令白名单 |
| Host Model Broker | 可信 | Cloudflare Gateway Token、capability 映射 |
| SQLite Config Store | 可信持久层 | active/draft revision、审计、Credential Vault 密文 |
| Public Admin | 受认证管理面 | setup、配置发布/回滚、凭据 configured/fingerprint |
| Pi Worker | 受限 | Prompt、显式 Skills、短期模型 capability、typed tool IPC |
| WorkspaceGuard | 路径边界 | 当前 App/Agent/Conversation 的持久目录 |

Pi Worker 是进程隔离，不是 VM。WorkspaceGuard 是文件路径与读写边界，不是原生代码 Sandbox。

共享 Pi SDK session core 强制 `PI_OFFLINE=1` 与 `PI_TELEMETRY=0`，process Worker 子进程环境也固定相同值；同时关闭 install telemetry/provider attribution 与 create-time model catalog network refresh。Pi 不执行自身的启动网络检查或安装遥测，业务模型请求仍只通过 loopback Host Model Broker。

## 模型凭据

Pi Worker 的环境变量不复制任何模型、飞书、OAuth 或管理凭据。Worker 通过 IPC 获得 Host Model Broker 的随机 capability；Broker 验证后删除 Worker 的 `Authorization`，再以 `cf-aig-authorization` 调用 Cloudflare。

每个 Pi Session 的 capability 在内存中签发，具有滑动 TTL 和绝对最大生命周期，并在 Session 创建失败、Worker 异常退出或 Session 释放时撤销。Worker 使用独立的 session-local `agent-runtime` 目录，`ModelRuntime` 使用 `InMemoryCredentialStore`，不读取共享 `auth.json` 或 `models.json`。

## 飞书工具与 lark-cli

- V0.1 对飞书业务数据严格只读；AgentDefinition 中出现 typed Feishu write tool 或非只读 `lark-cli` operation 时，统一配置加载器直接拒绝。
- `openapi.get` 只允许 `GET` 和 AgentDefinition 明确配置的路径前缀。
- `larkcli.run` 使用 operation ID 映射到固定 command 和 flag schema；模型不能传任意子命令。
- `allowCrossChatRead=false` 时，通用 IM OpenAPI 被禁用，`lark-cli` IM 参数必须属于当前 chat/thread/message。
- typed tool 的 `identity` 只由 Host grant 决定，不接受模型覆盖；Approval 的 `instance_id` 与 user-only `instance_code` endpoint 分开建模。
- 读取 operation 固定 `approval=never`；审批存储与旧写操作协议仅为历史/未来兼容保留，不构成 V0.1 可发布能力。
- Agent 不能提供身份、App Secret、Token、Profile、通用 API method 或任意子命令。
- `@larksuite/cli@1.0.79` 是由 `package-lock.json` 固定的 production dependency；Host 从项目 `node_modules/.bin` 启动并使用 `spawn(..., { shell: false })`，仅给子进程最小环境和当前 App 凭据；每个 App 使用独立 CLI HOME，自动 `config init --app-secret-stdin`、strict bot/default bot，不继承宿主用户配置。
- App 凭据与 CLI 输出都会经过脱敏边界；仍不得把原始 CLI debug 日志公开。
- 附件先按 `Content-Length` 做提前拒绝，并始终逐 chunk 累计实际字节；单项预算是 `min(maxBytesPerItem, maxTotalBytes - 本轮已接受字节数)`，超限立即销毁 stream，只有完整下载并通过检查的资源才计入本轮总量。
- 附件只写入当前 Conversation Workspace 的 `attachments/<safe-message-id>/<序号>-<sanitized-name>` 相对路径；Prompt 和日志不暴露 Host 绝对路径。

## WorkspaceGuard

- 仅接受相对路径；
- 配置的 `workspace.root/sessionRoot` 经 `resolve` 后必须等于或位于 resolved `DATA_ROOT` 内；
- 拒绝绝对路径、父目录穿越、NUL；
- 使用 `realpath` 验证根目录归属；
- 不跟随逃逸 symlink；
- 单次读写有字节上限，Workspace 持久总量默认受 `maxTotalBytes=268435456` 和 `maxFiles=10000` 限制；这些上限不替代附件的每 Turn 预算；
- 写入采用临时文件和原子替换；
- API 不存在 `exec`、Shell、PTY 或网络执行入口。

## HTTP

- Public `7860`：外部可见，处理飞书入口、OAuth、健康检查以及 `/admin`、`/api/admin/v1`。管理登录使用 HttpOnly + Secure + SameSite=Strict Cookie、TTL、CSRF 和失败限流。只有 socket peer 精确匹配 `ADMIN_TRUSTED_PROXY_ADDRESSES` 时才读取 XFF 第一跳；空值不信任任何代理，地址列表不接受 CIDR 或通配符，IPv4-mapped IPv6 会规范化后比较。
- Internal `8788`：强制 loopback，可选 Bearer 管理令牌。
- Model Broker `8790`：强制 loopback，只接受 capability。
- 请求体有上限；公网错误不回传堆栈或凭据。
- Docker 只 `EXPOSE 7860`。

## SQLite、Vault 与 setup

- `/data/feishu-agent-platform/platform.db` 保存配置 revision、审计和 AES-256-GCM credential envelope；SQLite 文件本身不是全库加密，配置元数据与审计仍按敏感运维数据保护；
- 管理 API 和 UI 只返回 credential 的 configured/fingerprint，不返回 envelope 或明文；
- `PLATFORM_MASTER_KEY` 不写入 SQLite，必须作为独立部署 Secret 保存；丢失后 Vault 密文不可恢复；
- 空库 `setup_required` 只表示管理面可用，不表示任何飞书 App、Broker 或外部集成 ready；
- 管理台位于 Public plane 是部署选择，不得因此代理或公开 Internal `8788`/Broker `8790`；
- Admin SSO 使用固定 callback、签名且一次性的 state、飞书 Token 响应 `open_id` 和 `ADMIN_OPEN_IDS` 精确匹配；
- Secure Cookie 要求 HTTPS，Compose/systemd/Kubernetes 必须在浏览器访问前配置 TLS；
- `platformctl config restore <file> --confirm=RESTORE` 拒绝 source 与目标相同路径/同 inode；目标数据库旁存在 `-wal/-shm` 时也会拒绝，要求先停止 Host。它在目标同目录临时文件中验证 SQLite header、`schema_migrations` 记录、核心配置表和 `PRAGMA integrity_check`，fsync 后原子替换，并保留 `pre-restore-*` 旧库。

## CI 与发布供应链

- `ci.yml`、Container、HF 和 Release 复用同一个 exact-head quality gate；source checks 成功后才构建并执行 production image setup-mode smoke，外部发布 job 依赖该 gate。
- 源码 ZIP 由仓库内 Node Store-method writer 固定 UTF-8 flag、DOS time、条目顺序、mode、CRC 和 header；生成不调用系统 `zip`，归档后仍用 `unzip` 独立复验。
- 已存在的 GitHub Release 只在新旧资产逐字节一致时允许幂等成功；资产缺失或不同必须失败，不允许 `--clobber`。

## 不提供的能力

项目不包含任意 Shell、SSH/SSHD、SCP/SFTP、PTY、Web Terminal、远程执行服务、Remote Sandbox、MicroVM、Docker-in-Docker、setuid/chroot/seccomp runner 或通用 Python/JavaScript Code Runner。

## 残余风险

- Node.js、Pi、飞书 SDK、`lark-cli` 和 npm 供应链；
- 同一 Host 进程内多个 App 凭据的总影响面；
- Pi Worker 或 typed tool 的拒绝服务；
- 配置错误导致 Agent 路由歧义或飞书权限过大；
- Cloudflare capability、Gateway Token 或 OAuth Token 泄漏；
- SQLite 文件、Vault master key 或管理员 session 泄漏，以及错误备份导致 WAL/主库不一致；
- 历史配置、未来版本或错误绕过只读门禁后触达 dormant 写实现；
- Workspace 累计限制属于 Host 应用层配额，不是跨进程 filesystem quota；多 Host 共享同一数据根时仍需要可靠的单写者约束或底层磁盘配额；
- HF Space 平台、持久卷和网络策略变化。

Pi SDK 固定为 `0.84.1`，锁文件回读其上游依赖树中的 `undici@8.9.0` 与 `brace-expansion@5.0.9`。项目不再通过根 `postinstall` 修改第三方包或锁文件；依赖升级必须重新运行 production `npm audit` 和完整兼容性检查。

上线前必须在目标环境验证飞书权限、WS/HTTP 回调、模型流式响应、持久化恢复和资源压力。

## 漏洞报告

不要在公开 Issue 提交 Token、聊天正文、附件、用户资料或完整日志。优先使用 GitHub Private Vulnerability Reporting；先撤销和轮换已泄漏凭据，再提供脱敏复现。
