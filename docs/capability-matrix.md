# 能力矩阵

这是功能范围的唯一清单。`DONE` 必须同时有代码、自动测试和所需的真实 DSH 运行证据；当前尚未满足发布退出条件的能力统一标为 `PARTIAL`，并在证据列写明缺口。已发布 `0.0.1-rc.1/.2/.5`、`0.1.0-rc.2/.3`、rc.6–0.1.2-rc.1、`0.1.2-alpha.2`–`.5`、`0.1.3-alpha.2` 和 `0.1.5-alpha.1/.2/rc.1/rc.2`，以及源码级 `0.1.2-alpha.1`、`0.1.3-alpha.1` 使用独立版本入口；未知运行时按最新可安全复用 wire 的 Adapter 优先进行只读兼容探测，`alpha13`/`alpha132` 的 Session v2 和 `alpha151`/`alpha152`/`rc151`/`rc152` 的 Session v3 仅精确版本可用，所有运行时专属能力仍以 `CAPABILITY_UNAVAILABLE` 和兼容警告边界降级；没有提供的 RPC 不以空实现冒充完成。安装器默认通过 npm `next` 使用精确支持集合中的最新 `0.1.5-rc.2`（npm `latest` 仍为 `rc.1`）。

## 2026-09-13 0.1.11 发布前上游同步审计

上游实时核对结果：`master` 仍为 `c291e7961a515f6d7af9304e7fd1d257929aef26`，最新发布 tag/npm 仍为 DSH `0.1.5-rc.2`（npm `next`；`latest` 为 `0.1.5-rc.1`）。`0.1.5-rc.2` 到当前 master 的审计未发现本扩展消费的 Connection/Gateway、Cookie、`remote.mux` 或 Session v3 wire 变化，因此本次不新增不存在的版本 Adapter，`rc152` 精确入口与未知版本安全回退边界保持不变。

本次扩展代码与自动测试已整理到 `0.1.11`；`pnpm check` 通过 167 个测试文件（1390 个测试通过、1 个跳过），`pnpm build` 通过。新增的结构化工具预览、重连/历史回放、Host-only 行、附件/导出错误等证据仍属于代码与自动测试级别；真实 DSH/Webview 完整 smoke 缺口不因发布而改标为 `DONE`。

本轮历史版本精确适配证据：`packages/dsh-adapter/test/legacy-contract.spec.ts` 覆盖五个 npm-only 版本的 exact probe、旧 command/事件/时区/能力边界，以及 rc.1/rc.2 的 frame parser；`adapter-chain.spec.ts` 和 `launch-contract.spec.ts` 覆盖版本身份、继承优先级和托管启动参数。上述是源码与自动测试证据，不替代五个版本的真实 DSH/VS Code live smoke。

## 2026-08-29 实施批次 E：Agent 编辑器闭环与本地生产力增量

本批次已按 `DSH_VSCODE_AGENT_FEATURE_IMPLEMENTATION_PLAN.md` 的 Slice 1–5 完成代码和自动测试接线，但没有把缺失的真实 DSH/VS Code Webview 运行证据写成完成声明。以下是当前有效证据；更早的“Slice 0 尚未实现”描述仅保留为历史基线。

| ID     | 当前代码与自动证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 仍缺的发布证据                                                                                                                                                             | 状态    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| ED-01  | `EditorContextProvider`、Host-only `EditorContextStore`、workspace path guard、一次性 prompt resolution、TTL/大小/版本/owner/generation/dispose；现已通过 VS Code `vscode.executeDocumentSymbolProvider` 支持嵌套 DocumentSymbol/SymbolInformation 的当前符号捕获，并由 Webview Composer 提供 symbol action；Host 还将当前编辑器可用的 selection/file/symbol/diagnostic 投影为 context keys，并在 `editor/context` 与 `editor/title/context` 注册原生入口，命令复用同一 Host capture route；`apps/extension/src/editor/editor-context-store.spec.ts`、编辑器上下文 provider tests、context-key/command registration tests 与 feature protocol/contract tests。 | 真实 VS Code editor/Webview capture、真实 DSH prompt/queue smoke；当前仅有自动化测试，尚无现场 Language Service/真实 DSH 回放。                                            | PARTIAL |
| SY-01  | VS Code Language Service 符号/诊断上下文：Host 侧定位当前光标最内层符号、校验工作区范围与文档版本、限量并以 opaque ref 交给现有 DSH prompt resolution；Composer 已提供 Current symbol action；`apps/extension/src/editor/editor-context-provider.spec.ts`、`EditorContextActions.spec.tsx` 与 feature capability tests。                                                                                                                                                                                                                                                                                                                                       | 真实 VS Code Language Service provider、Webview 回放和真实 DSH prompt/queue smoke。                                                                                        | PARTIAL |
| NAV-01 | `NavigationService`、Host route、canonical path/range 校验，Changes 行为复用 Host 导航；feature protocol tests。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 真实 VS Code 多根工作区、preserve-focus 和文件导航回放。                                                                                                                   | PARTIAL |
| RV-01  | `ChangeSetTracker` 仅消费结构化 tool presentation/location，带 session/workspace/connection-generation 过滤、dedupe、bounded diff、Host hash observation；`ChangesDrawer` 支持结构化详情、自动 viewed 以及 accepted/rejected/needs-attention 审阅决定，所有写回仍经 Host-owned route；`ChangesDrawer`、tracker/UI tests。                                                                                                                                                                                                                                                                                                                                      | 真实 DSH structured diff/filesystem observation 和 VS Code Webview 回放；恢复仍未开放。                                                                                    | PARTIAL |
| TC-01  | `TaskCenterRegistry` 默认提供当前 session safe summary，并支持用户显式切换到 workspace scope；workspace scope 使用已验证的 `session.list` + 每 session 的 `session.get`/`goal.list`/`job.list`/`subagent.list` 聚合，最多 64 个 session、每批 4 路并发，记录失败/截断会话；Task DTO 带 session label，CAS revision、session cancel 与 process stop 分离；`TasksDrawer` 提供范围切换和不完整来源提示，`TaskUseCases.listSnapshot`/严格 feature response、registry/protocol/UI tests 覆盖。                                                                                                                                                                      | 真实 DSH replay/global task seed、跨会话 interaction ownership 与完整事件重放、VS Code Webview 回放；workspace-composed 仍不能证明全局任务完整性，外部进程 stop 永不提供。 | PARTIAL |
| CP-01  | Host-only `CheckpointStore` 已接入 globalStorageUri；默认关闭，显式开启 metadata 后仍是 metadata-only，内容快照需第二个设置；具备 checksum manifest、journal/backup、冲突预览、回滚/启动恢复、checkpoint drawer。`apps/extension/src/checkpoints/checkpoint-store.spec.ts` 11 项存储/故障测试及 `CheckpointDrawer.spec.tsx` 4 项 UI 测试通过。                                                                                                                                                                                                                                                                                                                 | 真实 VS Code workspace trust/symlink/remote 文件系统和用户确认流程；真实 DSH 只需作为来源会话，仍无现场恢复证据。                                                          | PARTIAL |
| PT-01  | 严格 template request/summary DTO、Host-only global/workspace/session 存储、checksum/body integrity、显式变量白名单与 unresolved 交互已实现；Composer 支持 Ask/Plan/Act/Debug/Review 语义模式，Plan 只在动态命令目录声明时映射 `/plan`。`prompt-template-store.spec.ts` 9 项存储/故障测试、`PromptTemplatesDrawer.spec.tsx` 3 项 UI 测试、`SessionControls.spec.tsx` 工作流模式测试及 Domain/协议/启动映射回归通过。                                                                                                                                                                                                                                           | 真实 VS Code workspace trust/symlink/remote 文件系统、真实 DSH/VS Code Webview 回放、模板 reload 持久化与运行中模式切换证据；未新增 DSH RPC。                              | PARTIAL |
| RF-01  | Host 聚合脱敏连接状态与有界近期诊断事件；Webview 严格解析诊断快照，提供刷新、复制报告、打开 Output 和按 retryable 语义重新连接入口；端点、进程、路径和凭据不跨边界。`RedactedDiagnostics` ring、协议 schema、Store、DiagnosticsPanel/Drawer tests。                                                                                                                                                                                                                                                                                                                                                                                                            | 真实 DSH 故障注入、事件缺口/存储损坏回放和 VS Code Webview 现场验证；DSH 固定契约没有 diagnostics/recovery RPC，故本切片不伪造上游动作。                                   | PARTIAL |

本批次的全量门禁结果以交付命令输出为准；没有真实 DSH 运行验证的新增能力不标为 `DONE`。

## 2026-09-12 P0 递归工具调用树切片

- TL-01：固定 rc.6 契约中的 `rootCallId`、`parentCallId`、`subCallId` 已由 Adapter
  保留到 Domain；Timeline 新增有界 `ToolCallTree` 投影，支持任意已验证深度内的嵌套
  Code/PTC 调用、启动/完成/失败状态和父调用缺失时的可见降级。Webview 通过同一工具
  Renderer 递归展示子调用，并保留每个子调用独立的生命周期状态。
- 安全边界：循环、自引用和超过 256 层的关系会断开为安全根节点，不丢弃对应工具行；不
  解析 ANSI/TUI 文本，也不凭模型文本猜测工具状态。新增 Adapter、Timeline 和 Webview
  回归覆盖嵌套、孤儿、错误状态、循环与深度上限。
- 自动证据：`pnpm check`（146 个测试文件、1204 个测试）和 `pnpm build` 通过；真实
  DSH/VS Code Webview PTC 回放尚未完成，因此 TL-01 继续保持 `PARTIAL`。

## 2026-09-12 P0 结构化 Read 代码预览切片

- TL-01：结构化 `read` result card 现在保留共享 UI 的纯文本安全回退，并由 Webview
  renderer 对文件窗口提供与上游 `ReadBlock` 对齐的行号源码预览：进入视口后懒加载
  Shiki、支持双主题 token、默认 16 行头尾折叠、复制不含行号的源码正文，以及窗口行数提示。
  嵌套工具调用复用同一 renderer；未知语言、超长输入、语法加载失败和 renderer 异常都不
  丢失可见文本。
- 安全边界：共享 `packages/ui` 不依赖 Shiki；高亮只消费 Adapter 已校验的
  `ToolPresentationLine[]`，不会 fetch、解析 ANSI/TUI 或执行代码。复制仍由 Webview
  clipboard helper 处理，屏幕阅读器同时获得“行号 + 正文”的完整文本。
- 自动证据：`pnpm check`（147 个测试文件、1209 个测试）和 `pnpm build` 通过；新增
  renderer seam、折叠、源码复制、实际高亮和未知语法回退测试。真实 DSH/VS Code Webview
  Read 回放尚未完成，因此 TL-01 继续保持 `PARTIAL`。

## 2026-09-12 P0 结构化 Diff 预览切片

- TL-01：共享 `ToolRow` 新增可选结构化 diff renderer seam，默认 renderer 异常时仍回退到
  纯文本差异视图；Webview `ToolDiffPreview` 对齐上游 `DiffBlock`，支持创建/编辑差异、
  同文件多 hunk 分隔、多文件去重统计、默认 16 行头尾折叠、完整差异复制和 `+/-` 统计。
- 安全边界：差异只消费 Adapter 已校验的 `ToolPresentationDiff[]`，不读取文件、不 fetch、
  不解析 ANSI/TUI；复制经现有 Webview clipboard helper，renderer 失败不会隐藏原始差异。
- 自动证据：`pnpm check`（148 个测试文件、1214 个测试）和 `pnpm build` 通过；新增共享
  renderer 成功/异常回退以及 Webview 多 hunk、统计、折叠、复制、空列表测试。真实
  DSH/VS Code Webview Diff 回放尚未完成，因此 TL-01 继续保持 `PARTIAL`。

## 2026-09-12 P0 结构化 Terminal 结果预览切片

- TL-01：共享 `ToolRow` 新增结构化 terminal result renderer seam，Webview
  `ToolTerminalPreview` 对齐上游 `TerminalBlock` 的安全可用部分：输出最多显示 16 行并
  支持头尾折叠、复制原始 output、空输出占位，以及基于已验证 `exitCode`/`signal` 的显式
  退出状态；嵌套工具调用也复用该 renderer。
- 安全边界：只消费 Adapter 已校验的 terminal presentation，不从输出文本猜测成功/失败，
  不解析 ANSI/TUI，不启动命令、不读取工作目录；renderer 失败仍回退到共享纯文本结果视图。
- 自动证据：`pnpm check`（149 个测试文件、1218 个测试）和 `pnpm build` 通过；新增共享
  renderer 接线以及 Webview 折叠、原文复制、退出码/信号优先级、空输出测试。真实
  DSH/VS Code Webview Terminal 回放尚未完成，因此 TL-01 继续保持 `PARTIAL`。

## 2026-09-12 P0 结构化 Search 结果预览切片

- TL-01：共享 `ToolRow` 新增结构化 search renderer seam；Webview `ToolSearchPreview` 对齐
  上游 `SearchBlock`，同时支持 `matches` 按文件分组和 `paths` 平铺结果，提供结果总数/截断
  摘要、空态、保留完整结果的复制、文件组独立折叠，以及跨文件/跨匹配组的 16 行头尾折叠。
  当尾部从某文件的匹配行开始时，会恢复文件头，避免结果失去归属。
- 安全边界：只消费 Adapter 已校验的路径、行号和匹配文本，不读取文件、不 fetch、不从文本
  猜测工具状态；可选 renderer 失败时回退到共享结果视图。
- 自动证据：`pnpm check`（150 个测试文件、1223 个测试）和 `pnpm build` 通过；新增共享
  renderer 接线以及 Webview paths/matches、复制、文件折叠、尾部文件头恢复、空态测试。真实
  DSH/VS Code Webview Search 回放尚未完成，因此 TL-01 继续保持 `PARTIAL`。

## 2026-09-12 P0 结构化 Web 结果预览切片

- TL-01：共享 `ToolRow` 新增结构化 web renderer seam；Webview `ToolWebPreview` 对齐上游
  `WebBlock`，支持搜索答案的安全 Markdown、编号来源、标题/摘要/发布时间、无结果与来源
  截断提示，以及 fetch URL、HTTP 状态和内容截断提示。URL 只能经现有 Host `onOpenLink`
  回调触发，fetch renderer 启用时不会重复显示旧目标按钮。
- 安全边界：Adapter 已校验的 HTTP(S) URL 才能成为 Host 操作按钮；Webview 不生成原生
  `href`、不直接访问网络，模型答案继续走既有禁止原始 HTML/远程图片的 Markdown 投影。
  renderer 失败时回退到共享 Web 结果视图。
- 自动证据：`pnpm check`（151 个测试文件、1227 个测试）和 `pnpm build` 通过；新增共享
  renderer 接线以及 Webview 搜索/抓取、状态、截断、空态、Host-only URL 操作测试。真实
  DSH/VS Code Webview Web 回放尚未完成，因此 TL-01 继续保持 `PARTIAL`。

## 2026-09-12 P0 历史文件引用预览切片

- 上游证据：DSH `11d6bd05f3` 的 `user-text`/`ui-reference` 让历史用户消息中的文件引用
  和 session-reference 具备结构化展示事实；本地 Adapter 只投影有界的 session label，
  不把 session id、捕获统计或绝对路径发送到 Webview。
- 代码证据：Domain/Timeline 保留隐藏 `session-reference` 消息的 label，并将它关联到紧邻
  的用户消息；Webview 使用安全的文本投影显示文件、文件夹、session 标签，文件点击复用
  已有 Host `view.openLink` 路径校验，未生成原生 `href` 或直接访问文件系统。畸形引用在
  Adapter/Store 边界 fail closed。
- 自动证据：新增 Adapter、Timeline reducer、UserText 和 Timeline 回归，覆盖合法/畸形
  session-reference、quoted path、文件动作、文件夹/session 只读降级和隐藏上下文关联；本轮
  全量门禁结果以交付命令输出为准。真实 DSH/VS Code Webview 历史消息回放尚未完成，相关
  能力继续保持 `PARTIAL`。

托管启动回归修复（2026-08-29）：启动参数已迁移到版本化 `managedWebArguments` 契约；`--no-open` 对所有已知版本默认传入，仅 `0.0.1-rc.1/.2/.5`、`0.1.0-rc.2/.3/.6/.7` 这些早期 Web Profile 省略，未知版本不猜测可选 flag。实际 rc.6 隔离 smoke 已成功报告 loopback endpoint，并确认本次受管进程退出后端口关闭。

无文件夹临时工作区修复（2026-08-29）：`TemporaryWorkspaceManager` 已接入 Extension Host 的
`workspace.list`、`session.list` 和 `session.create` 路径。无 VS Code 文件夹时，首次列表请求会创建或恢复
扩展 `globalStorageUri` 下的 `workspace-*` 目录；DSH 注册表重启后丢失时按持久化的安全路径重新注册，
并发首次请求只允许一个创建操作；不安全的持久化路径不会被使用或删除。自动证据为
`apps/extension/src/backend/temporary-workspace.spec.ts` 7 项管理器测试和既有路径安全测试；尚未完成真实
VS Code 无文件夹 Webview 回放，因此该修复不提升能力矩阵中的核心能力为 `DONE`。

## 2026-09-13 会话转录完整性专项切片：无游标行、重建等价与 reducer 契约

本轮针对“静默丢失 / 陈旧 / 顺序错乱”这一同类问题清单逐项编写专项测试，其中两项被测试证伪为真实缺陷并已修复，其余假设被测试排除但保留测试文件。

已确认并修复的缺陷：

1. Host-only 行（`notice`、`command-input`、Host 无法映射的原始帧）没有 durable DSH 游标，但此前会回退使用 Host 发布计数器推进时间线游标：其后的 durable 行会被当作陈旧行丢弃，而计数器落后于持久化游标时（重载 Webview、从历史恢复会话）Host-only 行自身被丢弃。现在 `store.ts` 对“无 envelope sequence、无 transient sequence 且非助手增量”的行传入 `{ advanceSequence: false }`，按到达顺序排列；无 transient 元数据的助手增量仍保留游标比较，以维持已水合历史的去重（`store-subagent.spec.ts` 的既有用例守住了这条边界）。
2. `unknown` 原始帧此前会推进持久化游标；现在 `advancesTimelineSequence` 对其返回 false，未解释帧仍以原始行保留在真实位置，但不再占掉一个持久化槽位。
3. 从 durable ledger 重建时间线时会擦除 Host-only 的 `notice`/`command-input` 节点（DSH 永不下发这些行）。新增 `restoreHostOnlyNodes`，按重建前的位置重新插入历史中不存在的 Host-only 节点；`insertLiveNodeAtPreviousPosition` 放宽到全部携带 `liveStartedAfterSequence` 的节点，使流式助手/推理节点在重建后仍锚定在原位置。
4. 同一个 `restoreHostOnlyNodes` 只覆盖 below-cursor 重建，切换会话（`open()` 重建基线）与后台会话仍会静默丢掉 Host-only 行：DSH 会为所有被 watch 的会话发布 `notice`（例如某会话 follow 流断开时由 Adapter 合成的告警），而 Webview 只保留当前会话的转录。现在 store 按会话记忆 Host-only 行及其锚点（每会话 128 行、最多 16 个会话，LRU 淘汰），在重建、切换回来、重新打开时按到达顺序放回；后台会话的行在其会话未打开时也会被记住（锚点未知时落在末尾）。
5. `runGapBackfill` 此前在会话切换后放弃整段回填：切走再切回时，洞既没被历史补齐，也没有留下任何警告。现在回填只受 `openVersion`（dispose/换代）约束，恢复结果按会话发布 `session.gap`。
6. 子会话（`openSubagent`）是第三条转录重建路径：它只调用 `hydrateTimelineFromHistoryEvents`，缺少父会话 `open()` 同款的 `restoreGapNotices`/`restoreHostOnlyNodes`。子会话的 Host-only 行与未愈合 gap 警告在“离开子会话再进入”时静默丢失（`subagent.history` 只含 durable 行）。现已按父会话同样的顺序补齐两步恢复。
7. `loadOlderHistory` 合并更早分页时是第四条重建路径，同样缺少两步恢复：向上翻页会静默丢掉已记录的 Host-only 行与未愈合 gap 警告，且新合并的历史若覆盖了洞也不会撤下警告。现在与 `rebuildTimelineFromLedger` 使用同一套恢复顺序。

自动证据：

- `apps/webview/src/app/store-cursor-integrity.spec.ts`（7 项）：未解释帧不占持久化槽位、未解释帧保留在持久化位置、Host-only notice 不推进游标、计数器落后游标的 Host-only notice 仍可见、重建后 Host-only 行仍在、重建后流式答案仍在、重建后未愈合的 gap 警告仍在。
- `apps/webview/src/app/store-rebuild-equivalence.spec.ts`（2 项）：真实形状 fixture（含 reasoning/message 增量、嵌套子工具调用、稀疏未知工具结果、Host-only 命令通知、`session.projection`、不可读帧、gap）在“有/无 below-cursor 重建”下生成逐节点签名完全一致的转录，并断言各节点家族均已出现以防空跑；同一 below-cursor 行连续到达两次也稳定。
- `apps/webview/src/app/store-session-switch-integrity.spec.ts`（6 项）：Host-only notice/command-input 在切走再切回后仍在、后台会话的 notice 在打开该会话时仍在、未愈合的 gap 警告在切换后仍在、恢复的行落在其持久化位置而不是末尾、反复切换不会重复插入同一行。
- `apps/webview/src/app/store-rebuild-path-integrity.spec.ts`（4 项）：子会话重新进入后 Host-only 行与 gap 警告仍在；合并更早历史分页后 Host-only 行仍落在其 durable 锚点之后、gap 警告仍在。
- `packages/timeline/test/reducer-transcript-integrity.spec.ts`（10 项）：孤儿工具结果建卡、稀疏后续帧保留更完整身份、已关闭 turn 的迟到 running 更新降级为 `cancelled`、携带不同 id 的 durable 完成帧原地结算并改名、连续相同用户消息保持为独立节点、只消费 `optimistic:user:` 占位；同一 Host-only notice/command-input/连接警告/gap 警告行重投两次只刷新不追加（advisory 快照与切换返回都会重投这些无游标行，此前会追加第二份）。
- `packages/dsh-adapter/test/unknown-frame-cursor.spec.ts`（4 项）：Adapter 侧未解释帧的游标契约，含重启基线行为。
- `dispose()` 同步加固：清理待执行的重建定时器、通过 `openVersion` 失效在途 open/backfill、清理 gap 追踪表。

被测试排除的假设（无缺陷，测试保留）：Adapter 重启基线、reducer 的顺序/去重语义、会话引用投影、虚拟化、旧历史分页的 `lastSequence` 槽位边界、流中重建、gap 回填失败路径、协议未知帧名（`hostEventSchema.name` 为开放字符串，未知名保留为 `unknown` 行而非丢弃）、Host 外发序列（`enqueueEvent` 仅在投递成功后递增，同一外层序号不会承载两条已投递消息）均由上述新测试或既有高质量 spec 覆盖。

证据边界：本轮只有代码与自动测试证据，未做真实 DSH/VS Code Webview 运行验证，因此相关核心能力仍保持 `PARTIAL`，不因本切片提升为 `DONE`。全量门禁 `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 在本切片通过（160 个测试文件 / 1328 项测试通过、1 项 live smoke 默认跳过）。

## 2026-09-13 缺陷复查（续）：换代中的缺口回填、编辑器上下文加载态与跨平台路径判定

对上一节第 5 条的证据复查发现当时的结论过强：`runGapBackfill` 仍在每个分页前和分页返回后用 `openVersion` 直接 `return`，所以“会话切换期间正在读取的分页”会连同已出队的 range 一起被丢弃——切回该会话时既没有补齐，也没有任何警告。上一节第 5 条的描述按本轮结论修正为下面的第 1–3 条。

1. `runGapBackfill` 现在只在 `disposed` 时提前退出；`openVersion` 变化只停止继续取页（已换代的分页结果无法再并入该会话 ledger）。停止取页后仍会走到覆盖判定，把未愈合的 range 记入 `unhealedGapRanges`，下次打开该会话时由 `restoreGapNotices` 用该会话真实历史重新判定并渲染。
2. 覆盖判定只在该会话就是当前会话时才读 `state.history`；此前无条件读当前会话的 ledger，另一个会话中数值上覆盖同一段序号的历史会错误压制该洞的警告。
3. 新增 `disposed` 标志：dispose 时置位并同时递增 `openVersion`，让在途回填既不能触碰已销毁的 store，也不会因为“换代”而丢掉已经公告的洞。
4. 编辑器上下文（`editor.context.list`）刷新被 `open()`/`openSubagent()` 换代后，被废弃的刷新不会清除 `editorContextLoading`（其 `finally` 受 generation 保护），而换代路径此前也不重置该标志，编辑器上下文栏因此一直转圈。现在两条重建路径都在首帧重置 `editorContextLoading: false`。
5. 持久化的 DSH 运行时路径提示此前用只认 Windows 盘符/UNC 的谓词校验，macOS/Linux 上写入的 npm-global、PATH 提示每次窗口启动都会被丢弃并触发全量重扫。现在 `runtime-paths.ts` 的 `isAbsoluteFilePath` 同时接受 POSIX 绝对路径、盘符和 UNC，并同时用于“打开 Markdown 链接”的绝对路径判定。
6. 排队面板对 `mode: 'steer'` 的行仍提供“排队”选项，而 Host 侧只有 `action: { kind: 'steer' }`（固定上游的 `session.updateQueue` 没有反向动作），选中后静默无效。现在 steer 行作为只读状态显示（禁用触发器 + 说明性 tooltip），可切换的方向（排队 → 引导）保持可点。

自动证据：

- `apps/webview/src/app/store-gap-heal.spec.ts`（27 项，新增 2 项）：“另一会话接管回填后仍保留已公告的洞”（另一个会话的 ledger 数值上覆盖同一段序号也不得压制警告）、“回填读取在途时重开同一会话仍保留警告”。两项在修复前均以 `expected false to be true` 失败，修复后通过。
- `apps/webview/src/app/store-editor-context-loading.spec.ts`（2 项）：切换会话、进入子会话转录期间被换代的编辑器上下文刷新不再让工具栏持续转圈。
- `apps/webview/src/features/input/QueuePanel.spec.tsx`（6 项，新增 2 项）：排队行可以提升为 steer；steer 行不再提供 Host 无法执行的排队切换。
- `apps/extension/src/backend/runtime-paths.spec.ts`、`runtime-locator.spec.ts`（新增用例）：POSIX/盘符/UNC 绝对路径被接受，相对路径与盘符相对拼写被拒绝。

被测试排除的假设（无缺陷）：工作区文件夹变化后 `requireCurrentWorkspaceSession` 的缓存失效（`composition-root.ts` 的 `onDidChangeWorkspaceFolders` 已调用 `invalidateCurrentWorkspaceSessionDetails`）。

证据边界：本轮仍只有代码与自动测试证据，相关核心能力保持 `PARTIAL`。全量门禁 `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 在本轮通过（160 个测试文件 / 1339 项测试通过、1 项 live smoke 默认跳过）。

