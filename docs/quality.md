# 开发、验证与发布流程

本文件规定每次改动如何计划、验证和交付，不保存某次运行的日志、发布勾选状态或临时路径。架构约束见 [architecture.md](architecture.md)，精确上游契约见 [dsh-contract.md](dsh-contract.md)，当前能力与证据缺口见 [capability-matrix.md](capability-matrix.md)。

## 环境与日常开发

Node、pnpm 与 VS Code 最低要求以根 `package.json` 的 `engines`、`packageManager` 和扩展 manifest 为准，不在多个文档手抄版本号。首次安装与全量验证：

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

`pnpm check` 包含格式、文档一致性、lint、类型和自动测试；需要打包时执行 `pnpm package:vsix`，检查实际 VSIX 文件清单。开发中用 VS Code 打开仓库根目录，运行 `build` 任务后按 F5 启动 Extension Development Host；修改 Webview 可用 `pnpm dev`。`apps/extension/media/` 是生成物，不提交。没有打开真实文件夹时，Host 在 `globalStorageUri` 创建或恢复受管理的临时工作区，不把用户目录当临时目录清理。

### F5 附加故障

某些 VS Code 自带 js-debug 与 Node 组合在并发探测 `127.0.0.1`、`[::1]` 时，把其中一个地址的拒绝当成整次附加失败；扩展主机会停在第一行。已复现的组合是 Node 24.20 与使用 got 15 的 js-debug；根因和上游修复见 [问题](https://github.com/microsoft/vscode-js-debug/issues/2416)和[修复](https://github.com/microsoft/vscode-js-debug/pull/2417)。确认为这一故障后可运行：

```powershell
node scripts/patch-js-debug-ipv6-probe.cjs            # 然后重载 VS Code 窗口
node scripts/patch-js-debug-ipv6-probe.cjs --restore  # 安装上游修复后还原
```

VS Code 更新可能替换该补丁；不附加调试器时可用 Ctrl+F5。该补丁只让单地址失败淘汰该地址，两个地址都失败仍报错。上游修复在实际使用的 VS Code 中生效后，应还原补丁并删除这段临时排障说明。

## 一个垂直切片

每次只完成一个可验证的能力或契约差异。开始前阅读 README、本文件、矩阵目标行、目标文件的完整 TODO/`unimplemented` 条件，并在目标 DSH tag 的实际源码中核对 RPC、事件与工具契约。不要凭 UI 或函数名猜测上游行为。

1. 确认 Domain 类型与仓储接口、可观察的成功和失败行为。
2. 用脱敏 fixture 写目标 Adapter 契约测试，先让测试证明缺口；新版先建立独立 `versions/<version>` 身份。
3. 实现 mapper、RPC、错误映射、取消和资源释放；版本差异留在 Adapter。
4. 实现 Application 用例、Host route 与严格协议 schema，不向上泄漏 wire 类型。
5. 最后实现 Webview 状态、组件与可访问性；验证窄视图、键盘和故障恢复。
6. 更新矩阵对应 ID 的当前状态及最短证据入口；用户可见变化写扩展更新日志。
7. 执行完整门禁，不用单文件测试替代全量验证；涉及真实 DSH 的能力还须做可复现的隔离运行验证。

任务记录至少写明目标能力 ID、固定上游来源、各层改动、成功/错误/取消/释放条件、测试与完成证据。旧固定 Host API 提交只是对应家族的来源；新的目标版本必须按自己的 tag 核对，见 [dsh-contract.md](dsh-contract.md)。

## 测试与证据等级

| 等级                           | 验证对象                                                 | 不能替代              |
| ------------------------------ | -------------------------------------------------------- | --------------------- |
| 代码与静态检查                 | 类型、依赖边界、格式和构建                               | 行为测试              |
| 自动 Contract/Unit/Integration | 固定 wire、纯规则、状态机、伪 DSH socket、竞态和错误分支 | 真实 DSH/VS Code 行为 |
| 隔离真实 DSH                   | 精确运行包的握手、RPC、流、持久化、进程释放              | Webview 现场交互      |
| VS Code/Electron 与人工验收    | View、协议、焦点、主题、宽度、交互和安装包               | 上游版本契约 fixture  |

`DONE` 要求代码、适用的自动测试和该能力所需的真实 DSH/VS Code 证据都到位；缺少任何一层保持 `PARTIAL`。PR 或发布记录保存确切运行命令、目标版本、平台、结果及可复现步骤；矩阵只链接稳定证据入口，不粘贴原始输出、机器路径、PID、端口或每次门禁流水。

### 必测负面路径

- 无 DSH、非 DSH 端口、版本不兼容、候选逐个失败、未知版本安全降级、并发连接与取消。
- 子进程早退、分段 readiness、端口占用、超时、外部进程存活及受管句柄释放。
- RPC 业务/协议错误、畸形 JSON/Frame、超时、取消、重复/乱序/缺口事件与重连。
- 重复发送和审批、过期交互、模型或设置失败后的回滚、不可用能力的明确降级。
- Secret、Prompt、工具正文、路径和凭据不进入日志、协议或快照；恶意 Webview 参数被 Host 拒绝。
- 导出/附件的大小、路径、覆盖、Zip Slip、符号链接、取消清理和远程文件系统边界。

Fixture 只留结构必需字段，路径、Prompt、名称、模型输出和 key 使用假值，并注明目标 tag/commit、源码文件与类型。更新上游前先运行漂移测试；不能靠更新 snapshot 接受未知差异。版本链测试锁定继承、身份和优先级，但不能代替每个版本的 wire fixture。大流量用生成器，不提交真实会话日志。

### 控制测试规模

新增用例必须对应新的行为分支；同一个断言不在 Domain/Adapter、Application/Host、Webview 三层重复铺设，错误分支在离实现最近的一层覆盖一次，另一层只保留跨层组合的代表性场景。版本契约文件只写该版本相对前序版本的增量，版本选择门与共享 fixture 使用 `packages/dsh-adapter/test/support/` 的 harness，按身份表登记，不复制样板。对一个行为的多次断言可以合并在同一用例内，但不能为此合并不同被测单元，也不能删除必测负面路径。

分层执行：日常开发用 `pnpm test:changed` 只运行受未提交改动影响的用例（Vitest 按依赖图判定）；CI 的 PR 只运行受影响用例，外加 styles 契约这类依赖图之外的规格；`main` 推送与发布 workflow 运行全量 `pnpm check`，作为完整门禁与能力证据入口。依赖图判定不到的改动（CSS、按路径直读的 fixture）由始终执行的契约规格与 `main` 全量兜底；新增这类规格时必须登记到始终执行的范围。

### 隔离真实 DSH

只有明确启用才运行 `tests/live-dsh/`；测试使用独立工作区和隔离的 DSH home（默认新建空目录，可选使用脱敏、可丢弃的预置历史夹具），只启动并停止自己持有的进程，完成 Cookie 交换、精确 Adapter 探测、Session/Workspace 读取、订阅与端口释放。运行包版本必须显式记录，不能用一条未标明版本的 smoke 证明整个矩阵。默认空 home 只覆盖不依赖历史的路径；读取历史的测试只有在显式提供位于系统临时目录中的预置 home 后才运行。

```powershell
$env:DSH_LIVE_SMOKE = '1'
$env:DSH_LIVE_RUNTIME = '<dsh-executable>'
$env:DSH_LIVE_RUNTIME_VERSION = '<exact-supported-version>'
# Optional: a sanitized, disposable DSH home stored directly under the OS temp directory.
$env:DSH_LIVE_HISTORY_FIXTURE_HOME = '<preseeded-temp-dsh-home>'
pnpm exec vitest run tests/live-dsh
```

可执行文件可以是绝对路径或 PATH 中可解析的命令；Windows 的 `.cmd` shim 必须由 harness 解析到可执行入口，不能以 `shell: true` 绕过。Live 文件串行运行，跨 shell 的 managed lock 防止并发启动；测试失败仍须释放自己的资源。历史夹具只能是系统临时目录的直接子目录，不得指向用户生产 profile；不提供时，历史会话、跨页读取、工具卡、导出、子代理子会话和变更审阅测试会跳过，不能把跳过记录算成通过或能力证据。

### VS Code 现场验证

`tests/vscode-e2e/run.ts` 使用本地指定的 VS Code 可执行文件与一次性工作区，默认 attach-only 到受控 loopback fixture；`managed` 模式走真实扩展持有的启动路径。运行器只清理自己的工作区与 socket，不隐式下载 VS Code。

```powershell
$env:DSH_VSCODE_E2E_EXECUTABLE = '<path-to-Code.exe>'
node --experimental-transform-types tests/vscode-e2e/run.ts
```

按需设置 `DSH_VSCODE_E2E_MODE=managed` 与 `DSH_VSCODE_E2E_RUNTIME`；设置 `DSH_VSCODE_E2E_INVALID_SETTINGS=1` 验证错误配置不会阻止激活。套件已能观察激活、命令、Host 真实调用和连接错误；无法从稳定 VS Code API 观察到的焦点、侧栏、缺失运行时按钮、完整会话交互和重连状态，须另作人工验收并保留 `PARTIAL`。UI 改动还需检查亮/暗/高对比、Reduced Motion、长文本和窄侧栏。

### 性能与打包

激活未连接时不启动 DSH、不读取大目录；一个连接只保留一个上游流；Delta 合批、历史虚拟化、导出/附件流式处理，并在断开后释放循环、timer、socket、listener 和 child handle。至少用 10,000 个 Timeline 节点检验虚拟列表的首屏和交互，不能依赖全量 DOM。其他性能阈值由真实基线与测试固定，不能拍脑袋宣布达标。

Webview 入口保持可恢复；动态加载只用于可失败的非首屏资源，新增 Shiki 语言只更新有界 loader，不引入全量语法包或 wasm 引擎。VSIX 的 `.vscodeignore` 是包含清单；打包后用 `vsce ls --no-dependencies` 核对实际内容、sourcemap、许可证、隐私文案及无凭据/临时文件。Webview media sourcemap 不随包发布，Extension Host sourcemap 若发布须检查相对 source 路径。

## PR 与发布门禁

PR 应给出目标矩阵 ID、固定上游来源、测试覆盖、`pnpm check`/`pnpm build` 结果、真实 DSH 及 UI 验证的已做与未做部分。不要为让测试变绿而删 TODO、放宽类型或跳过错误分支。不得提交 `DSH_VSCODE_IMPLEMENTATION_PLAN.md`、`LOCAL_*.md`、凭据、用户路径、构建产物或 VSIX。除非用户明确要求，不自动 commit、push 或发布。

发布前逐项核对：

1. 发布所宣称的能力与矩阵证据一致；未完成的核心路径在用户说明中明确限制，不能把 `PARTIAL` 写成完整支持。
2. 完整门禁、三平台 CI、最低支持 VS Code 的 E2E 和目标 DSH 运行包 smoke 有可追溯结果；没有 live 证据的版本不成为新安装默认。
3. 性能、长会话、恢复、资源释放、键盘、屏幕阅读器、主题、窄宽和 Reduced Motion 已按发布范围验证。
4. 安全负面测试、CSP、脱敏、文件路径与用户触发条件通过；VSIX 清单、全新 Profile 安装/卸载、升级/回滚方案完成复核。
5. Tag、实际 GitHub Release 资产、Marketplace 版本、更新日志与精确版本下载端点逐一核实；不以 tag 或构建成功冒充发布完成。

发布记录和勾选状态放在对应 PR/Release，不写进本规范。若宣称“全部核心能力完成”，矩阵相应条目必须全部为 `DONE` 并具备真实运行证据。
