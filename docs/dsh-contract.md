# DSH 上游契约与兼容策略

本文件是开发文档中 **DSH 精确版本、wire 差异和安装默认的唯一位置**。代码中的 `SUPPORTED_DSH_VERSIONS`、版本化 Adapter、`LATEST_PUBLISHED_DSH_VERSION` 与脱敏契约 fixture 是实现事实；本表解释边界，不能凭版本号相近推断兼容。能力是否完成见 [能力矩阵](capability-matrix.md)，测试与发布门禁见 [质量流程](quality.md)。

## 上游来源与安装默认

扩展引导安装的精确包版本是 `@deepseek-ai/dsh@0.1.5-rc.3`，由 `packages/dsh-adapter/src/contracts.ts` 的 `LATEST_PUBLISHED_DSH_VERSION` 决定；安装时不解析浮动 dist-tag。npm 通道指向会改变，不在规范中复制“当前 latest/next/alpha”快照。更新功能可从上游目录选择经过验证的**精确**版本，不能把源码适配视为已发布包或已完成真实运行验证。

历史 Host API 的固定基线是提交 [`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)：[RPC map](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/host/apiproxy/src/api/rpc-map.ts)、[events](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/host/apiproxy/src/api/events.ts)、[tool catalog](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a/packages/core/tools)。它只证明该 Host API 家族；较新的 Connection/Gateway、typed Remote 和 Session Controller 必须从**目标版本自己的 tag/commit 和实际存在的接口文件**核对。尤其 `0.1.5-rc.2` 与 `0.1.5-rc.3` 的 wire 比较不能引用上述已不存在的旧 RPC 文件；两者被适配器消费的 Session Controller、typed Remote、Connection/Gateway 与工具运行时源码相同，仍保留各自精确身份。

## 版本身份与 wire 家族

以下每个精确身份都有独立入口；同一格中的多个版本按顺序对应列出的 Adapter。源码入口不等于 npm 包可用，也不等于完成 live smoke。

| DSH 版本                                                                            | Adapter                                         | 必须保留的边界                                                                                                        |
| ----------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `0.0.1-rc.1`, `0.0.1-rc.2`                                                          | `legacy01`, `legacy02`                          | 旧 unary `command.*`/Host frame；后者另有 `session/tasks`、`host/remote-event` 和已声明的时区字段                     |
| `0.0.1-rc.5`, `0.1.0-rc.2`, `0.1.0-rc.3`                                            | `legacy05`, `rc02`, `rc03`                      | 各自精确身份，复用已核对的 rc.6 Host wire                                                                             |
| `0.1.0-rc.6`, `0.1.0-rc.7`, `0.1.0-rc.8`                                            | `rc6`, `rc7`, `rc8`                             | Host 基线；rc.8 增加 home、图片限制、中断回复和 Agent Teams 事件                                                      |
| `0.1.1-rc.1`, `0.1.1-rc.2`                                                          | `rc11`, `rc12`                                  | 沿用 Host 家族；rc.2 不发送已移除的空白会话复用字段                                                                   |
| `0.1.2-alpha.1`, `0.1.2-alpha.2`, `0.1.2-alpha.3`, `0.1.2-alpha.4`, `0.1.2-alpha.5` | `alpha`, `alpha2`, `alpha3`, `alpha4`, `alpha5` | `/api`、Cookie、`remote.mux`、Session v0；各版错误/事件形状独立核对；alpha.1 仅源码入口                               |
| `0.1.2-rc.1`                                                                        | `rc13`                                          | 仍使用 alpha.5 的 Session v0 packed history，不因 rc 名称继承 Session v2                                              |
| `0.1.3-alpha.1`, `0.1.3-alpha.2`                                                    | `alpha13`, `alpha132`                           | Session v2；仅后者向 `subagent.prompt` 发送必填 `delivery`；alpha.1 仅源码入口                                        |
| `0.1.5-alpha.1`, `0.1.5-alpha.2`                                                    | `alpha151`, `alpha152`                          | Session v3；后者增加交付物与父会话 Subagent 目录                                                                      |
| `0.1.5-rc.1`, `0.1.5-rc.2`, `0.1.5-rc.3`                                            | `rc151`, `rc152`, `rc153`                       | v3 各自精确身份；反馈、交付物边界按目标 tag 启用；rc.3 沿已核对的 rc.2 wire                                           |
| `0.1.6-alpha.1`, `0.1.6-alpha.2`                                                    | `alpha161`, `alpha162`                          | v3；alpha.2 把 control 队列基线改成 Inbox projection，并映射 `session/writer-held`                                    |
| `0.1.7-alpha.1`, `0.1.7-alpha.2`                                                    | `alpha171`, `alpha172`                          | Session V4、projection-only control、pinned Workspace、独立 Job Controller；alpha.2 增加 turn-window 和工具内容投影   |
| `0.1.7-rc.1`, `0.1.7-rc.2`                                                          | `rc171`, `rc172`                                | V4 与 Job Controller；rc.2 的 preset registry、Schedule 等只在其精确入口启用；rc.2 是源码适配，不能宣称已完成真实运行 |

`0.1.7-rc.2` 的固定源码是 [tag `dsh-v0.1.7-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.7-rc.2)，提交 `477b4f420553e8a52c2fbccc464d7561b239c443`。其他新增版本也必须在 fixture 注明 tag、commit、文件和类型；版本身份、schema、错误词汇、启动参数与能力声明一起核对。