## 2026-09-13 缺陷复查（续二）：扩展主动重连后的连接域残留与跟随订阅丢失

定位方式：把“连接换代”当作独立缺陷族沿事件路径再查一遍。`DshConnectionCoordinator.disconnect()` 只发布
`{kind:'stopping'}` → `{kind:'idle'}`（失败时 `failed`）快照，从不发布 `connection.lost` 后端事件；而 Webview
store 里只有 `connection.lost` 分支清理连接域状态。因此由扩展发起的重连（`dsh.reconnect`、`connection.retry`、
`connection.configure` 与 `TRANSPORT_CONFIGURATION_KEYS` 触发的自动重连最终都走 composition-root 的
`reconnect()` = `disconnect()` + `connect()`）会完整保留上一个进程的排队行、审批/问题卡、编辑器上下文、
任务/变更清单、提示词模板与命令目录——这些都是进程内状态，新进程在重新订阅会话前并不存在。

同一根因还有第二半：跟随订阅属于进程本身。`connected → stopping → idle → connected` 之后新进程没有旧进程的
订阅，屏幕上的会话会静默停止接收模型与工具事件，而状态栏仍显示已连接。

1. 新增 `withoutConnectionScopedSurfaces(state)`：清空上述进程内状态并把 `activeSubagent.parentAvailable`
   置为 `false`；在 `connection.snapshot` 处理里于“离开 `connected`”时应用。`connected → connected`
   （协调器的缓存后端快路径）保持原样，不重复清空。
2. `connection.lost` 分支改为复用同一函数，两条路径语义一致。
3. `connection.snapshot` 由非 `connected` 变为 `connected` 时触发新的 `onConnectionEpoch` 回调，store 侧接
   `reopenActiveView()`：有活动子会话转录就 `openSubagent`，否则 `open(activeSessionId)`，随后 `refresh()`
   会话列表。扩展侧 `session.open` 使用 `{ fresh: true }`（经 `onSessionOpen` 惰性附着跟随流），且 `attach()`
   先调用 `invalidateCurrentWorkspaceSessionDetails()`，因此重开既建立新订阅也不会读到陈旧缓存；
   `BackendService.attach` 在 backend 对象变化时清空 replay map，旧进程的
   `queue.updated`/`permission.requested` 不会被重放进新 epoch。

自动证据：

- `apps/webview/src/app/store-reconnect-epoch.spec.ts`（新增 3 项）：重连序列 `stopping`/`idle`/`connected` 后
  排队行与审批卡被清空、活动会话被重新 open、转录节点保留（修复前以
  `expected [ { id: 'queued-1', …(5) } ] to deeply equal []` 失败）；重复 `connected` 快照不重开也不清空
  （缓存后端快路径）；`stopping`/`idle`/`connecting` 期间不提前重开、转录保留。
- `apps/webview/src/app/store-gap-heal.spec.ts`（27 项）：`makeStore` 增加 `openResponseForCall`，使“换代后新进程
  可复用更低的持久序号”这一既有保证在引入重开之后仍被覆盖（断言不变，仍要求 `contextPressure: 1` /
  `tokenUsage: 1`）。

被测试排除的假设（无缺陷）：`loadOlderHistory` 已按 `openVersion` 判代（`version !== openVersion` 时丢弃分页），
不会把被替换进程的历史页并入当前 ledger。

已知残留（未修复，可恢复的展示态而非静默错误）：切到**另一个** DSH 实例后重开必然失败且该失败被吞掉，旧转录
会继续显示；用户可从刷新后的会话列表另选会话恢复，发送消息也会给出可见错误。

证据边界：本轮仍只有代码与自动测试证据，核心能力保持 `PARTIAL`。全量门禁
`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 在本轮通过（161 个测试文件 /
1342 项测试通过、1 项 live smoke 默认跳过）。

## 2026-09-13 缺陷复查（续三）：替换进程里的子会话路由与重开重试

上一节的重连修复按“换代时刻”再打一遍探针（`store-reconnect-epoch.spec.ts` 由 3 项扩到 5 项），确认两个仍然存在的功能缺口：

1. 子会话转录在替换进程上打不开。DSH 的子会话路由（`subagent.history`/`subagent.send` 解析的 `addresses`）是**连接态**：只有在本连接读过 `subagent.list(parentSessionId)` 才会登记子会话的父路由，替换进程的表是空的。于是 `openSubagent` 的 history 读取（以及上一节新增的换代重开）以不可重试的 `CAPABILITY_UNAVAILABLE` 失败，用户停留在“看起来正常”的冻结转录上。现在 `openSubagent` 先读一次父目录（顺序在 history 之前，作为该连接上的路由登记），`parentAvailable` 仍沿用调用方从同一目录读到的值——此前尝试用刚读到的目录值覆盖它，会让 `subagent.send` 被误判为“父会话不可用”（4 项既有子会话用例转红后回退）。
2. 换代重开只尝试一次。`connected` 在替换进程提交工作区投影之前就已发布，`requireCurrentWorkspaceSession` 因此可能给出“会话不属于当前工作区”的**终局**（`retryable: false`）拒绝，而 `requestSessionOpen` 按设计不重试终局错误——这正是冷启动用 `attemptStartupRestore` 反复重试所规避的同一竞态。现在换代重开（`resubscribeActiveView`）用与 open 相同的 `OPEN_RETRY_ATTEMPTS` / `OPEN_RETRY_BASE_DELAY_MS` 有界退避重试，并在用户已经切到别的视图时立即停止，避免面板被拉回失败的会话。
3. 上一节把 `activeSubagent.parentAvailable` 在换代时置为 `false` 属于过强处理：该标志描述父会话目录事实，置假会让子会话转录的追问被直接拒绝。已回退该处理。

自动证据（均为先红后绿）：

- `apps/webview/src/app/store-reconnect-epoch.spec.ts`（新增 2 项）：“替换连接上重新登记子转录路由”修复前失败于 `expected [ { type: 'subagent.history', …(2) } ] to deeply equal []`；“替换连接以终局拒绝重开时重试”修复前失败于 `expected 2 to be greater than or equal to 4`（只发出 1 次重开请求）。第 1 项中断言顺序此前掩盖了 `parentAvailable` 子断言，另用一次“临时恢复旧行为”的定向运行单独证实（`expected false to be true`）。
- `apps/webview/src/app/store-subagent.spec.ts`（既有 4 项）在“目录值覆盖调用方值”的中间版本上转红，回退后恢复，确认回退不是猜测。

被测试排除的假设（无缺陷）：会话作用域事件不会污染当前会话视图——逐条核对 `session.status`、`session.title`、`session.projection`、`session.configuration`、`queue.updated`、`goal.updated`、`todo.updated`、`jobs.updated`、`permission.*`、`question.*` 分支后确认都按 `event.sessionId` 过滤或只更新对应列表项；`session.removed` 对活动会话的清理也覆盖了转录、投影与目录。

已知残留（同上节，未额外修复）：切到**另一个** DSH 实例后重开必然失败且失败被吞掉，旧转录继续显示；现在多了 3 次有界重试，用户仍可从刷新后的会话列表另选会话恢复，发送消息也会给出可见错误。

证据边界：本轮仍只有代码与自动测试证据，核心能力保持 `PARTIAL`。全量门禁
`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 在本轮通过（161 个测试文件 /
1344 项测试通过、1 项 live smoke 默认跳过）。

## 2026-09-13 缺陷复查（续四）：子会话被当作根会话打开

`open()` 是“把某个会话变成当前视图”的唯一入口（`openSession`、启动恢复、session mention、lineage 跳转、任务行、fork/创建回调都经过它），但此前它只按 id 打开：**子会话（`origin === 'subagent'`）会被当成根会话呈现**。子会话面完全由 `activeSubagent` 驱动——追问走 `subagent.send`、Stop 走 `subagent.interrupt`、one-shot 只读徽标、lineage 头、`parentAvailable` 门禁——所以被当成根会话的子会话会同时拿到根会话的动作：`session.sendPrompt` 直接发给子会话、`session.cancel`、`forkSession`（`App.branchSession` 只在 `activeSubagent !== undefined` 时拒绝）、导出按钮；one-shot 只读、附件门禁与 `parentAvailable` 检查则全部失效。lineage 头**会**渲染（rc.6 mapper 在摘要与详情里都投影 `parentSessionId`），所以返回父会话的入口仍在，错的是这个视图的动作语义与它自身的身份。

可达路径（都不需要构造畸形数据）：

1. **Webview 重载**：持久化状态只存 `activeSessionId`，而子会话摘要留在注册表投影里（`session.list` 按工作区成员过滤，不过滤 origin），于是 `selectStartupSessionId` 会返回被记住的子会话 id，`attemptStartupRestore` 以根会话路径打开它。
2. **session mention 点击**：composer 的本地子会话引用与 DSH 文本里的 `dsh-session:<childId>` 都经 `timelineOnOpenSession → openSession`。
3. **lineage 上跳**：嵌套子会话的祖先条目也是子会话，点击同样走 `openSession`。
4. **任务行**：`TasksDrawer` 只有 `kind: 'subagent'` 的行可以打开，App 层直接按 `sourceId`（子会话）统一交给 `openSession` 路由；见“续四再补”。

修复：`open()` 的目标若是在注册表投影里已知的子会话，就改由该子会话父会话的 `subagent.list` 目录路由（新 `resolveSubagentOpen`），用 `openSubagent(entry, catalog.parentAvailable)` 呈现；目录已不再列出该子会话（或目录读取失败）时，向上走到目录仍能呈现的最近祖先——父目录是子转录唯一仍可达的入口。根会话路径保持**同步序幕**：只有子会话才付出目录读取的异步代价，因为 open 屏障依赖“注册缓冲”与调用发生在同一轮事件循环里。

自动证据（均为先红后绿）：

- `apps/webview/src/app/store-startup.spec.ts`（新增 1 项，另加 `acquireVsCodeApi` 持久化桩）：“重载后按父目录重开被记住的子会话转录”修复前失败于 `expected undefined to match object { entry: { id: 'session-child', …(1) }, …(1) }`（子会话以根会话打开，且发出了 `session.open`）；修复后断言 `activeSubagent.entry.id === childSession.id`、`activeSubagent.parentAvailable === true`、`subagent.history` 已读取、从未发出 `session.open`，且后续 `sendPrompt` 走 `subagent.send` 而非 `session.sendPrompt`。
- `apps/webview/src/app/store-subagent.spec.ts`（新增 2 项）：“按目录路由子会话的 openSession”修复前失败于同一 `expected undefined to match object { entry: { id: 'child', …(1) }, …(1) }`；“目录不再列出该子会话时落到父会话”修复前失败于 `expected 'child' to be 'parent'`（子会话仍以根会话打开）。
- 回归证据：把路由的无条件 `await` 放在 `open()` 序幕时，`store-gap-heal.spec.ts` 的 6 项 open 屏障用例转红（`expected [ 1, 2, 3, 4, 5 ] to deeply equal [ 1, 2, 3, 4, 5, 6, 7, 8, 9, …(4096) ]` 等），改成“只有子会话才异步”后全部恢复——这 6 项用例即“序幕必须同步”的守门测试。

已知残留：子会话摘要尚未进入注册表投影（例如只有 `workspace.sessionIds` 的持久成员名单）时，origin 在 RPC 返回前不可知，该 id 仍会以普通会话打开；注册表投影或 `session.history` 恢复后再次进入该视图会走上正确路由。

### 续四补：迟到的子会话解析会覆盖用户之后选择的视图

上面的路由把一次 `subagent.list` 往返放进了 `open()` 的序幕，于是出现同族的第二个缺陷：**解析期间用户若切到别的会话（或启动恢复在途中用户已手动切换），迟到的解析结果仍会把视图抢回去**。`openSubagent` 一开始就 `++openVersion`，所以它不但不会被旧版本守卫拦住，反而让用户刚打开的那个会话的响应全部被判定过期。可达序列：点击 `dsh-session:<childId>` 提及 → 目录读取在途 → 用户点抽屉里的另一个会话 → 目录返回 → 视图跳回子会话。

修复：新增单调 `openIntent`。`open()` 在任何 `await` 之前同步 `++openIntent` 并记住自己的 intent，子会话解析返回后若 `intent !== openIntent` 就把结果整个丢弃（既不打开子会话，也不把它降级成根会话打开，更不执行 `flushPendingHistory` 等序幕副作用）；`resolveSubagentOpen` 改为只做纯解析并返回 `{ kind: 'subagent', entry, parentAvailable }`，副作用留给 `open`；`openSubagent` 自身也递增 `openIntent`，这样抽屉/任务行的**直接**子会话打开同样能作废在途的 by-id 解析。根会话路径仍无 `await` 前置，行为不变。

自动证据（先红后绿）：`store-subagent.spec.ts` 新增“慢的子会话解析不得覆盖其后打开的会话”——目录响应用 deferred 挂起，先 `openSession('child')`、再 `openSession('parent')`、最后 resolve 目录并 await 前者；修复前失败于 `expected 'child' to be 'parent'`（迟到解析把子会话视图抢回，`activeSubagent` 也被建立），修复后 `activeSessionId` 与 `timeline.sessionId` 保持 `parent`、`activeSubagent` 为 undefined。

证据边界：本轮仍只有代码与自动测试证据，核心能力保持 `PARTIAL`。全量门禁
`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 在本轮通过（162 个测试文件 /
1348 项测试通过、1 项 live smoke 默认跳过）。

### 续四再补：子代理任务行会打开父会话而不是子会话

同族的第三个缺陷在任务中心：`TaskSummary` 对 `kind: 'subagent'` 行的字段语义是 `sourceId` = 子会话 id、
`sessionId` = **父**会话 id（`apps/extension/src/tasks/task-center-registry.ts`）。而 `App.tsx` 的
`TasksDrawer.onOpen` 只在**当前视图的目录**（`state.subagents.entries`）里能查到该 child 时才走
`openSubagent`，查不到就回落 `openSession(task.sessionId)`——即静默打开父会话。可达场景不需要畸形数据：
任务范围切到 `workspace` 后，任一属于**别的父会话**的子代理行都会命中该回退；在子会话视图里查看任务列表时同理
（此时 `state.subagents.entries` 是当前子会话自己的子目录）。

修复：任务行不再自行查目录，改为把子会话 id 交给 `openSession` 单一路由
（`store.openSession(task.kind === 'subagent' ? task.sourceId : task.sessionId)`），由存储层按该子会话父会话的目录解析；
这与“续四”的路由修复共用同一入口，因此两个缺陷的修复互相依赖。

自动证据（先红后绿）：`apps/webview/src/App.connected.spec.tsx` 新增“即使当前目录未列出，也能打开具名的子代理任务”——
任务列表给出一条 `sourceId: 'child-2'`、`sessionId: 'other'` 的运行中子代理行，spy 断言
`openSession` 收到子会话 id 且未调用 `openSubagent`；修复前失败于
`expected "vi.fn()" to be called with arguments: [ 'child-2' ] / Received: [ "other" ]`，修复后通过。

证据边界：本轮仍只有代码与自动测试证据，核心能力保持 `PARTIAL`。全量门禁
`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 在本轮通过（161 个测试文件通过 /
1 项 live smoke 跳过；1349 项测试通过、1 项跳过）。

### 续五：检查点标签被解析器丢弃、缺失 i18n 键渲染原始标识符

缺陷一（检查点标签被 webview 解析器丢弃）：宿主 `featureCheckpointSummary`
（`apps/extension/src/composition-root.ts`）会在 `checkpoint.list`/`checkpoint.create`/`checkpoint.preview`
载荷里带 `label`，协议 `checkpointSummarySchema` 也定义了 `label`，但 webview 的
`parseFeatureCheckpointSummary`（`apps/webview/src/app/store.ts`）逐字段手抄成 domain 对象时漏掉了它。
后果：检查点抽屉里每个条目都退化成 `t('checkpoints.unnamed')`，用户建检查点时填的标签（`createCheckpoint`
确实发出了 `label`）在回包里凭空消失，条目的 title 与删除/恢复 aria-label 全部变成 id。
既有 `CheckpointDrawer.spec.tsx` 直接构造 domain 对象，绕过了 store 解析器，所以看不到这个字段丢失——
这类“手抄字段漏一个”的缺陷只能由**契约约束到解析器边界**的探针发现。

自动证据（先红后绿）：新增 `apps/webview/src/app/store-checkpoint-label.spec.ts`，fixture 先经
`featureResponseSchema.safeParse` 校验为合法协议载荷（防止 fixture 与契约漂移），再覆盖列表、创建、预览三条路径。
把解析器里的 `label` 拷贝临时移除后复现：三条断言分别失败于
`expected [ undefined ] to deeply equal [ 'Before refactor' ]` 与两处
`expected undefined to be 'Before refactor'`；恢复后 3/3 通过。

缺陷二（缺失的 i18n 键把原始标识符渲染进 UI）：`translate`（`apps/webview/src/i18n.tsx`）在词典里找不到键时
**不抛错、不告警**，直接把键名当作文本返回，于是 `t('app.error.checkpoint')`（store.ts 四处 checkpoint 失败路径）
和 `t('settings.modelIdDuplicate')`（`CustomProviderCard` 的重复模型 ID 校验）会在界面上显示成
`app.error.checkpoint` / `settings.modelIdDuplicate` 这样的原始标识符。同类语义问题：`settings.modelIdRequired`
的英文原文是“must have a unique model ID”，但 `ModelListEditor`/`ProviderSettingsEditor` 用它表示**未填写**，
文案与触发条件不符。

自动证据（先红后绿）：新增守卫 `apps/webview/src/i18n-keys.spec.ts`——遍历全部非测试源码里的字面量
`t('…')`/`translate('…')` 调用，要求每个键都能真正命中词典；修复前报出
`[ 'app.error.checkpoint', 'settings.modelIdDuplicate' ]`，修复后为空。同一文件再补一条同族守卫：对每个带
`{placeholder}` 的模板，静态解析字面量调用点的 params 对象，缺参即失败（`translate` 会原样留下 `{name}`，
同样是静默渲染）。该守卫已用变异验证：临时从 `TodoList` 的 `t('todo.progress', …)` 去掉 `completed` 后
报 `features\goals\TodoList.tsx: todo.progress missing completed`，还原后通过。

同类风险清单（本轮逐条证伪，测试保留为守卫）：144 个含占位符的词典模板逐个核对全部字面量调用点——无缺参、
无零参调用（简化版扫描先给出 18 处假阳性，全部是 `{ completed, total }` 简写属性导致的解析偏差，修正解析器后归零）；
`parseTodoViews`、`parseGoalViews`、`parseQueuedInputs`、权限/提问解析器、`parseFeatureTaskSummary`、
`parseFeaturePromptTemplateSummary`、`parseFeatureChangeSummary`、`parseEditorContextItem` 逐字段核对与协议 schema
一致，未发现第二个丢字段的解析器（`parseFeatureTasksResult` 丢掉的载荷 `source` 未被 webview 状态或 UI 使用）。
字面量扫描覆盖不到**模板字面量键**，因此另行枚举全部 25 个动态前缀（`changes.status.${…}`、`checkpoints.state.${…}`、
`tasks.kind.${…}`、`runtime.status.${…}` 等），逐个把词典后缀与取值来源比对：本地常量并集与域类型并集一致，
宿主驱动的那部分与协议 zod 枚举一致（`runtimeStatusLabel` 对 `failed`/`port-conflict` 做了显式合并、`plugins.phase`
对 `null` 显式回落 `unmounted`，两处都不是漏配）；其中 7 个协议驱动的后缀已固化为第三条自动派生守卫
（直接从 `changeSummarySchema`/`checkpointSummarySchema`/`taskSummarySchema`/`promptTemplateSummarySchema` 的
`options` 取值），并用变异验证会红：删掉 `checkpoints.state.stale` 后报同一路径。
另外确认了对称方向（宿主漏字段）不会静默：`message-router` 的 `response()` 在发送前用 `featureHostMessageSchema`
校验，超预算载荷显式降级为 `PROTOCOL_ERROR`；且 `AppErrorCode` 与 `protocolAppErrorCodeSchema` 逐项相同（33/33，
已用脚本比对），`ok:false` 分支的重解析不会因未知错误码抛异常。

请求路由覆盖同样双向核对过：`featureRequestSchema` 的 25 个成员里，webview 实际发出 23 个，宿主
`handleFeatureRequest` 全部有分支；`feature.request.cancel` 由 `message-router` 特判；唯一没有宿主分支的是
`changes.restore.prepare`——它只在协议里声明、webview 没有任何调用点（变更抽屉没有恢复入口），属于**分阶段
声明**，且真被发送时会走到处理器末尾显式抛 `FEATURE_DISABLED`（非重试终局错误），不会挂起或产生空载荷。
本轮不为其凭空补一个上游没有的破坏性能力，只把它记录为已知的空声明路由。
缺陷一的可见面也已补测：失败时 store 抛出的 `Error.message` 就是抽屉 `role="alert"` 显示的文本，新增用例断言
「宿主回包缺少 summary」时用户看到的是 `Unable to complete the checkpoint operation.` 而不是原始键；把词典里的
`app.error.checkpoint` 删掉后该用例正好还原出原始症状（`Received: "app.error.checkpoint"`）。

证据边界：本轮仍只有代码与自动测试证据，相关能力保持 `PARTIAL`，未做真实 DSH 运行验证。
全量门禁 `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 在本轮通过
（163 个测试文件通过、1 项 live smoke 默认跳过）。

## 2026-09-13 真实 DSH live smoke：rc.1 连接、探测与释放

新增可复现的真实运行验证 `tests/live-dsh/run.spec.ts`（默认跳过，`DSH_LIVE_SMOKE=1` 启用）。它用
扩展自身的托管契约启动真实 DSH，执行登录 cookie 交换、版本探测、真实适配器连接、只读 RPC 与释放，
只停止自己启动的进程：

```text
launch dsh.cmd --profile web --no-open --host 127.0.0.1 --port 45265
login http://127.0.0.1:45265 status=303 cookie=exchanged
managed start pid=21788 endpoint=http://127.0.0.1:45265
probe dsh=0.1.5-rc.1 protocol=rc151 adapter=dsh-0.1.5-rc.1 mode=exact
session.list 44 session(s) / workspace.list 8 workspace(s) / events.subscribe released
backend closed / managed stop port 45265 closed
```

本轮因此具备第三级证据（真实 DSH 运行验证）的能力：

- CN-06 的 `0.1.5-rc.1` 精确入口：真实构建被 `VersionedBackendProbe` 以 `exact` 模式选中
  `dsh-0.1.5-rc.1`/`rc151`，握手、`session.list`、`workspace.list` 与事件订阅均成功；其余历史
  版本（alpha.*、rc.131/rc.152 等）仍只有代码与自动测试证据。
- CN-01/CN-02 的受管启动路径：`managedWebArguments` 生成的 `--profile web --no-open` 参数向量在真实
  rc.1 上产生了 loopback endpoint，`onReadyEndpoint` 的 303 + cookie 交换成功。
- CN-04 的句柄所有权：脚本只停止自己创建的进程，并在停止后断言 loopback 端口已关闭。

证据边界：以上为 Node/适配层真实运行证据，仍未包含真实 VS Code Webview 渲染与交互（当时的 Electron
套件只做激活与 `dsh.connect` 冒烟），因此这些能力继续保持 `PARTIAL`；下一步提升路径是给 Electron
套件补真实 DSH 与断言，而不是直接改状态。

## 2026-09-13 VS Code Electron 套件：附着断言与真实托管运行

`tests/vscode-e2e/` 此前只做“激活 + `dsh.connect` + 等待 1.5 s”，对连接结果没有任何断言，README 却列出了
六项验收场景。本批次把它升级为可验证的端到端证据，并让 README 只声明实际断言的内容：

- `run.ts` 的 loopback fixture 记录真实流量（RPC 方法名、`/api/events.mux` 与 `/api/events.host` 的
  WebSocket 升级、被拒绝的升级），并通过测试专用只读通道 `GET /__e2e/observations` 暴露；窗口关闭后
  runner 复核同一份计数，套件若不再真正使用 fixture 会直接失败。
- `suite/index.js` 在 Extension Host 内读取工作区 `.vscode/settings.json` 确认连接模式，执行
  `dsh.connect`，并在 attach-only 模式下轮询观测通道，断言真实发生了 `host.describe` 握手与两条事件
  下行链路。managed 模式不做 fixture 断言（扩展拥有真实 runtime，不经过 fixture）。
- `run.ts` 增加 `--disable-workspace-trust`：一次性临时工作区必须被视为受信任，否则扩展按契约拒绝
  自动启动，托管模式无法执行。

真实运行证据（2026-09-13，Windows，VS Code 1.125.0，`DSH_VSCODE_E2E_EXECUTABLE=D:\Microsoft VS Code\Code.exe`）：

```text
attach-only : fixture listening on port 21326 → events.mux upgrade → events.host upgrade
              → dsh.connect completed → attached methods=[/,host.describe] mux=1 host=1 → exit 0
