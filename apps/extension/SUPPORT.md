# Support

Before opening an issue, please verify:

- You are using VS Code `1.125+`.
- A supported DeepSeek Harness is installed (the guided install and the installer action use the
  exact version `0.1.5-rc.2`; other known releases have their own adapters, and an unknown version is
  probed read-only with a compatibility warning), or you completed the guided install in the view.
- DSH and the VS Code Extension Host run on the same machine.

If the problem persists, open a
[GitHub Issue](https://github.com/Jabofish/deepseek-harness-vscode/issues) with:

1. Your OS, VS Code version, and DSH version (`dsh --version`).
2. Reproduction steps and the expected versus actual result.
3. The extension's redacted diagnostics (command `DSH: Show Redacted Diagnostics`).

Never include API keys, passwords, access tokens, full prompts, or other private data.
