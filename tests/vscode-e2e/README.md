# VS Code end-to-end suite

`run.ts` launches the pinned minimum VS Code build through `@vscode/test-electron`, creates a unique workspace, and serves a loopback rc.8-shaped fixture with HTTP RPC plus WebSocket event downlinks. The fixture includes the newer `host.describe.home` field while remaining useful for rc.6/rc.7 adapter regression. The default fixture is attach-only, so the test proves that discovery/attach does not spawn a runtime. The suite owns and removes only its temporary workspace and fixture sockets.

The runner is opt-in. To avoid an implicit network download, provide a local VS Code executable:

```powershell
$env:DSH_VSCODE_E2E_EXECUTABLE = '<path-to-Code.exe>'
node --experimental-transform-types tests/vscode-e2e/run.ts
```

To exercise the real extension-owned startup path, add `DSH_VSCODE_E2E_MODE=managed`. The runtime is discovered from PATH by default; set `DSH_VSCODE_E2E_RUNTIME` only when a specific DSH executable is required. The value may be a path or a bare command name (for example `dsh`); the runner resolves it through PATH before writing `dsh.runtime.executablePath`, a setting the extension accepts only as an absolute path.

The runner passes `--disable-workspace-trust`: the throwaway workspace must count as trusted, because the extension is required to refuse an automatic start in an untrusted folder.

To reproduce the invalid-settings scenario (see assertion 5 below):

```powershell
$env:DSH_VSCODE_E2E_EXECUTABLE = '<path-to-Code.exe>'
$env:DSH_VSCODE_E2E_INVALID_SETTINGS = '1'
node --experimental-transform-types tests/vscode-e2e/run.ts
```

## What the suite asserts today

1. The extension activates, and `dsh.connect`, `dsh.openInSecondarySidebar` and `dsh.openWebUi` are registered.
2. The Extension Host provides `WebSocket`.
3. Attach-only mode: the workspace settings were applied, and the extension host really used the fixture — `/api/events.mux` and `/api/events.host` were upgraded and at least one RPC method reached the fixture (`host.describe` in practice). The fixture counts this traffic; the suite polls `GET /__e2e/observations`. The runner repeats the same check after the window closes, so a suite that silently stops asking fails the run.
4. Managed mode: `dsh.connect` resolves inside the real Extension Host. The coordinator publishes and throws on every failure branch (no runtime, unsupported runtime, spawn failure, unreachable endpoint), so a resolved command means a real owned runtime was located, started, probed and attached.
5. With `DSH_VSCODE_E2E_INVALID_SETTINGS=1` the workspace is launched with a non-absolute `dsh.runtime.executablePath` instead. The suite then only asserts that the extension still activates, still contributes its commands, and reports the mistake on connect — an extension that reads settings while it activates instead fails to activate and needs a reload plus a manual settings edit to recover. The runner also skips the fixture-traffic check for this scenario.

## Acceptance scenarios still open

These are the remaining scenarios from the original acceptance list. They need UI-level observability the extension does not expose to tests yet (status or view state is not readable through the stable VS Code API), so they are not claimed here:

1. The Activity Bar container opens and the view can be moved to the Secondary Side Bar.
2. Missing DSH renders the bottom action area; no installation starts automatically.
3. New session, streaming, permission, question, model, provider, job, goal, and subagent flows traverse the versioned protocol.
4. Reload and reconnect restore non-sensitive UI selection but no prompt or credential data.
5. External processes survive extension shutdown; extension-owned fixture processes exit.

The remaining UI flows are covered by the protocol, adapter, timeline, and application unit tests; the Electron runner is intentionally opt-in because it downloads and launches VS Code.

Evidence is the test assertions and the exit code; never copy machine paths, ports, process ids or
raw run output into project documentation.
