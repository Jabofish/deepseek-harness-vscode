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
- 使用接近 DSH 原版的聚焦布局，按需展开过程详情，并使用紧凑输入栏。在 **设置 → 常规 → 会话布局** 中可以选择聚焦或经典布局；选择保存在本地。
- 在侧边栏旁打开独立导航的编辑器会话标签，窗口重载后恢复各自的会话。
- 在 **设置 → 模型 → 模型计费** 中按需启用会话费用估算，查看输入、输出和缓存分项，选择参考模型或填写自定义单价。中文显示人民币，英文显示美元；汇率刷新失败时沿用已保存的报价。

高级能力取决于连接的 DSH 版本；不支持的操作会明确显示不可用。[兼容契约](docs/dsh-contract.md)列出精确 Adapter 边界；[能力矩阵](docs/capability-matrix.md)概述具体功能、限制和完成状态。

可选的[编辑器集成](packages/dsh-editor-bridge/README.md)仅在你选择 **设置 → 常规 → 编辑器集成 → 安装并启用配套插件** 后加载。启用后自动跟随当前会话及扩展更新，F5 同样遵循安装选择。支持未保存文本、选区、诊断、语言服务、导航和可撤销编辑。设置中可查看状态、持久关闭、切换只读、重试、修复、重启、恢复缓存版本或撤销。能力独立协商；不安装插件也可聊天和手动添加上下文。

## 安装与开始使用

从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Direwolf.deepseek-harness-client) 安装扩展，或从[最新 GitHub Release](https://github.com/Jabofish/deepseek-harness-vscode/releases/latest)下载对应平台的 VSIX，再执行 **Extensions: Install from VSIX...**。

1. 打开 **DeepSeek Harness** 视图。
2. 如果缺少 DSH，使用引导安装、选择现有可执行文件，或复制视图显示的精确安装命令。安装器会显示 npm 输出并验证安装版本；npm 警告本身不会导致安装失败。
3. 选择或创建工作区，开始会话并发送任务。

DeepSeek Harness 的 Chat 视图默认注册在辅助侧边栏（VS Code 默认布局中位于编辑器右侧）。如果你以前移动过视图，VS Code 可能保留已有布局；可在命令面板运行 **DSH: Move View to Secondary Side Bar**，选择 Chat 视图和 **New Secondary Side Bar Entry**，或右键视图标题使用 **Move View**。

打开编辑器聊天标签后，侧边栏仍可使用。通过视图标题栏的**会话**按钮切换或新建会话；原生标题栏在宽度足够时显示完整操作，变窄后逐步将低频操作收进“更多”，优先保留**会话**和**设置**。

标题栏的 **Open Web UI** 默认使用 VS Code 内置浏览器。若要使用系统浏览器，在 VS Code 设置中将 `dsh.webUi.browser` 改为 `external`。

选择 **在编辑器区打开** 或执行 **DSH: Open Chat in Editor Area**（`/moveto:editor`）打开标签，`/moveto:sidebar` 可移回侧边栏。也可拖动已打开的编辑器标签分栏。手动排序时，列表内拖动仍用于调整顺序。

要直接拖拽会话分栏，可执行 **DSH: Open Drag Sessions**，在资源管理器中打开 **DSH Sessions**，将会话行拖到编辑器边缘即可分栏打开。该原生列表默认隐藏，不占用聊天区域；原浮层列表继续保留。

未指定目标时，auto 优先校验上次成功的本机连接，再发现其他实例，最后按需启动。手动指定服务地址或附加端口列表后，只连接这些目标；失败后仍可修改设置或重试。扩展绝不会停止不是自己创建的 DSH 进程。

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

凭据按执行环境和完整 origin 存入 VS Code SecretStorage。当前执行环境没有对应授权时，需要先授权再连接。使用 **DSH: Clear External Connection Credentials** 清除当前执行环境的授权。

## 远程工作区

在 Remote SSH、WSL、Dev Containers 和 Remote Tunnels 下，把扩展和 DSH 安装在工作区所在的一端。发现、安装、进程启动、环回连接和文件操作都使用该 Extension Host 的环境；只装在本机桌面的 DSH 不属于远端工作区。

远程窗口选择附件时保留所选文件系统的 URI。桌面客户端的 Inspector 操作先通过 VS Code 转发已验证的 Worker，再打开或复制 DevTools 链接；浏览器客户端不提供原生 DevTools。容器重建需要配置容器内的运行时安装及 DSH 数据持久化。

## 隐私与支持

网络连接、凭据、文件和进程控制均由 Extension Host 处理。Webview 不接收密钥，也不能直接访问文件系统或网络，诊断会脱敏。详见[安全模型](docs/architecture.md)和[支持说明](apps/extension/SUPPORT.md)。

开发者文档从[文档索引](docs/README.md)开始；[贡献指南](.github/CONTRIBUTING.md)说明验证与证据要求。版本更新见[扩展更新日志](apps/extension/CHANGELOG.md)。项目使用 [MIT 许可](LICENSE)。
