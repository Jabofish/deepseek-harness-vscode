# 能力矩阵

这是功能范围的唯一清单。文档只描述当前能力、完成条件和状态，不承载审计日记、缺陷流水、原始终端输出或逐次变更记录。用户可见的版本变化只记录在 [版本更新日志](../apps/extension/CHANGELOG.md) 中。

## 状态规则

- `DONE`：代码、自动测试和所需的真实 DSH / VS Code 运行验证全部完成。
- `PARTIAL`：已有部分实现或自动测试，但仍缺真实运行、负面路径、跨平台、可访问性或发布证据。
- `TODO`：尚未形成可验收实现。

没有真实运行证据的能力不得因为构建成功而标为 `DONE`。未知 DSH 版本只允许使用已经核对过的 wire 做只读兼容探测；版本专属字段、事件和 Session wire 必须精确匹配，无法支持时返回 `CAPABILITY_UNAVAILABLE`。

## 当前基线

- 扩展当前发布基线为 `0.1.11`；本轮修改不 bump 版本、不创建新 tag，也不触发发布。
- 已知 DSH 版本按真实协议边界使用独立 Adapter：legacy Host、alpha family v0、Session v2 和 Session v3 不跨 wire family 猜测。
- 已新增 DSH `0.1.6-alpha.1` 的精确 `alpha161` Adapter，并在 npm alpha 通道的真实 `0.1.6-alpha.1` 上通过 live smoke：managed `--no-open` 启动、`mode=exact` 精确探测、只读 surface 与 transcript 归约全部成功；Connection/Gateway 与 Session v3 基础 wire 复用已核对的 `rc152` 边界，`image/offload` 仅按脱敏 opaque 事件保留。其消息投影 UI、终端、权限预设、归档恢复和 Skill 路径等新增 surface 仍未实现，安装器默认仍为 `0.1.5-rc.2`。
- Webview 不接触 endpoint、进程句柄、凭据、文件系统或网络；所有 DSH、文件、进程和 Secret 操作由 Extension Host 负责。
- 代码与自动测试已经覆盖若干条目，但完整的 DSH 版本矩阵、VS Code Webview 现场回放、跨平台发布验证和可访问性人工验证仍是主要缺口，因此当前条目保持 `PARTIAL`。

## 新增与扩展能力

| ID     | 能力                                                   | 主要实现位置                            | 完成证据                                                                                                              | 状态    |
| ------ | ------------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------- |
| ED-01  | 编辑器上下文捕获、符号/诊断投影、一次性 Prompt 引用    | Extension Host editor context、Composer | VS Code Language Service、Webview 和真实 DSH Prompt/Queue 回放                                                        | PARTIAL |
| SY-01  | 当前光标符号、诊断和文档版本安全捕获                   | editor context provider、Composer       | 多根工作区、Language Service 和真实 DSH 回放                                                                          | PARTIAL |
| NAV-01 | 文件、位置和变更行导航                                 | NavigationService、Host route、Changes  | 多根工作区、路径边界和真实 VS Code 导航回放                                                                           | PARTIAL |
| RV-01  | 结构化变更预览、去重、审阅决定和 Host 写回             | ChangeSetTracker、ChangesDrawer         | 真实 DSH 已结算 diff 行的全部 hunk、宿主绝对路径拟合、filesystem observation 和 Webview 回放                          | PARTIAL |
| TC-01  | 当前会话/工作区任务汇总、范围切换和取消语义            | TaskCenterRegistry、TasksDrawer         | 跨会话事件重放、交互归属和真实 DSH 回放                                                                               | PARTIAL |
| CP-01  | 内容快照检查点、漂移预览、覆盖/中止恢复和启动恢复      | CheckpointStore、CheckpointDrawer       | 快照字节即创建时刻文件内容、`abort`/`overwrite` 双策略与 Drawer 回放、崩溃日志恢复；缺 workspace trust 与远程文件系统 | PARTIAL |
| PT-01  | Prompt 模板、变量校验和 Ask/Plan/Act/Debug/Review 模式 | Prompt template store、Composer         | 持久化 reload、运行中切换和真实 DSH 回放                                                                              | PARTIAL |
| RF-01  | 脱敏诊断快照、刷新、复制、Output 和重连入口            | diagnostics store、RuntimeStatus        | DSH 故障注入、事件缺口和 VS Code Webview 回放                                                                         | PARTIAL |

## 核心能力

