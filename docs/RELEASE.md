# 发布流程

版本遵循语义化版本。发布只证明指定 immutable Git SHA 的 reusable source/image gate、setup-mode image smoke 和归档完成，不等同于飞书、Cloudflare 或 HF 生产验收。

## 发布前条件

- `package.json`、`APP_VERSION`、README、CHANGELOG 和 Compose 镜像 Tag 一致；
- `package-lock.json` 已提交，`npm ci` 使用锁定依赖，包含 exact production dependency `@larksuite/cli@1.0.79`；
- FeishuApp、AgentDefinition 和 AppAgentBinding 示例可解析且引用闭合；
- 每个启用 App 恰有一个 default Binding；
- exact-head reusable quality gate 的 source matrix、生产镜像边界和 setup-mode smoke 通过；
- 不包含 `.env`、active manifests、数据目录或凭据；
- CHANGELOG 记录用户可见变化、数据迁移和回滚要求。

## 本地打包

```bash
npm run release:verify
npm run check
npm run build
npm run hf:preflight
npm run release:package
```

输出：

```text
release/feishu-agent-platform-<version>.zip
release/feishu-agent-platform-<version>.zip.sha256
```

只有 clean tracked tree 能生成上述 official 名称。工作树含未提交内容时，`auto` 模式生成 `feishu-agent-platform-<version>-uncommitted-preview.zip`，并在归档内写入 `RELEASE_PREVIEW.txt`；该文件不能上传到 GitHub Release、GHCR 或 HF 作为正式交付。`--official` 在非 clean exact Git tree 上直接失败。

源码归档排除 `.git`、`node_modules`、构建输出、coverage、data、`.env`、`local/`、`.visual-brainstorming/` 和旧 release 目录。归档内自动生成 `RELEASE_MANIFEST.txt`，记录每个文件的 SHA-256、字节数和 Unix mode；脚本随后解压并逐项复验。

ZIP 字节由仓库自有 Node Store-method writer 生成，固定 UTF-8 flag、DOS time、条目排序、Unix mode、CRC 和 local/central header。`SOURCE_DATE_EPOCH` 可指定归档时间；未设置时使用脚本的确定性来源。生成阶段不调用宿主 `zip`，但独立库存、解压和 manifest 复验仍要求宿主提供 `unzip -Z/-q`。

## GitHub Release

1. 更新 CHANGELOG 与版本引用；
2. 合并并完成目标 SHA 的 exact-head reusable quality gate；
3. 创建签名或受保护 Tag：

```bash
git tag -a v0.1.0 -m 'Feishu Agent Platform 0.1.0'
git push origin v0.1.0
```

4. `release.yml` 把目标 Tag 解析为 immutable SHA，并对该 SHA 调用 reusable quality gate；
5. release job 再检出同一 SHA，执行版本检查并生成 deterministic ZIP、SHA-256 和 artifact；
6. GitHub Release 不存在时创建；已存在时下载资产并要求同名资产逐字节一致，否则失败，绝不 `--clobber`；
7. 公共仓库按 workflow 条件生成 attestation。

手动运行 workflow 时输入 Tag 必须已经存在。

## 版本升级清单

至少同步：

```text
package.json
package-lock.json
src/config/types.ts -> APP_VERSION
README.md
CHANGELOG.md
docker-compose.yml
```

然后执行：

```bash
npm run release:verify -- v<version>
```

配置 schema、会话键或存储路径变化时，还必须提供迁移脚本或明确的不兼容说明，以及升级前备份和回滚验证。

## 回滚

- HF artifact lane：在 GitHub Actions `CI/CD` 手动输入上一个已验证 Commit SHA 并设置 `deploy_hf=true`，等待 artifact manifest、HF repo/runtime SHA 与 HTTP smoke 回读；
- 其他部署平台：切回上一 Tag 或固定镜像 digest；
- GHCR：固定上一版本镜像，不依赖 `latest`；
- 配置：恢复上一版 apps、agents、bindings 与 Prompt；
- 数据库：使用 `npm run platformctl -- config restore <file> --confirm=RESTORE` 完成校验和原子替换，再回读 active/draft、audit 与 Vault fingerprint；
- 其他数据：SQLite restore 不包含 Session、OAuth、附件、Workspace、lark-cli profile 或 encryption keys，需从一致性备份分别恢复；
- Secret：不复用已经泄漏或撤销的值；
- Model Broker：回滚时确认 Worker capability 与上游协议同时匹配旧版本。
