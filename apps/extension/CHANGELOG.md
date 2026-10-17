# Change Log

## Unreleased

- 修复打开会话时发送/停止按钮反复切换及消息区跳动：历史快照不再冒充实时运行事件，压缩历史已覆盖的记录不触发重新打开，并在连接就绪后只恢复一次会话。
- Fixes startup flicker, Send/Stop toggling and transcript jumps by separating follow history from live activity, preserving compacted read baselines, and restoring the session after connection readiness.

- 临时助手预览异常时立即重取上游基线，同一 attempt 只补上未交付的部分，避免等待和文字回退；重复失败才退避并最终降级。流式正文发送脱敏后的新增部分，扩大有界确认窗口，修复长回复补跳、回合结束状态残留及补丁预算计算。
- Immediately rebaselines interrupted assistant previews without replaying an already delivered prefix; repeated failures back off before durable fallback. Sends sanitized text suffixes with bounded delivery credits and fixes long-reply stalls, stale completion metadata, and patch budget accounting.

- 去除 Host 与前端通知的人为等待，修复逐帧等待确认、重复替换 Markdown 稳定段及长历史虚拟列表误退出尾部跟随；立即投递和通知，保留有界背压及主动滚动阅读的位置。
- Removes artificial Host and Store notification delays and per-frame ACK waits, preserves stable streaming Markdown DOM, and keeps long virtualized conversations following live output while respecting reader scrolling and bounded backpressure.

- 压缩任务、目标、提问、队列及扩展面板，完整目标列表移入“更多”；计划默认收起，长内容和多条交互内部滚动，缩小功能菜单、导出和反馈弹层。
- Compacts task, goal, question, queue and Mods panels; moves the goal list into More, collapses plans by default, bounds long content and interaction stacks, and reduces utility menus, export and feedback dialogs.

- 实时更新发送变化节点并复用未变的展示行，修复流式修订号重置、预览永久降级与活动长回复冻结；运行中可继续输入、添加附件和补充命令，停止操作独立；回合完成及断线恢复同步刷新界面状态。
- Sends changed transcript nodes while preserving unchanged rows, restores transient streaming after revision resets, and keeps long live replies updating. Input, attachments, commands and Stop remain independently usable; Turn completion and transport recovery refresh the UI state.

- 压缩权限审批卡片，合并标题与风险、移除重复等待提示；长会话的完整内容列表移至会话“更多”菜单，减少消息区占用。
- Compacts permission approvals and removes repeated waiting notices; moves full-content links into the conversation actions menu to keep the message area clear.

- 补齐 `0.2.1-alpha.3` 至 `0.2.1-rc.2` 的后台任务持久事件，修复 Preset 通知误用历史序号；旧版历史、临时回复预览及共享连接内的单流错误不再扩大为整段会话故障。
- Adds durable Job events for `0.2.1-alpha.3` through `0.2.1-rc.2` and fixes Preset notifications being treated as sequenced history. Unreadable legacy rows, transient preview failures and logical-stream errors no longer invalidate unrelated conversation data.

- 打开会话、历史翻页和实时跟随按记录兼容不支持的 V4 事件，避免单条后台任务记录导致整段历史打不开；任务与权限状态继续使用上游权威数据。
- Session opening, paging and live following tolerate unsupported V4 records individually, so a background-job record cannot block the whole conversation; task and permission state still comes from authoritative upstream data.

- 修复 DSH 安装的前后台等待时限不一致及同一宿主内重复安装；延长慢速安装预算，并区分超时和文件占用错误。
- Fixes mismatched DSH installation timeouts and duplicate installs within one Extension Host; allows longer installs and distinguishes timeouts from files that are in use or not writable.

- 新聊天标签复用已有连接，只初始化自身会话；新会话可在首条消息前选择上游提供的权限，已有会话发送后及运行中仍可随时调整。
- New chat tabs reuse the existing connection and initialize only their own session; new-session drafts can select upstream permission presets, while existing sessions remain adjustable after sending and while running.

- 支持将会话行拖到编辑器区或分栏打开；重复拖入复用已有标签，保留列表内排序，取消拖动不会打开会话。
- Supports dragging a session row into the editor area or a split group; reuses existing chat tabs, preserves list reordering, and leaves cancelled drags unopened.

- 聚焦布局继续收尾：隐藏性能行后不再保留底部空白；“跳转到最新”按钮浮于正文底部而不独占一行；Markdown 链接恢复手型光标。
- Focused layout polish: the frame no longer keeps empty space below the composer after the performance line is hidden; "Jump to latest" floats over the transcript tail instead of claiming a row; Markdown links restore the pointer cursor.