| ID    | 能力                                                                 | 主要实现位置                                              | 完成证据                                                                                                                                              | 状态    |
| ----- | -------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| RT-01 | Runtime 定位：配置路径、PATH、npm global、版本兼容、Windows `.cmd`   | `apps/extension/src/backend/runtime-locator.ts`           | 缺失、shim、版本不兼容和真实运行时定位                                                                                                                | PARTIAL |
| RT-02 | 缺失 DSH：安装提示、复制命令、选择路径、重试，不自动安装             | `RuntimeMissingView.tsx`、runtime commands                | UI 负面路径和最小 VS Code 回放                                                                                                                        | PARTIAL |
| RT-03 | DSH 版本身份、精确 Adapter 选择和未知版本安全回退                    | versioned adapter、probe                                  | 全部支持版本与未知版本拒绝/降级矩阵                                                                                                                   | PARTIAL |
| CN-01 | `auto` 先发现再启动，健康候选逐个回退，并发连接合并                  | DSH connection coordinator                                | 候选失败、并发请求和真实托管启动                                                                                                                      | PARTIAL |
| CN-02 | `attach-only` 绝不启动；`new-isolated` 只创建一个受管实例            | coordinator、process supervisor                           | attach-only 和 owned-process 生命周期回放                                                                                                             | PARTIAL |
| CN-03 | 自定义端口、端口 0、配置/Known/默认/OS/companion 发现，无宽泛扫描    | backend discovery                                         | 端口边界、候选优先级和跨平台发现测试                                                                                                                  | PARTIAL |
| CN-04 | 外部/受管所有权：只停止当前扩展创建并持有句柄的子进程                | process supervisor、coordinator                           | 外部进程存活、受管进程释放和异常退出                                                                                                                  | PARTIAL |
| CN-05 | 断线恢复、事件续接、历史补洞、无重复事件                             | stream controller、session store                          | 断流、重连、缺口、取消和长会话回放                                                                                                                    | PARTIAL |
| VS-01 | Activity Bar View、Secondary Side Bar 和一次性右栏引导               | extension manifest、sidebar commands                      | 最低 VS Code 的真实视图移动回放                                                                                                                       | PARTIAL |
| WS-01 | Workspace 列表/创建/重命名/删除/排序、目录选择、多根工作区           | workspace repository、SessionDrawer                       | 多根、无文件夹、信任边界和真实回放                                                                                                                    | PARTIAL |
| SS-01 | Session 新建、列表、分页、历史、搜索、重命名、分叉、归档、删除、恢复 | session repository、use cases、SessionDrawer              | 完整生命周期、分页、搜索边界与降级、改名回执、恢复和真实 DSH 回放                                                                                     | PARTIAL |
| CV-01 | 文本流、推理、工具、错误、重试、标题、统计和历史回放                 | rc6 mapper、timeline、Timeline                            | 结构化事件、畸形事件、重连和历史回放                                                                                                                  | PARTIAL |
| IN-01 | Composer 文本、IME、发送/停止和运行状态                              | `features/composer/Composer.tsx`                          | IME、取消、失败恢复、投递预览收敛和真实 Prompt 回放                                                                                                   | PARTIAL |
| IN-02 | Queue/Steer、队列查看/编辑/删除/转 Steer、取消                       | session repository、queue UI                              | 队列竞态、非文本行编辑保护、内联文件行投影、Steer 收敛和真实 DSH 回放                                                                                 | PARTIAL |
| AT-01 | 图片/文件粘贴、拖放、选择、预览、持久化、历史读取和限制              | attachment features、Extension file boundary              | 大小/类型/失败/取消和真实 VS Code 回放                                                                                                                | PARTIAL |
| MD-01 | 动态 Provider/Model/Reasoning 发现、选择、不可用状态和会话应用       | model repository、model features                          | 动态目录、未知项、逐 Provider 失败原因（宿主原文且不阻断可用分组）、目录失效刷新、`routable` 判定下的惰性输入与真实 DSH 回放                          | PARTIAL |
| AG-01 | 标准/code/minimal/cordis、用户 Preset、Tools native/code/both        | session config、picker、settings                          | 动态能力、持久化、未知值和真实 DSH 回放                                                                                                               | PARTIAL |
| PM-01 | `read-only`/`workspace-write`/`full-access`/custom 权限与审批一致    | session config、ApprovalCard                              | 审批一次性、过期、取消、审批命令预览（`callId` 配对调用卡）和真实 DSH 回放                                                                            | PARTIAL |
| PL-01 | Plan Mode、Goal 生命周期、Todo 和恢复一致                            | goal repository、GoalTodoStrip                            | 生命周期、重连、恢复、阻塞原因投影和真实 DSH 回放                                                                                                     | PARTIAL |
| IQ-01 | User Question 单选/多选/自由文本和过期恢复                           | interaction repository、UserQuestionCard                  | 畸形问题、过期、取消和真实 DSH 回放                                                                                                                   | PARTIAL |
| JB-01 | Jobs 列表、输出、进度、完成通知和停止                                | job repository、JobsDrawer                                | 进度、错误、停止和真实 DSH 回放                                                                                                                       | PARTIAL |
| SA-01 | Subagent 树、历史、Follow-up、Interrupt 和父子路由                   | subagent repository、SubagentDrawer                       | 父子路由（目录地址透传、父级归属）、目录、自述标签归一化、取消、历史分页和真实 DSH 回放                                                               | PARTIAL |
| WF-01 | Workflow/Ralph 列表、阶段、启动、完成/失败/取消                      | rc6 mapper `tool-workflow` 事件、timeline、WorkflowDrawer | 阶段流转、中断投影、畸形事件降级和真实 DSH 回放                                                                                                       | PARTIAL |
| SK-01 | Skills 项目/用户/插件发现、优先级、刷新和执行                        | skill repository、Composer/CommandPalette 手势            | 动态目录、无来源投影、user-only 语义和真实 DSH 回放                                                                                                   | PARTIAL |
| CM-01 | 动态命令、`/plan`、`/goal`、`/compact`、`/feedback` 和参数提示       | command repository、CommandPalette                        | 动态目录、附件参数版本边界和参数校验                                                                                                                  | PARTIAL |
| ST-01 | DSH Settings Schema、读取、更新、替换以及 live/restart 语义          | settings repository、SettingsDrawer                       | schema 负面路径、持久化和真实 DSH 回放                                                                                                                | PARTIAL |
| ST-02 | Provider Secret 仅通过密码输入/DSH 凭据 API，UI 只见状态             | credential repository、credential input                   | Secret 隔离、取消、错误和真实 DSH 回放                                                                                                                | PARTIAL |
| PG-01 | Plugin Inventory、能力、显式配置、重连/重启提示和未知插件降级        | plugin repository、PluginInventory                        | 动态目录、未知插件和真实 DSH 回放                                                                                                                     | PARTIAL |
| TL-01 | 通用 Tool Card 与 Shell/Edit/Search/LSP/MCP 等结构化 Renderer        | UI registry、rc6 tool mapping                             | 官方 catalog、未知工具、嵌套调用、无 `view` 的 alpha 线按 `meta` 形状与调用参数派生卡片、已结算 shell 行在时间线结算出输出与退出码、真实 Webview 回放 | PARTIAL |
| EX-01 | Markdown/JSON/ZIP 会话与附件流式导出、取消和安全路径                 | export repository、ExportDialog                           | 大会话、Zip Slip、取消、覆盖和真实 DSH 回放                                                                                                           | PARTIAL |
| UX-01 | 草稿、上次会话恢复、Quick Pick、通知和错误恢复，不自动发消息         | Webview store、VS Code commands                           | reload、焦点、失败恢复和真实 Webview 回放                                                                                                             | PARTIAL |
| PF-01 | 单流共享、批量 Delta、虚拟列表、缓存失效和资源释放                   | stream、timeline、store                                   | 性能、长会话、heap/handle 和恢复基线                                                                                                                  | PARTIAL |
| SC-01 | Loopback、CSP、Schema 校验、无 shell、日志脱敏和 Workspace Trust     | Extension、Protocol、diagnostics                          | 安全负面矩阵、信任边界和跨平台验证                                                                                                                    | PARTIAL |
| AX-01 | 键盘、焦点、屏幕阅读器、亮暗/高对比、240px 和 Reduced Motion         | UI/Webview                                                | axe、弹层焦点归属、人工矩阵、窄视口和真实 Webview 回放                                                                                                | PARTIAL |
| RL-01 | CI 三平台、VSIX、版本/隐私/许可证/升级/回滚                          | workflows、release docs                                   | clean checkout、三平台安装和回滚验证                                                                                                                  | PARTIAL |