managed     : fixture listening on port 53163 → managed runtime 0.1.5-rc.1 npm shim
              → dsh.connect completed → exit 0
```

`DshConnectionCoordinator.connectOnce` 在“未找到 runtime / 版本不受支持 / 启动失败 / 端点不可达”的每个
分支都先发布失败状态再 `throw`，因此 managed 模式下 `dsh.connect` 正常返回即证明真实 Extension Host 中
完成了“定位 → 启动 → 探测 → 附着”的完整受管链路。

因此获得第三级证据（真实 VS Code 扩展宿主 + 真实 DSH）的部分：

- CN-02 的 `attach-only` 与 `new-isolated` 两种策略：前者在真实 Extension Host 中以真实 wire 流量证明
  “附着不启动”，后者在真实 Extension Host 中托管真实 `0.1.5-rc.1`。
- CN-01 的受管启动段（定位 → 启动 → 探测 → 附着）；`auto` 的候选回退矩阵与并发合并仍未在真实运行中
  覆盖，因此 CN-01 保持 `PARTIAL`。
- CN-04 的“只停止自己持有的进程”在真实托管启动上成立；真实卸载矩阵仍未覆盖。

仍未覆盖（README 已如实标注，不再声称已完成）：Secondary Side Bar 布局、缺 runtime 时的底部引导、
真实 protocol 的完整业务流（session/streaming/审批/问题/模型/job/goal/subagent）、reload 恢复与外部
进程存活。这些需要扩展向测试暴露可读的视图/状态通道，或引入真正的 UI 自动化。

证据边界：本批次把“真实 VS Code 扩展宿主 + 真实 DSH”纳入证据，但**没有**断言 Webview DOM 的渲染与
交互；因此没有能力因此提升为 `DONE`，CN-01/CN-02/CN-04 继续保持 `PARTIAL`。全量门禁
`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 通过（160 个测试文件、
1328 项测试通过、1 项 live smoke 默认跳过）。

## 历史基线：实施批次 E 之前的能力快照

以下表格只保留批次 E 开始前的审计基线，用于追溯，不覆盖本文件上方“实施批次 E”的当前状态；其中的“尚未实现”描述不应被当作当前代码结论。

| ID     | 能力与验收范围                                                                                                                                                                   | 主要代码位置                                                                                                                                                                                                                                                    | 最低测试证据                                                                                                                                         | 状态    | 当前证据与缺口                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ED-01  | 编辑器上下文桥：活动编辑器安全快照、资源 TTL、版本/代际失效                                                                                                                      | `domain/feature-contracts.ts`, `webview-protocol/feature-schemas.ts`                                                                                                                                                                                            | 路径/范围/所有权/过期/上限 schema 测试                                                                                                               | PARTIAL | Slice 0 已冻结 canonical workspace-relative path、资源 owner/workspace/view/session/generation/TTL 规则和严格上下文 DTO；尚未接入 VS Code Editor Host、DSH session 或真实 Webview。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| RV-01  | 结构化变更审查：proposal、tool success、filesystem observed 分层                                                                                                                 | `domain/feature-contracts.ts`, `webview-protocol/feature-schemas.ts`                                                                                                                                                                                            | 变更证据/状态/严格事件 schema 测试                                                                                                                   | PARTIAL | Slice 0 已冻结变更证据与 application/review 状态枚举、事件身份和 bounded diff DTO；尚未实现变更采集、diff 预览、审查操作或文件写回。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| TC-01  | 跨会话任务中心：任务摘要、动作边界、session cancel/process stop 区分                                                                                                             | `dsh-adapter/feature-capabilities.ts`, `webview-protocol/feature-schemas.ts`                                                                                                                                                                                    | 会话范围降级/任务动作 schema 测试                                                                                                                    | PARTIAL | Slice 0 明确 DSH 当前 session-scoped task source，并将跨会话聚合标为 compatibility fallback；DTO 区分 session cancel 与 process stop；尚未完成全局数据源 spike、任务中心 UI 和动作路由。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| CP-01  | 检查点与恢复：CAS、manifest、冲突检测、partial restore                                                                                                                           | `domain/checkpoints.ts`, `apps/extension/src/checkpoints`, `webview-protocol/feature-schemas.ts`                                                                                                                                                                | 检查点元数据/冲突/部分恢复/存储故障测试                                                                                                              | PARTIAL | Host-only `CheckpointStore` 已接入 globalStorageUri；默认关闭，开启后默认 metadata-only，content snapshot 需第二个设置；journal/backup/rollback、startup recovery、冲突预览、partial restore 和 drawer 已实现，自动测试覆盖 11 项存储/故障与 4 项 UI；仍缺真实 VS Code workspace trust/symlink/remote 文件系统和现场恢复证据。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| PT-01  | Prompt 模板与模式：可审计变量、作用域、插入/更新生命周期                                                                                                                         | `domain/prompt-templates.ts`, `apps/extension/src/prompts`, `apps/webview/src/features/prompt-templates`, `webview-protocol/feature-schemas.ts`                                                                                                                 | 模板存储故障/变量/取消、严格协议、模式 UI/映射测试                                                                                                   | PARTIAL | Host-only 存储固定到 extension global storage 或受信 workspace 的 `.dsh-vscode/prompts`；正文以 checksum manifest + atomic rename 保存，读取时校验完整性和元数据，Webview 只收到严格 DTO，插入不会自动发送且缺失变量必须显式处理；工作流模式的 Plan 仅调用已声明的 `/plan`。仍缺真实 VS Code 文件系统/Webview 回放、reload 持久化和真实 DSH 证据。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| NAV-01 | 安全导航：workspaceFolderId + canonical relativePath + optional range                                                                                                            | `domain/feature-contracts.ts`, `webview-protocol/feature-schemas.ts`                                                                                                                                                                                            | 路径拒绝/范围/未知字段测试                                                                                                                           | PARTIAL | Slice 0 已冻结 Host-mediated navigation request，拒绝绝对路径、URI、遍历和跨平台分隔符；尚未接入 VS Code `openTextDocument`/编辑器导航。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| SY-01  | 符号/诊断上下文：Host 采集、限量、stale 标记与显式引用                                                                                                                           | `webview-protocol/feature-schemas.ts`                                                                                                                                                                                                                           | 严格上下文 DTO/大小上限测试                                                                                                                          | PARTIAL | Slice 0 将 symbol/diagnostic 作为受限 context kind，能力画像暂标 unavailable；尚未实现 VS Code Language Service 采集。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| RF-01  | 失败与恢复诊断：安全摘要、事件缺口、存储损坏与可恢复动作                                                                                                                         | `domain/errors.ts`, `domain/diagnostics.ts`, `webview-protocol/schemas.ts`, `apps/extension/src/backend/diagnostics.ts`, `apps/webview/src/features/diagnostics/`                                                                                               | canonical error/schema 回归、脱敏 ring、Store/Panel/Drawer 测试                                                                                      | PARTIAL | Slice 0 的 `EVENT_GAP`/`STORAGE_CORRUPT` 保留；当前已实现 Host 脱敏快照、32 条 ring、严格 Webview 解析、诊断面板和 reconnect/Output 动作。仍缺真实 DSH 故障注入、事件缺口/存储损坏回放及现场 VS Code Webview 证据；固定上游无 diagnostics/recovery RPC，不伪造上游能力。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| RT-01  | Runtime 定位：配置路径、PATH、npm global、版本兼容、Windows `.cmd`                                                                                                               | `apps/extension/src/backend/runtime-locator.ts`                                                                                                                                                                                                                 | Windows/Linux/macOS + 超时/畸形版本                                                                                                                  | PARTIAL | 配置/PATH/npm global、rc.6 版本检查、取消和 Windows npm shim→Node 解析已实现；shim 单测及真实 Windows managed smoke 通过；缺跨平台自动化矩阵。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| RT-02  | 缺失 DSH：底部安装提示、复制命令、选择路径、重试、文档；不自动安装                                                                                                               | `features/runtime/RuntimeMissingView.tsx`, `vscode/install-runtime.ts`                                                                                                                                                                                          | E2E 点击/取消/失败/成功                                                                                                                              | PARTIAL | Host 授权安装/选择/复制/文档路由已实现；缺完整 VS Code E2E。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| RT-03  | DSH 上游更新检查、精确版本下载安装、启动提示与外部进程安全边界                                                                                                                   | `vscode/update-runtime.ts`, `SettingsDrawer.tsx`, `app/store.ts`                                                                                                                                                                                                | npm 元数据/版本校验/失败/设置交互                                                                                                                    | PARTIAL | Host 侧实际查询 npm `@deepseek-ai/dsh` 元数据，按 SemVer 排序并验证精确版本，再执行全局 npm 安装；Webview 只接收版本标签和状态，启动检查不启动 DSH，设置页支持选择 rc.6–0.1.2-rc.1 等清单版本；自动化测试已覆盖排序、畸形响应、未列版本拒绝、安装验证和 UI 操作；尚缺跨平台 npm/VS Code Webview 实机回放与更新后重连证据。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| CN-01  | `auto` 先发现再启动，健康候选逐个回退，并发连接合并                                                                                                                              | `application/.../dsh-connection-coordinator.ts`                                                                                                                                                                                                                 | spawn=0 attach 测试 + 竞态测试                                                                                                                       | PARTIAL | 9 个协调器测试、attach-before-spawn 和实际 rc.6 attach 检查已完成；缺自动真实 spawn/回退矩阵。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| CN-02  | `auto`、`custom`、`attach-only`、`new-isolated` 的连接策略与所有权边界                                                                                                           | 同上                                                                                                                                                                                                                                                            | 四种模式集成测试                                                                                                                                     | PARTIAL | fake integration 已覆盖 auto attach、custom 只探测指定 loopback、attach-only 绝不启动和 new-isolated 受管实例；custom 缺失/不可达端点、协议校验和设置交互均有自动测试；真实 Windows VS Code 完整模式/竞态矩阵仍缺，因此保持 PARTIAL。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| CN-03  | 自定义端口、端口 0、配置/Known/默认/OS/companion 发现、无宽泛扫描                                                                                                                | `extension/src/backend/discovery/*`                                                                                                                                                                                                                             | Provider 单测 + 跨平台集成                                                                                                                           | PARTIAL | 受限 Provider、loopback 校验、Windows/Linux/macOS 进程解析测试已实现；缺三平台实机测试。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| CN-04  | 外部/受管所有权：只停止当前扩展创建并持有句柄的子进程                                                                                                                            | `process-supervisor.ts`, coordinator                                                                                                                                                                                                                            | 外部进程存活 + managed 退出                                                                                                                          | PARTIAL | fake ownership 测试、真实 Windows managed smoke（受管实例退出）和外部实例存活复核已完成；缺完整扩展卸载矩阵。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| CN-05  | 断线恢复、事件续接、历史补洞、无重复事件                                                                                                                                         | `dsh-adapter/stream-controller.ts`                                                                                                                                                                                                                              | 断流/乱序/重复/补洞 fixture                                                                                                                          | PARTIAL | rc.6 mux/host WebSocket downlink、重连、序号去重和历史 hydrate 已实现；Loopback WebSocket 的合法/畸形/错误/取消/释放测试通过；本轮补齐 HTTP/网络/超时/取消错误的稳定映射与重试边界，未知 runtime 按最新可安全复用 wire 的 Adapter 兼容探测并保留真实版本；仍缺断流/补洞 fixture、真实 Windows VS Code managed smoke 的完整事件流复核。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| CN-06  | `0.1.2-rc.1`/alpha.1/alpha.2/alpha.3/alpha.4/alpha.5/`0.1.3-alpha.1`/`0.1.3-alpha.2`/`0.1.5-alpha.1`/`.2`/`rc.1`/`rc.2` Connection/Gateway 协议、Cookie 握手、多路复用与兼容投影 | `dsh-adapter/src/versions/rc13` + `versions/alpha` + `versions/alpha2` + `versions/alpha3` + `versions/alpha4` + `versions/alpha5` + `versions/alpha13` + `versions/alpha132` + `versions/alpha151` + `versions/alpha152` + `versions/rc151` + `versions/rc152` | HTTP/WS envelope、错误、Session v0/v2/v3、assistant stream、subagent delivery/catalog、explicit deliverables、feedback categories、waterfall fixture | PARTIAL | 已发布 `0.1.2-rc.1` 按 npm/tag `a66e4702` 建立 `versions/rc13` 精确入口，保留 alpha.5 的 Cookie、remote.mux、packed history 和 `seedLength` Session v0；alpha.1 已按 `dsh-v0.1.2-alpha.1`/`cd5ef814` 适配 `/api/<namespace>/<method>`、`/api/remote.mux`、`$events`、Session/Workspace follow、packed chunk rows、Goal/Model/Preset 映射和 Host-only Cookie；alpha.2 按已发布 `dsh-v0.1.2-alpha.2`/`0a53fb55` 独立归一化 namespaced error、`ignorable` 事件和可选 agent-preset 插件组合；alpha.3 按已发布 `dsh-v0.1.2-alpha.3`/`dd6322d6` 保持同一 wire mapper，补齐精确版本入口、`--no-open` 与 alpha PTC 模式；alpha.4 按 tag `dsh-v0.1.2-alpha.4`/`4e84901e` 核对 Session branded sequence/offset、inherited-event 到 `seedLength` 的 wire 投影及 Subagent 内部投递重构，保持 Connection/Gateway/Remote wire；alpha.5 按 tag `dsh-v0.1.2-alpha.5`/`db6bdc35` 及此前核对的 `master`/`49a606bc` 增加独立精确入口并沿 alpha.4 线复用已验证 transport/mapper，alpha.4 不再作为未知回退；`0.1.3-alpha.1` 按 tag `dsh-v0.1.3-alpha.1`/`d347e703908d0406b7a7ef80e3a0e594d86b2215` 建立 `versions/alpha13`，严格校验 Session v2 的 `isSeeded`、event-only history、`assistantStream: true` 的 `start/chunk/end` 修订序列、压缩 assistant baseline 与 durable settlement；已发布 `0.1.3-alpha.2` 按 tag/提交 `dsh-v0.1.3-alpha.2`/`82a5fd61a7cf5c293cec4bdff68f455398d685e9` 建立 `versions/alpha132`，复用 v2 流并只对精确 alpha.2 透传严格必填的 subagent `delivery: queue | steer`，旧版本不发送该字段；`0.1.5-alpha.1` 按 tag/提交`dsh-v0.1.5-alpha.1`/`5dda764ed3aa172535a7967b06ff95d9cbfe536a`建立`versions/alpha151`，独立校验 Session v3 严格事件 envelope、surface `startSeq/endSeq`、`system/message`与 PTC 事件名，复用未变化的 Connection/Gateway/remote.mux/assistant stream/subagent delivery 传输边界；已发布`0.1.5-alpha.2`/`b2e3b2a0`与`0.1.5-rc.1`/`183f08e9`分别建立`versions/alpha152`与`versions/rc151`，沿 v3 精确复用传输，补齐 `deliverables/presented`有界文件 DTO、Timeline 交付卡片、Host 文件打开/显示委托和`subagent/catalog` 父目录刷新；`0.1.5-rc.2`/`fb2c4b9e`建立`versions/rc152`，沿 rc.1 复用未变化的 Connection/Gateway/Session v3 wire，补齐消息反馈七分类、统一提交/撤销对话框语义、交付物紧凑间距和 20px 文件图标；`alpha152-rc151-contract.spec.ts`、rc.2 contract、feedback repository/Store/Webview schema、MessageActions/Timeline 回归覆盖精确版本、畸形载荷、事件序号、分类边界和 UI 委托。当前只完成代码与自动测试证据；尚未执行真实 `0.1.5-alpha.2`/`rc.1`/`rc.2` Web Profile、Cookie、`remote.mux`、Session v3、present 工具、目录刷新、反馈 Remote 和 VS Code Webview smoke，因此继续保持 `PARTIAL`。安装器默认 rc.2（npm `next`）不等同于 live 兼容完成。 |
| VS-01  | Activity Bar View、可拖 Secondary Side Bar、一次性右栏引导                                                                                                                       | `apps/extension/package.json`, `secondary-sidebar.ts`                                                                                                                                                                                                           | VS Code E2E + 布局说明                                                                                                                               | PARTIAL | 稳定 API View、引导命令和 ADR 已完成；缺 VS Code E2E 布局验证。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| WS-01  | Workspace 列表/创建/重命名/删除/排序/目录选择、多根工作区                                                                                                                        | Workspace repo + `SessionDrawer.tsx`                                                                                                                                                                                                                            | 多根工作区 E2E                                                                                                                                       | PARTIAL | rc.6 list/create/rename/delete 与 Host 授权目录选择已接通；workspace/session 已改为紧凑切换器和按需覆盖面板；本批次补齐工作区选择卡、重命名/确认移除、按工作区分组和 Manual/Last updated 会话视图；仍缺拖拽排序、多根 E2E。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| SS-01  | Session 新建/列表/分页/历史/搜索/重命名/分叉/归档/删除/恢复                                                                                                                      | Session repo/use case/drawer                                                                                                                                                                                                                                    | 冷启动恢复 + 全 CRUD                                                                                                                                 | PARTIAL | 新建/list/search/history/rename/fork/archive 已映射；Webview 聊天消息下方提供紧凑复制操作，按上游 `turn/start`、`assistant/message`、`turn/end` 归并 turn，只有已结束 turn 的最终可见回复才调用 rc.6 `session.fork`，并支持任意历史回复；迟到工具投影不会重新打开已结束 turn；删除动作通过 rc.6 `workspace.archiveSession` 从当前工作区移除，并在删除活动会话后切换到剩余会话；本批次补齐会话重命名对话框/同名提示、分叉自动 `(N)` 命名、running/awaiting/completed/failed 状态徽章、Manual/Last updated 排序和工作区分组；新增有界 `session.history` 尾页、`beforeSeq` 向前加载、顶部滚动自动触发、序号去重/完整时间线重建、projection/sessionStats 保留和滚动锚点，协议、Adapter、Store、Timeline 定向测试已覆盖；真实 rc.8 已实际请求首尾页和 `beforeSeq` 边界，但本次会话仅有一页（`hasMore=false`），恢复/完整冷启动与 VS Code Webview 回放仍缺。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| CV-01  | 文本流、推理、工具、错误、重试、标题、统计、Trajectory 账本和历史回放                                                                                                            | rc6 mapper + timeline + `Timeline.tsx` + `TrajectoryView.tsx`                                                                                                                                                                                                   | 确定性回放 + 实际会话                                                                                                                                | PARTIAL | mapper/timeline fixture 和历史恢复已完成；Timeline 按上游 turn/step 边界归并文本、推理和工具，`assistant/message` 只结束步骤，`turn/end` 才结束活动状态；迟到投影不会让已结束 turn 恢复 streaming；`llm/retry` 已映射为结构化 `model.retry` 并在 Timeline 聚合为单条 shimmer 状态行（恢复输出即清除），compaction 各 phase 合并并显示 replaced/估算 token，Composer 上方新增 StatsLine（turns/steps/↑↓tokens/cache hit）；已用实际 rc.8 prompt 验证 DSH→Adapter→Timeline 的长正文、思考、工具节点和 turn 终态；Trajectory 视图已恢复；它消费共享的历史事件/时间线节点，宿主端不再生成或推送轨迹快照；与固定上游完整 UI 定义的真实回放仍待验证。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| IN-01  | Composer 文本、IME、发送/停止、运行状态                                                                                                                                          | `features/composer/Composer.tsx`                                                                                                                                                                                                                                | 键盘/IME/重复提交 E2E                                                                                                                                | PARTIAL | 发送/取消/禁用/附件入口已接通；官方键盘提交策略已实现：Shift+Enter 无条件原生换行、IME 组合期（isComposing/229/组合结束 10ms 窗口）不发送、Enter 重复键抑制、250ms 防抖、空闲 Enter=queue、运行中按 busy-Enter 偏好、加速键取其反面、空草稿加速 Enter 将全部 queue 行转 steer（等价官方 dock 整队 steer），domain→adapter（`session.prompt` mode 参数）→协议 schema→store 全链路传递（Composer 组件测试 12 例、adapter 契约测试 3 例）；输入区默认 42px 并随内容增高至 132px 后滚动（组件回归 1 例）；缺 busy-Enter 偏好持久化设置与真实会话 E2E。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| IN-02  | Queue/Steer、队列查看/编辑/删除/转 Steer、取消                                                                                                                                   | Session repo + `features/input/QueuePanel.tsx`                                                                                                                                                                                                                  | 运行中操作集成/E2E                                                                                                                                   | PARTIAL | rc.6 queue frame、cache 和 update/remove/steer 已接通；`session.prompt` 已按上游 mode 参数区分 queue/steer 投递（默认 queue，测试覆盖两种 mode 的 RPC 契约），空草稿加速 Enter 可整队 steer；队列编辑/模式/删除展示已统一为响应式控件；缺真实运行中操作验证。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AT-01  | 图片/文件粘贴、拖放、选择、预览、持久化、历史读取、限制                                                                                                                          | `features/attachments/*`, Extension file boundary                                                                                                                                                                                                               | PNG/JPEG/WebP/GIF/文本文件/尺寸/取消                                                                                                                 | PARTIAL | Host 授权选择图片和文本/代码文件；图片按 rc.6 image content 发送，文本文件在 Host 侧转为带文件名边界的 text content；Composer 可列出已打开文件、默认当前文件并记忆候选，Host 读取所选文件最新内容后以短期句柄加入；新增粘贴/拖放入口（`attachment.ingest`，base64 进 Host 校验魔数与 8MiB 上限后返回短期句柄）、拖放覆盖层、图片缩略图（`attachment.preview` 仅回图片 data URI）与 Lightbox（Esc/背景关闭）；二进制文档仍按上游契约明确拒绝，缺历史附件读取。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| MD-01  | 动态 Provider/Model/Reasoning 发现、选择、不可用状态、每会话应用                                                                                                                 | Model repo + `features/models/*`                                                                                                                                                                                                                                | 自定义 Provider + 切换后请求                                                                                                                         | PARTIAL | rc.6 `llm.providers/models` 和 session model select 已映射；Settings→Models 表单已提供 provider secret 配置、状态徽标与目录刷新，并恢复上游的两种添加入口：从动态目录选择并物化已知 Provider，或单独声明自定义 Provider；缺实际切换验证。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| AG-01  | standard/code/minimal/cordis/用户 Preset、Tools native/code/both                                                                                                                 | session config + picker/settings                                                                                                                                                                                                                                | 每会话配置契约 + live                                                                                                                                | PARTIAL | Preset list/select、动态 id、受管工具环境已实现；Agent preset 按 rc.6 规则仅允许空白会话切换，已开始会话由权限/Plan 命令控制运行时模式。批次3c 已补齐官方 Agent Presets 管理界面：roster 按 trust 分组卡片（default/broken/In use 徽标，broken 原因行内 alert）、经 `agent-presets.default` 设置字段设默认并重读权威 roster、copy 对话框为唯一创建入口（客户端按 host 同款 `^[a-z0-9][a-z0-9-]*$` 规则校验 id/占用，host 拒绝回显）、shipped 组合只读查看器、user preset 确认后删除、`agentPreset.openDocument` 打开失败时回退展示路径、authorable/hasDocument 部署事实控制复制与定位入口（adapter 契约测试 11 例、PresetManager 组件测试 14 例）；缺真实 DSH smoke。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| PM-01  | read-only/workspace-write/full-access/custom 权限与 DSH 审批一致                                                                                                                 | session config + ApprovalCard                                                                                                                                                                                                                                   | 不绕过审批 + 单次响应                                                                                                                                | PARTIAL | 审批 rpc correlation、单次响应和密码边界已实现；当前会话权限通过上游动态命令目录的 `commands/execute` 切换，动态 preset id 不再被本地枚举拒绝；缺真实 DSH smoke。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| PL-01  | Plan Mode、Goal 生命周期、Todo、恢复一致                                                                                                                                         | Goal repo + `GoalTodoStrip.tsx` + `TodoList.tsx`                                                                                                                                                                                                                | 事件回放 + 重连快照                                                                                                                                  | PARTIAL | goal create/CAS edit/pause/resume/complete 与历史读侧已实现；`/plan`、`/plan off` 已接入当前会话控制；结构化 `todo/write` 投影的 content/status 已在 Composer 上方默认展开可收起单行，含完成进度、pending/in-progress/completed 状态、长列表滚动和窄宽降级（组件/集成回归 4 例），不再把当前 TODO 放在会话顶部导致滚到底后不可见；缺完整 revision 快照/恢复 UI 与真实 DSH smoke。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| IQ-01  | DSH User Question 单选/多选/自由文本、过期恢复                                                                                                                                   | Interaction repo + UserQuestionCard                                                                                                                                                                                                                             | 各输入类型 + 重复响应                                                                                                                                | PARTIAL | rpcId/question id 分离、选项标签、单次响应及单测已完成；批次2c 已补齐官方 ask 增强：domain `UserQuestionItem`/`QuestionIntent`/选项 description 与 items[]、rc6 mapper 映射 detail/header/plan-review intent/多问题、adapter 批量应答（selected+custom 自由文本、`answers` 批量 RPC、重复提交幂等、过期 STALE_INTERACTION）、协议 schema 批量 questionAnswer、UserQuestionCard 多问题表单+approve 高亮+自由文本+整批提交（组件测试 5 例、adapter 契约 7 例）；缺过期/取消 fixture 与真实 DSH smoke。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| JB-01  | Jobs 列表/输出/进度/完成通知/停止                                                                                                                                                | Job repo + JobsDrawer                                                                                                                                                                                                                                           | 后台 Shell/子代理 + cancel                                                                                                                           | PARTIAL | rc.6 `session/jobs` 缓存和 Timeline 映射已完成；批次4a 补齐等价官方 JobListAction 的会话头 popover：live 优先排序、进行中状态点、每秒 duration 计时（打开且有 live 行才走钟）、Escape 关闭回焦触发器、行内 cancel（`job.cancel`）、目录清空自动复位（App key 重挂，不留旧 open 状态）；rc.6 无 job.list RPC，输出 UI 未接通；缺真实 DSH smoke。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| SA-01  | Subagent 树/历史/Follow-up/Interrupt/父子路由                                                                                                                                    | Subagent repo + SubagentDrawer                                                                                                                                                                                                                                  | continuable/one-shot + stale                                                                                                                         | PARTIAL | list/prompt/interrupt 和父子地址路由已映射；批次4b 补齐等价官方 SubagentCatalogAction 的懒加载 ARIA tree：`subagent.list` 按需展开分支、treeitem 键盘导航（ArrowUp/Down/Home/End/Enter/Space）、continuable/one-shot 与运行状态标注、Enter 打开子会话、目录清空经 App key 重挂复位；入口现直接消费 `SubagentCatalog.entries`，显示“子代理”标签、独立数量徽标与运行态，目录在打开时刷新；目录面板以触发器为锚点悬浮，居中后按视口边距钳制位置和宽高，不占用会话布局也不向任一侧溢出；组件与 App 回归覆盖目录存在时入口不消失、嵌套加载和父可用性；历史协议未完成；缺真实 DSH smoke。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| WF-01  | Workflow/Ralph 列表、阶段、启动、完成/失败/取消                                                                                                                                  | Workflow repo + WorkflowDrawer                                                                                                                                                                                                                                  | 全状态事件 fixture + live                                                                                                                            | PARTIAL | 固定 rc.6 RPC map 没有 Workflow 方法，repo 显式不可用并保留安全降级；批次4c 补齐事件驱动的 WorkflowDrawer：`workflow.updated` Host 事件按会话聚合（切换会话即清空投影）、run 卡片 + 阶段分组、含未完成成员的阶段强制展开、成员状态摘要与点击打开子会话；启动/取消控制无上游 RPC，不做虚构。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| SK-01  | Skills 项目/用户/插件发现、优先级显示、刷新、执行                                                                                                                                | Skill repo + SkillPicker                                                                                                                                                                                                                                        | 来源优先级 + 执行                                                                                                                                    | PARTIAL | rc.6 session-scoped skill.list 和 slash prompt 已映射；上游只提供项目目录，缺多来源优先级。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| CM-01  | 动态命令、`/plan`、`/goal`、`/compact`、`/feedback`、参数提示                                                                                                                    | Command repo + CommandPalette                                                                                                                                                                                                                                   | 未知命令不发送模型                                                                                                                                   | PARTIAL | rc.6 Typert Remote `commands/list`/`commands/execute` 已接入当前会话；命令目录严格按上游描述映射，Host 转发 `commands/change` 或 `agent-preset/selected` 时刷新，未知 command 仍不会发送给模型；批次2d 已补齐官方输入触发器交互：combobox 键盘仲裁（ArrowUp/ArrowDown 循环高亮、IME 组合守卫、Escape 关闭直至 query 变化、Enter 选取高亮行）、textarea 持焦点 + `aria-expanded`/`aria-controls`/`aria-autocomplete`/`aria-activedescendant` 联动、官方 Enter 裁决（args-tolerant 命令整行经 `commands/execute` 提交、bare-token 无参仅提交 token、bare-token 带参回落普通提交）、行 mousedown 选取不夺焦点、Tab 补全首位候选、权限 preset 与 `plan [off]` 字面量参数模糊补全（渲染/键盘行模型/Tab 选择三者共用同一排序，CommandPalette 组件测试 20 例 + Composer 命令仲裁测试 8 例）；缺真实 DSH smoke。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ST-01  | DSH Settings Schema、读取、更新、替换、live/restart 语义                                                                                                                         | Settings repo + SettingsDrawer                                                                                                                                                                                                                                  | Schema fixture + rollback                                                                                                                            | PARTIAL | settings describe/read/update/replace 与 secret redaction 已映射；SettingsDrawer 已提供 General 设置事实与 Models 表单（provider 分组、secret 经 Host 密码输入配置/替换/移除、目录刷新与 per-provider 模型列表，组件测试 6 例）；批次3b 已补齐 General 设置表单：`extensionSettings.read` 与 DSH `settings.read` 快照分离（协议 schema 各自独立消息）、schema 驱动的 DSH 偏好行（permission.defaultPreset/ui-theme.preference/ui-conversation.busyEnter，仅当 host schema 广告 enum 字段才渲染控件，绝不虚构命名空间）；共享的 `locale.preference` 由扩展界面语言控件统一驱动，Settings 与顶部菜单使用同一个 Locale，连接时同步 DSH，未连接时仍可切换扩展界面；upstream RiskConfirmation 语义（full-access 需显式确认对话才写回）、写回成功/失败后均重载权威快照（revision 冲突回显 host 值）、restartRequired 行内提示、保存错误与行级 Saving 状态、`ui-conversation.busyEnter` 偏好经 store 联动 Composer Enter 裁决（组件测试 12 例）；批次3d 已补齐 schema 的 per-namespace 元数据（applies/userFields/secrets 事实经 `settings.describe` 透传，secret 视图为其路径的权威来源，schema 派生行去重）与 `settings.mutate` op `unset` 用户层覆盖移除（adapter 契约测试 4 例）；设置对话框改为主题实色表面，连接标签直接使用 BackendState，并从 Extension Host 已验证的连接能力中白名单透传 `dshVersion`（不传 endpoint/pid/Secret），不再把版本缺失误判为未连接；仍缺非 enum 字段表单、rollback UI 与真实 DSH smoke。                                                  |
| ST-02  | Provider Secret：仅密码输入/DSH 凭据 API，UI 只见状态                                                                                                                            | Credential repo + `credential-input`                                                                                                                                                                                                                            | 日志/协议/状态无 Secret                                                                                                                              | PARTIAL | Host password input、credentials.set/unset、协议脱敏已实现；缺 live credential smoke。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PG-01  | Plugin Inventory、能力、显式配置、重连/重启提示、未知插件降级                                                                                                                    | Plugin repo + PluginInventory                                                                                                                                                                                                                                   | 未知插件/外部进程不重启                                                                                                                              | PARTIAL | rc.6 `pluginInventory/list` direct Remote 已接入为只读投影（entryId/moduleName/enabled/fiberPhase 闭集校验，`null`=未挂载）；SettingsDrawer 新增 Plugins 页，等价官方 PluginInventorySettingsTab 语义：搜索（moduleName/entryId 不区分大小写）、卡片展开显示 entryId/配置状态/Cordis 状态、enabled 徽标 + phase 状态点、禁用条目无状态点、空/无匹配/加载/错误重试态、被过滤掉的展开卡片自动折叠（adapter 契约测试 6 例 + 组件测试 7 例）；rc.6 契约未发布任何 mutation 路径，插件由部署组合，客户端不提供开关；缺真实 DSH smoke。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| TL-01  | 通用 Tool Card + Shell/Edit/Search/LSP/MCP 等专用可插拔 Renderer                                                                                                                 | UI registry + rc6 tool mapping                                                                                                                                                                                                                                  | 官方 tool catalog fixture                                                                                                                            | PARTIAL | 通用 ToolCard、registry、输入输出摘要和未知降级已实现；新增 UI presentation boundary，将工具摘要解包为带标签的请求/结果段落并过滤协议 envelope、内部 id 与敏感字段，Subagent 专门呈现 Task/Instructions/Result，标题与任务名分层且状态不再截成 `to…`；新增与上游 ui-tool/ui-skill 对齐的 ToolRow 展示：Shell/Pwsh、Read、Write/Edit、Search/Grep/Glob、Web、Todo、Question、Code、Skill 和 Cordis Inspect/控制行按冻结 `ToolCallView` 派生摘要、状态和可展开正文，未知工具仍保留通用 ToolCard 降级；本批次按 rc.8 官方 presentation.d.ts 接入 terminal/diff/search/read/web 的结构化 call/result 卡片，保留 rc.6 无 view 与未来未知 card 的通用回退，并通过 Host-only `openLink` 委托文件/网页打开；组件、Timeline、registry 与 adapter 契约回归覆盖真实协议形状、空行/截断/敏感字段和技能输出 envelope 过滤；已用真实 rc.8 `skill.list` 目录与一次真实技能请求验证，后者因隔离环境无凭据在 DSH 的 `assistant/chunk` 错误事件结束；另用真实 rc.8 Web Host、真实 session.prompt/session.history 和本机回环 OpenAI-compatible SSE 驱动真实 `read` 工具，history 返回外层 `{ event, view }` 的 `read` result card，实际读取 README.md 前 3 行并最终输出 `REAL-VIEW-CHECK`，未伪造插件事件；外部凭据会话、完整官方 catalog fixture 与浏览器 E2E 仍缺，因此保持 PARTIAL。                                                                                                                                                                                                   |
| EX-01  | Markdown/JSON/ZIP 会话与附件流式导出、取消和安全路径                                                                                                                             | Export repo + ExportDialog                                                                                                                                                                                                                                      | 大会话/Zip Slip/取消/覆盖                                                                                                                            | PARTIAL | Host 明确确认覆盖；Adapter 使用同目录 `wx` 临时文件、flush、可回滚替换并只清理本次临时文件；JSON/Markdown 按块写出，ZIP 使用 rc.6 Host-only 流；不支持的 ZIP 无附件/无推理选项明确返回 `CAPABILITY_UNAVAILABLE`；已补目标存在、失败保留、回滚、取消、畸形响应和 ZIP 参数测试；批次4f 接通 Webview 触发：会话头 Export 按钮打开 ExportDialog（`session.export` 经 store 走 Host 保存对话框，取消为正常无操作），ZIP 格式时附件/推理开关锁定为必含并显示原因提示，与 rc.6 Host 档案语义一致；仍缺真实 DSH 导出、长历史压力与 Zip Slip 证据。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| UX-01  | 草稿、上次会话恢复、Quick Pick、通知、错误恢复；不自动发消息                                                                                                                     | Webview store + VS Code commands                                                                                                                                                                                                                                | Reload E2E                                                                                                                                           | PARTIAL | session history hydrate、错误/重连、草稿和通知通路已实现；批次4e 引入 `I18nProvider` + localStorage 持久化共享 UI locale，并与 DSH 的 `locale.preference` 统一：Settings 与顶部菜单驱动同一个 Locale，连接时同步 DSH，localStorage 仅用于首屏恢复；English/中文切换已覆盖会话空态/页签、会话菜单、Composer 与附件、模型/权限/Plan 控件、Timeline 外壳、统计、Queue、Runtime Missing、Jobs/Subagent/Workflow popover、完整 Export 表单以及 Settings 的 General/Models/Presets/Plugins 全部静态文案，根节点 `lang` 随之更新，Provider 外仍以英文回退；语言菜单改为使用 VS Code menu/list 主题变量的自绘 listbox，避免系统原生下拉样式漂移；组件回归验证语言切换跨会话、导出与设置表面生效。视图标题栏新增 `dsh.openWebUi` 按钮（`$(globe)`），仅在 `dsh.connected` 时显示，从 Extension Host 已验证的连接 endpoint 取端口后用 `vscode.env.openExternal` 在浏览器打开 DSH Web UI，endpoint 不出 Host；中英文覆盖已补全：Trajectory 视图（搜索/计数/轮次区段/检查器/耗时/跳转）、Timeline 外壳（Goals/Todo/Events/Payload/Thinking/压缩/重试/附件/耗时）、连接与全部错误回退文案、错误边界、运行时状态、Goal 条、SessionControls、共享 ui 包 ToolCard 与工具展示标签（接受可选 translate 参数）以及 store/协议层错误与连接提示（经模块级 translate）均随语言切换；仍缺 VS Code reload 持久化 E2E。                                                                                                                                                                         |
| PF-01  | 单流共享、批量 Delta、虚拟列表、缓存失效、资源释放                                                                                                                               | stream/timeline/store                                                                                                                                                                                                                                           | 性能基准 + heap/handle 检查                                                                                                                          | PARTIAL | 单流、序号去重、TanStack Virtual、close/disposal 已实现；Timeline 使用 `ResizeObserver` 在侧栏宽度变化和文本重排后对“已贴底”视口立即及延迟二次校正，主动上滚的阅读位置不被强制拉回（组件回归 2 例）；缺性能与资源基准。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| SC-01  | Loopback、CSP、Schema 校验、无 shell、日志脱敏、Workspace Trust                                                                                                                  | Extension/Protocol/diagnostics                                                                                                                                                                                                                                  | 安全负面测试                                                                                                                                         | PARTIAL | loopback/CSP/Zod/无 shell/脱敏和 Host 文件边界已实现；本轮新增 method/status/timeout 上下文、HTTP/网络/取消错误映射，并验证永久错误不重试且错误响应体不出边界；缺 Workspace Trust 与完整负面矩阵。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| AX-01  | 键盘、焦点、屏幕阅读器、亮暗/高对比、240px、Reduced Motion                                                                                                                       | UI/Webview                                                                                                                                                                                                                                                      | axe/manual matrix                                                                                                                                    | PARTIAL | 原生控件、ARIA、可展开切换器、焦点样式、组件语义回归测试、360px 以下断点和 Reduced Motion 样式已覆盖；仍缺 axe/manual matrix 与真实 240px/高对比验证。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| RL-01  | CI 三平台、VSIX、版本/隐私/许可证/升级/回滚                                                                                                                                      | `.github/workflows/build-vsix.yml`, workflow/release docs                                                                                                                                                                                                       | clean checkout CI + install                                                                                                                          | PARTIAL | GitHub Actions 已覆盖 Linux x64、Windows x64、macOS x64/arm64 的依赖安装、构建和目标 VSIX 上传；`v*` tag 自动创建 GitHub Release；仍缺正式仓库元数据、Marketplace 发布凭据和安装回滚验证。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## 2026-08-21 P0/P1 gap closure evidence

