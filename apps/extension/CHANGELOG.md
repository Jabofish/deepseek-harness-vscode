# Change Log

Release entries describe behaviour at that release. `Unreleased` lists changes awaiting publication. See [GitHub Releases](https://github.com/Jabofish/deepseek-harness-vscode/releases) for distributed VSIX files, the [user guide](https://github.com/Jabofish/deepseek-harness-vscode) for current operation and the [compatibility contract](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/docs/dsh-contract.en.md) for supported runtimes.

历史条目描述对应版本，`Unreleased` 不代表已经发布；当前使用方式、兼容范围和可下载资产分别以上述入口为准。

## Unreleased

## 0.4.1

- 长会话输出按面板消费确认推进，限制归约前缓冲与恢复重读；隐藏视图延后处理，未变化节点及全文缓存保持稳定。暂态缺口使用恢复预算和退避，控制消息丢失后保留可重试的 Job 输出及字节游标。
- Long conversations use per-panel consumption acknowledgements, bounded buffers before reduction and scoped recovery. Hidden views defer work; unchanged nodes and full-content caches stay stable. Transient gaps use recovery budgets/backoff, and control loss retains retryable Job output and byte cursors.
- 修复答题后表单残留和迟到重放：定时问题保留调用身份并整组结算，排队答复在面板重建后保持只读，Inbox 丢弃后可重新作答。
- Fixes stale question forms and late replay after answering. Timed calls settle as a batch; queued replies remain read-only across panel rebuilds and can be answered again after Inbox discard.
- 跟随系统及 VS Code 的减少动效和读屏模式，提供本地安静过程显示；保留流式回答、工具展开、提交计划与键盘焦点，减少重复进度和错误提示。
- Honors system/VS Code reduced motion and screen-reader changes, with a local Quiet process display. Preserves streaming answers, tool disclosure, submitted plans and keyboard focus while reducing repeated progress/error announcements.
- 会话行悬停或聚焦时不再反复换行和重排；标题按持久序号更新，重放旧标题不触发目录刷新。相同截断预览下的全文变化仍会更新。
- Session rows no longer re-wrap or resize on hover/focus. Titles follow durable sequence without stale replay refreshing the directory, and changed full bodies refresh even when clipped previews match.
- 补齐英文技术文档，更新中英文贡献指南、Agent 规范和测试说明。安装包由 GitHub Releases 提供，本版本不上传 Marketplace。
- Adds complete English contract/capability documentation and updates bilingual contribution guides, agent rules and testing instructions. This version is distributed through GitHub Release VSIX files without Marketplace publication.

## 0.4.0

- 新增可选的会话费用估算，支持官方参考价匹配、手动选择模型、自定义单价，以及带缓存的人民币／美元换算。
- Adds optional session cost estimates with official price matching, searchable reference models, custom rates and cached CNY/USD conversion.
- 完善 DSH 与编辑器配套插件的安装、更新和恢复流程，显示实时输出与实际结果，处理网络、代理、取消和缓存版本恢复。
- Improves DSH and editor companion installation, updates and recovery with live output, verified results, network and proxy handling, cancellation and cached-version recovery.
- 修复加载大历史会话时反复断线的问题，减少快照、长回复、代码高亮和统计中的重复计算。
- Fixes repeated connection drops when loading large histories and reduces repeated snapshot, transcript, highlighting and statistics work.
- 会话改为按需订阅，多个面板共享连接；继续跟踪后台任务和待处理交互，空闲会话自动释放订阅。
- Follows sessions on demand, shares subscriptions across panels, keeps background tasks and pending interactions updated, and releases idle subscriptions.
- 修正上下文占比、链接点击、提问选择与快捷键、工具错误折叠，以及重复的权限和模式切换提示。
- Fixes context proportions, link handling, question selection and keyboard submission, collapsible tool errors, and repeated permission and mode-change messages.

### Model billing / 模型计费

- 分时规则合并同一时段的上下限，并保留“且／或／排除”的含义。中文显示北京时间，英文显示 UTC；跨日时同步换算星期，价格有效期的显示和编辑也使用对应时区，保存与计算仍基于原始时间。
- Time rules combine bounds into complete intervals and preserve conjunction, alternatives and exclusions. Chinese displays Beijing time and English displays UTC, including shifted weekdays and price-validity editing, while storage and calculations retain the original instants.
- 在模型设置中按需开启。优先匹配官方参考价，支持官方账号别名、大小写及完整模型标识；不确定的匹配提供候选，也可搜索完整目录手动选择。用户选择和自定义单价优先保留。
- Enable estimates in Models settings. Official references are preferred, including account aliases, case variants and qualified model IDs. Ambiguous matches offer candidates and full-catalog search; explicit mappings and custom prices take priority.
- 可展开查看单价、缓存及时间、上下文、服务等级等计价条件。费用详情保留输入、输出和缓存分项，标明未计价原因；长历史达到读取预算时保留部分结果，读取失败可重试。
- Expand rates and cache, time, context and service-tier conditions. Cost details show input, output and cache subtotals with reasons for unpriced usage. Large histories retain partial estimates at the read budget, and failed reads offer retry.
- 中文显示人民币，英文显示美元，保留原始单价与费用。成功取得的汇率保存到本地；刷新失败时沿用上次报价和日期，无缓存时才按 1 USD = 6.8 CNY 换算并标注。
- Chinese displays CNY and English displays USD while retaining original rates and costs. Successful exchange quotes persist across restarts; failed refreshes reuse the last dated quote, with a labeled 1 USD = 6.8 CNY fallback only when no quote is available.
- 金额最多显示四位小数，极小金额显示阈值。窄面板在 Token 统计旁显示金额并在统计详情中展示分项，宽面板使用独立费用区块。金额和详情共享缓存，用量、设置或连接变化后刷新，失败保留上次结果。
- Amounts use up to four decimals and a threshold for tiny values. Narrow panels show cost beside token statistics with a breakdown in details; wider panels use a separate cost pill. Shared estimates refresh on usage, settings or connection changes and retain the last result on failure.

### Installation, updates and recovery / 安装、更新与恢复

- DSH 安装和更新显示阶段、耗时及原生实时输出，改进网络重试、超时清理、代理和证书错误反馈，沿用 npm 配置并在缺少环境代理时使用 VS Code 代理。长输出和 npm 警告不会单独判定安装失败；以进程退出和安装后版本验证确认结果，完成通知也可结束等待，重连后刷新当前版本，防止旧检查覆盖新结果。
- DSH installation shows stages, elapsed time and live native output, with improved retries, timeout cleanup, proxy and certificate feedback. It respects npm configuration and uses the VS Code proxy when no environment proxy is present. Large logs and npm warnings alone do not fail installation. Process exit and installed-version verification determine the result; completion events settle pending requests, and reconnects refresh the running version without stale checks overwriting it.
- 修复 Windows 独立版 pnpm 误判，跳过损坏的入口，支持 Corepack 补全、npm 回退和取消，重新检测成功后清除旧错误；受管理 DSH 优先使用检测通过的 pnpm，并处理子进程 PATH 大小写冲突。
- Fixes standalone pnpm detection on Windows, skips broken launchers, supports Corepack repair, npm fallback and cancellation, and clears stale dependency errors after rechecking. Managed DSH prefers the verified launcher and avoids conflicting PATH casing.
- 配套插件安装返回成功、失败、取消或结果未确认的实际状态，完成后刷新状态，推迟重启时保留提示。修复同路径 already-installed 导致反复回滚的问题，重装使用校验后的固定备用包路径，不先卸载；安装和恢复分别保留请求 ID、取消操作和启停状态，恢复失败时停止共享，迟到回显不覆盖当前操作。
- Companion installation reports success, failure, cancellation or an unconfirmed result, refreshes status, and retains deferred restart actions. Repair uses a verified immutable alternate package path for already-installed responses without uninstalling first. Install and recovery retain separate request identities, cancellation and enabled state; failed recovery stops sharing, and late responses cannot overwrite the current operation.
- 恢复重连不会重复触发失败的自动更新；手动恢复缓存版本会暂停自动更新，仍可主动更新。缓存按包内容去重，列表优先显示较新的包并区分同版本构建，保留已有安装路径与回滚包。依赖正常时隐藏多余说明，故障排查默认折叠。
- Recovery reconnects do not repeat a failed automatic update, and manually restoring a cached version pauses automatic updates until an explicit update. Cached packages deduplicate by content, list newer builds first and distinguish builds sharing a version while preserving installation and rollback paths. Routine dependency guidance stays hidden when ready; troubleshooting is collapsed by default.

### Sessions and performance / 会话与性能

- 保留可见、运行中和等待用户应答的会话订阅，空闲且不可见后延迟 30 秒取消，重开时加载历史。多个面板共享订阅，后台任务保留进度流并在重连后恢复；已结束子会话不再仅因父会话打开而回放。
- Visible, running and actionable sessions remain followed. Hidden idle sessions release after 30 seconds and reload history when reopened. Panels share subscriptions; background jobs retain progress streams and recover after reconnecting. Completed child sessions do not replay merely because their parent is open.
- 大快照按身份集合去重，解码、投影与控制器回放分批让出事件循环，避免阻塞心跳；取消和重启会释放待投递批次。长回复增量计算大小，历史文本按组组装，复用未变化的高亮、工具与正文数组，保留事件顺序、脱敏、协议校验及及时统计。
- Large snapshots deduplicate through identity sets, and decoding, projection and controller replay yield in batches to keep heartbeats responsive. Cancellation and restart release pending batches. Long replies use incremental size accounting, history text assembles per group, and unchanged highlights, tools and content arrays are reused while preserving event order, redaction, protocol checks and current statistics.

### Chat interactions / 会话交互

- 上下文条以完整窗口为 100%，分项只占已用比例，剩余容量保留底色；总容量未知时仅显示数值。
- Context bars use the full window as 100%, confine categories to the occupied share and leave remaining capacity unfilled. Unknown capacity keeps numeric details without a percentage bar.
- 行内代码包裹的完整 Markdown 链接可点击，文件引用保留显式链接的目标，避免重复打开。
- Complete Markdown links wrapped in inline code remain clickable. File references preserve explicit link targets and avoid opening two locations from one click.
- 自定义回答增加选择标记，聚焦输入框即选中；Ctrl+Enter / ⌘Enter 提交整组答案，普通回车换行，输入法选字和重复按键不误提交。
- Custom answers have selection controls and activate on focus. Ctrl+Enter / ⌘Enter submits the complete answer batch; Enter adds a line, and composition or repeated key events do not submit.
- 工具失败在所属工具组的折叠按钮和箭头标红，错误正文随工具详情收起。权限变更产生的内部通知不再作为可编辑引导输入；权限和计划切换成功提示不进入聊天，重开和重放也不会重复插入，真实失败仍保留。
- Failed calls mark their tool-group disclosure and arrow in red, with error text inside collapsible tool details. Internal permission context is excluded from editable steering input. Successful permission and plan changes stay out of chat and are not reinserted on reopen or replay; actual failures remain visible.

## 0.3.9

- V4 会话历史快照分批校验和转换，定期让出事件循环并避免重复校验，降低大量历史加载时因心跳响应延迟而断线的风险；诊断日志增加脱敏断线原因与 WebSocket 关闭码。
- Decodes V4 session history snapshots incrementally, yielding to the event loop and avoiding duplicate validation to reduce heartbeat disconnects while loading large histories. Diagnostics include sanitized connection-loss reasons and WebSocket close codes.

- 编辑器配套包升级到 `0.2.2`，采用跨版本兼容声明与可选 Host peer；通过服务和协议协商决定能力，不以 DSH 版本枚举限制安装，也不额外安装一套核心服务。保留构建指纹更新与原有协议。
- Updates the editor companion to `0.2.2` with broad runtime compatibility and optional Host peers. Services and protocol negotiation determine available capabilities without a DSH version allowlist or an extra core-service installation. Build fingerprint updates and the existing protocol remain available.

- 新增 DSH `0.2.1-rc.3` 精确适配器，核对固定发布源码的 Remote、Gateway、Session、设置、工具与启动契约；更新可选运行时版本，引导安装默认继续使用稳定通道的 `0.2.1-rc.2`。
- Adds an exact DSH `0.2.1-rc.3` adapter after comparing its pinned Remote, Gateway, Session, settings, tools and launch contracts. Runtime updates offer the new version; guided installation retains stable-channel `0.2.1-rc.2`.

- 新版新会话回到工作区内已有空白草稿，按显式预设隔离 Creator 与普通草稿；保留已有模型选择，合并重复点击，采用 Host 实际返回的会话，并校验工作区归属及连接代次。
- New Session on the new runtime returns to an existing workspace blank and matches explicit presets so Creator keeps ordinary drafts separate. It preserves the existing model choice, coalesces repeated clicks, follows the Host's actual result, and checks workspace ownership and connection identity.

- 动态承接官方模型目录、百万上下文与模型目录超时／缓存配置；新增精确版本、草稿、错误、协议和隔离运行回归。浏览器专用插件插槽仍由 DSH Web UI 承载，VS Code 使用原生视图与已有插件管理入口。
- Consumes the official model catalog, million-token context metadata and listing timeout/cache settings dynamically, with exact-version, draft, error, protocol and isolated-runtime regressions. Browser plugin slots remain in DSH Web UI; VS Code uses native views and the existing plugin manager.

## 0.3.8

- 修复空 VS Code 窗口安装编辑器配套时因保存工作区设置失败而立即终止的问题；未打开文件夹时保存到用户设置，安装、关闭与只读控制均可使用。
- Fixes companion installation and off/read-only controls in empty VS Code windows by saving preferences to user settings when no workspace is open.

## 0.3.7

- 依赖缺失或损坏时可直接安装／修复 pnpm，验证可运行后重启扩展自有 DSH；准备过程支持取消，配套插件仍由用户明确发起首次安装。
- Adds cancellable pnpm preparation and repair, verifies the executable and reconnects the managed DSH. First companion installation remains an explicit user action.

- 安装前显示并检测 pnpm 依赖，提供安装命令、官方指南与重新检测；安装按钮根据 DSH 原生记录区分首次安装和修复，不再把安装意愿当成安装成功。迁移时仅清理旧 loader/overlay，保留缓存与会话数据。
- Checks pnpm before installation and provides setup commands, official guidance and rechecking. Native DSH records distinguish first installation from repair; migration removes only retired loader/overlay files while preserving archives and session data.

- 补齐桌面启动时的 pnpm/fnm 路径，安装失败在设置中保留 DSH 安全错误分类；修正重启可代替安装及强制保存原有未保存内容的旧提示。
- Restores pnpm/fnm paths for desktop launches and retains native installation failure categories in settings; corrects stale restart and unsaved-buffer descriptions.

- 编辑器配套通过 DSH 标准插件管理器安装、升级和取消，不再注入本地文件 overlay；配套包提供原生中英文标题和描述。安装面板保留进度、取消及未知结果恢复，取消过晚时按 DSH 实际结果显示。
- Installs, updates and cancels the editor companion through DSH's standard plugin manager instead of a local-file overlay. The package exports native English/Chinese metadata; settings show progress, cancellation and recovery without claiming a late cancellation succeeded.

- 重复排队相同内容时，一个无请求标识的队列项只确认一次发送，重复快照不再提前隐藏其他待发送回执。
- Keeps identical queued submissions distinct when runtime rows lack request identities, including across repeated snapshots.

- Markdown 代码块随栏宽自动换行，长标识符也可折行；流式与完成后的显示一致，保留缩进和复制原文。
- Markdown code blocks wrap to the available width, including long identifiers, during streaming and after completion while preserving indentation and copied source text.

- 会话历史补齐与重试提示改为显示在正文上方，修复刚进入会话时正文被挤到右半边、同步完成后才恢复宽度的问题。
- Stacks history loading and retry notices above messages so opening a session keeps content at full width throughout synchronization.

- 聚焦布局的标准和紧凑视图不再为每次模型请求重复显示首 Token 与生成速度；整轮 Token 用量保留一次，逐请求指标在详细或完整视图中查看。
- Focused standard and compact views no longer repeat first-token and generation-rate headers for every model request. Completed Turn token totals remain available once; detailed and verbose views retain request metrics.

- 新会话的创建回执已确认预设和模型、且没有额外权限或 Plan 选择时，不再重复配置读取；显式配置、复用会话与失败重试仍先完成配置再发送。
- Skips redundant configuration reads when a fresh create receipt confirms the preset/model and no additional permission or Plan choice was made. Explicit choices, reused sessions and retries still configure before sending.

- 会话和工作区目录变化只刷新对应目录，不再连带重复读取模型、设置和凭据；全局目录继续由启动、显式刷新和各自的变更事件更新。
- Session/workspace membership changes refresh their directory without repeating model, settings and credential reads. Startup, explicit refreshes and catalog change events continue to update global directories.

- 任务状态变化只发送一次失效通知，前端复用进行中的读取并核对最新状态；文本、推理和工具进度不再触发任务与会话历史的重复拉取。
- Task changes invalidate the view once, share in-flight reads, and reconcile the latest state. Streaming text, reasoning and tool progress no longer trigger repeated task and session-history reads.

- 会话内容到达后立即投递，不再等待上一条 IPC 回执；保留有界背压，工具上下文随调用发送，失败后立即有界恢复。发送获确认后立即释放输入框，编辑器配套准备不阻塞发送，停止复用当前连接和工作区下已验证的会话归属。
- Delivers conversation updates without serial IPC receipt waits, retains bounded backpressure, sends active tool context immediately, and retries failed delivery without a fixed delay. Accepted sends release the composer immediately; optional editor setup and advisory ownership refreshes no longer hold up ordinary sends or verified session stops.

- 自动读取完整会话内容期间明确提示当前显示尚未完整，读取成功后移除提示，无需用户额外操作。
- Marks content as incomplete while it is read automatically and clears the status once complete, with no additional user action.

- 实时审批与提问缺少答复标识时触发协议恢复，不再显示无法答复的交互；已失效请求与工作区权限拒绝使用不同错误。
- Recovers malformed live approvals and questions without inventing response identities, and distinguishes expired interactions from workspace access denial.

- 审批保留完整命令行，并自动补齐被传输裁切或移出当前窗口的工具请求；读取完成前仍可拒绝，批准等待完整请求就绪。
- Preserves complete approval commands and automatically reads clipped or off-window tool requests. Rejection remains available while approval waits for complete request content.

- 编辑器写入回执异常时核对实际缓冲区，保留已应用或结果不明的撤回快照；工具预先声明编辑容量与批次数量上限。
- Retains undo snapshots for applied or uncertain native edit outcomes and declares edit size and batch limits before execution.

- 编辑器配套修改和撤销不再连带保存用户的未保存内容；应用或路径校验期间新增的缓冲区修改也不会被自动保存，回执明确保留 saved:false。
- Editor companion edits and reverts preserve unsaved user buffers, including changes made while applying or validating an edit, and report saved:false explicitly.

- 预设失效时明确拒绝发送，不再静默换成其他模式；刷新目录不改写已有会话或草稿的选择，空目录不再补造 standard 预设。
- Rejects unavailable preset choices without substituting another mode. Catalog refreshes preserve session and draft choices, and empty catalogs no longer invent a standard preset.

- 保留 Windows 负数退出码；退出码为 null 或无法可靠表示时展示原始结果，不再误报为退出成功。
- Preserves negative Windows exit codes and keeps unknown exit markers in the result instead of reporting a clean exit.

- 首条消息发送前先应用草稿中选择的权限、Plan 和会话配置；配置失败或取消时保留草稿与已创建的会话，不继续投递。
- Applies staged permission, Plan and session choices before the first message. Configuration failures or cancellation retain the draft and created session without admitting the prompt.

- 修复 Windows 冷启动超过 15 秒即被误判失败的问题；启动和连接请求使用匹配的有界等待，取消仍立即生效。
- Allows slow Windows cold starts to finish with aligned startup and connection deadlines while retaining immediate cancellation.

- 长提示词的回显被省略且缺少请求标识时，重读全文确认投递，避免已发送内容卡在输入框；右键复制补齐长回复，并防止迟到的读取覆盖较新的复制操作。
- Confirms delivery of clipped long prompts without request identities by rereading their full content. Context-menu copying retrieves complete replies and ignores reads superseded by a newer copy gesture.

- 工具对象不再误用日志采样限制，完整保留参数、返回字段、换行、数组和深层内容；脱敏后不适合专用卡片的安全正文仍在会话内显示。畸形全量时间线触发自动重读恢复。
- Separates complete tool content from diagnostic sampling, preserving arguments, result fields, whitespace, arrays and nested data. Keeps safe output readable when redaction prevents a specialized card, and recovers malformed full transcript windows automatically.

- 正文、思考和工具结果在主会话内自动补齐；取消“查看全文”和菜单补取入口，保留会话内折叠，展开即显示全部已收到内容。长数组、工具分组及代码、终端和搜索结果不再因展示限制缺项。发送排队输入期间仍可独立停止当前回复。
- Automatically completes prose, reasoning and tool results inside the conversation, with inline disclosures and no full-content menu. Removes display limits on arrays, grouped tools, code, terminal and search output. Keeps Stop response available during a pending queued send.

- 修复待建草稿串入已有会话、取消发送后迟到消息仍保留草稿，以及附件读取、移除和超时期间的投递竞态。
- Keeps new-chat drafts with their intended conversation, clears late accepted drafts after cancellation, and protects attachments across ingestion, removal and send timeouts.

- 控制消息部分投递失败时恢复漏收的聊天面板；恢复会重读连接和交互状态，不因此启动或重连 DSH。
- Recovers chats that missed control messages, including partial broadcasts across multiple views, by rereading connection and interaction state without starting or reconnecting DSH.

## 0.3.6

- 编辑器配套改为用户主动安装：在设置中选择“安装并启用配套插件”后才加载，F5 同样遵循此选择；安装后继续随扩展更新，后台不再自动安装插件包。
- Makes the editor companion opt-in through Settings → General → Editor integration. F5 respects the same choice; enabled installations continue to follow extension updates, without background package installation.

- 加载提示词模板列表不再自动创建 `.dsh-vscode/prompts`；仅明确保存工作区模板时创建目录，已有模板保持可读。
- Stops creating `.dsh-vscode/prompts` while loading template lists. The directory is created only when explicitly saving a workspace template; existing templates remain readable.

## 0.3.5

- 编辑器配套随扩展打包并自动更新；F5 加载当前构建，常规升级自动检测旧配套。Webview 设置提供读写开关、修复、重试和撤销，无需另行安装或逐会话启用。
- Bundles and automatically updates the editor companion, including every F5 build. Webview settings provide access controls, repair, retry and undo without separate installation or per-session enable commands.

- 修复新会话因工作目录不同或缺少目录信息而无法绑定编辑器工具的问题；工具按当前窗口已信任的文件夹工作。首次调用缺少文件夹或信任时主动提示，设置页提供直接操作入口，工具卡保留具体失败原因。
- Binds editor tools for new sessions independently of their working directory. Access stays within this window's trusted folders; the first tool request offers folder/trust setup when needed, with direct settings actions and safe failure details.

- 修复从初始页打开会话后“会话 / 轨迹”切换入口缺失的问题；本地视图切换不再依赖 Coding Tools 开关或设置读取成功，迟到的设置回包也不会重置当前视图。
- Keeps Chat / Trajectory tabs available after opening a session from the initial page, independently of Coding Tools and settings availability; late settings replies preserve the selected view.

- 修复加载较早历史时整页替换、较新消息消失的问题：Host 按消息 ID 向上合并，保留实时更新；恢复触顶加载并按可见消息锚定视口。
- Prepends older history without replacing newer messages, preserves live updates, restores loading at the top and anchors scrolling to the visible message.

- 空闲发送留在输入框，直到正式消息出现，不再闪入排队面板；发送中的按钮显示可取消的加载圈，支持取消首发和命令请求。精简编辑工具说明，明确分页坐标、自动保存与重试规则。
- Keeps idle sends in the composer until their durable message appears, with a cancellable loading indicator instead of a transient queue row. Adds request cancellation and concise editor-tool instructions for paging, coordinates, saving and retries.

- 修复编辑已生效却被旧 pending/版本校验拒绝的问题；返回可查询的回执并自动保存文件，saved:false 明确表示已修改但保存失败，不建议重发。区分未知回执、缺失文件、越界和文件访问错误；打开文件支持省略路径，文档读取默认分页并保留准确的 UTF-16 游标。
- Fixes applied edits being rejected by obsolete pending-only validation. Returns queryable receipts and automatically saves files, reporting applied/saved:false when saving fails. Distinguishes missing receipts/files, invalid ranges and file access errors; supports the active editor for navigation and bounded reads with exact continuation positions.

- 排队正文改为多行编辑，Enter 换行，Ctrl/Cmd+Enter 或失焦保存。条目离队后保留只读正文与附件，直到正式消息进入时间线，避免显示空档；按消息 ID 衔接，不重复发送或生成虚假消息。
- Adds multiline queued-prompt editing and retains read-only text and attachments during the handoff to the authoritative transcript. Enter inserts a newline; Ctrl/Cmd+Enter or blur saves. Handoff uses message IDs without resending input or inventing transcript rows.

- 修复排队消息因会话状态短暂变化而消失、多条正文默认被折叠的问题；同一连续工作过程共享一个标题和展开状态，不再把每个虚拟列表分片显示成独立过程。
- Keeps pending queue text visible across transient session status changes and expands queued messages by default. Continuous work shares one disclosure across virtual rows instead of repeating a process header per segment.

- 正常自动连接会校验配套构建指纹，扩展升级后自动切换旧配套；F5 每次构建并启动加载当前配套的专用实例，无需手动安装或修改版本号。显式外部连接保持用户选择，切换失败时保留聊天。
- Compares companion build fingerprints during automatic connection so extension updates replace stale integration. F5 rebuilds and loads current source in a fresh owned runtime without a package version bump. Explicit external targets remain selected; failed replacement retains chat.

- 编辑器配套随扩展打包，受信工作区默认自动连接；在 Webview「设置 → 常规 → 编辑器集成」中调整读写、自动配置并重试连接，无需另装插件或逐会话运行启用命令。首条工具调用会等待自动绑定，连接完成后恢复共享。
- Bundles the editor companion for automatic setup in trusted workspaces. Settings → General → Editor integration controls access, automatic setup and recovery; no separate package installation or per-session enable command is required. First tool calls wait for session binding and sharing resumes after connection attachment.
- 支持多根工作区、未保存文档与选区、诊断、符号、定义、引用、导航和直接编辑。编辑后自动保存整个文件，可使用 VS Code 撤销或撤回 Agent 改动；读写范围与错误恢复均保持有界。命令面板收敛为六个日常入口，其余操作移入界面或上下文菜单。
- Supports multiple workspace folders, unsaved document and selection reads, diagnostics, language navigation and direct edits. Edits save automatically and support native Undo and independent revert. Keeps six everyday Command Palette entries; management and contextual actions are available from their relevant UI.
- 按配套协议协商可用能力；旧版、缺少配套或不兼容的 DSH 保留普通聊天和可用能力，设置中提供恢复入口。外部 DSH 不会被自动重启或安装接管。
- Negotiates optional editor capabilities independently of the DSH version. Missing or incompatible support leaves ordinary chat available with recovery actions in Settings. External DSH processes remain outside automatic installation and restart management.

## 0.3.4

- 修复会话标题不同步、Agent 与 Creator 被错误禁用，以及目标、队列和后台任务恢复后仍提示读取失败的问题。
- Fixes stale session titles, incorrectly disabled Agent and Creator choices, and read-failure notices that persisted after goals, queues or jobs recovered.

- 优化窄栏单行布局、标题留白和发送图标；当前文件入口常驻，附件按需展开，列表保持单行，高度平滑变化，加载不再反复拉动会话。
- Refines compact composer layouts, header spacing and send icons. Keeps the current-file shortcut visible, reveals attachments on interaction, and smooths height changes without loading-induced transcript jumps.

- Web UI 默认在 VS Code 内置浏览器打开，可切换系统浏览器；修复登录参数编码导致的认证失败。
- Opens the Web UI in VS Code's integrated browser by default, with a system-browser option, and fixes login-query encoding that prevented authentication.

## 0.3.3

- 改善流式增量传递，修复突发输出和重复基线造成的停顿；减少会话切换、首发与搜索等待，移除发送和滚动跟随的固定延迟。
- Improves incremental streaming through bursts and repeated baselines; reduces session-switch, first-send and search waits, and removes fixed send and scroll-follow delays.

- 加快连接启动，auto 优先校验上次连接，减少重复发现；手动地址与端口严格生效，失败后可修改设置重试；修复断连旧数据回填和会话目录重复加载。
- Speeds up startup with last-connection validation and less repeated discovery. Explicit targets stay strict and editable after failure; fixes stale reads after disconnect and repeated session-list loading.

- 统一紧凑布局、表单与提示，修复裁切和焦点；连接页增加加载圈与可展开的四行日志，窄栏优先保留会话和设置。可从默认隐藏的原生会话列表拖拽分栏。
- Unifies compact layouts, forms and messages; fixes clipping and focus, adds a loading ring with four-line expandable logs, and prioritizes Sessions and Settings in narrow views. Supports drag-to-split from the optional native session list, hidden initially.

## 0.3.2

- 重构长会话与流式传输：移除旧历史引擎，使用 Host 有界视图和 DSH 权威数据；修复分段输出、启动闪烁及完成状态残留。
- Reworks long conversations and streaming around bounded Host views and authoritative DSH data; removes the legacy history engine and fixes delayed output, startup flicker and stale completion state.

- 新增复用已有连接的编辑器会话标签；运行中保留输入、中断及模型和权限调整，修复跨窗口取消串扰。
- Adds editor chat tabs with shared connections; keeps input, Stop, model and permission choices available while running and isolates cancellation between windows.

- 精简审批、任务、通知和输入面板，修复窄栏挤压、菜单样式、弹层定位与焦点；删去重复说明。
- Compacts approvals, tasks, notices and the composer; fixes narrow layouts, menu styling, overlay placement and focus, and removes repetitive explanations.

- 适配并默认安装 DSH `0.2.1-rc.2`，补齐后台任务事件，改善旧历史兼容、断线恢复和慢速安装。
- Supports and installs DSH `0.2.1-rc.2` by default, adds missing Job events, and improves legacy-history compatibility, reconnection and slow installs.

已知问题：从会话列表拖到编辑器分栏可能被 VS Code 拒绝，尚未完成实际拖放验收。暂用会话行的“在编辑器区打开”或命令面板入口。
Known issue: VS Code may reject session-row drops into editor groups; native drag-to-split has not passed acceptance. Use **Open in Editor Area** or **DSH: Open Chat in Editor Area** for now.

感谢 [ggeorgovassilis](https://github.com/ggeorgovassilis) 的多窗口与界面贡献（[PR #4](https://github.com/Jabofish/deepseek-harness-vscode/pull/4)、[PR #5](https://github.com/Jabofish/deepseek-harness-vscode/pull/5)、[PR #6](https://github.com/Jabofish/deepseek-harness-vscode/pull/6)）。Thanks to ggeorgovassilis for the multi-window and UI contributions.

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
- 发布前 `pnpm check` 通过 167 个测试文件（1390 个测试通过、1 个跳过），`pnpm build` 通过；完整真实 DSH/Webview smoke 尚未完成。
- Before this release, `pnpm check` passed across 167 files (1390 tests passed, one skipped) and `pnpm build` passed. Full native DSH/Webview smoke remained incomplete.
- The upstream audit at `c291e796` confirms that DSH `0.1.5-rc.2` remains the newest published runtime and that no consumed Connection/Gateway, Cookie, `remote.mux`, or Session v3 wire changed afterwards; the exact `rc152` adapter remains the supported entry.
- Adds editor symbol/diagnostic context, native editor actions, workspace task scope, diagnostics recovery, recursive tool-call trees, structured read/diff/terminal/search/web previews, and historical file-reference rendering.
- Hardens long-session ordering, reconnect/history replay, Host-only rows, attachment-size errors, confirmed export races, and user-visible send failures while keeping credentials, endpoints, and file operations in the Extension Host.

## 0.1.10

- 适配 DSH `0.1.5-rc.2`：新增独立 `rc152` 精确版本入口；沿用已核对的 Session v3
  传输，补齐消息反馈七分类、统一提交/撤销对话框以及紧凑交付物展示。
- Added the exact `0.1.5-rc.2` adapter on the verified Session v3 transport, with upstream
  feedback categories/dialog semantics and compact deliverable presentation.
- 适配通过全量自动检查、VSIX 打包检查和真实 rc.2 基础 smoke；完整 VS Code Webview
  DOM、交互式交付物和长会话恢复尚待验证。
- Adaptation passed the full automated checks, VSIX packaging checks and a basic native rc.2 smoke.
  Full Webview DOM, interactive deliverables and long-session recovery validation remained open.

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
- 五个历史版本已完成 npm 包契约、源码适配和自动回归；真实 DSH/VS Code live smoke 尚未完成。
- The five historical versions have package/source contracts and automated regressions; native DSH/VS Code smoke remained incomplete.

- 适配最新上游 tag/npm `dsh-v0.1.5-alpha.1` / DSH `0.1.5-alpha.1`：新增独立 `alpha151` Session wire v3 版本缝，严格校验事件信封与 surface 元数据，安全处理 `system/message`，并映射 PTC 事件；旧 rc/alpha 版本入口、wire 和兼容回退保持独立。
- Added a dedicated `alpha151` Session wire v3 adapter for upstream `dsh-v0.1.5-alpha.1`, including strict event-envelope/surface validation, Host-only system-message handling, and PTC event mapping; older rc/alpha adapters and fallback boundaries remain unchanged.
- 此项适配保留原安装默认；已完成源码/tag 契约和自动回归，真实 DSH/VS Code smoke 尚待验证。
- This adaptation retained the installation default and added source/tag contracts and automated regressions. Native DSH/VS Code smoke remained to validate.

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
