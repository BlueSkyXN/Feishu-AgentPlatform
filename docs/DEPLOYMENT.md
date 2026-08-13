# 部署

## 部署形态

| 目标 | 推荐用途 | 说明 |
|---|---|---|
| Hugging Face Docker Space | 常驻单实例或按 App 分片 | 本项目主要交付形态 |
| Docker Compose | 本地和单机验收 | 与 HF 镜像结构接近 |
| Kubernetes | 自建平台和共享存储 | 需自行设置 Secret、PVC、NetworkPolicy 和分片 |
| systemd / 裸机 | 受控主机 | 运维成本更高，优先使用容器 |

## Docker Compose

```bash
cp .env.example .env
for file in config/apps/*.yaml.example \
            config/agents/*.yaml.example \
            config/bindings/*.yaml.example; do
  cp "$file" "${file%.example}"
done
docker compose up --build -d
curl -fsS http://127.0.0.1:7860/healthz
curl -i http://127.0.0.1:7860/readyz
```

Compose 只发布 7860。Internal 8788 和 Model Broker 8790 保留在容器 loopback；配置目录只读挂载，named volume 挂到 `/data`，应用 `DATA_ROOT` 为 `/data/feishu-agent-platform`，SQLite 固定为 `/data/feishu-agent-platform/platform.db`。Workspace、Session、OAuth、附件和 lark-cli profile 也必须回落到这个持久卷；显式 `workspace.root/sessionRoot` 经 `resolve` 后不得逃出 `DATA_ROOT`。

容器 healthcheck 使用 `/healthz`，所以空库 setup mode 可以保持 healthy。业务就绪仍以 `/readyz` body 判断：`setup_required` 表示管理台可用但 App 尚未运行，不等于生产 ready。

`/admin` 使用 `Secure` Cookie。Compose 本身只提供 HTTP，需要在浏览器使用管理台时，应通过 `deploy/nginx.conf.example` 或其他 TLS 反向代理访问；不要公开 8788/8790。同机 nginx 应在应用环境中设置 `ADMIN_TRUSTED_PROXY_ADDRESSES=127.0.0.1,::1`，并覆盖 XFF 为 `$remote_addr`。地址必须是精确 socket peer，不得使用 CIDR、通配符或无条件信任外部 XFF。

升级时使用固定 Tag 或 digest，不依赖 `latest`：

```bash
docker compose pull
docker compose build --pull
docker compose up -d
```

## Hugging Face Space

使用根目录 Dockerfile 与 README front matter，保持 7860 为唯一公网端口，并为 `/data` 配置持久化。镜像包含 `web/`，管理台通过 Space HTTPS 的 `/admin` 访问。详见 [HUGGING_FACE_SPACE.md](HUGGING_FACE_SPACE.md)。

源码只提交 `*.yaml.example`。HF workflow 保持这些文件为示例，不生成 active YAML；新实例以 setup mode 启动，通过 `/admin` 写入 SQLite Draft、Vault 和 active revision。需要受控 YAML seed 时必须显式准备，不属于默认 CD。

## Kubernetes

`deploy/kubernetes.yaml` 是单副本起点，部署前至少修改：

- 镜像地址和固定 Tag；
- Secret 与 ConfigMap；
- PVC 和容量告警；
- `/healthz` startup/liveness 与 `/readyz` readiness probe；setup mode 的 `/readyz=200 setup_required` 保证管理台仍可通过 Service 访问；
- NetworkPolicy，禁止公开 8788 和 8790；
- 单实例或 `APP_SHARD_COUNT/INDEX` 分片策略；
- 多实例时可提供可靠原子文件语义的共享租约、Session 和 Workspace 存储；SQLite 首版仍建议单写实例，不要让多个 Pod 通过不兼容的共享文件系统并发写同一个 `platform.db`。

配置结构必须保持 `apps/agents/bindings` 分离；不要把 App Secret 写入 Agent 或 Binding ConfigMap。

## systemd 与反向代理

源码部署需要 Node.js 24、`npm ci`、`npm run build`、`web/` 和专用系统用户。systemd 模板把数据库放在 `/var/lib/feishu-agent-platform/platform.db`。反向代理只转发 7860，包括 `/admin`；Internal API 与 Model Broker 必须保持 loopback。管理台 Cookie 强制 Secure，因此 TLS 不是可选项；只有精确列入 `ADMIN_TRUSTED_PROXY_ADDRESSES` 的 peer 才能提供客户端 XFF 第一跳。

## CI/CD

`ci.yml` 是唯一主编排：先解析 immutable SHA，再调用一次 `quality-gate.yml` 验证 npm 锁文件、production dependency audit、仓库与文档策略、TypeScript、测试、构建、HF/release preflight、最终镜像和 setup-mode HTTP smoke。Gate 通过后才调用 HF 或 GHCR reusable workflow。HF job 还必须等待 repo/runtime SHA 一致并完成 HTTP smoke。Gate 或 HF 成功仍不能替代真实飞书、Cloudflare、OAuth、只读工具和持久化恢复验收。

上线使用 [部署检查表](DEPLOYMENT_CHECKLIST.md)，记录 Commit、镜像 digest、配置变更、数据备份和回滚点。
