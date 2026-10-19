# Editor companion usability review

Scope: EB-01 and PG-01; editor companion activation, settings, delivery and recovery. This review records implementation and validation evidence; delivery follows the current user authorization.

## Behavior and architecture

- The extension bundles a self-contained companion factory. Managed startup creates a content-addressed overlay in extension storage, resolving the protocol from the selected DSH runtime. It does not require a package-manager install or edit the user's profile. Unsupported runtimes retain ordinary chat. Unknown versions require an advertised `--patch` CLI interface before attempting the overlay.
- Domain describes preferences and public status. Negotiated Adapter repositories carry the independent companion protocol across supported runtime families; the existing native version adapters retain their own identities. Application services own polling and bounded retry; Extension Host owns configuration, trusted workspace access, process ownership and native editor APIs.
- Webview Settings → General provides editor access, automatic setup, read-only access and recovery. The strict protocol carries preferences, named actions and a bounded public status; it carries no absolute paths, source, secrets or raw diagnostic bodies.
- Connection attachment and prompt preparation reconcile session binding. The companion waits briefly for the first automatic bind rather than instructing users to run an enable command. Requests remain bounded and cancellation/disposal release waiters.
- Protocol 2 binds to the selected session without requiring its cwd to match this window's roots. Root/trust checks happen before content access; a request channel can exist while restricted so the first actual tool call offers native folder/trust setup. Dismissal does not trigger repeated prompts; Settings can explicitly retry. Fixed failure guidance is shared between model errors and public cards, with raw errors still excluded.
- Multi-root names and draft handles are protocol-safe. Reads and edit snapshots are bounded. Agent edits apply directly to buffers, save the whole document and support native Undo and an independent bounded edit ledger. Unrelated local edits can be preserved where a unique rebase/revert location exists; ambiguous changes fail with an actionable explanation.
- The Command Palette exposes six general actions. Internal handlers and advanced recovery commands remain registered for compatibility and contextual UI without filling the palette. Editor setup and per-session enable/disable are not normal user steps.
- Normal automatic connections compare the shipped content fingerprint with the running companion through an optional `buildIdentity` RPC. An older same-host companion switches this window to a fresh owned runtime; external processes are not modified or stopped. Failed startup falls back to chat. Custom/attach-only targets and disabled automatic setup remain explicit choices.
- F5 runs the full build, enables a development-only fresh-runtime override and uses a free port. The override does not change persisted connection settings. Companion source changes produce immutable module paths even without a package version bump; a regression loads both builds in one ESM process and proves each executes its own source.

## Upstream sources

Verified Windows runtime packages and fixed upstream sources:

| DSH runtime  | Upstream commit                            |
| ------------ | ------------------------------------------ |
| `0.2.0-rc.2` | `639ed015397290b3745d163aafe02ffee4aa3f84` |
| `0.2.1-rc.1` | `1600d8a1e140dcde43a1a0941940a0480712c011` |
| `0.2.1-rc.2` | `687f282e8625c6b8d11ff58211a90524be2e4317` |

Compared the CLI patch loader, Typert protocol service and peer types, tool registry and tool execution context. Earlier peers identify the authenticated owner by `id`; later peers also expose a principal, which must be an owner when present. Alpha-family source checks and exact version provenance are recorded in [the contract](../docs/dsh-contract.md). Unknown-version CLI negotiation is fixture-tested; it does not establish compatibility with arbitrary future DSH packages.

## Validation and limits

- Isolated managed-overlay tests passed against all three runtime packages on Windows x64, without manual companion installation. These execute actual companion RPC/tool paths with disposable DSH homes; they do not perform paid model inference.
- The earlier VS Code 1.142.0 Extension Host check covered unsaved edits. The subsequent automatic-save requirement supersedes that behavior; the updated native API scenario passes automatic save and independent revert to disk while retaining native Undo.
- Unit and integration coverage includes readonly/disabled preferences, late connection attachment, session reconciliation, first-call binding, bounded retries, cancellation, disposal, malformed status/configuration, draft handles and palette visibility.
- The last complete `pnpm check` passed: 399 test files, 4,249 tests passed; 29 opt-in files and 31 tests skipped. Subsequent queue/process presentation fixes passed 40 focused tests and Webview typechecking; the user's request to avoid unrelated tests takes precedence over repeating the full suite. `pnpm build` and `git diff --check` passed before those final presentation fixes and are rechecked for delivery.
- The inspected local VSIX included both the runtime factory and the optional standalone archive. Inspection found no source maps, source TypeScript, node_modules or review artifacts in that package. The later build-fingerprint resource adds one runtime JSON file; installation-package evidence does not establish automatic-update acceptance in a user's existing profile.
- Browser-fixture rendering uses the actual React settings component and product CSS at 320/760 CSS pixels, plus light/dark/forced-colors checks. Measured document width equals viewport width, and switches remain inside the viewport. This is browser evidence, not a real VS Code Webview capture.
- The real runtime regression starts `vscode_read_document` before binding; it waits, attaches automatically and returns content. Read-only denial, per-call cancellation, binding ownership conflict and detach remain covered.
- Build update detection, old-companion fallback, same-host checks, F5 isolation and immutable ESM build loading passed focused tests. The subsequent real-runtime fingerprint probe reached its readiness timeout under concurrent full-suite load; it is not recorded as successful live update evidence.

