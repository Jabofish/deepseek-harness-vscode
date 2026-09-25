# DeepSeek Harness for VS Code

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/Jabofish/deepseek-harness-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/Jabofish/deepseek-harness-vscode/actions/workflows/ci.yml)
[![Marketplace](https://img.shields.io/badge/Marketplace-Install-0078D4?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=Direwolf.deepseek-harness-client)
[![GitHub Release](https://img.shields.io/github/v/release/Jabofish/deepseek-harness-vscode)](https://github.com/Jabofish/deepseek-harness-vscode/releases)
[![License](https://img.shields.io/github/license/Jabofish/deepseek-harness-vscode)](LICENSE)

**DeepSeek Harness Companion for VS Code** brings local [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) sessions into the editor. It shows streaming replies, thinking, tool activity, approvals, and recoverable conversation history in a VS Code view.

## What you can do

- Create, switch, resume, and archive sessions in a workspace.
- Send text, images, and supported files; reference files or sessions with `@`.
- Follow tool progress, answer questions and approvals, and open produced files through VS Code.
- Choose the models, providers, permissions, and agent options exposed by the connected DSH runtime.
- Use local prompt templates, checkpoints, a Changes view, and a task center when their prerequisites are available.

The connected DSH version determines which advanced capabilities are available. Unsupported operations show a clear unavailable state. The [compatibility contract](docs/dsh-contract.md) lists exact adapter boundaries; the [capability matrix](docs/capability-matrix.md) distinguishes implementation, automated tests, and real runtime verification.

## Install and start

Install [DeepSeek Harness Companion for VS Code](https://marketplace.visualstudio.com/items?itemName=Direwolf.deepseek-harness-client) from the Marketplace, or download a platform VSIX from the [latest GitHub Release](https://github.com/Jabofish/deepseek-harness-vscode/releases/latest) and use **Extensions: Install from VSIX...**.

1. Open the **DeepSeek Harness** view.
2. If DSH is missing, use the guided installer, select an existing executable, or copy the exact install command shown in the view. The installer checks its required Node.js version before running.
3. Choose or create a workspace, start a session, and send a task.

The extension first looks for a compatible local DSH. It starts one only when the selected connection mode permits it and discovery has finished. It never stops a DSH process it did not create.

| Connection mode | Behavior                                                                             |
| --------------- | ------------------------------------------------------------------------------------ |
| `auto`          | Attach to a running DSH; start an extension-owned one only if no candidate connects. |
| `attach-only`   | Discover and attach; never start DSH.                                                |
| `new-isolated`  | Start one dedicated extension-owned DSH.                                             |
| `custom`        | Probe only the single validated loopback endpoint supplied by the user.              |

The General settings page can check upstream package versions and install an exact verified version. Updating a global package never stops an external DSH.

## Privacy and support

DSH connections, credentials, files, and processes stay in the VS Code Extension Host. The Webview receives no secrets or direct filesystem/network access. Endpoints are restricted to validated loopback addresses; diagnostics are redacted. See the [security model](docs/architecture.md) and [support instructions](apps/extension/SUPPORT.md).

Developer documentation starts at the [documentation index](docs/README.md). The [contribution guide](CONTRIBUTING.md) explains validation and evidence. User-facing changes are recorded in the [extension changelog](apps/extension/CHANGELOG.md). Licensed under [MIT](LICENSE).
