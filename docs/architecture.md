# 架构、协议与信任边界

本文件定义跨能力必须保持的结构。DSH 的具体版本、RPC 和事件形状只在 [上游契约](dsh-contract.md) 维护；能力完成度只在 [能力矩阵](capability-matrix.md) 维护。

## 依赖方向

```text
apps/extension -> application + dsh-adapter + webview-protocol
application    -> domain
dsh-adapter    -> application ports + domain + pinned upstream contract
apps/webview   -> domain DTO + timeline + ui + webview-protocol
timeline       -> domain
ui             -> domain + React
domain         -> nothing platform-specific
```

| 层                      | 职责                                                | 禁止                                 |
| ----------------------- | --------------------------------------------------- | ------------------------------------ |
| Domain                  | 稳定类型、错误、仓储接口和纯规则                    | VS Code、React、HTTP、进程与平台 API |
| Application             | 用例、连接协调、端口                                | 上游 wire 类型、Webview 组件         |
| DSH Adapter             | 版本化探测、RPC/Event 映射、错误归一和流恢复        | `vscode.*`、把上游类型泄漏到上层     |
| Extension Host          | 组合、VS Code API、进程、文件、网络、凭据和消息路由 | 把特权资源交给 Webview               |
| Webview Protocol        | 双向消息的严格 schema 与安全 DTO                    | Secret、传输实现和上游原始类型       |
| Timeline / UI / Webview | 事件归并、可见窗口和交互展示                        | 直接访问 DSH、Node 或工作区文件      |

新增 DSH 版本只在 `packages/dsh-adapter/src/versions/<version>/` 建立身份及已核对的增量；新增发现来源只产出候选，Probe 负责协议验证；新 UI 按能力分组，通过用例和协议访问 Host。未知工具退回通用卡，不按工具名猜测执行或审批状态。

## 连接与进程

`auto` 必须先完成设置、已知实例、官方默认、经校验的 companion registry 和受限进程发现的候选验证，全部不可用后才允许启动本机 DSH。`attach-only` 只连接；`new-isolated` 只创建一个扩展持有的实例；`custom` 只探测用户给定且经校验的单个 loopback 端点，不转入自动启动。候选去重、排序、失败后继续和并发入口合并由连接协调器负责；不扫描任意端口范围。

| 来源                                 | 所有权     | 断开或停用时                                       |
| ------------------------------------ | ---------- | -------------------------------------------------- |
| 设置、已知实例、进程发现或 companion | `external` | 只关闭客户端和流；可重连，绝不停止、重启或接管进程 |
| 当前扩展直接创建并持有句柄           | `managed`  | 先优雅停止，超时后也只终止该句柄                   |

PID 不证明所有权。发现先于启动、单个 in-flight 连接和显式句柄所有权同时保护用户现有 DSH。连接、订阅、socket、timer 和子进程在成功、失败、取消、超时与停用路径均须释放。

Remote SSH、WSL 和 Dev Container 中，Extension Host 与 DSH 位于工作区一侧，Webview 显示在本地；PATH、全局包、进程、端口和文件操作均以 **Extension Host 所在平台**为准。已知实例的持久提示只保存经验证的 loopback port，不把完整 endpoint 或凭据写入工作区状态；读取旧格式时也必须重新校验 loopback。

## Host 与 Webview 消息

`packages/webview-protocol/src/schemas.ts` 是请求名和字段的代码事实来源。所有消息经严格 discriminated union 校验后才能产生副作用；新增消息同时更新 schema、类型、Host router、ProtocolClient 测试。禁止通用 `{ action: string, payload: any }`。Webview 请求有唯一 `requestId`，Host 最多返回一次终态；长期事件有递增 `sequence`，Store 忽略重复和旧序号。协议只传可序列化 Domain DTO，不传 Error、Map、Set、AbortSignal、VS Code 对象或上游类型。

