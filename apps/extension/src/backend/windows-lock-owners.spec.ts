import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { spawnFileLocker, stopFixtureChild, waitForFixtureOutput } from './windows-file-lock.fixture.js'
import { findWindowsLockOwners } from './windows-lock-owners.js'

describe('Windows lock owner diagnostics', () => {
  it.skipIf(process.platform !== 'win32')(
    'identifies the live file holder without closing it',
    async () => {
      const root = await fs.mkdtemp(path.join(tmpdir(), 'dsh-lock-owner-占用 空格-'))
      const file = path.join(root, 'locked $(unused).js')
      await fs.writeFile(file, 'locked module')
      const locker = spawnFileLocker(file)
      try {
        await waitForFixtureOutput(locker)
        const owners = await findWindowsLockOwners([root])
        expect(owners).toContainEqual({ pid: locker.pid, name: 'powershell' })
        expect(locker.exitCode).toBeNull()
      } finally {
        await stopFixtureChild(locker)
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5 })
      }
    },
    35_000,
  )
})
