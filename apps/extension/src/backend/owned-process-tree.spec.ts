import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileLockScript, stopFixtureChild, waitForFixtureOutput } from './windows-file-lock.fixture.js'
import { terminateOwnedWindowsTree } from './owned-process-tree.js'

describe('owned Windows process tree shutdown', () => {
  it.skipIf(process.platform !== 'win32')(
    'releases a descendant file lock without terminating an unrelated process',
    async () => {
      const root = await fs.mkdtemp(path.join(tmpdir(), 'dsh-owned-lock-'))
      const directory = path.join(root, 'package')
      await fs.mkdir(directory)
      const file = path.join(directory, 'locked.js')
      await fs.writeFile(file, 'old runtime')
      const powershell = path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      )
      const owner = spawn(
        process.execPath,
        [
          '-e',
          [
            `const child = require('node:child_process').spawn(${JSON.stringify(powershell)}, ${JSON.stringify(['-NoProfile', '-NonInteractive', '-Command', fileLockScript])}, {windowsHide:true, shell:false, env:process.env})`,
            'child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); setInterval(() => {}, 1000)',
          ].join('; '),
        ],
        { windowsHide: true, env: { ...process.env, DSH_TEST_LOCK_FILE: file } },
      )
      const external = spawn(process.execPath, ['-e', "console.log('locked');setInterval(() => {}, 1000)"], {
        windowsHide: true,
      })
      try {
        await Promise.all([waitForFixtureOutput(owner), waitForFixtureOutput(external)])
        await expect(fs.rename(directory, path.join(root, 'retired'))).rejects.toMatchObject({
          code: 'EPERM',
        })
        const started = Date.now()
        await terminateOwnedWindowsTree(owner)
        const deadline = Date.now() + 2_000
        for (;;) {
          try {
            await fs.rename(directory, path.join(root, 'retired'))
            break
          } catch (cause) {
            if (Date.now() >= deadline) throw cause
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        }
        expect(external.exitCode).toBeNull()
        expect(await fs.readFile(path.join(root, 'retired', 'locked.js'), 'utf8')).toBe('old runtime')
        console.info(
          `Windows owned-tree shutdown and file-lock release: ${Date.now() - started}ms; unrelated process preserved`,
        )
      } finally {
        await terminateOwnedWindowsTree(owner).catch(() => undefined)
        await Promise.all([stopFixtureChild(owner), stopFixtureChild(external)])
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5 })
      }
    },
    20_000,
  )
})
