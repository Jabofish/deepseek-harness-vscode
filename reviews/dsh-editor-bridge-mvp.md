# Editor companion MVP review

Target: EB-01, with ED-01 / SY-01 metadata capture and SC-01 boundaries.
Pinned upstream: `dsh-v0.2.1-rc.2`, commit
`687f282e8625c6b8d11ff58211a90524be2e4317`.

## Delivered behavior

An independently packed `@dsh-vscode/editor-bridge` bundle registers
`vscode_get_editor_state` and strictly validated Remote methods. The native
sharing command grants the selected ordinary session access to its matching
workspace's editor metadata. The native status bar revokes access. Session,
workspace and connection changes revoke the volatile grant. One DSH process
supports one owner/session lease in this MVP.

The metadata allowlist includes a relative file name, language, document
version, unsaved flag, one-based UTF-16 selection and cached error/warning
counts. It excludes source, selected text, diagnostic bodies, absolute paths,
credentials and binding identities. The existing Webview protocol and rendering
need no privileged bridge routes.

The feature requires a managed local loopback runtime, one trusted local root
and a session whose authoritative cwd matches that root. Old runtimes and a
missing companion remain explicitly unavailable. No installer default changes,
external-process control or automatic bundle installation are introduced.

## Verification

Windows verification used the exact published runtime above, an isolated DSH
home/profile and an independent test workspace. No production profile or model
credentials were used.

- Contract/unit tests cover fixed RPCs, complete result validation, unknown
  fields, unavailable capability, cross-session/Peer ownership, concurrent
  requests, timeouts, cancellation, lease expiry, duplicate/late replies,
  metadata allowlists, links escaping the workspace and native Host revocation.
- `tests/live-dsh/editor-bridge.spec.ts` installed the packed tarball through
  the real CLI into its test-owned `web` profile, booted that profile and used
  an actual Agent, verified its tool catalogue and used the public tool execution
  pipeline to request/reply to an editor-state call. It also verified conflicts,
  cancellation and detach.
- Installation used the public CLI's installation-owned package-manager option
  to select the repository's pnpm in a test-only launcher. The environment's
  other pnpm shim referenced a missing entry. No global package-manager
  configuration was changed.
- `tests/vscode-e2e/editor-bridge.ts` ran against the locally installed VS Code.
  The real metadata provider observed an unsaved document, version changes,
  selection and diagnostic collection, rejected cancellation and a revoked
  grant, and returned no source/diagnostic body. The runner used disposable
  user data and a test-owned workspace.
- The packed archive contains the bundle patch, built module, manifest, README
  and MIT license, with no workspace source dependency in the runtime module.
- `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build` and
  `git diff --check` passed. The full check passed 4,184 tests across 386 files;
  the 31 tests skipped by that command include the separately run live
  probe above. The existing Webview chunk-size warning remains in the build.

Reproduce the isolated runtime path after packing the bundle:

```powershell
pnpm --filter @dsh-vscode/editor-bridge pack --pack-destination artifacts
$env:DSH_LIVE_SMOKE = '1'
$env:DSH_LIVE_RUNTIME_VERSION = '0.2.1-rc.2'
$env:DSH_LIVE_RUNTIME = '<absolute path to an installed runtime executable>'
$env:DSH_EDITOR_BRIDGE_BUNDLE = '<absolute path to the packed tarball>'
# Optional: select a working pnpm entry through DSH's public runCli option.
$env:DSH_EDITOR_BRIDGE_PNPM = '<absolute path to pnpm.cjs>'
pnpm exec vitest run tests/live-dsh/editor-bridge.spec.ts
```

Reproduce the separate real VS Code API path:

```powershell
$env:DSH_VSCODE_E2E_EXECUTABLE = '<absolute path to a local VS Code executable>'
pnpm exec node --experimental-strip-types tests/vscode-e2e/editor-bridge.ts
```

## Evidence limits

The DSH test executes the actual registered tool through an actual Agent, but
the tool call is initiated by an isolated test-only Remote rather than an LLM.
Its editor response is a fixture. The VS Code test separately exercises the
actual editor metadata provider. These do not constitute a single model-driven
VS Code conversation or manual acceptance of menu/status-bar interaction.
EB-01 remains `PARTIAL`; remote execution environments, multiple roots,
external runtimes and other DSH versions are outside its supported scope.
