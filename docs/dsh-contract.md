# DSH 上游契约基线

## 固定版本

| 项目          | 固定值                                      |
| ------------- | ------------------------------------------- |
| npm CLI       | `@deepseek-ai/dsh@0.1.0-rc.6`               |
| API package   | `@deepseek-ai/dsh-host-apiproxy@0.1.0-rc.6` |
| 源码提交      | `47f943859bef60e4160492346772ded9b24f765a`  |
| Node 最低版本 | `22.19.0`                                   |

权威入口：

- [官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [固定提交 RPC Map](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/host/apiproxy/src/api/rpc-map.ts)
- [固定提交 Event Contract](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/host/apiproxy/src/api/events.ts)
- [固定提交 Tool Catalog](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/tool-catalog.md)
- [固定提交 CLI/Profile Reference](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/reference/README.md)

## 主通道决策

主通道是 `dsh web` 的 Web Host API 与 Host/Mux 事件，不是 ACP，也不是从 CLI stdout 解析状态。ACP/SDK 在会话恢复/列表/分叉、图片、推理、工具活动、计划、标题、设置和完整 UI 交互方面并不等价，不能满足本项目能力矩阵。

## 实现契约的固定流程

每个 Repository 方法必须按以下步骤实现：

1. 在固定 `rpc-map.ts` 找到唯一真实方法名和输入/输出类型。
2. 在 `versions/rc6` 定义 wire schema/mapper；不要把上游类型 re-export 到 Domain。
3. 录制或手工构造脱敏成功、业务错误、协议错误和畸形响应 fixture。
4. 在 Loopback client 加入 timeout/AbortSignal；只对明确幂等的瞬时故障重试。
5. 映射为稳定 `AppErrorCode`；未知错误保留 cause 供脱敏诊断，但不发原 body 到 Webview。
6. 如果固定源码和 npm 包不一致，以实际 pinned npm package + 官方同版本 tag/commit 为准并记录差异；不要猜。

## 必须审计的能力域

- Workspace 与目录；
- Session CRUD、历史、分页、搜索、分叉、归档；
- Prompt、Queue、Steer、Cancel、附件；
- Provider、Model、Reasoning、Preset、Tools、Permission、Plan；
- Settings Schema/read/update/replace 与 Secret；
- Permission/User Question；
- Host/Mux message/reasoning/tool/error/status/statistics/title events；
- Goal/Todo、Job、Subagent、Workflow/Ralph；
- Skill、动态命令、Plugin Inventory；
- Session/attachment export。

契约测试必须维护“实现使用的 RPC/Event 集合”和上游集合对比。上游新增项允许以 unknown/generic 降级，但测试要明确显示；上游删除或改形状必须失败。

## 事件恢复

每个 Session 保存最后提交的服务器序号。重连时：重新订阅 -> 比较服务端最后序号 -> 通过历史 RPC 补齐缺口 -> 去重后提交 reducer。事件不能仅靠时间戳排序；未知事件也要保留安全的类型/序号/摘要，避免后续已知事件丢失。

## 版本升级

1. 新增 `versions/<new-version>` Adapter 和契约 fixture。
2. 在 Probe 中按服务端报告版本选择 Adapter。
3. Domain/Protocol 只有真实产品语义改变时才更新。
4. 完成 rc.6 与新版本双版本测试后，才能修改支持范围。
