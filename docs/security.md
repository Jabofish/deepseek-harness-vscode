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
5. Secret 输入不进入 Webview。UI 只显示 configured/missing；日志只记录 value length 也应慎重，正式实现最好不记录。
6. 日志采用字段 allowlist 和递归 redact，默认不记录 prompt、body、response、tool input/output。
7. Markdown 禁止原始 HTML；链接只允许安全 scheme，并经用户点击后由 VS Code 打开。
8. 文件/附件/导出必须使用用户选择或工作区允许的 Uri；防止 `..`、Zip Slip、符号链接越界和静默覆盖。
9. Permission/Plugin/安装/重启/删除/导出等有副作用操作必须由用户显式触发。
10. Workspace Trust 未授予时只允许连接/浏览安全元数据，禁止自动启动高权限 Agent；具体降级 UI 在实现时测试。

## 诊断报告默认允许字段

- 扩展版本、DSH 版本、OS 名称；
- 状态名、ownership 类型、候选来源类型；
- 稳定错误码、重试次数、耗时、事件类型计数；
- 已启用 capability 名称。

默认禁止 endpoint、pid、完整命令行、用户名、绝对路径、仓库名、Prompt、响应正文、Tool 输入输出、API key、Token、Header、环境变量。
