# DeepSeek Harness for VS Code

> DSH，始终在你的代码旁边。<br>
> Your DSH workspace, right beside your code.

在 VS Code 里直接使用 DeepSeek Harness：管理会话、发送任务、查看实时回复和工具进度，不必在编辑器与独立网页之间来回切换。

Use DeepSeek Harness where you work: manage sessions, send tasks, and follow replies and tool progress without leaving VS Code.

## 为什么值得安装 · Why install it

- **保持专注 · Stay in flow** — 在 VS Code 侧栏完成任务，工作区和会话上下文一目了然。
- **看清全过程 · See the whole run** — 用户输入、模型回复、折叠思考和连续工具调用按时间线呈现。
- **掌控运行方式 · Stay in control** — 按当前 DSH 能力选择模型、Provider、Reasoning、权限和 Plan。
- **带上工作内容 · Bring your context** — 发送文本、图片和工作区文件，以 `@` 引用文件/会话，及时处理审批与用户问题。
- **闭环交互 · Close the loop** — 对回复点赞/点踩并补充备注，直接打开工具产生或修改的文件。
- **遇到问题也有答案 · Recover with confidence** — 连接、恢复、错误和不可用能力都有明确状态与诊断。

## 三步开始 · Start in seconds

1. 打开 VS Code 的 `DeepSeek Harness` 视图。<br>
   Open the `DeepSeek Harness` view in VS Code.
2. 选择或创建工作区，再创建会话。<br>
   Choose or create a workspace, then start a session.
3. 输入任务并发送。<br>
   Type your task and send it.

扩展会自动发现本机已有的兼容 DSH；如果没有找到，会提供安装、选择已有可执行文件、复制安装命令和打开文档的下一步引导。

The extension discovers a compatible local DSH automatically. When it is missing, the view offers guided actions to install it, select an existing executable, copy the install command, or open the documentation.

设置的常规页会在启动时检查 npm 上游版本；有更新时可从已验证的上游版本清单选择精确版本下载安装。更新操作在 Extension Host 执行，不会把 npm 配置、路径或凭据发送到 Webview，也不会停止外部 DSH。

The General settings page checks upstream npm versions at startup. Available releases can be selected from the verified upstream list and installed exactly. The operation runs in the Extension Host, never sends npm configuration, paths, or credentials to the Webview, and never stops an external DSH.

## 兼容性 · Compatibility

- Visual Studio Code `1.125+`
- Windows, Linux, or macOS local Extension Host
- DeepSeek Harness `0.1.0-rc.6` through `0.1.0-rc.8` Host/Web API; unknown non-empty version labels are attempted in compatibility mode
- Node.js `22.19+` when installing DSH from the extension

模型、工具和高级 Agent 能力由当前 DSH 实例决定；未提供的能力会安全降级并明确提示。

Available models, tools, and advanced Agent capabilities depend on your DSH instance. Unsupported capabilities are surfaced clearly and safely.

## 隐私与安全 · Privacy & security

DSH 连接、文件选择、凭据和进程管理均由 VS Code Extension Host 处理。Webview 不直接访问网络或文件系统，也不会接触密钥；扩展不会擅自停止外部 DSH。

Connections, file access, credentials, and process ownership stay in the VS Code Extension Host. The Webview never receives secrets or direct filesystem/network access, and external DSH processes are not stopped by the extension.
