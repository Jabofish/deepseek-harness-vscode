import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installWindowsRuntime } from './windows-runtime-installation.js'
import type { RuntimeCommandOptions } from './update-runtime.js'
import { terminateOwnedWindowsTree } from '../backend/owned-process-tree.js'
import {
  spawnFileLocker,
  stopFixtureChild,
  waitForFixtureOutput,
} from '../backend/windows-file-lock.fixture.js'

const roots: string[] = []
const packagePath = path.join('node_modules', '@deepseek-ai', 'dsh')
const args = ['install', '--global', '@deepseek-ai/dsh@0.2.2-alpha.2', '--ignore-scripts']
const options = { timeout: 10_000, maxBuffer: 1024 }
const shims = ['dsh', 'dsh.cmd', 'dsh.ps1']

afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function writePackage(prefix: string, version: string): Promise<void> {
  const directory = path.join(prefix, packagePath)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: '@deepseek-ai/dsh',
      version,
      bin: { dsh: 'bin.js' },
    }),
  )
  await fs.writeFile(path.join(directory, 'bin.js'), `console.log(${JSON.stringify(version)})`)
  for (const shim of shims) await fs.writeFile(path.join(prefix, shim), `launcher ${version}`)
}

async function fixture(): Promise<{
  root: string
  version: () => Promise<string>
  dependencies: {
    execute: Parameters<typeof installWindowsRuntime>[2]['execute']
    verify: Parameters<typeof installWindowsRuntime>[2]['verify']
  }
}> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'dsh-install-'))
  roots.push(root)
  await writePackage(root, '0.2.1-rc.3')
  const version = async (): Promise<string> => {
    const value = JSON.parse(await fs.readFile(path.join(root, packagePath, 'package.json'), 'utf8')) as {
      version: string
    }
    return value.version
  }
  const dependencies = {
    execute: async (command: readonly string[], _options: RuntimeCommandOptions) => {
      if (command[0] === 'prefix') return { stdout: root, stderr: '' }
      const prefix = command[command.indexOf('--prefix') + 1]
      expect(prefix).toBeDefined()
      expect(prefix).not.toBe(root)
      expect(await version()).toBe('0.2.1-rc.3')
      await writePackage(prefix ?? '', '0.2.2-alpha.2')
      return { stdout: 'installed', stderr: '' }
    },
    verify: async (shim: string, expected: string) => {
      expect(await fs.readFile(shim, 'utf8')).toBe(`launcher ${expected}`)
    },
  }
  return { root, version, dependencies }
}

