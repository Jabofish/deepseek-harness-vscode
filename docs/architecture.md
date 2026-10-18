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

| 层                      | 职责                                                | 禁止                                    |
| ----------------------- | --------------------------------------------------- | --------------------------------------- |
| Domain                  | 稳定类型、错误、仓储接口和纯规则                    | VS Code、React、HTTP、进程与平台 API    |
| Application             | 用例、连接协调、端口                                | 上游 wire 类型、Webview 组件            |
| DSH Adapter             | 版本化探测、RPC/Event 映射、错误归一和流恢复        | `vscode.*`、把上游类型泄漏到上层        |
| Extension Host          | 组合、VS Code API、进程、文件、网络、凭据和消息路由 | 把特权资源交给 Webview                  |
| Webview Protocol        | 双向消息的严格 schema 与安全 DTO                    | Secret、传输实现和上游原始类型          |
| Timeline / UI / Webview | Host 内纯展示归约、Webview 有界窗口及交互展示       | Webview 直接访问 DSH、Node 或工作区文件 |

DSH 版本身份及版本间契约差异位于 `packages/dsh-adapter/src/versions/<version>/`；发现来源只产出候选，Probe 负责协议验证；UI 按能力分组，通过用例和协议访问 Host。未知工具退回通用卡，不按工具名猜测执行或审批状态。

## 用户控制

用户明确操作优先于插件的本地推断、显示模式和辅助缓存。插件传递用户选择的模型、权限选项、配置和控制命令，不因可选字段缺省、目录加载失败或旧运行状态自行拦截、替换选择或伪报成功。运行中的模型与权限调整交给真实上游契约处理；上游拒绝必须保留可公开原因，界面显示失败并允许用户重试。

停止、拒绝工具执行、撤回排队输入、取消提问与终止作业是独立控制入口，不能依赖发送、模型目录或交互卡片是否可用；工作区失去信任不能阻止这些撤回操作。Host 根据待处理审批的结构化选项识别拒绝，不能用选项名称或 ID 猜测授权语义。Host 始终核对目标归属，继续执行工具和文件操作仍遵循用户授予的信任与端点授权。控制请求按窗口及请求身份关联，关闭窗口和旧请求的迟到结果不能影响其他用户操作。

## 连接与进程

未指定连接目标时，`auto` 优先针对上次成功的本机端点核对当前监听进程、命令行和包版本；记录中的 PID 只用于缩小查询，不能作为身份或所有权证据。成功即可附加，否则完成官方默认、经校验的 companion registry 和受限进程发现，全部不可用后才允许启动本机 DSH。手动设置服务地址时按单目标 `custom` 连接，显式附加端口列表则严格限制候选；失败不改连其他目标或自动启动，用户仍可改设置、重试或切回 auto。`attach-only` 不启动；`new-isolated` 只创建扩展持有的实例。候选有界并行校验，按优先级选定一个连接；不扫描任意端口范围。修改设置取消旧连接尝试，设置写入保持串行，旧结果不得回填新连接。

| 来源                                 | 所有权     | 断开或停用时                                       |
| ------------------------------------ | ---------- | -------------------------------------------------- |
| 设置、已知实例、进程发现或 companion | `external` | 只关闭客户端和流；可重连，绝不停止、重启或接管进程 |
| 当前扩展直接创建并持有句柄           | `managed`  | 先优雅停止，超时后也只终止该句柄                   |

PID 不证明所有权。发现先于启动、单个 in-flight 连接和显式句柄所有权同时保护用户现有 DSH。连接、订阅、socket、timer 和子进程在成功、失败、取消、超时与停用路径均须释放。

远程连接仅由原生确认的 `custom` 入口授权，自动发现限 loopback。凭据按执行环境身份和完整 origin 隔离存入 SecretStorage；执行环境身份在 Host 的扩展存储中原子创建，不进入 Webview 或日志，不能用只区分连接类型的 `remoteName` 代替。缺少当前执行环境作用域的授权记录不可用于连接。失效认证只在连接前刷新，不重放业务写入。HTTP/WebSocket 禁止跳转并固定经过校验的 DNS 地址，HTTPS 强制证书与主机名校验；远程 HTTP 要求明文确认，地址变化后重新授权。远程目标拒绝元数据、环回、链路本地与非单播地址。取消、超时或凭据变更后清理旧连接；远程端点不授予本地文件及 Inspector 权限。

Remote SSH、WSL 和 Dev Container 中，Extension Host 与 DSH 位于工作区一侧，Webview 显示在本地；PATH、全局包、进程、端口和文件操作均以 **Extension Host 所在平台**为准。已知实例的持久提示只保存经验证的 loopback port，不把完整 endpoint 或凭据写入工作区状态；读取旧格式时也必须重新校验 loopback。

