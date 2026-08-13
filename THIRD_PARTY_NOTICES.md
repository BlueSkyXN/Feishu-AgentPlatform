# Third-party notices

仓库整体按根目录 GPL-3.0 许可证分发。

本仓库的初始 TypeScript 底座由 `feishu-pi-agent-host 0.1.0` 迁入并重构，该底座原许可为 MIT，完整文本保存在 `LICENSES/feishu-pi-agent-host-MIT.txt`。保留该许可不改变组合仓库按 GPL-3.0 分发的要求。

主要运行依赖：

- `@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`：MIT；
- `@larksuiteoapi/node-sdk`：飞书/Lark Node SDK；
- `@larksuite/cli`：Docker 镜像中的飞书 CLI；
- `undici@8.9.0`、`brace-expansion@5.0.9`：由 Pi `0.84.1` 的上游依赖树解析，锁文件固定并由安全门禁回读；
- Node.js 及其传递依赖：各自许可证见对应发行物。

`vendor/skills/*/SOURCE.json` 记录 vendored Skill 的来源与版本。发布前应结合 `package-lock.json` 生成 SBOM，并复核依赖许可证。
