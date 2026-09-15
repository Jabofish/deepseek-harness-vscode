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
npx vitest run tests/live-dsh
```

Every spec in this directory reads the same two variables inside
`startManagedRuntime`, so `run.spec.ts`, `surfaces.spec.ts` and
`transcript.spec.ts` always launch the same build and the printed probe line
names the exact adapter selected for that version hint.

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
