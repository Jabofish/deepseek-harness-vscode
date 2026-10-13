import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'
import { build } from 'esbuild'
import { createImportMetaUrlPlugin } from '../../../apps/extension/esbuild-import-meta-url.mjs'

const destination = process.argv[2]
if (destination === undefined || !isAbsolute(destination))
  throw new Error('Provide an absolute destination for the test-only remote extension.')
await mkdir(destination, { recursive: true })
await build({
  entryPoints: ['tests/vscode-e2e/remote/smoke-extension.ts'],
  outfile: join(destination, 'extension.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  plugins: [createImportMetaUrlPlugin()],
})
await writeFile(
  join(destination, 'package.json'),
  JSON.stringify(
    {
      name: 'dsh-remote-fixture',
      publisher: 'dsh-test',
      version: '0.0.1',
      engines: { vscode: '^1.125.0' },
      extensionKind: ['workspace'],
      main: './extension.cjs',
      activationEvents: ['workspaceContains:.dsh-remote-fixture.json'],
    },
    null,
    2,
  ),
)
