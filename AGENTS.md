# Coding agent instructions

These rules apply throughout this repository. Follow the user's task and scope; do not turn a focused change into unrelated cleanup. Human onboarding: [English](.github/CONTRIBUTING.md) / [简体中文](.github/CONTRIBUTING.zh-CN.md). Keep shared agent rules here; `CLAUDE.md` only imports this file.

## Before editing

1. Check `git status --short --branch` and the diff. Preserve uncommitted work, `.codegraph/`, local tool state and unrelated artifacts. Never reset, clean or overwrite another contributor's changes.
2. Read the [README](README.md), [testing guide](docs/quality.md) and relevant [capability matrix](docs/capability-matrix.en.md) row. Read the full TODO/`unimplemented` requirements in files you touch; they are acceptance criteria.
3. For DSH changes, verify the exact target tag/commit and real interfaces in the [upstream contract](docs/dsh-contract.en.md). A historical Host API reference is not a contract for another Remote/version family.
4. Complete the requested behaviour through the necessary layers. For parallel work, agree on file ownership or use separate worktrees, then check the combined result.

If a `.codegraph/` index exists, use `codegraph_explore` or `codegraph explore "<symbol or question>"` before locating or tracing code. If CodeGraph is unavailable, use `rg` and targeted reads. Without an index, skip CodeGraph; do not create one just to contribute.

## Repository map and dependency boundaries

| Location                        | Owns                                                       | Must not do                                                |
| ------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/domain/`              | Stable types, repository contracts and pure rules          | Import VS Code, React, HTTP, process or platform APIs      |
| `packages/application/`         | Use cases, connection coordination and ports               | Depend on upstream wire types or Webview components        |
| `packages/dsh-adapter/`         | Version detection, RPC/events, errors and recovery         | Call `vscode.*` or leak upstream types into higher layers  |
| `packages/timeline/`            | Pure reduction into immutable transcript nodes             | Import React/platform APIs or mutate published snapshots   |
| `packages/webview-protocol/`    | Strict request/event schemas and safe DTOs                 | Carry secrets, endpoints or raw diagnostics to the Webview |
| `apps/extension/`               | VS Code composition, Host routes and privileged operations | Trust Webview input or claim an external process by PID    |
| `apps/webview/`, `packages/ui/` | View state, React rendering and interaction                | Fetch DSH directly or access privileged files/processes    |
| `packages/dsh-editor-bridge/`   | Optional bundle inside DSH                                 | Bypass Host workspace/session authorisation                |

Read the [English architecture overview](docs/architecture.en.md) and [detailed Chinese specification](docs/architecture.md) for dependency and lifecycle rules. Tests are colocated; `tests/` holds cross-layer, live and Electron suites. Shared configuration is in `config/`; keep root tool-discovery entrypoints in place.

## Implementation rules

- Work from domain rules and ports through Adapter mapping, Application/Host routes and schemas, then Store/UI. For Adapter changes, add a sanitised contract fixture and cover RPC errors. Touch only necessary layers; keep version differences in `packages/dsh-adapter/src/versions/`.
- Follow TypeScript strictness, nearby code, Prettier and ESLint. Do not weaken types, delete TODOs, skip failing branches or update snapshots merely to make checks green.
- Use structured DSH state. Never parse TUI/ANSI or infer tool, approval, question, Goal, Job or Workflow state from model text. Discover provider/model/skill/plugin/command catalogues rather than hardcoding them.
- Validate user controls through Store, protocol client and Host router. Preserve cancellation, refusal and stop operations, stale-generation checks, per-surface ownership and visible retryable failures.
- Preserve immutable identities for unchanged nodes, bounded buffers and cleanup. Internal performance work must retain rendered content, grouping, order, styling and interactions unless the user requested a UI change.
- Put Webview text in both locale JSON files under `apps/webview/src/locales/`; use `pnpm i18n` and `pnpm i18n:check`. Keep English/Chinese user documentation consistent.
- Write documentation as concrete actions, results and limits. Remove filler, repeated explanations and forced contrasts. Keep technical terms and security requirements precise.

## Trust and lifecycle rules

- The Webview never receives endpoints, PIDs, command lines, cookies, API keys, secrets, absolute workspace paths or raw diagnostic bodies. The Host revalidates IDs, enum values, lengths, paths, ownership and workspace trust after schema validation.
- Secrets enter through native VS Code password input or SecretStorage; the Webview sees configured/missing state only. Logs use an allowlist and redact prompts, bodies, tool input/output and credentials.
- In `auto` mode, discovery finishes before launch. Stop/restart only a process created and still held by this extension; never take over an external DSH or use its PID as proof of ownership.
- Automatic discovery is bounded and loopback-only, without arbitrary port scans. Remote access requires the user's explicit `custom` endpoint and native authorisation: origin-scoped credentials, no redirects, HTTPS certificate validation and consent for remote plaintext HTTP. Do not concatenate untrusted input into shell commands.
- File, attachment, export and editor actions use Host-owned VS Code APIs, user intent and trusted roots. Preserve path traversal, symlink, size, overwrite and cancellation checks. Release sockets, listeners, timers, pending reads and owned process handles on errors/cancellation/disposal as well as success.

## Verification and handoff

Use the [validation matrix](docs/quality.md#choose-validation-by-change). Typical commands, from the repository root:

```sh
pnpm test:changed
pnpm check
pnpm build
git diff --check
git status --short
```

For documentation-only changes, run the documentation checks in that matrix. UI, transport, process and Adapter changes also need the applicable interaction/live checks; automated success does not replace them. Add tests for new behaviour or regressions at the nearest meaningful boundary, not copies of the implementation or duplicate assertions at every layer.

When implementing an `unimplemented` path, cover its applicable TODO requirements: success, business/protocol errors, timeout, cancellation, malformed input and resource cleanup. Keep capabilities `PARTIAL` when required runtime/UI evidence is missing. Use the [result format](docs/quality.md#report-test-results) for commands, pass/fail/skipped results, versions, manual steps and untested areas. Never claim an unavailable check ran or confuse virtual-clock results with measured CPU time or UI latency.

Update rules in the relevant document. Keep exact DSH versions in the two language versions of the upstream contract and release changelogs. Do not append task logs to specifications. Do not commit credentials, private paths, `DSH_VSCODE_IMPLEMENTATION_PLAN.md`, `LOCAL_*.md`, generated media, build outputs or VSIX files.

Commit, push, open/merge a PR, tag or publish only when the user's task authorises that step. Opening a PR authorises its necessary commit/push, not a merge. Otherwise leave changes uncommitted and report what changed, why, checks and gaps. Continue routine, reversible work within the authorised scope without unnecessary confirmation.