## 证据入口

- 自动门禁：`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`。
- 真实 DSH 只读 smoke：见 [`tests/live-dsh/README.md`](../tests/live-dsh/README.md)；只验证扩展自己创建的进程，不接管外部 DSH。
- VS Code/Electron 验证：见 [`tests/vscode-e2e/README.md`](../tests/vscode-e2e/README.md)；套件是显式 opt-in，不以粘贴运行日志代替验收条件。
- DSH 固定契约、版本边界和降级规则：见 [`dsh-contract.md`](dsh-contract.md) 与 [`protocol.md`](protocol.md)。

## 可选 DSH 能力

MCP、LSP、Schedule、Plugin、Workflow、Ralph、第三方 Tool 等能力必须先从 DSH 的结构化目录或能力声明中发现。未声明、未验证或当前版本不支持时，客户端显示不可用或安全降级，不硬编码清单、不把模型文本当作状态、不伪造 RPC 成功。

## 维护规则

完成一个能力后只更新本表的状态和最短证据入口；不要新增按日期排列的审计章节、缺陷流水、门禁编号、终端转录或临时路径。用户可见的变更写入 [版本更新日志](../apps/extension/CHANGELOG.md)，协议变化写入 [`dsh-contract.md`](dsh-contract.md) / [`protocol.md`](protocol.md)，架构决策写入 ADR。
