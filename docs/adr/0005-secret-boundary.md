# ADR 0005：Secret 只经过 Extension Host 与 DSH

- 状态：Accepted
- 日期：2026-08-16

## 决策

Provider Secret 使用 VS Code 密码输入并由 Extension Host 直接传给本地 DSH 凭据接口。Webview 只获得字段定义和 configured/missing 状态；Secret 不进入 Webview、workspaceState、日志、协议 fixture 或剪贴板。

## 后果

Provider Settings UI 需要通过命令请求 Host 输入，不能使用普通 React password input 保存值。所有诊断和协议测试必须包含泄漏负面断言。