本节是对上表 P0/P1 WebUI 差距的增量证据，仍遵守“代码、自动测试、真实 DSH 运行验证”三项齐备才标记 `DONE` 的规则：

- P0 会话/工作区与 Composer：重命名冲突、归档、分叉命名、状态徽章、历史顶部分页、工作区分组/排序、拖拽排序、空会话姿态、附件 rail、DropOverlay、撤销/重做、队列 steer、引用面板、审批/计划 takeover、ContextMeter、产出文件行均已接入 Host/DSH 协议路径；Markdown 使用 KaTeX、懒加载 Shiki 和流式冻结块；ToolRow 使用结构化 rc.8 presentation 投影，不解析 ANSI/TUI，也不从模型文本猜生命周期。
- P1 子代理/运行态：头部 catalog tree、已加载后代 total/running 聚合、四 bucket token 总计、运行中只读 Composer + Stop、零额外 RPC 的运行中子代理引用、GoalBar 的 `goal.update/goal.clear`、Todo/Job 摘要、preset staged chip/头部标签/Cordis dashed card 均已接入真实路由。
- P1 命令/模型/引用：会话键控命令目录缓存带 generation 失效与失败保留、execute/popupSelect/leadingInput 三类派发、Skill 命令源、文件+会话分组引用、quoted path 搜索、会话级模型目录、provider 分组/effort 两级菜单和 generation-guarded `session.configure` 已完成；动态模型设置支持 Host 侧发现、模型列表编辑，并恢复上游的“已知 Provider + 自定义 Provider”两种添加入口，Webview 不接触 API key。
- P1 设置/导航/恢复：API key 仅显示已配置点、baseURL 只显示非秘密字段；Settings 支持配置文件打开、General 风险确认、模型编辑/发现、自定义 provider 及可滚动 section 导航；首次运行 Welcome notice 的关闭状态由 Webview 本地持久化。Toast 采用 3 秒保持 + 1 秒淡出；工具产物的 Host/OS 打开失败显示带 Retry 的 modal，Retry 只重试 Host 打开动作。Pinned rc.6 没有 `tool.retry` RPC，因此没有伪造“重跑工具”按钮。
- 自动证据：本轮定向 Settings/Model/Goals/Jobs/Session/Composer/Timeline/协议/Adapter 回归通过；新增 Tool open-error modal 的失败→Retry→成功测试。最终 `pnpm check`/`pnpm build` 结果以本轮命令输出为准；本轮新增 P1 路由尚未重新完成真实 DSH smoke，相关矩阵能力保持 `PARTIAL`。

## 2026-08-23 backend review batch B evidence

- CN-01/CN-05：`DshConnectionCoordinator` 在缓存命中前检查取消信号；连接查找结果改为每次调用携带独立的 `searchedLocations` 快照；协调器定向测试 14 例通过，运行时定位并发测试通过。配置变更只对传输相关键触发断开并合并自动重连，仍缺真实 VS Code 配置热更新回放。
- RT-01/CN-04：运行时定位不再共享并发可变路径数组；`ProcessSupervisor` 在停止请求开始时释放活动句柄，并在终止失败后允许重试；运行时定位 8 例、进程监督 3 例定向测试通过，仍缺跨平台扩展卸载实机矩阵。
- SS-01：Goal repository 优先消费 `session.history` 的 host projection，并支持 live `session.projection` 清空；Goal repository 3 例、session repository 18 例、rc.6 contract 20 例通过。历史 projection 与 `goal.updated` 仍保持旧事件回退，完整冷启动/真实 DSH projection 证据缺失。
- SA-01：Subagent history 的 `beforeSeq` 从 Webview schema 经 Application port 传到 rc.6 RPC，并保留 projection 字段；Subagent repository 12 例及 application typecheck 通过。真实 DSH 子代理历史分页仍缺，因此状态继续为 `PARTIAL`。
- SC-01：诊断输出继续使用 allowlist 与文本脱敏，异常栈不直接写入 Webview；诊断 1 例、message-router 4 例通过。Workspace Trust 与完整负面矩阵仍缺。

## 2026-08-23 backend review batch C evidence

- C1/C2：Adapter redaction、record/projection/provider/settings guards 和 bounded history walker 已共享；redaction、guards、stream、rc.6 contract、repository 定向回归通过。未声称消除所有领域语义差异，真实 DSH 运行证据仍缺。
- C3/C4：附件 base64/MIME/魔数与图片/文本 attachment projection 已集中到 adapter codec；composition-root 的 attachment 纯 helper 已迁入 `apps/extension/src/attachments`，保留 Host-only 授权边界。附件 codec、attachment store、session、rc.8 contract 定向回归通过；handler 分发表和 workspace scope 尚未拆分。
- C5/C6：rc.6 agent/tool presentation projection 已移出 mapper；frame 类型从 pinned rc.2 schemas 的 `options` 派生；移除 `commands/list`、`session/title` 和 rc7/rc8 mapper 别名及 rc11/rc12 重复 override；mapper、loopback、stream 定向回归与 dsh-adapter typecheck 通过。全量门禁和真实 rc.2 WebSocket/VS Code 回放以本轮交付结果为准，能力状态继续为 `PARTIAL`。

## 2026-08-30 backend review batch D evidence

- CN-01/CN-02（probe 分类）：`VersionedBackendProbe` 此前把 rc6 家族 probe 刻意抛出的
  `DSH_INCOMPATIBLE`（endpoint 应答了 DSH 握手但未报告兼容 host version）与普通"候选不适用"一并吞掉，
  导致 custom 端点与受管进程路径把它误分类为可重试的 `BACKEND_UNREACHABLE`，与实现顺序阶段 0
  "明确识别兼容/不兼容/非 DSH/不可达"的退出条件相悖。现在 probe 链在无 adapter 接受该候选时保留并抛出
  该分类；coordinator 的 custom 路径原样透传（先发布 `failed`），受管路径先发布 `failed` 再停止本次受管进程，
  auto 发现路径仍继续尝试其他候选。定向证据：`packages/dsh-adapter/test/probe.spec.ts` 4 例、
  `packages/application/test/dsh-connection-coordinator.spec.ts` 17 例（新增 custom 透传与受管进程停止两条）。
- CN-05/SC-01（传输资源释放）：loopback 传输的 4 处非 2xx 抛错点此前直接丢弃响应体；Node fetch 的
  未消费 body 会占住 socket 直到 GC，发现扫描与重试循环会累积占用回环连接。现在统一在抛错前
  `body.cancel()` 释放连接（成功路径与已消费的 PROTOCOL_ERROR 路径不受影响）。
  红绿证据：`packages/dsh-adapter/test/loopback-api-client.spec.ts` 新增 2 例（RPC 重试 3 次均释放、
  导出下载 404 释放），修复前 cancel 计数为 0（红），修复后为 3/1（绿）。
- CN-05（重订阅水位）：上游固定 rc.2 类型明确 v1 mux 忽略客户端 `since`、重连 = reopen + refetch
  history，`session/subscribed.lastSeq` 是服务端日志的权威基线（空日志约定 `-1`）。此前 host 以低于
  本地缓存水位（如进程重启后日志丢失、无 `session-removed` 通知）的 lastSeq 重订阅时，控制器保留陈旧
  高水位并把新纪元事件全部静默丢弃。现在按 host 基线向下收敛水位（projection 水位截断本已存在）。
  红绿证据：`packages/dsh-adapter/test/stream-controller.spec.ts` 新增多代重连测试（重订阅 lastSeq=2
  后 seq=3 事件必须送达），修复前超时失败（红），修复后通过（绿）。
- IQ-01（alpha 取消投影）：alpha `$events` 的 cancel 帧只携带 `eventId`；此前 approval 取消投影
  硬编码 `sessionId: ''`、question 取消投影完全缺失 sessionId，违反 domain 事件类型语义，且
  `BackendService` 的重放清除按 `permission:<session>:<id>` 前缀匹配，取消后的交互在下一次
  webview attach 时仍会作为 pending 重放。现在 pending 记录保存 waterfall 的 `agentId`，取消投影
  回填真实会话 id（InteractionRepository 按 rpcId 匹配，行为不变）。
  红绿证据：`packages/dsh-adapter/test/alpha-contract.spec.ts` 新增 approval/question 两条取消投影
  断言，修复前 `sessionId: ''`/缺失（红），修复后为 waterfall 的真实 `agentId`（绿）。
- 门禁状态：`typecheck`、`build` 通过；全量 `test` 为 97 文件/726 测试，除 `apps/webview` 已知的
  6 个预存前端失败（已在干净树上复现，属进行中的前端工作）外全部通过。本批 4 项修复均已按
  "红测试确认问题存在 → 修复 → 绿"流程完成。

## 2026-08-30 backend review batch E evidence

- CN-06（alpha 会话生命周期）：alpha 事件源此前只处理 `session.added`；host 发布 `api-session/removed`
  （映射为 `host/session-removed`）后，对应 per-session follow 控制器仍留在 `sessions` 表中，其
  `session/follow` 流被服务端结束后按退避无限重连（红测试复现 700ms 内 3 次重开），并且长期驻留的
  Extension Host 中 Map 无界增长。现在 `session.removed` 对称触发 unwatch：从表中移除、清理订阅并
  close 控制器；后续对会话的读取仍按既有 `onSessionAccess` 惰性重看。
  红绿证据：`packages/dsh-adapter/test/alpha-events.spec.ts`，修复前重开计数 3（红），修复后恒为 1（绿）。
- CN-06（alpha 连接状态语义）：单个 per-session follow 流的瞬时失败此前会以全局 `connection.lost`
  发布到所有监听者，而全局流仍然健康；Extension Host 据此拆掉 changeTracker/taskRegistry/editor
  context 且无恢复路径。现在仅 host-wide 控制器有权发布 `connection.lost`，session 作用域控制器在
  投影到共享监听者时过滤该事件（其自身重试循环不受影响，重开计数继续增长证明恢复仍在进行）。
  红绿证据：同文件第二例，修复前监听者收到 `connection.lost`（红），修复后不再收到且重开 ≥2（绿）。
- 门禁状态：`typecheck` 全仓通过、adapter 定向 lint/format 通过；全量 `test` 728 测试中除既知
  6 个预存前端失败外全部通过。

## 2026-08-30 backend review batch F evidence

- CN-05（重连退避状态机）：`DshStreamController` 的退避级别此前只在收到带序号的 session 事件或
  `session.subscribed` 时重置；基于 `streamSource` 的控制器（alpha workspace/session 流）以及只收到
  host 帧的 mux 读取器从不重置，退避级别跨"健康代际 → 干净结束"循环持续爬升，健康期后的下一次瞬断
  也要等待数秒。现在任何代际收到首帧（证明传输存活）即重置退避阶梯；退避仍在每次失败后生效，
  宕机 host 不会被热循环重连。红绿证据：`packages/dsh-adapter/test/stream-controller.spec.ts`
  新增三健康代后退避测试，修复前 2s 内仅 3 次重开（红），修复后 5 次重开在 ~1.2s 内（绿）。
