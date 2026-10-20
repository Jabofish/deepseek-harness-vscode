import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const packageRoot = path.join(root, 'packages/dsh-editor-bridge')
const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
if (process.argv.includes('--package-only')) {
  const options = {
    entryPoints: [path.join(packageRoot, 'src/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['@deepseek-ai/*'],
    write: false,
    legalComments: 'inline',
  }
  const fingerprint = await build(options)
  const identity = createHash('sha256')
    .update(fingerprint.outputFiles[0].text)
    .update(JSON.stringify(manifest))
  for (const locale of ['en', 'zh'])
    identity.update(await readFile(path.join(packageRoot, 'locale', `${locale}.json`)))
  const buildId = identity.digest('hex')
  const output = await build({ ...options, define: { __DSH_EDITOR_BUILD_ID__: JSON.stringify(buildId) } })
  await mkdir(path.join(packageRoot, 'dist'), { recursive: true })
  await writeFile(path.join(packageRoot, 'dist/index.js'), output.outputFiles[0].text)
  await writeFile(path.join(packageRoot, 'dist/build.json'), JSON.stringify({ buildId }) + '\n')
} else {
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
    const resources = path.join(root, 'apps/extension/resources')
    await mkdir(resources, { recursive: true })
    await copyFile(
      path.join(staging, `dsh-vscode-editor-bridge-${manifest.version}.tgz`),
      path.join(resources, 'editor-companion.tgz'),
    )
    await copyFile(
      path.join(packageRoot, 'dist/build.json'),
      path.join(resources, 'editor-companion-build.json'),
    )
    await rm(path.join(resources, 'editor-companion-runtime.mjs'), { force: true })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
