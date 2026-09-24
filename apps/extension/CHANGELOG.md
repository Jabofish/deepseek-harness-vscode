# Change Log

## 0.2.3

- 聊天代码高亮改为随流增量渲染：已闭合的围栏代码块在消息仍在输出时就上色，正在书写的那一行保持纯文本、下一行闭合后立即换成高亮；每个代码块按文本缓存着色结果，只有在增长到一定步长时才重新分词，高亮不再等到整条消息输出完毕。回归覆盖「完成行切换时不闪断」与「闭合围栏提前上色」，真实 Webview 浏览器复验待补。
- Chat code highlighting now renders incrementally while a message streams: a closed fenced block is colored while the rest of the message is still arriving, the line being written stays plaintext and switches to highlighted as soon as the next line closes, and each block caches its colors by text so it is re-tokenized only after enough growth. Highlighting no longer waits for the whole message to finish. Regressions cover the completed-line carry-over and the early highlight of a closed fence; a real-Webview browser re-check is still pending.

- 同步上游至 `dsh-v0.1.7-rc.1`：新增 `0.1.5-rc.3`、`0.1.7-alpha.2`、`0.1.7-rc.1` 三个独立精确 Adapter；alpha.2/rc.1 在普通会话和子代理历史中按上游 `turnWindow` 分页，补洞等严格读取保持原语义，rc1 已核实启用 Job Controller。Installer 默认改为精确 `0.1.5-rc.3`。上游缺少历史会话与非空 Job 的可复现运行验证，相关能力保持 PARTIAL。
- Synced upstream through `dsh-v0.1.7-rc.1`: added separate exact adapters for `0.1.5-rc.3`, `0.1.7-alpha.2`, and `0.1.7-rc.1`. Alpha.2/RC1 use the upstream `turnWindow` for ordinary session and subagent transcript paging while strict recovery reads keep their existing semantics; the shipped RC1 web profile was verified to activate Job Controller. The installer now targets exact `0.1.5-rc.3`. Live validation still lacks a historical session and non-empty Job, so those capabilities remain PARTIAL.

- 连接详情不再显示能力 ID、适配/回退状态等内部信息，Extension Host 也不再将能力档案发送给 Webview；DSH 版本和连接设置入口保留。
- Connection details no longer expose internal capability IDs or adapter/fallback statuses, and the Extension Host no longer sends the capability profile to the Webview. The DSH version and connection settings entry remain available.

## 0.2.2

- 修复聊天 Markdown 中 HTML、Python 等已标记代码块仍显示为灰色：Webview CSP 放行内联 `style` 属性以承载 Shiki token 颜色，打包样式表与 nonce 脚本的限制保持不变，模型原始 HTML 仍被禁用；补充浏览器 CSP 验证和界面回归测试。
- Fixed labeled HTML, Python, and other chat code blocks appearing monochrome: the Webview CSP permits inline `style` attributes for Shiki token colors while retaining packaged-stylesheet and nonce-script restrictions; raw model HTML stays disabled. Browser CSP and rendering regressions were checked.

- 修复工具变更预览的新增/删除行背景在横向滚动后消失：整份 diff 共用完整可滚动宽度，短行的着色也能延伸到长行末端。
- Fixed added/removed line backgrounds disappearing when horizontally scrolling a tool diff: all rows now share the full scrollable content width, so short rows remain colored through the end of long lines.

