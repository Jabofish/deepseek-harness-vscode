# DeepSeek Harness Companion for VS Code

Bring local [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sessions into VS Code. Follow streaming replies, thinking, tools, approvals, questions, and conversation history beside your code.

## Use the companion

- Create, switch, resume, and archive sessions by workspace.
- Send text, images, and supported files; reference files and sessions with `@`.
- Use the models, providers, permissions, and agent options supplied by the connected DSH.
- Open produced files through VS Code, and use local templates, checkpoints, Changes, and task views when available.

Available operations depend on the connected DSH runtime. Unsupported capabilities are shown explicitly; [exact compatibility and evidence](https://github.com/Jabofish/deepseek-harness-vscode/tree/main/docs) are documented in the repository.

## Get started

1. Open the **DeepSeek Harness** view.
2. If DSH is missing, use the guided installer or copy its exact install command. You can also select an existing executable.
3. Choose or create a workspace, start a session, and send a task.

The extension discovers compatible local instances before starting one. Connection modes let you attach only, start an isolated extension-owned instance, or probe one configured loopback endpoint. It never stops an external DSH. Runtime updates install a verified exact version and do not restart external processes.

## Privacy and help

DSH connections, credentials, file access, and process ownership stay in the VS Code Extension Host. The Webview receives no secrets or direct filesystem/network access; diagnostics are redacted.

- [Documentation and compatibility](https://github.com/Jabofish/deepseek-harness-vscode)
- [中文说明](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/README.zh-CN.md)
- [Version history](https://github.com/Jabofish/deepseek-harness-vscode/blob/main/apps/extension/CHANGELOG.md)
- [Support](https://github.com/Jabofish/deepseek-harness-vscode/issues)
