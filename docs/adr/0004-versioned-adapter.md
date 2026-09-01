# ADR 0004：所有 DSH 上游变化隔离在版本化 Adapter

- 状态：Accepted
- 日期：2026-08-16

## 决策

当前已发布适配 `0.1.0-rc.6` 至 `0.1.1-rc.2`，并为 `0.1.2-alpha.1` 源码及已发布的 `0.1.2-alpha.2`、`0.1.2-alpha.3` 保留独立版本入口。Probe 选择具体版本 Adapter；rc.6 wire schema、方法名和 mapper 只能存在于 `packages/dsh-adapter/src/versions/rc6` 或对应 Repository，alpha 的共用 `/api`/`remote.mux` 传输只能存在于 `packages/dsh-adapter/src/versions/alpha`，alpha.2/alpha.3 专属错误词汇和身份必须位于各自版本入口，新增版本使用独立目录入口。

## 后果

Domain/Application/Webview Protocol 不依赖上游类。升级通过新增 Adapter 和契约 fixture 完成；未知版本先完成通用握手，再按显式优先级使用最新已验证 Adapter 的只读兼容探测，界面显示警告并保留真实运行时版本。版本特有字段不能 best-effort 猜测；候选拒绝时继续尝试更旧的已验证 Adapter，全部失败才拒绝连接。