### 未知版本

对非空但未识别的标签，先进行公共握手，再按显式优先级只读 `probeCompatibility`。候选拒绝、超时或契约不匹配时尝试下一个；全部失败才拒绝连接。成功后保留真实版本标签、所选 Adapter 和兼容警告。只可复用经过证明安全的基础 wire：Session v2/v3/V4、`delivery`、turn-window、目录/交付事件和其他版本专属字段不能通过相近版本号猜测；未知 Remote 或事件安全降级为 unknown 或 `CAPABILITY_UNAVAILABLE`。畸形 SemVer-like 身份在 wire probe 前拒绝。

## 启动与传输

`packages/dsh-adapter/src/launch-contract.ts` 集中生成启动参数。`0.0.1-rc.1/.2/.5`、`0.1.0-rc.2/.3/.6/.7` 使用 `--profile web --host 127.0.0.1 --port <n>`；从 `0.1.0-rc.8` 起的已核对入口还传 `--no-open`。未知版本不猜可选 flag。端口为已验证的 loopback 端口，不扫描范围。进程所有权规则见 [架构](architecture.md)。

旧 Host 家族的 RPC 与 mux 是两个逻辑流；Session 事件带 `sessionId`/序号，订阅使用 `lastSeq`，审批和问题响应使用结构化 `rpcId`。Alpha 家族的 Connection Remote 走 `POST /api/<namespace>/<method>`、Cookie 握手和 `/api/remote.mux`；mux 使用 `open`、`cancel`、`item`、`error`、`end` 帧。每个 Session 保存最后提交的服务器序号；重连先订阅，再比较序号、分页补洞、去重后归约。`system/message` 和只面向模型的 surface replacement 只留下序号水印，内容不进入人类时间线；未知事件只保留脱敏的类型、序号和摘要，不阻断后续事件。

Session v2 的 `isSeeded`、event-only history 与 assistant stream 修订帧只在精确 v2 入口启用。Session v3 严格验证 event envelope、surface replacement、PTC 和 Host-only system watermark；`image/offload` 保留为脱敏 opaque 事件，持久图片引用仍可读取。Session V4 的工具结果是带 `role: 'tool'`、`toolCallId` 与 source 的 first-class message，必须先验证配对再投影。新的 projection 事件不由客户端猜成人类可见状态。

Control 基线随 wire 变化：早期 alpha 是 `queues`/`jobs`；`alpha162` 是 `jobs`/`projections.<sessionId>.values.inbox`，以 `next-turn`/`next-step` 和消息 ID 投影 Queue/Steer；`alpha171` 起只接受 `projections`，Job roster 从独立 `job/list` 的 whole-set rows 流读取。旧形状不得穿过新入口。Job follow 用绝对 UTF-8 字节偏移，首次数据帧可重放跨恢复游标的完整 chunk；客户端按字节且在码点边界裁掉已显示前缀。空文本的 lossy/gap 尾标志不能显示为输出。

只有明确支持 turn-window 的精确入口，才在普通 Session/Subagent 首屏与历史分页发送该参数：首屏/follow 使用至少 50 条、2 回合，扩展旧页使用本地 pageSize 200 条、2 回合；这与上游普通 `loadOlder()` 的 50 条默认值不同。补洞、导出、Goal 等严格读取继续按有界 durable sequence 分页。工具 `projectContent()` 插入的标准 ContentBlock 按结构化内容映射，不解析渲染文本。归档恢复只在精确声明该 Remote 的入口开放；旧 Host/alpha 入口在调用底层前明确返回不可用，永久删除没有上游契约。

## 工具、命令与交互

