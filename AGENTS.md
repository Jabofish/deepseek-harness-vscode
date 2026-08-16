# 实现代理操作规范

本仓库会交给编码能力尚可、工程规划能力有限的模型逐步实现。以下规则是强制约束，不是建议。

## 开始任何代码修改前

1. 阅读 `README.md`、`docs/implementation-order.md` 和当前能力对应的 `docs/capability-matrix.md` 行。
2. 阅读目标文件中完整的 `TODO`/`unimplemented` 要求；这些要求就是该函数的验收条件。
3. 在 DSH 固定提交 `47f943859bef60e4160492346772ded9b24f765a` 的 `rpc-map.ts`、`events.ts` 和工具目录中确认真实契约。禁止凭函数名或 UI 猜 RPC。
4. 只选择一个可验证的垂直切片；同时修改 Domain、Adapter、Application、Extension/Webview 和测试中确有需要的层。

## 绝对禁止

- 不得让 Webview 直接 `fetch` DSH，不得把 endpoint、pid、API key 或 Secret 发送到 Webview。
- 不得在 `domain` 引入 VS Code、React、HTTP、Node 子进程或平台 API。
- 不得在 `dsh-adapter` 调用 `vscode.*`。
- 不得解析 TUI/ANSI 文本或从模型文本猜测工具、审批、Goal、Job、Workflow 状态。
- 不得在自动连接发现完毕前启动 DSH。
- 不得停止、重启、kill 或接管外部 DSH；只有当前扩展创建并持有句柄的进程可以在释放时停止。
- 不得扫描任意端口范围；候选只能来自设置、已知实例、官方默认、受校验的 companion registry 或受限进程发现。
- 不得硬编码 Provider、Model、Skill、Plugin、动态命令或第三方工具清单。
- 不得为了让测试变绿而删除 TODO 验收条件、弱化严格类型或跳过错误分支。
- 不得提交 `DSH_VSCODE_IMPLEMENTATION_PLAN.md`、`LOCAL_*.md`、真实凭据、用户路径、构建产物或 `.vsix`。

## TODO 的完成规则

删除一个 `unimplemented` 调用前必须同时做到：

1. 按上游固定版本实现真实行为；
2. 覆盖 TODO 数组中的每条要求；
3. 添加成功、错误、超时、取消、畸形响应和资源释放测试中适用的部分；
4. 更新 `docs/capability-matrix.md` 状态和证据；
5. 执行 `pnpm check && pnpm build`；
6. 涉及真实 DSH 的能力还要记录一次可复现的运行验证。

“已实现”必须区分三个证据等级：代码存在、自动测试通过、真实 DSH 运行验证通过。只有三者都完成的高风险/核心能力才能标为 `DONE`。

## 代码与依赖方向

```text
apps/extension -> application + dsh-adapter + webview-protocol
application    -> domain
dsh-adapter    -> application ports + domain + pinned upstream contract
apps/webview   -> domain DTO + timeline + ui + webview-protocol
timeline       -> domain
ui             -> domain + React
domain         -> nothing platform-specific
```

保持文件职责窄小。新增 DSH 大版本时建立 `packages/dsh-adapter/src/versions/<version>/`，不要在组件和用例中散落版本判断。

## 每个垂直切片的固定顺序

1. 先补充或确认 Domain 类型与仓储接口。
2. 用脱敏 fixture 写 Adapter 契约测试，使测试先失败。
3. 实现 rc.6 mapper、RPC 和错误映射。
4. 实现 Application use case；禁止向上泄漏上游类型。
5. 实现 Extension message route 和协议 schema。
6. 最后实现 Webview 组件、状态和可访问性测试。
7. 运行全部门禁，不只运行单文件测试。

## 安全和日志

- 凭据输入使用 VS Code `showInputBox({ password: true })` 或 SecretStorage；Webview 只收到“已配置/缺失”。
- 日志采用 allowlist；字段名包含 key、token、authorization、secret、password、prompt、body、response 时默认移除。
- 网络目标必须是 `127.0.0.1`/`localhost` 且端口已验证。
- 子进程必须直接 spawn 固定 executable 与参数数组，不使用 shell。
- 导出、附件和文件选择必须由 Extension Host 经用户授权的 VS Code API 完成。

## 交付前检查

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git status --short
```

不要自动 commit、push 或发布，除非当前用户明确要求。