- 修复 DSH `0.1.7-alpha.1` 适配回归：Job 跟读正常结束不再误报失败，恢复跟读保留已显示输出，立即停止可取消尚未完成的启动；Session V4 历史中的 `tool/result` 与实时流一致，`session/control` 重连基线可删除旧 projection。禁用预设选择或切换连接时不再沿用旧预设状态；归档失败会向用户提示，畸形预设元数据会在 Webview 边界被拒绝。以上有自动回归覆盖，但同一 Job、同一 offset 的旧/新 `opened` 帧尚缺协议代际标识，非空真实 Job 与 VS Code 现场验证仍未完成。
- Fixed DSH `0.1.7-alpha.1` adaptation regressions: normal Job-follow completion no longer reports failure; resumed follow retains displayed output, and immediate stop cancels a pending start. Session V4 history now maps `tool/result` consistently with the live stream, and a reconnect control baseline removes stale projections. Disabled preset selection and connection changes no longer reuse stale preset state; archive failures are surfaced, and malformed preset metadata is rejected at the Webview boundary. Automated regressions cover these paths, but identical-offset old/new Job `opened` frames still lack a protocol generation identifier, and non-empty live Jobs plus VS Code interaction remain unverified.

- 修复重新构建后在开发宿主中一激活就报错 `The argument 'filename' must be a file URL object, file URL string, or absolute path string. Received undefined`：扩展以 CJS 单文件打包，esbuild 会把 `import.meta` 置空，而上游 `@deepseek-ai/*` 模块在求值时就调用 `createRequire(import.meta.url)("../package.json")` 读取自身版本，于是激活期抛出 `ERR_INVALID_ARG_VALUE`；构建期插件现改为按上游清单内联真实版本号，遇到无法翻译的 `import.meta` 用法或产物中残留的 `import.meta.url` 读取都会直接让构建失败。
- Fixed the error dialog shown as soon as the extension activates in a development host after a rebuild, `The argument 'filename' must be a file URL object, file URL string, or absolute path string. Received undefined`: the extension bundles to a single CJS file, where esbuild replaces `import.meta` with an empty object, while an upstream `@deepseek-ai/*` module calls `createRequire(import.meta.url)("../package.json")` during its own evaluation to read its version, so activation threw `ERR_INVALID_ARG_VALUE`. A build-time plugin now inlines the version the upstream manifest declares and fails the build on any `import.meta` use it cannot translate or on an emitted bundle that still reads `import.meta.url`.

- 代码高亮改为按需语法白名单：Webview 只为 18 种常用语法生成懒加载分块（此前打包 Shiki 全量 bundle 的 300+ 个分块），其余语言与未知名按纯文本渲染；VSIX 由 693 个文件降到 97 个，Webview 的 sourcemap 不再随包发布（本地构建仍保留，供 DevTools 使用）。
- Code highlighting now uses a bounded grammar whitelist: the Webview ships lazy chunks for 18 common languages instead of the 300+ chunks of Shiki's full bundle, and any other or unknown language falls back to plaintext. The VSIX drops from 693 files to 97 and stops publishing the Webview sourcemaps (local builds keep them for DevTools).

- 修复代码高亮在真实 Webview 中一直静默失效：CSP 不含 `wasm-unsafe-eval`，浏览器拒绝 WebAssembly 编译，Shiki 的 Oniguruma 引擎从未启动，每个代码块都退化成纯文本；现改用不依赖 WebAssembly 的 JavaScript 正则引擎，18 种语法在 Chromium + 同一 CSP 下逐一验证通过，未知名仍按纯文本渲染。
- Fixed code highlighting silently doing nothing in the real Webview: the CSP has no `wasm-unsafe-eval`, so the browser refused every WebAssembly compile, Shiki's Oniguruma engine never started, and each code block degraded to plaintext. The highlighter now uses the WebAssembly-free JavaScript regex engine; all 18 bundled grammars were verified in Chromium under the same CSP, with unknown languages still rendering as plaintext.

- 接入上游 DSH `0.1.7-alpha.1` 的独立 `alpha171` Adapter：严格校验 Session V4、接入独立 Job 全量列表流、按 UTF-8 字节偏移跟读输出并支持人工停止，UI 操作由精确能力标记门控；旧版继续使用原有只读 Jobs 行为。补齐 registry-only preset/plugin inventory 字段映射与权限预设限制。Job 跟读/停止已有自动契约和界面测试，但非空真实 Job、真实跟读/停止及 VS Code 现场回放仍待验证；安装器默认保留 `0.1.5-rc.2`。
- Added a dedicated `alpha171` adapter for upstream DSH `0.1.7-alpha.1`: it validates Session V4, streams complete Job rosters, follows output from UTF-8 byte offsets, and supports human-initiated stop. The UI gates these operations on the exact capability flag; older adapters retain their existing read-only Jobs behavior. Registry-only preset/plugin metadata and unsupported preset actions are handled explicitly. Job follow/stop have automated contract and UI coverage, while non-empty live Jobs, live follow/stop, and a real VS Code replay remain unverified. The installer default stays `0.1.5-rc.2`.

