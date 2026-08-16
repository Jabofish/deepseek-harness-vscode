# Contributing

## 变更粒度

每个变更只完成一个可测试的能力切片。避免“先把所有 UI 写完”或“先把所有 RPC 写完”，因为这会制造无法验证的半成品。

推荐提交格式：

```text
feat(connection): attach to an existing rc6 backend
test(adapter): cover malformed session history frames
docs(capabilities): record live model-switch verification
```

## Pull Request 必填证据

- 对应能力矩阵行和状态变化；
- 使用的上游 RPC/Event 固定链接；
- 新增或更新的测试；
- `pnpm check` 与 `pnpm build` 结果；
- 若涉及真实 DSH：版本、平台、复现步骤和实际结果；
- 若涉及 UI：窄视图、键盘、亮色/暗色与高对比度检查。

## 兼容策略

当前只承诺 DSH `0.1.0-rc.6`。连接到其他版本时必须明确拒绝或选择对应版本 Adapter，禁止静默继续。
