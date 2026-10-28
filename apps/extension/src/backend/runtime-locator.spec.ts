import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { DshRuntimeLocator, readStoredRuntimePath } from './runtime-locator.js'

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
  it('rejects a selected executable that does not report a version', async () => {
    await expect(locator('   ').locate()).resolves.toMatchObject({ runtime: { supported: false } })
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
})

describe('DshRuntimeLocator caching', () => {
  function countingLocator(
    version: string,
    overrides?: {
      fileExists?: (candidate: string) => Promise<boolean>
      npmGlobalPrefix?: () => Promise<string | undefined>
      lastKnownRuntimePath?: () => { path: string; source: 'path' | 'npm-global' } | undefined
      rememberRuntimePath?: (hint: { path: string; source: 'path' | 'npm-global' }) => void
    },
  ): { locator: DshRuntimeLocator; versionCalls: () => number } {
    let versionCalls = 0
    const locator = new DshRuntimeLocator({
      os: testPlatform.os,
      configuredPath: () => undefined,
      pathEntries: () => [testPlatform.existingDirectory],
      npmGlobalPrefix: overrides?.npmGlobalPrefix ?? (() => Promise.resolve(undefined)),
      fileExists:
        overrides?.fileExists ??
        ((candidate) =>
          Promise.resolve(
            candidate ===
              testPlatform.pathApi.join(testPlatform.existingDirectory, testPlatform.executableName),
          )),
      executeVersion: () => {
        versionCalls += 1
        return Promise.resolve(version)
      },
      ...(overrides?.lastKnownRuntimePath === undefined
        ? {}
        : { lastKnownRuntimePath: overrides.lastKnownRuntimePath }),
      ...(overrides?.rememberRuntimePath === undefined
        ? {}
        : { rememberRuntimePath: overrides.rememberRuntimePath }),
    })
    return { locator, versionCalls: () => versionCalls }
  }

  it('uses the persisted path hint and re-probes its version before trusting it', async () => {
    const hintPath = testPlatform.pathApi.join(testPlatform.existingDirectory, testPlatform.executableName)
    const remembered: { path: string; source: 'path' | 'npm-global' }[] = []
    const { locator, versionCalls } = countingLocator('0.1.1-rc.2', {
      fileExists: (candidate) => Promise.resolve(candidate === hintPath),
      lastKnownRuntimePath: () => ({ path: hintPath, source: 'path' }),
      rememberRuntimePath: (hint) => remembered.push(hint),
    })

    await expect(locator.locate()).resolves.toMatchObject({
      runtime: { executable: hintPath, source: 'path', supported: true },
    })
    expect(versionCalls()).toBe(1)
    expect(remembered).toEqual([{ path: hintPath, source: 'path' }])
  })
})

describe('configured runtime confirmation', () => {
  it('skips the configured executable when the host confirmation is declined', async () => {
    const configured = testPlatform.pathApi.join(
      testPlatform.configuredDirectory,
      testPlatform.executableName,
    )
    const scanned = testPlatform.pathApi.join(testPlatform.existingDirectory, testPlatform.executableName)
    const runtime = new DshRuntimeLocator({
      os: testPlatform.os,
      configuredPath: () => configured,
      pathEntries: () => [testPlatform.existingDirectory],
      npmGlobalPrefix: () => Promise.resolve(undefined),
      fileExists: (candidate) => Promise.resolve(candidate === configured || candidate === scanned),
      executeVersion: (executable) =>
        Promise.resolve(executable === configured ? '0.1.1-rc.2' : '0.1.1-rc.1'),
      confirmRuntimePath: () => Promise.resolve(false),
    })

    await expect(runtime.locate()).resolves.toMatchObject({
      runtime: { executable: scanned, source: 'path' },
    })
  })
})

describe('local runtime candidates', () => {
  it.each(['\\\\server\\share\\dsh.cmd', '//server/share/dsh.cmd', '//?/UNC/server/share/dsh.cmd'])(
    'never accesses a network path from configuration, cache, PATH, npm or the file picker: %s',
    async (candidate) => {
      const fileExists = vi.fn(() => Promise.resolve(true))
      const executeVersion = vi.fn(() => Promise.resolve('0.2.1-rc.2'))
      const runtime = new DshRuntimeLocator({
        os: 'windows',
        configuredPath: () => candidate,
        pathEntries: () => [path.win32.dirname(candidate)],
        npmGlobalPrefix: () => Promise.resolve(path.win32.dirname(candidate)),
        lastKnownRuntimePath: () => ({ path: candidate, source: 'path' }),
        fileExists,
        executeVersion,
      })
      await expect(runtime.locate()).resolves.toMatchObject({ searchedLocations: [] })
      await expect(runtime.inspectExecutable(candidate)).rejects.toMatchObject({
        code: 'INVALID_CONFIGURATION',
      })
      expect(fileExists).not.toHaveBeenCalled()
      expect(executeVersion).not.toHaveBeenCalled()
    },
  )
})

describe('persisted runtime path hints', () => {
  it('drops relative paths, drive-relative spellings, unknown sources and malformed values', () => {
    expect(readStoredRuntimePath({ path: 'dsh', source: 'path' })).toBeUndefined()
    expect(readStoredRuntimePath({ path: 'bin/dsh', source: 'path' })).toBeUndefined()
    expect(readStoredRuntimePath({ path: 'C:tools\\dsh.cmd', source: 'path' })).toBeUndefined()
    expect(readStoredRuntimePath({ path: '/usr/bin/dsh', source: 'configured' })).toBeUndefined()
    expect(readStoredRuntimePath({ path: '   ', source: 'path' })).toBeUndefined()
    expect(readStoredRuntimePath(undefined)).toBeUndefined()
    expect(readStoredRuntimePath(['/usr/bin/dsh'])).toBeUndefined()
  })
})
