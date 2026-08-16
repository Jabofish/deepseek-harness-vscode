# VS Code end-to-end suite

TODO(implementation): use `@vscode/test-electron` to launch the extension against a temporary workspace and a deterministic fake DSH server.

Required scenarios:

1. The Activity Bar container opens and the view can be moved to the Secondary Side Bar.
2. Missing DSH renders the bottom action area; no installation starts automatically.
3. A running fake server is attached and no spawn call occurs.
4. New session, streaming, permission, question, model, provider, job, goal, and subagent flows traverse the versioned protocol.
5. Reload and reconnect restore non-sensitive UI selection but no prompt or credential data.
6. External processes survive extension shutdown; extension-owned fixture processes exit.

The suite must create and remove only its own temporary workspace and process fixtures.