原生附件选择保留完整 URI，并通过 `workspace.fs` 读取相应文件系统；客户端路径不能交给远端 Node 文件 API。桌面远程 Inspector 只转发已验证的 loopback Worker，原生转发结果必须仍是客户端 loopback，保持固定 CDP 路径；地址仅在 Host 的打开/复制动作使用。状态查询不建立转发，取消或连接更换后不执行客户端动作；浏览器客户端明确返回原生 DevTools 不可用。

## Host 与 Webview 消息

`packages/webview-protocol/src/schemas.ts` 是请求名和字段的代码事实来源。消息经过严格 discriminated union 校验，由对应类型、Host router 和 ProtocolClient 处理。禁止通用 `{ action: string, payload: any }`。Webview 请求有唯一 `requestId`，Host 最多返回一次终态；长期事件有递增 `sequence`，Store 忽略重复和旧序号。协议只传可序列化 Domain DTO，不传 Error、Map、Set、AbortSignal、VS Code 对象或上游类型。

Webview 不接收 endpoint、PID、命令行、Cookie、launch token、Secret、绝对工作区路径、系统提示词或原始诊断 body。文件与变更卡片可显示相对文件标识，但不能据此推断文件夹归属。路径作用域操作只接受 Host 从会话 `cwd` 解析的 VS Code `workspaceFolderId`；它与 DSH workspace id 属于不同命名空间。没有打开 VS Code 文件夹时，相关本地能力不发起请求，也不把未读取显示成空列表。Host 对 enum、id、端口、路径、长度和权限再次验证。

错误响应只含稳定 code、脱敏 message 和 retryable。增量消息与终态在 Host/Store 立即投递和通知，不引入定时合批或绘制帧等待；一个 backend 共享一个上游流，历史分页传输。Webview 隐藏时可暂停昂贵渲染，不得丢失审批、问题或连接状态。断线恢复按服务器序号重新订阅、补齐缺口、去重并提交 reducer，不能只按时间戳排序。

Timeline 的实时归约发布不可变节点快照；批量历史回放可以拥有私有工作数组及查找索引，但不得发布中间状态或把索引写入协议/持久化。插入、替换和删除节点后按最早变更位置同步索引；渲染投影仅在变更基准与上次快照身份一致时使用增量范围，否则安全重建。Turn、重试、计时与用量证据由独立状态规则管理，预览清理不将参数生成阶段当作已执行工具。

普通和子代理会话统一由 Host `TranscriptWindowService` 安装 DSH 的权威历史页，并消费 Adapter 已整理的事件。DSH 已提供的当前领域 projection 直接读取；Host 仅做安全展示转换及缓存调度，不实现第二个序列补洞引擎。打开和翻页传完整窗口，实时更新按 Host 视图修订号发送变化节点及当前节点顺序；Webview 保留未变化节点的对象身份，只更新受影响的展示行。补丁缺少对应窗口时重读 Host 权威窗口，不排序或回放补丁。Webview 不保存原始历史、补洞、回放或压缩索引；缺少窗口的打开响应直接拒绝，没有旧 Host 回放兼容分支。Webview 协议不再暴露普通会话的原始历史读取；子代理历史入口只打开窗口，所有翻页均走窗口导航。

当前 Todo、队列、Goal、配置、模型与子代理目录采用上游整值或明确回执。Webview 不按消息文本或附件猜测队列接纳，不从聊天历史恢复当前 Todo，不据子会话创建事件重建目录树，也不在 Goal 修改后用请求值覆盖权威结果。创建、变更事件仅使相关目录失效；原生目录重读决定最终内容。旧 DSH 没有 Todo projection 时，Host 从结构化整值事件提供有界当前清单桥；历史页不会改变当前清单，裁切必须明确标记。

窗口最多 256 个节点，序列化驻留预算为 512 Ki 字符；历史单节点预览预算为 16 Ki 字符。活动回复节点允许最多 64 Ki 字符，其中正文和思考各保留最多 24 Ki 字符；超限滚动保留最新尾部，不能把活动内容永久冻结在历史前缀。Host 保留活动尾部与当前历史页，开会话缓冲受同一条数/字符预算限制，溢出后重读而非安装缺失数据。回看游标最多 64 个；非持久通知按 16 会话、每会话 128 条、全局 512 Ki 字符缓存，并保留展示锚点。会话权限缓存只存元数据，最多 16 项且每项不超过 256 Ki 字符。

