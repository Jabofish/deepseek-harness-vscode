# DSH 上游契约基线与兼容策略

## 当前上游版本

| 项目          | 固定值                                      |
| ------------- | ------------------------------------------- |
| npm CLI       | `@deepseek-ai/dsh@0.1.0-rc.8`               |
| API package   | `@deepseek-ai/dsh-host-apiproxy@0.1.0-rc.8` |
| 源码提交      | `141eb6fef83422698aef7a981029e843e8161534`  |
| Node 最低版本 | `22.19.0`                                   |

权威入口：

- [官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [rc.8 RPC Map](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/host/apiproxy/src/api/rpc-map.ts)
- [rc.8 Event Contract](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/host/apiproxy/src/api/events.ts)
- [rc.8 Tool Catalog](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/docs/tool-catalog.md)
- [rc.8 CLI/Profile Reference](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/apps/cli/reference/README.md)

## 支持范围

| DSH 版本             | 适配方式       | 兼容说明                                                                              |
| -------------------- | -------------- | ------------------------------------------------------------------------------------- |
| `0.1.0-rc.6`         | `versions/rc6` | 固定基线；允许旧 Host 在 `host.describe` 中不返回 `home`。                            |
| `0.1.0-rc.7`         | `versions/rc7` | 复用 rc.6 wire mapper，保留明确的版本身份。                                           |
| `0.1.0-rc.8`         | `versions/rc8` | 当前上游；支持 `home`、`imageLimits.maxImageDimension`、中断回复和 Agent Teams 事件。 |
| 任意非空未知版本标签 | rc.6 fallback  | 先完成通用握手，再以基础功能兼容模式连接并显示警告；版本特有字段只在安全识别后使用。  |

rc.6 与 rc.7 的 `rpc-map`/事件外壳仍可由 rc.6 mapper 处理。rc.8 的生成 Host schema 将 `host.describe.home` 设为必填，因此握手请求在 Extension Host 内按通用 RPC envelope 读取，再由版本 Adapter 检查字段，避免新 schema 把旧 Host 拒绝。`imageLimits` 投影和四类 Agent Teams durable event 使用宽事件/投影入口；旧版本缺少它们时会自然降级为无投影或未知事件。

## 主通道决策

主通道是 `dsh --profile web` 的 Web Host API 与 Host/Mux 事件，不是 ACP，也不是从 CLI stdout 解析状态。ACP/SDK 在会话恢复/列表/分叉、图片、推理、工具活动、计划、标题、设置和完整 UI 交互方面并不等价，不能满足本项目能力矩阵。

rc.6 的 `host.describe.version` 是 Host 应用版本，不是独立的协议版本；实际运行中它可以与 CLI npm 版本不同。因此 Probe 以固定 Host API 成功和非空 Host 版本建立兼容性，优先选择带运行时版本提示的 rc.8/rc.7/rc.6 Adapter。未知运行时不在启动前被版本号拦截；握手成功后使用 rc.6 fallback，并把兼容性警告传到 Webview。未来若出现独立协议协商，必须新增版本 Adapter。

## 实现契约的固定流程

每个 Repository 方法必须按以下步骤实现：

1. 在固定 `rpc-map.ts` 找到唯一真实方法名和输入/输出类型。
2. 在对应的 `versions/<version>` 定义版本入口、wire schema/mapper；不要把上游类型 re-export 到 Domain。
3. 录制或手工构造脱敏成功、业务错误、协议错误和畸形响应 fixture。
4. 在 Loopback client 加入 timeout/AbortSignal；只对明确幂等的瞬时故障重试。
5. 映射为稳定 `AppErrorCode`；未知错误保留 cause 供脱敏诊断，但不发原 body 到 Webview。
6. 如果固定源码和 npm 包不一致，以实际 pinned npm package + 官方同版本 tag/commit 为准并记录差异；不要猜。

## 必须审计的能力域

- Workspace 与目录；
- Session CRUD、历史、分页、搜索、分叉、归档；
- Prompt、Queue、Steer、Cancel、附件；
- Provider、Model、Reasoning、Preset、Tools、Permission、Plan、Agent Teams；
- Image attachment admission、尺寸/像素限制与模型图像能力错误；
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

1. 新增 `versions/<new-version>` Adapter 和契约 fixture；可复用未改变的 mapper，但必须保留版本入口。
2. 在 Probe 中按真实协议协商或受控运行时提示选择 Adapter；不要把 Host 应用版本误当成协议版本。
3. Domain/Protocol 只有真实产品语义改变时才更新；未知字段必须走安全 generic/unknown 降级。
4. 每次升级都保留 rc.6 回归，并至少完成当前版本的握手、事件和真实 DSH smoke；未知版本必须验证只显示警告且不阻断打开插件。
