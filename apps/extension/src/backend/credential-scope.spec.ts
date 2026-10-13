import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCredentialScope } from './credential-scope.js'

const roots: string[] = []
async function storage(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-credential-scope-'))
  roots.push(root)
  return path.join(root, 'host-storage')
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('execution environment credential identity', () => {
  it('persists one identity across concurrent windows and reloads while isolating other Hosts', async () => {
    const root = await storage()
    const firstWindow = createCredentialScope(root)
    const [first, second] = await Promise.all([firstWindow(), createCredentialScope(root)()])
    expect(first).toMatch(/^[a-f0-9]{32}$/u)
    expect(second).toBe(first)
    expect(await createCredentialScope(root)()).toBe(first)
    expect(await createCredentialScope(await storage())()).not.toBe(first)
    expect(await readdir(root)).toEqual(['external-connection-scope'])
  })
  it.each(['corrupt', 'oversized', 'directory'] as const)(
    'rejects a %s identity without replacing it or exposing its path',
    async (kind) => {
      const root = await storage()
      await mkdir(root)
      const target = path.join(root, 'external-connection-scope')
      if (kind === 'directory') await mkdir(target)
      else await writeFile(target, kind === 'corrupt' ? 'x'.repeat(32) : '0'.repeat(1024))
      await expect(createCredentialScope(root)()).rejects.toMatchObject({
        code: 'AUTH_REQUIRED',
        message: 'The execution environment could not be identified securely. Retry the connection.',
      })
      expect(await readdir(root)).toEqual(['external-connection-scope'])
    },
  )
})
