import { beforeEach, expect, it, vi } from 'vitest'
import { checkCompanionPackageManager, prepareCompanionPackageManager } from './companion-prerequisites.js'

const probe = vi.hoisted(() => ({
  exists: true,
  error: undefined as Error | undefined,
  output: '11.19.0\n',
  calls: vi.fn(),
  repair: false,
}))
vi.mock('node:fs', () => ({
  existsSync: () => probe.exists,
  readFileSync: () => '@node "%~dp0/corepack/dist/pnpm.js" %*',
}))
vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: readonly string[],
    options: unknown,
    callback: (error: Error | undefined, value: { stdout: string }) => void,
  ) => {
    probe.calls(file, args, options)
    if (probe.repair && args.includes('install')) {
      probe.error = undefined
      probe.output = '11.19.0\n'
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
    expect.objectContaining({ signal: controller.signal, timeout: 120000 }),
  )
  expect(await checkCompanionPackageManager()).toBe('ready')
  probe.calls.mockClear()
  controller.abort()
  await expect(prepareCompanionPackageManager(controller.signal)).rejects.toThrow()
  expect(probe.calls).not.toHaveBeenCalled()
})
