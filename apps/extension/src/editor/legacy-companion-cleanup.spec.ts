import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { it, expect } from 'vitest'
import { cleanupLegacyCompanion } from './legacy-companion-cleanup.js'

it('removes both known loader generations while retaining archives and unrelated files', async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), 'companion-cleanup-'))
  const root = path.join(storage, 'editor-companion', 'runtime')
  try {
    for (const [id, factory] of [
      ['a'.repeat(24), true],
      ['b'.repeat(24), false],
      ['c'.repeat(24), true],
    ] as const) {
      const directory = path.join(root, id)
      await mkdir(directory, { recursive: true })
      await writeFile(
        path.join(directory, 'loader.mjs'),
        "export const name = 'vscode-editor-bridge'; loadCompanion(runtimeRequire)",
      )
      await writeFile(
        path.join(directory, 'companion.patch.yml'),
        `- insert:\n    - id: vscode-editor-bridge${factory ? '' : '-managed'}\n      name: ${JSON.stringify(path.join(directory, 'loader.mjs').replaceAll('\\', '/'))}\n`,
      )
      if (factory) await writeFile(path.join(directory, 'companion.mjs'), 'generated factory')
      if (id.startsWith('c')) await writeFile(path.join(directory, 'keep.txt'), 'user content')
    }
    const archives = path.join(storage, 'editor-companion', 'archives')
    await mkdir(archives)
    await writeFile(path.join(archives, 'backup.tgz'), 'recovery archive')
    expect(await cleanupLegacyCompanion(storage)).toBe(2)
    expect(await readdir(root)).toEqual(['c'.repeat(24)])
    expect(await readFile(path.join(archives, 'backup.tgz'), 'utf8')).toBe('recovery archive')
    expect(await cleanupLegacyCompanion(storage)).toBe(0)
  } finally {
    await rm(storage, { recursive: true, force: true })
  }
})
