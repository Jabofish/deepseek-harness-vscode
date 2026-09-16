# DSH 上游契约与兼容策略

本文只描述当前仍有效的上游契约、版本边界和升级规则。版本变化写入
[版本更新日志](../apps/extension/CHANGELOG.md)，能力完成度写入
[能力矩阵](capability-matrix.md)，本文不保存逐次审计记录或运行输出。

## 当前基线

| 项目               | 固定值                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 最新稳定/next DSH  | `@deepseek-ai/dsh@0.1.5-rc.2`                                                                                                               |
| 最新 alpha 通道    | `@deepseek-ai/dsh@0.1.6-alpha.1`                                                                                                            |
| npm 安装通道       | `next`；`latest` 仍为 `0.1.5-rc.1`                                                                                                          |
| 扩展安装默认       | 精确使用 `0.1.5-rc.2`                                                                                                                       |
| Node 最低版本      | `22.19.0`                                                                                                                                   |
| 固定 Host API 契约 | [`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a) |

固定契约的权威入口：

- [RPC map](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/host/apiproxy/src/api/rpc-map.ts)
- [Host and mux events](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/host/apiproxy/src/api/events.ts)
- [Tool catalog](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a/packages/core/tools)
- [DSH CLI profile reference](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/reference/README.md)

## 版本与 Adapter

每个已知版本保留独立的精确入口。实现可以复用，但版本身份、wire schema、错误映射和版本专属字段不能跨入口猜测。

| DSH 版本        | Adapter    | 关键边界                                                                                           |
| --------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `0.0.1-rc.1`    | `legacy01` | 旧 unary `command.*` 与旧 Host invalidation；不发送 `clientTimeZone`，不提供 ZIP。                 |
| `0.0.1-rc.2`    | `legacy02` | 旧 `command.*`、`session/tasks` 和 `host/remote-event`；可使用已声明的 `clientTimeZone`。          |
| `0.0.1-rc.5`    | `legacy05` | 与 rc.6 Host wire 等价，但保留独立精确身份。                                                       |
| `0.1.0-rc.2`    | `rc02`     | 与 rc.6 Host API 契约等价的独立入口。                                                              |
| `0.1.0-rc.3`    | `rc03`     | 与 rc.6 Host API 契约等价的独立入口。                                                              |
| `0.1.0-rc.6`    | `rc6`      | 固定 rc.6 契约；旧 Host 可缺少 `host.describe.home`。                                              |
| `0.1.0-rc.7`    | `rc7`      | 复用 rc.6 wire mapper，保留版本身份。                                                              |
| `0.1.0-rc.8`    | `rc8`      | 增加 `home`、图片限制、中断回复和 Agent Teams 事件。                                               |
| `0.1.1-rc.1`    | `rc11`     | 复用 rc.8 wire；按条件支持空白会话复用。                                                           |
| `0.1.1-rc.2`    | `rc12`     | 复用 rc.8 wire；不发送已移除的 `reuseWorkspaceBlank`，沿官方边界处理图片限制。                     |
| `0.1.2-rc.1`    | `rc13`     | 使用 alpha.5 的 v0 `/api`、Cookie、`remote.mux` 和 packed history；不使用 Session v2。             |
| `0.1.2-alpha.1` | `alpha`    | `/api` Connection、Cookie 和 `remote.mux` 的源码预适配；未作为安装默认。                           |
| `0.1.2-alpha.2` | `alpha2`   | alpha v0；增加命名空间错误、可忽略事件和 agent-preset 组合。                                       |
| `0.1.2-alpha.3` | `alpha3`   | 沿 alpha v0；保持扩展消费的 RPC、事件和错误边界。                                                  |
| `0.1.2-alpha.4` | `alpha4`   | 沿 alpha v0；上游内部序号、继承事件和 Subagent 实现变化不外溢。                                    |
| `0.1.2-alpha.5` | `alpha5`   | alpha v0 的最新安全回退入口；未知版本只从这里开始只读探测。                                        |
| `0.1.3-alpha.1` | `alpha13`  | Session v2：`isSeeded`、event-only history、assistant stream；只精确匹配。                         |
| `0.1.3-alpha.2` | `alpha132` | Session v2；`subagent.prompt` 严格要求 `delivery: queue \| steer`；只精确匹配。                    |
| `0.1.5-alpha.1` | `alpha151` | Session v3、surface replacement、Host-only system watermark 和 PTC；只精确匹配。                   |
| `0.1.5-alpha.2` | `alpha152` | Session v3；严格映射 `deliverables/presented` 与 `subagent/catalog`；只精确匹配。                  |
| `0.1.5-rc.1`    | `rc151`    | 沿 v3 和交付/目录边界复用 alpha152；保留独立 rc 身份。                                             |
| `0.1.5-rc.2`    | `rc152`    | 沿 rc.1 的 v3 wire；增加消息反馈分类/提交语义和交付物展示边界。                                    |
| `0.1.6-alpha.1` | `alpha161` | 沿 rc.2 的 Connection/Gateway 与 Session v3 wire；新增 projection 事件按 opaque 保留；只精确匹配。 |

### 未知版本

对任意非空未知版本标签：

1. 先完成公共握手，再按显式优先级从最新可安全复用的 Adapter 开始只读 `probeCompatibility`；
2. 候选拒绝、超时或契约不匹配时继续尝试下一个候选，全部失败才拒绝连接；
3. 成功后保留真实运行时版本、所选 Adapter 身份和兼容警告；
4. 不选择 Session v2/v3 精确入口，不发送未经协商的 `delivery`、交付/目录事件、`image/offload` 或其他版本专属字段；
5. 运行中的未知 RPC、Remote 或事件使用安全 unknown 降级或 `CAPABILITY_UNAVAILABLE`。

## Web Profile 启动契约

启动参数属于版本化契约，不是进程管理器可以全局添加的公共选项。

| 版本                                                                                                              | 参数                                        |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `0.0.1-rc.1/.2/.5`、`0.1.0-rc.2/.3/.6/.7`                                                                         | `--profile web --host 127.0.0.1 --port <n>` |
| `0.1.0-rc.8`、`0.1.1-rc.1/.2`、`0.1.2-rc.1`、`0.1.2-alpha.1–.5`、`0.1.3-alpha.1/.2`、`0.1.5-alpha.1/.2/rc.1/rc.2` | 上述参数加 `--no-open`                      |
| 未知版本                                                                                                          | 只使用公共参数，不猜测可选 flag。           |

参数由 `packages/dsh-adapter/src/launch-contract.ts` 集中生成。端口必须是已验证的 loopback 端口；不得扫描任意端口范围。

## 传输与事件边界

- Legacy rc 使用各自的 unary `command.*`/Host event wire；不能把 `0.0.1-rc.1/.2` 当作 rc.6 的同一协议。
- Alpha v0 使用 `POST /api/<namespace>/<method>` 的 Remote RPC、Cookie 握手和 `/api/remote.mux`；mux 以 `open`、`cancel`、`item`、`error`、`end` 帧承载 `$events`、follow 和 control 流。
- `session/control` 基线的 `queues`/`jobs` 只覆盖 Host 当前 live 的 Session（即内存活动会话集）；没有 live agent 的会话没有待发队列，因此队列快照缺失是真实状态而不是主机能力缺失，客户端不得据此报“主机不支持队列”。
- rc.6 Host 与 mux 是两个逻辑流；session 事件携带 `sessionId` 和序号，订阅携带 `lastSeq`，审批/问题响应使用 `rpcId`，工具调用与结果使用结构化视图。
- 工具卡的 `view` envelope（`{for:'call'|'result', view:{card}}`）只属于 legacy/rc 线：`toolEventViewSchema` 在 `0.1.1-rc.2` 及更早的 apiproxy `session/event` 帧与历史记录上仍在（`{event, view}`），到 `0.1.2-rc.1`（本仓库的 `rc13`）已整体移除——那之后的每个 tag（`rc151`/`rc152`、`0.1.2-alpha.1`–`alpha.5`、`0.1.3-alpha.1/.2`、`0.1.5-alpha.*`/`rc.*`、`0.1.6-alpha.1`）历史记录都只是 `{type:'event', event}`（`SessionEventEntry` 无 `view`），`tool/call` 也只有 `name`/`arguments`，没有 call 期投影。
- 这些宿主上工具自己的展示值由 `tool/result` 载荷里的 `meta` 承载：上游把工具的 `output.presentationMeta` 快照进去，并把它定义为「持久日志在回放时还原出同一张卡片」（`Session.append` 以 `isJsonValue` 校验，非可序列化值在源头被拒），因此适配层必须在 envelope 缺失时按 `meta` 的**形状**派生卡片：`diffs`（数组）为 diff 卡、搜索 `shape`（`matches`/`paths`）为搜索卡、`sources` 为网页搜索卡、`url` 为网页抓取卡、`lines` 为读卡；`diffs: []`（新建文件的空 diff）与畸形/缺字段的 `meta` 都不得产出卡片，行退化到通用路径，且**不得**按工具名建表猜测。`view` envelope 存在时仍以它为权威。读卡校验与参考卡模型及 pinned `read-render.ts` 一致：`offset ≥ 1`、行号严格递增且不超过 `totalLines`；搜索/网页的 `files`/`paths`/`sources` 必须是数组。
- 同一批宿主上调用期的 shell 调用同样必须由**调用参数**派生终端卡，规则与官方客户端 terminal 卡模型逐条一致：前台 `bash`/`pwsh` 以 `command`（非空字符串）为标题，`description`（标准工具必带、常驻 shell 省略 `description`，两者都会运行）与 `workdir`（字符串）随卡带出；`terminal_send` 以 `text` 为标题、以它写入的会话（非空 `sessionId`）为描述；`command` 为空或非字符串、`description` 为空或非字符串、`timeoutMs` 非正有限数、`workdir` 非字符串、`run_in_background` 非布尔或为 `true`（后台调用只回执 job id，没有退出状态）、`terminal_send` 的空 `text`/空 `sessionId`、`submit` 非布尔以及越权字段不成对或值不合法都不出卡；非第一方 shell 工具（含参数里恰好带 `command` 的第三方工具）一律不派生。与文件变更不同，代码分发 PTC 子调用保留终端卡（参考模型明确为嵌套调用派生）；envelope 存在时仍以宿主投影为权威，结算期不派生调用期卡片。宿主 `approval/request` 只带 `{toolName, callId, reason}`，审批条要显示的命令正是配对调用这张卡的标题，因此这条派生同时是「授权前能看到命令」的前提。
- 同一批宿主上 `tool/result` 只带 `{turn, step, callId, message, error?}`（`meta` 只在工具声明了 `presentationMeta` 时才有），既没有工具名也没有参数：任何逐事件映射都不可能把结果配回它的调用，因此结算卡只能在**调用与结果两半相遇的时间线合并点**派生（纯规则放在 `domain`，它是 `timeline` 与 `dsh-adapter` 都允许依赖的层）。shell 行的结算规则与官方 terminal 卡模型一致：只有当该行调用期已画出终端卡、调用参数是前台一次性 `bash`/`pwsh`（或 `terminal_send`）、且结果已结算时才结算；正文末尾的 `[killed by signal: X]` 优先于 `[exit code: N]`，命中的标记从正文摘掉（状态由卡片的胶囊承载，正文不得重复渲染），无标记即退出码 0；`renderResult` 对无输出的命令写 `(no output)` 而不是空串，所以空正文不是合法的已渲染结果，不猜状态；后台调用、常驻终端（`description` 缺省）、失败结果、以及正文末尾带溢出提示（`(Omitted <n> bytes. Full formatted result stored at: …)`，其页脚可能盖住标记）一律退回通用行；`terminal_send` 的结算只陈述输出，不发明进程状态；宿主自己给出的结算卡永不被覆盖。行状态按 `terminalFailed` 语义（退出码非零或有信号即失败）同步到工具行与折叠分组摘要，失败行的错误摘要不得退化成裸退出码数字。
- 同一批宿主上调用期（`tool/call`）也没有任何投影（`presentCall` 值不进 Client），运行中的变更卡必须由**调用参数**派生，规则与官方客户端 diff 卡模型逐条一致：`write` 取 `file_path` + `content`（`oldText: null`，覆盖写同样如此，因为调用期看不到原内容）、`edit` 取 `file_path` + `old_string`/`new_string`（空 `old_string` 视为纯插入，即 `oldText: null`；`replace_all` 只能是布尔）、`str_replace_editor` 只在 `command` 为 `create`（`file_text`，可缺省为空文件）或 `str_replace`（`old_str`/`new_str`，`old_str` 缺省为 `null`）时出卡；参数不合法（`path`/`file_path` 为空或非字符串、`content` 非字符串、`replace_all` 非布尔）、越权字段 `sandbox_permissions`/`justification` 不成对或取值不在 `workspace-write`/`danger-full-access` 且 justification 非空白、`str_replace_editor` 的其他命令、以及代码分发 PTC 子调用一律不出卡。派生只为上述第一方文件变更工具，绝不按名字给第三方工具编造卡片；envelope 存在时仍以宿主投影为权威。结算期不派生调用期卡片，时间线保留调用期已携带的卡（成功且 `meta` 带卡时由结算卡替换），因此「打算做」永远不会被当成「已做」。
- Alpha v0 的 Remote Event 在结算时只向*其他*仍持有投递的 Client 推送 `cancel` 帧：发起响应的 Client 一旦 `$events/result` 被接受，就再也不会收到任何帧。因此本地已接受的审批/问题结算必须由适配层按真实身份补发 `permission.resolved`（`requestId` + outcome）或 `question.resolved`（`questionRpcId` + outcome）；否则 Host 回放缓存和任务中心会一直重放一个已经无法再回答的请求（响应只会得到 `STALE_INTERACTION`）。
- Session v2 只在 `alpha13`/`alpha132` 精确入口启用 `isSeeded`、event-only history、`assistantStream` 和 `start/chunk/end` 修订帧。
- Session v3 只在 `alpha151`/`alpha152`/`rc151`/`rc152`/`alpha161` 精确入口启用严格 envelope、surface replacement、`system/message` 隔离和 PTC 事件；`alpha161` 的 `image/offload` 是上游消息投影事件，当前只作为脱敏 opaque unknown 保留，不伪造本地投影。
- Agent Teams 事件（`team/member`、`team/task`、`team/message/queued`、`team/message/delivered`）的 envelope 版本随发行线变化：已发布的 `0.1.2-alpha.2`–`alpha.5` 是 `version: 1`，其排队消息快照带必填 `delivery`；`0.1.6-alpha.1` 起为 `version: 2`（上游 `z.literal(2)` 严格校验），消息快照不再有 `delivery`。共享 mapper 同时接受这两种版本，v1 仍要求 `delivery`（缺失即判为畸形），v2 只在载荷携带时投影该字段；其他 envelope 版本继续 fail-closed 为 unknown。
- `team/message/queued` 与 `team/message/delivered` 是同一条消息的两条记录：前者是已持久保存的消息本体（正文与发件人只在这里），后者是只带 `messageId`/`targetId` 的投递回执。时间线按 `teamId` + `messageId` 归并为一行，回执推进该行的状态并保留本体事实；成员与任务则各自按快照身份一行。任何一侧都不得据此伪造消息正文或把回执显示成独立卡片。消息正文与成员失败原因都是宿主原文：Mailbox 只约束发送方成帧后的整条投递（`maxMessageBytes`，默认 65 536 字节且可配置），失败原因由 `errorMessage(error)` 原样保存，因此这两段文本按普通散文渲染（换行、不省略号收尾），发件人（`senderName`）也必须出现在行上。
- `system/message` 只在 Host 保留序号水印；系统提示词、Cookie、launch token、endpoint 和原始上游错误不进入 Webview。
- 0.1.6-alpha.1 的 live 运行观察到 `agent/inbox/spliced`、`session/end-seed`、`session/title-llm-request`、`web/deepseek-search-llm-request`：这些是上游只写入 trajectory/inbox 状态的记录，没有人类 transcript 发布面。适配层按其真实形状保留为经 `safePayload` 脱敏的 opaque unknown，Webview 默认视图不显示；不得据此猜测或伪造本地投影。
- surface `replace` 事件是只面向模型的替换副本（压缩摘要等），其覆盖范围按上游契约已被遮蔽，人类 transcript 只由 append-origin 事件构成；副本与 `system/message` 一样折叠为 `session.system` 序号水印，序号继续参与缺口恢复，内容不进入 Extension/Webview。
- `deliverables/presented` 映射为有界的相对文件 DTO；`subagent/catalog` 是父会话目录事实；文件打开/显示始终回到 Extension Host。
- rc.2 的消息反馈分类、提交和撤销只通过 Host 调用真实 Remote 方法；不能用空实现或模型文本猜测结果。
- 未知字段只在版本契约明确允许时忽略；必填字段、序号、replacement 和 frame 外壳均 fail-closed。

## Host 本地能力

Checkpoint 和 Prompt Template 是 Extension Host 本地能力，不新增伪造的 DSH RPC：

- Checkpoint 默认关闭；metadata 与内容快照分别受设置控制，使用 checksum、journal/backup、冲突预览和原子写入。
- Prompt Template 只存放在 Extension Host 管理的 global storage 或受信工作区固定目录；变量使用显式白名单，缺失变量必须由用户处理。
- Webview 只收到严格的摘要、预览、配置状态和 opaque ref；路径、文件读写、Secret 和进程句柄不跨边界。

## 契约实现规则

1. 从固定 `rpc-map.ts`、`events.ts` 和工具目录确认真实方法、事件和输入输出形状。
2. 在 `versions/<version>` 中维护版本入口、schema、mapper、错误词汇和启动参数；不把上游类型 re-export 到 Domain。
3. 用脱敏 fixture 覆盖成功、业务错误、协议错误、畸形响应、超时、取消和资源释放中适用的路径。
4. 只对明确幂等的瞬时故障重试；所有错误进入稳定 `AppErrorCode`，原始 body 不跨 Host/Webview 边界。
5. 上游新增项可以安全降级为 unknown；上游删除或改变已消费形状必须让契约测试失败。
6. 更新版本时保留旧 Adapter 和回归测试，并在能力矩阵中更新状态；没有 live 证据不得标记 `DONE`。
7. 宿主合法的文案（失败原因、工具输出、正文）不得在适配层被截到低于宿主契约：上游 `rpcErrorSchema.message`、`turn/end` 的失败原因、工具结果正文都没有长度上限，公开文案的长度上限只由协议层统一约束（宿主错误响应 1 024 字符预算，且该预算处会保留错误码），适配层只做凭据脱敏与空白归一，不在自己的边界上另设更低的静默截断。同一条规则适用于展示层：`packages/ui` 的工具行/工具卡正文、错误块与结构化分区同样按宿主原文渲染（限高与滚动由 CSS 承担，行内摘要 `firstLine`/`oneLine` 是唯一的长度预算且与完整正文并存），格式化器不得静默丢弃数组尾部 —— 被截断的列表必须写明省略数量。

## 命令目录与 Skill 手势

`commands/list` 与 `commands/execute` 只覆盖 Host 已注册的命令目录；`commands/execute` 对目录外的行返回 `undefined`，这不是命令失败。该返回在 wire 上表现为「`ok` 信封但省略 `value` 成员」——JSON 无法承载 `undefined`，Gateway 用缺省的 `value` 槽位表示业务结果为空，因此「ok 且无 value」必须被读作未解析，而不是畸形响应；值为必需的调用方（`commands/list` 等）仍把缺失 `value` 视为协议错误。用户可调用 Skill 不以命令注册：`/<skill-name> [args]` 是一次 Prompt 手势，Host 在 `agent/pre-step` 识别该行并注入 Skill 正文。因此目录外的行必须交回调用方决定「手势 Prompt」还是普通文本，Adapter 不得当成命令错误，也不得自行发送 Prompt；只有会话配置命令（`/plan` 等）必须真正被应用，未解析的行不能让配置以为已经生效。

`skill.list` 的条目只有 `name`、`description`、可选 `whenToUse` 和 `modelInvocable`：上游已按「用户可调用」过滤，`modelInvocable: false` 表示模型不能自行挑选该 Skill，而不是「禁用」，因此任何界面都不得据此关闭入口，否则唯一能运行该 Skill 的人反而失去入口；条目同样不携带来源，客户端不得为 `source` 编造取值。`0.1.6-alpha.1` 起条目另有可选的 `path`，属 Host 本地路径，不跨边界。

## `commands/execute` 的附件参数

附件参数名随上游版本变化：`0.1.0-rc.7` 及更早的签名只有 `(agent, line)`，没有任何附件参数；`0.1.0-rc.8` 起增加 `images`，条目为裸 `EncodedImageAttachment`；`0.1.3-alpha.1` 起改名为 `submittedAttachments`，图片条目必须带 `type: 'image'` 标签，与已暂存文件的 `receiptId` 条目并列。该参数一经声明即必填 —— strict Remote descriptor 对缺字段直接拒绝，因此 `/plan`、`/permission` 这类无附件命令也必须显式发送空数组。版本差异只由 Adapter 的 `CommandAttachmentWire` 决定，不在组件或用例中判断版本；目标版本没有该参数时，带附件的命令必须在请求离开 Host 之前失败，而不是被静默丢弃。命令目录中的「可带附件」标记同样在 `0.1.3-alpha.1` 由 `images` 改名为 `attachments`，Domain 侧统一投影为 `input.images`。

## 待发队列与 Steer

`session/queue` 控制帧只携带 `id`、`placement`（`queued`/`steering`/`context`）与 `message.content`，没有 `createdAt`，也可能不带 `role`/`source`——alpha 的 Session Controller 会把消息削到 id 与内容块，缺少它们才是真实形状而不是损坏；出现时仍必须合法。`placement: 'context'` 的行不是用户待发消息，不得进入队列投影。

`session.updateQueue` 的 `action` 只有三种：`{kind:'edit', content}` 会用**整块文本**替换原内容，因此只有内容全是文本块的行可以编辑——行里一旦有图片或文件块，替换就会静默丢掉它们。Domain 的 `QueuedInput.textOnly` 就是这条判定（与上游 `queue-mirror` 的 `textOf` 同一语义：全部块都是 `text` 才可读成文本），任何界面都不得对 `textOnly: false` 的行提供编辑，仓储也必须自行拒绝这类编辑；文件块无法取回字节，只能投影为脱敏的显示名（`files`）。

Steer 是收敛操作：`session/steer-unavailable`（回合已停止接受 steer）与 `session/queue-item-not-found`（行已被 agent 领取）都意味着该行不再待发，正是调用方想要的终态，官方客户端对这两种错误静默返回，本扩展同样按成功处理；`edit`/`remove` 的失败仍然可见，不得一并吞掉。

## Session 标题契约

`session.rename` 的应答是 `{ title, seq }`，其中 `title` 是**宿主归一化并截断后真正存下的标题**，不是调用方提交的原文：上游会去掉 ANSI/控制字符与零宽、方向性字符，把连续空白折成一个空格，再按部署配置的 UTF-8 字节预算截断（固定版本 `0.1.6-alpha.1` 实测：`"  Live\nRename\u200B   probe  "` 存成 `"Live Rename probe"`，400 个汉字被截到 26 字 / 78 字节）。归一化后为空才是错误（`session/title-invalid`），超长只截断不拒绝，因此客户端不需要为标题长度设限，但**必须展示回执里的标题**——继续显示用户输入的原文等于宣称一个会话日志里并不存在的标题，直到下一次刷新才跳回真实值。

空白会话（`blank: true`）的行标题按官方语义显示为本地化的 `New Session`，与 `title` 字段无关；持久标题的来源始终是日志里的 `session/title` 事件。

## 会话模型目录

`session.models` 的应答是 `{ current, routable, groups, failures }`，`groups` 与 `failures` 是同一份目录的两半：前者是已枚举成功的 Provider 分组，后者是逐个 Provider 的枚举失败（`{ id, name, message }`）。上游 schema 对 `failures.id`/`failures.name` 要求 `min(1)`，`message` 是无长度上限的 lookup 诊断；该行是「这个 Provider 为什么没有模型」的唯一解释，因此适配层不得丢弃或截断它，界面按宿主原文渲染（契约实现规则 7）。两个方向的误读都要避免：某 Provider 失败不使其他分组失效，客户端不得因为 `failures` 非空而清空目录或禁用选择；`failures` 也不是整目录失败，不得据此宣称会话没有可选模型。

`routable` 是整份片段的必需字段（上游 schema 无默认值），语义是「当前是否有适配器服务 `current` 的 Provider」，即这个会话此刻能否开始一个 turn；上游明确说明它不能由 `groups` 推导，因此禁用输入的客户端必须读它而不是读分组（契约实现规则 7）：`routable === false` 时输入保持惰性并显示宿主给的原因，`true` 时正常；只有 Provider 变化才会改变它，所以写完 `session.configure` 后要按已提交的配置重读，而不是继续用旧判定。客户端不得把它当作强制——宿主对无法路由的 prompt 一律拒绝，界面禁用只是提示。

`groups[].models[].reasoning` 是适配器对推理强度的完整声明：`efforts[]` 每项都带必需的 `id` 与 `name`（都是 `min(1)`），`defaultEffort` 单独可选，且可以不在这份列表里。`name` 是宿主给这一档的显示名，`id` 才是选择里回传的值，两者不可互换；`defaultEffort` 是「没有指名强度时适配器实际用的那一档」，与 `efforts[0]` 无关。所以展示某一档必须用 `name`（列表外的值按宿主的 `id` 原文显示），会话未指名强度时显示 `defaultEffort`，适配器未声明默认时只能说「由提供方决定」——把列表首项当成生效值是在宣称一个宿主从未说过的强度，换模型时再把它回传，等于替用户做了一个他没做过的选择。

`current` 与 `groups` 的关系也要读准：`groups` 是咨询目录，`current` 才是宿主的当前选择。目录里查不到 `current` 时（最常见的原因是那个 Provider 枚举失败，解释就在 `failures` 行里）客户端只能按宿主的标识显示 `provider/model`，不得据此宣称模型「不可用」：可用性是宿主的判定（`routable` 以及 `session.selectModel` 与 prompt 的应答），不是目录缺席能推出的结论。

`session.models` 这次读取本身也可以被宿主拒绝（业务错误或协议错误）。失败的读取不是空目录：`groups`/`failures` 一行都没拿到时这份目录什么都没说，客户端不得据此显示「本会话没有可用模型」这类判定——那是对未作答 Provider 的臆断，参考实现（`ModelSelect`）把该判定保留给真正答出空目录的读取。失败必须按宿主原文（`AppError` 稳定映射后的 message，契约实现规则 7）显示在目录所在的界面里，并配一个重读入口：会话目录缺席时本扩展会退回全局目录，若不说明原因，「换了目录」本身就会被当成宿主的答案。重读失败时保留上一次成功读取的目录（模型行与 `failures` 行都不清空），因为一次瞬时失败不该把已经陈述过的事实变成未知。

## 事件恢复与资源所有权

每个 Session 保存最后提交的服务器序号。重连顺序固定为：重新订阅、比较序号、通过历史补齐缺口、去重、提交 reducer。事件不能只按时间戳排序；未知事件保留安全的类型/序号/摘要，不能阻断后续已知事件。

Extension 只停止自己创建并持有句柄的 DSH 进程。外部实例必须保持运行；连接、WebSocket、订阅和临时资源在成功、失败、取消、超时和关闭路径都要释放。