- CN-01/CN-02（连接状态机一致性）：managed 路径的 probe 抛出非 `DSH_INCOMPATIBLE` AppError
  （如 readiness 后 `host.describe` 超时映射的可重试 `BACKEND_UNREACHABLE`）时，coordinator 直接
  重抛而不发布 `failed`，最后发布的状态快照停在 `starting`。现在 probe 抛出的任何 AppError 都先
  发布 `failed`（携带其 message/retryable）再重抛，受管进程仍由既有外层清理停止一次。
  红绿证据：`packages/dsh-adapter/../application/test/dsh-connection-coordinator.spec.ts` 新增
  超时分类测试，修复前最后状态为 `starting`（红），修复后为 `failed`/retryable=true（绿）。
- 审计记录：`CheckpointStore.restore` 冲突 abort 时把 manifest 标记为 `stale` 并永久拒绝后续 restore
  是被 `checkpoint-store.spec.ts` 显式锁定的保守设计（冲突后保留外部编辑），不作为缺陷修改。
- 门禁状态：全量 `test` 730 测试中除既知 6 个预存前端失败外全部通过；typecheck/lint/format 通过。

## 2026-08-30 backend review batch G evidence

- CN-06（alpha 传输资源释放）：alpha transport 的 `post()` 与 `downloadSessionLog()` 此前在非 2xx 时
  直接丢弃响应体，与 loopback 客户端已修复的同类问题一致；`withRetry` 对幂等方法的 5xx 重试会按次
  占住回环 socket。现在两处抛错前先 `body.cancel()` 释放连接。红绿证据：
  `packages/dsh-adapter/test/alpha-contract.spec.ts` 新增 RPC+导出双断言测试，修复前 cancel 计数 0（红），
  修复后为 2（绿）。
- CP-01（partial restore 存储回收）：显式 `allow-partial` 的部分恢复是终态（`restoreAllowed` 永久为
  false），但此前 unlike committed/rolled-back 路径，未调用 `cleanupJournal`，每个已恢复文件的
  `backup-*.bin` 与 `journal.json` 永久残留；配额统计只计 `manifest.totalBytes`，该占用不可见且无界
  增长。回滚不完整（崩溃取证）路径的保留保持不变，因为那里的 backup 是恢复前字节的唯一记录。
  红绿证据：`apps/extension/src/checkpoints/checkpoint-store.spec.ts` 新增回收断言，修复前 journal
  残留（红），修复后无 `backup-*.bin`/`journal.json` 残留（绿）。
- 审计记录（不改）：`Rc6InteractionRepository` 对并发提交按 rpcId 折叠、"先到者胜"是被
  `interaction-repository.spec.ts` 锁定的设计（保证审批永不多发）；alpha `watchSession` 的惰性重看
  是 `events.ts` 注释明示的既有设计。change-set-tracker 每工具事件的 `sessions.get()` RPC 放大
  属效率优化候选，未在本轮改动。
- 门禁状态：全量 `test` 732 测试中除既知 6 个预存前端失败外全部通过；typecheck/lint/format 通过。

## 2026-08-30 backend review batch H evidence

- RV-01（变更采集效率）：`ChangeSetTracker.observeBackendEvent` 此前对每个 `tool.updated` 事件都在
  seen-events 去重之前 await `resolveSessionWorkspaceFolderId`，而该解析走完整的
  `sessions.get()`（`session.list` + `session.history`，必要时还有 `workspace.list`）。活跃 turn 的
  工具事件流因此被放大为每事件 2–3 个 RPC。现在按附件周期缓存每个会话的解析结果（attach/detach 清空；
  解析失败或不可归属的会话在下一事件重试）。红绿证据：
  `apps/extension/src/changes/change-set-tracker.spec.ts` 新增同会话 3 事件仅解析 1 次、重新 attach
  后重新解析的断言，修复前 3 次（红），修复后 1 次再 2 次（绿）。
- TC-01（任务中心作用域）：`TaskCenterRegistry` 的类契约是"当前会话任务投影"，但 `get()` 此前从
  `entries` 缓存返回任意会话的任务，`stop()`/`answer()` 由此可对用户已切换离开的会话执行
  `sessions.cancel` 或应答交互（entries 的裁剪谓词只按当前会话删除，前一会话的条目被保留）。现在
  `get()` 按当前会话作用域（含 `session:<id>` 子任务谓词，与 list 的裁剪一致）校验缓存条目，越界
  返回 `TASK_NOT_OWNED`；`stop()`/`answer()` 经 `get()` 传递性获得作用域。红绿证据：
  `apps/extension/src/tasks/task-center-registry.spec.ts` 新增切换会话后的拒绝断言，修复前
  `get` 解析出陈旧任务且 `stop` 会调用 cancel（红），修复后两个调用均拒绝且 cancel 未被调用（绿）。
- 审计记录（不改）：`NavigationService.openDiff` 的 `after` 参数目前无生产调用方（staged 路由，
  注释已声明临时实现），其静默忽略不构成用户可见缺陷；alpha `watchSession` 的按需创建为
  `events.ts` 注释明示的设计，仅保留其与 `session.removed` 的对称清理（batch E 已修）。
- 门禁状态：全量 `test` 734 测试中除既知 6 个预存前端失败外全部通过；typecheck/lint/format 通过。

## 2026-08-30 backend review batch I evidence

- PL-01（goal 缓存并发一致性）：`Rc6GoalRepository` 的 `remember()` 由 mux 观察者同步写 `goalCache`，
  而 `list()` 的历史回填在多个 await 完成后无条件覆盖缓存——回填期间到达的 `goal.updated`/
  `session.projection` 事件状态被陈旧的历史数据（可能为空）覆盖，且无补偿事件，直到下一次目标变更
  或重订阅前投影一直错误。现在回填仅在缓存仍为空时写入，且返回缓存中较新的状态。同理 `create()`
  在 host 的 `goal.updated` 事件先于 HTTP 回执到达（mux 与 HTTP 无顺序保证）时会向缓存追加重复行，
  现在按 goal id 去重、保留事件投递的 host 权威版本。
  红绿证据：`packages/dsh-adapter/test/goal-repository.spec.ts` 新增两例，修复前
  `expected [] to deeply equal [goal-live]` 与重复行（红），修复后返回 live 状态且无重复（绿）。
- CN-06（alpha 接收队列上限）：alpha `AsyncQueue` 此前无界缓冲，而 rc.6 传输对同类场景（消费方在
  read loop 内 await 历史恢复时 host 持续推送 mid-turn delta 帧）以 256 帧上限 + `PROTOCOL_ERROR`
  失败该流并触发重连/重新快照。现在 alpha 逻辑流队列采用相同的 `RECEIVE_QUEUE_LIMIT = 256` 上限，
  溢出时清空缓冲并以同语义错误失败该逻辑流（共享 socket 与其他逻辑流不受影响）。
  红绿证据：`packages/dsh-adapter/test/alpha-contract.spec.ts` 新增 session/follow 溢出测试，修复前
  300 帧全部缓冲且 next() 正常返回（红），修复后拒绝并携带 `PROTOCOL_ERROR`/retryable=true（绿）。
- 门禁状态：全量 `test` 737 测试中除既知 6 个预存前端失败外全部通过；typecheck/lint/format 通过。

## 2026-08-30 backend review batch J evidence

- PL-01（goal OCC 令牌新鲜度）：`Rc6GoalRepository.remember()` 消费 live `session.projection`/`session.subscribed`
  更新 `goalCache`，但不更新 refs 的 `{id, revision}` 对（`rememberProjectionRefs` 此前只在 `list()` 的
  历史回填路径调用）。goal edit/complete/resume/pause 是按 revision 的 compare-and-swap，令牌陈旧时
  发送的是历史回填时刻的 revision 而非 host 已确认的最新值。现在 remember 的两个投影分支同步 harvest
  refs，令牌与缓存视图保持同等新鲜；投影缺失 revision 字段时 harvest 为无操作（与既有 list 行为一致）。
  红绿证据：`packages/dsh-adapter/test/goal-repository.spec.ts` 新增 OCC 断言，修复前 `goal.edit`
  发送 revision 5（红），修复后发送 live 投影的 7（绿）。
- SA-01（subagent 并发刷新竞态）：`Rc6SubagentRepository.list()` 对 `addresses` 路由表的提交按响应
  解决顺序生效——同一父会话的两个并发刷新中，较旧的响应后解决会删除较新 catalog 刚路由的子代理或
  回退其 mode，直到下一次刷新前 follow-up/interrupt 报 `CAPABILITY_UNAVAILABLE`。现在按父会话维护
  刷新代计数，过期代仅返回其时间点视图而不触碰路由表。
  红绿证据：`packages/dsh-adapter/test/subagent-repository.spec.ts` 新增旧响应后提交测试，修复前
  `send` 报 `CAPABILITY_UNAVAILABLE`（红），修复后正常路由 `subagent.prompt`（绿）。
- 审计记录（不改）：alpha jobs/queue 状态在 per-session 重订阅时按 rc.6 语义清空、而 alpha 的
  session/follow 快照不携带该基线——是否需要 alpha 专用仓储行为取决于未发布 alpha host 是否在其他
  通道补偿推送，缺乏上游证据前不改动；`walkHistoryPages` 以映射条目数组索引兜底 `beforeSeq` 仅影响
  历史行缺失 `seq` 的 rc.6 时代 host，该 host 形状未获证实。
- 门禁状态：全量 `test` 739 测试中除既知 6 个预存前端失败外全部通过；typecheck/lint/format 通过。

## 2026-08-30 backend review batch K evidence

- IN-02（并发入队防重）：`Rc6SessionRepository.enqueuePrompt` 的 `pendingQueueIdentities` 防重闸门此前
  在 `session.prompt` 网络往返之后才注册——并发相同入队在该窗口内看到闸门为空并发送第二个
  `session.prompt`，用户提示词被排队两次。现在共享身份 promise 在 RPC 发起前注册，失败路径立即
  settle（并发等待者按既有语义自行重试），late-identity 等待与 30s grace 行为保持不变。
  红绿证据：`packages/dsh-adapter/test/session-repository.spec.ts` 新增并发同文入队断言，修复前
  2 个 RPC（红），修复后 1 个且两者获得同一队列身份（绿）；既有 late-identity/重试测试保持通过。
- ST-01（settings 冲突重试）：`settings.mutate` 是按 revision 的 compare-and-swap；host 以可重试的
  `settings-conflict`（`BACKEND_BUSY`，"reload and retry"）拒绝后，仓储的缓存描述此前不失效，
  被邀请的重试会重新发送同一个被拒绝的 `expectedRevision` 并确定性再次失败（红测试复现
  `expected 1 to be 2`）。现在 `update`/`unset` 的 mutate 失败即逐出缓存描述，重试重新 describe
  并携带 host 当前 revision（`replace` 走 `describe()` 本就新鲜，无需改动）。
  红绿证据：`packages/dsh-adapter/test/settings-repository.spec.ts` 新增冲突重试断言（绿）。
- 审计记录（不改）：session.list 的 `nextCursor` 转发与 cursor 拒绝在 pinned 上游契约下均不可达
  （响应类型无 `nextCursor` 字段，`cursor` 为"预留席位，v1 未实现"），不构成用户可见缺陷；
  composition-root 清洗器剥离 `commandLine` 的影响以 host 实际发送该字段为前提（rc.6 通常省略），
  且涉及安全边界放宽，未获运行证据前不改动。
- 门禁状态：全量 `test` 741 测试中除既知 6 个预存前端失败外全部通过；typecheck/lint/format 通过。

## 2026-08-30 backend review batch L evidence

- IN-02（queue 帧降级语义）：rc.6 mapper 对畸形的 `session/queue` 帧（`items` 非数组或缺失）此前
  静默映射为空队列，`Rc6SessionRepository.remember()` 随之清空队列与全部 queue-owner 条目，而 host
  仍持有这些条目——后续 `session.queue.update/remove/steer` 全部 `STALE_INTERACTION`。同类的
  `session/jobs` 帧早已 fail-closed（mapper 抛错 → 帧降级为脱敏 unknown 事件 → 保留最后已知状态）。
  现在 `session/queue` 对 `items` 非数组同样抛错，与 jobs 语义对齐。
  红绿证据：`packages/dsh-adapter/test/rc6-contract.spec.ts` 新增两条抛错断言，修复前静默通过（红），
  修复后按 `/Malformed session\/queue items/` 抛出（绿）。
- IN-02（入队失败重试路径回归锁定）：为 batch K 的 enqueuePrompt 修复补充失败路径测试——首个尝试
  被 host 拒绝（receipt `ok:false`）时，共享身份 promise 立即 settle，并发等待者回退并发送自己的
  `session.prompt` 而不是在 grace 窗口内挂起；host 接受后经 `session/queue` 事件交付队列身份。
  测试证据：`session-repository.spec.ts` 新增失败重试路径（2 个 RPC、第二个获得 `rpc-2` 的队列身份）。
- 审计记录（不改）：`replace()` 走 `describe()` 直接重取（无缓存读取），不存在 batch K 的陈旧
  revision 重放路径（探索代理候选经验证排除）；`messageFeedback/delete` 的冷缓存 no-op 修复依赖
  上游 delete 对 `ifVersion: null` 的接受度（put 有 `?? null` 先例但 delete 侧未证实），且可达性
  未确认，维持现状并记录；`queuedInput` 逐条丢弃与上游帧 schema 的约束范围有关，全丢弃场景的
  语义权衡缺乏上游证据，不扩大 fail-closed 范围。
- 门禁状态：全量 `test` 743 测试中除既知 6 个预存前端失败外全部通过；typecheck/lint/format 通过。

## 2026-08-30 backend review batch M evidence（搁置候选上游源码级交叉复核）

本轮对四项搁置候选逐一核对上游源码（rc.6 固定提交 `47f9438`、rc.8 tag `dsh-v0.1.0-rc.8`、alpha.1
固定提交 `cd5ef814` 与 pinned npm `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2` /
`@deepseek-ai/dsh-message-feedback` 类型），两项获证据支持并完成红→绿修复，两项证据不支持修复并
记录边界。batch J/L 中对应的两条"不改"审计记录由本节结论取代。

- JB-01（alpha 重订阅清空 control 流基线，修复）：alpha 的 jobs/queue 只由 `session/control` 流
  承载——`control(signal)` 在每个流代建立时 yield 一次完整 `baseline`（queues/jobs/projections，
  `packages/api/session-controller/src/control.ts`），之后仅变更增量；而 `session/follow` 快照只含
  `{header, cursor, records, hasMore, projections}`（`packages/api/session-controller/src/history.ts`）。
  alpha 装配复用的 `Rc6JobRepository`/`Rc6SessionRepository` 却按 rc.6 mux 语义在 `session.subscribed`
  时清空 jobs/queue（rc.6 家族正确：mux 在订阅时重发 queue 快照、jobs "absent key means an empty
  set"）。结果是首次 watch 与每次 follow 重连都会清空 control 流已基线的数据，直到下一次无关变更
  增量或 control 流整体重连前一直 stale-empty。现在两个仓储各自增加显式选项
  （`resetOnSubscribe` / `resetQueueOnSubscribe`，默认 `true` 保持 rc.6 语义），alpha 装配传 `false`，
  版本差异收敛在 `versions/alpha/adapter.ts`，不在共享仓储中散落版本判断。
  红绿证据：`packages/dsh-adapter/test/alpha-contract.spec.ts` 新增 adapter 级测试（经 FakeWebSocket
  驱动 `$events`/`session/control`/`workspace/follow` 三条逻辑流注入 control baseline，再 `watchSession`
  注入 follow snapshot），修复前 `jobs.list`/`listQueue` 在 subscribed 后变空（红），修复后保持
  baseline 数据（绿）；rc.6 默认路径既有语义测试全部保持通过。
- FB-01（messageFeedback/delete 冷缓存静默 no-op，修复）：上游 delete 契约是按 item 的 CAS——
  `MessageFeedbackDeleteRequest.ifVersion` 为必填的"Observed item version; ignored when the item is
  already absent"，"Absence is successful regardless of the supplied version; an existing item
  requires an exact version match"（pinned `dsh-message-feedback` 类型与 rc.8 sidecar 设计笔记
  "An already-absent delete is likewise successful"）。此前冷缓存（该 repository 实例未 list/put 过
  该 session:message，如 Extension Host 重建后）的 `remove()` 直接 return，UI 报告删除成功而远端
  条目原样保留——静默分叉；且版本 token 不可伪造/排序，`null` 不是 delete 的合法入参（batch L 审计
  假设的 `ifVersion: null` 接受度被上游类型否定）。现在冷缓存先以唯一可用读 `messageFeedback/list`
  观察：条目缺席即后成立返回（与上游"已缺席删除成功"语义一致），命中则携带观察到的版本 CAS 删除。
  红绿证据：`packages/dsh-adapter/test/feedback-reference-repositories.spec.ts` 新增两例——冷缓存
  先 list 后按 `ifVersion: 'v7'` delete（修复前 0 个 RPC，红）、观察到缺席时跳过 delete
  （修复前连 list 都不发，红）；修复后均绿。
- FB-02（version-conflict 丢弃权威 current，修复）：上游冲突响应携带
  `MessageFeedbackVersionConflict.current: MessageFeedbackItem | null`（"Authoritative current item,
  or null when it does not exist"，"so callers can reconcile without a second read"）。此前
  `readBusinessValue` 把 `error.current` 直接丢弃并抛 `BACKEND_BUSY`（retryable），但被邀请的重试
  仍携带同一过期版本，确定性再次冲突。现在 put/delete 的冲突路径先以 `current` 刷新版本缓存再抛错，
  被邀请的重试即 CAS 有效。
  红绿证据：同文件新增一例——首次 put 冲突（`current` 携带 v9）后，第二次 put 必须携带
  `ifVersion: 'v9'` 才被接受；修复前第二次 put 重发 `ifVersion: null` 再次被拒（红），修复后返回
  权威条目（绿）。
- 审计记录（复核结论，不改）：composition-root 清洗器剥离 `commandLine` —— rc.6 `approval/requested`
  MuxFrame 全字段为 `{type, sessionId, approvalId, toolName, callId?, reason?}`（rc.6
  `events.ts`/`approvals.ts`/`approvals.schema.ts`，rc.2 pinned 树 grep `commandLine` 零命中），官方
  审批面板的命令行经 `callId` 配对到正在运行的 tool call（`ApprovalPanel.tsx` 的 `commandOf(call)`
  读取 bash 族 `args.command`），不从审批帧携带。因此 mapper 中有界的 `commandLine` 提取对固定契约
  是永不触发的防御代码，清洗器剥离对审批链路无实际影响，而对进程发现链路（`DshProcessInfo.commandLine`
  携带本机可执行路径）是必需的安全剥离；官方 callId 配对命令展示属功能增强而非缺陷修复，未纳入。
  `queuedInput` 逐条丢弃 —— 上游 `QueuedInboxItem = {id: MessageId, placement: 'queued'|'steering'|
'context', message: Message}` 三字段全必填；对合法帧唯一被丢弃的是 `placement: 'context'`，官方
  语义即"context items stay invisible until claimed"，丢弃与官方渲染对齐（域 `QueuedInput` 仅
  queue|steer，无法表示）；对违约畸形条目，数组级 fail-closed 已于 batch L 建立，逐条策略差异
  （jobs 抛错 vs queue 丢弃）在上游 schema 保证字段存在的前提下构造不出用户可见缺陷，不扩大。
- 门禁状态：全量 `test` 747 测试中除既知 6 个预存前端失败外全部通过（新增 4 例全绿）；typecheck
  9 包 + tests tsconfig 通过；`pnpm build` 通过。`pnpm format:check`/`pnpm lint` 存在前端流提交
  `d70dcdf` 带入的 16 个 prettier 违规与 6 个 eslint 错误、1 个警告，全部位于 `apps/webview`、
  `apps/extension/src/editor/editor-context-provider.ts`、`packages/application/src/ports/feature-ports.ts`
  等前端流文件，后端本批触碰文件均干净，按"不修改前端"纪律本批不处理。

## 2026-08-30 backend review batch N evidence

- IN-01（alpha 重订阅清空 pending 审批/问题，修复）：`Rc6InteractionRepository.remember` 对
  `session.subscribed` 擦除该会话全部 pending permissions/questions。该语义源于 rc.6 mux 的刷新
  恢复基线——mux 打开时对每个 attached session 先发 subscribed 再**重放**仍 pending 的
  approval/question requested 帧（rpcId 原样复用，rc.6 `events.ts` 头注），擦除后由重放重新注册。
  alpha 则按官方 remote-event 契约"Approval and Question use Agent-scoped waterfall"（remote-event
  delivery 设计笔记）经 `$events` 载体投递，且 `session/follow` 快照不含任何审批/问题基线：首次
  watch 或 follow 重连触发的 subscribed 之后没有任何重放，pending 审批被擦除后
  `respondToPermission` 永远 `STALE_INTERACTION`，而 host 侧 waterfall 仍在等待应答。现在仓储增加
  显式选项 `resetPendingOnSubscribe`（默认 `true` 保持 rc.6 重放语义），alpha 装配传 `false`；
  alpha 的条目清理仍由 `permission.resolved`/`question.resolved`（经 `$events` 独立到达）完成。
  红绿证据：`packages/dsh-adapter/test/alpha-contract.spec.ts` 新增 adapter 级测试——`$events`
  waterfall 注入 `approval/request`（eventId `evt-1`）→ `watchSession` 注入 follow snapshot 触发
  subscribed → `respondToPermission('evt-1', 'allowed-once')`；修复前拒绝 `STALE_INTERACTION`（红），
  修复后经 `$events/result` 正常提交（绿）；rc.6 默认语义既有测试全部保持通过。
- 门禁状态：全量 `test` 748 测试中除既知 6 个预存前端失败外全部通过；typecheck 9 包通过；
  触碰文件 prettier 干净。

## 2026-08-30 backend review batch O evidence

- EV-01（序号缺口恢复只读尾页，修复）：rc.6 与 alpha 两个 adapter 给 `DshStreamController` 的恢复
  回调此前都经 `sessions.get()` 取 `detail.history` —— 该字段只含**最新一页**（固定 50 条/页，
  `HISTORY_PAGE_MESSAGES`）。重连缺口宽于一页时（休眠唤醒、长 turn 产生数百 chunk 事件等），
  较旧页的事件不可达：`recoverRange` 只能交付尾页命中的部分，剩余破洞经 `session.gap` 显式宣告，
  而 `session.gap` 在 application/webview 无任何消费者——对话留下永久空洞且无任何用户可见信号。
  这违反 dsh-contract.md 自身的事件恢复契约（"通过历史 RPC 补齐缺口"）。现在新增共享工厂
  `historyGapRecovery(sessions)`：从缺口末端（`toSequence + 1`，排他语义）起向后走 `session.history`
  分页（复用 `walkHistoryPages`，新增 `initialBeforeSequence` 起始锚），直到某页最老序号 ≤ 缺口起点
  或日志耗尽；`recoverRange` 对仍不可达的残余（host 侧截断/清理）照旧宣告 `session.gap`。两个
  adapter 的内联尾页回调统一替换为该工厂；顺带消除 `sessions.get()` 的多余重载（registry 提示 +
  workspace 快照 + fallback 汇总在恢复路径上均为副作用）。
  红绿证据：`packages/dsh-adapter/test/gap-recovery.spec.ts` 新增 adapter 级测试——经 fetch mock
  （分页 `session.history`：尾页 21..70、第二页 1..20）与 fake WebSocket 注入 mux 帧，水位 10 直接
  跳到 70；修复前只交付 21..69，11..20 仅以 `session.gap` 宣告（红），修复后 11..69 全部从两页
  历史补齐且无 `session.gap`（绿）。rc.6 与 alpha 共用同一工厂，行为一致。
- 审计记录（本轮扫描覆盖面，不改）：`credential-repository`（`credentials.set/unset` 回执与
  `RpcResponse<{}>` 逐字段吻合、describe/幂等 unset 语义一致）、`workspace-repository`（list/create/
  rename/delete/insertBefore/insertSessionBefore/archiveSession 响应形状与 rc.2 pinned
  `workspace.d.ts` 逐一吻合，含 `workspace-name-conflict` 容忍与幂等 adoption）、`model-repository`
  （catalog/failure/discovered 校验严密、credential 批量 describe 分批 64）、`skill-repository`、
  `plugin-repository`（只读、`null` fiberPhase 保留）、`preset-repository`、`backend-service`（attach
  重放/去重键设计）、`advanced-agent-use-cases`（能力探测委托）——均未发现可红测试复现的真实缺陷；
  rc.6 RPC 错误映射对未识别上游码落入 `PROTOCOL_ERROR` 属保守降级策略，保留。
- 门禁状态：全量 `test` 749 测试中除既知 6 个预存前端失败外全部通过；typecheck 9 包 + tests
  tsconfig 通过；`pnpm build` 通过；触碰文件 prettier 干净。

## 2026-08-30 backend review batch P evidence（stream-controller 生命周期 / view 路由审计）

