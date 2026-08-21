# ADR 0004：所有 DSH 上游变化隔离在版本化 Adapter

- 状态：Accepted
- 日期：2026-08-16

## 决策

当前适配 `0.1.0-rc.6` 至 `0.1.1-rc.2`。Probe 选择具体版本 Adapter；rc.6 wire schema、方法名和 mapper 只能存在于 `packages/dsh-adapter/src/versions/rc6` 或对应 Repository，新增版本使用独立目录入口。

## 后果

Domain/Application/Webview Protocol 不依赖上游类。升级通过新增 Adapter 和契约 fixture 完成；未知版本先完成通用握手并以 rc.6 基础能力降级，界面显示警告，版本特有字段不能 best-effort 猜测。
