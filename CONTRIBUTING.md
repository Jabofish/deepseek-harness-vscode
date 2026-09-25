# 贡献指南

每次改动只完成一个可验证的垂直切片。先读 [AGENTS.md](AGENTS.md)、[开发者文档](docs/README.md)和目标[能力矩阵](docs/capability-matrix.md)行。

[质量流程](docs/quality.md)规定实现顺序、fixture、负面路径、真实 DSH 与 VS Code 证据、PR 内容和发布门禁。[DSH 契约](docs/dsh-contract.md)是唯一列出精确上游版本的开发文档；不要在本指南或 PR 模板复制版本清单。

提交评审前运行 `pnpm check`、`pnpm build` 和 `git diff --check`。写清已经收集的证据与尚未验证的部分。用户可见变化写入[扩展更新日志](apps/extension/CHANGELOG.md)；规范变化直接修改所属文档，不追加实施日记。

`README.md` 使用英文，`README.zh-CN.md` 使用中文，Marketplace 说明 `apps/extension/README.md` 使用英文；三份用户说明的含义须保持一致。不得提交凭据、用户路径、本地计划、VSIX 或生成的 media。commit、push 和发布需要当前用户明确授权。