Legacy Host 的 `view` envelope 存在时，它是工具卡的权威投影。无 envelope 的后续 wire 只能从第一方工具**结构化参数或结果 `meta` 的合法形状**派生展示：diff、搜索、网页、读卡等分别校验所需字段，空或畸形 `diffs` 不造卡；第三方工具即使有同名参数也不套第一方规则。调用期文件变更卡只表示“打算做”，成功结果和权威 `meta` 到达后才可结算。Shell/terminal 卡必须校验前台命令、工作目录、权限字段及结果标记；后台、失败、溢出页脚、畸形参数和不完整结果退回通用行。调用与结果需按 call ID 在时间线合并点配对，不能逐事件猜测退出状态；宿主结算卡始终优先。

具体派生规则须与第一方客户端的结构模型一致：`write`、`edit` 和 `str_replace_editor` 仅在各自合法的路径、文本及布尔参数下形成调用期 diff 卡；PTC 子调用不派生文件变更卡。前台 `bash`/`pwsh` 的非空 `command` 与 `terminal_send` 的非空 `text`/`sessionId` 才可形成调用期终端卡，后台调用、畸形 `timeoutMs`/`workdir`/权限参数不出卡；PTC 子调用可以保留终端卡。结算只发生在匹配的调用与结果均到达后：尾部 signal 标记优先于 exit code，标记从正文移走；没有合法结算正文、失败结果或溢出页脚时不猜退出状态。工具原文和错误正文只按安全边界脱敏，不以任意较小长度预算静默裁切。

`commands/list` 与 `commands/execute` 只覆盖已注册命令。`commands/execute` 返回 `ok` 但缺少 `value` 表示目录外行未解析；对必须有值的读取则是协议错误。Skill 的 `/<name> [args]` 是 Prompt 手势，不因缺少命令目录项而被判为失败，也不由 Adapter 自行发送 Prompt。会话配置命令必须真的应用，不能把未解析当成功。`skill.list` 中 `modelInvocable: false` 只禁止模型主动挑选，不禁止用户调用；可选本地文档路径只留在 Host，Webview 只见是否可打开。

命令附件按版本化 `CommandAttachmentWire` 映射：没有附件参数的版本须在 Host 拒绝带附件请求；旧 `images` 接受裸图片，后续 `submittedAttachments` 使用有类型标签的图片或 receipt，参数一经声明即使为空也必须发送空数组。组件和用例不判断版本，也不静默丢弃附件。

Alpha Remote Event 的发起客户端在交互结算后可能不会收到取消帧。适配层对本地已接受的审批/问题必须按真实 request identity 补发 resolved；其他客户端的结构化结算也应使待处理卡消失。审批、Goal、Plan、Workflow、Job 和 Tool 状态只由结构化响应或事件推进，不从模型文本推断。

## 队列、标题与模型

`session/queue` 行可能没有时间、role 或 source；缺失本来可选的字段不是损坏。`placement: context` 不进用户待发队列。Host 控制流基线列出当时已知 Session，之后只在待发输入变化时发送帧；基线后新建且尚未入队的 Session 应回答空队列，不伪报不可用。不同 wire 的 subscription/control 基线语义要显式选择，重订阅不得清除另一控制流已发布的队列。

队列 `edit` 用整段纯文本替换。含图片/文件块的行 `textOnly: false`，UI 不提供编辑，仓储也必须拒绝，避免丢附件；文件只投影脱敏显示名。Steer 的“已不再接受”和“行已被领取”表示待发项已收敛，可按成功终态处理；编辑和删除失败仍须显示。

`session.rename` 应答中的 `{ title, seq }` 是宿主清理并持久化后的标题，UI 必须使用回执标题，不能保留用户原始输入。空白会话显示本地化新会话名，持久标题仍来自日志事件。

`session.models` 的 `{ current, routable, groups, failures }` 必须完整保留：Provider 部分枚举失败不使其他分组失效，`failures` 不是空目录；`routable` 是宿主的路由判定，不能由 `groups` 猜。推理强度显示宿主 `name`，提交其 `id`；未显式选择时只展示 `defaultEffort` 或“由提供方决定”，不把列表首项写回。目录中找不到 `current` 不能据此宣称模型不可用。

Alpha `session/modelCatalog` 的部署默认、可路由 Provider、分组与失败须结合会话持久 `modelSelection`：`current` 取 `next ?? lastUsed`，仅投影没有选择时才整份回落部署默认；`next: null` 不等于重置默认。读不到会话选择时整次读取失败，不能用默认冒充用户选择。UI 展示的当前路由不写回 `configuration.model`。目录读取失败不显示“没有模型”；保留上次成功目录并提供重读，若退回全局目录须告知原因。

