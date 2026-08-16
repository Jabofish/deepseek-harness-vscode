# VS Code end-to-end suite

`run.ts` launches the pinned minimum VS Code build through `@vscode/test-electron`, creates a unique workspace, and serves a loopback rc.6 fixture with HTTP RPC plus WebSocket event downlinks. The default fixture is attach-only, so the test proves that discovery/attach does not spawn a runtime. The suite owns and removes only its temporary workspace and fixture sockets.

The runner is opt-in. To avoid an implicit network download, provide a local VS Code executable:

```powershell
$env:DSH_VSCODE_E2E_EXECUTABLE = 'C:\path\to\Code.exe'
node --experimental-transform-types tests/vscode-e2e/run.ts
```

To exercise the real extension-owned startup path, add `DSH_VSCODE_E2E_MODE=managed`. The runtime is discovered from PATH by default; set `DSH_VSCODE_E2E_RUNTIME` only when a specific DSH executable is required. The suite also waits for the event downlinks after `dsh.connect`, so an asynchronous transport failure is not hidden by a fast command result.

Required scenarios:

1. The Activity Bar container opens and the view can be moved to the Secondary Side Bar.
2. Missing DSH renders the bottom action area; no installation starts automatically.
3. A running fake server is attached and no spawn call occurs.
4. New session, streaming, permission, question, model, provider, job, goal, and subagent flows traverse the versioned protocol.
5. Reload and reconnect restore non-sensitive UI selection but no prompt or credential data.
6. External processes survive extension shutdown; extension-owned fixture processes exit.

The remaining UI flows are covered by the protocol, adapter, timeline, and application unit tests; the Electron smoke runner is intentionally opt-in because it downloads and launches VS Code.
