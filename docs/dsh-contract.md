# DSH 上游契约与兼容策略

本文件是开发文档中 **DSH 精确版本、wire 差异和安装默认的唯一位置**。代码中的 `SUPPORTED_DSH_VERSIONS`、版本化 Adapter、`LATEST_PUBLISHED_DSH_VERSION` 与脱敏契约 fixture 是实现事实；本表解释边界，不能凭版本号相近推断兼容。能力是否完成见 [能力矩阵](capability-matrix.md)，测试与发布门禁见 [质量流程](quality.md)。

## 上游来源与安装默认

当前上游最新发布包为 `@deepseek-ai/dsh@0.2.1-rc.3`（npm `next`，`latest` 仍为 rc.2）；扩展引导安装默认包为 `@deepseek-ai/dsh@0.2.1-rc.2`，固定源码见下文版本表，隔离验证方法见[质量流程](quality.md)。发布版本与安装默认分别由 `LATEST_PUBLISHED_DSH_VERSION`、`DEFAULT_INSTALL_DSH_VERSION` 维护；新增适配不自动切换默认，安装和更新均使用经过验证的精确版本，不跟随浮动 dist-tag。默认版本不代表所有能力完成，timed 提问等验收缺口仍见能力矩阵。

历史 Host API 的固定基线是提交 [`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)：[RPC map](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/host/apiproxy/src/api/rpc-map.ts)、[events](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/host/apiproxy/src/api/events.ts)、[tool catalog](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a/packages/core/tools)。它只证明该 Host API 家族；较新的 Connection/Gateway、typed Remote 和 Session Controller 必须从**目标版本自己的 tag/commit 和实际存在的接口文件**核对。尤其 `0.1.5-rc.2` 与 `0.1.5-rc.3` 的 wire 比较不能引用上述已不存在的旧 RPC 文件；两者被适配器消费的 Session Controller、typed Remote、Connection/Gateway 与工具运行时源码相同，仍保留各自精确身份。

## 版本身份与 wire 家族

以下每个精确身份都有独立入口；同一格中的多个版本按顺序对应列出的 Adapter。源码入口不等于 npm 包可用，也不等于完成 live smoke。

| DSH 版本                                                                            | Adapter                                         | 必须保留的边界                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.0.1-rc.1`, `0.0.1-rc.2`                                                          | `legacy01`, `legacy02`                          | 旧 unary `command.*`/Host frame；后者另有 `session/tasks`、`host/remote-event` 和已声明的时区字段                                                                 |
| `0.0.1-rc.5`, `0.1.0-rc.2`, `0.1.0-rc.3`                                            | `legacy05`, `rc02`, `rc03`                      | 各自精确身份，复用已核对的 rc.6 Host wire                                                                                                                         |
| `0.1.0-rc.6`, `0.1.0-rc.7`, `0.1.0-rc.8`                                            | `rc6`, `rc7`, `rc8`                             | Host 基线；rc.8 增加 home、图片限制、中断回复和 Agent Teams 事件                                                                                                  |
| `0.1.1-rc.1`, `0.1.1-rc.2`                                                          | `rc11`, `rc12`                                  | 沿用 Host 家族；rc.2 不发送已移除的空白会话复用字段                                                                                                               |
| `0.1.2-alpha.1`, `0.1.2-alpha.2`, `0.1.2-alpha.3`, `0.1.2-alpha.4`, `0.1.2-alpha.5` | `alpha`, `alpha2`, `alpha3`, `alpha4`, `alpha5` | `/api`、Cookie、`remote.mux`、Session v0；各版错误/事件形状独立核对；alpha.1 仅源码入口                                                                           |
| `0.1.2-rc.1`                                                                        | `rc13`                                          | 仍使用 alpha.5 的 Session v0 packed history，不因 rc 名称继承 Session v2                                                                                          |
| `0.1.3-alpha.1`, `0.1.3-alpha.2`                                                    | `alpha13`, `alpha132`                           | Session v2；仅后者向 `subagent.prompt` 发送必填 `delivery`；alpha.1 仅源码入口                                                                                    |
| `0.1.5-alpha.1`, `0.1.5-alpha.2`                                                    | `alpha151`, `alpha152`                          | Session v3；后者增加交付物与父会话 Subagent 目录                                                                                                                  |
| `0.1.5-rc.1`, `0.1.5-rc.2`, `0.1.5-rc.3`                                            | `rc151`, `rc152`, `rc153`                       | v3 各自精确身份；反馈、交付物边界按目标 tag 启用；rc.3 沿已核对的 rc.2 wire                                                                                       |
| `0.1.6-alpha.1`, `0.1.6-alpha.2`                                                    | `alpha161`, `alpha162`                          | v3；alpha.2 把 control 队列基线改成 Inbox projection，并映射 `session/writer-held`                                                                                |
| `0.1.7-alpha.1`, `0.1.7-alpha.2`                                                    | `alpha171`, `alpha172`                          | Session V4、projection-only control、pinned Workspace、独立 Job Controller；alpha.2 增加 turn-window 和工具内容投影                                               |
| `0.1.7-rc.1`, `0.1.7-rc.2`                                                          | `rc171`, `rc172`                                | V4 与 Job Controller；rc.2 的 preset registry、Schedule 等只在其精确入口启用；rc.2 是源码适配，不能宣称已完成真实运行                                             |
| `0.2.0-rc.1`                                                                        | `rc201`                                         | 复用已核对的 rc.2 Gateway/Session V4 wire；保留失败工具结果恢复与 Schedule 缺失能力映射；仅精确身份，不作为未知版本回退                                           |
| `0.2.0-rc.2`                                                                        | `rc202`                                         | 保留 rc.1 的精确契约，新增 timed `userQuestions/answer` 与 `userQuestions/attachWait`、`userQuestions` 会话投影及结构化迟到答复；非幂等 answer 不重试；仅精确身份 |
| `0.2.1-alpha.1`                                                                     | `alpha211`                                      | 独立 V4 codec 与 catalog v0/v1、projection 子代理目录；保留 timed question，新增 Schedule 子代理拒绝、账号失败归一与插件实际安装版本；仅精确身份                  |
| `0.2.1-alpha.2`                                                                     | `alpha212`                                      | 独立 V4 格式库与工作目录事件、external 子代理目录、迁移状态和禁止隐式迁移的 fork；官方按需插件目录与精确安装；仅精确身份                                          |
| `0.2.1-alpha.3`                                                                     | `alpha213`                                      | Workspace replace 基线、Gateway 错误与插件 restartReason；仅精确身份                                                                                              |
| `0.2.1-alpha.4`                                                                     | `alpha214`                                      | 继承已核对 wire，增加插件 already-installed 业务错误；仅精确身份                                                                                                  |
| `0.2.1-alpha.5`                                                                     | `alpha215`                                      | 账号奖励通知标题与可选显示字段；任意 JSON 元数据留在 Host；仅精确身份                                                                                             |
| `0.2.1-rc.1`                                                                        | `rc211`                                         | 独立入口，复用已核对 alpha.5 消费契约；不作为未知版本回退                                                                                                         |
| `0.2.1-rc.2`                                                                        | `rc212`                                         | 独立入口，复用已核对 rc.1 消费契约；动态承接 Search / Fetch 设置；不作为未知版本回退                                                                              |
| `0.2.1-rc.3`                                                                        | `rc213`                                         | 独立精确入口；按预设复用空白草稿，动态承接官方模型目录与 listing 设置；不作为未知版本回退                                                                         |

`0.1.7-rc.2` 的固定源码是 [tag `dsh-v0.1.7-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.7-rc.2)，提交 `477b4f420553e8a52c2fbccc464d7561b239c443`。其他新增版本也必须在 fixture 注明 tag、commit、文件和类型；版本身份、schema、错误词汇、启动参数与能力声明一起核对。

`0.2.0-rc.1` 的固定来源是 [tag `dsh-v0.2.0-rc.1`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.1)，提交 `4878cdabd87d4041bdaff61d04c966883b9fd07a`。从预适配提交 `21638c56315ae6a2b552d6091945d3144c9af32e` 到该发布提交，Adapter 消费的 Gateway、Connection、Session、Workspace、Job、Account、Schedule、Plugin Manager、CLI 参数及工具恢复源码未变；Workspace 默认目录的原生命令改为隐藏窗口，Web profile 新增会话日志设置 UI 与遥测超时配置，均不改变此处的 Remote wire。`rc201` 保留独立精确入口，不接受旧的临时 master 版本提示。

`0.2.0-rc.2` 的固定来源是 [tag `dsh-v0.2.0-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2)，提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。相对 rc.1，Gateway、Session V4、Workspace、Job、Schedule、Account 和 Plugin Manager 的既有接口保持不变；`packages/api/remotes/src/client/index.ts` 新挂载 `dsh-user-questions`。其 wire descriptor 把首个 Agent 参数命名为 `agentId`，值沿用所属 Session ID；rc.2 Adapter 只在 Remote 边界把 Host 校验过的 `sessionId` 映射为 `agentId`。`userQuestions/attachWait` 是可取消流，只发一次 Host 剩余时长；打开 UI claim 暂停原截止时间，关闭/卸载后释放。`userQuestions/answer` 仅接受 `continued` 问题，把完整答案批次作为 `user-question-reply` 消息排入 Inbox；已排队答复必须显示只读，直到 Inbox 接纳或丢弃。Session projection 从 timed `ask_user_question` 的结构化请求/结果恢复 `active` 与 `settled`，legacy tool schema 不投影为 timed question。新工具模式仍由 DSH 的 `tool-ask-user` 插件配置启用，扩展不替用户切换 Preset。参数 `timeout: -1` 虽使用同一工具 schema，但属于无限等待，不携带 timed wait claim；UI 是否启动倒计时只依据 question event 中的 `wait.timed`。`rc202` 独立继承 `rc201`，不用于未知版本回退。

`0.2.1-alpha.1` 的固定来源是 [tag `dsh-v0.2.1-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.1)，提交 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。`alpha211` 独立继承 `rc202`，仅接受完整精确身份，不作为未知版本回退。核对目标提交的 Connection/Gateway、typed Remote、Session V4/history/control、Workspace、Job、userQuestions 和工具目录后，既有请求/事件形状保持可复用；Session list 的时间片和上传 receipt 的 Session 实例隔离是上游内部实现变化。web CLI 新增 `--public-url`，受管启动仍使用已验证的 loopback/port/`--no-open` 参数。

目标版本的增量保留在 `versions/alpha211/`：

- [Schedule 类型与 Remote](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/schedule/schedule/src/types.ts)新增非变更 `subagent_session` 拒绝；仅 alpha211 的 update mapper 接纳并投影为 Domain/严格协议/本地化 UI 错误，旧入口仍拒绝未知形状。web profile 直接挂载服务，`standard`、`cordis`、`ptc` Preset 挂载 `tool-schedule`；旧可选 Schedule bundle 已删除。工具创建仍由 DSH 执行，扩展不调用未声明的 create Remote。
- [账号失败类型](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/credentials/deepseek-account/src/types.ts)新增 `no-response`；版本内将它归一为 Domain 的 `network`，unary 和 watch 共用同一校验，其他未知失败仍为协议错误，授权 URL 继续只交 Host。
- [Plugin Manager 类型](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/boot/plugin-manager/src/types.ts)新增实际安装清单 `version` 与 bundle `source`。安装和同 ID 恢复仅投影经过验证的 SemVer 版本；Webview 保留版本并展示实际安装值。`source` 可以含绝对路径或私有 URL，始终留在 Host，严格协议拒绝该字段；不因新增字段重试安装。
- [结构化工具参数流](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-tool/src/client/tool/models/tool-call-model.ts)增加生成期预览。alpha211 入口按 Session/attempt/call 增量读取 typed `tool-call-delta`，只投影有界说明、完整文件路径和解码字符数；独立 `tool.preparing` 不占用持久游标，不触发文件变更或 Schedule 完成判定。Host 只发布所属工作区的相对路径，正文不跨协议；畸形 JSON 清空预览，重连、重试、中断和回合结束移除旧预览，持久调用替换预览。旧版本的流归一行为不变。

- Plugin Creator 快捷入口只在实时 roster 提供健康 `cordis` 时可用；从插件页关闭设置并创建空 Creator 会话，失败保留 Composer 草稿，不发送初始化消息。来源为目标 `ui-agent-preset/CreatePluginMenuItem.tsx` 及 workspace draft 初始化；不额外套用旧模式管理页的 Developer Tools 门槛。
- 可选 [Claude Code mods](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/experimental/claude-code-mods) 仅 alpha211 暴露独立 `modsBand` port。固定 `claudeCodeMods/watchBand` 和 `pressBand` 使用 `{agentId}` 与 generation/actionId；读取采用有界长轮询，退出会话、超时和关闭 backend 释放订阅。不可用服务隐藏，协议/业务错误保留；Webview 仅接收有界 Box/Text/Button DTO，无任意 Remote、原始 props、HTML/CSS、地址、Cookie、PID 或路径。执行仅接受该会话当前已公告的可用按钮，过期/并发拒绝，未知执行结果不自动重试。
- [Inspector](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/experimental/inspector) 发现先访问已认证 bootstrap，再访问它明确公告的 numeric loopback Worker；禁止重定向和端口扫描，Worker 不接收主 Cookie 或 ingest token。仅接受固定 Worker 身份、唯一 Host target 与精确 CDP/frontend 路径。DevTools URI 只留在 Host，原生打开与复制只由用户操作触发，Webview 接收可用性和动作结果。会话检查器本地展示事件/节点的 allowlist 元数据、类型过滤、分页、权威 sequence 匹配、聚合行拾取与虚拟列表定位；原始日志、模型/工具正文及内部对象不跨安全边界。
- captured Markdown 文件在现有用户触发的 Host 脱敏预览内显示 frontmatter 字段和安全 Markdown。只识别完整前导 YAML mapping；保留数字拼写、集合/alias 源文本，不展开 alias，限制源码、字段、AST 节点与深度；畸形值回退文本。统计明细使用既有权威时间/usage 分桶，不生成缺失的缓存或 total 值。

这些入口遵循 VS Code 宿主安全边界，不复制上游桌面布局或原始诊断对象。mods 与 Inspector 是可选插件，不是标准后端必需服务。各项适配及现场缺口见 [能力矩阵](capability-matrix.md)。

脱敏增量 fixture 与精确探测/错误/取消/释放测试见 `alpha211-*-contract.spec.ts`、`alpha211-mods-band.spec.ts` 和 `alpha211-inspector.spec.ts`；`tests/alpha211-feature-projection.spec.ts` 与 Extension composition 规格覆盖 Adapter→Application→Host→严格协议，Webview 规格覆盖最终动作、安装恢复、解析与长列表。隔离真实包 smoke 与 `tests/live-dsh/alpha211-surfaces.spec.ts` 已验证精确入口、Session/Workspace、timed question 的未知 call 与空 wait 路由、默认 Schedule/Plugin Manager 目录、账号空状态/watch、Creator roster 和未挂载可选服务。`alpha211-optional-surfaces.spec.ts` 在精确发布实验包的隔离 overlay 下验证实际 Inspector bootstrap/Worker、mods 读取/按钮执行/取消/过期拒绝及两个端口释放；测试专用 mod 不使用模型或工具。本机 VS Code managed E2E 已通过扩展 Host connect/reconnect；真实 timed 问答、委派提醒拒绝、插件安装恢复、OAuth、模型参数预览、Chrome 原生打开及新增 Webview 交互仍需独立现场证据，相关能力维持 `PARTIAL`。

`0.2.1-alpha.2` 的固定来源是 [tag `dsh-v0.2.1-alpha.2`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.2)，提交 `d743267388641bc76f17c45ce8b4c231aed1d32c`。`alpha212` 独立继承 `alpha211`；两者分别加载精确发布的 V4 codec，历史入口的格式库及依赖解析保持原值。完整快照恢复与逐条事件校验使用同一版本 profile，不把新事件登记为未知可忽略事件。

- [工作目录](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/session/working-directory/src/index.ts)的必需 `working-directory/change` 保留持久 sequence 并归一为 Host 投影；Session header 的原始项目目录继续用于工作区归属。当前目录不跨 Webview，工具结果中的规范路径经 Host 归属校验后才投影为相对路径；PTC 子调用保留同样的结构化 meta。失败结果不提供导航 authority，目录变化清除旧参数预览的路径基准。
- 两个新 alpha 入口均从 `session/projections` 读取子代理目录，不调用上游未声明的 `subagents/list`。alpha211 接受 `{asOfSeq, values}`；alpha212 只接受 `kind: sequenced` 的精确基线，`migration-required` 的无序号提示不建立子会话路由。null 表示不可读取。子目录读取有并发上限，分支失败保留诊断；原子提交目录及刷新 generation 守卫沿用共享仓储。
- alpha211 接纳 catalog v0/v1；alpha212 增加 [catalog v2](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/subagent/subagent/src/catalog.ts) 的 `external` 执行。它只用于目录展示，没有本地 child Session，不进入地址表或历史/Follow-up/Interrupt 路由。未知模式保留诊断。
- [Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/api/session-controller/src/types.ts)的 `formatStatus` 经 Domain/Host 到列表，成功解码 V4 历史后显示 current。alpha212 `session/fork` 使用真实 `{request}` 参数并固定 `allowMigration: false`；需要迁移时提示先打开源会话，拒绝在后台分叉中启动迁移。
- [Plugin Manager](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/boot/plugin-manager/src/types.ts)的 `official`、`availability` 和安装目标由 alpha212 严格解析。Application 移除 Host 私有 `installTarget.spec`，仅投影可安装状态和目标版本；Webview 发出包名，Host 重新查询实时目录并走现有检查、确认、取消与同 ID 恢复流程，安装使用 `saveExact: true`。已有文件的包使用启停入口，缺少文件的包显示安装入口。实际安装 receipt 的版本继续沿用 alpha211 校验。
- Connection/Gateway、timed userQuestions、Account、Workspace、Job、Schedule、动态命令/Settings，以及可选 mods/Inspector 保留经过固定源码核对的能力入口。上游移除 tool mode `both` 不产生本扩展静态选项；运行目录、Preset 与 Settings 继续由上游目录决定。受管启动仍限定验证过的 loopback HTTP 与所有权。

这些入口不作为未知版本回退；真实模型运行、外部执行和新增 VS Code 交互缺少独立现场证据时，能力保持 `PARTIAL`。

### 后续精确入口的固定来源

| Adapter    | 目标版本        | 上游固定提交                                                                                                                                |
| ---------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `alpha213` | `0.2.1-alpha.3` | [`2fbf4359b82fb94c03dcce0b831660d87f12ea5c`](https://github.com/deepseek-ai/deepseek-harness/tree/2fbf4359b82fb94c03dcce0b831660d87f12ea5c) |
| `alpha214` | `0.2.1-alpha.4` | [`86a402200d95fecef4529d969836f1fe13c6cb0d`](https://github.com/deepseek-ai/deepseek-harness/tree/86a402200d95fecef4529d969836f1fe13c6cb0d) |
| `alpha215` | `0.2.1-alpha.5` | [`1517a4dbca0a2789ff1d41ba439600f8547d23fa`](https://github.com/deepseek-ai/deepseek-harness/tree/1517a4dbca0a2789ff1d41ba439600f8547d23fa) |
| `rc211`    | `0.2.1-rc.1`    | [`1600d8a1e140dcde43a1a0941940a0480712c011`](https://github.com/deepseek-ai/deepseek-harness/tree/1600d8a1e140dcde43a1a0941940a0480712c011) |
| `rc212`    | `0.2.1-rc.2`    | [`687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317) |

逐提交比较 Connection/Gateway、typed Remote、Session V4、Workspace、Plugin Manager、Account 和工具目录后，五个入口按顺序继承已核对能力；Session V4 codec 源码与前一已支持入口相同，继续使用既有独立格式库。Gateway 新增 peer 专用载体不取消根客户端的 Cookie/token 交换，扩展保持已验证的根客户端路径，不把自己伪装成 peer。

格式 codec 相同不代表事件目录相同：从 `0.2.1-alpha.3` 的固定提交起，`packages/jobs/jobs/src/types.ts` 增加 `job/registered` 与 `job/settled`，直到 `0.2.1-rc.2` 的原生目录均为 62 类事件。`alpha213` 的独立 Session profile 校验它们的身份、原始 owner、时间、工具归属及结束状态；后续精确入口继承该 profile，旧入口不接纳为已知事件。这两类是 log-only 审计事实，读取时保留序号但不恢复执行权或重建 Job roster；任务状态、输出和停止继续使用上游 Job Controller。

Workspace `replace` 是同一 generation 的完整目录基线，必须替换旧缓存并保留 pinned/archive；旧 wire 仍拒绝这个新帧。Gateway 的 `interactions-forbidden` 映射权限拒绝，`peer-disposed` 映射连接不可达；写操作不因此自动重试。

Plugin Manager 只在新入口读取并校验五种 `restartReason`，从 mutation、install 和同 ID 恢复一直传递到本地化提示。后续入口接纳 `already-installed`，旧入口继续拒绝未知业务结果。新的 requirements/incompatibility 原文和 bundle source 不跨 Webview。Plugin Market 的新增专用 Remote 尚未提供独立页面，已有 registry/spec/安装和清单能力不冒充市场功能。

账号奖励通知的 `title` 和 display 字段可以缺省；`campaign`、`amount`、`currency`、`grantedAt` 可以是任意 JSON，不能据此拒绝整批通知，也不能把它们原样投影。只发送安全字符串显示字段和有界标题，缺省金额仍允许显示及确认奖励；`orderId` 继续严格校验，确认身份留在 Host。

rc.2 与 rc.1 的 Connection / Gateway、全部 API Remote、Session V4、Account、Plugin Manager 和工具声明源码相同。新增 Search / Fetch provider 通过 `settings.describe` 暴露 `web` 的实时 provider 选择和 `web-deepseek-api` 的配置，包括结果数量及是否发送原始问题；通用插件配置界面从运行时 schema 生成控件，不内置 provider 清单。密钥继续通过 Host 原生凭据入口管理。上游临时模型标签只改变展示，不改变目录名称、model ID 或路由，本扩展保持权威目录原值。精确准入、继承的错误 / 取消 / 释放及隔离真实配置读写入口见 `rc211-contract.spec.ts`、`rc211-incremental-contract.spec.ts` 和 `tests/live-dsh/rc211-surfaces.spec.ts`。

### rc.3 的模型目录与空白草稿

`0.2.1-rc.3` 固定到 [tag `dsh-v0.2.1-rc.3`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3)，提交 `1f81c047fc48fa190a683e469daa699857e9afe8`。相对 rc.2，Connection/Gateway、Host 侧 API Remote、Session V4 与格式目录、Workspace、Job、Schedule、Account、Plugin Manager、Typert、CLI 参数及工具声明源码未变；Session Controller 的 client summary 注释更新不改变 wire。`rc213` 独立继承已核对的 rc.2 契约，保持精确身份及 `fallback: false`。

- [新会话导航](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/ui-workspace/src/client/navigation.ts)重新使用工作区内可复用的空白会话；指定预设时跳过已列出其他预设的候选，未列出预设仍可候选。Adapter 声明 Domain `blankSessionReuse`，Host 只投影安全布尔值，严格协议拒绝非法类型和 Host 私有字段。Webview 按能力进入原生创建流程，传候选 `sessionId` 与所选预设，不发送旧 `reuseWorkspaceBlank`；Host 先验证所属工作区，DSH 对候选是否仍可复用作最终决定。打开实际回执 ID，保留已有模型与该会话草稿；Creator 不接管列出其他预设的普通草稿。不自动发送消息，重复点击合并，较新的导航或连接使迟到回执失效。旧入口保留原有创建策略。
- [官方 API-key 目录加载](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/llm/llm-deepseek-api-key/src/index.ts)与账号路由共用缓存和 listing 解析。是否读取官方 `/models`、认证、后台刷新、失败重试、明确的自定义模型配置及非官方 origin 的边界均由 DSH 执行；扩展仍从原生 `session/modelCatalog` 动态读取名称、推理选项、可路由状态和失败，不另行访问官方 API。普通 ModelCatalogModel 不承诺 `contextWindow`，扩展不为缺省字段补造百万上下文；新的内置上下文值由 DSH provider 配置声明，实际请求额度归 DSH 管理。
- [listing 配置](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/llm/llm-deepseek/src/listing-config.ts)的 `modelsTimeoutMs`、`modelsMaxAgeMs` 通过通用 Settings schema 进入配置界面，保留实时生效、修订校验、非法值拒绝及重置。设置 namespace 来自 Loader entry ID（默认 API-key entry 为 `llm-deepseek`），不能从 npm 包名猜测。账号的模型 override 与凭据规则仍由原有动态设置承载，Secret 不跨 Webview。
- [入口定制](https://github.com/deepseek-ai/deepseek-harness/tree/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/ui-entry-customization)及会话视图折叠属于 DSH 浏览器 client slots，没有新增 Host Remote。扩展继续以 VS Code 原生视图布局、现有插件管理和 Creator 入口提供相应工作流，不执行第三方浏览器组件、插槽或遥测。原生视图拖动与设置不转换成未声明的 DSH RPC。
- 配套包 `@dsh-vscode/editor-bridge@0.2.2` 的 `engines.dsh` 和 Cordis/Tools/Typert peers 使用 `*`，Host peers 标为 optional；兼容声明覆盖各类 DSH 版本及预发布，不以已验证版本作安装白名单。能力由所连接服务、`describe`/方法及独立编辑器协议协商，缺失方法明确不可用，认证 Peer 与 owner 权限校验保留。只有构建用的 devDependencies 固定类型基线，发布归档不会因此安装另一套 DSH 核心服务；锁文件保留历史 codec 的独立 peer 快照。目标 tag 的工具、Registry 和 Remote 注册源码仍须核对；声明可安装不等于所有运行时已验证。`tests/live-dsh/editor-bridge.spec.ts` 由 `DSH_LIVE_EDITOR_COMPANION=1` 显式启用，针对所选精确运行包验证标准 tgz 安装、元数据、工具执行、更新/移除/重装/取消与释放；不调用模型。

新增增量 fixture 为 `rc213-contract.spec.ts`，精确准入、继承的 Workspace/error/probe 取消与释放由共享版本表覆盖；Webview 草稿/导航/并发、Host 归属和严格协议各在对应边界回归。隔离真实运行入口为 `tests/live-dsh/rc213-surfaces.spec.ts`、`rc211-surfaces.spec.ts` 和 `run.spec.ts`：空白复用、归档候选替换、Preset 回读、Search/Fetch 与 listing 设置读写/拒绝/恢复、账号和可选服务读取、进程端口释放。空 home 不证明真实官方账号/凭据列表、付费模型、浏览器插槽或人工 Webview 体验，相关能力保持 `PARTIAL`。

未发布主干的同版本开发构建不等于该 tag：已审计快照 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` 含 Gateway 访问控制、Typert resource resolver、Session summary/baseline、媒体与插件安装等后续变化，不能以 rc.3 标签套用未冻结的主干契约。精确支持范围针对上表固定发布来源；后续发布需重新比较自己的来源。

### 未知版本

对非空但未识别的标签，先进行公共握手，再按显式优先级只读 `probeCompatibility`。候选拒绝、超时或契约不匹配时尝试下一个；全部失败才拒绝连接。成功后保留真实版本标签、所选 Adapter 和兼容警告。只可复用经过证明安全的基础 wire：Session v2/v3/V4、`delivery`、turn-window、目录/交付事件和其他版本专属字段不能通过相近版本号猜测；未知 Remote 或事件安全降级为 unknown 或 `CAPABILITY_UNAVAILABLE`。畸形 SemVer-like 身份在 wire probe 前拒绝。

## 编辑器配套插件

编辑器协议独立于 DSH 版本：包 `@dsh-vscode/editor-bridge` 提供元数据协议 1 和工具协议 2。客户端在已连接的 Remote 家族中探测自身固定方法，不因 DSH 标签不同就隐藏仓储；缺失方法只使该能力不可用，不阻断聊天。原始 `rc212` 入口保留兼容导出，公共仓储不依赖该版本身份。

配套默认不自动安装；用户在设置中选择安装并启用后，Host 通过 DSH 原生 Plugin Manager 将随扩展构建的 tgz 安装到扩展自有 profile，启动不再注入本地文件或专用 overlay。包按 DSH 规范导出 `package.json` 与 `locale/*.json`，中英文 `meta.title/description` 直接进入 DSH 自身的插件目录。安装依赖 DSH 环境中的包管理器及精确兼容检查，失败不阻断聊天。原生 tarball 安装同时负责更新已有依赖，更新前不卸载旧包；失败或取消由 DSH 恢复原 manifest/lockfile，可用的缓存包用于恢复。

设置读取原生 `listBundles` 判断安装状态，安装意愿标记不代表已经安装。自有实例安装前只读探测 pnpm，禁用 Corepack 探测中的联网；缺失或损坏时先显示命令、官方指南与重新检测，不发送安装 mutation。远程环境在 Extension Host 侧准备依赖。迁移只移除扩展存储内经名称、loader 特征和引用归属验证的旧文件，跳过符号链接、未知文件和锁定项；缓存、回滚包及会话数据不清理。

用户可明确发起安装／修复 pnpm：优先使用 Corepack 的标准全局准备命令，缺少 Corepack 时使用 npm 安装已验证版本，验证可执行后重连扩展自有 DSH 以更新环境。准备操作独立支持取消，失败不宣称配套已经安装；首次配套安装仍由用户发起。只读探测不触发依赖修复，外部实例不执行此操作。

固定源码已核对 `dsh-v0.2.0-rc.2` / `639ed015397290b3745d163aafe02ffee4aa3f84`，以及 `dsh-v0.2.1-alpha.1` 至 `alpha.5`、`rc.1` 至 `rc.2` 的 Typert Service/Registry 和工具契约；关键来源为 `apps/cli/src/bin.ts`、`packages/typert/protocol/src/index.ts`、`packages/typert/registry/src/service.ts`、`packages/core/tools`。`rc.1` 为 `1600d8a1e140dcde43a1a0941940a0480712c011`，`rc.2` 为 `687f282e8625c6b8d11ff58211a90524be2e4317`。标准安装及元数据来源固定到该 `rc.2` 的 `packages/boot/plugin-manager/src/index.ts`、`packages/boot/app-boot/src/package-meta.ts`、`packages/host/plugin-inventory/src/index.ts`；旧版本已有真实工具链证据不等于新版安装流程已验证。引入 Principal 前的 Gateway 仅提供认证 Peer ID，新 Gateway 则另要求 owner principal；真实 Peer 仍用于绑定归属。

协议 2 的 `vscodeEditorCompanion/describe`、`verifyHost`、`attach`、`poll`、`respond`、`detach` 均以 `request` 为命名参数；结果为严格 `status: ok/error` 联合。可选 `buildIdentity` 方法返回随包构建指纹，旧配套缺少它不改变原有 `describe` 形状。用户已选择安装且启用后，只对当前自有实例中已经安装的配套比较指纹并走标准更新；缺包仍要求显式安装，不自动替换外部连接。原生结果要求重启时才重连自有实例。F5 遵循相同安装选择，构建后以调试专用标记启动新实例并采用空闲端口，不改持久连接设置。协议 1 的 `vscodeEditorBridge` 方法保留，仅能力缺失时回退元数据。无法协商的能力不会被猜成成功，普通附件和手动编辑器上下文仍可使用。共享要求 loopback 及同侧随机文件挑战；内容访问限于当前 VS Code 窗口已打开且受信的根，按已有编辑器设置授权，不要求协议 2 会话目录与根相同。协议 1 回退保留目录关联校验。协议 2 可先绑定请求通道，缺少文件夹或信任时在首次工具调用提供原生入口，满足条件前不读取内容。远程环境按 Extension Host 执行侧处理，不把端口转发当成共享文件系统证明。

新协议最多十六个独立会话绑定，每个最多四个请求；poll 最长一秒、lease 四十五秒、请求时限十秒。同一会话不允许第二个窗口重复绑定，新旧协议不重复授权。请求取消只释放对应请求；慢采集不阻塞续期，迟到回复不满足新请求。短暂传输失败退避恢复，连接/会话切换串行释放并重建授权；显式关闭持久化到工作区，重连不擅自打开。单个路径请求越界或不存在不撤销其余工具能力。

设置页通过 Host 的 `editor.companion.status/configure/action` 查看安全状态、修改启用/允许编辑，及主动安装、重试、修复、重启、撤销或创建独立实例。偏好在已打开文件夹或工作区时保存到工作区设置；空窗口保存到用户设置，不要求先打开目录才能安装或关闭共享。输入采用严格 schema，状态不携带端点、绝对路径、授权标识或原始错误。安装及停止/重启仍仅操作扩展自有实例；独立实例恢复路径不停止原外部进程。

工具读取未保存缓冲区、选区、诊断、语言服务与导航，或直接执行可撤销编辑。空选区返回空文本；文档读取每次最多 200 行、16,384 个 UTF-16 单元，选区保留 65,536 单元上限。分页以返回 range.end 的行和列作为下一次 startLine/startColumn，越过 EOF 的起点返回 invalid-range，结束行截到 EOF，不把末行冒充请求行；条目最多 200。草稿仅返回可验证的相对句柄，不返回原始 untitled URI。多根名称清理并去重，嵌套根按最长路径归属；真实路径允许根内符号链接，拒绝根外目标。重基只在已知旧版本且修改范围可明确区分时执行，有界快照不复制巨大文件；不确定冲突返回 stale，不能宣称写入成功。编辑按当前设置授权，不再逐次弹确认，原生 Undo 和独立撤回保留；编辑及独立撤回仅自动保存原本干净且未被并发输入改动的缓冲区，保留用户未保存内容，回执 saved 布尔值说明保存结果；原生写入回执丢失时保留撤回快照，无法确认的结果用 uncertain 明示，禁止直接重发。propose 接受 applied/uncertain/stale/cancelled 的不早于期望版本回执，旧 pending 仍须版本相等；未知回执 ID 返回 not-found，文件不存在与权限/IO 故障不再冒充越界，读版本错误不使用写操作文案。结果不明的编辑不得自动重发，需先读取核对。正文仅返回已授权 DSH；结构化实时/历史工具卡投影安全摘要。

完整目录与限制见[配套包说明](../packages/dsh-editor-bridge/README.md)。设置页在安装进行中或结果未知时保留独立取消入口，以原请求 ID 调用 `cancelInstall`，保留原安装响应以接收最终结果；原生确认前不宣称取消成功。未知结果通过 `waitForInstall` 查询，禁止重复 mutation。原生安装、等待及移除使用十分钟传输预算，调用方取消和连接关闭仍即时生效；普通请求保持原超时。标准安装或重启失败时仍保留聊天与手动上下文。

## 启动与传输

`packages/dsh-adapter/src/launch-contract.ts` 集中生成启动参数。`0.0.1-rc.1/.2/.5`、`0.1.0-rc.2/.3/.6/.7` 使用 `--profile web --host 127.0.0.1 --port <n>`；从 `0.1.0-rc.8` 起的已核对入口还传 `--no-open`。未知版本不猜可选 flag。端口为已验证的 loopback 端口，不扫描范围。进程所有权规则见 [架构](architecture.md)。

旧 Host 家族的 RPC 与 mux 是两个逻辑流；Session 事件带 `sessionId`/序号，订阅使用 `lastSeq`，审批和问题响应使用结构化 `rpcId`。Alpha 家族的 Connection Remote 走 `POST /api/<namespace>/<method>`、Cookie 握手和 `/api/remote.mux`；mux 使用 `open`、`cancel`、`item`、`error`、`end` 帧。每个 Session 保存最后提交的服务器序号；重连先订阅，再比较序号、分页补洞、去重后归约。`system/message` 和只面向模型的 surface replacement 只留下序号水印，内容不进入人类时间线；未知事件只保留脱敏的类型、序号和摘要，不阻断后续事件。

Session v2 的 `isSeeded`、event-only history 与 assistant stream 修订帧只在精确 v2 入口启用。Session v3 严格验证 event envelope、surface replacement、PTC 和 Host-only system watermark；`image/offload` 保留为脱敏 opaque 事件，持久图片引用仍可读取。Session V4 的工具结果是带 `role: 'tool'`、`toolCallId` 与 source 的 first-class message，必须先验证配对再投影。新的 projection 事件不由客户端猜成人类可见状态。

读取 DSH 已恢复的 V4 会话时，客户端逐条处理可解释的记录，不重复执行完整持久日志的恢复与关系校验。未知或单条不可解释的记录降级为无正文、无控制语义的内部序号标记；无安全序号的记录不解释，不能因此拒绝其余可读历史。打开、翻页和实时跟随使用同一规则；任务、权限及其他状态继续使用原生 Controller 和投影，未知记录不触发执行操作。外层会话身份、游标和投影结构仍须校验；版本事件基线复用固定上游格式包导出的目录，不手工复制整张事件表。

旧版历史同样按记录隔离不可解释的数据；识别事件时忽略未消费的新增 envelope 元数据。临时 assistant preview 不能阻断持久回复：预览帧不连续或基线畸形时先重订阅 `session/follow` 并采用其新基线继续流式（最多三次；首次立即，连续失败再退避 250–500ms），同一 attempt 的本地恢复只交付未发出的 chunk；新 follow 或不同 attempt 仍完整采用权威基线。仍失败才释放已收到的持久回复、退回 durable follow；缺失 `assistantStream` 基线表示宿主未接受 opt-in，不重试，等下一个 attempt 的 `start` 帧再恢复。任何路径都不伪造增量或正文。Remote 通知没有 durable sequence，Preset 变更经 Host 通知触发目录刷新，不包装为缺失序号的 `session/event`。共享 mux 保留消息大小、身份及 JSON 边界，能确定所属逻辑流的错误仅终止该流，不能关闭其他会话的流；未知通知不推断为审批或权限操作。

Control 基线随 wire 变化：早期 alpha 是 `queues`/`jobs`；`alpha162` 是 `jobs`/`projections.<sessionId>.values.inbox`，以 `next-turn`/`next-step` 和消息 ID 投影 Queue/Steer；`alpha171` 起只接受 `projections`，Job roster 从独立 `job/list` 的 whole-set rows 流读取。旧形状不得穿过新入口。Job follow 用绝对 UTF-8 字节偏移，首次数据帧可重放跨恢复游标的完整 chunk；客户端按字节且在码点边界裁掉已显示前缀。空文本的 lossy/gap 尾标志不能显示为输出。

只有明确支持 turn-window 的精确入口，才在普通 Session/Subagent 首屏与历史分页发送该参数：首屏/follow 使用至少 50 条、2 回合，扩展旧页使用本地 pageSize 200 条、2 回合；这与上游普通 `loadOlder()` 的 50 条默认值不同。补洞、导出、Goal 等严格读取继续按有界 durable sequence 分页。工具 `projectContent()` 插入的标准 ContentBlock 按结构化内容映射，不解析渲染文本。归档恢复只在精确声明该 Remote 的入口开放；旧 Host/alpha 入口在调用底层前明确返回不可用，永久删除没有上游契约。

## 工具、命令与交互

`rc201` 及继承它的精确入口直接消费 [rc.1 的 tool-todo projection](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/todo/tool-todo/src/index.ts)：原生 `todos` 是整值数组或 null；`todo/write` 替换，`turn/start` 清为 null，`turn/end` 保留清单。rc.2（`639ed015397290b3745d163aafe02ffee4aa3f84`）和 alpha.2（`d743267388641bc76f17c45ce8b4c231aed1d32c`）已核对同一行为。Adapter 只将 key、条目身份及 `in_progress` 映射为 Domain `todoList` / `in-progress`；完整基线缺少服务表示空当前列表，不从历史 Todo 卡恢复。历史卡仍属于对应回合；旧版未声明该 projection 时，由 Host 桥接结构化 Todo 整值，Webview 不再扫描历史。桥只采用最新尾部，裁切带明确标记；新版原生投影一旦可用就停止该桥的推导，不能用新版投影契约猜测旧版。

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
- `0.2.0-rc.1` 的受管 `web` profile 将 Schedule 放在默认关闭的可选 bundle；仅给旧 `schedule`、`ui-schedule`、`time-context` 行写入 home patch 不能挂载服务。未挂载时 Remote 路由的 HTTP 404 按 Schedule 接口映为 `CAPABILITY_UNAVAILABLE`。Gateway 对没有活动 Remote 的 endpoint 使用 `gateway/invocation-unavailable`；先注册后撤下的 strict definition 使用 `gateway/definition-unavailable`。共享词汇归一层将这类 Gateway 缺失码归为 `unknown-command`，共享 RPC mapper 映为 `INVALID_CONFIGURATION`。因此 `rc201` Adapter 在 [Schedule 仓储](../packages/dsh-adapter/src/versions/rc201/schedule-repository.ts)仅对五个静态 `schedule/*` 方法、匹配的 `rpcMethod` 和精确 `unknown-command` 做版本内映射，其他方法和错误仍走原分类。面板据此说明「本 DSH 未提供提醒服务」并禁用创建入口，不把服务缺失显示为 `0 of 0`。
- Plugin Manager 的可选 bundle 启停发出 `plugin-manager/changed`；它不等同于 `schedule/changed`。Extension 已把前者投影为 `plugin.manager.changed`，Schedule 面板在收到时重新读取目录，并在历史页签打开时同步重读所选任务的历史；若上游返回 `restart-required`，连接重建会触发现有 epoch 刷新路径。
- Goal 的持久 phase 与进程内 armed 状态分别读取；旧请求不能覆盖较新的流事件。Plan 卡只从完整结构化 `exit_plan_mode` 参数建立。

### Schedule、Plugin 与账号的长操作

Schedule 的目录、历史、更新、删除走目标入口声明的 Remote；创建走新会话中的 `schedule_create` 工具。创建请求锁定到同一 Session 的 `turn.started` 与匹配 `turn.ended`，随后刷新权威目录；只有**成功读到空目录**才允许重新创建。目录读取失败保持 pending，跨 Session/turn 事件不能解除锁，aborted 终态、超时、取消和 watcher dispose 均须处理。时区、cron、DST、重复提交与 Drawer 重开也需验收。

Plugin 安装前的二次 inspect、registry、Host 确认或 Adapter 本地验证失败，明确返回 `PLUGIN_INSTALL_NOT_STARTED`，可重试且不调用等待 Remote。取消覆盖预检与确认；先到的取消意图有界保留，防止随后发出安装。Remote 一经调用，断线或畸形回包都视为结果不确定：以同一 `installRequestId` 查询 `waitForInstall`，有界缓存可恢复同一 Host 已完成结果，恢复期间仍可取消；`not-running` 可按同 ID 重试取消。结果仍未知只刷新目录，不重新安装。启用单个可选插件 entry 需要 Host 模态确认；只读 inventory 不冒充完整管理器，上游无通用 registry 搜索时不伪造搜索。

账号授权 URL 只由 Host 打开，DSH loopback callback 与 `watch`/`watchExpiry` 的订阅由 Host 持有并释放；用户可取消授权 attempt。任务影响未知时由 Host 确认，成功登录边沿才调用目标入口声明的默认模型初始化。资料、钱包和 bonus 只经安全 DTO 投影；过期以 Host 时钟判断，连接身份变化清空 Webview 账号快照，Host 的 account-scope revision 隔离旧账号卡与迟到 ACK。旧 signed-out 详情读取不能清除新账号确认状态；usage/top-up 页面仅由 Host 打开。以上需独立验证真实 DSH OAuth 和 VS Code 交互，自动契约测试不等于现场通过。

## 契约变更验收

每次新增目标版本：固定 tag/commit 与被实际消费的源码，比较接口而非名称；建立独立版本身份和脱敏 fixture；覆盖成功、业务/协议错误、畸形响应、超时、取消、释放和邻近版本拒绝中适用的路径。只重试明确幂等的瞬时故障，原始 body 不跨 Host。上游新增可安全降级为 unknown；已消费形状删除或改变必须使契约测试失败。保留旧 Adapter 回归，更新能力矩阵；没有目标版本的真实运行证据不得标为 `DONE`。宿主公开正文与失败原因不得被 Adapter 静默截短；展示层用滚动/折叠承载长文本，列表若截断须说明省略数量。
