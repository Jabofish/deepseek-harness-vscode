# Live DSH smoke

Opt-in level-3 evidence run for the connection story. Unlike the unit and
contract suites, this drives a real DSH process through the extension's own
managed launch contract, probe and versioned adapter:

- `DshProcessSupervisor` + `managedWebArguments` start `dsh --profile web
--no-open --host 127.0.0.1 --port <free port>` in a throwaway workspace and
  read the ready endpoint from the process output.
- The launch URL is exchanged for its session cookie exactly like the
  Extension Host does, so the managed web profile's authorized RPC surface is
  reachable.
- `VersionedBackendProbe` selects the adapter for the running build and
  `VersionedBackendFactory` connects it; the run reads `session.list` and
  `workspace.list`, subscribes once, closes the backend, stops its own process
  and asserts the loopback port is released.

The test only ever signals the process it started itself; an external DSH is
never touched. It is skipped unless explicitly enabled:

```powershell
$env:DSH_LIVE_SMOKE = '1'
$env:DSH_LIVE_RUNTIME = 'dsh.cmd'                                     # optional; defaults to `dsh` on PATH
$env:DSH_LIVE_RUNTIME_VERSION = '0.1.5-rc.1'                          # optional; defaults to the pinned runtime
pnpm exec vitest run tests/live-dsh
```

The specs that drive a real host read the same two variables inside
`startManagedRuntime`, so `run.spec.ts`, `surfaces.spec.ts`,
`transcript.spec.ts`, `writes.spec.ts`, `frames.spec.ts`, `paging.spec.ts`,
`attachment.spec.ts`, `export.spec.ts`, `change-hunks.spec.ts`,
`tool-cards.spec.ts`, `subagent-child.spec.ts`, `consistency.spec.ts` and
`skill-document.spec.ts`, `permission-catalog.spec.ts` and
`binary-upload.spec.ts` always launch the same build, and the printed probe
line names the exact adapter selected for that version hint. Two specs never
start a runtime: `runtime.spec.ts` pins the bare-name PATH resolution and
`managed-lock.spec.ts` pins the cross-process lock itself.

Seven of them exist for data-path evidence rather than a golden path:
`writes.spec.ts` commits real writes on a throwaway home, `frames.spec.ts`
probes the verbs that a short-lived client would otherwise never send —
`session.prompt` (with and without an attached image), `session.cancel`,
`session.fork`, `session.attachment`, `commands.execute` with an attached
image, `messageFeedback.put` — plus the preset and model pickers, which it
applies and reads back, and `paging.spec.ts` walks a real Session backwards
through the "load older" cursor until the first durable sequence;
`attachment.spec.ts` sends its own 2x1 PNG and reads the durable row back (a
1x1 probe could not tell a swapped width from a swapped height, and the
Webview sizes a single-image thumbnail by that ratio), `export.spec.ts`
exports a real session as JSON — the only end-to-end walk of the paging
contract — and as the Host's ZIP archive, `change-hunks.spec.ts` holds every
hunk a real runtime persisted for one file to the
`change.diffs.length === presentation.diffs.length` invariant, and
`tool-cards.spec.ts` scans the registry for a session that really holds a
first-party shell or mutation call and asserts the cards derived for those
rows, so it needs a profile carrying such a call and fails rather than passing
vacuously when there is none. The
un-sendable verbs are aimed at an identity the host must reject (an absent
session, message or attachment), so the call still crosses the real transport,
the real descriptor validation and the real error mapping. A refusal answered
in the host's own business vocabulary (`session-not-found`, `target-not-found`,
`attachment-error`, `fork-unavailable`) is the expected outcome; a
`gateway/arguments-invalid` decode code or a `PROTOCOL_ERROR` means the frame,
not the request, was wrong.

Vitest runs those spec files in parallel by default, and one machine cannot boot
three DSH processes inside the managed start's 15s readiness budget, so a
`DSH_LIVE_SMOKE=1` run turns file parallelism off (`vitest.config.ts`) and the
files run one after another. Each spec keeps its whole timeout budget for host
work instead of spending it on a start queue.

`startManagedRuntime` still takes an advisory cross-process lock
(`managed-lock.ts`) for the lifetime of its own runtime. Inside one run it is
uncontended; it is the guard for a second shell starting its own managed DSH
while this run is live. A lock whose owner process is gone is reclaimed, a wait
longer than 30s fails with the owner's pid instead of a bare test timeout, and
the lock file lives next to the other throwaway live artifacts in the OS temp
directory.

`DSH_LIVE_RUNTIME` accepts either an explicit path or a bare command name. A
bare name is resolved through `PATH` with the runtime locator's candidate order
(`dsh.cmd`, `dsh.bat`, `dsh.exe`, `dsh` on Windows), because `shell: false`
cannot launch a `.cmd` shim and the resulting `ENOENT` used to surface as a
readiness timeout. `runtime.spec.ts` guards that resolution without needing an
installed DSH.

A bare command name is not the only hazard: `shell: false` rejects a `.cmd`
path outright with a synchronous `EINVAL`. Only an explicit path that the shim
resolver can unwrap (or a command Node can execute directly) works, which is
exactly what `resolveLiveRuntime` produces.

Passing this run is evidence for the managed start path, endpoint discovery,
exact adapter selection and owned-process teardown. It does **not** by itself
promote a capability to `DONE`: the Webview leg (a real VS Code window rendering
the transcript) is still covered only by the opt-in Electron suite.
