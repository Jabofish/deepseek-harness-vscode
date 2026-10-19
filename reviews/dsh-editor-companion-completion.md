# Editor companion completion

Target: EB-01, ED-01, SY-01, NAV-01, RV-01, PG-01 and RW-01.
Pinned upstream: `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`.
Platform: Windows x64; VS Code 1.142.0 (`6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1`).
Companion package: 0.2.0, protocol 2 with protocol 1 retained.

## Implemented scope

- [x] Strict Domain requests, results, capability selection and bounded limits.
- [x] Independent rc212 Adapter repository; fixed named Remote calls and safe errors.
- [x] Ten registered model tools; Agent session/Remote Peer ownership, distinct grants,
      bounded concurrency, lease renewal, timeout, cancellation and teardown.
- [x] Application polling independent of editor work; late replies cannot cross requests.
- [x] Unsaved buffer and selection reads, cached diagnostic details, language-provider
      queries, same-root result filtering and native navigation.
- [x] Pending-only edit proposals; native diff review with an interactive confirmation,
      version/original-text rechecks, grouped undo and no automatic save.
- [x] Native install/version/status, enable/disable/uninstall, bounded archive inspection,
      hash-verified cache, upgrade/restore, cancellation and lost-acknowledgement recovery.
      Failed replacements preserve the prior enabled state when recovery succeeds.
- [x] Multi-root selection and independent session grants; same-session exclusivity.
      Same-host filesystem challenge and explicit trust confirmation for external grants.
      External runtimes remain outside installation and process management.
- [x] Safe structured tool projections for live events and restored history; privileged
      paths, grant identifiers, source and diagnostic bodies stay out of these cards.
- [x] Bundle packaged with the extension; no generated archive or VSIX committed.
- [x] User guide, contract, architecture, capability matrix and changelog updated.

## Automated evidence

`pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build` and `git diff --check`.
Full check: 4,216 tests passed, 31 skipped (opt-in/environment-dependent cases).
Contract tests cover per-capability denial, Peer/session conflicts, bounded queues,
request cancellation, stale responses, trust loss, real-path escapes, version drift,
rejected/declined/stale edits, revocation during confirmation, original installation
ID recovery, cancellation and restoration of disabled bundles. No gates are weakened.

The built VSIX contains `extension/resources/editor-companion.tgz`, the extension
runtime, Webview assets and licenses. Its allowlist excludes source and Webview
sourcemaps. The archive has the expected private package identity, version and patch.

## Isolated real DSH evidence

Enable `DSH_LIVE_SMOKE=1`, select exact `DSH_LIVE_RUNTIME_VERSION=0.2.1-rc.2` and its
executable, and set `DSH_EDITOR_BRIDGE_BUNDLE` to the built local archive. On Windows,
`DSH_EDITOR_BRIDGE_PNPM` selects the exact package-manager JavaScript entry for
the disposable CLI and runtime profile. Then run:

```powershell
pnpm exec vitest run tests/live-dsh/editor-bridge.spec.ts
```

This uses a new disposable DSH home/profile and workspace, installs the independent
archive, authenticates through actual Remote and invokes tools through the real
Agent/tool pipeline. It verifies legacy metadata, all ten tools in the actual
catalogue, protocol negotiation, same-host challenge and missing-proof rejection,
content read, capability denial before Host execution, cancellation without losing
the grant, another independent session and same-session ownership conflict. DSH is
stopped and its test-owned resources are removed. No model inference is invoked.

The same isolated run also verifies actual plugin-manager inventory, disable,
enable, remove and reinstall of the packed 0.2.0 archive through the Adapter.
The Windows CLI's default package-manager invocation returned an operation error
during removal; using the public `runCli({ packageManager })` option with the exact
pnpm JavaScript entry made the full lifecycle pass. This is an explicit runtime
dependency, not proof that every DSH installation can execute package mutations.
Offline-only profile refusals are reported with maintenance instructions.

## Real VS Code API evidence

Select an installed VS Code with `DSH_VSCODE_E2E_EXECUTABLE`, then run:

```powershell
pnpm exec node --experimental-strip-types tests/vscode-e2e/editor-bridge.ts
```

The isolated Electron Extension Host uses actual text documents/editors and native
API calls. It verifies dirty buffers, selected text, document versions, diagnostic
cache/details, document symbols, definitions/references through explicitly registered
fixture language providers, navigation, pending proposal receipts without mutation,
cancellation and revoked access. It does not simulate clicking Apply in a real diff.

## Remaining acceptance boundaries

- [ ] A real model chooses and chains these tools through the normal chat UI.
- [ ] A person reviews a long native diff, applies/declines, and checks keyboard/undo
      behavior in their installed VS Code profile.
- [ ] Separate SSH, WSL and container runs, including multi-window interaction.
- [ ] Three-platform CI on the delivered commit and fresh-profile installation.

These are acceptance/evidence gaps, not promises inferred from fixtures. Relevant
matrix rows remain `PARTIAL`. No claim of complete remote or model-driven acceptance
is made. The editor companion complements DSH: transport, conversation history,
approvals, process ownership and general UI remain extension responsibilities.
