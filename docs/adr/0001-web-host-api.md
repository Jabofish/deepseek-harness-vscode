# ADR 0001：以 DSH Web Host API 为主通道

- 状态：Accepted
- 日期：2026-08-16

## 决策

扩展通过 `dsh web` 暴露的 Web Host RPC 与 Host/Mux 事件实现完整产品能力。ACP/SDK 可作为未来辅助入口，但不得替代主通道；禁止解析 TUI/ANSI。

## 理由

完整需求包含会话列表/恢复/分叉、图片、推理、工具活动、计划、设置、审批、用户问题、Jobs、Goals、Subagents 等。ACP/SDK 当前能力面不足，终端输出也不是稳定机器契约。

## 后果

必须维护版本化 Adapter 和契约测试；收益是 UI 不依赖文本推断，能与 Web 能力对齐。
