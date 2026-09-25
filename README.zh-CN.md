# DeepSeek Harness for VS Code

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/Jabofish/deepseek-harness-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/Jabofish/deepseek-harness-vscode/actions/workflows/ci.yml)
[![Marketplace](https://img.shields.io/badge/Marketplace-Install-0078D4?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=Direwolf.deepseek-harness-client)
[![GitHub Release](https://img.shields.io/github/v/release/Jabofish/deepseek-harness-vscode)](https://github.com/Jabofish/deepseek-harness-vscode/releases)
[![License](https://img.shields.io/github/license/Jabofish/deepseek-harness-vscode)](LICENSE)

**DeepSeek Harness Companion for VS Code** 把本地 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)会话带进编辑器。在 VS Code 视图中可以查看流式回复、思考过程、工具活动、审批和可恢复的会话历史。

## 可以做什么

- 在工作区中创建、切换、恢复和归档会话。
- 发送文本、图片和受支持的文件，用 `@` 引用文件或会话。
- 跟进工具进度、回答问题与审批，并通过 VS Code 打开产出文件。
- 选择当前 DSH 运行时提供的模型、Provider、权限和 Agent 选项。
- 在满足前提时使用本地 Prompt 模板、检查点、变更视图和任务中心。

高级能力取决于连接的 DSH 版本；不支持的操作会明确显示不可用。[兼容契约](docs/dsh-contract.md)列出精确 Adapter 边界；[能力矩阵](docs/capability-matrix.md)区分代码实现、自动测试与真实运行验证。

## 安装与开始使用

从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Direwolf.deepseek-harness-client) 安装扩展，或从[最新 GitHub Release](https://github.com/Jabofish/deepseek-harness-vscode/releases/latest)下载对应平台的 VSIX，再执行 **Extensions: Install from VSIX...**。

1. 打开 **DeepSeek Harness** 视图。
2. 如果缺少 DSH，使用引导安装、选择现有可执行文件，或复制视图显示的精确安装命令。安装器会先检查所需的 Node.js 版本。
3. 选择或创建工作区，开始会话并发送任务。

扩展会先查找本机兼容的 DSH。只有所选连接模式允许且发现流程结束后，才会启动实例；扩展绝不会停止不是自己创建的 DSH 进程。

| 连接模式       | 行为                                                       |
| -------------- | ---------------------------------------------------------- |
| `auto`         | 连接正在运行的 DSH；没有候选可连接时才启动扩展持有的实例。 |
| `attach-only`  | 只发现和连接，绝不启动 DSH。                               |
| `new-isolated` | 启动一个专用、由扩展持有的 DSH。                           |
| `custom`       | 只探测用户给定且经过校验的单个 loopback 端点。             |

常规设置页可以检查上游包版本并安装已验证的精确版本。更新全局包不会停止外部 DSH。

## 隐私与支持

DSH 连接、凭据、文件和进程均留在 VS Code Extension Host。Webview 不接收密钥，也不能直接访问文件系统或网络。端点只能是经验证的 loopback 地址，诊断会脱敏。详见[安全模型](docs/architecture.md)和[支持说明](apps/extension/SUPPORT.md)。

开发者文档从[文档索引](docs/README.md)开始；[贡献指南](CONTRIBUTING.md)说明验证与证据要求。用户可见的变化记录在[扩展更新日志](apps/extension/CHANGELOG.md)。项目使用 [MIT 许可](LICENSE)。
