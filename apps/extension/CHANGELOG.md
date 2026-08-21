# Change Log

## 0.0.6

- 完成 DSH rc.8 接入，同时保留 rc.6/rc.7 适配与未知版本的兼容降级；补齐工具、反馈、引用、模型、设置和运行时更新通路。
- 增加自动/自定义本地 DSH 端点选择、启动前运行时发现、更新版本选择与通知关闭，并修复流式时间线、工具包装和窄窗口布局问题。

- Completes DSH rc.8 integration while retaining rc.6/rc.7 adapters and a warning-based fallback for unknown versions; adds tools, feedback, references, model, settings, and runtime-update paths.
- Adds automatic or custom local DSH endpoint selection, startup runtime discovery, selectable updates with dismissible notices, and fixes streaming timelines, tool presentation, and narrow-Webview layout issues.

## 0.0.5

- 修复流式回复未及时刷新、工具调用被拆分隐藏以及任务完成状态误判，完成后可立即复制或创建分支。
- 补充会话、代码块和表格的复制操作，并保持任务进度、模式切换和中英文界面的一致展示。

- Fixes delayed streaming updates, hidden or split tool calls, and incorrect task termination state so completed replies immediately expose copy and branch actions.
- Adds copy actions for conversations, code blocks, and tables while keeping task progress, mode switching, and bilingual labels consistent.

## 0.0.4

- 完善 DSH rc.6 会话、事件时间线、队列、交互、附件、导出、目标、任务、子代理和工作流展示。
- 收紧上游响应与事件校验，改进断流恢复、资源释放、凭据脱敏和动态设置处理。
- 补充适配器契约、应用层、时间线、协议和 Webview 测试覆盖。

- Completes the DSH rc.6 session, event timeline, queue, interaction, attachment, export, goal, job, subagent, and workflow surfaces.
- Tightens upstream response and event validation, stream recovery, disposal, credential redaction, and dynamic settings handling.
- Expands adapter contract, application, timeline, protocol, and Webview test coverage.

## 0.0.2

- 首个公开版本：在 VS Code 中管理 DSH 会话、流式回复、折叠思考和连续工具调用。
- 支持 Windows、Linux、macOS 的本地 DSH 发现、工作区感知、会话恢复、权限/模式切换与斜杠命令。
- 提供缺失运行时引导、错误诊断、上下文用量展示和安全的 Extension Host 边界。

- First public release: manage DSH sessions, streaming replies, collapsed thinking, and grouped tool calls in VS Code.
- Supports local DSH discovery, workspace awareness, session recovery, permission/mode controls, and slash commands on Windows, Linux, and macOS.
- Includes guided runtime setup, actionable diagnostics, context usage, and a secure Extension Host boundary.

## 0.0.1

- 首个可用版本：在 VS Code 中管理 DSH 会话、流式回复、思考和工具进度。
- 支持 Windows、Linux、macOS 的本地运行时发现，以及 DSH 未安装时的安装/选择/文档引导。
- 支持安全的会话恢复、错误诊断和工作区上下文。

- First usable release: manage DSH sessions, streaming replies, thinking, and tool progress in VS Code.
- Supports local runtime discovery on Windows, Linux, and macOS, with guided setup when DSH is missing.
- Includes session recovery, safe diagnostics, and workspace-aware context.
