# DSH 上游契约基线与兼容策略

## 当前上游版本

| 项目                        | 固定值                                      |
| --------------------------- | ------------------------------------------- |
| npm CLI 默认                | `@deepseek-ai/dsh@0.1.2-rc.1`               |
| API package 默认            | `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2` |
| 默认源码提交                | `b150a551b8`                                |
| Node 最低版本               | `22.19.0`                                   |
| 已发布 alpha.2 npm          | `@deepseek-ai/dsh@0.1.2-alpha.2`            |
| 已发布 alpha.3 npm          | `@deepseek-ai/dsh@0.1.2-alpha.3`            |
| 已发布 alpha.4 npm          | `@deepseek-ai/dsh@0.1.2-alpha.4`            |
| 已发布 alpha.5 npm          | `@deepseek-ai/dsh@0.1.2-alpha.5`            |
| 已发布 0.1.3-alpha.2 npm    | `@deepseek-ai/dsh@0.1.3-alpha.2`            |
| 已发布 rc.1 npm             | `@deepseek-ai/dsh@0.1.2-rc.1`               |
| alpha.2 源码 tag            | `dsh-v0.1.2-alpha.2`                        |
| alpha.2 源码提交            | `0a53fb55bea101816fa226bb964ae2bed71c343b`  |
| alpha.3 源码 tag            | `dsh-v0.1.2-alpha.3`                        |
| alpha.3 源码提交            | `dd6322d604e00eec1ba5e0c8541159906a21094a`  |
| alpha.4 源码 tag            | `dsh-v0.1.2-alpha.4`                        |
| alpha.4 源码提交            | `4e84901e6471b79ec0338099867ebb4606d12bb5`  |
| alpha.5 源码 tag            | `dsh-v0.1.2-alpha.5`                        |
| alpha.5 源码提交            | `db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5`  |
| rc.1 源码 tag               | `dsh-v0.1.2-rc.1`                           |
| rc.1 源码提交               | `a66e4702047846cdaa10c66c9d3df3951f5ea70d`  |
| 当前 master 提交            | `c389f96bf3a9b6807cb71ed6bdad5849be0df6d8`  |
| 最新 0.1.3-alpha.2 发布 tag | `dsh-v0.1.3-alpha.2`                        |
| 最新 0.1.3-alpha.2 发布提交 | `82a5fd61a7cf5c293cec4bdff68f455398d685e9`  |
| 0.1.3-alpha.1 源码 tag      | `dsh-v0.1.3-alpha.1`                        |
| 0.1.3-alpha.1 源码提交      | `d347e703908d0406b7a7ef80e3a0e594d86b2215`  |
| alpha.1 源码 tag（未发布）  | `dsh-v0.1.2-alpha.1`                        |
| alpha.1 源码提交（未发布）  | `cd5ef8148158c3a752a658978873241fdf8e2bbc`  |

权威入口：

