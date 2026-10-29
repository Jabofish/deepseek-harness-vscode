# 贡献指南

[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

欢迎提交修复、文档、翻译和测试。Issue 和 PR 可以使用中文或英文。报告问题时附最小复现，修改行为时给出前后示例。小的文档修正可以直接提交 PR。

## 开始之前

- 检查现有 Issue 和 PR。较大的功能或架构调整，先通过 Issue 讨论问题与范围，再开始实现。
- 阅读[架构规范](../docs/architecture.md)、[能力矩阵](../docs/capability-matrix.md)中的相关条目和[测试指南](../docs/quality.md)（英文）。其他主题及文档语言见[文档索引](../docs/README.md)。
- 涉及上游集成时，按 [DSH 契约](../docs/dsh-contract.md)中的固定 tag/commit 和真实接口来源核对，不能根据界面文案或模型输出猜测 RPC 与能力。
- 漏洞按[安全策略](SECURITY.md)私下报告，不要在公开 Issue 中披露敏感数据。

## 准备开发环境

Node 使用根 [package.json](../package.json) 的 `engines` 支持范围，pnpm 使用 `packageManager` 声明的版本。已安装 Corepack 时可执行 `corepack enable` 启用入口；否则单独安装该版本的 pnpm。安装依赖前用 `node --version` 和 `pnpm --version` 检查版本。VS Code 最低版本见[扩展 manifest](../apps/extension/package.json)。

没有写入权限时先 Fork，将下方 `YOUR-ACCOUNT` 替换为 Fork 所属账号。命令同时适用于 PowerShell 和 POSIX shell：

```sh
git clone https://github.com/YOUR-ACCOUNT/deepseek-harness-vscode.git
cd deepseek-harness-vscode
git remote add upstream https://github.com/Jabofish/deepseek-harness-vscode.git
git fetch upstream main
git switch -c my-change upstream/main
pnpm install --frozen-lockfile
pnpm build
node -e "require('node:fs').mkdirSync('.test-workspace', {recursive: true})"
```

已有工作区按实际 remote 操作，保留未提交内容。pnpm 命令均在仓库根目录执行。默认自动化测试使用 fixture，无需全局安装 DSH、配置模型凭据或打开真实 VS Code 窗口。

## 找到对应层

| 位置                                                               | 职责                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `apps/extension/`                                                  | VS Code API、进程/文件/网络/凭据所有权、Host 路由与装配             |
| `apps/webview/`                                                    | React UI、视图状态与多语言文案                                      |
| `packages/domain/`、`packages/application/`                        | 与平台无关的类型、规则、端口与用例                                  |
| `packages/dsh-adapter/`                                            | 按版本实现 DSH 握手、RPC/Event 映射与恢复                           |
| `packages/timeline/`、`packages/webview-protocol/`、`packages/ui/` | 不可变时间线归约、安全的 Host/Webview DTO 与共享渲染组件            |
| `packages/dsh-editor-bridge/`                                      | 加载在 DSH 内的可选编辑器配套 bundle                                |
| `tests/`、`config/`、`scripts/`                                    | 跨层/真实运行时/Electron 测试、共享测试和 TypeScript 配置及开发工具 |

测试通常放在实现文件旁，使用 `*.spec.ts` 或 `*.spec.tsx`。沿用相邻代码及仓库的格式、lint 规则。

## 开发与测试

每个 PR 处理一个具体问题，遵守分层和信任边界。[AGENTS.md](../AGENTS.md) 列出了开发者与 Coding Agent 共用的实现要求。

用 VS Code 打开仓库根目录，在“运行和调试”中选择 **Run JaboDSH Extension**。F5 会执行构建任务，再以上面创建的 `.test-workspace/` 启动 Extension Development Host；Ctrl+F5 不附加调试器。在新窗口中打开 **JaboDSH** 视图，连接开发用 DSH，验证本次涉及的交互。`pnpm dev` 用于监听 Webview 和扩展构建。交互测试使用可丢弃的会话与工作区。

按[验证矩阵](../docs/quality.md#choose-validation-by-change)选择检查。开发时可用 `pnpm test:changed` 执行受影响的测试和固定契约测试，`pnpm test:contracts` 只执行固定契约测试。代码 PR 提交评审前运行 `pnpm check`、`pnpm build` 和 `git diff --check`；纯文档修改按指南运行文档检查。压力、真实 DSH 与 Electron 测试需单独启用，影响相应路径时再执行。命令和人工交互场景见[测试指南](../docs/quality.md)。

Webview 文案同时维护 `apps/webview/src/locales/en.json` 与 `zh.json`，不要写死在组件内。使用 `pnpm i18n add <key> "<English>" "<中文>"`、`pnpm i18n set <key> <en|zh> "<text>"`、`pnpm i18n remove <key>` 和 `pnpm i18n find <regex>`；`pnpm i18n:check` 检查键和占位符。

## 提交 Pull Request

1. 检查 `git diff` 与 `git status --short`，只提交预期文件。生成的 media、VSIX、凭据、私人路径、本地计划与无关修改不进入 PR。
2. 将分支推送到自己的 Fork，向本仓库 `main` 发起 PR。未完成的工作可先建 Draft PR。[PR 模板](PULL_REQUEST_TEMPLATE.md)支持中英文填写，不适用的部分可删除。
3. 说明问题、修改后的行为，按需关联 Issue/能力 ID，以及兼容性影响。希望 Issue 保持打开时写 `Related to #...`，验收完成后才使用自动关闭关键词。
4. 记录命令与结果、相关人工步骤、环境/运行时版本，以及未执行检查的原因。使用简短的[结果格式](../docs/quality.md#report-test-results)即可。可见界面变化附脱敏的前后截图或相关交互的短录屏。
5. 等待必需 CI 通过，处理有效审查意见。PR CI 运行受影响测试与固定契约，`main` 运行分片全量测试，并在 Linux、Windows、macOS 构建。涉及真实 DSH 或 UI 的检查时，另行记录相应结果。

用户可见行为变化写入[扩展更新日志](../apps/extension/CHANGELOG.md)。文档所描述的行为变化时，同步英文/中文 README 与 Marketplace 说明。技术规则在对应文档中维护，单次验证结果和限制记录在 PR。

## 与 Coding Agent 协作

让 Agent 修改前先读 [AGENTS.md](../AGENTS.md)，提供 Issue、预期行为、不涉及的范围及需要完成的交付步骤。项目规则统一维护在 `AGENTS.md`；[CLAUDE.md](../CLAUDE.md) 为 Claude Code 导入同一文件。其他工具未自动加载时，显式指向 `AGENTS.md`。

提交前审查 Agent 的 diff、测试与验证证据，检查许可并移除私人数据。Agent 应列明未执行的检查，并按任务授权完成 commit、push、合并或发布。
