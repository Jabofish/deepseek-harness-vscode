# VS Code editor companion for DSH

An optional DSH bundle giving an agent explicitly scoped access to the actual
VS Code editor, including unsaved buffers. It uses the authenticated Remote
connection and adds no listening port. The exact runtime is pinned in the
[compatibility contract](../../docs/dsh-contract.md#编辑器配套插件).

## Install and manage

Build with `pnpm build` (bundle only: `pnpm build:companion`). The extension
includes the private local bundle; these commands do not publish it to npm.

1. Connect an extension-managed DSH in a trusted workspace.
2. Run **DSH: Install Editor Companion**, or **DSH: Manage Editor Companion**
   from the Command Palette or the DSH view's More Actions menu.
3. Confirm installation; reconnect if DSH requires it.
4. Select a session whose working directory matches an open workspace root.
5. Run **DSH: Share Editor State with Current Session** and select permissions.
   No capabilities selected means metadata access only.

The manager displays installed/active versions and protocol, and offers enable,
disable, uninstall, local archive installation, cached restore, access revocation
and edit review. Replacements require a recovery archive of the installed version.
Confirmed failed/cancelled replacements attempt to restore it. Unknown outcomes
are recovered using the original installation ID, blocking duplicate installs.
Archives are identity-checked and kept in a bounded, hash-verified cache. Install
only trusted archives: package validation is not a code signature.

DSH's own plugin manager must have a working pnpm invocation in its execution
environment. A broken/missing package-manager command can make mutations fail
even when status queries and editor tools work. A profile started without the
required hot-reload support may require offline CLI maintenance; the manager
reports that upstream refusal rather than bypassing the profile lock.

External loopback runtimes may share editor access after native trust confirmation
and proof of access to the Extension Host filesystem. Installation, removal and
process control remain exclusive to extension-managed instances. For an external
runtime, install the bundle into its selected home/profile yourself, for example:

```powershell
pnpm --filter @dsh-vscode/editor-bridge pack --pack-destination artifacts
dsh plugin --profile web add "<absolute path to artifacts/dsh-vscode-editor-bridge-0.2.0.tgz>"
```

## Tools and permissions

File paths are relative to the selected session root; coordinates are one-based
UTF-16. Tool registration is automatic and supports DSH tool discovery. Each
request rechecks its capability, trust, document and workspace boundaries.

| Tool                      | Required permission | Behavior                                                                                |
| ------------------------- | ------------------- | --------------------------------------------------------------------------------------- |
| `vscode_get_editor_state` | Metadata grant      | Active file, language, version, dirty flag, selection and diagnostic counts.            |
| `vscode_read_document`    | Content             | Current buffer, optional line range/expected version; at most 65,536 UTF-16 code units. |
| `vscode_read_selection`   | Content             | Actual selected text, version and truncation status.                                    |
| `vscode_get_diagnostics`  | Diagnostics         | Bounded cached messages/ranges/severity; does not wait for compilation.                 |
| `vscode_find_symbols`     | Language services   | Document symbols or a workspace symbol query confined to the selected root.             |
| `vscode_find_definitions` | Language services   | Definition locations with out-of-root results excluded.                                 |
| `vscode_find_references`  | Language services   | Reference locations with the same containment rules.                                    |
| `vscode_open_file`        | Navigation          | Validated file and position, preserving keyboard focus.                                 |
| `vscode_propose_edit`     | Edit proposals      | Versioned, non-overlapping edits to one document; returns pending and never writes.     |
| `vscode_get_edit_result`  | Edit proposals      | Pending/applied/declined/stale/cancelled receipt for this grant.                        |

An edit requires a separate user action: **DSH: Review Proposed Editor Edits** or the native
Review notification, followed by native diff inspection and explicit Apply. The
Host rechecks permission, trust, root, version and original text before applying
one undoable edit group. It never saves the file. Dismissing confirmation leaves
the proposal pending. At most eight proposals are kept per grant, expiring after
ten minutes; before/after documents are limited to 262,144 UTF-16 code units each.

## Scope and lifecycle

Up to sixteen different sessions/windows can hold independent grants in one DSH.
A session cannot be claimed by a second window. Each grant selects one multi-root
workspace folder and allows four concurrent requests. Per-request cancellation
does not revoke other requests. Session/root changes, disconnect, shutdown,
explicit stop and lease expiry revoke access. Reconnection never restores access.
Missing editors, unavailable language providers, stale versions and denied
permissions return explicit errors.

Files must be regular files inside the selected real root; symlink escapes,
files over 2 MiB and arbitrary URI schemes are rejected. Open buffers may contain
unsaved changes; untitled documents outside a root are unavailable. Language
queries depend on installed VS Code providers and are not an indexing service.

In SSH, WSL or containers, both extension and DSH must execute on the workspace
Extension Host. Matching paths or a forwarded loopback address are insufficient:
a short-lived random filesystem challenge must succeed. Desktop-to-remote path
mapping and arbitrary remote HTTP sharing are unavailable. Remote environment
acceptance remains separate from local tests.

Code and diagnostic details go to the granted DSH tool. Structured companion
cards in the Webview show safe summaries in live events and restored history.
This does not redact text the model chooses to quote in its reply. Credentials,
privileged paths and grant identifiers stay in the Host.

## Protocol and evidence

Package 0.2.0 negotiates protocol 2 via `vscodeEditorCompanion/describe`,
`verifyHost`, `attach`, `poll`, `respond` and `detach`, retaining legacy metadata
protocol 1. Inputs, outputs and limits are strictly validated. Grants bind to
both the Agent session and Remote Peer. Slow operations do not stop lease renewal;
stale replies cannot satisfy later requests. No privileged Webview route is added.

`pnpm check` covers contracts, containment, permissions, cancellation, edit
conflicts, rollback and projections. `tests/live-dsh/editor-bridge.spec.ts`
exercises an isolated real DSH Agent/tool pipeline without model inference.
`tests/vscode-e2e/editor-bridge.ts` separately exercises real VS Code APIs with
registered language-provider fixtures. Manual diff acceptance, a model-driven
editor scenario and SSH/container acceptance are not implied by these tests.
See the [completion record](../../reviews/dsh-editor-companion-completion.md).
