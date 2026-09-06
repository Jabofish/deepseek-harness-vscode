# Change Log

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