- 修复右栏两处误报：检查点、提示词模板等路径作用域列表此前把 DSH workspace id 当作 VS Code 文件夹 id 送出，被宿主一律拒绝，现改由宿主在会话投影上声明所属文件夹并只以此读取；没有打开文件夹时（仅临时工作区）不再发起这类读取，也不再显示「列表可能不完整」。输入队列按上游语义读取：alpha/rc 线的队列基线来自宿主级控制流，基线之后新建的会话在其第一次入队前不会被任何帧提到，此前被当成「读不到」而永久报错，现与官方客户端一致按空队列处理（真实运行时验证：修复前等满 2s 后失败，修复后立即返回）。
- 按运行时能力禁用 RC6/legacy 不支持的归档恢复入口，保留 Alpha 恢复；RC1 Jobs 明确提示不支持，不再伪装为空列表，RC2 任务事件不受影响。

- 修正状态与操作回执：永久删除无上游接口时明确禁用；权限与 Plan 未知值不再冒充默认配置；归档状态可随上游恢复同步，Goal 清除验证真实回执。
- 修正辅助面板的失败提示与展示：目录读取失败、变更能力缺失、检查点部分恢复明确提示；不再推测 Workflow 中断、会话完成、审批风险或模型活动，本地能力与上游能力分别标识。

- alpha.2 会话与交互：恢复 Goal 激活控制、刷新插件清单并显示待处理会话交互；读取权威回合变更，将已提交的 Plan Markdown 保留为可复用聊天卡片。
- 修复 DSH 0.1.6 alpha 权限选择器仅显示当前值：读取独立动态目录、监听目录失效，补齐 Auto 实验标记和风险确认。
- DSH 0.1.6-alpha.2 支持通过会话上传回执发送 PDF、Office、压缩包等二进制附件，保留非图片单文件 8 MiB 限制。
- alpha.2 的 Cordis 浏览器激活请求不再静默丢弃：可由用户明确拒绝；需要真实页面的查询提示转到 DSH Web 或停止回合。完整浏览器插件执行仍未支持。

## 0.2.1

