# VS Code editor companion for DSH

The editor integration is bundled with the VS Code extension. It uses DSH's
existing authenticated Remote connection and adds no listening port. Editor
access follows the selected session after the user chooses to install the companion
in Settings. It is not automatically installed, including during F5 launches. The
agent edits remain undoable. Initially clean buffers save automatically;
existing unsaved user changes remain unsaved when edits are applied or undone.

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
Remote users prepare pnpm on the DSH/Extension Host side. Installation consent is
independent from the native installed state; a missing package always says Install.
Migration removes recognized legacy loader/overlay files in extension-owned storage,
retaining cached archives, unrelated files and all session data.
Already installed companions can update through the same manager after consent;
missing packages always retain the explicit Install action. External processes are
never modified or replaced automatically. Turning editor tools off revokes access.
Cancel installation addresses the original DSH request. The panel keeps an unknown
outcome visible and prevents duplicate installs until status recovery confirms it;
if cancellation was too late, it shows the actual installed result.

The repository's **F5** launch runs `pnpm build` before starting the Extension
Development Host. This rebuilds the companion from current source even without a
version bump. The debug launch requests a fresh owned DSH on a free port, ignoring
discovery of old processes without changing saved connection settings. Each build
has its own package build fingerprint, so an installed stale build can be detected.
Stop and start debugging with F5 after editing companion source; reloading a running
window alone does not run the pre-launch build task. Installation consent and the
editor access switch both apply during debugging.

The standard package-manager contract is pinned in `docs/dsh-contract.md` for
DSH `0.2.1-rc.2`. Failure to install or load the optional integration does not stop
DSH startup. The client negotiates its own tool protocol
separately from DSH's version and falls back to metadata when only protocol 1 is
available. Unsupported tools leave chat, attachment and manual editor context usable.

**Repair setup** remains available for compatible extension-managed profiles.
The standard plugin archive is built by `pnpm build:companion`; explicit
archive/profile mutations still require the DSH package manager to work. Unknown
installation outcomes recover by original request ID instead of replaying mutations.
Existing versions are preserved for rollback when available. Filesystem/profile
maintenance is an advanced recovery path, not a normal installation requirement.

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

An edit is written as one undoable editor group the moment the agent asks for it; the
user is not asked to review a diff, no notification pops up and no editor tab is opened
or focused. The touched lines get a two-second highlight when the file is already on
screen. The Host rechecks trust, root, version and original
text first, then saves through VS Code only when the buffer was initially clean and still matches the applied edit. The receipt carries `saved: true` on save success or `saved: false` when user changes are retained unsaved or saving failed; do not resend that edit. Undo also preserves unsaved user changes. Saving honors VS Code save participants. A transient status bar entry offers **Undo**, and
**DSH: Undo Last Editor Edit** reverts the most recent applied edit while the buffer
still matches what the agent produced. The undo record lives in the extension rather than
in the grant, so it survives a reconnect, a session switch and a stopped grant; reverting
compares text instead of a document version, so it also works after the file was saved, and
it reverts only the agent's own span when you edited elsewhere in the file.

Typing while the agent thinks no longer discards the edit: the Host keeps the text the
agent read, and an edit whose ranges sit entirely outside the span you changed is rebased
onto the new buffer. Only an edit that overlaps your change is refused.

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
relative handle, never an absolute `untitled:` URI. Drafts cannot be written. Reads return at most 200 lines and 16,384 UTF-16 units; selections retain the separate 65,536-unit cap. Continue at the exact returned end line/column using `startLine` and `startColumn` to preserve line endings. A start beyond EOF fails instead of substituting another line. End lines are clamped to EOF; an empty
selection returns empty text. Open buffers may contain unsaved changes; file-backed
documents outside the open roots remain unavailable. Language queries depend on installed VS Code
providers and are not an indexing service.

A short connection failure retries with backoff; released grants also get bounded
reconnection attempts. The settings panel shows remaining failures with Retry. Every tool failure reaches the agent
with the user action that fixes it, so a stale document or missing language provider
is reported as such rather than as a generic error.

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

Package 0.2.1 negotiates protocol 2 via `vscodeEditorCompanion/describe`,
`verifyHost`, `attach`, `poll`, `respond` and `detach`, retaining legacy metadata
protocol 1. Inputs, outputs and limits are strictly validated. Grants bind to
both the Agent session and Remote Peer. Slow operations do not stop lease renewal;
stale replies cannot satisfy later requests. Three bounded Host routes provide status, preference changes and named recovery actions; no arbitrary command or filesystem route is exposed.

`pnpm check` covers contracts, containment, permissions, cancellation, edit
conflicts, rollback and projections. `tests/live-dsh/editor-bridge.spec.ts`
exercises an isolated real DSH Agent/tool pipeline without model inference.
`tests/vscode-e2e/editor-bridge.ts` separately exercises real VS Code APIs with
registered language-provider fixtures. Native VS Code Undo and independent editor reversion are also exercised. A
model-driven editor scenario and SSH/container acceptance are not implied by these tests.
