# 贡献指南

## 变更粒度

每个变更只完成一个可测试的能力切片。避免“先把所有 UI 写完”或“先把所有 RPC 写完”，因为这会制造
无法验证的半成品。实现规则与验收条件见 [AGENTS.md](AGENTS.md)；新切片的计划方式见
[docs/implementation-order.md](docs/implementation-order.md)。

推荐提交格式：

```text
feat(connection): attach to an existing rc6 backend
test(adapter): cover malformed session history frames
docs(capabilities): record live model-switch verification
```

## 开发环境

要求 Node.js `>=22.19 <27` 和 pnpm `11.19`（由根 `packageManager` 固定）。环境配置、调试和真实
DSH 联调见 [docs/development.md](docs/development.md)。

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm check   # format + lint + typecheck + tests
pnpm build
```

## 提交与门禁

- 每次修改聚焦一个位置；垂直切片完成后运行 `pnpm check && pnpm build`，门禁全绿才算交付。
- 不自动 commit、push 或发布，除非维护者明确要求。
- 禁止提交构建产物、`.vsix`、真实凭据、用户路径、`DSH_VSCODE_*PLAN*.md` 和 `LOCAL_*.md`。

## Pull Request 必填证据

- 对应 `docs/capability-matrix.md` 行和状态变化；
- 使用的上游 RPC/Event 固定链接（见 [docs/dsh-contract.md](docs/dsh-contract.md)）；
- 新增或更新的测试；
- `pnpm check` 与 `pnpm build` 结果；
- 若涉及真实 DSH：版本、平台、复现步骤和实际结果；
- 若涉及 UI：窄视图、键盘、亮色/暗色与高对比度检查。

## 文档联动

- 面向用户的能力或行为变化：同步 `apps/extension/CHANGELOG.md`，必要时同步 `README.md` 与
  `README.zh-CN.md`（两份内容保持平行）。
- 面向开发者的契约、架构或流程变化：同步 `docs/` 下对应文档及其
  [索引](docs/README.md)。

## 文档语言约定

- `README.md` 使用英文，`README.zh-CN.md` 使用简体中文，两份内容平行；一个文件只写一种语言。
- `apps/extension/README.md` 是 VS Code Marketplace 的 listing，使用英文。
- `docs/` 与 `AGENTS.md` 面向贡献者，使用中文。

## 兼容策略

当前承诺已发布的 DSH `0.1.0-rc.6` 至 `0.1.1-rc.2`；未发布的 `0.1.2-alpha.1` 只保留源码级预适配，
不作为安装默认。连接到其他版本时必须显示警告并降级到对应版本 Adapter，禁止静默继续。