- 接入 DSH `0.1.6-alpha.2`（`alpha162`）与 `0.1.6-alpha.1`（`alpha161`）精确 Adapter：alpha.2 按新的 `session/control` `projections.inbox` 归约队列/Steer、严格拒绝 alpha.1 的 `queues` 基线并归一化 `session/writer-held`，alpha.1 复用已核对的 Session v3 基础 wire、`image/offload` 只作脱敏 opaque 保留；两条线补齐畸形/取消/释放 fixture 并通过 managed live smoke，真实 DSH 证据与 `docs/dsh-contract.md`、能力矩阵同步；新增 alpha surface 不冒充完成，安装器默认仍为 `0.1.5-rc.2`。
- 连接体验与运行时定位：连接进度页重写为启动骨架屏（确定型进度条与百分比、五行会话占位骨架，失败时骨架收起换成原因框与重试/设置/诊断），连接阶段不再回退——只有本扩展已持有进程、真正附加时才宣告「正在连接」；定位失败（探测超时、已选可执行文件无法启动、候选无法上报版本）一定落到失败终态并给出原因与重试，损坏候选归类为「不可用运行时」且只向诊断写一行脱敏原文，失效的持久提示回落到常规扫描。
- 会话与工作区：会话切换器新增「已归档」分区（按需读取、逐行恢复、永久删除须确认，被拒绝时按宿主原文说明），并可用 VS Code 原生目录选择器添加工作区文件夹（修复多根工作区已有一个注册目录时其余无法注册）；归档/删除或新建/分叉期间改选导航、分叉重命名失败都不再覆盖新的选择；`/` 菜单可打开 Skill 说明文档，路径仅由宿主从会话目录解析。
- 配置与插件：字符串与枚举配置保留空字符串和首尾空格并与恢复默认区分，JSON 配置拒绝溢出的非有限数字，嵌套配置保留用户覆盖状态与重置入口；插件配置不再内置清单（命名空间、字段、可选值和凭据状态来自宿主 `settings.describe`，凭据只在宿主声明的引用下写入），支持非凭据对象与数组的 JSON 编辑、校验与重置，且不整体覆盖含脱敏凭据的容器，插件清单补充 Agent 预设组成、条件启用、默认预设与搜索。
- 模型选择与会话目录：适配层按参考客户端规则从会话持久投影组合 `current`（`next ?? lastUsed`）并据此判定 `routable`，不再把部署级默认当成会话选择；目录读取按宿主原文陈述失败与进行中并提供「重新读取」，枚举失败的 Provider 保持可见、已加载分组仍可用；推理强度与默认档按适配器声明显示，目录查不到的当前选择按 `provider/model` 命名而不称「不可用」；当前模型无适配器服务时 Composer 复用宿主 `routable` 判定（输入惰性、发送被拒、停止与换模型可用）。
- 工具卡、检查点与展示保真：结算卡由 `tool/result` 的 `meta` 形状派生、运行中的终端/变更卡由调用参数派生、已结算 shell 行结算出输出与退出码，变更行聚合文件的全部 hunk，检查点保存创建时刻的整份字节、恢复按预览选择 `abort`/`overwrite`；适配层、渲染层与 Webview 不再低于宿主契约地截断正文、失败原因、团队消息与列表尾部；持久图片引用可展开预览并重试；主题覆盖补齐插件配置下拉、模板变量框、状态药丸与工具卡读数。
- 修复一批交互与路由缺陷：绝对路径打开文件、子会话分页与父子路由、审批命令预览、Agent Teams 消息归并、队列编辑与 Steer 收敛、Skill 目录与命令附件参数、会话改名回执，以及非绝对 `dsh.runtime.executablePath` 导致扩展无法激活；同时加固弹层键盘/焦点/IME、结构化预览与模型选择展示、导出按选项过滤。
- 产品面陈述与清理：运行状态面板逐能力陈述「已验证/兼容回退/不可用」与整体来源，任务中心只投影契约能证明的会话取消，预设位置入口只在宿主陈述能力时区分「原生打开」与「显示路径」；移除一批无法到达的 Webview 路由与组件，协议声明与宿主分发保持一致。
- 修复两处 Webview 布局缺陷：已配置模型列表的每一行被旧模板压成窄条、Provider 卡片把「编辑/移除」挤到单独一行；两者改为随面板宽度自适应，窄面板下折行而不溢出，并补充永久回归断言。
- Add the exact `0.1.6-alpha.2` (`alpha162`) and `0.1.6-alpha.1` (`alpha161`) adapters: alpha.2 projects the upstream `session/control` `projections.inbox` into Queue/Steer and rejects the alpha.1 `queues` baseline, alpha.1 reuses the audited Session v3 base wire with `image/offload` kept as a redacted opaque row; both pass the managed live smoke with malformed, cancellation and disposal fixtures, updating `docs/dsh-contract.md` and the capability matrix; new alpha surfaces are not claimed done and the installer default stays `0.1.5-rc.2`.
- Connection experience and runtime lookup: the progress page is a startup skeleton (a determinate progress bar with a percentage readout and five placeholder rows, replaced on failure by the reason and the retry / settings / diagnostics actions) and "connecting" starts only once this extension owns a process to attach to, never rolling back; a locate failure (a probe timeout, an executable that cannot run, a candidate that cannot report its version) always ends in a terminal failed state with a retry, a broken candidate becomes an unusable runtime with one redacted process line in diagnostics, and a stale hint falls through to the ordinary scan.
- Sessions and workspaces: the session switcher gains an "Archived" section (read on demand, restored row by row, a permanent delete confirmed in a dialog, a refusal stated in the host's words) and can add a workspace folder through the native directory picker, fixing registration when a multi-root workspace already had one; a navigation switch during an archive/delete or create/fork — a failed fork rename included — is no longer overwritten by the older request; the `/` menu opens a skill's documentation, resolved by the host from the session directory only.
- Configuration and plugins: string and enum settings keep empty strings and surrounding whitespace and stay distinct from restoring the default, JSON settings reject out-of-range non-finite numbers, and nested settings keep the user's override state and reset entries; the plugin configuration ships no built-in list (namespaces, fields, choice values and credential state come from the host's `settings.describe`, with a secret written only under the reference the host declares), validates and resets non-credential objects and arrays without overwriting a container that holds a redacted secret, and the plugin inventory adds Agent preset composition, conditional enablement, the default preset and search.
- Model selection and the session directory: the adapter composes `current` from the session's durable projection (`next ?? lastUsed`) and derives `routable` from it the way the reference client does, not treating the deployment default as the session's choice; a directory read states its refusal and in-flight state in the host's words with a "read again" action, and an unenumerable provider stays visible while the loaded groups stay usable; reasoning levels and their defaults come from the adapter's declaration, an unlisted selection is named `provider/model` rather than called unavailable, and a session with no served model goes inert while Stop and the picker stay reachable.
- Tool cards, checkpoints and presentation fidelity: a settled card comes from the shape of `tool/result`'s `meta`, a running terminal or mutation card from the call arguments, and a settled shell row from the output and exit status its own result states; a change row carries every hunk of a file; a checkpoint snapshots the file's whole bytes as of creation and a restore picks `abort`/`overwrite` from the preview it showed; the adapter, render layer and Webview no longer cut tool bodies, failure reasons or a list's tail below the host contract; a persistent image previews on expand and retries a failed load; the theme covers the plugin dropdowns, template variables, status pills and tool-card readouts.
- Fix a batch of interaction and routing defects: opening an absolute path, subagent paging and parent/child routing, the approval command preview, Agent Teams message merging, queue edits and Steer convergence, the skill catalog and command attachment arguments, the rename receipt, and a non-absolute `dsh.runtime.executablePath` that kept the extension from activating; plus overlay keyboard/focus/IME handling, structured and model-selection presentation, and option-aware export filtering.
- Product surfaces and cleanup: the runtime status panel states every capability ID's verified/fallback/unavailable verdict and the overall source, the task centre projects only the session cancel the contract can prove, and the preset location action distinguishes a native opener from a revealed path only when the host states it; a set of unreachable Webview routes and components is removed, keeping the declared protocol and host dispatch in step.
- Fix two Webview layout defects: a configured-model row was squeezed into a narrow column and provider cards pushed their edit/remove buttons onto a line of their own; both now follow the panel width and wrap instead of overflowing, with permanent regression assertions.

## 0.2.0

- 修复错误信息在工具卡和结构化工具行中重复展示的问题；通用回退、终端和搜索结果会复用同一份错误展示，不再生成两张错误卡。
- 修复文件位置链接重复和不可点击的问题：每个目标只保留一个由宿主打开的入口，同时覆盖通用工具回退路径和宿主提供的顶层文件位置。
- 修复“读取”预览在没有语言或元数据时显示整条空白复制栏的问题，并压缩插件清单的详情布局；补充对应的 Webview/UI 回归测试。
- Fix duplicated error presentation across generic and structured tool renderers, including terminal and search results.
- Fix duplicated, non-clickable file-location labels by routing one deduplicated target per location through the Extension Host opener.
- Keep unlabeled read previews compact and add regression coverage for the tool-card, file-target, read-preview, and plugin-inventory layouts.

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
