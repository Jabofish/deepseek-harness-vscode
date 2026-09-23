# 安全与信任边界

## 信任模型

- DSH 仅允许 loopback；本版本不支持任意远程 Host。
- Extension Host 可以访问 VS Code API、工作区、进程和本地 DSH，是唯一特权边界。
- Webview 内容和消息均按不可信输入处理。
- DSH/Plugin/Tool 返回的 Markdown、路径、命令和 HTML 也按不可信内容处理。

## 强制控制

1. Webview CSP 使用 nonce，禁止远程脚本、`unsafe-eval`、内联事件和任意 frame。
2. 所有双向消息经 Zod discriminated union；拒绝额外/非法高权限参数。
3. DSH endpoint 固定 `127.0.0.1`/`localhost`，端口范围 1–65535。
4. 子进程使用直接 spawn 和参数数组；不使用 shell，不拼接用户命令。
5. Secret 输入不进入 Webview。UI 只显示 configured/missing；日志 allowlist 中不存在 Secret 值或长度的字段。
6. 日志采用字段 allowlist 和递归 redact，默认不记录 prompt、body、response、tool input/output。
7. Markdown 禁止原始 HTML；链接只允许安全 scheme，并经用户点击后由 VS Code 打开。
8. 文件/附件/导出必须使用用户选择或工作区允许的 Uri；防止 `..`、Zip Slip、符号链接越界和静默覆盖。
9. Permission/Plugin/安装/重启/删除/导出等有副作用操作必须由用户显式触发。
10. Workspace Trust 未授予时只允许连接/浏览安全元数据，禁止自动启动高权限 Agent；具体降级 UI 在实现时测试。

`script-src` 不包含 `wasm-unsafe-eval`，因此 Webview 内的 WebAssembly 编译与实例化会被浏览器拒绝，这是有意
保留的边界：Webview 依赖不得依赖 WebAssembly。代码高亮因此使用 Shiki 的 JavaScript 正则引擎
（`shiki/engine/javascript`），不加载任何 wasm 资源。
Shiki 的语法 token 和部分 React 控件使用内联 `style` 属性；CSP 只对 `style-src-attr` 允许这些属性，
`style-src-elem` 仍限定在扩展打包资源，脚本仍需 nonce。模型 Markdown 的原始 HTML 继续被禁用，
不会因为代码高亮而允许用户内容注入 `<style>` 或 `<script>`。

已知实例发现的 workspace state 只保存经连接校验的 loopback port（`dsh.lastEndpoint`）；完整 endpoint
只存在于 Extension Host 的活动连接中，不进入 Webview。旧版本曾保存 `{ endpoint }` 的兼容记录，读取时仅
接受 loopback、端口和严格匹配的 `http://` URL，并在下一次成功连接时覆盖为 port-only 记录；该迁移不读取或
保存凭据。

## 诊断报告默认允许字段

- 快照只含扩展版本、连接后的 DSH 版本、连接状态、endpoint 类型（`external`/`managed`/`configured`）、是否可重连和最近 32 条脱敏日志行。
- 日志字段由 `apps/extension/src/backend/diagnostics.ts` 的 allowlist 决定（错误/阶段/候选来源/方法/状态/所有权/计数与耗时等结构化字段）；`message`/`stack`/`detail` 先经共享脱敏器，单条日志有长度上限。

默认禁止 endpoint、pid、完整命令行、用户名、绝对路径、仓库名、Prompt、响应正文、Tool 输入输出、API key、Token、Header、环境变量。
