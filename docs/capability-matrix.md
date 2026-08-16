# 能力矩阵

这是功能范围的唯一清单。初始状态全部为 `TODO`。只有代码、自动测试和需要的真实 DSH 验证都完成后才能标 `DONE`；只完成部分时标 `PARTIAL` 并在证据列说明。

| ID    | 能力与验收范围                                                     | 主要代码位置                                                           | 最低测试证据                        | 状态 |
| ----- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------- | ---- |
| RT-01 | Runtime 定位：配置路径、PATH、npm global、版本兼容、Windows `.cmd` | `apps/extension/src/backend/runtime-locator.ts`                        | Windows/Linux/macOS + 超时/畸形版本 | TODO |
| RT-02 | 缺失 DSH：底部安装提示、复制命令、选择路径、重试、文档；不自动安装 | `features/runtime/RuntimeMissingView.tsx`, `vscode/install-runtime.ts` | E2E 点击/取消/失败/成功             | TODO |
| CN-01 | `auto` 先发现再启动，健康候选逐个回退，并发连接合并                | `application/.../dsh-connection-coordinator.ts`                        | spawn=0 attach 测试 + 竞态测试      | TODO |
| CN-02 | `attach-only` 绝不启动；`new-isolated` 只创建一个受管实例          | 同上                                                                   | 三种模式集成测试                    | TODO |
| CN-03 | 自定义端口、端口 0、配置/Known/默认/OS/companion 发现、无宽泛扫描  | `extension/src/backend/discovery/*`                                    | Provider 单测 + 跨平台集成          | TODO |
| CN-04 | 外部/受管所有权：只停止当前扩展创建并持有句柄的子进程              | `process-supervisor.ts`, coordinator                                   | 外部进程存活 + managed 退出         | TODO |
| CN-05 | 断线恢复、事件续接、历史补洞、无重复事件                           | `dsh-adapter/stream-controller.ts`                                     | 断流/乱序/重复/补洞 fixture         | TODO |
| VS-01 | Activity Bar View、可拖 Secondary Side Bar、一次性右栏引导         | `apps/extension/package.json`, `secondary-sidebar.ts`                  | VS Code E2E + 布局说明              | TODO |
| WS-01 | Workspace 列表/创建/重命名/删除/排序/目录选择、多根工作区          | Workspace repo + `SessionDrawer.tsx`                                   | 多根工作区 E2E                      | TODO |
| SS-01 | Session 新建/列表/分页/历史/搜索/重命名/分叉/归档/删除/恢复        | Session repo/use case/drawer                                           | 冷启动恢复 + 全 CRUD                | TODO |
| CV-01 | 文本流、推理、工具、错误、重试、标题、统计和历史回放               | rc6 mapper + timeline + `Timeline.tsx`                                 | 确定性回放 + 实际会话               | TODO |
| IN-01 | Composer 文本、IME、发送/停止、运行状态                            | `features/composer/Composer.tsx`                                       | 键盘/IME/重复提交 E2E               | TODO |
| IN-02 | Queue/Steer、队列查看/编辑/删除/转 Steer、取消                     | Session repo + `features/input/QueuePanel.tsx`                         | 运行中操作集成/E2E                  | TODO |
| AT-01 | 图片/文件粘贴、拖放、选择、预览、持久化、历史读取、限制            | `features/attachments/*`, Extension file boundary                      | PNG/JPEG/WebP/GIF/尺寸/取消         | TODO |
| MD-01 | 动态 Provider/Model/Reasoning 发现、选择、不可用状态、每会话应用   | Model repo + `features/models/*`                                       | 自定义 Provider + 切换后请求        | TODO |
| AG-01 | standard/code/minimal/cordis/用户 Preset、Tools native/code/both   | session config + picker/settings                                       | 每会话配置契约 + live               | TODO |
| PM-01 | read-only/workspace-write/full-access/custom 权限与 DSH 审批一致   | session config + ApprovalCard                                          | 不绕过审批 + 单次响应               | TODO |
| PL-01 | Plan Mode、Goal 生命周期、Todo、恢复一致                           | Goal repo + `GoalTodoStrip.tsx`                                        | 事件回放 + 重连快照                 | TODO |
| IQ-01 | DSH User Question 单选/多选/自由文本、过期恢复                     | Interaction repo + UserQuestionCard                                    | 各输入类型 + 重复响应               | TODO |
| JB-01 | Jobs 列表/输出/进度/完成通知/停止                                  | Job repo + JobsDrawer                                                  | 后台 Shell/子代理 + cancel          | TODO |
| SA-01 | Subagent 树/历史/Follow-up/Interrupt/父子路由                      | Subagent repo + SubagentDrawer                                         | continuable/one-shot + stale        | TODO |
| WF-01 | Workflow/Ralph 列表、阶段、启动、完成/失败/取消                    | Workflow repo + WorkflowDrawer                                         | 全状态事件 fixture + live           | TODO |
| SK-01 | Skills 项目/用户/插件发现、优先级显示、刷新、执行                  | Skill repo + SkillPicker                                               | 来源优先级 + 执行                   | TODO |
| CM-01 | 动态命令、`/plan`、`/goal`、`/compact`、`/feedback`、参数提示      | Command repo + CommandPalette                                          | 未知命令不发送模型                  | TODO |
| ST-01 | DSH Settings Schema、读取、更新、替换、live/restart 语义           | Settings repo + SettingsDrawer                                         | Schema fixture + rollback           | TODO |
| ST-02 | Provider Secret：仅密码输入/DSH 凭据 API，UI 只见状态              | Credential repo + credential-input                                     | 日志/协议/状态无 Secret             | TODO |
| PG-01 | Plugin Inventory、能力、显式配置、重连/重启提示、未知插件降级      | Plugin repo + PluginInventory                                          | 未知插件/外部进程不重启             | TODO |
| TL-01 | 通用 Tool Card + Shell/Edit/Search/LSP/MCP 等专用可插拔 Renderer   | UI registry + rc6 tool mapping                                         | 官方 tool catalog fixture           | TODO |
| EX-01 | Markdown/JSON/ZIP 会话与附件流式导出、取消和安全路径               | Export repo + ExportDialog                                             | 大会话/Zip Slip/取消/覆盖           | TODO |
| UX-01 | 草稿、上次会话恢复、Quick Pick、通知、错误恢复；不自动发消息       | Webview store + VS Code commands                                       | Reload E2E                          | TODO |
| PF-01 | 单流共享、批量 Delta、虚拟列表、缓存失效、资源释放                 | stream/timeline/store                                                  | 性能基准 + heap/handle 检查         | TODO |
| SC-01 | Loopback、CSP、Schema 校验、无 shell、日志脱敏、Workspace Trust    | Extension/Protocol/diagnostics                                         | 安全负面测试                        | TODO |
| AX-01 | 键盘、焦点、屏幕阅读器、亮暗/高对比、240px、Reduced Motion         | UI/Webview                                                             | axe/manual matrix                   | TODO |
| RL-01 | CI 三平台、VSIX、版本/隐私/许可证/升级/回滚                        | workflow/release docs                                                  | clean checkout CI + install         | TODO |

## 可选 DSH 能力的处理

MCP、LSP、Schedule、Terminal、Session Query、E2B、Cordis 动态工具等可能未在默认 Web Profile 启用。扩展应通过 Plugin Inventory、Settings Schema、动态命令和通用 Tool Card 发现与降级；不得为了“功能完整”擅自启用高权限插件。
