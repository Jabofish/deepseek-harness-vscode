import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { DshRuntimeLocator } from './runtime-locator.js'

const testPlatform =
  process.platform === 'win32'
    ? {
        os: 'windows' as const,
        pathApi: path.win32,
        executableName: 'dsh.cmd',
        configuredDirectory: 'C:\\dsh',
        missingDirectory: 'C:\\missing',
        existingDirectory: 'C:\\Users\\alice\\AppData\\Roaming\\npm',
      }
    : {
        os: process.platform === 'darwin' ? ('macos' as const) : ('linux' as const),
        pathApi: path.posix,
        executableName: 'dsh',
        configuredDirectory: '/tmp/dsh',
        missingDirectory: '/missing',
        existingDirectory: '/home/alice/.local/bin',
      }

function locator(version: string): DshRuntimeLocator {
  return new DshRuntimeLocator({
    os: testPlatform.os,
    configuredPath: () =>
      testPlatform.pathApi.join(testPlatform.configuredDirectory, testPlatform.executableName),
    pathEntries: () => [],
    npmGlobalPrefix: () => Promise.resolve(undefined),
    fileExists: () => Promise.resolve(true),
    executeVersion: () => Promise.resolve(version),
  })
}

describe('DshRuntimeLocator compatibility policy', () => {
  it('keeps rc.6 through rc.2 as known launchable runtimes', async () => {
    for (const version of ['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.1', '0.1.1-rc.2']) {
      await expect(locator(version).locate()).resolves.toMatchObject({
        runtime: { version, supported: true, compatibility: 'known' },
      })
    }
  })

  it('does not block a future DSH version before protocol probing', async () => {
    await expect(locator('0.1.0-rc.99').locate()).resolves.toMatchObject({
      runtime: { version: '0.1.0-rc.99', supported: true, compatibility: 'unknown' },
    })
  })

  it('keeps an unrecognized non-empty version label launchable for handshake fallback', async () => {
    await expect(locator('dsh-next-development').locate()).resolves.toMatchObject({
      runtime: { version: 'dsh-next-development', supported: true, compatibility: 'unknown' },
    })
  })

  it('rejects a selected executable that does not report a version', async () => {
    await expect(locator('   ').locate()).resolves.toMatchObject({ runtime: { supported: false } })
  })

  it('aborts the underlying version probe when the caller cancels', async () => {
    let observedSignal: AbortSignal | undefined
    const controller = new AbortController()
    const runtime = new DshRuntimeLocator({
      os: 'windows',
      configuredPath: () => 'C:\\dsh\\dsh.cmd',
      pathEntries: () => [],
      npmGlobalPrefix: () => Promise.resolve(undefined),
      fileExists: () => Promise.resolve(true),
      executeVersion: (_executable, signal) => {
        observedSignal = signal
        return new Promise<string>(() => undefined)
      },
    })
    const pending = runtime.locate(controller.signal)
    await vi.waitFor(() => expect(observedSignal).toBeDefined())
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(observedSignal?.aborted).toBe(true)
  })

  it('preserves cancellation while resolving the npm-global prefix', async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    let release: (() => void) | undefined
    const runtime = new DshRuntimeLocator({
      os: 'windows',
      configuredPath: () => undefined,
      pathEntries: () => [],
      npmGlobalPrefix: (signal) =>
        new Promise<string | undefined>((resolve) => {
          observedSignal = signal
          release = () => resolve(undefined)
        }),
      fileExists: () => Promise.resolve(false),
      executeVersion: () => Promise.resolve('0.1.1-rc.2'),
    })

    const pending = runtime.locate(controller.signal)
    await vi.waitFor(() => expect(observedSignal).toBeDefined())
    controller.abort()
    release?.()

    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
  })

  it('does not turn a PATH probe timeout into a false DSH_NOT_FOUND result', async () => {
    vi.useFakeTimers()
    try {
      const existing = 'C:\\dsh-bin\\dsh.cmd'
      const runtime = new DshRuntimeLocator({
        os: 'windows',
        configuredPath: () => undefined,
        pathEntries: () => ['C:\\dsh-bin'],
        npmGlobalPrefix: () => Promise.resolve(undefined),
        fileExists: (candidate) => Promise.resolve(candidate === existing),
        executeVersion: () => new Promise<string>(() => undefined),
      })

      const pending = runtime.locate()
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'BACKEND_UNREACHABLE',
        context: { operation: 'runtime.version', timedOut: true },
      })
      await vi.advanceTimersByTimeAsync(3_000)

      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues to an npm-global runtime after a PATH probe timeout', async () => {
    vi.useFakeTimers()
    try {
      const pathCandidate = 'C:\\dsh-bin\\dsh.cmd'
      const npmCandidate = 'C:\\npm\\dsh.cmd'
      const runtime = new DshRuntimeLocator({
        os: 'windows',
        configuredPath: () => undefined,
        pathEntries: () => ['C:\\dsh-bin'],
        npmGlobalPrefix: () => Promise.resolve('C:\\npm'),
        fileExists: (candidate) => Promise.resolve(candidate === pathCandidate || candidate === npmCandidate),
        executeVersion: (executable) =>
          executable === pathCandidate ? new Promise<string>(() => undefined) : Promise.resolve('0.1.1-rc.2'),
      })

      const pending = runtime.locate()
      await vi.advanceTimersByTimeAsync(3_000)

      await expect(pending).resolves.toMatchObject({
        runtime: { executable: npmCandidate, source: 'npm-global', supported: true },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports only PATH candidates that actually exist', async () => {
    const existing = testPlatform.pathApi.join(testPlatform.existingDirectory, testPlatform.executableName)
    const runtime = new DshRuntimeLocator({
      os: testPlatform.os,
      configuredPath: () => undefined,
      pathEntries: () => [testPlatform.missingDirectory, testPlatform.existingDirectory],
      npmGlobalPrefix: () => Promise.resolve(undefined),
      fileExists: (candidate) => Promise.resolve(candidate === existing),
      executeVersion: () => Promise.reject(new Error('probe failed')),
    })

    await expect(runtime.locate()).resolves.toMatchObject({ searchedLocations: [existing] })
  })

  it('keeps searched locations isolated for concurrent lookups', async () => {
    const firstPath = testPlatform.pathApi.join(
      testPlatform.existingDirectory,
      'first',
      testPlatform.executableName,
    )
    const secondPath = testPlatform.pathApi.join(
      testPlatform.existingDirectory,
      'second',
      testPlatform.executableName,
    )
    let pathCall = 0
    let firstProbeStarted = false
    let releaseFirstProbe: (() => void) | undefined
    const firstProbe = new Promise<void>((resolve) => {
      releaseFirstProbe = resolve
    })
    const runtime = new DshRuntimeLocator({
      os: testPlatform.os,
      configuredPath: () => undefined,
      pathEntries: () => [
        pathCall++ === 0 ? testPlatform.pathApi.dirname(firstPath) : testPlatform.pathApi.dirname(secondPath),
      ],
      npmGlobalPrefix: () => Promise.resolve(undefined),
      fileExists: (candidate) => Promise.resolve(candidate === firstPath || candidate === secondPath),
      executeVersion: async (executable) => {
        if (executable === firstPath) {
          firstProbeStarted = true
          await firstProbe
          return '0.1.1-rc.2'
        }
        throw new Error('probe failed')
      },
    })

    const first = runtime.locate()
    await vi.waitFor(() => expect(firstProbeStarted).toBe(true))
    const second = runtime.locate()
    const secondResult = await second
    releaseFirstProbe?.()
    const firstResult = await first

    expect(firstResult.searchedLocations).toEqual([firstPath])
    expect(secondResult.searchedLocations).toEqual([secondPath])
  })

  it('finds the npm-global shim from npm prefix when the Extension Host PATH omits it', async () => {
    const npmPrefix =
      testPlatform.os === 'windows'
        ? testPlatform.existingDirectory
        : testPlatform.pathApi.dirname(testPlatform.existingDirectory)
    const existing =
      testPlatform.os === 'windows'
        ? testPlatform.pathApi.join(npmPrefix, testPlatform.executableName)
        : testPlatform.pathApi.join(npmPrefix, 'bin', testPlatform.executableName)
    const runtime = new DshRuntimeLocator({
      os: testPlatform.os,
      configuredPath: () => undefined,
      pathEntries: () => [testPlatform.pathApi.join(testPlatform.missingDirectory, 'system32')],
      npmGlobalPrefix: () => Promise.resolve(npmPrefix),
      fileExists: (candidate) => Promise.resolve(candidate === existing),
      executeVersion: () => Promise.resolve('0.1.1-rc.1'),
    })

    await expect(runtime.locate()).resolves.toMatchObject({
      runtime: {
        executable: existing,
        version: '0.1.1-rc.1',
        source: 'npm-global',
        supported: true,
      },
    })
    expect((await runtime.locate()).searchedLocations).toEqual([existing])
  })

  it('uses Windows path semantics and accepts non-cmd native candidates', async () => {
    const existing = 'C:\\Users\\alice\\AppData\\Roaming\\npm\\dsh.exe'
    const runtime = new DshRuntimeLocator({
      os: 'windows',
      configuredPath: () => undefined,
      pathEntries: () => ['C:\\Users\\alice\\AppData\\Roaming\\npm'],
      npmGlobalPrefix: () => Promise.resolve(undefined),
      fileExists: (candidate) => Promise.resolve(candidate === existing),
      executeVersion: () => Promise.resolve('0.1.1-rc.2'),
    })

    await expect(runtime.locate()).resolves.toMatchObject({
      runtime: {
        executable: existing,
        source: 'path',
        supported: true,
      },
    })
  })

  it('accepts an extensionless Windows executable from the npm prefix', async () => {
    const npmPrefix = 'C:\\Users\\alice\\AppData\\Roaming\\npm'
    const existing = `${npmPrefix}\\dsh`
    const runtime = new DshRuntimeLocator({
      os: 'windows',
      configuredPath: () => undefined,
      pathEntries: () => [],
      npmGlobalPrefix: () => Promise.resolve(npmPrefix),
      fileExists: (candidate) => Promise.resolve(candidate === existing),
      executeVersion: () => Promise.resolve('0.1.1-rc.2'),
    })

    await expect(runtime.locate()).resolves.toMatchObject({
      runtime: {
        executable: existing,
        source: 'npm-global',
        supported: true,
      },
    })
  })
})
