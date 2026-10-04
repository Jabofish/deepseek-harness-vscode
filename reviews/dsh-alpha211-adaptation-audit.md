# DSH alpha211 adaptation audit

审计日期：2026-10-04。目标矩阵：RT-03、CV-01、TL-01、SCH-01、PG-01、AC-01、ED-01、MOD-01、INS-01；继承能力同时核对 UQ-01、AG-01。

已补齐审计识别的客户端实现缺口：工具参数生成期预览、插件 Creator 快捷入口、可选 mods 提示带、会话 Inspector/Host DevTools、Markdown frontmatter 和统计明细。客户端实现遵循 VS Code 安全边界；真实模型、Chrome 原生打开与完整 VS Code 新界面验收仍有缺口，相关能力保持 `PARTIAL`。

## 固定来源和检查方法

- 前序：`dsh-v0.2.0-rc.2` / `639ed015397290b3745d163aafe02ffee4aa3f84`。
- 目标：[`dsh-v0.2.1-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc) / `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。
- 比较整个 tag 差异与提交主题，再对 238 个变动的 `src` TypeScript/TSX 文件做 AST 声明和 Remote 签名清单；全仓差异共 4,190 个文件，大部分包含删除的 invariant 伴随文件、测试、资源和构建配置。文件数与 AST 清单是检索辅助，不是兼容性证明。
- 实际检查扩展消费的 Session Controller、Connection/Gateway、Preset、Question、Schedule、Plugin Manager、Account、结构化事件和工具参数路径。已有 Remote 签名没有增删；仅可选 Claude Code mods 插件新增 `watchBand` 和 `pressBand`。返回类型和服务装配仍单独核对，不能仅凭签名不变认定兼容。
- UI 增量同时检查，并逐项补齐客户端入口；安全限制以内的等价行为与上游原始对象/桌面布局差异单独记录。

## 功能清单

| 上游变化                                                                                                                          | 扩展处理和边界                                                                                                                                                                                  | 自动证据 / 现场缺口                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 精确版本身份、探测、启动                                                                                                          | 独立 `Alpha211VersionAdapter`，只接纳目标精确身份；保留稳定安装默认                                                                                                                             | `alpha211-contract.spec.ts`、版本链与启动规格；目标 Windows 隔离 CLI 和 VS Code managed connect/reconnect 已通过；外部附加待验                                                                         |
| Schedule 服务进入 web profile，工具改为 Preset 提供；子代理 update 拒绝                                                           | 目录按能力发现；版本内接纳 `subagent_session`，delete 不错误套用 update 拒绝，旧 mapper 继续严格拒绝                                                                                            | `alpha211-incremental-contract.spec.ts`、`alpha211-feature-projection.spec.ts`、`live-dsh/alpha211-surfaces.spec.ts`；真实委派会话的拒绝、创建/历史及面板交互待验                                      |
| 账号登录 `no-response`                                                                                                            | 版本内将读/流失败归一为 Domain `network`，未知失败不吞掉                                                                                                                                        | 增量 Adapter 规格和目标空账号/watch live；真实 OAuth/超时往返待验                                                                                                                                      |
| 安装实际版本提示                                                                                                                  | 安装/同 ID 恢复保留实际 `version`，UI 显示实际安装值，不触发第二次安装                                                                                                                          | 增量 Adapter、严格协议、恢复和 OptionalBundleManager 规格；真实安装/取消/断线恢复待验                                                                                                                  |
| bundle `source` 与清单/图标修复                                                                                                   | 来源可能含绝对路径和私有 URL，按安全规则留在 Host；现有移除 eligibility 继续接受失效 selection                                                                                                  | 目标类型/源码、失效 selection fixture、严格协议拒绝 source；完整自定义插件页面现场待验                                                                                                                 |
| typed 参数生成期预览                                                                                                              | 新增独立 `tool.preparing`；有界增量 JSON 投影；说明脱敏、路径映射、字符计数；不成为执行、变更或 Schedule 完成事实                                                                               | `alpha211-tool-preparation.spec.ts`、Host `tool-preparation.spec.ts`、Store/Timeline integration、ToolCallCollection；真实模型流和 VS Code 现场尚未验证                                                |
| description/file_path 参数顺序提示                                                                                                | 是模型工具 schema/提示顺序，DSH 负责；预览不依赖参数出现顺序，也不猜测工具执行                                                                                                                  | 上游工具 schema 和分段/交错/嵌套参数 fixture；无需新增客户端 RPC                                                                                                                                       |
| Goal Stop 撤回排队的保留轮次                                                                                                      | 上游后端修复，`goals`/Inbox wire 不变；继续消费权威状态与队列                                                                                                                                   | 固定目标源码与既有 Goal/Queue 规格；真实 Stop 撤回回合现场待验                                                                                                                                         |
| Plugin Creator 快捷入口及结构化初始化草稿                                                                                         | 插件页按实时 roster 的健康 `cordis` 启用快捷按钮；关闭设置，创建空 Creator 会话，成功后清空旧草稿，失败保留，不自动发送消息；无额外 Developer Tools 门槛                                        | `PluginCreatorAction.spec.tsx`、既有 Creator flow；真实目标 roster 发现通过，完整 VS Code 草稿交互待验                                                                                                 |
| Claude Code mods AbovePrompt band                                                                                                 | 独立 alpha211 port + Application + Host/严格协议 + Webview 提示带；固定 watch/press、generation 防过期、并发拒绝、有界长轮询、取消释放及绘图 allowlist；标准 profile 缺失时隐藏                 | `alpha211-mods-band.spec.ts`、Host `alpha211-mods-projection.spec.ts`、`ModsBand.spec.tsx`；精确实验包实际 Remote 正向/缺失及释放通过，生产 mod/VS Code 交互待验                                       |
| Session Inspector / Chrome DevTools                                                                                               | 本地元数据检查器提供类型过滤/分页/sequence 匹配/聚合行拾取/虚拟列表定位；固定 bootstrap→Worker 发现，DevTools 打开/复制留在 Host；不导出原始日志、内部对象或正文                                | `alpha211-inspector.spec.ts`、Host `alpha211-inspector-projection.spec.ts`、`SessionInspector.spec.tsx`、`Timeline.scale.spec.tsx`；精确实验包实际 Worker/释放通过，Chrome 原生打开及 VS Code 交互待验 |
| Markdown frontmatter 字段预览、Composer stats/Dock 细节                                                                           | 现有 captured Markdown Host 脱敏预览内增加字段与安全 Markdown；有界 YAML AST、不展开 alias、数字/集合保留源码、畸形回退；统计增加精确毫秒、TTFT、速度及已报告 usage，Dock 采用既有 VS Code 布局 | `MarkdownDocumentPreview.spec.tsx`、`StatsDetails.spec.tsx`/`StatsLine.spec.tsx`；真实文件预览/统计现场待验                                                                                            |
| Session list 分片、上传 receipt 实例归属、Plugin runtime resolution/HMR、Preset introspection、OS 分配桌面端口、Office 和发布通道 | 后端内部、可选诊断、桌面或构建变化；当前消费的 Remote 参数/返回契约未增加必需字段，保持既有传输/所有权边界                                                                                      | 对目标实际源码及主服务接口的差异核查；本次没有复制后端实现或修改扩展发布版本                                                                                                                           |

## 新增预览的验收边界

Domain 增加显示专用事件和可选 preparation view；Adapter 的有状态归一器归属于单个 Session，位于 Controller 接收之前，只计算一次，不能放到会分别供 observer/listener 调用的 mapper。重订阅从新基线重建，块结束和中断后忽略晚到片段。

实际 `SessionAssistantStreamFrame` 的 chunk 不直接携带 turn/step；`start` 或 reconnect baseline 提供坐标。既有 `Alpha13AssistantStreamProjector` 先验证 revision、attempt、dense index 与 settlement，再向版本归一器提供补齐坐标的内部帧。预览消费这条已验证路径，不把测试 fixture 的字段当作上游直接返回字段。新增安装结果的严格协议也核对 SemVer，拒绝 `word`、缺段、前导零和畸形 prerelease/build。

JSON 投影不保留 `content`、`old_string`、`new_string` 正文；只统计解码后的 UTF-16 字符数。说明、路径、键数、层数和活动 call 数都有界。畸形转义、重复顶层键、错配容器、尾随逗号或垃圾使字段预览清空。说明通过既有脱敏器处理。

Host 只发布当前 backend 的 allowlist。完整源路径留在 Host；只有属于当前工作区/受管临时工作区的路径变为规范相对路径。每 attempt 缓存作用域读取；读取失败时省略路径，连接替换后丢弃旧结果。严格协议拒绝额外正文、原始 arguments、绝对路径、穿越路径和畸形计数。

Store/Timeline 保持持久序列不变，预览不进入持久历史/Trajectory、不增加执行工具计数或“正在使用工具”。跟随流基线清除旧预览，控制流基线不误删；执行调用替换预览，重试、中断、step/turn 结束和断连清理。未知工具也使用相同的安全准备行，不能展开工具正文。

## 验证记录

补齐后的最终 `pnpm check` 通过：302 个测试文件、3,419 项测试通过；21 个文件、22 项测试跳过。格式、文档、i18n、lint 与严格类型检查全部通过。跳过的现场测试没有计为通过。自动覆盖包含协议/业务错误、超时、取消/释放、旧 generation、并发、过期 roster、权限/连接替换、有界树/YAML、敏感值拒绝、Host 原生动作、实际 Composer 预览与 10,000 节点定位。检查器入口归入会话三点菜单，关闭菜单后仍保持独立拾取/定位与焦点恢复；切换会话不会复用旧打开请求。

补齐后的 `pnpm build` 通过 Webview 生产构建与 Extension Host 打包；`git diff --check` 通过，`git status --short` 已复核。YAML parser 仅在 Markdown frontmatter 预览时动态加载。生成产物没有进入版本控制。

本轮额外在 Windows 对固定 `0.2.1-alpha.1` 隔离运行包执行 `tests/live-dsh/run.spec.ts` 与 `tests/live-dsh/alpha211-surfaces.spec.ts`，2 项均通过。设置 `DSH_LIVE_SMOKE=1`、`DSH_LIVE_RUNTIME_VERSION=0.2.1-alpha.1` 和 `DSH_LIVE_RUNTIME=<isolated exact package executable>`，执行 `pnpm exec vitest run tests/live-dsh/run.spec.ts tests/live-dsh/alpha211-surfaces.spec.ts --maxWorkers=1 --reporter=verbose` 可复现。验证受管启动、精确握手、Session/Workspace 读取、空 Question 路由、Schedule/Plugin Manager 目录、账号 signed-out/watch 取消，以及进程、流和端口释放；未使用模型、授权或安装请求。

目标真实包的既有隔离 CLI 测试覆盖 exact probe、Session/Workspace、Question 空路由、默认 Schedule/Plugin Manager 目录、账号 signed-out/watch 及进程/端口释放；VS Code managed connect/reconnect E2E 已通过。它们不证明有效 timed 问答、委派 Schedule 拒绝、插件安装恢复、OAuth 或新增预览的真实模型/界面交互。

补齐后在 Windows 再次运行标准 profile 的 `alpha211-surfaces.spec.ts`，通过健康 Creator roster 与未挂载 mods/Inspector 的安全降级。随后在同一精确 CLI 发布包安装精确 `@deepseek-ai/dsh-experimental-claude-code-mods@0.2.1-alpha.1`，使用随 CLI 已安装的同版本 Inspector，运行 `alpha211-optional-surfaces.spec.ts`：实际 bootstrap/Worker 身份与唯一 target、mods 首次 watch 绘图、按钮回调后的 generation/内容、旧 generation 拒绝、取消和双端口释放均通过。仅绘图 mod 为可丢弃测试插件，未调用模型或执行工具；这不是生产 mod 的全功能验收。第一次 overlay 尝试因 `--patch` 放在应用参数之后启动失败；依据真实 CLI 参数源码改为 launcher 前缀后通过，未放宽产品契约。

正向验证可复现：在系统临时目录安装精确 DSH 和上述 mods 包，设置 `DSH_LIVE_SMOKE=1`、`DSH_LIVE_RUNTIME_VERSION=0.2.1-alpha.1`、`DSH_LIVE_RUNTIME=<exact dsh executable>`、`DSH_LIVE_OPTIONAL_PACKAGE_ROOT=<isolated package directory>`，运行 `pnpm exec vitest run tests/live-dsh/alpha211-optional-surfaces.spec.ts --maxWorkers=1 --reporter=verbose`。测试会创建一次性 home/workspace/overlay，只停止持有的进程并核对主服务和 Worker 端口释放。

补齐后联合执行 `run.spec.ts`、`alpha211-surfaces.spec.ts` 和 `alpha211-optional-surfaces.spec.ts`，3 个真实运行规格、3 项测试全部通过。最后收紧 numeric loopback 公告格式并覆盖显式默认端口后，单独重验受影响的 Inspector/mods 正向 live；基础 smoke 无需复制为 UI 验收证据。

真实回放待完成：在隔离目标运行包与 VS Code 中使用有效模型，触发 read/write/edit/bash/run_code 的分段参数，观察准备行；分别取消和重连，确认路径/正文隔离、准备到执行的替换和执行计数。亮/暗/高对比、窄侧栏、键盘/读屏及跨平台仍须现场验收。代码与模拟流测试不能代替这些证据。

本轮适配和菜单调整归入扩展 `0.2.12`；发布结果以对应 GitHub Release、Actions 和 Marketplace 记录为准。`v0.2.11` 发布检查发现 Markdown 的共享高亮完成会覆盖未变化消息的 DOM，导致文件打开按钮消失；该版本未发布。以真实高亮完成通知稳定复现后，保持未变化 HTML prop 的身份，修复后再执行完整门禁。保留 `.codegraph/` 与无关本地产物，不纳入提交或 VSIX。
