# Contributing

[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

We welcome fixes, documentation, translations and tests. Issues and PRs can use English or Chinese. Include a small reproduction for a bug, or a before/after example for a behaviour change. Small documentation fixes can go straight to a PR.

## Before you start

- Check existing issues and PRs. Discuss substantial features or architecture changes in an issue before implementing them.
- Read the [architecture specification](../docs/architecture.en.md), relevant [capability matrix](../docs/capability-matrix.en.md) row and [testing guide](../docs/quality.md). Use the [documentation index](../docs/README.md) to find other topics and their available languages.
- For upstream integration, use the exact tag/commit and real interface sources in the [DSH contract](../docs/dsh-contract.en.md). Do not infer RPCs or capabilities from UI labels or model output.
- Report vulnerabilities through the [security policy](SECURITY.md), without disclosing sensitive data in public issues.

## Set up a checkout

Use a Node version supported by the root [package.json](../package.json) and the pnpm version in its `packageManager` field. If Corepack is available, `corepack enable` enables its shim; otherwise install that declared pnpm version. Check `node --version` and `pnpm --version` before installing dependencies. The VS Code minimum is in [the extension manifest](../apps/extension/package.json).

Fork the repository if you do not have write access. Replace `YOUR-ACCOUNT` with the fork owner. These commands work in PowerShell and POSIX shells:

```sh
git clone https://github.com/YOUR-ACCOUNT/deepseek-harness-vscode.git
cd deepseek-harness-vscode
git remote add upstream https://github.com/Jabofish/deepseek-harness-vscode.git
git fetch upstream main
git switch -c my-change upstream/main
pnpm install --frozen-lockfile
pnpm build
node -e "require('node:fs').mkdirSync('.test-workspace', {recursive: true})"
```

In an existing checkout, use its actual remotes and preserve uncommitted work. Run pnpm commands from the repository root. Default automated tests use fixtures: they do not require a global DSH installation, model credentials or a live VS Code window.

## Find the right layer

| Location                                                           | Responsibility                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `apps/extension/`                                                  | VS Code APIs, process/file/network/credential ownership, Host routes and composition        |
| `apps/webview/`                                                    | React UI, view state and localised text                                                     |
| `packages/domain/`, `packages/application/`                        | Platform-independent types, rules, ports and use cases                                      |
| `packages/dsh-adapter/`                                            | Version-specific DSH handshake, RPC/event mapping and recovery                              |
| `packages/timeline/`, `packages/webview-protocol/`, `packages/ui/` | Immutable transcript reduction, safe Host/Webview DTOs and shared rendering components      |
| `packages/dsh-editor-bridge/`                                      | Optional companion bundle loaded inside DSH                                                 |
| `tests/`, `config/`, `scripts/`                                    | Cross-layer/live/Electron tests, shared test/TypeScript configuration and development tools |

Tests also live beside implementation files as `*.spec.ts` or `*.spec.tsx`. Follow nearby code and the repository's formatter/linter.

## Develop and test

Keep each PR focused on one observable change. Preserve layer and trust boundaries; [AGENTS.md](../AGENTS.md) is a compact implementation checklist for people and coding agents.

Open the repository root in VS Code, then select **Run JaboDSH Extension** in Run and Debug. F5 runs the configured build task and launches an Extension Development Host using the `.test-workspace/` directory created above; Ctrl+F5 runs without attaching the debugger. Open the **JaboDSH** view in that new window and connect to a development DSH to test the affected interaction. `pnpm dev` watches Webview and extension builds. Use disposable sessions and workspaces for interaction tests.

Choose checks from the [validation matrix](../docs/quality.md#choose-validation-by-change). During code work, `pnpm test:changed` runs affected tests plus fixed contracts; `pnpm test:contracts` runs those contracts alone. Before a code PR, run `pnpm check`, `pnpm build` and `git diff --check`. For documentation-only changes, use the documentation checks in that guide. Stress, native DSH and Electron checks are separate opt-in runs, used when the change affects those paths. Commands and manual scenarios are in the [testing guide](../docs/quality.md).

Keep Webview text in both `apps/webview/src/locales/en.json` and `zh.json`, rather than in components. Use `pnpm i18n add <key> "<English>" "<中文>"`, `pnpm i18n set <key> <en|zh> "<text>"`, `pnpm i18n remove <key>` and `pnpm i18n find <regex>`; `pnpm i18n:check` validates keys and placeholders.

## Open a pull request

1. Review `git diff` and `git status --short`. Commit only intended files; keep generated media, VSIX files, credentials, private paths, local plans and unrelated work out of the PR.
2. Push to your fork and open a PR against this repository's `main`. Draft PRs are welcome. Use the [PR template](PULL_REQUEST_TEMPLATE.md) in either language; remove sections that do not apply.
3. Explain the problem, resulting behaviour, issue/capability ID when applicable, and any compatibility impact. Use `Related to #...` when an issue should stay open; use closing keywords only when its acceptance is complete.
4. Include commands and results, relevant manual steps, environment/runtime versions and checks not run with reasons. Use the short [result format](../docs/quality.md#report-test-results). For visible changes, add redacted before/after screenshots or a short recording of the affected interaction.
5. Wait for required CI and address actionable review feedback. PR CI runs affected tests plus fixed contracts; `main` runs the full suite in shards. Builds run on Linux, Windows and macOS. Record native DSH and UI results separately when those checks apply.

Update the [extension changelog](../apps/extension/CHANGELOG.md) for user-visible behaviour. Keep English/Chinese READMEs and the Marketplace description consistent when their described behaviour changes. Update technical rules in the relevant document and record individual test results and limitations in the PR.

## Work with a coding agent

Have the agent read [AGENTS.md](../AGENTS.md) before editing. Provide the issue, expected behaviour, scope exclusions and desired delivery step. Shared project rules live in `AGENTS.md`; [CLAUDE.md](../CLAUDE.md) imports them for Claude Code. Point other tools at `AGENTS.md` if they do not load it themselves.

Before submitting, review the agent's diff, tests and evidence, check licensing and remove private data. The agent should list checks it could not run and follow the delivery steps authorised in the task.