- 审计记录（本轮扫描覆盖面，不改）：`stream-controller` 剩余路径——subscribe 重入与 stranded
  subscriber 重启（unsubscribe 触发的 abort 期间新订阅者由 finally 检测重启，自然失败走 backoff，
  防止 down host 热循环）、`scheduleReconnect` 的 `this.lifetime !== lifetime` 陈旧代次守卫、
  `runGeneration` 的 `Promise.allSettled(tasks)` 防止慢旧读者与下一代重叠发布陈旧事件、close 与
  重连计时器互斥、`session.subscribed` 三分支（基线上行恢复/下行跟随/相等幂等）与投影水位截断、
  `retryAttempt` 在首个帧/订阅/每个有序事件三处重置——均与既有红绿测试对应，无新缺陷。
  `view/message-router`：请求预算前置检查、双信封 schema 判别、requestId 单飞去重、cancel 的
  `completed/accepted` 诚实状态、`complete()` 幂等删除与 postMessage 传输失败兜底、`response()`
  超预算回退为受限 PROTOCOL_ERROR、非 AppError 失败归一为 INTERNAL_ERROR 并旁路脱敏诊断——
  `!ok` 分支的 `schema.parse(candidate)` 重抛在公开错误消息全部有界的构造下不可达。配套
  `dsh-webview-view-provider` 的 dispose/重建监听生命周期与 `onMessage` 未处理拒绝吸收正确。
  `webview-protocol` 的 `protocolValueWithinBudget`（节点数/深度/字符串总量/环引用，WeakSet 去重
  对 JSON 可达载荷无假阳性）、`temporary-workspace`（受管路径约束、单飞、失败清理、引用失效即清除）、
  `feature-capabilities` 分级门控、rc.6 `withRetry` 仅对 15 个幂等读重试且 abort 优先——均无新缺陷。
- 门禁状态：本轮为纯审计（无代码改动），门禁沿用 batch O 提交 `1f0de27` 的全绿结果。

## 2026-08-30 backend review batch Q evidence（runtime/shim 与扩展本地能力审计）

- 审计记录（本轮扫描覆盖面，不改）：`backend/windows-shim.ts`——npm `.cmd` shim 的静态解析
  （自底向上取最后一个可解析 `.js` 引用、`SET` 行跳过、`FOR /F` 动态值经 `%%` 检测跳过并保留首个
  静态可解析赋值、`%~dp0`/变量展开的 seen-set 环防护）与 node 查找三级回退（shim 同目录 node.exe →
  Extension Host 可执行仅当确为 Node → PATH → `node.exe` 直名），全程无 shell，符合子进程红线。
  `backend/runtime-locator.ts`——configured 存在即采纳（不兼容也如实上报，不静默换 PATH 二进制）、
  npm 前端探测仅在 configured/PATH 未命中时发生、候 select 去重（Windows 大小写不敏感）、探针 3s
  超时并取消底层执行、超时与取消错误分类保留、`findSupported` 记录"仅存在候选"供诊断。
  `attachments/attachment-store.ts`——容量/10 分钟过期/魔数校验（PNG/JPEG/GIF/WebP）/canonical
  Base64 边界。`prompts/prompt-template-store.ts`——索引 checksum 写读对称（`decodeIndex` 确实校验
  sha256，键序固定）、body 完整性失败自动 disable、原子写 + 失败清理、create/update/delete 回滚路径
  （update 的 oldBody 回写在同 hash 场景等价）、所有权/信任边界、重复 id 即 STORAGE_CORRUPT。
  `navigation/navigation-service.ts`——WorkspacePathGuard 解析 + 规则文件断言 + 打开后 range 校验。
  `commands/register-commands.ts`（30 行注册）无逻辑面。均未发现可红测试复现的真实缺陷。
- 门禁状态：本轮为纯审计（无代码改动），门禁沿用 batch O 提交 `1f0de27` 的全绿结果。

## rc.8 适配增量与兼容证据

- 版本层：`versions/rc6`、`versions/rc7`、`versions/rc8` 与受控兼容探测；运行时定位允许任何非空未知版本标签，Probe 按显式优先级选择最新可安全复用 wire 的 Adapter，保留真实版本、Adapter 身份并把警告安全传给 Webview。
- 契约层：rc.8 `host.describe.home` 的增量字段、`imageLimits`（含 `maxImageDimension`）投影、`assistant/message.interrupted` 和 Agent Teams 四类 durable event 已有 mapper、reducer、UI 和契约测试；新增 `messageFeedback/list|put|delete`、`fileReferences/list`、`sessionReferenceResolver/candidates`、动态命令 `input.images`、命令 `result.kind`、mutation `locations` 的 Host 适配和 Webview 投影；旧版本缺少这些字段时按可选/unknown 降级。
- WebUI 增量覆盖：消息反馈（评级、备注、删除）、`@` 文件/会话候选（文件优先、目录续写、引用会话 opaque mention）、图片斜杠命令（Host-only opaque attachment handles）以及产出文件 chips/唯一反引号文件提及均已接通。当前仍将 DSH optional sidecar 的缺失能力按空结果或 `CAPABILITY_UNAVAILABLE` 处理，不向模型伪造功能。
- 当前自动证据：`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test` 通过（66 个测试文件、517 个测试），`pnpm build` 通过；新增 `packages/dsh-adapter/test/tool-presentation.spec.ts`、`packages/ui/src/tool-renderer-registry.spec.ts` 和 `packages/ui/src/tool-row.spec.ts` 结构化工具回归，连同 `Timeline.spec.tsx` 覆盖 rc.6/rc.7/rc.8、未知版本、降级路径、历史分页、生命周期序号边界、presentation 空行/截断/敏感字段和 Host-only 文件打开委托。真实 smoke 已在隔离临时 DSH_HOME 启动本地 `dsh web --port 3939`：CLI 为 `0.1.0-rc.8`，`host.describe` 返回 `ok=true`、`home` 存在且 `canOpenPath=true`。随后使用实际 rc.8 `dsh web --port 3940` 做了真实实时链路回归：工具场景收到 747 个正文增量、58 个思考增量和 `read` 工具的 running/completed 事件，修复后的时间线保留 3,493 字正文、679 字思考并完成 turn；长文本场景收到 1,170 个正文增量、275 个思考增量，保留 4,605 字正文、3,014 字思考和末尾标记；最新真实 rc.8 历史链路通过 `host.describe`、真实会话创建、`session.history` 尾页与 `beforeSeq=0` 请求，Adapter 得到 6 个尾部事件、`hasMore=false`、合法空前页；本批次另以真实 rc.8 会话发送中文 skill 请求并读取 18 条历史事件，确认 `skill.list` 目录实际可用，模型调用因隔离实例没有凭据产生真实 `MISSING_CREDENTIAL` 错误，不将其冒充工具成功；随后以真实 rc.8 Web Host + 真实 `session.prompt/session.history` 驱动本机回环 OpenAI-compatible SSE，实际执行 `read(file_path=README.md, offset=1, limit=3)`，history 返回 `tool/call`/`tool/result` 及外层 `{ event, view }` 的 `read` 卡片，真实行内容为 `# DeepSeek Harness for VS Code`、空行和 `> DSH，始终在你的代码旁边。<br>`，最终助手输出 `REAL-VIEW-CHECK`。上述证据覆盖 DSH → Adapter → Timeline，但尚未完成真实浏览器 DOM/VS Code Webview 回放、外部凭据会话和官方 catalog fixture，因此能力仍标为 `PARTIAL`。

## 0.1.1-rc.1 适配增量与兼容证据

- 上游依据：DSH `dsh-v0.1.1-rc.1`，提交 `528c682e06`。`rpc-map.ts` 与 `events.ts` 没有新增 RPC/Event 名称；本版本的实际 wire 增量是 `session.create` 的 `sessionId` 与 `reuseWorkspaceBlank` 字段，以及对应的官方 WebUI 空白会话复用条件。
- 版本层：新增 `packages/dsh-adapter/src/versions/rc11`，依赖固定到 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.1`。rc.6/rc.7/rc.8 继续走原有 Adapter；未知非空版本按最新可安全复用 wire 的 Adapter 优先进行兼容探测，不发送 rc.1 专有字段。
- 会话层：只在工作区成员、cwd 与工作区路径精确相等、会话为空白且未归档四项条件同时满足时复用；rc.1 通过上游 `session.create` 字段复用，rc.2 按官方 WebUI 行为在 Webview 本地打开匹配会话，显式 preset 或旧版本不触发复用。启动恢复也会优先选择已有运行中/可继续会话，再选择最近的非空会话，避免已有空白根会话被误判为“没有会话”。
- WebUI 增量：缓存命中率与计费输入按上游四 bucket 计算；终止错误在重试耗尽后保留独立错误行；问题输入框限制六行；宽表格按列数获得横向滚动；空白新会话按当前工作区置顶；设置页同时接受 rc.1 的 `credentials/reference-updated`、`llm/adapters-updated`、`settings/document-updated` 和 rc.6–rc.8 的 `credentials/updated`；Provider 编辑器保留 `inputModalities` 等未来模型字段，不因无关编辑覆盖它们。
- 子代理与边界：本地已提供可展开的直接/嵌套子代理树、token/耗时指标、lineage 导航、加载失败行和视口夹紧；官方 `SubagentHeaderLineage` 的 slot 级头部布局与本地现有标题栏/抽屉不是同一 DOM 结构，因此只记为行为等价，不标为 1:1 完成。rc.1 新增的授权/登录流程属于 DSH 内部 authorization 包，当前公共 loopback RPC 没有对应入口，扩展不猜测 RPC；视觉模型的未知字段可保留并通过既有图片附件链路传输。
- 错误层：`turn/end` 的 `reason.kind=error` 现在以限长、脱敏的 code/message 贯穿 Adapter、Domain、Timeline 与 Webview；畸形错误仍回退为通用终止原因。上游 `model-unavailable` 映射为配置错误而不是认证错误，避免统一错误文案掩盖真实原因。
- 自动证据：rc.1 相关定向回归（设置字段保留、旧/新凭据事件、session.create 复用、子代理指标/lineage、错误/统计/输入/表格路径）已通过；本轮全量 `pnpm test` 为 66 个测试文件、517 个测试，`pnpm typecheck` 与 `pnpm build` 通过。此前已用单个隔离的 rc.1 DSH 实例取得真实 `session.create`（含 `workspaceId`、`sessionId`、`reuseWorkspaceBlank:true`）返回同一会话的链路证据；本轮按要求没有再次启动 DSH。仍缺真实 VS Code Webview DOM 回放、外部凭据会话，以及将本地子代理布局改成官方 slot 的 1:1 结构，因此相关能力保持 `PARTIAL`。

## 0.1.1-rc.2 适配增量与兼容证据

- 上游依据：DSH `0.1.1-rc.2`，提交 `b150a551b8`。`rpc-map.ts` 与 `events.ts` 没有新增公共 RPC/Event 名称；rc.2 的可见 wire 变化是 `session.create` 删除了 rc.1 专用的 `reuseWorkspaceBlank`，同时保留 `sessionId` 的幂等创建语义；官方 WebUI 同时把匹配空白会话的复用移到了客户端本地。
- 版本层：新增 `packages/dsh-adapter/src/versions/rc12`，依赖固定到 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`。rc.1 继续由 rc11 Adapter 发送完整空白会话复用字段；rc.2 在匹配到官方条件时由 Webview 直接 `session.open`，否则只使用不含 `reuseWorkspaceBlank` 的创建请求；rc.6–rc.8 与未知版本的最新可安全复用 wire Adapter 优先兼容探测路径保持独立。
- 上游内部增量：rc.2 的图片规范化、DeepSeek Files 上传/受限内联回退和 `read-image` 行为属于 DSH/provider 内部实现；由于没有新的 loopback RPC/Event，插件继续通过既有附件、结构化工具事件和通用 presentation 映射承载，未复制内部实现或凭空增加协议。插件已将 rc.2 的 20 MiB 单图/200 MiB 单消息图片输入边界贯通 Webview 预检、Host ingest/pick/open-file、Adapter prompt 和历史附件读取；rc.6–rc.8/未知版本保留 8 MiB/100 MiB 保守边界。
- 自动证据：已加入 rc.2 版本选择、旧版本不误认、rc.2 `session.create` 不发送 `reuseWorkspaceBlank`、匹配空白会话改为本地 `session.open`、图片边界按版本放宽的契约回归；本轮改动后的全量门禁结果以交付命令输出为准。此前使用实际全局 `@deepseek-ai/dsh@0.1.1-rc.2` 启动单个隔离 smoke 实例，真实 `host.describe` 返回 `ok=true`、`home` 和 `canOpenPath=true`，真实 `session.create({ agentPreset: "standard" })` 返回 `sessionId` 与 `agentPreset`；测试会话已归档，实例已停止。该 smoke 未调用模型，仍缺完整 rc.2 事件/附件/工具场景和 VS Code Webview DOM 回放，因此能力保持 `PARTIAL`。

## 0.1.2-alpha.1 源码预适配与证据边界（历史）

- 上游依据：源码 tag `dsh-v0.1.2-alpha.1`，提交 `cd5ef8148158c3a752a658978873241fdf8e2bbc`。该版本删除旧 `host-apiproxy`，以 `client-connection`/Gateway 的 `/api` 和 `/api/remote.mux` 取代；本地适配器保持独立，不改变已发布 rc.6–rc.2 路径。
- 传输层：新增 alpha Connection envelope、`{ args }` Remote 编码、严格 `rpcId`/result 校验、`remote.mux` open/cancel/item/error/end 生命周期和 Cookie 握手；launch token 只在 Extension Host 内换 Cookie，不进入 Webview。
- 能力层：覆盖上游当前公开的 Agent Preset、Commands、Credentials、Directory Picker、Goals、LLM、Message Feedback、File References、Session、Settings、Skills、Subagents 与 Workspace Remote，并将 durable Session chunk rows、Control/Projection、Workspace follow 和 event waterfall 映射到现有仓储/事件接口。
- 自动证据：`packages/dsh-adapter/test/alpha-contract.spec.ts` 已覆盖 HTTP envelope/path/Cookie、Session snapshot/chunk expansion、`$events/result` waterfall 和畸形响应；新增错误映射回归。alpha.1 尚未封包/发布，当前没有真实 alpha.1 DSH 可用于运行 smoke，故该历史适配保持 `PARTIAL`，不把源码对照冒充 live evidence。

## 0.1.2-alpha.2 适配与证据边界

- 上游依据：已发布 npm `@deepseek-ai/dsh@0.1.2-alpha.2`、tag `dsh-v0.1.2-alpha.2`，提交 `0a53fb55bea101816fa226bb964ae2bed71c343b`。alpha.2 保持 alpha.1 的 `/api` Connection、Cookie 握手、`remote.mux` 和 Web Profile `--no-open` 边界；本地新增 `versions/alpha2` 入口，不修改 rc.6–rc.2 和 alpha.1 的行为。
- 真实增量：上游把 Remote 错误放入 namespaced vocabulary；Session 事件支持 `ignorable: true`；`pluginInventory/list` 可选返回 agent-preset composition rows（含 `conditional` enablement 和 Fiber phase）。本地只在 alpha2 seam 做已声明 code 的兼容映射，未知 code 保留并 fail closed，Webview 只接收严格 DTO。
- 自动证据：`packages/dsh-adapter/test/alpha2-contract.spec.ts` 覆盖精确版本选择、HTTP/mux namespaced error、未知错误、可忽略事件和畸形标记；`plugin-repository.spec.ts` 与 `apps/webview/src/app/store-plugin.spec.ts` 覆盖 agent-preset 组合保留和畸形丢弃；运行时启动参数、PTC 环境和版本工厂也有回归。真实 alpha.2 DSH smoke 结果待交付验证，在完成前保持 `PARTIAL`。

## 2026-08-31 timeline/history rendering repair evidence

- CN-05/CN-06：alpha Gateway history snapshot 中的普通 event 与 packed chunk row 现在先按 durable `seq` 稳定排序，再交给 `DshStreamController` 的去重水位；`packages/dsh-adapter/test/alpha-contract.spec.ts` 用交错 seq=3 与 chunk seq=1/2 锁定了早期文本/工具记录不得被高水位误丢弃的行为。
- SS-01/CV-01：会话打开已把 history/configuration 首帧与慢速 queue/goal/job/catalog 读取解耦；首帧后到达的当前会话事件立即进入时间线，同时保留在打开队列供最终快照重放，过期/失败打开不会丢弃事件；history-only projection 也会触发正常通知。`store-startup.spec.ts`、`store-subagent.spec.ts` 覆盖首帧、工具实时更新和通知路径。
- CV-01：Timeline 虚拟化在 Webview 首帧尚未取得非零 viewport 时回退为普通流式布局，避免“任务面板仍在但聊天区空白”；工具尾记录的内容增长也进入统一的轻量进入动画。`Timeline.spec.tsx`、`useTailEntrance.spec.ts` 已有回归覆盖；宿主端本地轨迹快照重算链路已撤销；Trajectory 视图已恢复，仍待真实 DSH/Webview 回放验证。
- CV-01/AX-01（时间线动效 S5/S6）：动画计划 S5/S6 已按门控规则落地——只有追加到尾部的新行播放 `dsh-rise-in` 入场（类挂在行的子内容上，避免覆盖虚拟化行的定位 transform），首屏/会话切换/历史回填/流式输出期间均不播；`StreamingActivity` 图标呼吸、工具卡 running 状态点脉冲（queued/终态保持静态）、`ScrollToLatestButton` 经子元素入场（规避根元素 `translateX(-50%)` 冲突）；用户点击"跳到最新"走 `userScrollToLatest` 平滑滚动（Reduced Motion 硬跳、平滑期间 scroll 事件视为内部行为、手势可打断、到达终点复位标志），程序化跟随路径保持硬跳，TrajectoryView 等其他表面行为不变。自动证据：`useTailEntrance.spec.ts` 3 例（首屏/前插/重置/流式抑制）、`useScrollFollow.spec.tsx` 4 例（平滑、Reduced Motion 硬跳、中间事件不误触发、到点后恢复原语义）；真实 VS Code Webview 手工动效验收仍缺。
- 门禁边界：上述为自动化契约/组件证据，仍未完成真实 VS Code Webview 冷启动、切换和长会话 DOM 回放，因此 CN-05、CN-06、SS-01、CV-01 继续保持 `PARTIAL`，不把本地回归冒充为真实运行验证。

## 2026-08-31 timeline 缺项与"整段聊天不可见"修复证据

- CN-05/CN-06（接收队列溢出不再杀死流）：2026-08-30 batch I 确立的 alpha 队列"溢出即清空缓冲并
  fail 整个逻辑流"语义，在真实长回答中会级联为重连风暴并留下整轮静默空洞——溢出恰好发生在消费方于
  read loop 内等待历史恢复、host 持续推送 mid-turn delta 帧的时候。现在溢出只丢弃缓冲帧并保持流存活：
  丢弃转化为普通序号缺口，由缺口检测与历史恢复按既定路径补齐；`firstStreamItem` 等取首帧用途不受影响。
  红绿证据：`packages/dsh-adapter/test/alpha-contract.spec.ts` 溢出测试改写为存续契约——300 帧涌向
  已在 yield 处挂起的消费方后，next() 恢复并交付未缓冲的 `session/event`（修复前拒绝
  `PROTOCOL_ERROR`）。
- CN-05（缺口恢复移出 read loop）：`session.subscribed` 上行基线与 live 序号缺口此前在消费循环内
  await 历史恢复，正是触发上述队列溢出压力的根因。现在恢复按会话串行调度（检测顺序排队、后继等待
  前继完成）、完全脱离 read loop；恢复游标本地化（不再回写去重水位），恢复后仍不可达的残余以
  `session.gap` 显式宣告；无 recover 回调时同步宣告缺口。
  红绿证据：`packages/dsh-adapter/test/stream-controller.spec.ts` 新增 5 例——live 先行交付且水位不被
  恢复回退、恢复失败宣告整洞缺口、部分重放宣告残余缺口、无 recover 回调的同步缺口、按会话串行与
  close 中止。
- SS-01/CV-01（Webview 缺口自愈）：Webview 此前把 `session.gap` 降级为未知事件，既不提示也不自愈。
  现在 `session.gap` 解析为严格 DTO 并渲染去重后的缺口提示，同时触发有界的 `session.history`
  反向回填（每缺口范围 ≤4 页、每页 ≤200 条消息、仅限当前会话与当前 open 代），逐页合并进事件台账并
  重建时间线（进度式揭示）；回填进行中不渲染瞬时黄色提示，只有确认台账仍无法覆盖缺口时才保留提示，
  补齐成功撤下提示。乱序迟到事件（≤当前水位）经 16ms
  去抖的台账重建显示。
  红绿证据：`apps/webview/src/app/store-gap-heal.spec.ts` 新增 5 例——回填+自愈、失败保留提示、
  乱序重建、畸形缺口忽略、他会话缺口忽略。
- SS-01（session.open 有界重试）：`session.open` 请求失败时整个面板没有任何会话。现在关键 open 请求
  以 300ms 起步的指数退避重试至多 3 次；宿主以 `retryable: false` 拒绝的确定性失败立即上抛错误横幅；
  Webview 本地请求超时错误标记 `retryable: true`；重试等待期间被更新的 open 接管时停止重试并静默
  让位（与既有 stale-open 成功路径的静默语义一致）。
  红绿证据：`apps/webview/src/app/store-open-retry.spec.ts` 新增 4 例——瞬时失败重试后成功、确定性
  失败不重试、3 次耗尽上抛、stale 让位后不再补发旧会话请求。
- 门禁状态：`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`（110 文件 858 例全绿）、
  `pnpm build` 通过。真实 DSH 长回答 + 断连/追赶场景的现场复核仍未完成，CN-05、CN-06、SS-01、
  CV-01 继续保持 `PARTIAL`。

## 2026-08-31 对话字号设置证据

- UX-01/AX-01：General 设置新增本地 Webview UI 偏好“对话字体大小”，提供小/中/大三档；默认中，选择立即作用于活动对话区域（聊天、轨迹和输入区），并持久化到 Webview `localStorage`。偏好值不进入 DSH RPC、配置文件或 Host 日志；未知值和受限存储均安全回退。
- UX-01/AX-01（主题）：Appearance 的 `system` 保留 `@dsh-vscode/ui` 对 `--vscode-*` 变量的继承，显式 `light`/`dark` 只覆盖 Webview 自有 `--dsh-*` 语义变量，不重定义宿主颜色变量；旧兼容样式的颜色引用也统一走 DSH 语义变量。自动证据：`theme.spec.ts`、`ui-preferences.spec.ts`、`SettingsDrawer.spec.tsx` 和 `App.connected.spec.tsx`；真实 VS Code Webview 主题切换矩阵仍未完成，UX-01、AX-01 保持 `PARTIAL`。
- 自动证据：`apps/webview/src/app/ui-preferences.spec.ts` 覆盖默认/持久化、未知值和存储异常；`SettingsDrawer.spec.tsx` 覆盖设置控件与回调；`App.connected.spec.tsx` 覆盖已保存值恢复、选择后 DOM 作用域更新和持久化。语言/设置定向回归为 2 个文件、62 个测试全绿；全仓库回归为 117 个文件、920 个测试全绿；真实 VS Code Webview 冷启动/重载和视觉字号矩阵仍未完成，UX-01、AX-01 保持 `PARTIAL`。
- General 设置区块顺序固定为连接状态/操作、DSH 更新、扩展偏好、DSH 偏好、本地对话外观、配置文件入口，并由 `SettingsDrawer.spec.tsx` 的 DOM 顺序测试覆盖；语言控件在 DSH 未连接时仍可修改扩展界面，并在连接时写入同一 `locale.preference`。

## 2026-09-01 DSH alpha.3 上游同步证据

- CN-06：本地 DSH 仓库已从 rc.2 `b150a551b8` 快进至已发布 `dsh-v0.1.2-alpha.3`、提交
  `dd6322d604e00eec1ba5e0c8541159906a21094a`；npm `@deepseek-ai/dsh@0.1.2-alpha.3` 已安装并由
  `dsh --version` 验证。alpha.2 与 alpha.3 的上游对照确认 Gateway 心跳容错、Connection readiness
  告警语义和 Session Controller 内部准入/展示逻辑有变化，但未发现 RPC、事件帧或 Remote 错误词汇
  变化；Web Profile 仍声明 `--no-open`。
- 代码/自动证据：新增 `packages/dsh-adapter/src/versions/alpha3/adapter.ts` 和
  `packages/dsh-adapter/test/alpha3-contract.spec.ts`，补齐精确版本探测、`alpha3` 协议身份、继承的
  namespaced error 映射、mixed prompt content、受管启动参数及 alpha PTC 工具模式测试；默认安装
  版本仍为稳定 rc.2。真实 smoke 已验证 Web Profile endpoint、token-to-Cookie 登录和
  `session/list` 合法 envelope。
- 真实证据边界：alpha.3 的真实 `remote.mux`、Session/Workspace follow、长回答断线恢复与 VS Code
  Webview 回放尚未执行，因此 CN-06 继续保持 `PARTIAL`，不能把基础 smoke 和契约测试记为完整 live
  兼容。

## 2026-09-02 DSH alpha.4 上游同步与适配证据

- CN-06：本地上游仓库已核对已发布 `dsh-v0.1.2-alpha.4` tag/提交
  `4e84901e6471b79ec0338099867ebb4606d12bb5`，CLI manifest 版本为 `0.1.2-alpha.4`。
- 变更核对：alpha.3→alpha.4 的主要变化位于 Session Controller 内部 sequence/log-offset 品牌、
  inherited-event 统计和 Subagent 投递实现；`history.ts` 将这些内部值继续投影为数值 seq/cursor、
  `seedLength` 等 v0 browser wire。`session.list`、`session.prompt`、`session.fork`、Gateway/
  Connection framing、Remote 方法/错误词汇和 Web Profile `--no-open` 未改变。
- 代码/自动证据：新增 `versions/alpha4/adapter.ts` 与 `alpha4-contract.spec.ts`，alpha.4 使用
  独立精确身份；`adapter-chain.spec.ts` 进一步锁定 alpha.1 → alpha.2 → alpha.3 → alpha.4 → alpha.5
  的连续继承，避免再以 alpha.5 兼容回退冒充 alpha.4。真实 alpha.4 Web Profile、Cookie、
  `remote.mux`、Session/Workspace follow 和 VS Code Webview 回放尚未执行，因此 CN-06 继续保持
  `PARTIAL`。

