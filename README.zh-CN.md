# DeepSeek Harness for VS Code

> DSH，始终在你的代码旁边。

[English](README.md) | 简体中文

[![CI](https://github.com/Jabofish/deepseek-harness-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/Jabofish/deepseek-harness-vscode/actions/workflows/ci.yml)
[![Marketplace listed](https://img.shields.io/badge/Marketplace-listed-0078D4?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=Direwolf.deepseek-harness-client)
[![GitHub Release](https://img.shields.io/github/v/release/Jabofish/deepseek-harness-vscode)](https://github.com/Jabofish/deepseek-harness-vscode/releases)
[![License](https://img.shields.io/github/license/Jabofish/deepseek-harness-vscode)](LICENSE)

**DeepSeek Harness Companion for VS Code** 是
[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek 本地编码
Agent）的原生 VS Code 客户端。它把会话、流式回复、思考过程和工具进度带进侧栏，让你在编辑代码
的同时完成任务。

## 核心能力

- **会话与上下文** — 按工作区创建、切换、恢复和归档会话。
- **完整时间线** — 用户输入、模型回复、折叠思考、工具调用、审批和错误状态各自清晰呈现。
- **可控的运行方式** — 使用当前 DSH 实例提供的模型、Provider、Reasoning、权限和 Plan 设置。
- **文件与交互** — 发送文本、图片和工作区文件，使用 `@` 引用文件/会话，在原地处理审批与用户
  问题。
- **反馈与产出** — 对回复点赞/点踩并补充备注，直接打开工具产生或修改的文件。
- **可靠连接** — 自动发现本机 DSH，支持重连、去重、历史补洞和脱敏诊断。
- **本地生产力增强** — Prompt 模板、Checkpoint、Changes 抽屉和任务中心，全部由 Extension
  Host 处理，且只在用户显式操作时触发。

## 安装

**从 VS Code 插件市场安装** — 安装
[DeepSeek Harness Companion for VS Code](https://marketplace.visualstudio.com/items?itemName=Direwolf.deepseek-harness-client)，
或在扩展视图中搜索 `DeepSeek Harness`。

**从 GitHub Releases 安装** — 从
[最新发布页](https://github.com/Jabofish/deepseek-harness-vscode/releases/latest)下载
`deepseek-harness-vscode-universal.vsix`（或平台专用包：`linux-x64`、`windows-x64`、
`darwin-x64`、`darwin-arm64`），然后在 VS Code 中执行 _Extensions: Install from VSIX..._。

## 快速开始

1. 如果尚未安装 DSH，执行 `npm install --global @deepseek-ai/dsh`（需要 Node.js `22.19+`），或
   在视图内点击引导安装。
2. 打开 VS Code 的 `DeepSeek Harness` 视图。
3. 选择或创建工作区，创建会话，输入任务并发送。

扩展会自动发现本机已有的兼容 DSH；找不到时提供安装 DSH、选择已有可执行文件、复制安装命令和
打开文档的引导。发现流程总是先于任何启动动作完成；扩展永远不会停止不归它所有的 DSH 进程。

### 连接模式

| 模式           | 行为                                                                             |
| -------------- | -------------------------------------------------------------------------------- |
| `auto`（默认） | 发现并连接正在运行的 DSH；只有无法连接任何实例时才启动本地 DSH。                 |
| `attach-only`  | 只发现和连接，绝不启动 DSH。                                                     |
| `new-isolated` | 总是启动一个专用的、由扩展持有的 DSH 实例。                                      |
| `custom`       | 只探测用户配置的唯一 loopback 端点（`http://127.0.0.1` 或 `http://localhost`）。 |

### 运行时更新

设置的常规页会在启动时检查 npm 上游版本，并允许从已验证的版本清单中选择一个精确版本下载安装。
更新不会停止外部 DSH；使用自定义可执行文件时，全局包更新后需要重新选择或重新连接运行时。

## 兼容性

| 要求             | 版本                                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VS Code          | Windows、Linux、macOS 的 `1.125+`；支持 Remote SSH、WSL 和 Dev Container                                                                                                                                                            |
| DeepSeek Harness | 已发布 CLI/Web API `0.1.0-rc.6` 至 `0.1.2-rc.1`，并提供源码级 `0.1.2-alpha.1`、已发布 `0.1.2-alpha.2`/`0.1.2-alpha.3`/`0.1.2-alpha.4`/`0.1.2-alpha.5` 以及最新源码快照 `0.1.3-alpha.1` 的兼容适配层（预发布源码快照不作为安装默认） |
| 未知版本         | 任何非空版本标签都会优先由可安全复用已验证 wire 的 Adapter 探测；alpha13 Session v2 仅精确匹配，未知运行时回退到已验证的 alpha5 v0 Adapter，并保留真实版本和兼容警告                                                                |
| Node.js          | `22.19+`，仅从扩展内安装 DSH 时需要                                                                                                                                                                                                 |

模型、工具和高级 Agent 能力以当前连接的 DSH 实例为准；未提供的能力会明确提示，而不是静默失败。

## 隐私与安全

连接、文件访问、凭据和进程管理都留在 VS Code Extension Host。Webview 不接触密钥，也没有直接的
文件系统或网络访问；日志采用 allowlist 并对 prompt/body/token 脱敏；所有 DSH 端点必须是经过验证
的 loopback 地址。完整信任模型见 [docs/security.md](docs/security.md)。

## 文档

开发者文档位于 [`docs/`](docs/README.md)，从
[索引页](docs/README.md)开始：

| 文档                                                         | 用途                              |
| ------------------------------------------------------------ | --------------------------------- |
| [docs/architecture.md](docs/architecture.md)                 | 运行时结构、包边界、连接状态机    |
| [docs/capability-matrix.md](docs/capability-matrix.md)       | 功能状态与证据的唯一清单          |
| [docs/dsh-contract.md](docs/dsh-contract.md)                 | 上游 DSH 契约基线与升级流程       |
| [docs/protocol.md](docs/protocol.md)                         | Extension Host ↔ Webview 消息协议 |
| [docs/security.md](docs/security.md)                         | 信任边界与强制控制                |
| [docs/development.md](docs/development.md)                   | 环境、调试与 DSH 联调模式         |
| [docs/testing.md](docs/testing.md)                           | 测试层次、负面路径、fixture 规则  |
| [docs/implementation-order.md](docs/implementation-order.md) | 实施阶段与退出条件                |
| [docs/release-checklist.md](docs/release-checklist.md)       | 发布前必须满足的全部条目          |

## 开发

需要 Node.js `>=22.19 <27` 和 pnpm `11.19`（由 `packageManager` 固定）：

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm check   # format + lint + typecheck + tests
pnpm build
pnpm package:vsix
```

变更纪律与 PR 证据要求见 [CONTRIBUTING.md](CONTRIBUTING.md)；调试与真实 DSH 联调模式见
[docs/development.md](docs/development.md)。

- Pull Request 和对 `main` 的推送会在 Linux、Windows 和 macOS 上运行跨平台 CI。
- 推送 `v*` tag 会为 Linux、Windows 和 macOS 打包 VSIX（另含 universal 包），创建 GitHub
  Release，并把扩展发布到 Visual Studio Marketplace。

## 变更记录与许可

用户可见的变更记录在 [apps/extension/CHANGELOG.md](apps/extension/CHANGELOG.md)，并同步到
[Releases 页面](https://github.com/Jabofish/deepseek-harness-vscode/releases)。基于
[MIT License](LICENSE) 开源。
