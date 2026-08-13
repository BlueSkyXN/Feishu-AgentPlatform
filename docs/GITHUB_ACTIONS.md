# GitHub Actions CI/CD

GitHub Actions 是本项目唯一的正式构建、测试和 Hugging Face 部署链。本地构建和本地 ZIP 只用于开发排错，不构成交付证据。

## 主链

```text
Pull Request
  → resolve immutable source SHA
  → exact-head quality gate
      ├── Node 22.19：check + build + preflight
      ├── Node 24：check + build + preflight
      └── production Docker image + setup-mode HTTP smoke

main push
  → 同一个 exact-head quality gate
  → HF_AUTO_DEPLOY=true 时调用 HF deploy
      ├── 构建并上传同一 GitHub SHA 的私有 artifact payload
      ├── git archive 仅导出瘦 hfs/ wrapper
      ├── 保持空库 setup mode，不生成 active YAML
      ├── 生成 DEPLOYMENT_SOURCE.json
      ├── HTTPS 推送 Space
      ├── 等待 repo SHA == runtime SHA
      └── 验证 RUNNING、READY、/healthz、/readyz、/admin
  → PUBLISH_GHCR=true 时发布同一 SHA 的 GHCR 镜像

Tag v*.*.*
  → exact-head quality gate
  → GitHub Release
  → PUBLISH_GHCR=true 时发布 Tag 镜像
```

## 工作流

| 文件 | 触发方式 | 作用 |
|---|---|---|
| `ci.yml` | PR、main、手动 | 唯一 CI/CD 编排入口；一次验证后再调用部署或镜像发布 |
| `quality-gate.yml` | `workflow_call` | exact-head source matrix、Docker build/inspect 和 setup-mode smoke |
| `hf-space.yml` | `workflow_call` | 只部署已经通过 gate 的 immutable SHA，并等待 HF runtime 验收 |
| `container.yml` | `workflow_call` | 发布已经通过 gate 的 exact-head GHCR 镜像 |
| `release.yml` | Tag、手动 | 验证 Tag SHA、生成远端 Release 资产，可选发布 Tag 镜像 |
| `codeql.yml` | PR、main、定时、手动 | JavaScript/TypeScript CodeQL |
| `dependency-review.yml` | PR | 使用 Dependency Review 审查 PR 相对 base 的依赖变化 |
| `dependency-audit.yml` | 每周、手动 | 干净安装当前锁定的 production dependency 后运行 `npm audit`，发现无代码变更期间新披露的公告 |

`quality-gate.yml` 固定使用 `npm ci`，并通过 `npm run check` 对每个 exact-head 运行 production `npm audit`。`dependency-review.yml` 只检查 PR dependency delta，`dependency-audit.yml` 负责定时/手动执行干净 production install 并审计当前锁文件。`package-lock.json` 必须和依赖变更一起提交；正式测试、构建和 Docker smoke 以 GitHub Actions run 为准。

## GitHub 设置

Repository Variables：

```text
HF_AUTO_DEPLOY=true
HF_SPACE_ID=owner/space-name
PUBLISH_GHCR=false       # 按需开启
```

创建 Environment：

```text
huggingface-space
```

在该 Environment 中保存：

```text
HF_TOKEN
```

`HF_TOKEN` 只需要目标 Space 的写权限。它不进入 Space runtime、源码、Git remote URL、日志或 artifact。`ADMIN_TOKEN`、`PLATFORM_MASTER_KEY` 与 Cloudflare Gateway 凭据保存在 HF Space Secrets；飞书 App credential 可保存在 Space Secrets 或管理台 Vault。这些值都不复制到 GitHub 部署 job。

## Setup mode 与配置

CD 默认只部署 `*.yaml.example`，绝不把示例复制成 active `*.yaml`。因此新的空数据库稳定进入：

```json
{"status":"setup_required","activeApps":0,"failedApps":0}
```

管理员随后通过 HTTPS `/admin` 创建 Draft、录入 Vault、校验并 Publish。这样首次部署不依赖飞书或 Cloudflare凭据，管理台不会被示例配置提前阻塞。

需要 YAML seed 时，应在目标环境显式准备 active YAML 并确保所有引用凭据已存在；正式 GitHub CD 不自动生成 seed。

## GitHub SHA 与 HF SHA

HF Space 使用独立 Git 仓库，因此 GitHub source SHA 与 HF repository SHA 不相同。部署流程通过三层绑定：

1. artifact packager 只处理 gate 验证过的 GitHub `source_sha`，manifest 固定 source ref、payload SHA-256 和 bytes；
2. `git archive` 只导出同一 SHA 的瘦 `hfs/` wrapper，不把产品源码、测试或文档推入 Space Git；
3. Space 根目录生成 `DEPLOYMENT_SOURCE.json`，记录 GitHub repository、source SHA、artifact manifest 和 source commit time；
4. Action artifact `hf-deployment-<source_sha>` 记录 GitHub SHA、HF repo SHA、HF runtime SHA 和 HTTP smoke。

HF 导出 commit 使用源 Commit 时间和固定 bot identity；同一 source SHA 的导出树相同时，重复部署产生相同 HF SHA。

## 部署成功标准

`git push` 成功不等于部署成功。CD 必须同时满足：

```text
HF repo SHA == workflow 生成的 HF SHA
HF runtime SHA == HF repo SHA
runtime.stage == RUNNING
domain.stage == READY
GET /healthz == 200 且 status=ok
GET /readyz == 200 且 status 为 setup_required 或 ready
GET /admin == 200
```

如果 HF 进入 `BUILD_ERROR`、`RUNTIME_ERROR` 或超时，workflow 失败。`setup_required` 只代表管理面可用，不代表飞书业务 ready。

## 手动部署和回滚

在 Actions 中运行 `CI/CD`：

```text
ref=<branch、Tag 或完整 Commit SHA>
deploy_hf=true
publish_ghcr=false
```

workflow 会先把 ref 解析为 immutable SHA，再执行完整 gate。回滚时填写上一个已验证 Commit SHA；不得直接在 Space 仓库手改代码作为长期状态。

## 分支保护

当前 GitHub 仓库未启用 `main` branch protection 或 repository ruleset，具有写权限的账号可以直接更新 `main`。Actions 仍会按事件触发，但不再作为更新分支前的强制门禁。

若后续重新启用保护，应先从真实 Actions run 回读 required check 名称，再按需要配置 exact-head Node 22.19、Node 24、production image integration 和 CodeQL；不能凭 workflow 文件猜测名称。

## 证据边界

- GitHub source gate：证明该 Commit 的源码检查、测试和构建通过；
- production image smoke：证明镜像可构建并能以非 root setup mode 启动；
- HF deployment evidence：证明同一导出树构建并运行；
- `ready`：证明 App/Broker 在该进程启动，不证明真实飞书事件、模型、OAuth 或只读工具调用；
- 真实业务验收与持久卷重启恢复仍需按[部署检查表](DEPLOYMENT_CHECKLIST.md)执行。