## 2026-09-02 DSH alpha.5 上游同步与适配证据

- CN-06：本地上游仓库已同步到当前 `master` 提交
  `49a606bc5b5934603f22a26957a07dc799ab0291`；已发布 alpha.5 tag 为
  `dsh-v0.1.2-alpha.5`/`db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5`，CLI manifest 版本为
  `0.1.2-alpha.5`。
- 变更核对：alpha.4→alpha.5 在 Gateway、Remotes、Session Controller、Client Connection 和 CLI
  源码中无差异，发布增量集中在版本号、存储/投影缓存兼容；当前 master 相对 alpha.5 tag 的
  API 消费路径仅改变 Session 冷列表统计门槛和持久化内部，未改变扩展实际消费的 RPC、事件帧、
  Remote 错误词汇或 `--no-open` 启动 flag。
- 代码/自动证据：新增 `versions/alpha5/adapter.ts` 和 `alpha5-contract.spec.ts`，alpha.5
  使用独立 `alpha5` 身份与精确探测；未知未来版本（如 alpha.6）才进入 alpha.5 的只读兼容探测，
  已知 alpha.4 走自己的精确 Adapter 并保留真实标签。契约测试覆盖成功、业务错误、混合 prompt、
  畸形响应、取消和资源释放；受管启动和 alpha PTC 工具模式回归也纳入 alpha.5。
- 真实证据边界：alpha.5 的真实 Web Profile endpoint、Cookie、`remote.mux`、Session/Workspace
  follow、长回答断线恢复和 VS Code Webview 回放尚未执行，因此 CN-06 继续保持 `PARTIAL`，不能把
  代码或自动测试证据记为完整 live 兼容。

## 2026-09-06 DSH `0.1.3-alpha.1` 上游同步与 Session v2 适配证据（历史记录）

- CN-06：本节记录时，上游 `master` 对应 tag `dsh-v0.1.3-alpha.1`、提交
  `d347e703908d0406b7a7ef80e3a0e594d86b2215`，源码 manifest 版本为 `0.1.3-alpha.1`。
  当时 npm 没有同版本可安装包，因此本仓库以独立 `versions/alpha13` 适配源码契约；默认安装版本
  仍不切换到未发布快照。
- 变更核对：上游 Session Controller v2 要求 `SessionWireHeader.isSeeded`，历史记录收敛为
  `{ type: 'event', event }`，`session/follow` 通过 `assistantStream: true` opt-in
  `start/chunk/end` assistant frame；重连快照使用 `revision/activeAttempt/nextIndex` 和
  `text-chunks`、`reasoning-chunks`、`tool-call-chunks` 压缩记录，durable assistant settlement
  要等到对应 `end` 才发布。`/api` Connection envelope、Cookie、`remote.mux`、Gateway
  waterfall 和 `--no-open` 路径继续沿已验证 alpha family 复用。
- 代码/自动证据：新增 `versions/alpha13/adapter.ts` 与 `session-wire.ts`，v2 请求只由
  alpha13 发送；旧 alpha.1–alpha.5 仍固定 v0。Adapter 对 v2 header/history/frame/compact
  record 做已知字段严格校验（未知新增顶层字段安全忽略），Host 侧只把可见 text/reasoning delta 投影给 Domain，tool/raw
  chunk 不穿透 Webview；Timeline 使用 `transientAttemptId + transientIndex` 去重，且
  `advanceSequence: false`，不把进程内帧伪装成 durable Session seq。`alpha13-contract.spec.ts`
  覆盖精确/未知版本探测、assistantStream 请求、baseline 重建、settlement 顺序和 malformed
  continuity；`reducer.spec.ts` 覆盖 reconnect baseline 去重、同一 attempt 的 baseline 重放替换，
  abandoned frame 的 Host-only interrupted 投影由 `stream-controller.spec.ts` 覆盖。
- 真实证据边界：当前仅完成最新源码/tag 对照、代码和自动测试；由于 `0.1.3-alpha.1` 未发布
  npm 包且未在本轮构建/启动上游 DSH 实例，真实 Web Profile、Cookie、remote.mux、长回答
  断线恢复和 VS Code Webview 回放仍缺，CN-06 保持 `PARTIAL`。
- alpha13 的瞬态流明确降级为 text/reasoning：`block-start`、`block-end`、`tool-call-delta`、`usage`、
  `finish` 不进入 Domain；工具最终结果仍来自 durable tool 事件。Session v2 header/event 对未知新增
  顶层字段忽略，但已知字段和 frame 外壳继续 fail-closed，避免把未经验证的状态当作可恢复事件。

- 生命周期回归：`session.open` 在权威 history 之后重新建立已有 follow baseline；瞬态序号出现缺口时
  自动重启逻辑流并丢弃缺口帧；归档集合变化释放对应 session controller；单个 session 流断开只发送一次
  session 级 reconnecting notice，Webview Timeline 已实际归约该提示。迟到 durable ledger 重建保留
  active transient 节点，abandoned attempt 由 Host-only interrupted completion 关闭并保留中断标记；
  覆盖证据为 `alpha-events.spec.ts`、`stream-controller.spec.ts`、`reducer.spec.ts`、
  `store-gap-heal.spec.ts` 和 `store-timeline.integration.spec.tsx`；全量门禁仍不等价于真实
  alpha13 DSH/VS Code Webview smoke。

## 2026-09-08 DSH `0.1.3-alpha.2` 上游同步与 subagent delivery 适配证据

- CN-06：最新正式上游 tag 为 `dsh-v0.1.3-alpha.2`，提交
  `82a5fd61a7cf5c293cec4bdff68f455398d685e9`，npm 版本为 `0.1.3-alpha.2`；上游 `master`
  已继续前进到 `c389f96bf3a9b6807cb71ed6bdad5849be0df6d8`，其未发布的桌面端、workspace-files
  和客户端资源变化不在本次精确版本适配范围内。
- 变更核对：alpha.2 保持 alpha.1 的 Session v2、Connection/Gateway、Cookie、`remote.mux`
  和 Web Profile `--no-open` 边界；`SubagentPromptRequest` 及 control schema 新增严格必填
  `delivery: 'queue' | 'steer'`，Session Controller 将客户端运行模式传入该字段。固定 rc.6
  `rpc-map.ts`、`events.ts` 与工具目录契约未被本次版本差异改写。
- 代码证据：新增 `versions/alpha132/adapter.ts`，与 `alpha13` 分开保留精确 identity；只有
  alpha132 组装的 `Rc6SubagentRepository` 开启 `subagentPromptDelivery`，旧 alpha/rc 路径继续
  省略该字段。`subagent.send` Webview schema、Store、Application port/use case 已贯通
  `queue/steer`，省略模式时 Host 默认 `queue`；Webview 仍只传 opaque attachment handle。
- 自动证据：`alpha132-contract.spec.ts` 验证精确探测、v2 backend 组装和 alpha.2 prompt wire；
  `subagent-repository.spec.ts` 验证 queue/steer 字段和旧线路隔离；`advanced-agent-use-cases.spec.ts`、
  Webview schema/store、`adapter-chain.spec.ts`、`launch-contract.spec.ts` 及运行时启动回归已通过。
- 真实证据边界：本轮仅完成上游 tag/source 对照和自动契约测试；尚未执行真实
  `0.1.3-alpha.2` Web Profile、Cookie、`remote.mux`、Session v2 长回答断线恢复、VS Code Webview
  或 subagent queue/steer smoke，因此 CN-06 继续保持 `PARTIAL`，且 alpha.2 不切换安装默认。

## 2026-09-10 DSH `0.1.5-alpha.2`/`0.1.5-rc.1` 全功能适配证据

- 上游同步：扩展仓库 `main`/`origin/main` 已到 `0107e4856add27c2ad39d47ccde940fda2d9be5e`；DSH
  `master`/`origin/master` 已到 `aa8262ec091698bae9a6b04773a6b5b06ad4aef2`。本次适配基线为
  `dsh-v0.1.5-alpha.2`/`b2e3b2a0125854567a4a5fcba75782e42fe84901` 与
  `dsh-v0.1.5-rc.1`/`183f08e9c6dde7e36cd2318eaee70b0da08fb35e`；全局 npm 运行时已核验为
  `@deepseek-ai/dsh@0.1.5-rc.1`，`dsh --version` 与 `dsh web --help --no-open` 可用。
- CN-06 代码证据：新增 `versions/alpha152`、`versions/rc151` 精确入口，复用已核对的 Session
  v3 transport；更新 v3 known-event vocabulary，严格映射 `deliverables/presented` 与
  `subagent/catalog`。Domain/Timeline/Store 接收有界交付文件和父目录事实，交付卡片复用既有
  Host-only 文件打开/显示路径，目录事件只刷新活动父会话的 `subagent.list`。
- CN-06 自动证据：`alpha152-rc151-contract.spec.ts` 覆盖两个版本的 exact probe、v3 event mapper、
  malformed path/catalog；`adapter-chain.spec.ts`、`launch-contract.spec.ts`、Timeline、Store
  integration/subagent 回归覆盖版本链、启动参数、durable sequence、交付文件渲染/委托和目录刷新。
  定向回归为 7 个测试文件、145 个测试通过；随后全量门禁结果以本轮最终命令输出为准。
- 真实证据边界：尚未执行真实 `0.1.5-alpha.2`/`0.1.5-rc.1` Web Profile、Cookie、`remote.mux`、
  Session v3、`present` 工具实际交付、子代理目录实际刷新或 VS Code Webview DOM smoke；因此
  CN-06 仍为 `PARTIAL`，不能把代码/自动测试证据写成完整运行时兼容证明。

## 2026-09-11 DSH `0.1.5-rc.2` 全功能适配证据

- 上游同步：DSH `master` 已由 `aa8262ec091698bae9a6b04773a6b5b06ad4aef2` 快进到
  `c291e7961a515f6d7af9304e7fd1d257929aef26`；本轮发布基线为
  `dsh-v0.1.5-rc.2`/`fb2c4b9e698e30edb738bca4cf0618587db7d203`。npm 的 `latest` 仍为
  `0.1.5-rc.1`，`next` 为 `0.1.5-rc.2`；扩展安装器明确使用 `next`，不把 dist-tag 差异
  混同为协议差异。
- 上游差异：rc.1→rc.2 的主通道没有新增 Connection/Gateway、Cookie、`remote.mux`、
  assistant stream 或 Session v3 wire；变化集中在消息反馈统一提交/撤销行为、七分类字段、
  反馈失败提示，以及交付物卡片的紧凑间距和文件图标尺寸。
- CN-06 代码证据：新增 `versions/rc152` 精确身份并复用已核对的 rc.1 Session v3 transport；
  Domain、rc.6 feedback repository、Webview schema、Store、Timeline 和 MessageActions 已贯通
  `category`，正/负反馈均在提交后落库，当前 rating 重复点击走撤销；产出/交付行补充稳定 DOM
  标记并收紧 rc.2 间距，文件打开/显示仍经 Host 路径校验。
- CN-06 自动证据：rc.2 adapter chain/contract/launch、feedback repository、Webview schema、
  Store feedback、MessageActions、Timeline 和 deliverables layout 定向回归已通过；最终全量门禁
  结果以本轮命令输出为准。
- CN-06 真实基础 smoke（2026-09-11）：在隔离临时 `DSH_HOME` 启动真实 npm
  `@deepseek-ai/dsh@0.1.5-rc.2`，完成 token-to-Cookie（HTTP 303）握手、`session/create`、
  `session/list`、`remote.mux` `$events` ready，以及带 `assistantStream: true` 的 Session v3
  `session/follow`；真实 snapshot 含 `header.isSeeded`、`assistantStream`、`records`、`projections`
  等字段。`messageFeedback/list` 返回空目录；带有效七分类的 `messageFeedback/put` 到达业务层，
  对无真实助手消息的测试会话返回预期 `target-not-found`，未调用模型。
- 真实证据边界：交互式交付工具、目录刷新、长回答/断线恢复、外部凭据会话和 VS Code Webview
  DOM smoke 尚未执行，因此 CN-06 仍为 `PARTIAL`；精确 Adapter、自动测试和基础 live smoke
  不能替代完整产品兼容证明。

## 2026-09-09 DSH `0.1.5-alpha.1` 上游同步与 Session v3 适配证据

- CN-06：最新上游 tag 为 `dsh-v0.1.5-alpha.1`，提交
  `5dda764ed3aa172535a7967b06ff95d9cbfe536a`；远端 `master` 与该 tag 一致，npm
  `@deepseek-ai/dsh` 的 `alpha` dist-tag 指向 `0.1.5-alpha.1`。相对 `0.1.3-alpha.2` 的
  上游 compare 为 563 个提交，变更中与本仓库主通路相关的部分集中在 Session wire v3、
  surface 元数据和 PTC 事件命名；workspace-files、桌面端和客户端资源 API 不在本次适配范围。
- 变更核对：Session `SESSION_FORMAT_VERSION` 升为 3；事件 envelope 对未知顶层字段
  fail-closed，surface replacement 使用 `startSeq/endSeq`，`system/message` 替代
  `request/header.header.system` 的系统提示承载，`tool/ptc-dispatch-start` 与
  `tool/ptc-dispatch` 成为 PTC 事件名；Connection/Gateway、Cookie、`remote.mux`、
  assistant stream frame 和 alpha.2 subagent `delivery` 线路保持不变。
- 代码证据：新增 `versions/alpha151/adapter.ts` 与独立 v3 validator；alpha transport
  在精确 `0.1.5-alpha.1` 分支按 v3 合同发送 `assistantStream: true` 并验证 v3 snapshot/page/event；
  Domain 只接收无 prompt payload 的 `session.system` 序号水印，Webview/Timeline 将其作为
  不改变 UI 的内部事件；rc/alpha v0 与 alpha13/alpha132 v2 入口未复用 v3 字段。
- 自动证据：`alpha151-contract.spec.ts` 覆盖精确 Adapter 选择、严格 envelope、surface
  marker/replacement、未知 ignorable opaque metadata、系统提示隔离、PTC 映射、历史过滤、
  assistant baseline 和 malformed response；最终 `pnpm format:check`、`pnpm lint`、
  `pnpm typecheck`、`pnpm test`、`pnpm build` 均通过；`pnpm test` 为 133 个文件、1126 个测试。
- 真实证据边界：尚未执行真实 `0.1.5-alpha.1` Web Profile、Cookie、`remote.mux`、Session v3、
  surface replacement、系统提示隔离、PTC 和 VS Code Webview smoke；因此 CN-06 保持 `PARTIAL`，
  alpha151 不作为安装默认。

## 2026-09-03 供应商添加接线修复与上游语义适配证据

- MD-01/ST-01/ST-02：结合固定上游的 `CustomProviderCard`、`ModelsSection`、Schemastery
  protocol union 和 `settings.mutate` 语义，补齐自定义 Provider 从 Webview 到 Extension Host、
  Application、Adapter、DSH 的完整链路。Provider profile 以打开时 namespace revision 做一次
  compare-and-swap 写入，API key 由 Host 可选密码输入后单独调用 `credentials.set`；key 不进入
  Webview 协议、Domain DTO 或日志。无 key 时保留上游 provider-native authentication 语义。
- 动态接线：API protocol 选项直接来自 DSH `llm.providers` 对应 Schemastery union；模型发现增加
  Host-only `models.discover.custom` 路由；自定义创建增加严格的 `provider.custom.create` 协议。
  profile 已提交但凭据写入失败时，卡片锁定 profile 字段，重试只调用现有 Provider Secret
  Host 路径，不重复使用已失效的 revision；刷新失败也不会诱导重复提交已落地 profile。