- 精简聚焦布局：简洁模式隐藏性能与用量行；收紧会话头、正文与输入框的边距，并缩小正文与输入框之间的空隙。
- Tightens the focused layout: Compact mode hides the performance and usage line, trims the header/transcript/composer insets, and reduces the gap between the transcript and the composer.

- 将目标与任务合并为会话头部的紧凑、默认收起的目标/任务坞：活跃目标作为常驻信号，附完成计数与状态徽标；展开后查看目标栏、目标待办与任务清单。
- Folds goals and todos into a compact, collapsed-by-default dock in the conversation header: the active goal stays visible with a completion count and status pill; expanding reveals the goal bar, goal todos and task list.

- 当轨迹视图被禁用（关闭开发者工具）时隐藏会话视图标签栏，会话标题改为常驻显示。
- Hides the conversation view tab bar when the Trajectory view is disabled (Developer Tools off), and keeps the conversation title visible in the header.

- 新增 DSH `0.2.1-rc.2` 精确适配，核对固定源码并验证 Search / Fetch 实时设置、密钥隔离、非法值与过期修订拒绝、恢复默认；保留动态模型目录与已选路由。
- Adds exact DSH `0.2.1-rc.2` support with pinned source review and Search / Fetch settings coverage, including credential isolation, invalid values, stale revisions and restoring inherited defaults; preserves authoritative model catalogs and routes.

- 将更新、连接、错误和欢迎提示合并为默认收起的紧凑通知栏；返回最新消息和轨迹详情各占独立空间，短窗口提供滚动退路，修复通知挤压、辅助控件覆盖正文及长会话跳转后再次偏离尾部的问题。
- Combines persistent notices into a compact collapsed bar; reserves separate rows for jump controls and trajectory details, keeps short windows scrollable, and preserves the measured tail of long conversations after a jump.

- 修复菜单同级入口字号与行高不统一：任务、导出、语言和检查器采用相同文字角色；共享选择菜单不再继承表单字号，菜单和工具详情正确跟随会话字号设置。
- Unifies typography across peer menu actions, including tasks, export, language and Inspector; gives shared choice menus an explicit text role and makes menu/tool detail roles follow conversation font settings.

- 系统修复 Webview 布局和弹层：会话状态与行操作不再重叠，任务等菜单保持可读宽度；重排检查器和插件页，统一选择器主题及锚点定位，修复诊断和导出层级、嵌套 Esc、焦点恢复与动画残留坐标偏移。
- Repairs Webview layout and overlays: separates session status from row actions, keeps feature menus readable, reorganizes Inspector and plugins, unifies themed anchored selectors, and fixes diagnostics/export stacking, nested Escape, focus restoration and retained animation transforms.

