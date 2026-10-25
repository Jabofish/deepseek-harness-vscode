# DeepSeek Harness Companion for VS Code

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/Jabofish/deepseek-harness-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/Jabofish/deepseek-harness-vscode/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/Jabofish/deepseek-harness-vscode)](https://github.com/Jabofish/deepseek-harness-vscode/releases)
[![License](https://img.shields.io/github/license/Jabofish/deepseek-harness-vscode)](LICENSE)

**DeepSeek Harness Companion for VS Code** brings local or remote [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) sessions into the editor. Follow streaming replies, thinking, tools, approvals, and conversation history beside your code.

## What you can do

- Create, switch, resume, and archive sessions in a workspace.
- Send text, images, and supported files; reference files or sessions with `@`.
- Follow tool progress, answer questions and approvals, and open produced files through VS Code.
- Choose the models, providers, permissions, and agent options exposed by the connected DSH runtime.
- Use local prompt templates, checkpoints, a Changes view, and a task center when their prerequisites are available.
- Use the DSH-style focused layout with collapsible process details and a compact composer. Choose the focused or classic layout in **Settings → General → Conversation layout**; the choice is saved locally.
- Open sessions in editor tabs alongside the side bar, with independent navigation and restored sessions after a window reload.
- Enable optional session cost estimates in **Settings → Models → Model billing**. Inspect input, output and cache costs, choose a reference model, or enter custom rates. Chinese uses CNY and English uses USD; saved exchange quotes remain available when a refresh fails.

The connected DSH version determines which advanced capabilities are available. Unsupported operations show a clear unavailable state. The [compatibility contract](docs/dsh-contract.en.md) lists exact adapter boundaries; the [capability matrix](docs/capability-matrix.en.md) summarizes supported functions, limitations and completion status.

The optional [editor integration](packages/dsh-editor-bridge/README.md) provides unsaved text/selection, diagnostics, language services, navigation and undoable edits. Choose **Settings → General → Editor integration → Install and enable companion** to install it. Once enabled, it follows your selected session and extension updates. Settings provides status, off/read-only switches and recovery actions, including Undo. Available tools depend on the companion and DSH versions. Chat and manual context attachment remain available without it.

## Install and start

Download a VSIX matching the operating system and architecture of your Extension Host from the [latest GitHub Release](https://github.com/Jabofish/deepseek-harness-vscode/releases/latest), then run **Extensions: Install from VSIX...**. A universal VSIX is also provided. Use these VSIX files if the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=Direwolf.deepseek-harness-client) is unavailable.

1. Open the **DeepSeek Harness** view.
2. If DSH is missing, use the guided installer, select an existing executable, or copy the exact install command shown in the view. The installer shows npm output and verifies the installed version; npm warnings alone do not fail the installation.
3. Choose or create a workspace, start a session, and send a task.

The DeepSeek Harness Chat view appears in VS Code's Secondary Side Bar by default (on the right in the default workbench layout). If you previously moved it, VS Code may keep your saved layout. Run **DSH: Move View to Secondary Side Bar** from the Command Palette to choose the Chat view and **New Secondary Side Bar Entry**, or right-click the view title and use **Move View**.

The side bar stays available while editor chat tabs are open. Use the view title's **Sessions** button to switch or create a session. The native title bar shows its full controls when space permits; narrower views move lower-priority actions into **More**, keeping **Sessions** and **Settings** visible.

**Open Web UI** uses VS Code's integrated browser by default. To use your system browser, set `dsh.webUi.browser` to `external` in VS Code Settings.

To open an editor tab, choose **Open in Editor Area** or run **DSH: Open Chat in Editor Area** (`/moveto:editor`); `/moveto:sidebar` returns the chat. You can drag an opened editor tab to split. Dragging within a manually sorted session list still reorders sessions.

To drag a session directly into a split, run **DSH: Open Drag Sessions** to open **DSH Sessions** in Explorer, then drag a session row to an editor edge. The Explorer list is hidden until you run that command.

Without a specified target, auto validates the last successful local connection first, then discovers other instances before starting one. An explicit server URL or attachment port list restricts connection to those targets; failure leaves Settings and Retry available. The extension stops only processes it created and still holds a handle for.

| Connection mode | Behavior                                                                             |
| --------------- | ------------------------------------------------------------------------------------ |
| `auto`          | Attach to a running DSH; start an extension-owned one only if no candidate connects. |
| `attach-only`   | Discover and attach; never start DSH.                                                |
| `new-isolated`  | Start one dedicated extension-owned DSH.                                             |
| `custom`        | Probe only the single validated HTTP(S) endpoint supplied by the user.               |

The General settings page can check upstream package versions and install an exact verified version. Updating a global package never stops an external DSH.

## Connect to an external instance

1. Select `custom` mode and set `dsh.connection.serverUrl` to the server's HTTP(S) origin, with no path, query, or embedded credentials.
2. Set `dsh.connection.runtimeVersion` to the server's exact supported version.
3. Run **DSH: Authorize External Connection** and enter its launch token in the native password prompt. Leave it empty for an anonymous instance, then connect.

HTTPS requires a trusted certificate. Remote HTTP requires confirmation of plaintext transport and renewed authorization after DNS address changes. The server must accept the configured host; where supported, use DSH's `--trusted-host host:port` for a proxy. Remote connections do not grant access to local workspace files or the local inspector.

VS Code SecretStorage scopes credentials to the execution environment and full origin. Authorise again after changing environments or origins. **DSH: Clear External Connection Credentials** removes the current environment's grant.

## Remote workspaces

In Remote SSH, WSL, Dev Containers and Remote Tunnels, install the extension and DSH on the workspace side. Discovery, installation, process launch, loopback connections and files use that Extension Host's environment. A DSH installed only on your desktop is not the remote workspace's runtime.

Remote file picking keeps the selected filesystem URI. Desktop Inspector actions forward the validated Worker through VS Code before opening or copying a DevTools link; native DevTools is unavailable in a browser client. Container rebuilds require runtime installation and DSH data persistence to be configured for the container.

## Privacy and support

Network connections, credentials, files, and process control stay in the Extension Host. The Webview receives no secrets or direct filesystem/network access. Inspect redacted diagnostics before sharing them; remove remaining private content from screenshots and excerpts. See the [security model](docs/architecture.en.md), [security reporting policy](.github/SECURITY.md) and [support instructions](apps/extension/SUPPORT.md).

Developer documentation starts at the [documentation index](docs/README.md). Contribute with the [English guide](.github/CONTRIBUTING.md) or [中文指南](.github/CONTRIBUTING.zh-CN.md), the shared [testing guide](docs/quality.md) and [agent instructions](AGENTS.md). Release notes are recorded in the [extension changelog](apps/extension/CHANGELOG.md). Licensed under [MIT](LICENSE).
