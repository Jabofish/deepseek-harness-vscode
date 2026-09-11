# Security Policy

## Supported versions

Security fixes are only applied to the latest release line.

| Version                   | Supported |
| ------------------------- | --------- |
| latest release (`0.1.10`) | Yes       |
| older releases            | No        |

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting (the **Report a vulnerability** button on this
repository's **Security** tab) instead of a public issue. Include the extension version, the DSH
version (`dsh --version`), your platform, and a minimal reproduction.

**Never include API keys, passwords, access tokens, or prompt bodies** in a report.

## Scope notes

The extension's security model is documented in [docs/security.md](docs/security.md). Key
invariants that count as security boundaries:

- The Webview is untrusted: it never receives secrets, DSH endpoints, process handles, or direct
  filesystem/network access.
- DSH endpoints must be verified loopback addresses (`127.0.0.1` / `localhost`).
- Child processes are spawned with fixed executables and argument arrays, never through a shell.
- Logs follow a field allowlist with recursive redaction of prompt/body/token-like fields.
- External DSH processes are never stopped or restarted by the extension.

Reports about upstream DeepSeek Harness itself should go to the
[upstream repository](https://github.com/deepseek-ai/deepseek-harness).