## 其他精确能力边界

- Agent Teams 的 `team/message/queued` 承载本体，`team/message/delivered` 只是同一 `teamId`/`messageId` 的回执；合并为一行，不伪造正文。v1 envelope 要求 `delivery`，v2 允许缺省，其他版本 fail closed。
- `deliverables/presented` 只投影有界的相对文件 DTO；`subagent/catalog` 是父会话目录事实；打开文件经 Host。`workspace/changes` 的权威 summary/diff 仅通过经验证的固定路由读取，不把历史列表冒充持久审查快照。
- `permissionPresets/catalog` 是权威可选项；目录失效后重读，不保留旧项。Auto 权限需要风险确认。会话二进制文件先上传得到只对原会话有效的 receipt，再提交 prompt；畸形回执、超时或取消不得继续写入，不自动重试非幂等请求。旧版本和子代理不据此宣称支持。
- 二进制文件只在声明该上传能力的普通会话开放，单个非图片文件本地上限为 8 MiB，一个草稿最多 20 个附件；选择、拖放、粘贴都必须在 Host 暂存前按相同规则拒绝不支持的候选，图片和文本沿原有通路。
- Cordis `request-run` 只提供用户显式拒绝入口；`inspect-query` 失败不伪造成功结果，也不在 VS Code 执行浏览器代码。
- Schedule 创建若上游没有 Remote，只通过 DSH 自己的 Agent 工具与同一会话的结构化终态确认；Plugin Manager 的安装与只读 plugin inventory 是不同能力，未知结果不重试安装。
- Goal 的持久 phase 与进程内 armed 状态分别读取；旧请求不能覆盖较新的流事件。Plan 卡只从完整结构化 `exit_plan_mode` 参数建立。

### Schedule、Plugin 与账号的长操作

Schedule 的目录、历史、更新、删除走目标入口声明的 Remote；创建走新会话中的 `schedule_create` 工具。创建请求锁定到同一 Session 的 `turn.started` 与匹配 `turn.ended`，随后刷新权威目录；只有**成功读到空目录**才允许重新创建。目录读取失败保持 pending，跨 Session/turn 事件不能解除锁，aborted 终态、超时、取消和 watcher dispose 均须处理。时区、cron、DST、重复提交与 Drawer 重开也需验收。

Plugin 安装前的二次 inspect、registry、Host 确认或 Adapter 本地验证失败，明确返回 `PLUGIN_INSTALL_NOT_STARTED`，可重试且不调用等待 Remote。取消覆盖预检与确认；先到的取消意图有界保留，防止随后发出安装。Remote 一经调用，断线或畸形回包都视为结果不确定：以同一 `installRequestId` 查询 `waitForInstall`，有界缓存可恢复同一 Host 已完成结果，恢复期间仍可取消；`not-running` 可按同 ID 重试取消。结果仍未知只刷新目录，不重新安装。启用单个可选插件 entry 需要 Host 模态确认；只读 inventory 不冒充完整管理器，上游无通用 registry 搜索时不伪造搜索。

账号授权 URL 只由 Host 打开，DSH loopback callback 与 `watch`/`watchExpiry` 的订阅由 Host 持有并释放；用户可取消授权 attempt。任务影响未知时由 Host 确认，成功登录边沿才调用目标入口声明的默认模型初始化。资料、钱包和 bonus 只经安全 DTO 投影；过期以 Host 时钟判断，连接身份变化清空 Webview 账号快照，Host 的 account-scope revision 隔离旧账号卡与迟到 ACK。旧 signed-out 详情读取不能清除新账号确认状态；usage/top-up 页面仅由 Host 打开。以上需独立验证真实 DSH OAuth 和 VS Code 交互，自动契约测试不等于现场通过。

## 契约变更验收

每次新增目标版本：固定 tag/commit 与被实际消费的源码，比较接口而非名称；建立独立版本身份和脱敏 fixture；覆盖成功、业务/协议错误、畸形响应、超时、取消、释放和邻近版本拒绝中适用的路径。只重试明确幂等的瞬时故障，原始 body 不跨 Host。上游新增可安全降级为 unknown；已消费形状删除或改变必须使契约测试失败。保留旧 Adapter 回归，更新能力矩阵；没有目标版本的真实运行证据不得标为 `DONE`。宿主公开正文与失败原因不得被 Adapter 静默截短；展示层用滚动/折叠承载长文本，列表若截断须说明省略数量。
