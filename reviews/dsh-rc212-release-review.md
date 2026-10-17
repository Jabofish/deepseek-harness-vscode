# rc.2 适配与交付检查

## 固定来源与范围

- 目标：`@deepseek-ai/dsh@0.2.1-rc.2`，tag `dsh-v0.2.1-rc.2`，提交 `687f282e8625c6b8d11ff58211a90524be2e4317`。
- 对照：rc.1 提交 `1600d8a1e140dcde43a1a0941940a0480712c011`。按固定 tag 比较所消费的 Connection / Gateway、API Remote、Session V4、Account、Plugin Manager 及工具源码，没有 wire 变更；Web service 的 provider 选择改为实时值，新增 Search / Fetch 实现和设置 namespace。
- npm 官方 registry 与镜像的精确包 integrity 相同：`sha512-tvY+yhfKRifthbqPe/OK0AYxM5ZkvqfYq/jMYgJcEUxiRRL1Vwra3Ti5TB6AXgSWQdiPHYh/Vp6SJa9yHwMNuw==`。现场运行使用独立安装、临时 home / workspace 和测试拥有的进程，不接管用户的 DSH。
- `rc212` 独立精确入口继承核对后的 rc.1；生产 registry、包导出、已知版本与隔离测试同时登记。未知 / 畸形版本不进入此入口，安装默认不因发布元数据变化而自动切换。
- Search / Fetch 配置沿用动态 Settings schema 和 CAS mutation；不向 Webview 提供密钥。模型展示改动属于上游可选 client slot，扩展保留目录原值和真实 route，不硬编码模型清单或临时标签。

## Issue 与 PR 审查

- [Issue #3](https://github.com/Jabofish/deepseek-harness-vscode/issues/3)：普通会话不得因缺省子代理字段而被误判为不可中断；停止请求必须经过真实 Store / 协议到达 Host。类同路径包括审批 / 提问期间停止、运行中模型与权限选择、可选模型目录失败、Workspace Trust 撤回和多个聊天表面。
- [PR #4](https://github.com/Jabofish/deepseek-harness-vscode/pull/4) 固定审查 head：`d7d9df5a814317954bff085898a3724f5e8e7b7c`。标题是复制修复，但相对 main 的 82 个文件还包含编辑器聊天表面。两部分均纳入审查，未凭标题或 CI 结果直接合并。
- 保留作者贡献的右键 / 键盘菜单复制语义：只复制所指的可读消息 Markdown；非空选区、输入控件、thought / tool / notice 内容和无可复制行保持原行为。回归覆盖 addressed-row 优先级、临时 textarea、失效 / 嵌套目标及不清空剪贴板。
- 多表面补强：请求 ID 按 surface 隔离，取消不能串扰；会话 ID 绑定由 Host 校验；关闭后的消息与 ready 队列释放；移动失败保留原窗口和错误，窗口恢复 / 复用 / 移交有回归。客户端命令目录由协议白名单生成，不授权任意命令执行。
- 不接纳“未被接受的拖放就打开编辑器”的推断：该结果同样可能来自用户按 Esc 取消，不能把取消解释为打开请求；保留明确菜单 / 按钮 / 命令和面板内重排，补齐取消和未接受 drop 回归。
- 完整设计计划属于审查材料，不进入产品交付。源文件和新增测试经过集成修正后交付，保留贡献归属。

## 验证与边界

交付前重新执行 `pnpm check`、`pnpm test:contracts`、`pnpm build`、隔离真实 rc.2 和差异检查。`pnpm check` 通过：354 个文件 / 3929 项测试通过，27 个文件 / 29 项环境条件场景跳过；格式、文档、i18n、lint、类型检查通过。`pnpm test:contracts` 的 19 个文件 / 309 项测试通过；`pnpm build` 和 `git diff --check` 通过。构建保留既有的大 chunk 提示；跳过场景不计入通过证据。

Windows 隔离真实 rc.2 smoke 已通过：独立精确安装、临时 home / workspace，验证 Search / Fetch 实时字段、两项 provider 选择的同 namespace 写入、count / sendOriginalQuestion 写入回读、非法 count 和过期修订拒绝、unset 恢复默认；另验证官方插件清单、V4 会话创建 / 打开 / 列表、空子代理、停止、归档往返、工作区重命名、可选服务空状态和进程退出后的端口关闭。没有模型或账号请求。首次与全量检查并行时启动超时，串行复测及最终完整运行通过；未扩大生产超时来掩盖该情况。

真实 VS Code Extension Host（内置 Node 24.21.0）的 managed E2E 通过：独立测试工作区与 DSH home、精确 rc.2 runtime、Host connect / reconnect、编辑器聊天命令登记、启动时无多余聊天标签、退出后测试清理。此运行不等于 Webview 全部视觉交互的人工验收。

复现命令（两个运行串行执行，runtime 与 VS Code 可执行文件必须显式选择；安装放在独立目录，不覆盖全局包）：

```powershell
$env:DSH_LIVE_SMOKE = '1'
$env:DSH_LIVE_RUNTIME_VERSION = '0.2.1-rc.2'
# DSH_LIVE_RUNTIME 指向独立安装的精确 rc.2 npm shim。
pnpm exec vitest run tests/live-dsh/rc211-surfaces.spec.ts
$env:DSH_VSCODE_E2E_MODE = 'managed'
$env:DSH_VSCODE_E2E_RUNTIME = $env:DSH_LIVE_RUNTIME
# DSH_VSCODE_E2E_EXECUTABLE 指向本机 VS Code 可执行文件。
node --experimental-strip-types tests/vscode-e2e/run.ts
```

UI 修复及既有渲染证据见[系统检查记录](dsh-rc211-adaptation-audit.md)。真实 VS Code 完整人工验收、付费模型搜索 / Fetch、账号登录及 timed 问答不由无模型 smoke 或 jsdom 测试代替；对应矩阵保持 `PARTIAL`。
