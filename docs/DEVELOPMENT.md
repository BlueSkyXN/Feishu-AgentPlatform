# 本地开发

## 工具链

| 项目 | 要求 |
|---|---|
| Node.js | `>=22.19.0`，建议使用 Node.js 24 |
| npm | 以 `package.json#packageManager` 为准 |
| TypeScript | 由 `devDependencies` 提供 |
| 容器验证 | Docker + BuildKit |

仓库提供 `.nvmrc` 和 `.node-version`。依赖已锁定，使用：

```bash
npm ci --no-audit --no-fund
```

依赖升级后必须同步更新 `package-lock.json`。`@larksuite/cli@1.0.79` 也是 exact production dependency，由同一 lockfile 固定并从项目 `node_modules/.bin` 启动，不依赖全局安装。不要加 `--ignore-scripts`：根项目 `postinstall` 需要将已审计的 `brace-expansion@5.0.8` 同步到 Pi 0.82.1 的 shrinkwrap 嵌套依赖，并会校验实际安装版本。

## 本地配置

先在没有 `.env` 和 active YAML 的 checkout 中运行 `npm run check`。仓库策略检查会拒绝这些仅供本地/部署使用的文件。完成源码检查后再创建：

```bash
cp .env.example .env
for file in config/apps/*.yaml.example \
            config/agents/*.yaml.example \
            config/bindings/*.yaml.example; do
  cp "$file" "${file%.example}"
done
```

实际 YAML 和 `.env` 只用于本地或部署 Secret，不提交仓库。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | `tsx watch` 启动开发模式 |
| `npm run platformctl -- doctor` | 检查 Node、Host 路径、端口和 Model Broker 配置 |
| `npm run platformctl -- validate` | 加载并校验 apps、agents、bindings |
| `npm run platformctl -- list` | 输出三类配置摘要 |
| `npm run platformctl -- config import <file> [--publish] [--note=<text>]` | 导入版本化配置，可选立即发布 |
| `npm run platformctl -- config export <file> [--slot=active\|draft]` | 导出指定配置 slot |
| `npm run platformctl -- config backup [file]` | 创建一致的 SQLite 备份 |
| `npm run platformctl -- config restore <file> --confirm=RESTORE` | 校验后原子替换 SQLite，并保留旧库 |
| `npm run typecheck` | TypeScript 严格检查 |
| `npm test` | 编译并运行 Node Test Runner |
| `npm run security:scan` | 检查凭据、模型代理、工具与 Workspace 边界 |
| `npm run repository:check` | 检查 YAML、示例、Workflow 和 Secret 策略 |
| `npm run docs:check` | 检查 Markdown 本地链接、标题和代码围栏 |
| `npm run check` | 组合执行安全、仓库、文档、类型和测试检查 |
| `npm run build` | 输出 ESM JavaScript 到 `dist/` |
| `npm run hf:preflight` | 检查 HF Space 元数据和上传树 |
| `npm run release:verify` | 检查版本号、README、CHANGELOG 和镜像 Tag |
| `npm run release:package` | 生成源码 ZIP、SHA-256 与文件 manifest |

管理台 session Cookie 固定 Secure；浏览器调试 `/admin` 需使用本地 TLS 反向代理。数据库默认 `./data/platform.db`，不要把开发数据库、WAL、Vault master key 或管理 token 加入 fixture/snapshot。

## 测试设计

测试位于 `test/`，使用 Node 内置 Test Runner。新增或修改功能至少覆盖：

- FeishuApp、AgentDefinition 和 Binding schema；
- N:N Binding 路由、优先级和歧义拒绝；
- `appKey + agentId + tenantKey + chatId + topicKey` 会话隔离；
- 并发、队列上限、超时、中止和空闲回收；
- Worker 只能访问 Model Broker capability，不能读取长期凭据；
- typed tools grants、飞书审批 operator、`lark-cli` operations/bot profile 与 WorkspaceGuard 拒绝路径；
- Workspace configured roots 的 `DATA_ROOT` containment、`maxTotalBytes/maxFiles` 与附件 per-Turn 预算分离；
- SQLite migration、active/draft/publish/rollback runtime apply failure、原子 backup/restore、orphan Session cleanup、Vault 无明文回显和 Admin Cookie/CSRF/rate limit；
- trusted proxy 精确地址、XFF spoof 拒绝、附件 Content-Length/逐 chunk 超限和 callback configured/ready 分离；
- Public/Internal HTTP 路径和错误响应。

真实飞书、Cloudflare 和 HF 验收与本地自动化分开记录。

## 目录约定

```text
config/apps/       FeishuApp 示例与本地配置
config/agents/     AgentDefinition 示例与本地配置
config/bindings/   AppAgentBinding 示例与本地配置
prompts/           Agent Prompt
skills/            项目 Skill
vendor/skills/     固定来源的只读飞书 Skill
web/               Public /admin 静态中文管理台
src/               TypeScript 源码
test/              自动化测试
scripts/           检查与发布工具
docs/              设计和运维文档
.github/           CI、模板和依赖更新
```
