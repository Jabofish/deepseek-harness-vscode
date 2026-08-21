# DeepSeek Harness for VS Code

> DSH，始终在你的代码旁边。<br>
> Your DSH workspace, right beside your code.

DeepSeek Harness for VS Code 是一个面向 DSH 的原生 VS Code 客户端。它把会话、流式回复、思考过程和工具进度带进侧栏，让你在编辑代码的同时完成任务。

DeepSeek Harness for VS Code is a native VS Code client for DSH. It brings sessions, streaming replies, thinking, and tool progress into your sidebar so you can stay in the editor and stay in flow.

## 核心能力 · Highlights

- **会话与上下文 · Sessions & context** — 按工作区创建、切换、恢复和归档会话。
- **完整时间线 · A clear timeline** — 用户输入、模型回复、折叠思考、工具调用、审批和错误状态各自清晰呈现。
- **可控的运行方式 · Control** — 使用当前 DSH 提供的模型、Provider、Reasoning、权限和 Plan 设置。
- **文件与交互 · Context-aware work** — 发送文本、图片和工作区文件，使用 `@` 引用文件/会话，处理审批与用户问题。
- **反馈与产出 · Close the loop** — 对回复点赞/点踩并补充备注，直接打开工具产生或修改的文件。
- **可靠连接 · Reliable recovery** — 自动发现本机 DSH，支持恢复、去重和脱敏诊断。

## 快速开始 · Get started

1. 打开 `DeepSeek Harness` 视图。<br>
   Open the `DeepSeek Harness` view.
2. 选择或创建工作区，再创建会话。<br>
   Choose or create a workspace, then start a session.
3. 输入任务并发送。<br>
   Type your task and send it.

扩展会自动发现本机已有的兼容 DSH；找不到时会显示安装、选择已有可执行文件、复制安装命令和打开文档的引导。Windows、Linux 和 macOS 均支持本地 Extension Host。

The extension discovers a compatible local DSH automatically. If DSH is not installed, it offers guided actions to install it, select an existing executable, copy the install command, or open the documentation. Windows, Linux, and macOS local Extension Hosts are supported.

设置的常规页会在启动时由 Extension Host 检查 npm 上游版本；发现更新后会显示提示，并允许从上游清单选择一个精确版本下载安装。更新不会停止外部 DSH；正在使用自定义可执行文件时，全局包更新后需要重新选择或重新连接运行时。

The General settings page checks upstream npm versions through the Extension Host at startup. When an update is available, it shows a notice and allows installing one exact version from the upstream list. Updating never stops an external DSH; when a custom executable is selected, the global package update requires selecting or reconnecting the runtime before it is used.

## 安全边界 · Security

连接、文件选择、凭据和进程管理都留在 VS Code Extension Host。Webview 不直接访问网络或文件系统，也不会接触密钥；外部 DSH 不会被扩展擅自停止。

Connections, file access, credentials, and process ownership stay in the VS Code Extension Host. The Webview receives no secrets or direct filesystem/network access, and external DSH processes are never stopped by the extension.

## 兼容性 · Compatibility

当前适配 DeepSeek Harness `0.1.0-rc.6` 至 `0.1.1-rc.2` Host/Web API；任何能报告非空版本标签的未知版本也会尝试以兼容模式连接，并在界面显示警告。支持 Windows、Linux 和 macOS；从扩展内安装 DSH 时需要 Node.js `22.19+`。模型、工具和高级 Agent 能力以当前 DSH 实例为准，未提供的能力会明确提示。

Currently targets the DeepSeek Harness `0.1.0-rc.6` through `0.1.1-rc.2` Host/Web API on Windows, Linux, and macOS. Any unknown version that reports a non-empty label is also attempted in compatibility mode and surfaced with a warning. Installing DSH from the extension requires Node.js `22.19+`. Available models, tools, and advanced Agent capabilities depend on the connected DSH instance.

## 开发 · Development

实现规则、能力状态和上游契约见 [AGENTS.md](AGENTS.md)、[docs/implementation-order.md](docs/implementation-order.md)、[docs/capability-matrix.md](docs/capability-matrix.md) 和 [docs/dsh-contract.md](docs/dsh-contract.md)。

See [AGENTS.md](AGENTS.md), [docs/implementation-order.md](docs/implementation-order.md), [docs/capability-matrix.md](docs/capability-matrix.md), and [docs/dsh-contract.md](docs/dsh-contract.md) for implementation rules and upstream contracts.

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm package:vsix
```

推送 Pull Request 或 `main` 会触发跨平台构建；推送 `v*` tag 会自动生成 Linux、Windows 和 macOS VSIX 并创建 GitHub Release。

Pull requests and pushes to `main` run the cross-platform build. Pushing a `v*` tag packages Linux, Windows, and macOS VSIX files and creates a GitHub Release automatically.
