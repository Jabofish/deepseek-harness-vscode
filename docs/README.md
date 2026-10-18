# 开发者文档

本目录描述**当前有效的架构、契约、功能边界和验收条件**。

## 唯一职责

| 文档                                         | 唯一职责                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [architecture.md](architecture.md)           | 分层、连接与进程所有权、Extension Host/Webview 协议、安全边界及其决策理由                  |
| [dsh-contract.md](dsh-contract.md)           | DSH 版本身份、上游来源、wire 差异、启动参数与兼容策略；开发文档中唯一列出 DSH 版本号的文件 |
| [capability-matrix.md](capability-matrix.md) | 按功能分组列出具体能力、可用范围、限制和完成状态                                           |
| [ui.md](ui.md)                               | Webview 的颜色、排版、布局、动效及可访问性规则                                             |
| [quality.md](quality.md)                     | 开发环境、垂直切片、测试、联调、PR 和发布门禁                                              |

[AGENTS.md](../AGENTS.md) 是实现代理的操作规则；[CONTRIBUTING.md](../CONTRIBUTING.md) 是 GitHub 贡献入口。用户说明分别见 [README.md](../README.md)、[README.zh-CN.md](../README.zh-CN.md) 和 Marketplace 使用的 [扩展说明](../apps/extension/README.md)。发布内容见[扩展更新日志](../apps/extension/CHANGELOG.md)。

## 文档范围

| 主题                             | 事实来源                                     |
| -------------------------------- | -------------------------------------------- |
| 上游 DSH 契约或适配器            | `dsh-contract.md`                            |
| 跨层、进程、文件、凭据或消息边界 | `architecture.md`                            |
| UI 布局与可访问性                | `ui.md`                                      |
| 能力范围、限制与完成度           | `capability-matrix.md`                       |
| 工作流、测试或发布要求           | `quality.md`；实现代理操作规则见 `AGENTS.md` |
| 用户操作、安装或支持信息         | 英文、中文 README 与 Marketplace 扩展说明    |

能力矩阵只记录具体能力、可用范围、限制和完成状态，不列源码和测试文件链接，也不保存验证流水；必要的文档引用可以保留。完成状态仍须满足质量流程中的验证要求；构建成功不等于能力完整可用。

## 防退化门禁

`pnpm docs:check` 检查本地链接、文档结构、能力 ID、版本事实来源及安装默认与代码的一致性，并作为 `pnpm check` 的一部分运行。上游契约以目标 tag 的源码和脱敏 fixture 为依据；英文、中文与 Marketplace 文案描述相同的产品行为。
