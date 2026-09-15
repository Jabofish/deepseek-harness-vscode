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
- rc.6 Host 与 mux 是两个逻辑流；session 事件携带 `sessionId` 和序号，订阅携带 `lastSeq`，审批/问题响应使用 `rpcId`，工具调用与结果使用结构化视图。
- Session v2 只在 `alpha13`/`alpha132` 精确入口启用 `isSeeded`、event-only history、`assistantStream` 和 `start/chunk/end` 修订帧。
- Session v3 只在 `alpha151`/`alpha152`/`rc151`/`rc152`/`alpha161` 精确入口启用严格 envelope、surface replacement、`system/message` 隔离和 PTC 事件；`alpha161` 的 `image/offload` 是上游消息投影事件，当前只作为脱敏 opaque unknown 保留，不伪造本地投影。
- `system/message` 只在 Host 保留序号水印；系统提示词、Cookie、launch token、endpoint 和原始上游错误不进入 Webview。
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

## 事件恢复与资源所有权

每个 Session 保存最后提交的服务器序号。重连顺序固定为：重新订阅、比较序号、通过历史补齐缺口、去重、提交 reducer。事件不能只按时间戳排序；未知事件保留安全的类型/序号/摘要，不能阻断后续已知事件。

Extension 只停止自己创建并持有句柄的 DSH 进程。外部实例必须保持运行；连接、WebSocket、订阅和临时资源在成功、失败、取消、超时和关闭路径都要释放。
