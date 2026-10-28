# DeepSeek Harness Companion for VS Code

Bring local or remote [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sessions into VS Code. Follow streaming replies, thinking, tools, approvals, questions, and conversation history beside your code.

This is an unofficial extension for DeepSeek Harness.

## Use the extension

- Create, switch, resume, and archive sessions by workspace.
- Send text, images, and supported files; reference files and sessions with `@`.
- Use the models, providers, permissions, and agent options supplied by the connected DSH.
- Open produced files through VS Code, and use local templates, checkpoints, Changes, and task views when available.
- Use the compact DSH-style focused layout, or switch to the classic layout in **Settings → General → Conversation layout**.
- Open sessions in editor tabs alongside the side bar, with independent navigation and restored sessions after a window reload.
- Enable optional session cost estimates in **Settings → Models → Model billing**. Inspect input, output and cache costs, choose a reference model, or enter custom rates. Chinese uses CNY and English uses USD; saved exchange quotes remain available when a refresh fails.

Available operations depend on the connected DSH runtime. Unsupported capabilities are shown explicitly; [exact compatibility and current limitations](https://github.com/Jabofish/deepseek-harness-vscode/tree/main/docs) are documented in the repository.

The optional [editor integration](https://github.com/Jabofish/deepseek-harness-vscode/tree/main/packages/dsh-editor-bridge) provides unsaved text/selection, diagnostics, language services, navigation and undoable edits. Choose **Settings → General → Editor integration → Install and enable companion** to install it. Once enabled, it follows your selected session and extension updates. Settings provides status, off/read-only switches and recovery actions, including Undo. Available tools depend on the companion and DSH versions. Chat and manual context attachment remain available without it.

## Get started

Download a matching platform VSIX (or the universal package) from [GitHub Releases](https://github.com/Jabofish/deepseek-harness-vscode/releases/latest) and run **Extensions: Install from VSIX...**. Match the Extension Host's platform for remote workspaces. Use these files if the Marketplace listing is unavailable.

1. Open the **DeepSeek Harness** view.
2. If DSH is missing, use the guided installer, select an existing executable, or copy the exact install command shown in the view. The installer shows npm output and verifies the installed version; npm warnings alone do not fail the installation.
3. Choose or create a workspace, start a session, and send a task.

The Chat view is registered in VS Code's Secondary Side Bar by default (on the right in the default workbench layout). VS Code may keep a previously saved view location after an upgrade.

Choose **Open in Editor Area** or run **DSH: Open Chat in Editor Area** (`/moveto:editor`); `/moveto:sidebar` returns the chat. You can drag an opened editor tab to split. The side bar remains available for other sessions. The native title bar shows its full controls when space permits; narrower views move lower-priority actions into **More**, keeping **Sessions** and **Settings** visible.

**Open Web UI** uses VS Code's integrated browser by default. To use your system browser, set `dsh.webUi.browser` to `external` in VS Code Settings.

To drag a session directly into a split, run **DSH: Open Drag Sessions** to open **DSH Sessions** in Explorer, then drag a session row to an editor edge. The Explorer list is hidden until you run that command.

Without a specified target, auto validates the last successful local connection first, then discovers compatible instances before starting one. An explicit server URL or attachment port list restricts connection to those targets; failure leaves Settings and Retry available. Connection modes also let you attach only, start an isolated extension-owned instance, or probe one configured HTTP(S) endpoint (which may be remote). It never stops an external DSH. Runtime updates install a verified exact version and do not restart external processes.

For an external instance, select `custom`, set `dsh.connection.serverUrl` to its HTTP(S) origin and `dsh.connection.runtimeVersion` to its exact supported version. Run **DSH: Authorize External Connection**, enter its launch token (leave blank for anonymous access), then connect. Credentials stay in SecretStorage per execution environment and full origin; **DSH: Clear External Connection Credentials** removes the current environment's grant. Authorise again after changing execution environments or origins.

HTTPS requires a trusted certificate. Remote HTTP needs explicit plaintext confirmation and renewed authorization after DNS address changes. The server must accept the configured host; use `--trusted-host host:port` where supported for a proxy. Remote connections do not grant local file or inspector access. See the [connection guide](https://github.com/Jabofish/deepseek-harness-vscode#connect-to-an-external-instance).

## Remote workspaces

Remote SSH, WSL, Dev Containers and Remote Tunnels run the extension and DSH on the workspace side. Install DSH there, and configure executable paths for that environment. Picked attachments retain their filesystem URI; desktop Inspector links use a native loopback tunnel, while native DevTools is unavailable in a browser client. Container rebuilds require runtime installation and DSH data persistence to be configured for the container.

## Privacy and help

DSH connections, credentials, file access, and process ownership stay in the VS Code Extension Host. The Webview receives no secrets or direct filesystem/network access. Inspect redacted diagnostics and screenshots before posting; remove private prompts, tool bodies, paths and credentials.

- [User guide](https://github.com/Jabofish/deepseek-harness-vscode)
- [Exact compatibility](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/docs/dsh-contract.en.md)
- [中文说明](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/README.zh-CN.md)
- [Extension versions](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/apps/extension/CHANGELOG.md)
- [Support and safe diagnostic collection](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/apps/extension/SUPPORT.md)
- [Security reporting](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/.github/SECURITY.md)
- [Contributing and testing](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/.github/CONTRIBUTING.md)
