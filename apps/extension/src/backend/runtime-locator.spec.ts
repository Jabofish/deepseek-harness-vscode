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
        version,
        supported: true,
        compatibility: 'known',
      })
    }
  })

  it('does not block a future DSH version before protocol probing', async () => {
    await expect(locator('0.1.0-rc.99').locate()).resolves.toMatchObject({
      version: '0.1.0-rc.99',
      supported: true,
      compatibility: 'unknown',
    })
  })

  it('keeps an unrecognized non-empty version label launchable for handshake fallback', async () => {
    await expect(locator('dsh-next-development').locate()).resolves.toMatchObject({
      version: 'dsh-next-development',
      supported: true,
      compatibility: 'unknown',
    })
  })

  it('rejects a selected executable that does not report a version', async () => {
    await expect(locator('   ').locate()).resolves.toMatchObject({ supported: false })
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

    await expect(runtime.locate()).resolves.toBeUndefined()
    expect(runtime.searchedLocations()).toEqual([existing])
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
      executable: existing,
      version: '0.1.1-rc.1',
      source: 'npm-global',
      supported: true,
    })
    expect(runtime.searchedLocations()).toEqual([existing])
  })
})