- 适配 DSH 的后续精确入口，涵盖工作区完整替换、插件重启原因及重复安装错误、账号奖励通知变化；版本与固定来源见 [DSH 契约](../../docs/dsh-contract.md)。
- Adds subsequent exact DSH adapters, including workspace replacement baselines, plugin restart reasons and already-installed failures, and optional account bonus fields; see the pinned [DSH contract](../../docs/dsh-contract.md).
- 修复 [Issue #3](https://github.com/Jabofish/deepseek-harness-vscode/issues/3) 的普通会话停止被误判为子代理问题；审批和提问期间保持停止入口，允许运行时调整模型与权限，撤回控制不被工作区信任变化阻挡。
- Fixes ordinary-session Stop routing in [Issue #3](https://github.com/Jabofish/deepseek-harness-vscode/issues/3), preserves Stop during approvals and questions, enables model and permission choices while running, and keeps withdrawal controls available after workspace trust changes.
- 深入修复 [PR #4](https://github.com/Jabofish/deepseek-harness-vscode/pull/4) 的跨窗口取消串扰、会话绑定错位、关闭后的迟到消息和移动失败丢失错误；感谢 [ggeorgovassilis](https://github.com/ggeorgovassilis) 的贡献。
- Hardens [PR #4](https://github.com/Jabofish/deepseek-harness-vscode/pull/4) against cancellation across surfaces, stale session bindings, queued messages after close, and lost move failures; thanks to [ggeorgovassilis](https://github.com/ggeorgovassilis).

- 新增编辑器区聊天入口：命令面板的 **DSH: Open Chat in Editor Area** 将当前会话以编辑器标签打开（每个会话一个标签，窗口重载后恢复）；侧边栏保持可用，可独立新建、切换和发送会话消息。
- Adds an editor-area chat entry point: **DSH: Open Chat in Editor Area** opens the current session as an editor tab (one tab per session, restored after a window reload); the side bar remains available to create, switch and send messages in its own session.
- 新增聊天输入框命令 `/moveto:editor`（等同 `/moveto editor`）与 `/moveto:sidebar`，可在编辑器区与侧边栏之间移动聊天；未知目标只在本机报错，不会作为提示词发送。
- Adds the composer commands `/moveto:editor` (same as `/moveto editor`) and `/moveto:sidebar` for moving the chat between the editor area and the side bar; an unknown target fails locally instead of being sent as a prompt.
- 会话列表的每一行新增“在编辑器区打开”操作，可直接把该会话作为编辑器标签打开；重命名会话会同步更新已打开标签的标题。
- Adds an "Open in Editor Area" action to every session row, opening that conversation as an editor tab; renaming a session now updates the title of its open tab.

- 修复 Webview 上下文菜单的“复制”在未选中文本时无任何效果：现在复制所指行（助手回答或用户提问）的 Markdown，不含思考、工具调用和通知；该行没有可读文本时保持剪贴板不变。
- Fixes the Webview context menu's Copy doing nothing without a selection: it copies the Markdown of the addressed row (assistant answer or user prompt) without reasoning, tool calls or notices, and leaves the clipboard untouched when that row has no readable text.

- 精简设置、模型、插件和检查器中的重复说明；空状态与错误提示聚焦当前情况和可执行操作。
- Removes repetitive explanations from Settings, Models, Plugins and the Inspector; empty states and errors focus on the current situation and available actions.

- 移除 Webview 旧历史引擎及原始历史分页协议，普通和子代理会话统一使用 Host 窗口；队列接纳、Goal 修改和子代理目录采用 DSH 权威结果，工具预览复用工作目录投影。
- Removes the legacy Webview history engine and raw paging protocol. Ordinary and child sessions use Host windows; queue admission, Goal edits and subagent catalogs follow authoritative DSH results, and tool previews reuse the working-directory projection.
- 将聊天历史展示投影移至 Extension Host，按节点及正文预算提供可回看的窗口；隐藏时暂停窗口发送，以确认控制消息积压，避免 Webview 累积事件账本及历史页。
- Moves transcript presentation to the Extension Host with bounded, navigable windows and acknowledged delivery. Hidden views pause window delivery instead of accumulating a renderer event ledger and loaded history pages.
- 移除聊天区的分页、长记录预览和任务清单截断说明；完整持久内容可按需在 VS Code 编辑器打开，当前 Todo 直接使用 DSH 的整值投影。
- Removes paging, long-entry preview and partial-task-list notices from the chat. Full durable content opens on demand in the editor, and current Todos consume DSH's whole projection.

## 0.3.1

- 修复远程工作区的凭据作用域、附件文件系统与 Inspector 转发边界，避免不同 SSH / 容器环境复用授权。
- Fixes credential scopes, attachment filesystem access and Inspector forwarding in remote workspaces, keeping grants isolated between SSH and container environments.

- 改善聚焦布局和窄侧栏中的通知、导航、设置、菜单、图片、代码及表格展示，修复遮挡、裁切和多余滚动。
- Improves focused and narrow-sidebar layouts for notices, navigation, Settings, menus, images, code and tables, with fixes for overlap, clipping and unnecessary scrolling.

- 修复并发取消互相干扰、冲突答复被误报成功及迟到输出；加固会话配置回滚、Goal 状态和重连恢复。
- Fixes cancellation leaking across concurrent requests, conflicting answers reported as successful and late output; hardens session configuration rollback, Goal state and reconnect recovery.

## 0.3.0

- 新增 DSH 风格聚焦布局，统一会话、工具、输入栏、设置和插件界面；设置中可切回经典布局。
- Adds a DSH-style focused layout across conversations, tools, the composer, Settings and Plugins, with the classic layout available in Settings.

- 改善模型搜索、目录滚动和会话导航，修复过程折叠、长结果、统计及窄窗口布局。
- Improves model search, catalog scrolling and session navigation, with fixes for process disclosures, long results, statistics and narrow views.

- 支持自定义远程 HTTP(S) 连接：原生授权、按地址隔离凭据、严格 TLS 校验；远程 HTTP 需明确确认。见 [PR #2](https://github.com/Jabofish/deepseek-harness-vscode/pull/2)，感谢 [ggeorgovassilis](https://github.com/ggeorgovassilis) 的贡献。
- Adds custom remote HTTP(S) connections with native authorization, per-origin credentials and strict TLS verification; remote HTTP requires explicit confirmation. See [PR #2](https://github.com/Jabofish/deepseek-harness-vscode/pull/2); thanks to [ggeorgovassilis](https://github.com/ggeorgovassilis).

- 适配 DSH `0.2.1-alpha.2`，改善子代理、旧会话提示和插件安装恢复；默认引导安装保持稳定 rc.2。
- Adds DSH `0.2.1-alpha.2` support with improved subagents, legacy-session guidance and plugin install recovery; guided installation retains stable rc.2.

- 修复设置页反复重试、目录刷新竞态与长会话恢复，保留失败操作后的草稿和已加载数据。
- Fixes repeated Settings retries, catalog refresh races and long-session recovery while preserving drafts and loaded data after failures.

## 0.2.12

- 新增会话检查器、Creator 入口、工具参数预览和 Markdown frontmatter 展示。
- Adds a Session Inspector, Creator shortcut, tool argument previews and Markdown frontmatter display.

- 适配 DSH `0.2.1-alpha.1`，保留稳定版默认安装。
- Adds DSH `0.2.1-alpha.1` support while retaining the stable install default.

- 修复代码高亮影响文件操作、面板重载丢失状态和历史加载失败；导航或发送被取代时保留草稿与附件。
- Fixes highlighting disrupting file actions, lost panel state and failed history loading; superseded navigation and sends preserve drafts and attachments.

## 0.2.10

- 接入 DSH `0.2.0-rc.2` 限时用户问题与迟到答案入队，并更新默认安装版本。
- Adds DSH `0.2.0-rc.2` timed questions and queued late answers, and updates the install default.

- 合并重复文件上下文，改善长会话首屏渲染。
- Deduplicates file context and improves initial rendering of long conversations.

- 修复设置内弹窗误关闭，保持长插件列表的操作可见。
- Fixes nested Settings dialogs closing the parent and keeps actions visible in long plugin lists.

## 0.2.9

- Chat 默认放在辅助侧边栏；移动视图命令打开原生选择器，升级保留已保存布局。
- Places Chat in the Secondary Side Bar by default and opens the native view-move picker; upgrades preserve saved layouts.

## 0.2.8

- 适配 DSH `0.2.0-rc.1`，更新默认安装版本，支持 Session V4 与可选 Schedule 能力。
- Adds DSH `0.2.0-rc.1` support, updates the install default and supports Session V4 and optional Schedule capabilities.

## 0.2.7

- 设置重新打开时读取最新配置；队列保存失败后保留输入，迟到响应不再覆盖当前界面。
- Refreshes Settings on reopen, preserves rejected queue edits and prevents late responses from replacing the current view.

- 改善窄栏弹层、键盘焦点、屏幕阅读器提示和中文标签；清除目标需确认。
- Improves narrow popovers, keyboard focus, screen reader feedback and Chinese labels; clearing a goal requires confirmation.

## 0.2.6

- 改进工具结果、折叠失败提示与审批样式，长会话输入更流畅。
- Improves tool results, collapsed failure indicators and approvals, with smoother typing in long conversations.

- 设置保存不再误改连接模式，修复 macOS 受管临时工作区清理误报。
- Preserves connection modes when saving Settings and fixes false managed-workspace cleanup failures on macOS.

## 0.2.5

- 完善 DSH `0.1.7-rc.2` 接入、提问和错误展示，修复 Windows 文件链接。
- Improves DSH `0.1.7-rc.2` integration, questions and error display, and fixes Windows file links.

- 扩展激活不再提前连接或检查更新，打开视图或显式连接后才执行。
- Defers connections and update checks until the view opens or the user explicitly connects.

## 0.2.4

- 提醒服务未启用时说明原因；改进会话搜索、空白草稿和归档恢复。
- Explains unavailable reminder services and improves session search, blank drafts and archive restoration.

- 插件设置支持分组搜索，安装状态可恢复；代码高亮支持 40 种按需语法。
- Adds grouped plugin search and recoverable install status, with 40 lazily loaded highlighting grammars.

## 0.2.3

- 插件安装在断线或取消后可按原请求恢复，结果未知时不重复安装。
- Recovers plugin installs after disconnection or cancellation without reinstalling when the outcome is unknown.

- 完善 RC2 会话升级、定时任务和后台输出支持；连接详情隐藏内部能力标识。
- Improves RC2 session upgrades, schedules and background output; connection details hide internal capability identifiers.

## 0.2.2

- 适配 DSH `0.1.7-alpha.1`，支持 Session V4、后台任务输出及停止，改善队列和预设恢复。
- Adds DSH `0.1.7-alpha.1` support with Session V4, background output and stop controls, and improved queue and preset recovery.

- 修复代码高亮、横向滚动 diff 和构建后的激活错误，缩小高亮资源包。
- Fixes syntax highlighting, horizontally scrolled diffs and activation after rebuilds, with smaller highlighting assets.

- 修复本地文件作用域与空工作区提示；浏览器激活请求可拒绝，完整浏览器插件仍不支持。
- Fixes local file scopes and empty-workspace messaging; browser activation can be declined, while full browser-plugin execution remains unsupported.

## 0.2.1

- 适配 DSH `0.1.6-alpha.1` 与 `0.1.6-alpha.2`，改进连接进度和失败重试。
- Adds DSH `0.1.6-alpha.1` and `0.1.6-alpha.2` support with improved connection progress and retries.

- 新增归档会话管理、原生工作区选择和 Skill 文档入口；完善动态插件配置、模型与预设选择。
- Adds archived-session management, native workspace selection and Skill documentation, with improved dynamic plugin settings, models and presets.

- 改善工具结果、检查点、队列、子代理和导出，修复窄栏布局及键盘交互。
- Improves tool results, checkpoints, queues, subagents and exports, with fixes for narrow layouts and keyboard interaction.

## 0.2.0

- 修复工具错误和文件链接重复展示，压缩读取预览与插件详情布局。
- Fixes duplicated tool errors and file links, with compact read previews and plugin details.

## 0.1.11

- 上游同步审计截至 `c291e796`：最新 DSH 发布仍为 `0.1.5-rc.2`，其后未发现本扩展消费的 Connection/Gateway、Cookie、`remote.mux` 或 Session v3 wire 变化；继续使用独立 `rc152` 精确适配，不虚构未发布的上游版本。
- 完善编辑器当前符号/诊断上下文、原生编辑器入口、工作区任务中心和故障诊断恢复；新增递归工具调用树，以及 read/diff/terminal/search/web 结构化预览和历史文件引用展示。
- 加固长会话事件顺序、重连/历史回放、Host-only 行、附件大小错误、导出覆盖竞态和发送错误详情；保持凭据、端点和文件操作留在 Extension Host。
- 本次发布前 `pnpm check` 通过 167 个测试文件（1390 个测试通过、1 个跳过），`pnpm build` 通过；真实 DSH/Webview 完整 smoke 仍按能力矩阵保留为未完成证据。
- The upstream audit at `c291e796` confirms that DSH `0.1.5-rc.2` remains the newest published runtime and that no consumed Connection/Gateway, Cookie, `remote.mux`, or Session v3 wire changed afterwards; the exact `rc152` adapter remains the supported entry.
- Adds editor symbol/diagnostic context, native editor actions, workspace task scope, diagnostics recovery, recursive tool-call trees, structured read/diff/terminal/search/web previews, and historical file-reference rendering.
- Hardens long-session ordering, reconnect/history replay, Host-only rows, attachment-size errors, confirmed export races, and user-visible send failures while keeping credentials, endpoints, and file operations in the Extension Host.

## 0.1.10

- 适配 DSH `0.1.5-rc.2`：新增独立 `rc152` 精确版本入口；沿用已核对的 Session v3
  传输，补齐消息反馈七分类、统一提交/撤销对话框以及紧凑交付物展示。
- Added the exact `0.1.5-rc.2` adapter on the verified Session v3 transport, with upstream
  feedback categories/dialog semantics and compact deliverable presentation.
- 上游适配通过全量自动门禁、VSIX 打包检查和真实 rc.2 基础 smoke；完整 VS Code Webview
  DOM、交互式交付物和长会话恢复验证仍按能力矩阵保留为后续工作。

## 0.1.9

- 适配 DSH `0.1.5-alpha.2` 与 `0.1.5-rc.1`：保留独立精确版本入口并沿用已核对的 Session v3 传输；补齐 `deliverables/presented` 文件交付事件、时间线展示以及 Host 安全打开/显示文件路径。
- 接入 `subagent/catalog` 持久目录事件，刷新活动父会话的子代理目录；新增事件、畸形载荷、版本选择和 Webview 回归测试。
- 受管 DSH 的 Web Profile 启动关闭默认浏览器交接；Web UI 仍仅通过 `dsh.openWebUi` 命令按需打开。
- Added exact `0.1.5-alpha.2` and `0.1.5-rc.1` adapters on the verified Session v3 transport, with delivered-file timeline cards and Host-mediated open/reveal actions.
- Added durable `subagent/catalog` refresh handling plus mapper, reducer, and Webview regression coverage. Automatic checks pass; real DSH/Webview smoke remains a release prerequisite.
- Managed Web Profile launches no longer hand off to the default browser automatically; `dsh.openWebUi` remains an explicit opt-in command.

## 0.1.8

- 补齐当前 npm 上列出的历史版本：`0.0.1-rc.1`、`0.0.1-rc.2`、`0.0.1-rc.5`、`0.1.0-rc.2`、`0.1.0-rc.3`；旧 `command.*`、`session/tasks`、Host invalidation/remote-event、时区字段和能力缺口均在独立 Adapter 中精确隔离，并新增脱敏契约回归。
- Added exact adapters for the five historical npm releases (`0.0.1-rc.1`, `0.0.1-rc.2`, `0.0.1-rc.5`, `0.1.0-rc.2`, and `0.1.0-rc.3`), including their legacy command/event/time-zone differences and explicit unsupported capability boundaries.
- 本轮仅完成历史 npm 包契约、源码适配和自动回归，五个历史版本尚未完成真实 DSH/VS Code live smoke；因此不把自动测试当作运行时兼容证明。

- 适配最新上游 tag/npm `dsh-v0.1.5-alpha.1` / DSH `0.1.5-alpha.1`：新增独立 `alpha151` Session wire v3 版本缝，严格校验事件信封与 surface 元数据，安全处理 `system/message`，并映射 PTC 事件；旧 rc/alpha 版本入口、wire 和兼容回退保持独立。
- Added a dedicated `alpha151` Session wire v3 adapter for upstream `dsh-v0.1.5-alpha.1`, including strict event-envelope/surface validation, Host-only system-message handling, and PTC event mapping; older rc/alpha adapters and fallback boundaries remain unchanged.
- 本次仅完成源码/tag 契约适配和自动回归，未切换安装默认，也未宣称真实 DSH/VS Code smoke 已完成。

## 0.1.7

- 适配已发布 DSH `0.1.3-alpha.2`：新增独立 `alpha132` Session v2 版本入口，严格透传 subagent `queue/steer` 的 `delivery` 字段，并保留旧版本不发送该字段的兼容边界。
- Added a dedicated `alpha132` Session v2 adapter for released DSH `0.1.3-alpha.2`, forwarding subagent `queue/steer` delivery strictly while keeping the field off older runtimes.

## 0.1.6

- 完成最新未发布 DSH `0.1.3-alpha.1` Session v2 的严格适配，补齐 transient/durable 结算、重连基线、abandoned 中断和未知版本安全降级回归。
- 加固本地 DSH 发现、连接恢复、Host/Webview 隐私边界、Provider/模型投影与跨平台路径处理；补充异常、畸形响应、取消和资源释放测试。
- 修复 durable 历史重建覆盖流式回答、混合 attempt、隐藏事件空态和更新提示布局问题；更新完成后提示自动收起并改为浮层显示。
- Completes the strict Session v2 adapter for the latest unpublished DSH `0.1.3-alpha.1` source contract, including transient/durable settlement, reconnect baselines, abandoned interruptions, and safe unknown-version fallback coverage.
- Hardens local DSH discovery, connection recovery, Host/Webview privacy boundaries, Provider/model projections, and cross-platform path handling with malformed-response, cancellation, and resource-release tests.
- Fixes durable history rebuilds overwriting live streams, mixed attempts, hidden-event empty states, and runtime update notice layout; completed updates now dismiss the notice and keep it out of document flow.

## 0.1.5

- 修复 Provider 列表经过 Host 脱敏投影后丢失 `secret` 元数据，导致设置页错误显示 `0 个 Provider`；已用真实 DSH `0.1.2-alpha.5` 响应完成端到端验证。
- 完成自定义 Provider 设置、凭据接线和模型发现链路，凭据继续只在 Extension Host 中处理。
- 完善 DSH alpha 版本适配、Provider/模型目录校验、会话恢复、插件和设置页回归覆盖，并改进主题下的 Provider 控件显示。
- Fixes Provider discovery being reduced to `0` after Host redaction removed the structural `secret` metadata flag; verified end to end against a real DSH `0.1.2-alpha.5` response.
- Completes custom Provider settings, credential wiring, and model discovery while keeping credentials in the Extension Host.
- Expands DSH alpha compatibility, Provider/model catalog validation, session recovery, plugin and settings regression coverage, and themed Provider controls.

## 0.1.4

- 新增 DSH `0.1.2-alpha.4` 与 `0.1.2-alpha.5` 的独立精确适配；按上游变更核对 Session、Connection/Gateway、Remote 错误和 Web Profile 启动边界，alpha 版本仍不作为安装默认。
- 将版本适配器整理为共享基础结构下的两条线性继承链：`rc.6 → rc.7 → rc.8 → rc.1 → rc.2` 与 `alpha.1 → alpha.2 → alpha.3 → alpha.4 → alpha.5`；未知未来版本（包括 alpha.6）先尝试最新已验证适配器，成功时保留真实版本并显示兼容性警告。
- 补充 alpha.4/alpha.5 契约、继承链、启动参数、运行时工具模式和畸形响应/取消/资源释放回归测试，并同步上游契约与发布文档。
- Adds independent exact adapters for DSH `0.1.2-alpha.4` and `0.1.2-alpha.5`; verifies the upstream Session, Connection/Gateway, Remote error, and Web Profile launch boundaries while keeping alpha releases out of the install default.
- Organizes version adapters into two linear inheritance chains over a shared base: `rc.6 → rc.7 → rc.8 → rc.1 → rc.2` and `alpha.1 → alpha.2 → alpha.3 → alpha.4 → alpha.5`. Unknown future versions, including alpha.6, are read-only probed from the newest verified adapter first; successful connections preserve the real version and show a compatibility warning.
- Adds alpha.4/alpha.5 contract, chain, launch, runtime tool-mode, malformed-response, cancellation, and resource-release regression coverage, with synchronized upstream-contract and release documentation.

## 0.1.3

- 新增设置页中的扩展版本信息，版本直接取自扩展清单；同时显示独立的 DSH 运行时版本，避免混淆两者。
- 完成 DSH `0.1.2-alpha.3` 的版本化适配，并为未识别但可探测的未来版本提供最新已验证适配器优先的尽力兼容路径；成功时保留真实运行时版本并显示兼容性警告。
- Adds the extension version to the settings summary from the installed manifest, while keeping it distinct from the connected DSH runtime version.
- Completes the versioned DSH `0.1.2-alpha.3` adapter and adds newest-verified-adapter-first best-effort compatibility for probeable future versions, preserving the real runtime version with a compatibility warning.

## 0.1.2

- 修复长会话历史回填、流式时间线和滚动跟随中的缺口，避免内容因乱序、恢复竞态或首帧布局时机而不可见；补充队列、运行态、会话恢复与跨层协议回归覆盖。
- 完善 Provider、模型、预设、插件、队列和运行时界面，补齐中文界面与窄窗口布局；设置中的本地外观支持亮色、暗色和跟随系统。
- 统一 Webview 颜色、代码标识、Markdown 代码块和滚动条的语义配色；跟随系统时继承 VS Code 主题，显式亮/暗模式不再出现黑色代码块或滚动条错配。
- Fixes missing content in long-session history backfill, streaming timelines, and scroll-follow behavior caused by out-of-order events, recovery races, and first-paint layout timing; adds regression coverage for queues, runtime state, session recovery, and cross-layer protocol paths.
- Improves Provider, model, preset, plugin, queue, runtime, Chinese UI, and narrow-window surfaces; Appearance now supports light, dark, and system preferences.
- Aligns Webview colors, code identifiers, Markdown code blocks, and scrollbars with semantic theme tokens; system mode follows VS Code's palette without dark code blocks or scrollbar mismatches in light mode.

## 0.1.1

- 修复输入框"+"号弹出菜单每次重新打开都会不断变小的问题：入场动画的缩放被写进弹窗测量尺寸并在多次打开间累积；所有锚定弹窗现在按布局尺寸定位，尺寸保持稳定。
- Fixes the composer "+" popover shrinking on every reopen: the entry animation's scale leaked into the measured popup size and accumulated across opens; all anchored popovers now position from the layout size and keep a stable size.

## 0.1.0

- 提升扩展启动、DSH 发现、会话恢复、流式时间线和长历史渲染性能，并加强缓存失效、异步竞态与资源释放测试。
- 修复 VS Code 恢复旧 Webview 文档时，根级动态模块指向过期构建文件并导致整个聊天视图加载失败的问题；核心界面现在由稳定入口一次加载。
- Improves extension startup, DSH discovery, session restoration, streaming timelines, and long-history rendering, with stronger cache-invalidation, async-race, and resource-release coverage.
- Fixes the full chat view failing when VS Code restores an older Webview document whose root-level dynamic modules point to replaced build files; core UI now loads from one stable entry.

## 0.0.9

- 稳定长会话时间线的虚拟化与滚动位置归属，保留消息顺序，降低快速滚动和大历史记录对 Webview 的影响；统一前端共享内容流、工具调用和选择面板的渲染边界。
- 改进连接重订阅、历史缺口补齐、alpha 交互状态、任务/变更作用域和检查点资源回收，避免恢复时重复、越界或遗留临时数据。
- 接入已发布 DSH `0.1.2-alpha.2` 的独立 Connection/Gateway 适配，兼容命名空间错误、可忽略事件和 agent-preset 插件组合投影；未改变 rc.6–rc.2 默认安装路径。
- Adds virtualized long-session timelines with stable scroll ownership and ordered message rendering, reducing Webview churn during fast scrolling and large histories while keeping shared content, tool, and selection surfaces consistent.
- Improves reconnect history backfill, alpha interaction state, task/change scoping, and checkpoint cleanup so recovery does not duplicate, cross boundaries, or retain temporary data.
- Adds a separate adapter for published DSH `0.1.2-alpha.2`, covering namespaced errors, ignorable events, and agent-preset plugin composition projections without changing the rc.6–rc.2 install default path.

## 0.0.8

- 加固本地 DSH 运行时发现、取消/超时处理、进程生命周期和错误诊断，降低配置、文档、附件及其他 Host 操作因异常调用失败的风险。
- 完善 DSH 兼容适配、响应/事件投影、工具、附件、会话和工作区处理，并补充跨层安全边界与回归测试。
- 完善中文界面、插件配置与列表展示；宽窗口支持插件多列布局，搜索输入框和状态配色与 Web UI 更一致。

- Hardens local DSH runtime discovery, cancellation and timeout handling, process lifecycle management, and diagnostics to reduce failures in configuration, documentation, attachment, and other host actions.
- Improves DSH compatibility adapters, response and event projections, tools, attachments, sessions, and workspaces with cross-layer boundary and regression coverage.
- Completes Chinese UI coverage and plugin configuration and inventory presentation; wide layouts now support multiple plugin columns, with a rounded search field and Web UI-aligned status colors.

## 0.0.7

- 接入 DSH `0.1.1-rc.2`，保留 `rc.6` 至 `rc.1` 的向下兼容与未知版本警告降级；按上游行为处理空白会话复用和图片附件边界。
- 改进 DSH 更新器：已安装的目标版本不重复安装，更新阶段显示确定性进度，并过滤 npm 弃用警告、保留可操作失败原因。
- 修复流式思考预览、工具来源重复、来源标题溢出和窄窗口 Composer/设置布局问题。

- Adds DSH `0.1.1-rc.2` while retaining compatibility from `rc.6` through `rc.1` and warning-based fallback for unknown versions; follows upstream blank-session reuse and image-attachment limits.
- Improves the DSH updater with no-op protection for an already installed target, determinate lifecycle progress, and actionable npm failure details without deprecation noise.
- Fixes streaming reasoning previews, duplicated tool sources, overflowing source titles, and narrow Composer/settings layouts.

## 0.0.6

- 完成 DSH rc.8 接入，同时保留 rc.6/rc.7 适配与未知版本的兼容降级；补齐工具、反馈、引用、模型、设置和运行时更新通路。
- 增加自动/自定义本地 DSH 端点选择、启动前运行时发现、更新版本选择与通知关闭，并修复流式时间线、工具包装和窄窗口布局问题。

- Completes DSH rc.8 integration while retaining rc.6/rc.7 adapters and a warning-based fallback for unknown versions; adds tools, feedback, references, model, settings, and runtime-update paths.
- Adds automatic or custom local DSH endpoint selection, startup runtime discovery, selectable updates with dismissible notices, and fixes streaming timelines, tool presentation, and narrow-Webview layout issues.

## 0.0.5

- 修复流式回复未及时刷新、工具调用被拆分隐藏以及任务完成状态误判，完成后可立即复制或创建分支。
- 补充会话、代码块和表格的复制操作，并保持任务进度、模式切换和中英文界面的一致展示。

- Fixes delayed streaming updates, hidden or split tool calls, and incorrect task termination state so completed replies immediately expose copy and branch actions.
- Adds copy actions for conversations, code blocks, and tables while keeping task progress, mode switching, and bilingual labels consistent.

## 0.0.4

- 完善 DSH rc.6 会话、事件时间线、队列、交互、附件、导出、目标、任务、子代理和工作流展示。
- 收紧上游响应与事件校验，改进断流恢复、资源释放、凭据脱敏和动态设置处理。
- 补充适配器契约、应用层、时间线、协议和 Webview 测试覆盖。

- Completes the DSH rc.6 session, event timeline, queue, interaction, attachment, export, goal, job, subagent, and workflow surfaces.
- Tightens upstream response and event validation, stream recovery, disposal, credential redaction, and dynamic settings handling.
- Expands adapter contract, application, timeline, protocol, and Webview test coverage.

## 0.0.2

- 首个公开版本：在 VS Code 中管理 DSH 会话、流式回复、折叠思考和连续工具调用。
- 支持 Windows、Linux、macOS 的本地 DSH 发现、工作区感知、会话恢复、权限/模式切换与斜杠命令。
- 提供缺失运行时引导、错误诊断、上下文用量展示和安全的 Extension Host 边界。

- First public release: manage DSH sessions, streaming replies, collapsed thinking, and grouped tool calls in VS Code.
- Supports local DSH discovery, workspace awareness, session recovery, permission/mode controls, and slash commands on Windows, Linux, and macOS.
- Includes guided runtime setup, actionable diagnostics, context usage, and a secure Extension Host boundary.

## 0.0.1

- 首个可用版本：在 VS Code 中管理 DSH 会话、流式回复、思考和工具进度。
- 支持 Windows、Linux、macOS 的本地运行时发现，以及 DSH 未安装时的安装/选择/文档引导。
- 支持安全的会话恢复、错误诊断和工作区上下文。

- First usable release: manage DSH sessions, streaming replies, thinking, and tool progress in VS Code.
- Supports local runtime discovery on Windows, Linux, and macOS, with guided setup when DSH is missing.
- Includes session recovery, safe diagnostics, and workspace-aware context.
