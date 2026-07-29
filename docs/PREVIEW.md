# 功能预览与验收

本文区分“无需外部账号即可预览的管理功能”和“必须连接真实飞书/模型后才能验收的业务功能”。页面存在不等于外部闭环已经通过。

## Space 入口

项目 Space：

```text
https://huggingface.co/spaces/BlueSkyXN/Feishu-AgentPlatform
```

管理台：

```text
https://blueskyxn-feishu-agentplatform.hf.space/admin
```

Space 为 private 时，先登录具有访问权限的 Hugging Face 账号。管理台再使用部署时配置的 `ADMIN_TOKEN` 登录；Token 不写入文档、URL 或浏览器截图。

## 无外部凭据可以预览

空数据库以 setup mode 启动，可以检查：

- 中文登录页、错误提示和安全 Cookie；
- 总览中的 App、Agent、Binding、Worker、队列和 Broker 状态；
- App、Agent、Binding Draft 表单；
- Draft validation 错误定位；
- Credential Vault 录入入口、configured/fingerprint 状态和 Secret 不回显；
- revision、Publish、Rollback 和 audit 页面；
- Session 查询、终止、reset 和清理入口；
- Approval 查询与状态；
- `lark-cli` 版本、profile 和 operation 诊断页面；
- 桌面和移动布局、加载态、空状态、错误态。

首次只读验收：

```text
GET /healthz → 200 + status=ok
GET /readyz  → 200 + status=setup_required
GET /admin   → 200
```

| 页面 | 主要 API/数据源 | Setup mode 可预览 | 需要真实外部系统 |
|---|---|---:|---:|
| 总览 | `/api/admin/v1/overview`、Host snapshot | 是 | App/Broker 的 ready 状态需要 |
| Apps / Agents / Bindings | Draft/Config API、SQLite revision | 是 | Publish 后启动需要 |
| Credentials | Vault status/fingerprint | 是 | 有效性验证需要 |
| Revisions / Audit | SQLite config/audit | 是 | 无 |
| Sessions | Session index 与 runtime | 空状态 | 对话、abort/reset 恢复需要 |
| Approvals | Approval store | 空状态 | 飞书卡片 requester/admin 操作需要 |
| `lark-cli` Diagnostics | 配置、版本、profile runtime | 静态诊断 | 真实 read/write scope 需要 |

管理台中的按钮均连接真实 API；setup mode 出现空状态不代表业务闭环已经执行。

## 建议的安全预览数据

在 Draft 中创建但不要 Publish：

```text
Feishu App A
  general（default）
  office（/office）

Feishu App B
  office（default）
```

这样可以预览多个 App、复用 Agent、显式 Binding 和校验错误，而不会连接真实飞书或启动 Worker。不要把虚构 App credential 写入 Vault；使用真实测试 App 时再录入。

## 必须使用真实外部系统验收

以下功能不能靠 UI 或 mock 宣称完成：

- Feishu WS 收消息、断线重连、去重和流式卡片；
- HTTP challenge、加密 Event 和 Card Callback；
- 用户 OAuth、Token refresh 和用户身份 typed tool；
- Cloudflare AI Gateway 的 OpenAI Responses 与 Anthropic 流式调用；
- `lark-cli` read、requester-approved write、admin-approved high-risk write；
- 多 App 复用 Agent 时的凭据、Session、Workspace 隔离；
- 附件下载、多模态图片和 Workspace 相对路径；
- 10,000 持久会话索引、16 并发 Turn 和 Worker LRU；
- `/data` 持久卷重启恢复、Secret 轮换和配置回滚。

对应步骤见[部署检查表](DEPLOYMENT_CHECKLIST.md)。写操作只使用专用测试资源，执行前确认，结束后回读并清理。

## 部署来源确认

每次正式 CD 后检查：

1. GitHub `CI/CD` run 的 source SHA；
2. run artifact `hf-deployment-<source_sha>`；
3. Space 根目录 `DEPLOYMENT_SOURCE.json`；
4. artifact 中的 HF repository SHA 与 runtime SHA 相同；
5. `/healthz`、`/readyz` 和 `/admin` HTTP 状态。

没有这些证据时，只能称为本地或手工预览，不能称为 GitHub Actions 自动部署。
