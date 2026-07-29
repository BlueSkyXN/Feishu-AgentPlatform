# 支持

## 使用问题

先查阅[快速开始](docs/QUICKSTART.md)、[配置参考](docs/CONFIGURATION.md)、[飞书设置](docs/FEISHU_SETUP.md)和[故障排查](docs/TROUBLESHOOTING.md)。

提交 Issue 前执行：

```bash
npm run platformctl -- doctor
npm run platformctl -- validate
curl -i http://127.0.0.1:7860/healthz
curl -i http://127.0.0.1:7860/readyz
```

请附上版本或 Commit、部署环境、最小复现步骤和脱敏日志。不要公开 Secret、Token、真实用户消息、飞书文档正文、内部 URL 或完整模型请求。

## 安全问题

不要通过公开 Issue 报告可利用漏洞。优先使用 GitHub Private Vulnerability Reporting；仓库未启用时，通过维护者提供的私密渠道联系。详见 [SECURITY.md](SECURITY.md)。
