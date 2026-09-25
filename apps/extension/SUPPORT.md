# Support

Before opening an issue, check that VS Code meets the extension manifest requirement, DSH is installed or the guided installer completes, and DSH runs on the same machine as the VS Code Extension Host. The [compatibility contract](../../docs/dsh-contract.md) records exact supported adapters and the installer default.

If the problem persists, open a [GitHub Issue](https://github.com/Jabofish/deepseek-harness-vscode/issues) with:

1. Your OS and the VS Code and DSH versions (`dsh --version`).
2. Reproduction steps, expected behavior, and actual behavior.
3. The extension's redacted diagnostics from **DSH: Show Redacted Diagnostics**.

Never include API keys, passwords, access tokens, full prompts, or other private data. Security vulnerabilities should use [private reporting](../../.github/SECURITY.md).
