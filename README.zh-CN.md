# DeepSeek Harness for VS Code

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/Jabofish/deepseek-harness-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/Jabofish/deepseek-harness-vscode/actions/workflows/ci.yml)
[![Marketplace](https://img.shields.io/badge/Marketplace-Install-0078D4?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=Direwolf.deepseek-harness-client)
[![GitHub Release](https://img.shields.io/github/v/release/Jabofish/deepseek-harness-vscode)](https://github.com/Jabofish/deepseek-harness-vscode/releases)
[![License](https://img.shields.io/github/license/Jabofish/deepseek-harness-vscode)](LICENSE)

**DeepSeek Harness Companion for VS Code** 把本地或远程 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)会话带进编辑器。在代码旁查看流式回复、思考、工具、审批和会话历史。

## 可以做什么

- 在工作区中创建、切换、恢复和归档会话。
- 发送文本、图片和受支持的文件，用 `@` 引用文件或会话。
- 跟进工具进度、回答问题与审批，并通过 VS Code 打开产出文件。
- 选择当前 DSH 运行时提供的模型、Provider、权限和 Agent 选项。
- 在满足前提时使用本地 Prompt 模板、检查点、变更视图和任务中心。
- 使用接近 DSH 原版的聚焦布局，按需展开过程详情，并使用紧凑输入栏。在 **设置 → 常规 → 会话布局** 中可以切回原有经典布局；选择保存在本地。

高级能力取决于连接的 DSH 版本；不支持的操作会明确显示不可用。[兼容契约](docs/dsh-contract.md)列出精确 Adapter 边界；[能力矩阵](docs/capability-matrix.md)区分代码实现、自动测试与真实运行验证。

## 安装与开始使用

从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Direwolf.deepseek-harness-client) 安装扩展，或从[最新 GitHub Release](https://github.com/Jabofish/deepseek-harness-vscode/releases/latest)下载对应平台的 VSIX，再执行 **Extensions: Install from VSIX...**。

1. 打开 **DeepSeek Harness** 视图。
2. 如果缺少 DSH，使用引导安装、选择现有可执行文件，或复制视图显示的精确安装命令。安装器会先检查所需的 Node.js 版本。
3. 选择或创建工作区，开始会话并发送任务。

DeepSeek Harness 的 Chat 视图默认注册在辅助侧边栏（VS Code 默认布局中位于编辑器右侧）。如果你以前移动过视图，VS Code 可能保留已有布局；可在命令面板运行 **DSH: Move View to Secondary Side Bar**，选择 Chat 视图和 **New Secondary Side Bar Entry**，或右键视图标题使用 **Move View**。

扩展会先查找本机兼容的 DSH。只有所选连接模式允许且发现流程结束后，才会启动实例；扩展绝不会停止不是自己创建的 DSH 进程。

| 连接模式       | 行为                                                       |
| -------------- | ---------------------------------------------------------- |
| `auto`         | 连接正在运行的 DSH；没有候选可连接时才启动扩展持有的实例。 |
| `attach-only`  | 只发现和连接，绝不启动 DSH。                               |
| `new-isolated` | 启动一个专用、由扩展持有的 DSH。                           |
| `custom`       | 只探测用户给定且经过校验的单个 HTTP(S) 端点。              |

常规设置页可以检查上游包版本并安装已验证的精确版本。更新全局包不会停止外部 DSH。

## 连接外部实例

1. 选择 `custom`，将 `dsh.connection.serverUrl` 设为服务端 HTTP(S) 地址，不带路径、查询参数或凭据。
2. 将 `dsh.connection.runtimeVersion` 设为服务端实际运行的受支持精确版本。
3. 执行 **DSH: Authorize External Connection**，在原生密码框输入启动 token；无需认证的实例可留空，然后连接。

HTTPS 要求可信证书。远程 HTTP 必须确认明文传输，DNS 地址变化后需重新授权。服务端也需接受配置的主机地址；支持时可用 DSH 的 `--trusted-host host:port` 允许代理地址。远程连接不授予本地工作区文件或本地检查器访问权限。

凭据按地址存入 VS Code SecretStorage。使用 **DSH: Clear External Connection Credentials** 清除该地址的凭据。

## 隐私与支持

网络连接、凭据、文件和进程控制均由 Extension Host 处理。Webview 不接收密钥，也不能直接访问文件系统或网络，诊断会脱敏。详见[安全模型](docs/architecture.md)和[支持说明](apps/extension/SUPPORT.md)。

开发者文档从[文档索引](docs/README.md)开始；[贡献指南](CONTRIBUTING.md)说明验证与证据要求。用户可见的变化记录在[扩展更新日志](apps/extension/CHANGELOG.md)。项目使用 [MIT 许可](LICENSE)。
