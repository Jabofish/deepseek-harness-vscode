# ADR 0004：所有 DSH 上游变化隔离在版本化 Adapter

- 状态：Accepted
- 日期：2026-08-16

## 决策

当前已发布适配 `0.0.1-rc.1/.2/.5`、`0.1.0-rc.2/.3`、`0.1.0-rc.6` 至 `0.1.2-rc.1`、`0.1.2-alpha.2` 至 `0.1.2-alpha.5`、`0.1.3-alpha.2` 和 `0.1.5-alpha.1/.2/rc.1`，并为 `0.1.2-alpha.1`、`0.1.3-alpha.1` 源码保留独立版本入口。所有版本入口共享 `DshVersionAdapterBase` 的 identity/probe 结构，但按真实 wire 边界分为 legacy rc、alpha family v0、alpha13/alpha132 Session v2 与 alpha151/alpha152/rc151 Session v3 三组明确入口；legacy rc 内部再区分 `0.0.1-rc.1/.2` 的旧 command/frame wire 与 `0.0.1-rc.5`、`0.1.0-rc.2/.3` 的 rc.6 Host wire；`0.1.2-rc.1` 虽是 rc 发布号，实际浏览器 wire 仍沿 alpha.5，因此由 `versions/rc13` 明确复用 alpha.5 v0，而不会继承 `versions/alpha13` 的 v2。Probe 选择具体版本 Adapter；rc.6 wire schema、方法名和 mapper 只能存在于 `packages/dsh-adapter/src/versions/rc6` 或对应 Repository，alpha 的共用 `/api`/`remote.mux` 传输只能存在于 `packages/dsh-adapter/src/versions/alpha`，各版本专属错误/Session wire 和身份必须位于对应版本入口，新增版本不得跳过已核对的发布边界或跨 wire family 猜测。Session v3 的三个版本入口保留独立精确身份；未知版本不得兼容探测它们。

## 后果

Domain/Application/Webview Protocol 不依赖上游类。升级通过新增 Adapter 和契约 fixture 完成；版本入口只承载 identity 和真实变更，公共 probe/transport/backend 组装留在所属 family 基类。未知版本先完成通用握手，再按显式优先级使用最新可安全复用 wire 的 Adapter 进行只读兼容探测，界面显示警告并保留真实运行时版本。版本特有字段不能 best-effort 猜测；当前 `alpha13`/`alpha132` 的 Session v2 与 `alpha151`/`alpha152`/`rc151` 的 Session v3 只允许精确版本选择，alpha132 的 `delivery` 以及 alpha152/rc151 的新目录/交付事件只在其已核对的版本入口中启用，候选拒绝时继续尝试更旧的已验证 Adapter，全部失败才拒绝连接。
