# 文档索引

本目录是开发者文档的唯一入口。使用者文档见仓库根目录的
[README.md](../README.md)（英文）与 [README.zh-CN.md](../README.zh-CN.md)（中文）。

## 新贡献者阅读顺序

1. [README](../README.md) — 了解产品定位与安装方式；
2. [AGENTS.md](../AGENTS.md) — 代理操作规范（强制约束，不是建议）；
3. [implementation-order.md](implementation-order.md) — 实施阶段与退出条件；
4. [capability-matrix.md](capability-matrix.md) — 当前什么已完成、还缺什么证据；
5. 按切片需要查阅 dsh-contract / architecture / protocol / security / testing。

## 文档清单

| 文档                                               | 用途                                                                      | 何时读                       |
| -------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| [implementation-order.md](implementation-order.md) | 六个实施阶段、任务模板与退出条件                                          | 计划任何新切片之前           |
| [capability-matrix.md](capability-matrix.md)       | 功能状态与证据的唯一清单（代码/自动测试/live）                            | 判断完成度、更新证据时       |
| [dsh-contract.md](dsh-contract.md)                 | 上游 DSH 固定契约、支持范围、启动契约与升级流程                           | 改动 Adapter 或升级上游前    |
| [architecture.md](architecture.md)                 | 运行时结构、包依赖方向、连接状态机、进程所有权                            | 新增组件或跨层改动前         |
| [protocol.md](protocol.md)                         | Extension Host ↔ Webview 消息协议与流量控制                               | 改 Webview、路由或 Schema 前 |
| [security.md](security.md)                         | 信任模型、强制控制与诊断字段 allowlist                                    | 涉及凭据/路径/进程/网络时    |
| [testing.md](testing.md)                           | 测试层次、必测负面路径、fixture 规则、性能预算                            | 编写测试之前                 |
| [motion.md](motion.md)                             | Webview 动效 token、keyframes、Reduced Motion 与性能规则                  | 修改动效或新增交互过渡时     |
| [development.md](development.md)                   | 环境版本、调试、DSH 联调模式、依赖升级                                    | 配置环境或联调 DSH 时        |
| [release-checklist.md](release-checklist.md)       | 发布前必须满足的全部条目                                                  | 发版之前                     |
| [adr/](adr/)                                       | 已接受的架构决策（主通道、进程所有权、侧栏、版本化 Adapter、Secret 边界） | 做相关架构选择时             |

## 仓库级文档

- [AGENTS.md](../AGENTS.md) — 代理操作规范（强制）；
- [CONTRIBUTING.md](../CONTRIBUTING.md) — 贡献流程、门禁与文档联动；
- [CHANGELOG.md](../CHANGELOG.md) → [apps/extension/CHANGELOG.md](../apps/extension/CHANGELOG.md) —
  版本变更记录（唯一事实来源）；
- [tests/vscode-e2e/README.md](../tests/vscode-e2e/README.md) — 端到端套件的运行方式；
- [.github/SECURITY.md](../.github/SECURITY.md) — 漏洞报告渠道。

## 维护约定

- 修改功能状态只更新 `capability-matrix.md`，不要在其他文档复制状态表；
- `capability-matrix.md` 只保留当前状态、完成条件和最短证据入口，不追加按日期排列的审计记录、缺陷流水或原始运行输出；
- 修改版本兼容信息时，同步检查 `README.md`、`README.zh-CN.md`、`apps/extension/README.md`、
  `docs/dsh-contract.md` 和 `docs/release-checklist.md`，避免互相矛盾；
- 新增 ADR 使用 `adr/` 的现有编号格式，状态只能是 Accepted / Superseded。