Webview 打开屏障只缓存一个最新窗口和有限控制事实，合计最多 128 帧 / 1 Mi 字符；被替代、失败和 dispose 时释放，不跨失败打开积攒正文。审批和问题没有待合并的 advisory list，直接更新交互状态；缓冲溢出重取权威控制面和窗口。Host 使用已有工作目录投影解析工具路径，不因每次参数预览再读取会话。缺口通知只保留展示范围，由上游页明确覆盖后退役，不触发另一轮补洞。

窗口发送使用最多 64 个待确认视图信用，合计不超过 512 Ki 字符；不支持节点补丁的发送方仍限制为 1 个。Host 更新立即尝试发送，不使用定时合批，也不把一次 ACK 往返串入每帧周期。发送尚未完成时仅合并最新状态。信用或字符预算耗尽时只保留最新状态，确认后合并发送；不保留待发送的 Delta 账本。`session.transcript.ack` 表示 Webview 已安装，`postMessage` 返回 true 只表示已交给传输。Host 仅保留上一已发送窗口的有界节点身份和脱敏节点作为差分基线；流式正文优先发送脱敏后的新增文本及精确基线长度，不反复传输累计正文。普通 token 不重复脱敏、校验或传输未变事件事实；回合、统计、分页、省略及当前 Todo 元数据变化时整体替换该元数据，缺省字段随之清除。节点重排、淘汰或删除时退回整窗。Webview 仅对匹配视图修订和正文长度的补丁做展示字符串追加，不维护上游事件账本或重排队列。Webview 安装状态后同步通知订阅者，未变正文不重复序列化，流式 Markdown 的稳定前缀与活动尾部分别更新 DOM。侧边栏与每个编辑器聊天窗口分别拥有历史窗口、导航游标、确认和可见状态；关闭只释放对应窗口，旧窗口排队的消息不能发送到同标识的新窗口。隐藏、重建及释放由 Host 的视图生命周期控制，不依赖隐藏页面的 timer。历史页替换、较新页与返回最新使用原生 DSH 分页游标；长内容通过受工作区权限及当前窗口身份约束的 Host 路由按需在原生编辑器打开。Inspector 读取有界事件元数据，不持有聊天正文账本。上述是每个窗口的驻留预算，不能当作 DSH RPC 解码、大型单页或原生编辑器的峰值内存上限。

通用事件发送队列最多保留 128 个等待项及 512 Ki 字符，另允许一个原子在途帧受协议预算约束。溢出会释放等待项并发出视图重读信号；Webview 重开权威窗口，Host 顺序重投既有控制面事实。未经观察的回合结算不能冒充已完成；待处理回合等待器在重读时退出，原始 DSH 任务继续由其宿主管理。

### 需要独立身份的长操作

插件安装使用独立 `installRequestId`，与一次 Webview 请求的 `requestId` 分离。调用安装 Remote 前失败须明确返回“未开始”；调用后若回包丢失或取消太迟，必须以同一安装 ID 查询结果。结果未知时刷新权威目录，不重新发起安装；取消与等待也按同 ID 去重。

Job 输出的 `at`/`next` 是 UTF-8 字节偏移，首次数据帧可合法重叠恢复游标；按字节并在码点边界裁切已显示前缀，真实缺口和畸形帧关闭该恢复路径。账号详情的 `accountScopeRevision` 仅在当前 Host 生命周期单调；作用域或连接身份变化时清理旧账号 UI，账号 ID 留在 Host。

## 安全规则

- DSH 网络目标仅限经规范化校验的 HTTP(S) origin 和合法端口：本机发现默认只接受 `127.0.0.1`/`localhost`，`custom` 模式允许用户显式配置的远程地址；Webview 不直接联网、读文件或启动进程。
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
- **辅助侧边栏默认位置**：使用 VS Code 稳定贡献点注册 View，升级保留编辑器已保存的布局；移动位置使用原生选择器。
- **编辑器区聊天是独立表面**：View 无法移动到编辑器区，因此编辑器区聊天由 `createWebviewPanel` 承载，每个会话一个标签并由序列化器在重载后恢复；Host 用表面注册表维护身份与路由，响应只回到发起的表面，一个表面释放不取消其他表面的请求、Job 跟读或编辑器上下文。新表面复用已有连接，仅定向接收当前状态和控制基线；不得因加入表面重新挂接共享服务。侧边栏始终可独立新建、切换和发送会话消息，编辑器标签的数量与生命周期不能覆盖侧边栏选择或隐藏其操作入口。
- **版本化 Adapter**：上游变化在版本边界内消化，Domain、Application 和 Webview 不依赖上游类或版本判断。
- **Secret 留在 Host**：普通 Webview 输入框不处理 Provider Secret，诊断和协议测试必须验证无泄漏。
