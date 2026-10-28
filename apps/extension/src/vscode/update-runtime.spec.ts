import { describe, expect, it } from 'vitest'
import { type DshRuntime, type DshRuntimeUpdateProgress } from '@dsh-vscode/domain'

import { DshRuntimeUpdater, type ExecuteRuntimeCommand } from './update-runtime.js'

const metadata = JSON.stringify({
  'dist-tags': { latest: '0.1.0-rc.7', next: '0.1.0-rc.8' },
  versions: ['0.0.1-rc.1', '0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8'],
})

function runtime(version = '0.1.0-rc.6'): DshRuntime {
  return {
    executable: 'C:\\dsh\\dsh.cmd',
    version,
    supported: true,
    compatibility: 'known',
    source: 'npm-global',
  }
}

function updater(
  execute: ExecuteRuntimeCommand,
  current = runtime(),
  onProgress?: (progress: DshRuntimeUpdateProgress) => void,
  prepareManagedUpdate?: () => Promise<(() => Promise<void>) | undefined>,
): DshRuntimeUpdater {
  return new DshRuntimeUpdater({
    npmExecutable: () => 'npm.cmd',
    locateRuntime: () => Promise.resolve(current),
    execute: async (executable, args, options) => {
      if (args[0] === 'install') await options.beforeReplace?.()
      return execute(executable, args, options)
    },
    ...(onProgress === undefined ? {} : { onProgress }),
    ...(prepareManagedUpdate === undefined ? {} : { prepareManagedUpdate }),
    environment: () => ({ PATH: 'test-path' }),
    now: () => new Date('2026-08-21T00:00:00.000Z'),
  })
}

