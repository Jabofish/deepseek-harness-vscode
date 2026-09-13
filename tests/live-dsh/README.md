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
$env:DSH_LIVE_RUNTIME = 'C:\Users\<you>\AppData\Roaming\npm\dsh.cmd'   # defaults to `dsh` on PATH
$env:DSH_LIVE_RUNTIME_VERSION = '0.1.5-rc.1'                          # defaults to the pinned runtime
npx vitest run tests/live-dsh/run.spec.ts
```

Recorded run (2026-09-13, Windows, `@deepseek-ai/dsh@0.1.5-rc.1`):

```text
[dsh-live-smoke] launch dsh.cmd --profile web --no-open --host 127.0.0.1 --port 45265
[dsh-live-smoke] login http://127.0.0.1:45265 status=303 cookie=exchanged
[dsh-live-smoke] managed start pid=21788 endpoint=http://127.0.0.1:45265
[dsh-live-smoke] probe dsh=0.1.5-rc.1 protocol=rc151 adapter=dsh-0.1.5-rc.1 mode=exact
[dsh-live-smoke] session.list 44 session(s)
[dsh-live-smoke] workspace.list 8 workspace(s)
[dsh-live-smoke] events.subscribe released
[dsh-live-smoke] backend closed
[dsh-live-smoke] managed stop port 45265 closed
```

Passing this run is evidence for the managed start path, endpoint discovery,
exact adapter selection and owned-process teardown. It does **not** by itself
promote a capability to `DONE`: the Webview leg (a real VS Code window rendering
the transcript) is still covered only by the opt-in Electron suite.
