import { beforeEach, expect, it, vi } from 'vitest'
import { checkCompanionPackageManager } from './companion-prerequisites.js'

const probe = vi.hoisted(() => ({
  exists: true,
  error: undefined as Error | undefined,
  output: '11.19.0\n',
  calls: vi.fn(),
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
    callback(probe.error, { stdout: probe.output })
  },
}))
beforeEach(() => {
  probe.exists = true
  probe.error = undefined
  probe.output = '11.19.0\n'
  probe.calls.mockClear()
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
