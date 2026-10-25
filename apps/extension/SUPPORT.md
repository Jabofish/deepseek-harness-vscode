# Support

Use the [bug-report form](https://github.com/Jabofish/deepseek-harness-vscode/issues/new?template=bug_report.yml) with reproduction steps, diagnostics and any checks you tried. You can report launch or connection failures without running the contributor test suites.

## Check the environment

- Check the extension's VS Code requirement in its manifest, and record your installed extension version and **Help → About** information. Use the [user guide](https://github.com/Jabofish/deepseek-harness-vscode) for installation; [GitHub Release VSIX files](https://github.com/Jabofish/deepseek-harness-vscode/releases/latest) are available when the Marketplace listing cannot be used.
- In local `auto`, `attach-only` and `new-isolated` modes, DSH discovery/launch happens in the Extension Host environment. For Remote SSH, WSL and containers, install DSH on the workspace side.
- `custom` may connect to an explicitly chosen remote HTTP(S) origin. Verify the configured origin, exact runtime version and native authorisation; do not disable certificate checks or paste launch tokens into an issue. A remote custom server does not grant local workspace/editor access.
- For editor integration issues, include the companion's installed/enabled status, read-only setting and workspace trust state alongside the chat connection status.

The [compatibility contract](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/docs/dsh-contract.en.md) records supported Adapter identities and the installer default. Optional services depend on the connected profile; include any unavailable-service errors in the report.

## File a useful report

Search [existing issues](https://github.com/Jabofish/deepseek-harness-vscode/issues) before filing. Include what is available:

1. OS/architecture, local or remote workspace, VS Code and extension versions, exact `dsh --version` output (or “not installed”), and connection mode.
2. Minimal steps, expected and actual behaviour, whether it repeats after reconnect/reload, and whether one or several panels are affected. Use disposable/synthetic data for reproduction.
3. **DSH: Show Redacted Diagnostics**, if the command is available. Inspect the result before posting; remove residual private data. A short relevant excerpt is better than an entire log archive.
4. For UI issues, a redacted screenshot/recording plus language, theme, sidebar/editor layout, window width and relevant accessibility settings. For a performance issue, add approximate history size, visible/hidden panels and the workload; identify CPU time versus wall time if you measured them.
5. Checks already tried and their outcomes. Contributors can use the shared [test-result format](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/docs/quality.md#report-test-results) to record automated/manual results and blocked checks.

Never include API keys, passwords, launch URLs/tokens, full prompts, tool bodies or private paths in shared diagnostics or screenshots. Use the [security reporting policy](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/.github/SECURITY.md) for vulnerabilities; it includes a fallback when GitHub private reporting is unavailable. Contributor setup and tests are documented in [English](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/.github/CONTRIBUTING.md) and [简体中文](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/.github/CONTRIBUTING.zh-CN.md).

中文用户可直接使用中文反馈，无需先运行开发者测试。请记录版本、连接模式、复现步骤与观察结果；分享前检查脱敏输出，安全问题先确认私密报告渠道。