describe('DshRuntimeUpdater', () => {
  it('rechecks global state before a mutation and accepts npm list JSON on a nonzero exit', async () => {
    let installed = '0.1.0-rc.6'
    let installs = 0
    const execute: ExecuteRuntimeCommand = async (_executable, args) => {
      await Promise.resolve()
      if (args[0] === 'view') return { stdout: metadata, stderr: '' }
      if (args[0] === 'install') installs++
      throw Object.assign(new Error('unrelated global dependency is invalid'), {
        stdout: JSON.stringify({ dependencies: { '@deepseek-ai/dsh': { version: installed } } }),
      })
    }
    const subject = updater(execute)
    await subject.checkForUpdates()
    installed = '0.1.0-rc.8'
    expect((await subject.installVersion('0.1.0-rc.8')).globalVersion).toBe(installed)
    expect(installs).toBe(0)
  })

  it('installs only a version present in the checked registry and verifies npm global state', async () => {
    const calls: string[][] = []
    let installed = '0.1.0-rc.6'
    const execute: ExecuteRuntimeCommand = async (_executable, args) => {
      await Promise.resolve()
      calls.push([...args])
      if (args[0] === 'view') return { stdout: metadata, stderr: '' }
      if (args[0] === 'list')
        return {
          stdout: JSON.stringify({ dependencies: { '@deepseek-ai/dsh': { version: installed } } }),
          stderr: '',
        }
      if (args[0] === 'install') {
        installed = args[2]?.split('@').at(-1) ?? installed
        return { stdout: 'added packages', stderr: '' }
      }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    }

    const snapshot = await updater(execute).installVersion('0.1.0-rc.8')

    expect(installed).toBe('0.1.0-rc.8')
    expect(snapshot.globalVersion).toBe('0.1.0-rc.8')
    expect(snapshot.restartRequired).toBe(true)
    expect(calls).toContainEqual([
      'install',
      '--global',
      '@deepseek-ai/dsh@0.1.0-rc.8',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--loglevel=info',
    ])
  })

  it('returns an authored network failure without forwarding npm diagnostics', async () => {
    const execute: ExecuteRuntimeCommand = async (_executable, args) => {
      await Promise.resolve()
      if (args[0] === 'view') return { stdout: metadata, stderr: '' }
      if (args[0] === 'list')
        return {
          stdout: JSON.stringify({ dependencies: { '@deepseek-ai/dsh': { version: '0.1.0-rc.6' } } }),
          stderr: '',
        }
      const failure = Object.assign(new Error('npm exited with code 1'), {
        stderr:
          'npm warn deprecated node-domexception@1.0.0: Use your platform native DOMException instead &#x20;\n' +
          'npm error code EAI_AGAIN\n' +
          'GET https://user:password@example.invalid/package failed token=secret-value',
      })
      throw failure
    }

    const failure = await updater(execute)
      .installVersion('0.1.0-rc.8')
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(failure).toMatchObject({
      context: { operation: 'runtime.update', reason: 'install-failed' },
    })
    const detail =
      typeof failure === 'object' && failure !== null && 'context' in failure
        ? (failure as { readonly context?: { readonly detail?: unknown } }).context?.detail
        : undefined
    expect(detail).toBeUndefined()
    expect((failure as Error).message).toContain('network')
    expect((failure as Error).message).not.toContain('secret-value')
  })

  it('rejects a requested version that was not returned by the registry', async () => {
    const phases: string[] = []
    const execute: ExecuteRuntimeCommand = async (_executable, args) => {
      await Promise.resolve()
      if (args[0] === 'view') return { stdout: metadata, stderr: '' }
      if (args[0] === 'list') return { stdout: '{}', stderr: '' }
      throw new Error('install must not run')
    }

    await expect(
      updater(execute, runtime(), (progress) => phases.push(progress.phase)).installVersion('0.1.0-rc.999'),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      context: { operation: 'runtime.update', reason: 'metadata-unavailable' },
    })
    expect(phases).toContain('failed')
  })

  it('stops the managed runtime before npm and resumes it before verification', async () => {
    const events: string[] = []
    let installed = '0.1.0-rc.6'
    const execute: ExecuteRuntimeCommand = async (_executable, args) => {
      await Promise.resolve()
      if (args[0] === 'view') return { stdout: metadata, stderr: '' }
      if (args[0] === 'list') {
        events.push(`list:${installed}`)
        return {
          stdout: JSON.stringify({ dependencies: { '@deepseek-ai/dsh': { version: installed } } }),
          stderr: '',
        }
      }
      if (args[0] === 'install') {
        events.push('install')
        installed = args[2]?.split('@').at(-1) ?? installed
        return { stdout: 'added packages', stderr: '' }
      }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    }
    const prepareManagedUpdate = (): Promise<() => Promise<void>> => {
      events.push('prepare')
      return Promise.resolve(() => {
        events.push('resume')
        return Promise.resolve()
      })
    }

    const snapshot = await updater(execute, runtime(), undefined, prepareManagedUpdate).installVersion(
      '0.1.0-rc.8',
    )

    expect(events.indexOf('prepare')).toBeLessThan(events.indexOf('install'))
    expect(events.indexOf('install')).toBeLessThan(events.indexOf('resume'))
    expect(events.indexOf('resume')).toBeLessThan(events.lastIndexOf('list:0.1.0-rc.8'))
    expect(snapshot.restartRequired).toBe(true)
  })

  it('resumes the managed runtime after npm fails', async () => {
    let resumed = 0
    const execute: ExecuteRuntimeCommand = async (_executable, args) => {
      await Promise.resolve()
      if (args[0] === 'view') return { stdout: metadata, stderr: '' }
      if (args[0] === 'list')
        return {
          stdout: JSON.stringify({ dependencies: { '@deepseek-ai/dsh': { version: '0.1.0-rc.6' } } }),
          stderr: '',
        }
      throw Object.assign(new Error('npm failed'), { stderr: 'npm error code EAI_AGAIN' })
    }
    const prepareManagedUpdate = (): Promise<() => Promise<void>> =>
      Promise.resolve(() => {
        resumed += 1
        return Promise.resolve()
      })

    await expect(
      updater(execute, runtime(), undefined, prepareManagedUpdate).installVersion('0.1.0-rc.8'),
    ).rejects.toMatchObject({
      context: { operation: 'runtime.update', reason: 'install-failed' },
    })
    expect(resumed).toBe(1)
  })
})
