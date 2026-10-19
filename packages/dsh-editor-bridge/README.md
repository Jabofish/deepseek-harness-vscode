# VS Code editor companion for DSH

An optional, locally installable DSH bundle exposing `vscode_get_editor_state`.
The tool reads explicitly shared metadata from the VS Code Extension Host:
workspace-relative file name, language, document version, unsaved state,
one-based UTF-16 selection, and cached error/warning counts. It does not read
document text or diagnostic messages. Counts are observations, not proof that
language services or compilation have finished.

## Build and install

Use the exact DSH runtime specified in the repository's
[compatibility contract](../../docs/dsh-contract.md#编辑器配套插件).
From the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @dsh-vscode/editor-bridge pack --pack-destination artifacts
dsh plugin --profile web add "<absolute path to artifacts/dsh-vscode-editor-bridge-0.1.0.tgz>"
```

Installation changes the selected DSH home's `web` profile. Choose that home
explicitly when testing. Reconnect the extension-owned runtime after installation;
if the running DSH asks for a restart, use the extension's own reconnect action.
The extension does not install the bundle automatically or control external DSH
processes. This package is private and is not published to npm by these steps.

## Use

1. Open one trusted local workspace folder. Use an extension-managed local DSH
   instance (`new-isolated`, or one started by `auto`).
2. Select an ordinary DSH session whose working directory matches that folder.
3. From the DSH view's **More Actions** menu or the Command Palette, run
   **DSH: Share Editor State with Current Session**.
4. Keep a saved file open in the editor; its current buffer may contain unsaved
   changes. Ask the model to call `vscode_get_editor_state`.
5. Click **DSH: Editor state shared** in the status bar, or run
   **DSH: Stop Sharing Editor State**, to revoke access.

Sharing is volatile and belongs to one session/window/workspace. Session changes,
workspace changes, disconnect and shutdown revoke it. Reconnect does not restore
authorization. A missing editor is an unavailable result, not an empty snapshot.
Only one owner/session can hold a lease per DSH process in this MVP. External
instances, remote workspaces, multiple roots, file editing and source/diagnostic
body retrieval are outside the first supported scope.

## Protocol and verification

The plugin uses DSH's existing authenticated Remote connection. It adds no
listening port. Fixed `attach`, `poll`, `respond`, and `detach` methods carry
strictly validated messages. Binding identities stay in the Host. A bounded
poll renews a short lease; cancellation, expiry and teardown release pending
requests. The tool can only request metadata for its own bound Agent session.

`pnpm check` covers contracts, ownership, cancellation, stale replies, metadata
allowlists and Host lifecycle. The opt-in
`tests/live-dsh/editor-bridge.spec.ts` exercises an isolated real DSH and its
Agent/tool execution pipeline without a model request. The separate
`tests/vscode-e2e/editor-bridge.ts` exercises the real VS Code metadata provider.
These are separate evidence paths; a complete model-driven UI scenario remains
manual acceptance work.

中文：安装本地 bundle 后，在受管本地 DSH 的当前会话中主动开启编辑器状态共享。
工具仅返回相对文件名、语言、版本、未保存标记、选区和诊断数量；切换会话或断连会撤销。
状态栏可随时停用。代码和诊断正文不包含在首版能力中。