- 安全与回归：协议和 Application 双重拒绝模型元数据中的 credential-shaped 字段，并校验模型
  ID/name/capacity、路由 ID、动态 protocol、目标 settings collection、碰撞和 CAS revision；
  `packages/application`、`packages/dsh-adapter`、`packages/webview-protocol` 及 Settings
  组件回归覆盖成功、keyless、credential-only failure/retry、刷新失败、畸形输入和动态枚举。
  本次全量自动证据为 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`
  （126 个文件、1011 个测试）和 `pnpm build` 均通过。
- 真实证据边界：尚未对真实 DSH 执行自定义 Provider 写入、凭据保存/重试和模型发现 smoke，
  因此 MD-01、ST-01、ST-02 继续保持 `PARTIAL`，不能将代码或自动测试证据记为完整 live 兼容。

## 未知运行时的尽力而为兼容策略

- 选择规则：运行时版本为空时沿用未版本化候选的既有探测；运行时版本为非空且不在
  `SUPPORTED_DSH_VERSIONS` 时，禁止调用精确版本 `probe`，只调用实现了只读
  `probeCompatibility` 的 Adapter，并按显式 `compatibilityPriority` 从新到旧排序。当前
  `0.1.2-alpha.6` 或 `0.1.3-alpha.3` 会跳过不能安全协商 Session v2 的 alpha13/alpha132，先尝试可复用 v0 wire 的 alpha.5
  Adapter，只有其只读 `session/list` 契约探测拒绝后才继续更旧候选；已知 alpha.4 不进入此分支。
- 状态规则：连接成功后 `dshVersion` 保留运行时实际标签，`adapterId` 保留实际选中的实现，
  `compatibilityMode=best-effort` 且 `featureProfile.source=compatibility-fallback`；警告只说明
  这是未验证版本，不把它伪装成已支持版本，也不把 alpha/beta 解释成继承分支。
- 失败规则：候选返回 `undefined`、只读握手失败或契约字段不匹配时继续下一个候选；调用方取消立即终止，
  不尝试旧候选；所有候选均拒绝才报告不兼容。未知版本不猜测版本专属 CLI flag、RPC 字段或事件形状，
  运行时不支持的单项能力仍走现有 `CAPABILITY_UNAVAILABLE`/安全错误映射，不升级为连接崩溃。
- 自动证据：`packages/dsh-adapter/test/probe.spec.ts` 覆盖最新优先、显式优先级、精确-only 候选跳过、
  已知版本精确探测、候选不兼容后继续和取消短路；`alpha4-contract.spec.ts` 覆盖 alpha.4 精确身份、
  新旧候选选择、错误映射和畸形响应，`alpha5-contract.spec.ts` 覆盖 alpha.5 精确身份、未知 alpha.6
  保留真实版本、alpha.5 Adapter 身份和兼容警告，`alpha13-contract.spec.ts`/`alpha132-contract.spec.ts` 锁定 v2 精确-only
  和未知版本回退到 alpha.5；`adapter-chain.spec.ts` 锁定版本 family 线性继承链，
  `backend-factory.spec.ts` 锁定工厂按 Adapter 身份创建，避免再次按协议名误选。

## 可选 DSH 能力的处理

MCP、LSP、Schedule、Terminal、Session Query、E2B、Cordis 动态工具等可能未在默认 Web Profile 启用。扩展通过已知上游事件的通用 Tool Card 和 `CAPABILITY_UNAVAILABLE` 降级；不得为了“功能完整”擅自启用高权限插件。

## 2026-09-03 上游 goal/change 接线修复证据

- PL-01：固定 rc.6 提交 `47f943859bef60e4160492346772ded9b24f765a` 的 `goal/change` 是单个完整快照或 clear 墓碑，不是 `goals[]` 列表。rc.6 mapper 现将快照 `goal` 投影为 `goal.updated`，把 `objective` 映射为标题，并将 `active/paused/blocked/complete` 正确转换为 UI 的 `in-progress/pending/blocked/completed`；clear 墓碑映射为空列表，旧 whole-list 事件仍兼容。
- 自动证据：`packages/dsh-adapter/test/rc6-contract.spec.ts` 新增 canonical snapshot、四种 phase、clear 和畸形快照回归；定向回归通过。尚未新增真实 DSH/Webview 回放，因此 PL-01 继续保持 `PARTIAL`。

## 2026-09-03 固定版本跨链路字段审计与修复证据

- IN-02/AT-01：rc.6 与 alpha 的 queue projection 现在保留上游 `Message` 中的 durable image reference；队列 UI
  对含图片的条目只读展示，避免调用上游明确拒绝非 text block 的 queue edit；文本队列仍保留原有编辑、删除和
  steer 路径。定向回归覆盖图片投影、图片队列编辑的本地拒绝和 UI 展示，IN-02、AT-01 仍因缺真实运行中操作与
  Webview 回放保持 `PARTIAL`。
- PL-01：goal create/edit 的可选 `maxGoalRounds` 已沿 Domain → Application → Host → Adapter 传递，历史投影、
  live `goal.updated` 和 rc.6 `goal/change` canonical snapshot 均只接受正安全整数；`goal/change` 的 clear tombstone
  映射为空列表。回归覆盖 max-only edit、live/历史投影、phase、clear 与畸形输入；真实 DSH/Webview 仍未验证，
  PL-01 保持 `PARTIAL`。
- SA-01/AT-01：alpha.3–.5 的 `subagent/attachment-invalid`、alpha.1–.2 的旧错误词汇、各 alpha 版本的
  `agentPreset.copy` void receipt 和独立 `settings/canOpenAgentPresetDirectory` 探测均按固定上游契约映射；可选
  目录探测失败不再阻断有效 preset roster。子代理图片只在 alpha.3+ 的真实能力路径启用，rc.6/旧 alpha 在 Host
  边界明确拒绝；opaque attachment handle 只在成功投递后释放，失败保留以支持重试。SA-01、AT-01 仍缺真实 DSH
  子代理/Webview 回放，保持 `PARTIAL`。
- SK-01/TL-01/CM-01：skill 的可选 `whenToUse`、rc.6 structured tool/result error 的可读回放以及空 cursor
  的参数省略已贯穿投影和 UI；command.execute 的 Host handle 解析/资源释放也补齐成功与失败边界。自动测试覆盖
  畸形响应、取消、错误和资源释放；相关能力仍保持原有 `PARTIAL`，未以静态或自动证据冒充真实运行完成。
- MD-01/CN-06：继续审计 alpha provider 接线时发现 `llm/listProviders` 与
  `llm/listConfigurableProviders` 的非数组或坏条目此前会被静默过滤为缺失状态；现按固定上游数组契约
  在 Host 侧以 `PROTOCOL_ERROR` fail closed，并新增非数组、坏条目回归，避免把协议损坏误显示成“无 Provider”。
- CN-05/PL-01/AT-01：继续审计发现 session.list 的 projection 只是可能过期的部分提示，现不再作为
  open 的权威基线；history projection 才能替换缓存，畸形 imageLimits、权限目录、目标快照、Token/pressure
  分桶、队列/消息图片和 canonical 已知 content block 均按整项拒绝或保留上一份有效状态，避免过滤后放宽权限、
  清空有效状态或静默丢失图片；新增 session/goal/Webview/stream 回归覆盖这些边界。
- 协议边界回归：history 的显式 beforeSeq/sequence/time、session.open 的关键字段、session.subscribed/
  session.projection 的水位与 value、permission/question resolution、workspace/notice/tool 标识、session.detail
  的 goalIds，以及 alpha goal receipt、preset `hasDocument` 能力字段现在在“出现但畸形”时拒绝或降级为 unknown，
  不再用索引、当前时间、空字符串、过滤后的子集或默认能力静默替代；真实缺省字段仍保留旧版本兼容路径。
- 证据等级：本批次完成固定上游源码/契约核对和自动回归；本轮已通过 `pnpm check && pnpm build`
  （格式、lint、类型检查、126 个测试文件/1062 个测试及构建）。尚未执行真实 DSH 与 VS Code Webview
  的完整运行验证，因此不提升上述核心能力为 `DONE`。

## 2026-09-13 复杂对话流 P0 完整性修复证据

- CN-05/CN-06 根因：恢复任务此前与 live reader 脱钩，后续 durable 序号可能越过未恢复的洞；历史
  presentation 过滤/压缩又被误当作恢复源；同一序号的不同 projection 或工具记录会被 sequence-only
  合并丢弃；相邻之外的 delta 被跨工具/生命周期行拼接；`model.retry` 的嵌套 sessionId、重连交接、
  打开屏障超量缓存和 Host-only 交互序号也存在漏路或乱序风险。
- 修复：按 session 建立有序 durable 队列，恢复期间持续读取但按序号屏障交付，支持关闭、重连代际交接、
  同序号多记录和 observer 异常隔离；恢复使用未压缩、保留内部 system marker 的 Adapter 专用历史源，
  presentation page 返回精确 raw coverage；Webview 台账采用 exact-event dedupe、coverage 合并和 durable
  序号排序，打开屏障取消静默 4096 条截断，并把审批/提问/队列/作业等控制面与对话游标隔离。
- 自动证据：`packages/dsh-adapter/test/stream-controller.spec.ts` 以真实 rc.6 mapper/Repository 形状回放
  多请求、多工具并行/失败、嵌套 PTC、deliverables、projection、多个 live hole、重连和同序号记录；
  `session-repository.spec.ts` 覆盖 raw recovery 与 system marker/相邻 delta；Webview 的 gap/open/startup/
  subagent 回归覆盖乱序恢复、压缩覆盖、同 Host 序号、4100 条打开屏障和非 durable approval。最终全量
  `pnpm test` 为 152 个测试文件、1250 个测试全绿；`pnpm format:check`、`pnpm lint`、`pnpm typecheck`
  和 `pnpm build` 均通过。
- 证据边界：本批次完成代码与自动复杂流回放，但未新增真实 DSH 长会话断线恢复及真实 VS Code Webview
  DOM smoke；因此 CN-05、CN-06、SS-01、CV-01 仍保持 `PARTIAL`，自动测试不冒充现场运行证明。

## 2026-09-13 P0 最终 assistant 消息丢失：control projection 占用 durable 序号

- CN-06/CV-01 根因：真实 DSH 会在 `session/control` 上推送增量 `projection` 帧，其 `seq` 描述的是该投影的
  as-of 游标而不是持久日志位置（对照本机 `session.v3.jsonl.zstd` journal，其中没有任何 `projection`
  行）。`AlphaLoopbackApiClient.readControl` 的增量分支此前直接 `yield frame`，而 `normalizeEnvelope` 没有
  `projection` 分支，帧因此变成带 `sequence` 的 `unknown`；Webview Store 把 `unknown` 视为推进对话游标，
  于是 `projection@141` 抢占 durable 槽位，紧随其后的真实 `assistant/message@141`、`step.ended@142`、
  `turn.ended@143` 被判为过期丢弃，台账重建（`reduceTimelineBatch`）后依旧缺失——与“工具行还在、最终回答
  消失”的现场症状一致。
- 修复：增量投影在 transport seam 归一化为 `session/projection`，与 baseline 分支产出的形状一致；
  `session/projection` 既不推进 Webview 对话游标，也在 `DshStreamController` 中绕过有序 durable 队列，因此
  不会再占用 durable 序号。真实流中其余 `unknown`（`model/selection`、`agent/inbox/spliced`、
  `session/queue`）经 journal 核对确属持久行，保留推进语义。
- 自动证据：`packages/dsh-adapter/test/alpha-contract.spec.ts` 新增 “normalizes an incremental control
  projection so it cannot occupy a durable sequence”（transport seam 归一化）与 “keeps the durable
  completion that shares its sequence with a control projection”（组装层：控制面投影 @15 之后跟随真实
  `assistant/message@15` 不再降级为 unknown）；`apps/webview/src/app/store-timeline.integration.spec.tsx`
  新增 “keeps the answer when a control projection is published for a completion sequence”，覆盖完成帧被
  丢弃的失败形态以及延迟 durable 重投后的台账重建。移除 transport 修复时上述用例转红，恢复后转绿。
- 真实 DSH 运行验证（本机外部实例 `0.1.5-rc.1`，`127.0.0.1:30005`，token launch URL + cookie，多步工具
  回合）：314 个后端事件、75 个 `session.projection`、0 个 unknown projection、4 条 assistant-message；
  最终 Markdown 为“已在当前目录创建 `hello.txt`，内容为 `live-verify`，读取确认无误（单行内容正是
  `live-verify`）。”；用真实 durable 历史重开会话后 assistant 数量与 Markdown 完全一致，Trajectory 记录 4
  条 message。同一脚本移除修复后复现 P0：40 个 unknown projection、0 条 assistant-message、最终 Markdown
  为空。
- 门禁：`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`（152 个测试文件、1293 个测试）与
  `pnpm build` 全部通过。
- 证据边界：本批次为 Adapter/Store 自动回归与真实 DSH 事件流运行验证，仍未完成真实 VS Code Webview DOM
  smoke；因此 CN-06 与 CV-01 继续保持 `PARTIAL`。

## 2026-09-13 脱敏长会话端到端呈现回放

- 资产：`apps/webview/src/app/long-session.fixture.ts` 以真实 0.1.5 会话（18 轮 / 47 步）的事件顺序、
  步数分布、工具词汇与 payload 形状为模板，重放一段 6 轮 / 19 步的脱敏对话；路径、命令、标识与句子均为
  虚构。覆盖 durable `turn/step/tool` 行、进程内 assistant 帧（无游标 delta）、`assistant/message`
  完成、`session/projection`、`todo/write`+`todo.updated`、`subagent` 工具与
  `subagent-report`/`relay` 收件箱报告、`deliverables/presented`，以及结果行只报 `unknown-tool` 的
  合并路径。
- 自动证据：`apps/webview/src/app/store-long-session.spec.tsx` 通过真实 Store（`createAppStore`）+
  `Timeline` + `TrajectoryView` 断言 6 条用户气泡、6 条完成回答、11 张工具卡（8 种工具）的本地化标题与
  来源顺序、失败工具的 error 区块、TODO 的 `In progress` 状态、交付文件描述、思考展开前后内容、以及
  Trajectory 的 6 个轮次分段和 `context` 行位置；同时断言 `session.projection@177` 之后的
  `message.completed@177` 仍落在唯一节点上、瞬时流式节点被就地替换、全程不出现 `event`/unknown 节点，
  并在重渲染与低于游标的 durable 重投后保持节点集合与文本不变。
- 门禁：`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`（153 个测试文件、1295 个测试）与
  `pnpm build` 全部通过。
- 证据边界：本批次为脱敏回放的 Store/组件层自动验证，未启动真实 DSH、未做真实 VS Code Webview DOM
  smoke；CN-06 与 CV-01 的证据等级不因本批次改变。

## 2026-09-13 续六：启动失败被误报为「就绪超时」、live smoke 默认运行时在 Windows 上不可启动

本轮由「跑一次真实 DSH live smoke」触发，两个缺陷同属一族：**启动阶段的失败没有自己的表达**，
只能以别的现象（就绪超时）出现。

缺陷一（可执行文件启动失败被误报为就绪超时）。`DshProcessSupervisor.startOnce`
（`apps/extension/src/backend/process-supervisor.ts`）只等待 stdout 里的 ready 行；而启动失败的两种形态都
不会产生任何输出、也不会产生 `exit`：

- 可执行文件不可用（裸命令名在 Windows 上、文件被删除、EACCES）→ Node 在 `child` 上发 `error`
  事件（`spawn dsh ENOENT`），`pid` 为 undefined；
- `shell: false` 遇到 `.cmd`/`.bat` 目标 → Node **同步抛出** `EINVAL`，连 child 都不存在。

前者让 `start()` 白等 15 秒后报 `Timed out waiting for DSH readiness.`（把启动失败说成运行时没就绪），
后者让裸 errno `EINVAL` 穿透 supervisor 的错误映射直达调用方；两种 spawner
（`composition-root.ts` 的 `spawnManagedChild` 与 live smoke 自带的那份）也都没有挂 `error` 监听，
于是 `ENOENT` 会以未处理事件的形式抛进扩展宿主。用普通 Node 复现过两种形态：
`spawn('dsh', …, { shell: false })` → `ERROR ENOENT`；`spawn('dsh.cmd', …, { shell: false })` → 同步
`Error: spawn EINVAL`。

自动证据（先红后绿，`apps/extension/src/backend/process-supervisor.spec.ts`）：

- 新增「reports a launch that never produced a process instead of a readiness timeout」：假的
  `SpawnedChild`（`pid: -1`、无输出、`exited` 永不 settle）。修复前失败于
  `expected AppError: Timed out waiting for DSH readi… to match object { code: 'BACKEND_UNREACHABLE', message: 'The DSH process could not be started.' }`，
  并确实耗时约 15 秒；修复后毫秒级失败。
- 新增「reports a synchronous spawn failure as an unreachable runtime」：`spawn` 同步抛 `EINVAL`。
  修复前失败于 `expected Error: spawn EINVAL { code: 'EINVAL' } to match object { code: 'BACKEND_UNREACHABLE', … }`。

修复：两个 spawner 都挂上 `child.once('error', …)` 并把失败并入 `exited` 契约（失败启动等价于立即退出，
且不再产生未处理事件）；supervisor 把「同步抛出」与 `pid <= 0` 统一映射为 `BACKEND_UNREACHABLE:
The DSH process could not be started.`（`retryable: true`，保留 `cause`）。错误文案刻意不回显进程输出，
避免把 DSH 的登录 token 链接带进用户可见错误。修复后该 spec 39/39 通过（18ms）。

缺陷二（live smoke 的默认运行时在 Windows 上不可启动）。`tests/live-dsh/run.spec.ts` 把
`DSH_LIVE_RUNTIME` 默认成裸命令名 `dsh`，而 README 承诺「defaults to `dsh` on PATH」：裸名交给
`shell: false` 必然 `ENOENT`，于是这份「可复现的真实运行验证」在本机跑不起来，且因为缺陷一而表现为
误导性的就绪超时。

自动/运行证据（先红后绿）：修复前连续两次
`DSH_LIVE_SMOKE=1 npx vitest run tests/live-dsh/run.spec.ts` 都在
`[dsh-live-smoke] launch dsh --profile web --no-open --host 127.0.0.1 --port <port>` 之后失败于
`AppError: Timed out waiting for DSH readiness.`（`Tests 1 failed (1)`）。修复：新增
`tests/live-dsh/runtime.ts` 的 `resolveLiveRuntime`——显式路径原样使用，裸命令名按产品 runtime-locator
的候选顺序（Windows：`dsh.cmd`、`dsh.bat`、`dsh.exe`、`dsh`）扫 PATH，找不到时明确报错并提示设置
`DSH_LIVE_RUNTIME`；`runtime.spec.ts` 用假 PATH/假 `fileExists` 固定该解析（4 项，不需要真实 DSH），
变异验证：把 `.cmd` 候选改名后「resolves a bare command name to a spawnable PATH entry」立即变红，还原后 4/4。
README 里那条写着 `launch dsh.cmd` 的旧「recorded run」已删除——裸 `dsh.cmd` 在 `shell: false` 下同步
`EINVAL`，该记录不可能复现，留着就是假证据。

修复后的真实运行（2026-09-13，Windows，`@deepseek-ai/dsh@0.1.5-rc.1`，默认运行时解析）：

```text
[dsh-live-smoke] launch C:\Users\<you>\AppData\Roaming\npm\dsh.cmd --profile web --no-open --host 127.0.0.1 --port 15459
[dsh-live-smoke] login http://127.0.0.1:15459 status=303 cookie=exchanged
[dsh-live-smoke] managed start pid=12224 endpoint=http://127.0.0.1:15459
[dsh-live-smoke] probe dsh=0.1.5-rc.1 protocol=rc151 adapter=dsh-0.1.5-rc.1 mode=exact
[dsh-live-smoke] session.list 44 session(s)
[dsh-live-smoke] workspace.list 8 workspace(s)
[dsh-live-smoke] events.subscribe released
[dsh-live-smoke] backend closed
[dsh-live-smoke] managed stop port 15459 closed
```

证据边界：这次真实运行只补强 CN-01 的受管启动段（定位 → 启动 → 探测 → 附着）与 CN-04 的「只停止自己
启动的进程 + 端口释放」，仍不含真实 VS Code Webview 渲染；相关能力保持 `PARTIAL`。本轮同时确认：
产品侧不存在同一问题——runtime-locator 的候选名带 `.cmd` 前缀且必须通过 `fileExists`，所以扩展拿到的
是可被 shim 解析的完整路径（Electron 套件的 managed 真实运行也是这么走的）。

门禁：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全部通过。

## 2026-09-13 续七：剪贴板写入被拒时跳过 DOM 回退；缓存命中率整数算法反证

审计方法（本轮新增）：把「源文件中被任何 `.spec` 文件零引用」的导出符号当作未审计区，逐个判定。该扫描给出
215 个零引用导出，其中多数是类型/常量/`index` 重导出；重点核对后确认以下为**分阶段声明**（协议或 domain 已定义、
两侧都还没有调用点，不是缺陷）：`compareFeatureEventCursor` / `isFeatureEventStale` / `isFeatureEventGap` /
`resourceScopeAllows` / `FeatureResourceRegistry`（domain 侧），以及协议里的 `notification.safe` 宿主事件。
`changes.restore.prepare` 同属此类（真发过去会显式抛 `FEATURE_DISABLED`）。

缺陷：`writeClipboard`（`apps/webview/src/features/chat/clipboard.ts`）只在 `navigator.clipboard` **不存在**时
才走 DOM 回退。Webview iframe 的权限策略拒绝 `clipboard-write` 时，`navigator.clipboard` 依然存在、而
`writeText()` 会以 `NotAllowedError` reject——原实现直接把这个拒绝抛给调用方，**既不回退也不返回布尔值**。
后果：复制按钮点了没有任何反应（`CopyButton` 的 `.catch` 只重置 pending、不给反馈），
`DiagnosticsPanel` 的 `void writeClipboard(report)` 还会产生未处理的 Promise 拒绝。

- 先红：`apps/webview/src/features/chat/clipboard.spec.ts` 断言「API reject 时必须回退 DOM 并 resolve」，
  原实现报 `AssertionError: promise rejected "DOMException{ … NotAllowedError … }" instead of resolving`（3 个用例红）。
- 修复：把 `writeText` 的失败折算为 `false` 后继续走 DOM 回退；函数从此不再 reject，只返回布尔值。
- 回归：同一文件 5 个用例（API 成功 / API 拒绝→回退成功 / 回退失败返回 false / 回退抛错返回 false 且清理
  textarea / API 缺失时走回退）全部通过，另断言成功路径不触碰 `execCommand`。

反证（保留为新守卫，不修改实现）：`packages/timeline/src/usage.ts` 是本轮扫描中唯一零测试的 `timeline` 模块，
其缓存命中显示使用手工整数运算（二分求整百分比 + 逐位提升小数的循环）。新增
`packages/timeline/test/usage.spec.ts` 用独立推导的不变量复算：显示值必须等于「在所示精度下四舍五入」的结果、
在任何有未缓存 prompt token 的会话上不得显示 100、精度必须是最细的可用精度，并对
input×cacheWrite×cacheRead 约 1300 组网格与 1/999999、1/999、1/1999 等近似满命中用例全量核对，全部一致
——未发现缺陷，结论保持「实现正确」而不是「未验证」。

证据边界：本轮改动只在 Webview 组件层与 timeline 纯函数层，未启动真实 DSH、未做真实 VS Code Webview DOM
smoke；CN-06 与 CV-01 的证据等级不因本批次改变。

门禁：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全部通过
（166 个测试文件通过 / 1 跳过，1375 个测试通过 / 1 跳过）。

## 2026-09-13 续八：工具文本渲染的丢失与泄漏；双语字典一致性反证

本轮继续按「先写探针、看 RED、再改源码」的顺序审计导出级零测试函数。`packages/ui/src/tool-presentation.ts` 的
`formatToolText`/`formatToolValue`/`decodeToolValue` 被 `ToolCard.tsx`、`ToolRow.tsx`（工具错误、输出、回答、
输入摘要）直接使用，此前只有 `toolPresentation` 有测试。

缺陷 1：`formatToolText` 丢掉结构化字面量之后的尾部文本。`embeddedStructuredLiteral` 找到前缀化结果里的
平衡括号字面量后，只保留 `字面量之前的文本 + 格式化块`，`字面量之后`的内容被静默丢弃。RED 证据：
`formatToolText('Expected one of [read, write] but got "x"')` 返回 `'Expected one of\n• read\n• write'`，
`but got "x"`（读者唯一能知道被拒值的地方）消失；`'Tool completed: {"answers":…} — 12 ms'` 丢掉 `12 ms`。
修复：把字面量之后的文本作为第三段保留（`[prefix, formatted, suffix].filter(非空).join('\n')`），
保持原始顺序、不丢信息。

缺陷 2：嵌套 tool-result 文本里的原始 JSON 泄漏。`visibleContent` 的 `record.text` 分支用 `bounded()` 直接输出，
于是 `outputSummary = {"content":[{"type":"text","text":"{\"answers\":[…]}"}]}`（DSH 工具结果的真实包裹形状）
把原始 JSON 渲染进会话，违反该文件「不得泄漏 JSON/Python 对象表示」的契约。RED 证据：
断言渲染文本不含 `{"answers"` 时收到 `{"answers":[{"selected":["yes"]}]}`。修复：`record.text` 改走
`formatToolText`，与同函数中字符串分支的处理一致。

同时修正 3 处「永远不会失败」的断言：`JSON.stringify(presentation)).not.toContain('{"answers"')` ——
`JSON.stringify` 会把引号转义成 `\"`，该子串不可能出现；改为直接断言 `response[0].content`。

反证（保留为守卫，不修改实现）：`apps/webview/src/i18n.tsx` 的 `en`/`zh` 字典各 1154 个键，
键集合、占位符名（`{count}` 等）完全一致，无重复键。此前只有「英文键存在」与「占位符齐全」两个守卫，
中文侧没有任何检查，而 provider 是 `zh[key] ?? en[key] ?? key`：中文缺键不会报错，只会渲染英文；
占位符名不一致则会留下字面 `{n}`。新增守卫断言两字典键集合互为子集、占位符名逐键相同，
并用「临时把 zh 的 `{count}` 改成 `{n}`」验证该守卫确实会失败（RED 输出
`tasks.count: en{count} zh{n}`），随后已还原。

证据边界：本轮改动只在 `packages/ui` 纯函数层与 Webview 测试层，未启动真实 DSH、未做真实 VS Code
Webview DOM smoke；CN-06 与 CV-01 的证据等级不因本批次改变。

门禁：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全部通过
（166 个测试文件通过 / 1 跳过，1382 个测试通过 / 1 跳过）。

## 2026-09-13 续九：删除型 diff 在 Adapter 与 Webview 两层被丢弃

缺陷 36（高）：`newText` 为空串的 diff 被当作「空标签」丢弃，diff 卡片与变更审阅条目一起消失。
上游固定版本证据（`$APPDATA/npm/node_modules/@deepseek-ai/dsh`，v0.1.5-rc.1）：
`dsh-tools/lib/types/presentation.d.ts:33-35` 只约束 `oldText: string | null`、`newText: string`，
没有任何非空要求；`dsh-tool-fs/lib/index.js:502-503` 的 `computeHunkDiffs` 对纯删除 hunk 产出
`oldText: oldLines.join("\n")`、`newText: newLines.join("\n")`，即 `newText: ''`；同文件 `:674-675`、`:684-685`
的 `write` 用 `oldText: null, newText: args.content`（清空文件即 `''`）、`:789-792` 的 `edit` 与
`:826-827` 的 `oldText: args.old_string || null, newText: args.new_string` 同理；
`dsh-tool-str-replace-editor/lib/index.js:237,247` 用 `?? ""` 显式允许空内容；上游自己的
`isFileDiff`（`dsh-tool-fs/lib/index.js:509-512`）与 `diffsFromMeta` 只做类型检查，接受空串。
本仓库内证据：`apps/extension/src/changes/change-set-tracker.ts:445-452` 的 `changeStatus` 正是用
`newText.length === 0 && oldText.length > 0` 判定「删除」，即该状态此前不可达。

RED 证据（先写探针，两处同时复现）：`packages/dsh-adapter/test/tool-presentation.spec.ts` 期望
`{ card: 'diff', phase: 'result', diffs: [{ path: 'src/feature.ts', oldText: 'const removed = 1', newText: '' }] }`
实际 `presentation: undefined`；`apps/webview/src/app/store-tool-diff.spec.ts` 同样在期望
`newText: ''` 的 diff 时收到 `undefined`（宿主事件已到达 store，被 `parseToolDiffs` 丢弃）。

修复（两层同源，都用「内容而非标签」的判据）：
`packages/dsh-adapter/src/projection/tool-presentation.ts` 的 `diffPresentation` 改用 `lineText`
（只拒绝非字符串，不再拒绝空串，仍保留 `bounded()` 4096 上限与 `safePath` 校验）；
`apps/webview/src/app/store.ts` 的 `parseToolDiffs` 改用 `presentationText(value, true)`
（与本文件处理 read/search 行内容时既有的 `allowEmpty: true` 约定一致，`:7653`、`:7678`）。
`oldText === null`（新建/覆盖）语义保持不变，非字符串与不安全路径仍被丢弃。

链式守卫：`apps/extension/src/changes/change-set-tracker.spec.ts` 新增
`reports a removal-only edit, mapped from the DSH wire shape, as deleted`，用 `rc6Mapper.event('tool/result', …)`
构造真实线形（`view.card === 'diff'` + 空 `newText`）再喂给 `ChangeSetTracker`，断言
`status: 'deleted'`、`additions: 0`、`deletions: 1`、`diffAvailable: true`；修复前该用例无任何候选可产出。

回归检查（新行为新触发的路径）：修复后删除型 diff 会首次进入 Webview 宿主渲染器
`apps/webview/src/features/chat/ToolDiffPreview.tsx`，其 `projectDiffs` 对 `newText: ''` 输出路径行 +
纯 `del` 行、`added` 保持 0，`contentLines('')` 返回 `[]`；`packages/ui/src/components/ToolRow.tsx` 的
`diffLines`/`splitDiffLines` 同样已丢弃结尾空段。该路径无需改动。

证据边界：本批次只覆盖代码存在与自动测试两级；未启动真实 DSH、未做真实 VS Code Webview DOM smoke，
CN-06 与 CV-01 的证据等级不因本批次改变。

门禁：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全部通过
（167 个测试文件通过 / 1 跳过，1385 个测试通过 / 1 跳过）。

## 2026-09-13 续十：超限附件被误报为编码非法，且附件/发送失败原因对用户不可见

缺陷 37（中高）：字节数超限的附件被报成「The attachment encoding is not canonical Base64.」——用户上传的
Base64 完全规范，只是超出 `maxImageBytes`。根因：`packages/dsh-adapter/src/attachment-codec.ts` 里
`encodePromptContent` 先调用 `decodeCanonicalBase64(encoded, maximumBytes)`，而该函数对「超限」与「畸形」
统一返回 `undefined`（`:26`），调用点只能把两者都描述成「编码非法」。
上游固定版本证据（`$APPDATA/npm/node_modules/@deepseek-ai/dsh`，v0.1.5-rc.1）：
`dsh-attachment/lib/types/error.d.ts:2,5` 把 `INVALID_IMAGE_BASE64` 与 `IMAGE_TOO_LARGE` 声明为两个稳定错误码，
并注明「Consumers route on `code`」；`dsh-attachment-local/lib/index.js:321`
`if (input.data.byteLength > limits.maxImageBytes) throw new AttachmentError("Image exceeds the configured byte limit.", "IMAGE_TOO_LARGE")`。
本仓库证据：`packages/dsh-adapter/src/repositories/session-repository.ts:859-871` 的 `promptContentLimits` 以
`Math.min(本地上限, imageLimits.maxImageBytes)` 为准，宿主投影里更小的上限会合法地产生「超限但编码正确」的输入。

RED 证据：`packages/dsh-adapter/test/attachment-codec.spec.ts` 新增
`blames the byte limit, not the encoding, when an attachment is too large`，修复前实际为
`'The attachment encoding is not canoni…'`，期望 `'The attachment is too large.'`。
修复：解码前用 `decodedByteLength(encoded)`（不分配 payload）判尺寸并抛 `INVALID_CONFIGURATION` +
`'The attachment is too large.'`；删除原先不可达的 `bytes.length > limits.maxImageBytes` 分支；
`decodeCanonicalBase64` 保持严格，继续负责「非规范 Base64」判据。

缺陷 38（高，可诊断性）：附件与提示词发送的失败原因在 Extension 边界被整体丢弃。
`apps/extension/src/view/message-router.ts` 的 `publicErrorMessage` 此前只对 `command.execute`、settings/models/provider
转发有界（320 字符）且脱敏后的原因，`attachment.*`、`session.sendPrompt`、`session.enqueuePrompt`、`subagent.send`
一律只回落到 code 的兜底文案——「附件过大」「图片类型不被 DSH 接受」「附件内容与图片签名不符」「combined size 超限」
在 Webview 里全部显示为「The DSH configuration is invalid.」，用户无法区分「该换一张图」和「该改配置」。
RED 证据：`apps/extension/src/view/message-router.spec.ts` 新增两条用例：`attachment.pick` 得到
`expected 'The DSH configuration is invalid.' to contain 'too large'`；`session.sendPrompt` 同样，
且断言转发内容已脱敏（`not.toContain('super-secret')`）。
修复：新增 `MESSAGE_ATTACHMENT_REQUESTS` 白名单与 `withFailureDetail`（复用既有 `safeCommandDiagnostic`：
`redactText(..., 320)`，并附带 `rpcMethod`/`rpcCode`），只对附件类与提示词发送类请求追加原因，其它请求文案不变。

缺陷 39（中）：确认覆盖的导出在提交竞态下漏认一种错误词汇。`writeExportAtomically` 只在 `EEXIST` 时走
「目标已被创建 → 备份并替换」的恢复路径，而 Extension Host 经 `vscode.workspace.fs.rename(..., {overwrite:false})`
上报的是 `FileExists`（`node_modules/@types/vscode/index.d.ts:9741`：`@throws FileExists when newUri exists and when the overwrite option is not true`），
于是 `overwriteConfirmed: true` 的导出在 VS Code 文件系统下直接失败为 `EXPORT_FAILED`，尽管用户已确认覆盖。
RED 证据：`packages/dsh-adapter/test/export-repository.spec.ts` 新增
`it.each(['EEXIST', 'FileExists'])` 的 `recovers a confirmed export when the destination appears as a %s commit failure`，
修复前 `FileExists` 用例以 `EXPORT_FAILED`（cause `Error: FileExists`）失败。
修复：`isCommitConflict` 同时接受 `EEXIST` 与 `FileExists`。

附带修复（测试级竞态）：`apps/webview/src/features/settings/SettingsDrawer.spec.tsx` 的
`offers a dashed custom-provider card from a dynamic settings path` 在保存成功后自动关闭卡片，
而 Close 按钮在 `setBusy(false)` 落地前仍为 `disabled`，全量并发下点击被忽略导致偶发失败；
改为等待卡片自行消失，与同文件另外两条同源用例（`:889`、`:933`）一致。

证据边界：本批次只覆盖代码存在与自动测试两级；未启动真实 DSH、未做真实 VS Code Webview DOM smoke，
CN-06 与 CV-01 的证据等级不因本批次改变。

门禁：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全部通过
（167 个测试文件通过 / 1 跳过，1390 个测试通过 / 1 跳过）。