- [官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [rc.2 RPC Map](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8/packages/host/apiproxy/src/api/rpc-map.ts)
- [rc.2 Event Contract](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8/packages/host/apiproxy/src/api/events.ts)
- [rc.2 Tool Catalog](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8/docs/tool-catalog.md)
- [rc.2 CLI/Profile Reference](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8/apps/cli/reference/README.md)
- [alpha.1 source tag](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.2-alpha.1)
- [alpha.1 Connection RPC](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/client/connection/src/rpc.ts)
- [alpha.1 Gateway stream protocol](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/api/gateway/src/stream-protocol.ts)
- [alpha.2 release tag](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.2-alpha.2)
- [alpha.2 commit](https://github.com/deepseek-ai/deepseek-harness/commit/0a53fb55bea101816fa226bb964ae2bed71c343b)
- [alpha.2 npm package](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.1.2-alpha.2)
- [alpha.2 Gateway error vocabulary](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/api/gateway/src/remote-error-codes.ts)
- [alpha.2 plugin inventory projection](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/host/plugin-inventory/src/types.ts)
- [alpha.3 release tag](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.2-alpha.3)
- [alpha.3 commit](https://github.com/deepseek-ai/deepseek-harness/commit/dd6322d604e00eec1ba5e0c8541159906a21094a)
- [alpha.3 Connection package](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/client/connection/src/client/connection.ts)
- [alpha.3 Gateway heartbeat](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/api/gateway/src/stream-server.ts)
- [alpha.3 Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/api/session-controller/src/commands.ts)
- [alpha.4 release tag](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.2-alpha.4)
- [alpha.4 commit](https://github.com/deepseek-ai/deepseek-harness/commit/4e84901e6471b79ec0338099867ebb4606d12bb5)
- [alpha.4 Session history wire projection](https://github.com/deepseek-ai/deepseek-harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/api/session-controller/src/history.ts)
- [alpha.4 Session wire types](https://github.com/deepseek-ai/deepseek-harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/api/session-controller/src/types.ts)
- [alpha.5 release tag](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.2-alpha.5)
- [alpha.5 commit](https://github.com/deepseek-ai/deepseek-harness/commit/db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5)
- [alpha.5 Connection RPC](https://github.com/deepseek-ai/deepseek-harness/blob/db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5/packages/client/connection/src/client/rpc.ts)
- [alpha.5 Gateway stream protocol](https://github.com/deepseek-ai/deepseek-harness/blob/db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5/packages/api/gateway/src/stream-protocol.ts)
- [current master (unreleased)](https://github.com/deepseek-ai/deepseek-harness/commit/c389f96bf3a9b6807cb71ed6bdad5849be0df6d8)
- [published rc.1 release tag](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.2-rc.1)
- [published rc.1 commit](https://github.com/deepseek-ai/deepseek-harness/commit/a66e4702047846cdaa10c66c9d3df3951f5ea70d)
- [latest alpha.1 release tag](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.3-alpha.1)
- [latest alpha.1 Session wire types](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/api/session-controller/src/types.ts)
- [latest alpha.2 release tag](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.3-alpha.2)
- [latest alpha.2 subagent control types](https://github.com/deepseek-ai/deepseek-harness/blob/82a5fd61a7cf5c293cec4bdff68f455398d685e9/packages/subagent/subagent/src/control-types.ts)
- [latest alpha.2 subagent control validation](https://github.com/deepseek-ai/deepseek-harness/blob/82a5fd61a7cf5c293cec4bdff68f455398d685e9/packages/subagent/subagent/src/control.ts)
- [latest alpha.2 Session subagent delivery](https://github.com/deepseek-ai/deepseek-harness/blob/82a5fd61a7cf5c293cec4bdff68f455398d685e9/packages/api/session-controller/src/client/sessions/session.ts)

## rc.6 固定契约核对记录

Slice 0 重新核对了 DSH rc.6 固定提交 [`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)：

- `packages/host/apiproxy/src/api/rpc-map.ts` 注册 52 个客户端请求方法；`packages/dsh-adapter/test/fixtures/rc6-contract-snapshot.ts` 脱敏固定了来源 commit、方法名和事件族，`packages/dsh-adapter/test/rc6-contract.spec.ts` 同时用该 snapshot 做来源/集合断言，并以 npm 类型派生的 `RpcMethodMap` 做编译期兼容检查。npm 类型包不是固定 commit 的替代证据。
- `packages/host/apiproxy/src/api/events.ts` 将 mux 与 host 作为两个逻辑流，session 事件携带 `sessionId`/序号，订阅帧携带 `lastSeq`，审批/问题响应使用 `rpcId`，工具调用/结果使用结构化事件视图；扩展继续通过 Adapter 映射，不解析 TUI/ANSI 或模型文本状态。
- 工具能力由 `packages/core/tools`、`packages/*/tool-*` 等包注册，并由生成的 `docs/tool-catalog.md` 汇总；扩展不硬编码第三方工具清单，只消费已知结构化投影或显式降级。

本次核对只记录脱敏的名称、序号和结构边界，不把上游路径、Prompt、Secret、原始响应或运行时凭据写入 fixture/协议；Slice 0 的新 feature schema 也与 legacy `boundedUnknown` 事件 envelope 分离，避免未实现路由被提前接受。

当前批次新增路由只在 Extension Host 装配后接受。checkpoint 路由是 Extension Host 本地能力：默认关闭；用户显式开启 `dsh.checkpoints.enabled` 后只列出/创建 metadata-only 记录，内容保存与 restore 还必须单独开启 `dsh.checkpoints.storeContent`。prompt template 路由同样是 Host 本地能力，不新增 DSH RPC：正文存放在 extension global storage 或受信工作区的固定 `.dsh-vscode/prompts` 根目录，使用 checksum manifest 和 atomic rename；Webview 只接收严格摘要/预览/插入 DTO，变量必须在白名单内且缺失变量要由用户明确处理。`Plan` 工作流模式仅在动态命令目录声明 `/plan` 时可用，其他语义模式不改变 DSH 权限或工具配置。

## 托管 Web Profile 启动契约

托管进程的 CLI 参数不是协议 Adapter 可以跨版本猜测的公共字段，必须由版本化启动契约生成。当前已核实的 Web Profile 参数如下：

| DSH 版本                                                                                                                                                                      | 托管参数                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `0.1.0-rc.6`、`0.1.0-rc.7`                                                                                                                                                    | `--profile web --host 127.0.0.1 --port <n>` |
| `0.1.0-rc.8`、`0.1.1-rc.1`、`0.1.1-rc.2`、`0.1.2-rc.1`、`0.1.2-alpha.1`、`0.1.2-alpha.2`、`0.1.2-alpha.3`、`0.1.2-alpha.4`、`0.1.2-alpha.5`、`0.1.3-alpha.1`、`0.1.3-alpha.2` | 上述参数加 `--no-open`                      |
| 未知版本                                                                                                                                                                      | 只使用公共参数，不猜测可选 flag             |

rc.6/rc.7 的 Web Profile 未注册 `--no-open`；把该参数传给它会在 readiness endpoint 输出前以 CLI 参数解析错误退出。启动参数由 `packages/dsh-adapter/src/launch-contract.ts` 集中生成；新增版本必须先核对该版本的 Web Profile 源码/帮助文本并补充对应契约测试，不能在 `ProcessSupervisor` 中添加全局 flag。

## 支持范围

| DSH 版本             | 适配方式                                | 兼容说明                                                                                                                                                                                                                                                                                                   |
| -------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.1.0-rc.6`         | `versions/rc6`                          | 固定基线；允许旧 Host 在 `host.describe` 中不返回 `home`。                                                                                                                                                                                                                                                 |
| `0.1.0-rc.7`         | `versions/rc7`                          | 复用 rc.6 wire mapper，保留明确的版本身份。                                                                                                                                                                                                                                                                |
| `0.1.0-rc.8`         | `versions/rc8`                          | 支持 `home`、`imageLimits.maxImageDimension`、中断回复和 Agent Teams 事件。                                                                                                                                                                                                                                |
| `0.1.1-rc.1`         | `versions/rc11`                         | 复用 rc.8 wire/event mapper；按官方 WebUI 条件启用 `session.create` 空白会话复用。                                                                                                                                                                                                                         |
| `0.1.1-rc.2`         | `versions/rc12`                         | 复用 rc.8 wire/event mapper；按官方 WebUI 先在客户端打开匹配的空白会话，否则使用 `session.create.sessionId` 幂等语义，不发送 rc.1 专用的 `reuseWorkspaceBlank`。                                                                                                                                           |
| `0.1.2-rc.1`         | `versions/rc13`                         | 已发布 tag `dsh-v0.1.2-rc.1`/提交 `a66e4702`；与 alpha.5 相同的 `/api` Connection、Cookie、`remote.mux` 和 packed Session history wire，保持独立精确身份，不使用后续 `0.1.3-alpha.1` 的 Session v2。                                                                                                       |
| `0.1.2-alpha.1`      | `versions/alpha`                        | 基于源码 tag `dsh-v0.1.2-alpha.1`/提交 `cd5ef814` 的 `/api` Connection、Cookie 握手和 `remote.mux` 预适配；未发布、未作为安装默认，等待运行包 smoke。                                                                                                                                                      |
| `0.1.2-alpha.2`      | `versions/alpha2`                       | 基于已发布 tag `dsh-v0.1.2-alpha.2`/提交 `0a53fb55`；复用 alpha 传输，补充命名空间错误、可忽略事件和 agent-preset 插件组合；未作为安装默认，等待 live smoke。                                                                                                                                              |
| `0.1.2-alpha.3`      | `versions/alpha3`                       | 基于已发布 tag `dsh-v0.1.2-alpha.3`/提交 `dd6322d6`；上游调整 Gateway 心跳容错、Connection readiness 与 Session Controller 内部准入/展示，但保持扩展消费的 wire contract；复用 alpha.2 错误映射，未作为安装默认。                                                                                          |
| `0.1.2-alpha.4`      | `versions/alpha4`                       | 基于已发布 tag `dsh-v0.1.2-alpha.4`/提交 `4e84901e`；Session 序列/offset 品牌、继承事件元数据和 Subagent 投递内部发生重构，但 `wireHeader` 继续投影为 `seedLength`，Remote/Gateway/Connection 方法、错误词汇和 Web Profile flag 保持兼容；沿 alpha 链精确适配，未作为安装默认。                            |
| `0.1.2-alpha.5`      | `versions/alpha5`                       | 基于已发布 tag `dsh-v0.1.2-alpha.5`/提交 `db6bdc35` 与当前 master `49a606bc`；alpha.4→alpha.5 未改变 Connection/Gateway/Session wire、Remote 错误或 CLI flag，当前 master 的持久化/冷列表变化也不改变这些边界；沿 alpha.4 线复用传输与错误映射但保留独立身份，未作为安装默认。                             |
| `0.1.3-alpha.1`      | `versions/alpha13`                      | 最新源码 tag `dsh-v0.1.3-alpha.1`/提交 `d347e703`；Session v2 要求 `isSeeded`、event-only history 和 `assistantStream: true`，并以 `start/chunk/end` 修订帧与压缩 baseline 传递进程内 assistant stream；其他 Connection/Gateway 路由沿用 alpha family。                                                    |
| `0.1.3-alpha.2`      | `versions/alpha132`                     | 已发布 tag `dsh-v0.1.3-alpha.2`/提交 `82a5fd61`；保留 alpha.1 的 Session v2、Connection/Gateway 与 `--no-open`，并按上游严格控制契约向 `subagent.prompt` 增加必填 `delivery: queue/steer`；只精确匹配，不向未知运行时发送该字段。                                                                          |
| 任意非空未知版本标签 | 最新可安全复用 wire 的 Adapter 兼容探测 | 按显式优先级从最新安全回退实现向旧实现逐一进行只读契约探测；`0.1.3-alpha.1/.2` 的 Session v2（以及 alpha.2 的 `delivery`）不能由 `session/list` 协商，因此未知运行时不选择 `alpha13`/`alpha132`，避免发送未经验证字段；成功后保留真实运行时版本、所选 Adapter 身份并显示警告，失败的候选不会阻断后续候选。 |

rc.6 与 rc.7 的 `rpc-map`/事件外壳仍可由 rc.6 mapper 处理。rc.8/rc.1/rc.2 的生成 Host schema 将 `host.describe.home` 设为必填，因此握手请求在 Extension Host 内按通用 RPC envelope 读取，再由版本 Adapter 检查字段，避免新 schema 把旧 Host 拒绝。rc.1 的 `session.create({ workspaceId, sessionId, reuseWorkspaceBlank: true })` 只有在空白、同一工作区成员、cwd 精确相等且未归档时才发送；rc.2 按官方 WebUI 行为在满足同样条件时先由 Webview 打开已有空白会话，只有没有可复用会话时才创建；其官方 schema 已删除 `reuseWorkspaceBlank`，因此 rc.2 Adapter 不发送该字段。rc.2 仍保留通用 `sessionId` 预分配/幂等创建语义，并将图片输入上限提升为单图 20 MiB、单条消息 200 MiB；插件只在 rc.2 的 Webview/Host/Adapter 链路放宽输入边界，图片规范化和 Files API 仍由 DSH 内部完成。rc.6–rc.8 和未知版本继续使用 8 MiB/100 MiB 的保守边界。结构化 `turn/end` 失败只保留脱敏、限长的 code/message，畸形失败回退为通用终止原因。

## 0.1.2-alpha.1 源码预适配契约（历史）

该源码版本移除了旧的 `host-apiproxy` 包，改由 `client-connection` 与 Gateway 提供统一 `/api` 入口。当前 `versions/alpha` 适配已按源码 tag 冻结以下边界：

- Unary Remote 使用 `POST /api/<namespace>/<method>`，发送 `client-request`/`{ args }`，接收带同一 `rpcId` 的 `server-response`；错误统一经过现有 `AppError` 映射。
- 长连接使用 `/api/remote.mux`，以 `open`/`cancel` 多路复用 `$events`、`session/follow`、`session/control` 和 `workspace/follow`；`item`、`error`、`end` 帧严格校验 stream ID。
- `/?token=<launch-token>` 只由 Extension Host 用于换取 Cookie；Cookie 仅留在 Host 的 HTTP/WebSocket transport，token、Cookie 和 endpoint 不进入 Webview。
- 新的 Session chunk rows、Goal ref、Model catalog、Preset roster、Workspace projection 和事件 waterfall 在 Adapter 内投影为现有 Domain/Application 接口；不把上游类或动态 Provider/Tool 清单泄漏到稳定层。

契约 fixture 位于 `packages/dsh-adapter/test/alpha-contract.spec.ts`。由于 alpha.1 尚未发布 npm/运行包，真实 alpha.1 DSH smoke 尚未完成，因此该版本保持 `PARTIAL`，不能标为 `DONE`。

## 0.1.2-alpha.2 已发布契约增量

上游已发布 npm `@deepseek-ai/dsh@0.1.2-alpha.2`，对应 tag
`dsh-v0.1.2-alpha.2`/提交 `0a53fb55bea101816fa226bb964ae2bed71c343b`。该版本保持 alpha.1 的
`/api` Connection、Cookie 握手、`/api/remote.mux`、Remote envelope 和 `--no-open` 启动边界；本地
新增 `versions/alpha2` 独立入口，不改写 alpha.1 或已发布 rc 适配器。

- Remote 错误统一进入 namespaced vocabulary，例如 `session/agent-busy`、`session/not-found` 和
  `gateway/lookup-not-found`；版本边界只把已声明 code 映射为现有本地错误，未声明 code 保留原值并
  fail closed。
- Session wire event 增加可选的 `ignorable: true` 标记；带该标记的未知事件可以作为安全 generic event
  保留，其他畸形标记仍按协议错误拒绝。
- `pluginInventory/list` 可选返回 `agentPresets`，其中包含 preset 信任级别、默认标记、损坏原因和按
  composition 顺序排列的 plugin rows；`enabled: 'conditional'`、`entryId: null` 和 Fiber phase 均保留为
  严格 Domain DTO。

契约 fixture 位于 `packages/dsh-adapter/test/alpha2-contract.spec.ts`。npm/tag/commit 已核验，自动测试
覆盖版本选择、命名空间错误、未知错误 fail-closed、可忽略事件、畸形标记、mux 错误和插件组合；隔离
真实包 smoke 已验证 loopback 版本、token-to-Cookie 登录、`session/list` 合法 envelope、
`pluginInventory/list` 的 149 个 entries/4 个 agent-preset 组合，以及 `remote.mux` `$events` ready/cancel。
真实 Session/Workspace follow 和 VS Code Webview 回放仍未完成，因此 alpha.2 保持 `PARTIAL`。

## 0.1.2-alpha.3 已发布契约增量

上游已发布 npm `@deepseek-ai/dsh@0.1.2-alpha.3`，对应 tag
`dsh-v0.1.2-alpha.3`/提交 `dd6322d604e00eec1ba5e0c8541159906a21094a`。逐文件对照 alpha.2
与 alpha.3 后，确认变化分为三类，但都没有改变扩展实际消费的 RPC、事件帧或 Remote 错误词汇：

- `packages/api/gateway/src/stream-server.ts` 将未收到 Pong 的容错提高为连续两次心跳，并在最终
  检查前用异步检查避免延迟到达的 Pong 被误断开；这是服务端 carrier 生命周期变化，标准 Node
  `ws`/浏览器 WebSocket 客户端仍自动回应 Ping，`AlphaRemoteMux` 不需要伪造应用层心跳。
- `packages/client/connection/src/client/connection.ts` 将 readiness 超时改为告警并继续等待，
  由 source settlement 或显式取消负责终止 generation；这是 DSH Web UI 自身的连接状态机，
  不等同于扩展负责的 CLI stdout endpoint 解析。扩展的受管进程启动超时仍保持独立的进程所有权边界。
- `packages/api/session-controller` 新增历史跳转/提交位置投影，并将图片准入复用共享 attachment
  API；这些是 DSH Web UI 的客户端/Host 内部状态与准入实现，alpha.3 的 `session.prompt` 仍接受
  同一 mixed prompt content，扩展继续把内容留在 Extension Host 的 alpha transport 中发送。

本地新增独立 `versions/alpha3` 身份入口，复用 alpha.2 的 `/api`、Cookie、`remote.mux` 和错误
归一化，不改变 alpha.2 或已发布 rc 适配器，也不把预发行版设为安装默认。Web Profile 仍声明
`--no-open`，因此启动契约也单独纳入 alpha.3。

契约 fixture 位于 `packages/dsh-adapter/test/alpha3-contract.spec.ts`，覆盖精确版本选择、
协议身份、namespaced error 映射和 mixed prompt content；共享 alpha.2 契约测试继续覆盖畸形响应、
超时、取消、事件和资源释放。真实 alpha.3 已完成 Web Profile endpoint、token-to-Cookie 登录和
`session/list` 合法 envelope smoke；Session/Workspace follow、长回答断线恢复与 VS Code Webview
回放尚未完成，因此保持 `PARTIAL`。

## 0.1.2-alpha.4 已发布契约增量

上游已发布 npm `@deepseek-ai/dsh@0.1.2-alpha.4`，对应 tag
`dsh-v0.1.2-alpha.4`/提交 `4e84901e6471b79ec0338099867ebb4606d12bb5`。逐文件对照
alpha.3 与 alpha.4 后，适配边界分为“内部类型变化”和“保持不变的浏览器 wire”两部分：

- `packages/api/session-controller` 将内部 session sequence/log offset 改为 branded 类型，增加
  inherited-event 计数，并在历史页投影中把内部 `isSeeded`/继承计数翻译为公开的 `seedLength`；
  `SessionWireHeader`、数值 `seq`/cursor、`session.list`、`session.prompt` 和 `session.fork` 的
  Extension 消费形状保持兼容。
- Subagent 的内部 follow-up/report attribution 重构为 send-message 语义，但 Web Remote 仍是
  `subagents/list`、`subagents/prompt`、`subagents/interruptByParent`；Gateway/Connection
  framing、namespaced Remote 错误和 Web Profile `--no-open` 也未发生改变。
- 因此 `versions/alpha4` 保留独立的 `alpha4`/`0.1.2-alpha.4` 身份，沿 alpha.3 的已验证
  transport/mapper 精确适配；共享实现不等于把 alpha.4 当作未知回退，也不改变稳定 rc.2 安装默认。

契约 fixture 位于 `packages/dsh-adapter/test/alpha4-contract.spec.ts`，并由
`adapter-chain.spec.ts` 锁定 alpha.1 → alpha.2 → alpha.3 → alpha.4 → alpha.5 的线性继承关系。
真实 alpha.4 Web Profile/remote.mux/Session/Workspace follow smoke 尚未完成，因此能力矩阵仍为
`PARTIAL`。

## 0.1.2-alpha.5 上游适配契约

上游当前 `master` 为 `49a606bc5b5934603f22a26957a07dc799ab0291`，其发布 tag
`dsh-v0.1.2-alpha.5` 位于 `db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5`。逐目录对照
alpha.4、alpha.5 tag 和当前 `master` 后，适配边界如下：

- alpha.4 → alpha.5 的 `packages/api/gateway`、`packages/api/remotes`、
  `packages/api/session-controller`、`packages/client/connection` 与 `apps/cli/src` 没有源码差异，
  只有版本/文档及存储投影缓存兼容变更；alpha.5 仍使用 `POST /api/<namespace>/<method>`、
  `client-request`/`server-response`、`/api/remote.mux` 的 `open`/`cancel`/`item`/`error`/`end`，
  以及 `--no-open` Web Profile flag。
- 当前 `master` 相对 alpha.5 tag 的 API 消费路径只新增 Session 冷列表的事件数/字节数统计门槛，
  同时调整持久化 handle；`SessionListValue`、`session.prompt` mixed content、Gateway stream
  frame、Remote 错误词汇和动态工具目录边界没有变化。
- `packages/dsh-adapter/src/versions/alpha5/adapter.ts` 因此独立声明 `alpha5`/`0.1.2-alpha.5`，
  沿 alpha.4 线性继承已验证的 transport、Cookie 握手、错误归一化、Session/Workspace follow 和
  资源关闭实现；复用实现不等于复用版本身份。未知未来版本（例如 alpha.6）才进入 alpha.5 的
  只读 `probeCompatibility`，连接后保留真实标签、`best-effort` 模式和兼容警告。

契约 fixture 位于 `packages/dsh-adapter/test/alpha5-contract.spec.ts`，覆盖精确选择、未知 alpha.6
回退、namespaced error、mixed prompt content、畸形 `session.list`、取消和探测资源释放；启动参数和
alpha PTC 工具模式也有回归覆盖。alpha.5 尚未执行真实 Web Profile/remote.mux/Session/Workspace
follow smoke，因此 CN-06 继续保持 `PARTIAL`，不能将自动契约测试视为完整 live 兼容。

## 0.1.2-rc.1、0.1.3-alpha.1 与 0.1.3-alpha.2 最新边界

已发布 npm `@deepseek-ai/dsh@0.1.2-rc.1` 对应源码 tag
`dsh-v0.1.2-rc.1`/提交 `a66e4702047846cdaa10c66c9d3df3951f5ea70d`。逐目录对照
alpha.5 与 rc.1 后，确认扩展实际消费的 `/api` Connection、Cookie 握手、`remote.mux`、
Session packed history 和 `--no-open` 启动边界未改变；本地新增 `versions/rc13` 作为独立精确
身份，并显式复用 alpha.5 的 v0 Session transport。这样 npm 安装默认不会把 rc.1 错误地送入
后续 Session v2。

上游 `dsh-v0.1.3-alpha.1`/提交 `d347e703908d0406b7a7ef80e3a0e594d86b2215` 首次引入
Session v2：`SessionWireHeader` 用必填 `isSeeded` 替换 `seedLength`，历史记录只保留
`{ type: 'event', event }`，follow 请求可选 `assistantStream: true`，并新增带 `revision` 的
`start/chunk/end` assistant stream 与压缩 reconnect baseline。`versions/alpha13` 只在精确匹配
该版本时启用 v2；旧 alpha/rc 适配器仍保留 v0 行为。

最新已发布 `dsh-v0.1.3-alpha.2`/提交 `82a5fd61a7cf5c293cec4bdff68f455398d685e9` 保持上述
Session v2、Connection/Gateway 与 Web Profile `--no-open` 边界，但把 `subagent.prompt` 的
`delivery` 加为严格必填字段，取值为 `queue` 或 `steer`；Session Controller 将客户端模式原样
传入该字段。`versions/alpha132` 继承 alpha13 的 v2 流处理，只在精确 alpha.2 连接上启用该字段，
旧 alpha/rc 适配器不会发送未知字段。`alpha132-contract.spec.ts`、`alpha13-contract.spec.ts`
和 `subagent-repository.spec.ts` 覆盖精确选择、未知版本拒绝、queue/steer 透传、旧线路字段隔离、
请求组装和畸形响应边界；真实 `0.1.3-alpha.2` Web Profile/remote.mux/Session v2/长回答断线恢复/
VS Code Webview 回放与 subagent smoke 尚未执行，因此能力矩阵保持 `PARTIAL`。

当前上游 `master` 已继续前进到 `c389f96bf3a9b6807cb71ed6bdad5849be0df6d8`，包含未发布的
workspace-files、桌面端和客户端资源变化。本仓库本轮冻结并适配最新正式 tag `dsh-v0.1.3-alpha.2`，
不把 tag 之后的 master 变更冒充为已验证协议。

alpha13 的 assistant stream 帧是进程内瞬态传输。当前稳定 Domain 只投影 `text-delta` 和
`reasoning-delta`；`block-start`、`block-end`、`tool-call-delta`、`usage`、`finish` 不伪造成 durable
事件，也不会静默改变 durable 序号。工具调用的最终参数和结果仍通过 durable tool 事件呈现；因此
alpha13 的工具参数增量和瞬态 usage/finish UI 明确属于未支持降级，后续若要展示必须新增 Domain
瞬态 DTO 与对应版本 fixture。

Session v2 的 header/event 已采用“已知字段严格校验、未知新增顶层字段忽略”的兼容策略；已知字段类型、
必填项、序号和 replacement 结构仍 fail-closed。snapshot/frame 外壳和 assistant stream frame 本身
继续严格校验，防止将未知消息形状误当成可恢复状态。

Session v2 的生命周期边界也在 Host 侧固定：`session.open` 先读取权威 durable history，再对已有的
per-session follow 流重新建立 baseline；因此 baseline 不会早于本次打开返回的 durable cut。Host 发现
瞬态序号缺口时丢弃缺口后的帧并重启该逻辑流，不能从 history 恢复的瞬态内容不会被伪造成 durable 事件。
workspace 归档集合变化会释放对应的 follow controller；单个 session 流断开只向该 session 发一次安全的
reconnecting notice，不会把仍健康的 host-wide 连接误报为全局断线。Webview 对迟到 durable 事件或缺口
回填触发的 ledger 重建会保留仍在 streaming 的 transient 节点；follow baseline 的本地序号重新从 1
开始时，同一 attempt 的首帧会替换旧的 partial projection，而不是被重复帧门丢弃。上游 abandoned
attempt 会投影为不进入 ledger 的 Host-only `message.completed(interrupted)`，让已交付前缀明确结束并
标记为中断。

## 主通道决策

主通道是 `dsh --profile web` 的 Web Host API 与 Host/Mux 事件，不是 ACP，也不是从 CLI stdout 解析状态。ACP/SDK 在会话恢复/列表/分叉、图片、推理、工具活动、计划、标题、设置和完整 UI 交互方面并不等价，不能满足本项目能力矩阵。

rc.6 的 `host.describe.version` 是 Host 应用版本，不是独立的协议版本；实际运行中它可以与 CLI npm 版本不同。因此 Probe 以固定 Host API 成功和非空 Host 版本建立兼容性。对已知版本，按精确版本选择 Adapter；对任意非空未知版本（例如 `0.1.2-alpha.6` 或未来版本），不根据后缀推断“alpha 家族”或继承关系，而是按显式优先级从最新可安全复用的 v0 alpha.5 Adapter 开始调用其只读 `probeCompatibility`，成功后使用该 Adapter 的实际 mapper，并把真实版本、Adapter 身份和兼容性警告传到 Webview。`0.1.3-alpha.1/.2` 的 Session v2 只在精确版本匹配时启用：其 `session/list` 探测无法协商 Session wire，因此 alpha13/alpha132 不接受未知版本兼容探测，避免向未知运行时发送 `assistantStream`、`isSeeded` 或 alpha.2 专属 `delivery`。某个候选拒绝或契约不匹配时继续尝试下一个候选；所有候选都失败才拒绝连接。兼容模式不发送未验证的版本专有字段，运行中的未知 RPC/Remote/事件错误继续按既有脱敏错误和 `CAPABILITY_UNAVAILABLE` 边界处理。未来若出现独立协议协商，必须新增版本 Adapter。

## 实现契约的固定流程

每个 Repository 方法必须按以下步骤实现：

1. 在固定 `rpc-map.ts` 找到唯一真实方法名和输入/输出类型。
2. 在对应的 `versions/<version>` 定义版本入口、wire schema/mapper；不要把上游类型 re-export 到 Domain。
3. 录制或手工构造脱敏成功、业务错误、协议错误和畸形响应 fixture。
4. 在 Loopback client 加入 timeout/AbortSignal；只对明确幂等的瞬时故障重试。
5. 映射为稳定 `AppErrorCode`；未知错误保留 cause 供脱敏诊断，但不发原 body 到 Webview。
6. 如果固定源码和 npm 包不一致，以实际 pinned npm package + 官方同版本 tag/commit 为准并记录差异；不要猜。

## 必须审计的能力域

- Workspace 与目录；
- Session CRUD、历史、分页、搜索、分叉、归档；
- Prompt、Queue、Steer、Cancel、附件；
- Provider、Model、Reasoning、Preset、Tools、Permission、Plan、Agent Teams；
- Image attachment admission、尺寸/像素限制与模型图像能力错误；
- Settings Schema/read/update/replace 与 Secret；
- Permission/User Question；
- Host/Mux message/reasoning/tool/error/status/statistics/title events；
- Goal/Todo、Job、Subagent、Workflow/Ralph；
- Skill、动态命令、Plugin Inventory；
- Session/attachment export。

契约测试必须维护“实现使用的 RPC/Event 集合”和上游集合对比。上游新增项允许以 unknown/generic 降级，但测试要明确显示；上游删除或改形状必须失败。

## 事件恢复

每个 Session 保存最后提交的服务器序号。重连时：重新订阅 -> 比较服务端最后序号 -> 通过历史 RPC 补齐缺口 -> 去重后提交 reducer。事件不能仅靠时间戳排序；未知事件也要保留安全的类型/序号/摘要，避免后续已知事件丢失。

## 版本升级

1. 新增 `versions/<new-version>` Adapter 和契约 fixture；可复用未改变的 mapper，但必须保留版本入口。
2. 在 Probe 中按真实协议协商或受控运行时提示选择 Adapter；不要把 Host 应用版本误当成协议版本。
3. Domain/Protocol 只有真实产品语义改变时才更新；未知字段必须走安全 generic/unknown 降级。
4. 每次升级都保留旧版本回归，并至少完成当前版本的握手、事件和真实 DSH smoke；未知版本必须验证“最新可安全复用 wire 的 Adapter 优先、候选失败继续尝试、真实版本保留、只显示警告且不阻断打开插件”。
