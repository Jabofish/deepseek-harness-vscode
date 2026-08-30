# DSH 上游契约基线与兼容策略

## 当前上游版本

| 项目           | 固定值                                      |
| -------------- | ------------------------------------------- |
| npm CLI        | `@deepseek-ai/dsh@0.1.1-rc.2`               |
| API package    | `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2` |
| 源码提交       | `b150a551b8`                                |
| Node 最低版本  | `22.19.0`                                   |
| 未发布源码 tag | `dsh-v0.1.2-alpha.1`                        |
| 未发布源码提交 | `cd5ef8148158c3a752a658978873241fdf8e2bbc`  |

权威入口：

- [官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [rc.2 RPC Map](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8/packages/host/apiproxy/src/api/rpc-map.ts)
- [rc.2 Event Contract](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8/packages/host/apiproxy/src/api/events.ts)
- [rc.2 Tool Catalog](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8/docs/tool-catalog.md)
- [rc.2 CLI/Profile Reference](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8/apps/cli/reference/README.md)
- [alpha.1 source tag](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.2-alpha.1)
- [alpha.1 Connection RPC](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/client/connection/src/rpc.ts)
- [alpha.1 Gateway stream protocol](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/api/gateway/src/stream-protocol.ts)

## rc.6 固定契约核对记录

Slice 0 重新核对了 DSH rc.6 固定提交 [`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)：

- `packages/host/apiproxy/src/api/rpc-map.ts` 注册 52 个客户端请求方法；`packages/dsh-adapter/test/fixtures/rc6-contract-snapshot.ts` 脱敏固定了来源 commit、方法名和事件族，`packages/dsh-adapter/test/rc6-contract.spec.ts` 同时用该 snapshot 做来源/集合断言，并以 npm 类型派生的 `RpcMethodMap` 做编译期兼容检查。npm 类型包不是固定 commit 的替代证据。
- `packages/host/apiproxy/src/api/events.ts` 将 mux 与 host 作为两个逻辑流，session 事件携带 `sessionId`/序号，订阅帧携带 `lastSeq`，审批/问题响应使用 `rpcId`，工具调用/结果使用结构化事件视图；扩展继续通过 Adapter 映射，不解析 TUI/ANSI 或模型文本状态。
- 工具能力由 `packages/core/tools`、`packages/*/tool-*` 等包注册，并由生成的 `docs/tool-catalog.md` 汇总；扩展不硬编码第三方工具清单，只消费已知结构化投影或显式降级。

本次核对只记录脱敏的名称、序号和结构边界，不把上游路径、Prompt、Secret、原始响应或运行时凭据写入 fixture/协议；Slice 0 的新 feature schema 也与 legacy `boundedUnknown` 事件 envelope 分离，避免未实现路由被提前接受。

当前批次新增路由只在 Extension Host 装配后接受。checkpoint 路由是 Extension Host 本地能力：默认关闭；用户显式开启 `dsh.checkpoints.enabled` 后只列出/创建 metadata-only 记录，内容保存与 restore 还必须单独开启 `dsh.checkpoints.storeContent`。prompt template 路由同样是 Host 本地能力，不新增 DSH RPC：正文存放在 extension global storage 或受信工作区的固定 `.dsh-vscode/prompts` 根目录，使用 checksum manifest 和 atomic rename；Webview 只接收严格摘要/预览/插入 DTO，变量必须在白名单内且缺失变量要由用户明确处理。`Plan` 工作流模式仅在动态命令目录声明 `/plan` 时可用，其他语义模式不改变 DSH 权限或工具配置。

## 托管 Web Profile 启动契约

托管进程的 CLI 参数不是协议 Adapter 可以跨版本猜测的公共字段，必须由版本化启动契约生成。当前已核实的 Web Profile 参数如下：

| DSH 版本                                                  | 托管参数                                    |
| --------------------------------------------------------- | ------------------------------------------- |
| `0.1.0-rc.6`、`0.1.0-rc.7`                                | `--profile web --host 127.0.0.1 --port <n>` |
| `0.1.0-rc.8`、`0.1.1-rc.1`、`0.1.1-rc.2`、`0.1.2-alpha.1` | 上述参数加 `--no-open`                      |
| 未知版本                                                  | 只使用公共参数，不猜测可选 flag             |

rc.6/rc.7 的 Web Profile 未注册 `--no-open`；把该参数传给它会在 readiness endpoint 输出前以 CLI 参数解析错误退出。启动参数由 `packages/dsh-adapter/src/launch-contract.ts` 集中生成；新增版本必须先核对该版本的 Web Profile 源码/帮助文本并补充对应契约测试，不能在 `ProcessSupervisor` 中添加全局 flag。

## 支持范围

| DSH 版本             | 适配方式         | 兼容说明                                                                                                                                                         |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.1.0-rc.6`         | `versions/rc6`   | 固定基线；允许旧 Host 在 `host.describe` 中不返回 `home`。                                                                                                       |
| `0.1.0-rc.7`         | `versions/rc7`   | 复用 rc.6 wire mapper，保留明确的版本身份。                                                                                                                      |
| `0.1.0-rc.8`         | `versions/rc8`   | 支持 `home`、`imageLimits.maxImageDimension`、中断回复和 Agent Teams 事件。                                                                                      |
| `0.1.1-rc.1`         | `versions/rc11`  | 复用 rc.8 wire/event mapper；按官方 WebUI 条件启用 `session.create` 空白会话复用。                                                                               |
| `0.1.1-rc.2`         | `versions/rc12`  | 复用 rc.8 wire/event mapper；按官方 WebUI 先在客户端打开匹配的空白会话，否则使用 `session.create.sessionId` 幂等语义，不发送 rc.1 专用的 `reuseWorkspaceBlank`。 |
| `0.1.2-alpha.1`      | `versions/alpha` | 基于源码 tag `dsh-v0.1.2-alpha.1`/提交 `cd5ef814` 的 `/api` Connection、Cookie 握手和 `remote.mux` 预适配；未发布、未作为安装默认，等待运行包 smoke。            |
| 任意非空未知版本标签 | rc.6 fallback    | 先完成通用握手，再以基础功能兼容模式连接并显示警告；版本特有字段只在安全识别后使用。                                                                             |

rc.6 与 rc.7 的 `rpc-map`/事件外壳仍可由 rc.6 mapper 处理。rc.8/rc.1/rc.2 的生成 Host schema 将 `host.describe.home` 设为必填，因此握手请求在 Extension Host 内按通用 RPC envelope 读取，再由版本 Adapter 检查字段，避免新 schema 把旧 Host 拒绝。rc.1 的 `session.create({ workspaceId, sessionId, reuseWorkspaceBlank: true })` 只有在空白、同一工作区成员、cwd 精确相等且未归档时才发送；rc.2 按官方 WebUI 行为在满足同样条件时先由 Webview 打开已有空白会话，只有没有可复用会话时才创建；其官方 schema 已删除 `reuseWorkspaceBlank`，因此 rc.2 Adapter 不发送该字段。rc.2 仍保留通用 `sessionId` 预分配/幂等创建语义，并将图片输入上限提升为单图 20 MiB、单条消息 200 MiB；插件只在 rc.2 的 Webview/Host/Adapter 链路放宽输入边界，图片规范化和 Files API 仍由 DSH 内部完成。rc.6–rc.8 和未知版本继续使用 8 MiB/100 MiB 的保守边界。结构化 `turn/end` 失败只保留脱敏、限长的 code/message，畸形失败回退为通用终止原因。

## 0.1.2-alpha.1 预适配契约

该源码版本移除了旧的 `host-apiproxy` 包，改由 `client-connection` 与 Gateway 提供统一 `/api` 入口。当前 `versions/alpha` 适配已按源码 tag 冻结以下边界：

- Unary Remote 使用 `POST /api/<namespace>/<method>`，发送 `client-request`/`{ args }`，接收带同一 `rpcId` 的 `server-response`；错误统一经过现有 `AppError` 映射。
- 长连接使用 `/api/remote.mux`，以 `open`/`cancel` 多路复用 `$events`、`session/follow`、`session/control` 和 `workspace/follow`；`item`、`error`、`end` 帧严格校验 stream ID。
- `/?token=<launch-token>` 只由 Extension Host 用于换取 Cookie；Cookie 仅留在 Host 的 HTTP/WebSocket transport，token、Cookie 和 endpoint 不进入 Webview。
- 新的 Session chunk rows、Goal ref、Model catalog、Preset roster、Workspace projection 和事件 waterfall 在 Adapter 内投影为现有 Domain/Application 接口；不把上游类或动态 Provider/Tool 清单泄漏到稳定层。

契约 fixture 位于 `packages/dsh-adapter/test/alpha-contract.spec.ts`。当前证据为源码对照、契约测试、`pnpm check` 和 `pnpm build`；由于 alpha 尚未发布 npm/运行包，真实 alpha DSH smoke 尚未完成，因此该版本保持 `PARTIAL`，不能标为 `DONE`。

## 主通道决策

主通道是 `dsh --profile web` 的 Web Host API 与 Host/Mux 事件，不是 ACP，也不是从 CLI stdout 解析状态。ACP/SDK 在会话恢复/列表/分叉、图片、推理、工具活动、计划、标题、设置和完整 UI 交互方面并不等价，不能满足本项目能力矩阵。

rc.6 的 `host.describe.version` 是 Host 应用版本，不是独立的协议版本；实际运行中它可以与 CLI npm 版本不同。因此 Probe 以固定 Host API 成功和非空 Host 版本建立兼容性，优先选择带运行时版本提示的 rc.2/rc.1/rc.8/rc.7/rc.6 Adapter。未知运行时不在启动前被版本号拦截；握手成功后使用 rc.6 fallback，并把兼容性警告传到 Webview。未来若出现独立协议协商，必须新增版本 Adapter。

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
4. 每次升级都保留 rc.6 回归，并至少完成当前版本的握手、事件和真实 DSH smoke；未知版本必须验证只显示警告且不阻断打开插件。
