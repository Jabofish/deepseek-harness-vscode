# Security policy / 安全报告

Security fixes target the latest release line. Include the affected extension and DSH versions in your report. If you can safely check a newer release, include that result too.

## Find a private reporting channel

Do not post exploit details, private workspace data, prompts, credentials or unredacted logs in a public issue or discussion.

1. If the repository's **Security → Report a vulnerability** action is available, use it for a private report.
2. If that action is unavailable, use a [non-sensitive support request](https://github.com/Jabofish/deepseek-harness-vscode/issues) or [discussion](https://github.com/Jabofish/deepseek-harness-vscode/discussions) to ask the maintainer for a private contact channel. Ask for a private security contact without technical details, then send the reproduction through that channel.

In the private report, include the affected versions and platform, local/custom connection mode, relevant workspace-trust or companion state, minimal sanitised reproduction, expected/actual result and security impact. Use synthetic files or data where possible; API keys, passwords, launch URLs/tokens and real prompt/tool bodies are unnecessary.

The [architecture specification](../docs/architecture.en.md) describes Host/Webview boundaries, endpoint validation, process ownership, credentials, file containment and diagnostic handling. A normal functional bug belongs in the [support flow](../apps/extension/SUPPORT.md). If the issue originates in [DSH itself](https://github.com/deepseek-ai/deepseek-harness), first establish an appropriate private channel with its maintainers; keep exploit details private while arranging that contact.

## 中文说明

不要公开漏洞细节、真实工作区内容、凭据或未脱敏日志。优先使用 GitHub 的私密漏洞报告入口；若入口不可用，先通过不含技术细节的支持请求或讨论索取私密联系渠道，确认后再提供脱敏复现。注明扩展、DSH、平台、连接模式及相关信任/配套插件状态；旧版本不保证收到修复。
