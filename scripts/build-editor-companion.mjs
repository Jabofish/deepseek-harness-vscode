import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const staging = await mkdtemp(path.join(os.tmpdir(), 'dsh-editor-companion-build-'))
try {
  const pnpm = process.env.npm_execpath
  if (pnpm === undefined || !/\.(?:c?js|mjs)$/u.test(pnpm))
    throw new Error('Run the build through pnpm so its executable entry is explicit.')
  const result = spawnSync(
    process.execPath,
    [pnpm, '--filter', '@dsh-vscode/editor-bridge', 'pack', '--pack-destination', staging],
    { cwd: root, shell: false, stdio: 'inherit' },
  )
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error('The editor companion bundle could not be packed.')
  const manifest = JSON.parse(
    await readFile(path.join(root, 'packages/dsh-editor-bridge/package.json'), 'utf8'),
  )
  const resources = path.join(root, 'apps/extension/resources')
  await mkdir(resources, { recursive: true })
  await copyFile(
    path.join(staging, `dsh-vscode-editor-bridge-${manifest.version}.tgz`),
    path.join(resources, 'editor-companion.tgz'),
  )
} finally {
  await rm(staging, { recursive: true, force: true })
}
