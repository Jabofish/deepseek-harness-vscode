import { beforeEach, expect, it, vi } from 'vitest'
import {
  checkCompanionPackageManager,
  prepareCompanionPackageManager,
  resolveCompanionPackageManager,
} from './companion-prerequisites.js'

const probe = vi.hoisted(() => ({
  exists: true,
  error: undefined as Error | undefined,
  output: '11.19.0\n',
  calls: vi.fn(),
  repair: false,
  primaryBroken: false,
  primaryExeBroken: false,
  corepackBroken: false,
  enableRequired: false,
}))
vi.mock('../backend/runtime-paths.js', () => ({ runtimePathEntries: () => ['first', 'second'] }))
vi.mock('node:fs', () => ({
  existsSync: () => probe.exists,
  readFileSync: (file: string) =>
    `@node "%~dp0/${file
      .split(/[\\/]/u)
      .at(-1)
      ?.replace(/\.(cmd|bat)$/u, '')}.js" %*`,
}))
vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: readonly string[],
    options: unknown,
    callback: (error: Error | undefined, value: { stdout: string }) => void,
  ) => {
    probe.calls(file, args, options)
    if (probe.primaryExeBroken && args.includes('--version') && /first[\\/]pnpm\.exe$/u.test(file)) {
      callback(new Error('broken preferred exe'), { stdout: '' })
      return
    }
    if (args.includes('--version') && probe.primaryBroken && file.includes('first')) {
      callback(new Error('stale launcher'), { stdout: '' })
      return
    }
    if (
      args.includes('install') &&
      probe.corepackBroken &&
      [file, ...args].some((part) => part.includes('corepack'))
    ) {
      callback(new Error('broken corepack'), { stdout: '' })
      return
    }
    if (probe.repair && args.includes('install')) {
      if (!probe.enableRequired) probe.error = undefined
      callback(undefined, { stdout: '' })
      return
    }
    if (probe.repair && args.includes('enable')) {
      probe.error = undefined
    }
    callback(probe.error, { stdout: probe.output })
  },
}))
beforeEach(() => {
  probe.exists = true
  probe.error = undefined
  probe.output = '11.19.0\n'
  probe.calls.mockClear()
  probe.repair = false
  probe.primaryBroken = false
  probe.primaryExeBroken = false
  probe.corepackBroken = false
  probe.enableRequired = false
})

it('tries a later pnpm when the first launcher is broken', async () => {
  probe.primaryBroken = true
  expect(await checkCompanionPackageManager()).toBe('ready')
  expect(probe.calls.mock.calls.some(([file]) => String(file).includes('second'))).toBe(true)
  expect(probe.calls.mock.calls.every(([, args]) => (args as string[]).includes('--version'))).toBe(true)
  expect(await resolveCompanionPackageManager()).toMatchObject({ status: 'ready', directory: 'second' })
})
it.skipIf(process.platform !== 'win32')(
  'does not prefer a directory whose higher-priority pnpm.exe is broken',
  async () => {
    probe.primaryExeBroken = true
    expect(await resolveCompanionPackageManager()).toMatchObject({ status: 'ready', directory: 'second' })
  },
)

it('enables Corepack launchers after preparing a cached pnpm version', async () => {
  probe.error = new Error('missing launcher')
  probe.repair = true
  probe.enableRequired = true
  await prepareCompanionPackageManager(new AbortController().signal)
  expect(probe.calls).toHaveBeenCalledWith(
    expect.any(String),
    expect.arrayContaining(['enable', 'pnpm']),
    expect.objectContaining({
      env: expect.objectContaining({
        COREPACK_ENABLE_NETWORK: '1',
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      }) as unknown,
    }),
  )
})

it('falls back to npm when Corepack cannot run', async () => {
  probe.error = new Error('pnpm unavailable')
  probe.repair = true
  probe.corepackBroken = true
  await prepareCompanionPackageManager(new AbortController().signal)
  expect(
    probe.calls.mock.calls.some(
      ([file, args]) =>
        [String(file), ...(args as string[])].some((part) => /(?:^|[\\/])npm(?:\.exe|\.js)?$/u.test(part)) &&
        (args as string[]).includes('install'),
    ),
  ).toBe(true)
})

it('does not spawn a version probe after cancellation', async () => {
  const abort = new AbortController()
  abort.abort()
  await expect(checkCompanionPackageManager(abort.signal)).rejects.toThrow()
  expect(probe.calls).not.toHaveBeenCalled()
})
it('distinguishes a missing pnpm from a broken executable without invoking an installer', async () => {
  probe.exists = false
  expect(await checkCompanionPackageManager()).toBe('missing')
  expect(probe.calls).not.toHaveBeenCalled()
  probe.exists = true
  probe.error = new Error('module missing')
  expect(await checkCompanionPackageManager()).toBe('broken')
})
it('checks only the version and disables Corepack network access', async () => {
  expect(await checkCompanionPackageManager()).toBe('ready')
  expect(probe.calls).toHaveBeenCalledWith(
    expect.any(String),
    expect.arrayContaining(['--version']),
    expect.objectContaining({
      env: expect.objectContaining({ COREPACK_ENABLE_NETWORK: '0' }) as unknown,
      timeout: 5000,
    }),
  )
})

it('uses an explicit cancellable preparation action and verifies pnpm afterward', async () => {
  probe.error = new Error('broken corepack selection')
  probe.repair = true
  const controller = new AbortController()
  await prepareCompanionPackageManager(controller.signal)
  expect(probe.calls).toHaveBeenCalledWith(
    expect.any(String),
    expect.arrayContaining(['install', '--global', 'pnpm@11.19.0']),
    expect.objectContaining({ signal: controller.signal, timeout: expect.any(Number) as unknown }),
  )
  expect(await checkCompanionPackageManager()).toBe('ready')
  probe.calls.mockClear()
  controller.abort()
  await expect(prepareCompanionPackageManager(controller.signal)).rejects.toThrow()
  expect(probe.calls).not.toHaveBeenCalled()
})
