# Developer documentation

Start with [Contributing in English](../.github/CONTRIBUTING.md) or [中文贡献指南](../.github/CONTRIBUTING.zh-CN.md) for setup, development and PR submission.

## Find a document

| Topic                                       | English                                                         | 简体中文                                     |
| ------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------- |
| Development and PRs                         | [Contributing](../.github/CONTRIBUTING.md)                      | [贡献指南](../.github/CONTRIBUTING.zh-CN.md) |
| Architecture, protocols and trust           | [Architecture overview](architecture.en.md)                     | [详细架构规范](architecture.md)              |
| Exact DSH versions and interfaces           | [Upstream contract](dsh-contract.en.md)                         | [上游契约](dsh-contract.md)                  |
| Supported features and limits               | [Capability matrix](capability-matrix.en.md)                    | [能力矩阵](capability-matrix.md)             |
| Automated tests, manual checks and releases | [Testing guide](quality.md)                                     | —                                            |
| Layout, styles, motion and accessibility    | [UI specification](ui.md)                                       | —                                            |
| DSH-side editor tools                       | [Companion guide](../packages/dsh-editor-bridge/README.md)      | —                                            |
| Agent instructions                          | [AGENTS.md](../AGENTS.md); [CLAUDE.md](../CLAUDE.md) imports it | —                                            |
| Bug reports and diagnostics                 | [Support](../apps/extension/SUPPORT.md)                         | Chinese reports are welcome                  |
| Vulnerability reports                       | [Security policy](../.github/SECURITY.md)                       | 中文说明在同一文件中                         |

The English architecture overview covers components, interfaces and key flows; the Chinese specification records detailed implementation limits. The contract and capability matrix have complete English and Chinese versions. The other developer guides use English; contribution instructions are available in both languages.

## Update the right file

Keep version lists and interface details in the contract, capability scope/status in the matrix, and test commands in the testing guide. Update both languages of a document together, including technical limits, examples and links. Keep shared agent rules in `AGENTS.md`; `CLAUDE.md` imports them.

User instructions are in the [English README](../README.md), [中文 README](../README.zh-CN.md) and [Marketplace description](../apps/extension/README.md). Update the relevant guides when behaviour changes. Release notes live in the [extension changelog](../apps/extension/CHANGELOG.md), linked by the [root changelog](../CHANGELOG.md). Licence terms are in [LICENSE](../LICENSE).

Put test results and run logs in PRs or release records.

## Check documentation

Run `pnpm docs:check`, `pnpm format:check` and `git diff --check` for documentation changes. The documentation checker verifies local file links, document ownership, version facts against code, capability IDs/statuses, and translation consistency for navigation, commands and pinned sources. `pnpm check` also runs it.

Read the changed instructions and follow their links. Check heading anchors, translations and command prerequisites manually; automated consistency checks cannot verify the meaning of a translation. Test installation and reporting links when changing those instructions. The [testing guide](quality.md#choose-validation-by-change) lists any additional checks for documentation tooling.
