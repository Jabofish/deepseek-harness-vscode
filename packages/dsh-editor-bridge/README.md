# VS Code editor companion for DSH

The VS Code extension bundles this optional DSH-side editor integration. It uses
DSH's existing authenticated Remote connection and adds no listening port. Choose
Install and enable companion in Settings to enable it, including during F5 launches.
It follows the selected session. Edits are undoable; initially clean buffers can save
automatically, while existing unsaved input remains unsaved through edits and reverts.

See the [user guide](https://github.com/Jabofish/deepseek-harness-vscode) for setup,
the [upstream contract](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/docs/dsh-contract.en.md)
for compatibility and [Contributing](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/.github/CONTRIBUTING.md)
for development.

Compatibility follows the available Host services and the negotiated editor protocol.
The published archive accepts DSH versions broadly, including prereleases; its optional
Cordis, Tools and Typert peers come from the running Host. It does not install another
copy of these services or require a list of DSH release numbers. Development dependencies
pin only the types used to build the archive. Missing methods or capabilities remain
unavailable, and authenticated peer ownership is checked on every request.

## Start and configure

1. Connect DSH and select or create a session in your open workspace.
2. Choose **Settings → General → Editor integration → Install and enable companion**.
3. Use the editor tools. No separate download, CLI install or permission picker.

**Settings → General → Editor integration** provides live status, a persistent
workspace on/off switch, explicit installation and cancellation, read-only mode, retry, repair, managed
restart and Undo. These controls also work before a DSH connection exists. An
external instance with no companion offers **Use a dedicated DSH**, starting an
extension-owned instance while leaving the external process running.

Installation uses DSH's standard plugin manager and the archive shipped with the
extension. It requires a working package manager in the connected DSH environment.
The package exports English/Chinese display metadata so DSH's own plugin inventory
shows its title and description. Startup injects no local-file plugin or overlay.
Settings checks pnpm before installation, distinguishes missing and broken commands,
and provides a cancellable Install / repair pnpm action, a copyable command, the
official guide and a recheck action. Preparation uses Corepack when available or
npm otherwise, verifies pnpm, then restarts only the extension-managed DSH.
Remote users prepare pnpm on the DSH/Extension Host side. Migration removes recognized legacy loader/overlay files in extension-owned storage,
retaining cached archives, unrelated files and all session data.
After consent, already installed companions can update through the same manager.
Settings reads the native installed state; missing packages retain an explicit Install action. External processes are
never modified or replaced automatically. Turning editor tools off revokes access.
Cancel installation addresses the original DSH request. The panel keeps an unknown
outcome visible and prevents duplicate installs until status recovery confirms it;
if cancellation was too late, it shows the actual installed result.

The standard package-manager contract and exact supported runtime identities are pinned in the [DSH contract](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/docs/dsh-contract.en.md). Failure to install or load the optional integration does not stop
DSH startup. The client negotiates its own tool protocol
separately from DSH's version and falls back to metadata when only protocol 1 is
available. Unsupported tools leave chat, attachment and manual editor context usable.

**Repair setup** remains available for compatible extension-managed profiles.
The standard plugin archive is built by `pnpm build:companion`; explicit
archive/profile mutations still require the DSH package manager to work. Unknown
installation outcomes recover by original request ID instead of replaying mutations.
Existing versions are preserved for rollback when available. Use filesystem/profile maintenance only for advanced recovery.

## Tools

File paths are relative to an open workspace root; coordinates are one-based
UTF-16. Tool registration is automatic and supports DSH tool discovery. Each
request rechecks trust, document and workspace boundaries.

| Tool                      | Behavior                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `vscode_get_editor_state` | Active file, language, version, dirty flag, selection and diagnostic counts.                                                         |
| `vscode_read_document`    | Current buffer; at most 200 lines and 16,384 UTF-16 code units. Continue at returned end line/column with `startLine`/`startColumn`. |
| `vscode_read_selection`   | Actual selected text, version and truncation status.                                                                                 |
| `vscode_get_diagnostics`  | Bounded cached messages/ranges/severity; does not wait for compilation.                                                              |
| `vscode_find_symbols`     | Document symbols or a workspace symbol query confined to the open roots.                                                             |
| `vscode_find_definitions` | Definition locations with out-of-root results excluded.                                                                              |
| `vscode_find_references`  | Reference locations with the same containment rules.                                                                                 |
| `vscode_open_file`        | Validated file and position, preserving keyboard focus.                                                                              |
| `vscode_propose_edit`     | Versioned, non-overlapping edits to one document, applied immediately.                                                               |
| `vscode_get_edit_result`  | Applied/reverted/stale/cancelled receipt retained in the bounded edit ledger.                                                        |

With editing enabled, the Host applies an accepted edit as one undoable group.
It does not open or focus an editor tab, show a notification or request a separate diff review. The touched lines get a two-second highlight when the file is already on
screen. The Host rechecks trust, root, version and original
text first, then saves through VS Code only when the buffer was initially clean and still matches the applied edit. The receipt carries `saved: true` on save success or `saved: false` when user changes are retained unsaved or saving failed; do not resend that edit. Undo also preserves unsaved user changes. Saving honors VS Code save participants.

A transient status bar entry offers **Undo**, and
**DSH: Undo Last Editor Edit** reverts the most recent applied edit while the buffer
still matches what the agent produced. The extension retains the undo record across reconnects, session changes and stopped
grants. Reversion checks the text, so saving the file does not invalidate it. Edits
elsewhere in the file are preserved while the agent's span is reverted.

When the Host has the text the agent read, it can rebase an edit onto a changed
buffer if the edit ranges are separate from the user's changes. Overlapping edits
return a conflict; version, trust and size checks still apply.

## Scope and lifecycle

Up to sixteen different sessions/windows can hold independent grants in one DSH.
A session cannot be claimed by a second window. Each grant covers every workspace
root in the window and allows four concurrent requests; with several roots a path is
addressed as `<root name>/<relative path>`. Per-request cancellation
does not revoke other requests. Session/root changes, disconnect, shutdown and
explicit stop revoke access; a reconnect or a new session selection shares again
automatically. An explicit stop is remembered and suppresses automatic sharing
until editor tools are turned back on in **Settings → General → Editor integration**. Missing editors,
unavailable language providers and stale versions return explicit errors.

Files must be regular files inside one of the real roots; symlink escapes,
files over 64 MiB and arbitrary URI schemes are rejected. An unsaved draft is readable through the active editor and receives an opaque
relative handle, never an absolute `untitled:` URI. Drafts cannot be written. Document reads use the limits in the tool table; selections have a separate 65,536-unit cap. Continue at the exact returned end line/column using `startLine` and `startColumn` to preserve line endings. A start beyond EOF fails instead of substituting another line. End lines are clamped to EOF; an empty
selection returns empty text. Open buffers may contain unsaved changes; file-backed
documents outside the open roots remain unavailable. Language queries depend on installed VS Code
providers and are not an indexing service.

A short connection failure retries with backoff; released grants also get bounded
reconnection attempts. Settings shows failures with Retry. Tool errors use specific codes for stale
documents, missing language providers and other failures, with available recovery actions.

In SSH, WSL or containers, both extension and DSH must execute on the workspace
Extension Host. Matching paths or a forwarded loopback address are insufficient:
a short-lived random filesystem challenge must succeed. Desktop-to-remote path
mapping and arbitrary remote HTTP sharing are unavailable. Remote environment
acceptance remains separate from local tests.

Code and diagnostic details go to the granted DSH tool. Structured companion
cards in the Webview show safe summaries in live events and restored history.
This does not redact text the model chooses to quote in its reply. Credentials,
privileged paths and grant identifiers stay in the Host.

## Protocol and testing

The package version is defined in [package.json](package.json); it is independent of the DSH version and negotiated editor protocol. The companion negotiates protocol 2 via `vscodeEditorCompanion/describe`,
`verifyHost`, `attach`, `poll`, `respond` and `detach`, retaining legacy metadata
protocol 1. Inputs, outputs and limits are strictly validated. Grants bind to
both the Agent session and Remote Peer. Slow operations do not stop lease renewal;
stale replies cannot satisfy later requests. Three bounded Host routes provide status, preference changes and named recovery actions; no arbitrary command or filesystem route is exposed.

The repository's **F5** launch runs `pnpm build` before starting the Extension
Development Host. This rebuilds the companion from current source even without a
version bump. The debug launch requests a fresh owned DSH on a free port, ignoring
discovery of old processes without changing saved connection settings. Each build
has its own package build fingerprint, so an installed stale build can be detected.
Stop and start debugging with F5 after editing companion source; reloading a running
window alone does not run the pre-launch build task. Installation consent and the
editor access switch both apply during debugging.

`pnpm check` covers contracts, containment, permissions, cancellation, edit
conflicts, rollback and projections. `tests/live-dsh/editor-bridge.spec.ts`
exercises an isolated real DSH Agent/tool pipeline without model inference.
`tests/vscode-e2e/editor-bridge.ts` separately exercises real VS Code APIs with
registered language-provider fixtures. Native VS Code Undo and independent editor reversion are also exercised. Model-driven editor scenarios and SSH/container operation require separate validation.

For a companion change, follow the [change-based validation matrix](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/docs/quality.md#choose-validation-by-change) and report the exact DSH/runtime version, extension build, negotiated protocol and exercised capabilities. Check the negotiated capabilities for each tested Host. Keep process ownership, read-only mode, document versions, unsaved changes and Undo in the affected manual checks.
