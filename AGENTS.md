# 实现代理操作规范

本文件是代理的强制约束。长期说明分别见 [架构与安全](docs/architecture.md)、[DSH 契约](docs/dsh-contract.md)、[能力矩阵](docs/capability-matrix.md)和[质量流程](docs/quality.md)；不要把某次改动记录追加到这些规范。

## 修改前

1. 阅读 `README.md`、`docs/quality.md` 和目标能力对应的矩阵行。
2. 阅读目标文件中完整的 `TODO`/`unimplemented` 要求；它们是验收条件，不能为了通过测试而删除。
3. 按目标 DSH 版本在固定 tag/commit 的真实接口源码、事件和工具目录核对契约。历史 Host API 固定提交只适用于对应家族，不能拿它猜新版 Remote；来源见 `docs/dsh-contract.md`。
4. 每次只选一个可验证的垂直切片，并检查 Domain、Adapter、Application、Extension/Protocol、Webview 和测试中确有需要的层。
5. 先检查工作区状态。保留用户未提交内容、`.codegraph/` 和无关本地产物。

## 绝对禁止

- Webview 直接 fetch DSH，或接收 endpoint、PID、Cookie、API key、Secret、绝对路径及原始诊断正文。
- Domain 引入 VS Code、React、HTTP、子进程或平台 API；DSH Adapter 调用 `vscode.*`；上游 wire 类型向 Application/Webview 泄漏。
- 解析 TUI/ANSI，或从模型文本猜测工具、审批、Goal、Job、Workflow 等状态。
- `auto` 发现完成前启动 DSH；停止、重启、kill 或接管外部 DSH；仅凭 PID 推断进程所有权。
- 扫描任意端口范围，连接非验证 loopback 目标，或使用 shell 拼接子进程命令。
- 硬编码 Provider、Model、Skill、Plugin、动态命令或第三方工具清单。
- 删除 TODO 验收条件、弱化严格类型、跳过错误分支，或把自动测试冒充真实运行验证。
- 提交 `DSH_VSCODE_IMPLEMENTATION_PLAN.md`、`LOCAL_*.md`、真实凭据、用户路径、构建产物或 `.vsix`。

## 实现顺序与完成条件

先定 Domain 与仓储接口；用脱敏 fixture 写 Adapter 契约测试使缺口可见；实现目标版本 mapper/RPC/错误；再接 Application、Host route 与协议 schema；最后完成 Webview 状态、组件及可访问性测试。新 DSH 大版本在 `packages/dsh-adapter/src/versions/<version>/` 建独立入口，版本判断不散落到 UI 或用例。

移除一个 `unimplemented` 调用，必须同时覆盖原 TODO 的每项行为、适用的成功/业务错误/协议错误/超时/取消/畸形响应/资源释放测试，更新矩阵状态与证据，执行 `pnpm check && pnpm build`。涉及真实 DSH 的核心能力还需记录目标版本、平台、步骤和结果；缺少现场证据时维持 `PARTIAL`，不能标 `DONE`。

Secret 只经 VS Code 密码输入或 SecretStorage 由 Extension Host 处理；Webview 只显示 configured/missing。日志采用 allowlist，prompt、body、response、工具输入输出、key、token、authorization、secret 和 password 默认脱敏。附件、导出和文件选择通过用户操作及 Host 的 VS Code API 完成。

交付前检查：

```powershell
pnpm check
pnpm build
git diff --check
git status --short
```

不要自动 commit、push 或发布，除非当前用户明确要求。