Reproduce using `pnpm build:companion`, then set `DSH_LIVE_SMOKE=1`, `DSH_EDITOR_COMPANION_MANAGED=1`, `DSH_LIVE_RUNTIME_VERSION` to the exact package version and `DSH_LIVE_RUNTIME` to that package's executable. Run `pnpm exec vitest run tests/live-dsh/editor-bridge.spec.ts` serially per runtime. The harness creates disposable homes/workspaces and releases its own process and endpoint. For native editor APIs, build and run `node --experimental-transform-types tests/vscode-e2e/editor-bridge.ts` with `DSH_VSCODE_E2E_EXECUTABLE` pointing at VS Code.

Evidence remains PARTIAL for complete real-model interaction, manual Webview acceptance across all themes, remote extension hosts, and arbitrary future DSH versions. Structural, browser-fixture and automated Extension Host checks do not establish these missing acceptance results.

## Editor tool reply, read and save corrections

The direct-edit implementation returned `applied` at an advanced version while the shared validator still required legacy `pending` at the requested version. Both the Application service and companion broker rejected successful writes. The corrected correlation accepts applied/stale/cancelled receipts at a non-regressing version while retaining exact pending-version and path/ID checks. Uncertain mutation errors never advise automatic resending.

Edits and independent revert now save the whole current buffer through VS Code, including pre-existing unsaved content. Receipts report `saved` independently from the applied/reverted status; failed saves preserve the edit and remain visible to the model and Host status indicator. `dirty` retains the native API meaning. Unknown receipts and missing files report `not-found`, file IO reports `file-access`, and out-of-file read starts report `invalid-range`. `open` accepts an omitted path. Document reads cap both 200 lines and 16,384 UTF-16 units and continue at the exact returned end position using `startLine`/`startColumn`.

Related checks: 34 focused Domain/provider/service/broker/public-summary/failure tests pass across their targeted runs; Extension Host typecheck, scoped lint and build pass. An isolated real DSH `0.2.1-rc.2` Agent/tool/Remote scenario passes applied/saved reply serialization, receipt lookup, unknown-ID isolation and omitted-path navigation. The real VS Code editor API scenario separately passes disk save/revert and lossless CRLF/surrogate pagination. Neither scenario invokes a real model. For the native API scenario use `node --experimental-transform-types tests/vscode-e2e/editor-bridge.ts`, with `DSH_VSCODE_E2E_EXECUTABLE` set to the local VS Code executable.

## Delivery verification

The final workspace passes 400 test files / 4,281 tests, with 29 opt-in files / 31 tests skipped. Formatting, documentation, locale parity, lint and workspace type checks pass through `pnpm check`, as do the production build and whitespace checks. The isolated real DSH `0.2.1-rc.2` tool/Remote scenario passes after rebuilding the companion.

New-session regressions execute selection requests through the real Broker and Application service with a mocked VS Code provider: unrelated or missing cwd does not block binding, session switching releases the old grant, and restricted-mode requests prompt before content access. Native access entry tests cover folder/trust actions, dismissal, concurrent requests, cancellation and late actions after disabling. These are automated fixtures; first-use prompts and new-session behavior in a real F5 window remain manual acceptance items.

Chat changes keep direct submissions in the composer through durable admission, support request cancellation and preserve real queued items with multiline editing and ID-based handoff. History navigation now prepends Host-projected nodes and retains live updates, with a bounded expanded view of 2,048 nodes / 4 Mi characters. Overlapping rows keep the newer version. Scroll restoration anchors a visible message when mounted, with a height-difference fallback for virtualized rows. Manual F5 acceptance of the final composer and history interaction remains outstanding.