Webview 不接收 endpoint、PID、命令行、Cookie、launch token、Secret、绝对工作区路径、系统提示词或原始诊断 body。文件与变更卡片可显示相对文件标识，但不能据此推断文件夹归属。路径作用域操作只接受 Host 从会话 `cwd` 解析的 VS Code `workspaceFolderId`；它与 DSH workspace id 属于不同命名空间。没有打开 VS Code 文件夹时，相关本地能力不发起请求，也不把未读取显示成空列表。Host 对 enum、id、端口、路径、长度和权限再次验证。

错误响应只含稳定 code、脱敏 message 和 retryable。增量消息在 Host/Store 合批，终态立即投递；一个 backend 共享一个上游流，历史分页传输。Webview 隐藏时可暂停昂贵渲染，不得丢失审批、问题或连接状态。断线恢复按服务器序号重新订阅、补齐缺口、去重并提交 reducer，不能只按时间戳排序。

### 需要独立身份的长操作

插件安装使用独立 `installRequestId`，与一次 Webview 请求的 `requestId` 分离。调用安装 Remote 前失败须明确返回“未开始”；调用后若回包丢失或取消太迟，必须以同一安装 ID 查询结果。结果未知时刷新权威目录，不重新发起安装；取消与等待也按同 ID 去重。

Job 输出的 `at`/`next` 是 UTF-8 字节偏移，首次数据帧可合法重叠恢复游标；按字节并在码点边界裁切已显示前缀，真实缺口和畸形帧关闭该恢复路径。账号详情的 `accountScopeRevision` 仅在当前 Host 生命周期单调；作用域或连接身份变化时清理旧账号 UI，账号 ID 留在 Host。

## 安全规则

- DSH 网络目标仅限经过验证的 `127.0.0.1`/`localhost` 和合法端口；Webview 不直接联网、读文件或启动进程。
- Webview CSP 使用 nonce，禁止远程脚本、`unsafe-eval`、内联事件和任意 frame；模型 Markdown 禁止原始 HTML，链接只接受安全 scheme 并由 Host 打开。
- Secret 经 VS Code 密码输入或 SecretStorage 交给 Extension Host 和本机 DSH；Webview 只见 configured/missing，Secret 不进入日志、状态、fixture 或剪贴板。
- 日志以字段 allowlist 为准，对 prompt、body、response、工具输入输出、token、authorization、password、secret 和路径做递归脱敏；诊断只发布有界的版本、状态、来源类别、可重连标志及脱敏日志。完整 endpoint、PID、环境变量和堆栈不外传。
- 子进程直接 spawn 固定 executable 与参数数组，不使用 shell。附件、导出、文件打开和选择经用户操作与 VS Code API，由 Host 校验 Uri、工作区信任、路径穿越、符号链接、Zip Slip 和覆盖意图。
- Permission、Plugin、安装、重启、删除、导出等副作用须由用户显式触发；未授予 Workspace Trust 时不自动启动高权限 Agent。
- Webview 不允许 WebAssembly 编译，代码高亮使用 JavaScript 引擎；仅受控高亮与控件可使用 CSP 放行的内联样式属性，脚本仍受 nonce 限制。

Checkpoint 与 Prompt Template 属于 Host 本地能力，不伪造 DSH RPC。前者默认关闭并要求 checksum、journal/backup、冲突预览及原子写入；后者只写 Host 管理的存储或受信工作区固定目录，变量使用白名单。Webview 只见安全摘要和 opaque ref。

## 设计决定及理由

- **Web Host API 为主通道**：完整会话、工具、审批和 Agent 状态必须来自结构化 RPC/Event；TUI/ANSI 和模型文本不是机器契约。
- **发现先于启动**：先验证外部候选，保留用户已有进程；只有当前扩展持有的进程可以停止。
- **Activity Bar 默认位置**：使用 VS Code 稳定贡献点，提供把 View 移到 Secondary Side Bar 的引导；不调用私有 API，也不承诺安装后自动右置。
- **版本化 Adapter**：上游变化在版本边界内消化，Domain、Application 和 Webview 不依赖上游类或版本判断。
- **Secret 留在 Host**：普通 Webview 输入框不处理 Provider Secret，诊断和协议测试必须验证无泄漏。
