# DeepSeek Harness Companion for VS Code

Bring local or remote [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sessions into VS Code. Follow streaming replies, thinking, tools, approvals, questions, and conversation history beside your code.

## Use the companion

- Create, switch, resume, and archive sessions by workspace.
- Send text, images, and supported files; reference files and sessions with `@`.
- Use the models, providers, permissions, and agent options supplied by the connected DSH.
- Open produced files through VS Code, and use local templates, checkpoints, Changes, and task views when available.
- Use the compact DSH-style focused layout, or switch to the classic layout in **Settings → General → Conversation layout**.
- Open sessions in editor tabs alongside the side bar, with independent navigation and restored sessions after a window reload.

Available operations depend on the connected DSH runtime. Unsupported capabilities are shown explicitly; [exact compatibility and current limitations](https://github.com/Jabofish/deepseek-harness-vscode/tree/main/docs) are documented in the repository.

Editor integration loads with extension-managed DSH and follows the selected session
automatically. Open **Settings → General → Editor integration** to see status,
turn it off, keep tools read-only, retry, repair, restart or undo the last agent
edit. No separate plugin installation or permission picker is needed. Ten tools
cover unsaved text/selection, cached diagnostics, symbols/definitions/references,
navigation and immediate, automatically saved, undoable edits. The last edit can be reverted
after a session switch; unrelated typing is preserved when it can be distinguished
from the agent's edit. Runtime capabilities are negotiated independently. An
unsupported editor capability leaves ordinary chat and manual context attachment
usable. External processes are never stopped; a dedicated instance can be started
from settings when an attached instance lacks the companion. Remote and real-model
acceptance remain separate checks.

## Get started

1. Open the **DeepSeek Harness** view.
2. If DSH is missing, use the guided installer or copy its exact install command. You can also select an existing executable.
3. Choose or create a workspace, start a session, and send a task.

The Chat view is registered in VS Code's Secondary Side Bar by default (on the right in the default workbench layout). VS Code may keep a previously saved view location after an upgrade.

Choose **Open in Editor Area** or run **DSH: Open Chat in Editor Area** (`/moveto:editor`); `/moveto:sidebar` returns the chat. You can drag an opened editor tab to split. The side bar remains available for other sessions. The native title bar shows its full controls when space permits; narrower views move lower-priority actions into **More**, keeping **Sessions** and **Settings** visible.

**Open Web UI** uses VS Code's integrated browser by default. To use your system browser, set `dsh.webUi.browser` to `external` in VS Code Settings.

To drag a session directly into a split, run **DSH: Open Drag Sessions** to open **DSH Sessions** in Explorer, then drag a session row to an editor edge. This native list is hidden initially and keeps the chat area free; the existing switcher remains available.

Without a specified target, auto validates the last successful local connection first, then discovers compatible instances before starting one. An explicit server URL or attachment port list restricts connection to those targets; failure leaves Settings and Retry available. Connection modes also let you attach only, start an isolated extension-owned instance, or probe one configured HTTP(S) endpoint (which may be remote). It never stops an external DSH. Runtime updates install a verified exact version and do not restart external processes.

For an external instance, select `custom`, set `dsh.connection.serverUrl` to its HTTP(S) origin and `dsh.connection.runtimeVersion` to its exact supported version. Run **DSH: Authorize External Connection**, enter its launch token (leave blank for anonymous access), then connect. Credentials stay in SecretStorage per execution environment and full origin; **DSH: Clear External Connection Credentials** removes the current environment's grant. Connections without a grant for the current execution environment require authorization.

HTTPS requires a trusted certificate. Remote HTTP needs explicit plaintext confirmation and renewed authorization after DNS address changes. The server must accept the configured host; use `--trusted-host host:port` where supported for a proxy. Remote connections do not grant local file or inspector access. See the [connection guide](https://github.com/Jabofish/deepseek-harness-vscode#connect-to-an-external-instance).

## Remote workspaces

Remote SSH, WSL, Dev Containers and Remote Tunnels run the extension and DSH on the workspace side. Install DSH there, and configure executable paths for that environment. Picked attachments retain their filesystem URI; desktop Inspector links use a native loopback tunnel, while native DevTools is unavailable in a browser client. Container rebuilds require runtime installation and DSH data persistence to be configured for the container.

## Privacy and help

DSH connections, credentials, file access, and process ownership stay in the VS Code Extension Host. The Webview receives no secrets or direct filesystem/network access; diagnostics are redacted.

- [Documentation and compatibility](https://github.com/Jabofish/deepseek-harness-vscode)
- [中文说明](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/README.zh-CN.md)
- [Extension versions](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/apps/extension/CHANGELOG.md)
- [Support](https://github.com/Jabofish/deepseek-harness-vscode/issues)
