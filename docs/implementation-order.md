# 实施顺序与退出条件

不要按目录横向实现。每一阶段都必须形成可以验证的垂直切片；前一阶段退出条件未满足时，不进入后一阶段。

## 阶段 0：固定上游契约

实现内容：

1. 从固定提交复制/生成脱敏的 RPC 名称、请求/响应 Schema 和事件 fixture 到契约测试资源。
2. 完成 `Rc6VersionAdapter.probe`，明确识别兼容/不兼容/非 DSH/不可达。
3. 完成 AppError 映射规范和所有协议 Schema。

退出条件：契约测试可发现 rpc-map 漂移；连接未知版本会明确失败；fixture 不含路径、Prompt 或 Secret。

## 阶段 1：View、配置和 Runtime Missing

实现内容：

1. 激活/Composition Root/Webview CSP/message schema。
2. `dsh.*` 设置读取和验证。
3. Runtime Locator：配置路径 -> PATH -> npm global。
4. 缺失视图底部操作区、安装任务、复制命令、选择路径、重试、文档。
5. Secondary Side Bar 引导，不使用私有 API。

退出条件：没有 DSH 时不崩溃、不自动安装；每个按钮有成功/失败/取消测试；视图 240px 宽可用。

## 阶段 2：发现、连接、所有权与恢复

实现内容：

1. 配置端口、Known、默认端口、Windows/Linux/macOS 进程、可选 companion Provider。
2. 并发发现、去重、排序、逐个 Probe。
3. attach-before-spawn 协调器、连接并发合并。
4. `dsh web --host 127.0.0.1 --port 0|fixed` 启动和 readiness。
5. 外部/受管关闭语义、连接状态 UI、脱敏诊断。

退出条件：已有 DSH 时 spawn 计数为 0；并发入口只产生一次工作；外部进程在扩展卸载后仍存活；只停止测试创建的 managed child。

## 阶段 3：基础 Workspace、Session 和 Conversation

实现内容：

1. Workspace 列表/创建/重命名/删除。
2. Session 新建/列表/分页/搜索/历史/重命名/分叉/归档。
3. 单例 Host/Mux 流、序号、重连、历史补洞。
4. 文本/推理/错误/标题/统计 Timeline；虚拟化和流合批。
5. Composer 发送/停止；附件基础通路。

退出条件：重放 fixture 得到确定 Timeline；重连无重复/缺失；大历史不卡主线程；实际 rc.6 完成新会话和恢复。

## 阶段 4：运行中输入、模型和交互

实现内容：

1. Queue/Steer、队列编辑/删除/转 Steer、Cancel。
2. Provider/Model/Reasoning 动态发现和每会话应用。
3. Preset、Tools Mode、Permission Preset、Plan Mode。
4. Provider 非密钥 Schema Form；密钥经 Extension Host 密码输入。
5. Permission 和 User Question 卡片。

退出条件：未知 Provider/Model 不丢失；Secret 永不进入 Webview/日志；运行中输入行为由服务器事件确认；审批只能响应一次。

## 阶段 5：高级 Agent 能力

实现内容：

1. Goal/Todo 和 Plan Mode 恢复。
2. Jobs 输出、通知、停止。
3. Subagent 树、历史、Follow-up、Interrupt。
4. Workflow/Ralph 阶段生命周期。
5. Skills 发现/执行、动态命令、Plugin Inventory/配置。
6. 未知工具和未知事件的安全降级。

退出条件：每类事件有契约 fixture；父子会话路由正确；未知上游能力不导致 Renderer 崩溃；外部 backend 不因插件配置被强制重启。

## 阶段 6：导出、体验、性能和发布

实现内容：

1. Markdown/JSON/ZIP 流式导出和附件。
2. 草稿、通知、键盘、Quick Pick、错误恢复。
3. 可访问性、主题、高对比、窄宽、Reduced Motion。
4. 性能预算、E2E、VSIX 审查、隐私和发布文档。

退出条件：满足 `docs/release-checklist.md` 全部条目；所有核心能力矩阵为 DONE 且有真实 DSH 证据。

## 阶段内任务模板

每个能力建立一个短任务，正文必须包含：

```text
Capability: <矩阵中的名称>
Upstream evidence: <固定 commit 的文件和行>
Domain changes: <类型/接口>
Adapter changes: <RPC/Event/Mapper>
Protocol changes: <request/response/event schema>
UI changes: <component/store selector>
Tests: <contract/unit/integration/e2e>
Failure/cancel/disposal behavior: <明确描述>
Definition of done: code + automated + live evidence
```
