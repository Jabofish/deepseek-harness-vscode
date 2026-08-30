# DeepSeek Harness Companion for VS Code

> Your DSH workspace, right beside your code.

**DeepSeek Harness Companion for VS Code** is a native VS Code client for
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness), DeepSeek's local coding
agent. It brings sessions, streaming replies, thinking, and tool progress into the side bar so you
can stay in the editor and stay in flow.

## Why install it

- **Stay in flow** — manage DSH sessions in the side bar with workspace context always visible.
- **See the whole run** — user input, model replies, collapsed thinking, and grouped tool calls
  render as one clear timeline.
- **Stay in control** — choose the models, providers, reasoning levels, permission presets, and
  plan settings your DSH instance provides.
- **Bring your context** — send text, images, and workspace files, reference files and sessions
  with `@`, and handle approvals and user questions in place.
- **Close the loop** — rate replies with notes and open files produced or modified by tools
  directly.
- **Recover with confidence** — automatic local DSH discovery, reconnection, and redacted
  diagnostics with a clear status for every connection state.

## Start in seconds

1. Open the `DeepSeek Harness` view in VS Code.
2. Choose or create a workspace, then start a session.
3. Type your task and send it.

If DSH is not installed yet, run `npm install --global @deepseek-ai/dsh` (requires Node.js
`22.19+`), or use the guided install action in the view. The extension discovers a compatible local
DSH automatically; discovery always completes before anything is started, and a DSH the extension
does not own is never stopped.

The General settings page checks the npm upstream at startup and can install one exact version from
the verified list. Updating never stops an external DSH.

## Compatibility

- Visual Studio Code `1.125+` on Windows, Linux, or macOS (Remote SSH, WSL, and Dev Containers
  supported)
- Published DeepSeek Harness `0.1.0-rc.6` through `0.1.1-rc.2` Host/Web API, plus a prepared
  adapter for source-level `0.1.2-alpha.1` (not the install default)
- Unknown versions reporting a non-empty label are attempted in compatibility mode with a warning
- Node.js `22.19+` when installing DSH from within the extension

Available models, tools, and advanced agent capabilities follow the connected DSH instance;
unsupported capabilities are surfaced clearly and safely.

## Privacy & security

DSH connections, file access, credentials, and process ownership stay in the VS Code Extension
Host. The Webview never receives secrets or direct filesystem/network access, logs follow an
allowlist with prompt/body/token redaction, and every DSH endpoint must be a verified loopback
address. External DSH processes are never stopped by the extension.

## Links

- [Repository & documentation](https://github.com/Jabofish/deepseek-harness-vscode) — architecture,
  security model, and the full capability matrix
- [中文说明](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/README.zh-CN.md)
- [Changelog](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/apps/extension/CHANGELOG.md)
- [Support](https://github.com/Jabofish/deepseek-harness-vscode/issues) — please never include API
  keys, passwords, tokens, or prompt bodies in issues
