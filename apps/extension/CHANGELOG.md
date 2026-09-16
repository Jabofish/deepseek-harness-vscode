# Change Log

## Unreleased

- 接入 DSH `0.1.6-alpha.1` 的精确 `alpha161` Adapter：复用已核对的 Session v3 基础 wire，`image/offload` 仅作脱敏 opaque 保留；新增 alpha surface（终端、权限预设、归档恢复、Skill 路径）未冒充为已完成，安装器默认仍为 `0.1.5-rc.2`。
- 修复最新 alpha 线上的工具卡、变更审阅与检查点：结算卡改由 `tool/result` 的 `meta` 形状派生，运行中的终端/变更卡由调用参数派生，已结算的 shell 行在调用与结果相遇处结算出输出与退出码（授权条因此能看到要批准的命令）；变更行接受宿主的绝对路径并聚合文件的全部 hunk；检查点保存创建时刻的整份文件字节，恢复按预览选择 `abort`/`overwrite`。
- 修复宿主合法文案被静默截断：适配层、渲染层与 Webview 解析不再低于宿主契约地截断工具正文、失败原因、团队消息、命令输入和列表尾部（被截断的列表写明省略数量）。
- 模型选择器显示会话目录里枚举失败的 Provider：失败原因按宿主原文完整呈现，已枚举成功的分组保持可用，宿主的目录失效事件同时刷新会话级目录。
- 当前模型没有适配器服务时，Composer 复用宿主的 `routable` 判定：输入变为惰性并显示「当前模型不可用」的原因，发送被拒绝但停止与模型选择器保持可用（选择可用模型即是出路）；该判定在 Provider 变化后按已提交配置重读，不会因旧判定锁住可用输入。
- 模型选择器只陈述宿主的事实：推理强度按适配器给的名字显示，会话未指名时用适配器声明的默认档，未声明默认时显示「提供方默认」而不是列表首项；换模型的请求只写路由、把强度交给适配器解析，回到默认档也能显式选择。目录查不到当前选择时按 `provider/model` 显示宿主标识，不再据此宣称模型「不可用」。
- 模型选择器陈述会话模型目录的读取本身：读取失败时按宿主原文说明原因并给出「重新读取」，读取进行中显示该状态；「本会话没有可用模型」只留给确实答出空目录的读取（此前某个 Provider 枚举失败会被误读成整目录为空），重读失败时保留上一次成功读取的模型行与失败行。
- 会话模型目录陈述会话**自己的**路由：适配层按参考客户端的规则从会话持久投影组合 `current`（`next ?? lastUsed`）并据此判定 `routable`，不再把部署级默认当成会话选择——默认 Provider 已下线而会话路由仍被服务时不再误禁输入，会话适配器消失而默认仍在线时也不再误放行；投影读不出时整次目录读取按协议错误失败，只有会话从未选过模型时才整份回落到目录默认（含其声明的强度）。模型选择器在会话未选模型时显示这条宿主路由，但它只是路由陈述而非会话选择，任何配置提交路径都不会把它写回。
- 修复一批交互与路由缺陷：绝对路径打开文件、子会话分页与父子路由、审批命令预览、Agent Teams 消息归并、队列编辑与 Steer 收敛、Skill 目录与命令附件参数、会话改名回执，以及非绝对 `dsh.runtime.executablePath` 导致扩展无法激活；同时加固 Webview 弹层的键盘/焦点/IME 交互、结构化预览与模型选择的展示映射、导出按选项过滤。
- 补充真实 DSH 的 live 证据（writes、frames、paging、tool-cards、change-hunks、consistency、attachment、export、subagent-child 及跨进程受管启动锁），`docs/dsh-contract.md` 与能力矩阵同步更新；本轮不 bump 扩展版本、不触发发布。
- Add the exact `0.1.6-alpha.1` (`alpha161`) adapter on the audited Session v3 base wire, keeping `image/offload` as a redacted opaque row; the new alpha surfaces (terminal, permission presets, unarchive, skill paths) are not claimed as done and the installer default stays `0.1.5-rc.2`.
- Fix tool cards, change review and checkpoints on the newest alpha line: a settled card comes from the shape of `tool/result`'s `meta`, a running terminal or mutation card from the call arguments, and a settled shell row from the output and exit status its own result states (which is what lets the approval strip name the command); change rows accept the host's absolute paths and carry every hunk of a file; a checkpoint snapshots the file's whole bytes as of creation and a restore picks `abort`/`overwrite` from the preview it showed.
- Fix host-legal text being silently truncated: the adapter, the render layer and the Webview parse no longer cut tool bodies, failure reasons, team messages, command input or a list's tail below the host contract (a capped list states how many items it omits).
- The model picker now shows providers the session directory could not enumerate: the host's reason is rendered whole, the groups that did load stay usable, and host catalog invalidations refresh the session-scoped directory too.
- When no adapter serves the session's current model, the Composer reuses the host's `routable` verdict: the input goes inert with the "model is unavailable" reason, a send is refused, and Stop plus the model picker stay reachable because choosing a served model is the way out; the verdict is re-read after the provider changes so a stale one cannot lock a usable input.
- The model picker states only the host's facts: a reasoning level is shown by the adapter's own name, a session that names none shows the adapter's declared default, and an adapter that declares none shows "provider default" rather than the first listed level; changing the model writes the route alone and lets the adapter resolve the effort, and returning to the default effort is an explicit choice. A selection the catalog does not list is named with the host's `provider/model` identifiers instead of being called unavailable.
- The model picker states the session model directory's own read: a refusal shows the host's wording with a "read again" action and a read in flight is shown as such, while "no models are available for this session" is reserved for a directory that really answered empty (a provider that failed to enumerate is no longer read as an empty catalog); a refused re-read keeps the model and failure rows an earlier read stated.
- The session model directory states the session's own route: the adapter composes `current` from the session's durable projection (`next ?? lastUsed`) and derives `routable` from it the way the reference client does, instead of restating the deployment default — a retired default provider no longer disables a session whose route is served, and a session whose adapter is gone is no longer let through on a live default; an unreadable projection fails the whole read, and the catalog default (with the effort it declares) is used only when the session never chose a model. The picker shows that host route while the session names none, but it is a routing statement and no configuration path writes it back.
- Fix a batch of interaction and routing defects: opening an absolute path, subagent paging and parent/child routing, the approval command preview, Agent Teams message merging, queue edits and Steer convergence, the skill catalog and command attachment arguments, the rename receipt, and a non-absolute `dsh.runtime.executablePath` that kept the extension from activating; also harden the Webview overlay keyboard/focus/IME interaction, structured and model-selection presentation, and option-aware export filtering.
- Add the real-DSH live evidence (writes, frames, paging, tool-cards, change-hunks, consistency, attachment, export, subagent-child, plus the cross-process managed-start lock) and update `docs/dsh-contract.md` and the capability matrix; no extension version bump and no release trigger in this round.

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
