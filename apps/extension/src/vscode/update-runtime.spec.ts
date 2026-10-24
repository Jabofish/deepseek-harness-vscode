import { describe, expect, it, vi } from 'vitest'
import { type DshRuntime, type DshRuntimeUpdateProgress } from '@dsh-vscode/domain'

import {
  compareVersions,
  DshRuntimeUpdater,
  isDshPackageVersion,
  parseNpmMetadata,
  type ExecuteRuntimeCommand,
} from './update-runtime.js'

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
): DshRuntimeUpdater {
  return new DshRuntimeUpdater({
    npmExecutable: () => 'npm.cmd',
    locateRuntime: () => Promise.resolve(current),
    execute,
    ...(onProgress === undefined ? {} : { onProgress }),
    environment: () => ({ PATH: 'test-path' }),
    now: () => new Date('2026-08-21T00:00:00.000Z'),
  })
}

describe('DshRuntimeUpdater', () => {
  it('returns the verified installed package even if the optional executable scan hangs', async () => {
    vi.useFakeTimers()
    let installed = '0.1.0-rc.6'
    let lookups = 0
    let probeSignal: AbortSignal | undefined
    const subject = new DshRuntimeUpdater({
      npmExecutable: () => 'npm',
      activeVersion: () => '0.1.0-rc.6',
      locateRuntime: (signal) => {
        if (++lookups === 1) return Promise.resolve(runtime())
        probeSignal = signal
        return new Promise(() => undefined)
      },
      execute: async (_executable, args) => {
        await Promise.resolve()
        if (args[0] === 'view') return { stdout: metadata, stderr: '' }
        if (args[0] === 'install') installed = '0.1.0-rc.8'
        return {
          stdout: JSON.stringify({ dependencies: { '@deepseek-ai/dsh': { version: installed } } }),
          stderr: '',
        }
      },
    })
    try {
      const result = subject.installVersion('0.1.0-rc.8')
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(result).resolves.toMatchObject({
        status: 'ready',
        globalVersion: installed,
        restartRequired: true,
      })
      expect(probeSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports verification failure when npm succeeds but the requested version is missing', async () => {
    const phases: string[] = []
    const execute: ExecuteRuntimeCommand = async (_executable, args) => {
      await Promise.resolve()
      return { stdout: args[0] === 'view' ? metadata : '{}', stderr: 'npm warn EBADENGINE' }
    }
    await expect(
      updater(execute, runtime(), (value) => phases.push(value.phase)).installVersion('0.1.0-rc.8'),
    ).rejects.toMatchObject({ context: { reason: 'verify-failed' } })
    expect(phases.at(-1)).toBe('failed')
  })

  it('publishes the verified final version after a successful install with engine and cleanup warnings', async () => {
    let installed = '0.1.0-rc.6'
    const progress: DshRuntimeUpdateProgress[] = []
    const execute: ExecuteRuntimeCommand = async (_executable, args) => {
      await Promise.resolve()
      if (args[0] === 'view') return { stdout: metadata, stderr: '' }
      if (args[0] === 'install') {
        expect(args).not.toContain('--engine-strict')
        installed = '0.1.0-rc.8'
        return {
          stdout: 'added 1 package, and changed 612 packages',
          stderr: 'npm warn EBADENGINE Unsupported engine\nnpm warn cleanup EPERM',
        }
      }
      return {
        stdout: JSON.stringify({ dependencies: { '@deepseek-ai/dsh': { version: installed } } }),
        stderr: 'npm warn cleanup EPERM',
      }
    }
    const result = await updater(execute, runtime(), (value) => progress.push(value)).installVersion(
      '0.1.0-rc.8',
    )
    expect(result).toMatchObject({
      status: 'ready',
      globalVersion: installed,
      updateAvailable: false,
      restartRequired: true,
    })
    expect(progress.at(-1)).toMatchObject({
      phase: 'completed',
      version: installed,
      snapshot: result,
    })
    expect(progress.some((value) => value.phase === 'failed')).toBe(false)
  })
  it('ignores an old check completing after installation and shares concurrent installs', async () => {
    let release!: (value: { stdout: string; stderr: string }) => void
    let views = 0
    let installs = 0
    let installed = '0.1.0-rc.6'
    const phases: string[] = []
    const execute: ExecuteRuntimeCommand = async (_executable, args) => {
      if (args[0] === 'view') {
        if (++views === 1)
          return new Promise((resolve) => {
            release = resolve
          })
        return { stdout: metadata, stderr: '' }
      }
      if (args[0] === 'install') {
        installs++
        installed = '0.1.0-rc.8'
      }
      return {
        stdout: JSON.stringify({ dependencies: { '@deepseek-ai/dsh': { version: installed } } }),
        stderr: '',
      }
    }
    const subject = updater(execute, runtime(), (progress) => phases.push(progress.phase))
    const old = subject.checkForUpdates(true)
    const installation = subject.installVersion('0.1.0-rc.8')
    expect(subject.installVersion('0.1.0-rc.8')).toBe(installation)
    expect(subject.checkForUpdates(true)).toBe(installation)
    await expect(subject.installVersion('0.1.0-rc.7')).rejects.toMatchObject({ code: 'BACKEND_BUSY' })
    await installation
    const settledPhases = [...phases]
    release({ stdout: metadata, stderr: '' })
    expect((await old).globalVersion).toBe('0.1.0-rc.8')
    expect((await subject.checkForUpdates()).globalVersion).toBe('0.1.0-rc.8')
    expect((await subject.checkForUpdates()).updateAvailable).toBe(false)
    expect(installs).toBe(1)
    expect(phases).toEqual(settledPhases)
  })

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

  it('invalidates the old snapshot after a failed mutation and permits retry', async () => {
    let installed = '0.1.0-rc.6'
    let broken = true
    const phases: string[] = []
    const execute: ExecuteRuntimeCommand = async (_executable, args) => {
      await Promise.resolve()
      if (args[0] === 'view') return { stdout: metadata, stderr: '' }
      if (args[0] === 'install') {
        if (broken) throw Object.assign(new Error('network failed'), { code: 'ETIMEDOUT' })
        installed = '0.1.0-rc.8'
      }
      return {
        stdout: JSON.stringify({ dependencies: { '@deepseek-ai/dsh': { version: installed } } }),
        stderr: '',
      }
    }
    const subject = updater(execute, runtime(), (progress) => phases.push(progress.phase))
    await subject.checkForUpdates()
    await expect(subject.installVersion('0.1.0-rc.8')).rejects.toMatchObject({
      context: { reason: 'install-failed' },
    })
    expect(phases.at(-1)).toBe('failed')
    broken = false
    expect((await subject.installVersion('0.1.0-rc.8')).globalVersion).toBe('0.1.0-rc.8')
  })
  it('parses and sorts the real upstream version shape without trusting dist-tags for ordering', () => {
    const parsed = parseNpmMetadata(metadata)

    expect(parsed.versions).toEqual(['0.1.0-rc.8', '0.1.0-rc.7', '0.1.0-rc.6', '0.0.1-rc.1'])
    expect(parsed.latestTagVersion).toBe('0.1.0-rc.7')
    expect(parsed.nextTagVersion).toBe('0.1.0-rc.8')
    expect(compareVersions('0.1.0-rc.8', '0.1.0-rc.7')).toBeGreaterThan(0)
    expect(isDshPackageVersion('0.1.0-rc.8')).toBe(true)
    expect(isDshPackageVersion('0.1.0-rc.8+build.01')).toBe(true)
    expect(isDshPackageVersion('0.1.0-rc.01')).toBe(false)
    expect(isDshPackageVersion('latest')).toBe(false)
    expect(isDshPackageVersion('0.1.0-rc.8 && whoami')).toBe(false)
  })

  it('rejects malformed numeric prerelease identifiers before npm commands', async () => {
    let commandCount = 0
    const execute: ExecuteRuntimeCommand = () => {
      commandCount += 1
      return Promise.resolve({ stdout: '', stderr: '' })
    }

    await expect(updater(execute).installVersion('0.1.0-rc.01')).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      context: { operation: 'runtime.update', reason: 'invalid-version' },
    })
    expect(commandCount).toBe(0)
  })

  it('accepts npm versions-only responses used by older update paths', () => {
    const parsed = parseNpmMetadata(JSON.stringify(['0.1.0-rc.6', '0.1.0-rc.8', '0.1.0-rc.7']))

    expect(parsed.versions).toEqual(['0.1.0-rc.8', '0.1.0-rc.7', '0.1.0-rc.6'])
    expect(parsed.latestTagVersion).toBeUndefined()
    expect(parsed.nextTagVersion).toBeUndefined()
  })

  it('accepts a single-version JSON response', () => {
    expect(parseNpmMetadata(JSON.stringify('0.1.0-rc.8')).versions).toEqual(['0.1.0-rc.8'])
  })

  it('checks npm metadata and reports an update without starting DSH', async () => {
    const calls: string[][] = []
    const execute: ExecuteRuntimeCommand = async (_executable, args) => {
      await Promise.resolve()
      calls.push([...args])
      if (args[0] === 'view') return { stdout: metadata, stderr: '' }
      if (args[0] === 'list')
        return {
          stdout: JSON.stringify({ dependencies: { '@deepseek-ai/dsh': { version: '0.1.0-rc.6' } } }),
          stderr: '',
        }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    }

    const snapshot = await updater(execute).checkForUpdates()

    expect(snapshot).toMatchObject({
      status: 'ready',
      currentVersion: '0.1.0-rc.6',
      globalVersion: '0.1.0-rc.6',
      latestVersion: '0.1.0-rc.8',
      latestTagVersion: '0.1.0-rc.7',
      nextTagVersion: '0.1.0-rc.8',
      updateAvailable: true,
    })
    expect(calls).toContainEqual(['view', '@deepseek-ai/dsh', 'versions', 'dist-tags', '--json'])
    expect(calls).toContainEqual(['list', '--global', '@deepseek-ai/dsh', '--depth=0', '--json'])
    expect(calls.some((args) => args[0] === 'dsh')).toBe(false)
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
      '--loglevel=info',
    ])
  })

  it('does not reinstall a version that is already the global package', async () => {
    const calls: string[][] = []
    const phases: string[] = []
    const execute: ExecuteRuntimeCommand = async (_executable, args) => {
      await Promise.resolve()
      calls.push([...args])
      if (args[0] === 'view') return { stdout: metadata, stderr: '' }
      if (args[0] === 'list')
        return {
          stdout: JSON.stringify({ dependencies: { '@deepseek-ai/dsh': { version: '0.1.0-rc.8' } } }),
          stderr: '',
        }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    }

    const snapshot = await updater(execute, runtime('0.1.0-rc.8'), (progress) =>
      phases.push(progress.phase),
    ).installVersion('0.1.0-rc.8')

    expect(snapshot.globalVersion).toBe('0.1.0-rc.8')
    expect(calls.some((args) => args[0] === 'install')).toBe(false)
    expect(phases).toEqual(['checking', 'completed'])
  })

  it('emits visible lifecycle phases while a real npm install is pending', async () => {
    let installed = '0.1.0-rc.6'
    const phases: string[] = []
    const execute: ExecuteRuntimeCommand = async (_executable, args) => {
      await Promise.resolve()
      if (args[0] === 'view') return { stdout: metadata, stderr: '' }
      if (args[0] === 'list')
        return {
          stdout: JSON.stringify({ dependencies: { '@deepseek-ai/dsh': { version: installed } } }),
          stderr: '',
        }
      if (args[0] === 'install') {
        installed = '0.1.0-rc.8'
        return { stdout: 'added packages', stderr: '' }
      }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    }

    await updater(execute, runtime(), (progress) => phases.push(progress.phase)).installVersion('0.1.0-rc.8')

    expect(phases).toEqual(expect.arrayContaining(['checking', 'downloading', 'verifying', 'completed']))
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

  it('returns a bounded unavailable snapshot for malformed registry data', async () => {
    const execute: ExecuteRuntimeCommand = async () => {
      await Promise.resolve()
      return { stdout: '{not-json', stderr: '' }
    }

    await expect(updater(execute).checkForUpdates()).resolves.toMatchObject({
      status: 'unavailable',
      availableVersions: [],
      updateAvailable: false,
      failure: 'invalid-response',
    })
  })

  it('classifies a valid JSON response with no DSH versions as invalid response data', async () => {
    const execute: ExecuteRuntimeCommand = async () => {
      await Promise.resolve()
      return { stdout: JSON.stringify({ versions: [] }), stderr: '' }
    }

    await expect(updater(execute).checkForUpdates()).resolves.toMatchObject({
      status: 'unavailable',
      availableVersions: [],
      updateAvailable: false,
      failure: 'invalid-response',
    })
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
})
