# 测试策略

## 层次

| 层          | 目标                                                                                                                                  | 禁止替代                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Contract    | `0.0.1-rc.1/.2/.5`、`0.1.0-rc.2/.3`、rc.6–0.1.2-rc.1、alpha.1–alpha.5、0.1.3-alpha.1/.2 与 0.1.5-alpha.1 RPC/Event/Tool 形状与 mapper | 不能只 mock Domain           |
| Unit        | 状态机、排序、去重、reducer、错误映射                                                                                                 | 不能靠 E2E 才发现竞态        |
| Integration | Fake DSH socket/server、spawn 依赖、重连/资源释放                                                                                     | 不能调用真实用户实例         |
| VS Code E2E | View、命令、设置、Webview 协议、焦点和布局                                                                                            | 不能只测 React DOM           |
| Live smoke  | 固定 DSH 版本真实运行                                                                                                                 | 不能声称自动测试等于真实兼容 |

## 必测负面路径

- 无 DSH、版本不兼容、连接拒绝、端口被非 DSH 服务占用；
- 候选 1 失败候选 2 成功、未知版本按优先级选择最新可安全复用 wire 的 Adapter、兼容探测全部拒绝、并发 connect、connect 中取消；
- 子进程早退、启动输出分段、端口占用、readiness 超时；
- RPC timeout、Abort、5xx、业务错误、畸形 JSON/Frame；
- 事件重复、乱序、缺口、重连、unknown event；
- 重复 Send、重复审批、过期问题、模型切换失败回滚；
- Secret/Prompt/Tool body 不出现在日志、协议、状态和 snapshot；
- Webview 恶意消息、超长字段、非法 id/path/port；
- 外部 DSH 在 disconnect/deactivate 后仍运行；
- 只清理测试自己创建的临时目录、fixture server 和子进程。

## Fixture 规则

- 只保留结构必需字段；名称、路径、Prompt、模型输出和 key 全部使用假值。
- 每个 fixture 标注上游 commit、文件和类型名。
- 未发布版本（如 alpha.1）的 fixture 必须同时标注源码 tag/commit，并在能力矩阵中注明尚无真实运行包证据；已发布预发行版本（如 `0.1.2-alpha.2`、`0.1.2-alpha.3`、`0.1.2-alpha.4`、`0.1.2-alpha.5`、`0.1.3-alpha.2`、`0.1.5-alpha.1`）也要记录 npm/tag/commit 与 live smoke 边界。
- `0.1.5-alpha.1` v3 fixture 必须覆盖严格事件 envelope、surface `startSeq/endSeq`、`system/message` 不向 Webview 透传、PTC 事件映射、assistant baseline 缺失和未知 ignorable 事件的 opaque metadata；旧 v0/v2 fixture 仍必须验证其原有字段边界。
- 大流量 fixture 由生成器产生，避免提交真实会话日志。
- 更新 DSH 依赖时先运行漂移测试，再更新 fixture；禁止直接更新 snapshot 接受未知差异。未知版本 fixture 必须覆盖真实版本标签保留、兼容模式警告、最新候选优先、候选拒绝后继续、全部候选拒绝和取消边界。
- `packages/dsh-adapter/test/adapter-chain.spec.ts` 必须随版本链变更维护，锁定每个已支持版本的连续继承、协议身份和兼容优先级；它不能替代各版本的 wire contract fixture。
- 当前历史版本 fixture 还必须锁定：rc.1 的旧 `command.*` 与 Host invalidation、rc.2 的 `session/tasks`/`host/remote-event`、rc.1/rc.2 的时区字段差异、rc.1 缺少 ZIP 下载和工作区排序，以及 rc.5/0.1.0-rc.2/.3 的 rc.6 Host wire 复用边界。

## 性能预算

发布前设立并在 CI/手工验证记录：

- 扩展激活不连接时不启动 DSH，不读取大目录；
- 一个连接只存在一个 Host/Mux 流；
- Delta 合批后 Webview 消息速率有上限；
- 10,000 个 Timeline 节点使用虚拟化，交互不依赖全量 DOM；
- 导出和附件不把完整大文件同时复制到多个 JS 堆；
- disconnect/deactivate 后无读循环、timer、socket、listener 或 child handle 泄漏。

具体阈值在有真实基线后写入测试，不能拍脑袋把无法验证的数字标为完成。
