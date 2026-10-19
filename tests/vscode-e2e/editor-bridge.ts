import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { runTests } from '@vscode/test-electron'
import { resolveVscodeExecutable } from './vscode-executable.ts'

/** Actual VS Code API evidence, separate from the isolated DSH/tool-pipeline suite. */
export async function run(): Promise<void> {
  const executable = resolveVscodeExecutable(process.env.DSH_VSCODE_E2E_EXECUTABLE)
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-editor-vscode-'))
  const workspace = path.join(root, 'workspace')
  const bundle = path.join(root, 'editor-state.cjs')
  try {
    await mkdir(workspace)
    await build({
      stdin: {
        contents: `export { EditorStateProvider } from './apps/extension/src/editor/editor-state-provider.ts'; export { workspaceFolderId } from './apps/extension/src/editor/workspace-path-guard.ts'; export { EditorCompanionProvider } from './apps/extension/src/editor/editor-companion-provider.ts'; export { EditLedger } from './apps/extension/src/editor/edit-ledger.ts';`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['vscode'],
      outfile: bundle,
    })
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: path.resolve('apps/extension'),
      extensionTestsPath: fileURLToPath(new URL('./suite/editor-bridge.js', import.meta.url)),
      extensionTestsEnv: { ELECTRON_RUN_AS_NODE: undefined, DSH_EDITOR_STATE_TEST_BUNDLE: bundle },
      launchArgs: [
        workspace,
        '--user-data-dir',
        path.join(root, 'user-data'),
        '--disable-extensions',
        '--disable-gpu',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
      ],
    })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}
await run()
