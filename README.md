# DeepSeek Harness for VS Code

> Your DSH workspace, right beside your code.

English | [简体中文](README.zh-CN.md)

[![CI](https://github.com/Jabofish/deepseek-harness-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/Jabofish/deepseek-harness-vscode/actions/workflows/ci.yml)
[![Marketplace listed](https://img.shields.io/badge/Marketplace-listed-0078D4?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=Direwolf.deepseek-harness-client)
[![GitHub Release](https://img.shields.io/github/v/release/Jabofish/deepseek-harness-vscode)](https://github.com/Jabofish/deepseek-harness-vscode/releases)
[![License](https://img.shields.io/github/license/Jabofish/deepseek-harness-vscode)](LICENSE)

**DeepSeek Harness Companion for VS Code** is a native VS Code client for
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness), DeepSeek's local coding
agent. It brings sessions, streaming replies, thinking, and tool progress into the side bar so you
can stay in the editor and stay in flow.

## Highlights

- **Sessions & context** — create, switch, resume, and archive sessions per workspace.
- **A clear timeline** — user input, model replies, collapsed thinking, tool calls, approvals, and
  error states each render distinctly.
- **Control** — use the models, providers, reasoning levels, permission presets, and plan settings
  that your DSH instance provides.
- **Context-aware work** — send text, images, and workspace files; reference files and sessions
  with `@`; handle approvals and user questions in place.
- **Close the loop** — leave a rating and note on replies, and open files produced or modified by
  tools directly.
- **Reliable recovery** — automatic local DSH discovery with reconnect, deduplication, history gap
  backfill, and redacted diagnostics.
- **Local productivity extras** — prompt templates, checkpoints, a Changes drawer, and a task
  center, all handled host-side and triggered only by explicit user action.

## Install

**From the VS Code Marketplace** — install
[DeepSeek Harness Companion for VS Code](https://marketplace.visualstudio.com/items?itemName=Direwolf.deepseek-harness-client)
or search for `DeepSeek Harness` in the Extensions view.

**From GitHub Releases** — download `deepseek-harness-vscode-universal.vsix` (or a
platform-specific build: `linux-x64`, `windows-x64`, `darwin-x64`, `darwin-arm64`) from the
[latest release](https://github.com/Jabofish/deepseek-harness-vscode/releases/latest), then run
_Extensions: Install from VSIX..._ in VS Code.

## Get started

1. If DSH is not installed yet, run `npm install --global @deepseek-ai/dsh` (requires Node.js
   `22.19+`), or press the guided install action in the view.
2. Open the `DeepSeek Harness` view in VS Code.
3. Choose or create a workspace, start a session, and send your task.

The extension discovers a compatible local DSH automatically. When none is found it offers guided
actions to install DSH, select an existing executable, copy the install command, or open the
documentation. Discovery always completes before anything is started, and a DSH the extension does
not own is never stopped.

### Connection modes

| Mode             | Behaviour                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `auto` (default) | Discover and attach to a running DSH; start a local instance only when none can be attached.    |
| `attach-only`    | Discover and attach only; never start DSH.                                                      |
| `new-isolated`   | Always start a dedicated, extension-owned DSH.                                                  |
| `custom`         | Probe exactly one user-configured loopback endpoint (`http://127.0.0.1` or `http://localhost`). |

### Runtime updates

The General settings page checks the npm upstream at startup and can install one exact version from
the verified list. Updating never stops an external DSH; when a custom executable is selected, the
global package update requires selecting or reconnecting the runtime before it is used.

## Compatibility

| Requirement      | Version                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VS Code          | `1.125+` on Windows, Linux, or macOS; Remote SSH, WSL, and Dev Containers are supported                                                                                                                                                                                                                                                                                        |
| DeepSeek Harness | Published CLI/Web API `0.0.1-rc.1`/`.2`/`.5`, `0.1.0-rc.2`/`.3`, `0.1.0-rc.6` through `0.1.2-rc.1`, published `0.1.2-alpha.2`/`0.1.2-alpha.3`/`0.1.2-alpha.4`/`0.1.2-alpha.5`, released `0.1.3-alpha.2`, and latest upstream tag/alpha npm dist-tag `0.1.5-alpha.1`; source-level adapters are retained for every known tag (pre-release versions are not the install default) |
| Unknown versions | Any non-empty label is probed with the newest adapter that can safely reuse a verified wire; the alpha13/alpha132 Session v2 and alpha151 Session v3 adapters are exact-only, so unknown runtimes fall through to the verified alpha5 v0 adapter and surface a warning                                                                                                         |
| Node.js          | `22.19+`, required only when installing DSH from within the extension                                                                                                                                                                                                                                                                                                          |

Available models, tools, and advanced agent capabilities follow the connected DSH instance;
unsupported capabilities are surfaced clearly instead of failing silently.

## Privacy & security

Connections, file access, credentials, and process ownership stay in the VS Code Extension Host.
The Webview receives no secrets and no direct filesystem or network access, logs follow an
allowlist with prompt/body/token redaction, and every DSH endpoint must be a verified loopback
address. See [docs/security.md](docs/security.md) for the full trust model.

## Documentation

Developer documentation lives in [`docs/`](docs/README.md), starting from the
[index](docs/README.md):

| Document                                                     | Purpose                                              |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                 | Runtime structure, package boundaries, state machine |
| [docs/capability-matrix.md](docs/capability-matrix.md)       | Single source of truth for feature status & evidence |
| [docs/dsh-contract.md](docs/dsh-contract.md)                 | Upstream DSH contract baseline & upgrade process     |
| [docs/protocol.md](docs/protocol.md)                         | Extension Host ↔ Webview message protocol            |
| [docs/security.md](docs/security.md)                         | Trust boundaries and enforced controls               |
| [docs/development.md](docs/development.md)                   | Environment, debugging, DSH integration modes        |
| [docs/testing.md](docs/testing.md)                           | Test layers, negative paths, fixture rules           |
| [docs/implementation-order.md](docs/implementation-order.md) | Implementation phases and exit criteria              |
| [docs/release-checklist.md](docs/release-checklist.md)       | Everything required before a release                 |

## Development

Requires Node.js `>=22.19 <27` and pnpm `11.19` (pinned through `packageManager`):

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm check   # format + lint + typecheck + tests
pnpm build
pnpm package:vsix
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for change discipline and PR evidence requirements, and
[docs/development.md](docs/development.md) for debugging and live DSH integration modes.

- Pull requests and pushes to `main` run cross-platform CI on Linux, Windows, and macOS.
- Pushing a `v*` tag packages VSIX files for Linux, Windows, and macOS (plus a universal build),
  creates a GitHub Release, and publishes the extension to the Visual Studio Marketplace.

## Changelog & license

User-facing changes are tracked in
[apps/extension/CHANGELOG.md](apps/extension/CHANGELOG.md) and mirrored on the
[Releases page](https://github.com/Jabofish/deepseek-harness-vscode/releases). Licensed under the
[MIT License](LICENSE).