describe('transactional Windows DSH installation', () => {
  it.skipIf(process.platform !== 'win32')(
    'automatically releases an owned file lock and completes the update',
    async () => {
      const { root, version, dependencies } = await fixture()
      const locker = spawnFileLocker(path.join(root, packagePath, 'bin.js'))
      try {
        await waitForFixtureOutput(locker)
        await expect(
          fs.rename(path.join(root, packagePath), path.join(root, 'blocked')),
        ).rejects.toMatchObject({ code: 'EPERM' })
        await installWindowsRuntime(
          args,
          { ...options, beforeReplace: () => terminateOwnedWindowsTree(locker) },
          dependencies,
        )
        expect(await version()).toBe('0.2.2-alpha.2')
        expect(locker.exitCode !== null || locker.signalCode !== null).toBe(true)
        expect(await fs.readFile(path.join(root, 'dsh.cmd'), 'utf8')).toBe('launcher 0.2.2-alpha.2')
      } finally {
        await stopFixtureChild(locker)
      }
    },
    20_000,
  )
  it('completes verification and switching when the progress panel has closed', async () => {
    const { version, dependencies } = await fixture()
    await installWindowsRuntime(
      args,
      {
        ...options,
        onOutput: () => {
          throw new Error('output disposed')
        },
      },
      dependencies,
    )
    expect(await version()).toBe('0.2.2-alpha.2')
  })

  it.skipIf(process.platform !== 'win32')(
    'rolls back a partial launcher switch when another program locks the cmd entry',
    async () => {
      const { root, version, dependencies } = await fixture()
      const locker = spawnFileLocker(path.join(root, 'dsh.cmd'))
      try {
        await waitForFixtureOutput(locker)
        await expect(installWindowsRuntime(args, options, dependencies)).rejects.toMatchObject({
          code: 'BACKEND_BUSY',
        })
        expect(await version()).toBe('0.2.1-rc.3')
        for (const shim of shims)
          expect(await fs.readFile(path.join(root, shim), 'utf8')).toBe('launcher 0.2.1-rc.3')
        expect(locker.exitCode).toBeNull()
      } finally {
        await stopFixtureChild(locker)
      }
    },
    35_000,
  )
  it('preserves an unreadable recovery journal and its previous-package backup', async () => {
    const { root, dependencies } = await fixture()
    const work = path.join(root, '.dsh-vscode-update')
    await fs.mkdir(path.join(work, 'previous'), { recursive: true })
    await fs.writeFile(path.join(work, 'previous', 'keep'), 'recoverable old files')
    await fs.writeFile(path.join(work, 'journal.json'), '{}')
    await expect(installWindowsRuntime(args, options, dependencies)).rejects.toThrow('journal is invalid')
    expect(await fs.readFile(path.join(work, 'previous', 'keep'), 'utf8')).toBe('recoverable old files')
  })

  it('rejects linked global module directories without modifying their contents', async () => {
    const { root, dependencies } = await fixture()
    const shared = path.join(root, 'shared')
    await fs.rename(path.join(root, 'node_modules'), shared)
    await fs.symlink(
      shared,
      path.join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await expect(installWindowsRuntime(args, options, dependencies)).rejects.toThrow('unexpected link')
    const previous = await fs.readFile(path.join(shared, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')
    expect(JSON.parse(previous)).toMatchObject({ version: '0.2.1-rc.3' })
  })
  it.skipIf(process.platform !== 'win32')(
    'bounds a real external file lock, preserves the old CLI, and succeeds after release',
    async () => {
      const { root, version, dependencies } = await fixture()
      const packageDirectory = path.join(root, packagePath)
      const locker = spawnFileLocker(path.join(packageDirectory, 'bin.js'))
      try {
        await waitForFixtureOutput(locker)
        // Establish the actual Windows sharing violation before exercising the fix.
        await expect(fs.rename(packageDirectory, path.join(root, 'blocked'))).rejects.toMatchObject({
          code: 'EPERM',
        })
        const started = Date.now()
        let diagnostic = ''
        await expect(
          installWindowsRuntime(
            args,
            {
              ...options,
              onOutput: (text) => {
                diagnostic += text
              },
            },
            dependencies,
          ),
        ).rejects.toMatchObject({
          code: 'BACKEND_BUSY',
          context: { reason: 'files-in-use' },
        })
        const elapsed = Date.now() - started
        expect(elapsed).toBeLessThan(25_000)
        expect(await version()).toBe('0.2.1-rc.3')
        expect(await fs.readFile(path.join(root, 'dsh.cmd'), 'utf8')).toBe('launcher 0.2.1-rc.3')
        expect(locker.exitCode).toBeNull()
        expect(diagnostic).toContain(`powershell (PID ${locker.pid})`)
        console.info(
          `Windows external file-lock rejection: ${elapsed}ms; old package and external process preserved`,
        )
      } finally {
        await stopFixtureChild(locker)
      }
      await installWindowsRuntime(args, options, dependencies)
      expect(await version()).toBe('0.2.2-alpha.2')
    },
    35_000,
  )
  it('verifies staging before stopping DSH, then switches the package and all global launchers', async () => {
    const { root, version, dependencies } = await fixture()
    let staged = false
    const verify = dependencies.verify
    dependencies.verify = async (shim, expected) => {
      await verify(shim, expected)
      staged = true
    }
    await installWindowsRuntime(
      args,
      {
        ...options,
        beforeReplace: async () => {
          expect(staged).toBe(true)
          expect(await version()).toBe('0.2.1-rc.3')
        },
      },
      dependencies,
    )
    expect(await version()).toBe('0.2.2-alpha.2')
    for (const shim of shims)
      expect(await fs.readFile(path.join(root, shim), 'utf8')).toBe('launcher 0.2.2-alpha.2')
  })

  it('restores the original package and launchers when verification after switching fails', async () => {
    const { root, version, dependencies } = await fixture()
    dependencies.verify = (shim) =>
      shim === path.join(root, 'dsh.cmd') ? Promise.reject(new Error('new CLI is broken')) : Promise.resolve()
    await expect(installWindowsRuntime(args, options, dependencies)).rejects.toThrow('new CLI is broken')
    expect(await version()).toBe('0.2.1-rc.3')
    for (const shim of shims)
      expect(await fs.readFile(path.join(root, shim), 'utf8')).toBe('launcher 0.2.1-rc.3')
  })

  it.each(['download', 'metadata', 'verify', 'stop', 'cancel'] as const)(
    'keeps the old runtime usable on %s failure',
    async (failure) => {
      const { root, version, dependencies } = await fixture()
      const execute = dependencies.execute
      const controller = new AbortController()
      let stops = 0
      dependencies.execute = async (command, commandOptions) => {
        if (command[0] === 'install' && failure === 'download')
          throw Object.assign(new Error('network timeout'), { code: 'ETIMEDOUT' })
        const result = await execute(command, commandOptions)
        if (command[0] === 'install' && failure === 'metadata') {
          const prefix = command[command.indexOf('--prefix') + 1] ?? ''
          await fs.writeFile(path.join(prefix, packagePath, 'package.json'), '{}')
        }
        if (command[0] === 'install' && failure === 'cancel') controller.abort()
        return result
      }
      if (failure === 'verify') dependencies.verify = () => Promise.reject(new Error('staged CLI failed'))
      await expect(
        installWindowsRuntime(
          args,
          {
            ...options,
            signal: controller.signal,
            beforeReplace: () => {
              stops++
              return failure === 'stop'
                ? Promise.reject(new Error('owned tree did not stop'))
                : Promise.resolve()
            },
          },
          dependencies,
        ),
      ).rejects.toBeDefined()
      expect(await version()).toBe('0.2.1-rc.3')
      expect(stops).toBe(failure === 'stop' ? 1 : 0)
      expect(await fs.readFile(path.join(root, 'dsh.cmd'), 'utf8')).toBe('launcher 0.2.1-rc.3')
    },
  )

  it('serializes updates from separate extension hosts sharing the global prefix', async () => {
    const { version, dependencies } = await fixture()
    let started!: () => void
    let resume!: () => void
    const starting = new Promise<void>((resolve) => {
      started = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      resume = resolve
    })
    const execute = dependencies.execute
    const first = installWindowsRuntime(args, options, {
      ...dependencies,
      execute: async (command, commandOptions) => {
        if (command[0] === 'install') {
          started()
          await waiting
        }
        return execute(command, commandOptions)
      },
    })
    await starting
    try {
      await expect(installWindowsRuntime(args, options, dependencies)).rejects.toMatchObject({
        code: 'BACKEND_BUSY',
      })
      expect(await version()).toBe('0.2.1-rc.3')
    } finally {
      resume()
      await first
    }
  })

  it('recovers the old package and shims after an interrupted switch before attempting another download', async () => {
    const { root, version, dependencies } = await fixture()
    const work = path.join(root, '.dsh-vscode-update')
    await fs.mkdir(path.join(work, 'old-shims'), { recursive: true })
    await fs.mkdir(path.join(work, 'new-shims'))
    await fs.rename(path.join(root, packagePath), path.join(work, 'previous'))
    await writePackage(root, '0.2.2-alpha.2')
    for (const shim of shims) await fs.writeFile(path.join(work, 'old-shims', shim), 'launcher 0.2.1-rc.3')
    await fs.writeFile(
      path.join(work, 'journal.json'),
      JSON.stringify({ previousPackage: true, previousShims: [true, true, true], committed: false }),
    )
    dependencies.execute = async (command) => {
      if (command[0] === 'prefix') return { stdout: root, stderr: '' }
      expect(await version()).toBe('0.2.1-rc.3')
      expect(await fs.readFile(path.join(root, 'dsh.cmd'), 'utf8')).toBe('launcher 0.2.1-rc.3')
      throw new Error('stop after recovery')
    }
    await expect(installWindowsRuntime(args, options, dependencies)).rejects.toThrow('stop after recovery')
    expect(await version()).toBe('0.2.1-rc.3')
  })
})
