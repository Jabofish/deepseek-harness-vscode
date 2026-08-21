# 开发环境

## 版本

- Node.js：`>=22.19.0 <27`，CI 使用 `22.19.0` 和 `24`。
- pnpm：`11.19.0`，由根 `packageManager` 固定。
- VS Code：扩展 `engines.vscode` 为 `^1.125.0`。
- DSH：`0.1.0-rc.6` 至 `0.1.1-rc.2`；任何非空未知版本标签会走兼容降级；真实联调前用 `dsh --version` 确认。

## 首次安装

```powershell
corepack enable
pnpm --version
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

如果 Node 低于 22.19，先升级 Node；不要关闭 engine 检查来掩盖 DSH 自身最低版本要求。

## 调试

1. 用 VS Code 打开仓库根目录。
2. 运行任务 `build` 或执行 `pnpm build`。
3. 按 `F5`，选择 `Run DSH VS Code Extension`。
4. 新 Extension Development Host 使用 `.test-workspace`，不会把测试文件混入仓库。
5. 修改 Webview 时使用 `pnpm dev`；Vite 输出固定文件到 `apps/extension/media`，该目录不提交。

当前激活已经进入连接/Runtime Missing/会话基础切片；仍请以能力矩阵和门禁结果判断可用范围，不要把成功激活视为所有能力完成。

## DSH 联调模式

### 复用外部实例

1. 由开发者自行启动 `dsh --profile web`。
2. 把端口加入 `dsh.connection.attachPorts` 或使用实现后的进程发现。
3. 选择 `auto` 或 `attach-only`。
4. 验证日志显示 `ownership=external`，扩展关闭后 DSH 仍在运行。

### 指定现有服务端点

在设置的 DSH 连接中选择“自定义端点”，填写 `http://127.0.0.1:<port>` 或
`http://localhost:<port>`，然后应用并重新连接。该模式只探测这个端点；它不会扫描其它端口，
也不会自动启动 DSH。端点只在 Extension Host 内使用，Webview 只知道是否已配置。

### 受管实例

1. 选择 `new-isolated`，或 `auto` 且确认没有可连接实例。
2. `dsh.connection.managedPort=0` 使用随机空闲端口；固定端口用于可预测调试。
3. 验证命令固定为参数数组 `--profile web --no-open --host 127.0.0.1 --port <n>`，避免受管 DSH 把系统浏览器当成启动界面。
4. 扩展关闭后只结束本次扩展创建的进程。

## Remote SSH/WSL/Dev Container

`extensionKind: ["workspace"]` 使 Extension Host 和 DSH 位于工作区一侧，Webview 仍显示在本地。所有 PATH、npm global、进程、端口和文件选择逻辑必须使用 Extension Host 所在平台，不能使用本地 Renderer 平台假设。

## 依赖升级

- 普通工具依赖：单独 PR，运行三平台 CI 和 VSIX 构建。
- DSH 依赖：必须遵循 `docs/dsh-contract.md` 版本升级流程。
- 不允许 `latest`、`^` 或 `~` 浮动版本；本仓库使用精确版本和 lockfile。
