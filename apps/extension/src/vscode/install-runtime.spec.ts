import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppError } from '@dsh-vscode/domain'

import { INSTALL_COMMAND } from '../constants.js'
import { RuntimeInstaller, isSupportedNodeVersion } from './install-runtime.js'

interface Harness {
  readonly installer: RuntimeInstaller
  readonly runInstall: ReturnType<typeof vi.fn>
  readonly verifyInstall: ReturnType<typeof vi.fn>
  readonly verifyExecutable: ReturnType<typeof vi.fn>
  readonly createTerminal: ReturnType<typeof vi.fn>
  readonly sendText: ReturnType<typeof vi.fn>
  readonly showOpenDialog: ReturnType<typeof vi.fn>
  readonly update: ReturnType<typeof vi.fn>
  readonly writeText: ReturnType<typeof vi.fn>
  readonly openExternal: ReturnType<typeof vi.fn>
}

function createHarness(
  options: {
    readonly runInstall?: () => Promise<void>
    readonly verifyInstall?: () => Promise<boolean>
    readonly verifyExecutable?: (path: string) => Promise<boolean>
    readonly selected?: readonly { readonly fsPath: string }[]
    readonly nodeVersion?: string
  } = {},
): Harness {
  const runInstall = vi.fn(options.runInstall ?? (() => Promise.resolve()))
  const verifyInstall = vi.fn(options.verifyInstall ?? (() => Promise.resolve(true)))
  const verifyExecutable = vi.fn(options.verifyExecutable ?? (() => Promise.resolve(true)))
  const sendText = vi.fn()
  const createTerminal = vi.fn(() => ({ show: vi.fn(), sendText }))
  const showOpenDialog = vi.fn(() => Promise.resolve(options.selected))
  const update = vi.fn(() => Promise.resolve())
  const writeText = vi.fn(() => Promise.resolve())
  const openExternal = vi.fn(() => Promise.resolve(true))
  const installer = new RuntimeInstaller({
    tasks: {} as never,
    window: { createTerminal, showOpenDialog } as never,
    env: { clipboard: { writeText }, openExternal } as never,
    Uri: { parse: (value: string) => ({ value }) } as never,
    workspace: { getConfiguration: () => ({ update }) } as never,
    runInstall,
    verifyInstall,
    verifyExecutable,
  })
  return {
    installer,
    runInstall,
    verifyInstall,
    verifyExecutable,
    createTerminal,
    sendText,
    showOpenDialog,
    update,
    writeText,
    openExternal,
  }
}

const originalNodeVersion = Object.getOwnPropertyDescriptor(process.versions, 'node')

beforeEach(() => {
  // `install()` gates on the Extension Host's own Node runtime, which is
  // whatever this machine happens to run; pin it so the install paths are
  // exercised regardless of the local toolchain.
  Object.defineProperty(process.versions, 'node', { value: '24.0.0', configurable: true })
})

afterEach(() => {
  if (originalNodeVersion !== undefined) Object.defineProperty(process.versions, 'node', originalNodeVersion)
})

async function withNodeVersion<T>(version: string, run: () => Promise<T>): Promise<T> {
  Object.defineProperty(process.versions, 'node', { value: version, configurable: true })
  try {
    return await run()
  } finally {
    Object.defineProperty(process.versions, 'node', { value: '24.0.0', configurable: true })
  }
}

describe('runtime installer', () => {
  it('installs through the injected command and verifies the result', async () => {
    const harness = createHarness()

    await harness.installer.install()

    expect(harness.runInstall).toHaveBeenCalledTimes(1)
    expect(harness.verifyInstall).toHaveBeenCalledTimes(1)
    expect(harness.createTerminal).not.toHaveBeenCalled()
  })

  it('reports an unverified install as a not-found runtime instead of success', async () => {
    const harness = createHarness({ verifyInstall: () => Promise.resolve(false) })

    await expect(harness.installer.install()).rejects.toMatchObject({
      code: 'DSH_NOT_FOUND',
      retryable: true,
      context: { operation: 'runtime.install', reason: 'verify-failed' },
    })
  })

  it('names a missing npm instead of reporting a generic failure', async () => {
    const missing = Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' })
    const harness = createHarness({ runInstall: () => Promise.reject(missing) })

    await expect(harness.installer.install()).rejects.toMatchObject({
      code: 'DSH_NOT_FOUND',
      context: { operation: 'runtime.install', reason: 'npm-not-found' },
    })
    const error = await harness.installer.install().catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).cause).toBe(missing)
  })

  it('keeps a host-owned install error and reports any other failure as an install failure', async () => {
    const cancelled = new AppError({
      code: 'REQUEST_CANCELLED',
      message: 'The install was cancelled.',
      retryable: true,
    })
    const cancelledHarness = createHarness({ runInstall: () => Promise.reject(cancelled) })
    await expect(cancelledHarness.installer.install()).rejects.toBe(cancelled)

    const harness = createHarness({ runInstall: () => Promise.reject(new Error('exit 1')) })
    await expect(harness.installer.install()).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      context: { operation: 'runtime.install', reason: 'install-failed' },
    })
    expect(harness.verifyInstall).not.toHaveBeenCalled()
  })

  it('falls back to a visible terminal with the pinned command when no runner is injected', async () => {
    const sendText = vi.fn()
    const show = vi.fn()
    const installer = new RuntimeInstaller({
      tasks: {} as never,
      window: { createTerminal: () => ({ show, sendText }) } as never,
      env: { clipboard: { writeText: vi.fn() }, openExternal: vi.fn() } as never,
      Uri: { parse: (value: string) => ({ value }) } as never,
    })

    await installer.install()

    expect(sendText).toHaveBeenCalledWith(INSTALL_COMMAND, true)
    expect(show).toHaveBeenCalledWith(true)
  })

  it('refuses to install on an Extension Host Node older than the supported floor', async () => {
    const harness = createHarness()

    await expect(withNodeVersion('20.11.1', () => harness.installer.install())).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      retryable: false,
      context: { operation: 'runtime.install', reason: 'node-version' },
    })
    expect(harness.runInstall).not.toHaveBeenCalled()
    expect(harness.createTerminal).not.toHaveBeenCalled()
    await expect(harness.installer.install()).resolves.toBeUndefined()
  })

  it('gates the install on the documented Node floor', () => {
    expect(isSupportedNodeVersion('22.19.0')).toBe(true)
    expect(isSupportedNodeVersion('22.19.7')).toBe(true)
    expect(isSupportedNodeVersion('22.20.0')).toBe(true)
    expect(isSupportedNodeVersion('23.0.0')).toBe(true)
    expect(isSupportedNodeVersion('24.18.0')).toBe(true)
    expect(isSupportedNodeVersion('22.18.9')).toBe(false)
    expect(isSupportedNodeVersion('21.99.99')).toBe(false)
    expect(isSupportedNodeVersion('20.11.1')).toBe(false)
    expect(isSupportedNodeVersion('not-a-version')).toBe(false)
  })

  it('selects an executable only after verification and then pins it in settings', async () => {
    const executable = process.platform === 'win32' ? 'C:\\tools\\dsh.cmd' : '/tools/dsh'
    const harness = createHarness({ selected: [{ fsPath: executable }] })

    await harness.installer.selectExecutable()

    expect(harness.verifyExecutable).toHaveBeenCalledWith(executable)
    expect(harness.update).toHaveBeenCalledWith('runtime.executablePath', executable, true)
  })

  it('refuses an unverified executable without touching settings', async () => {
    const harness = createHarness({
      selected: [{ fsPath: '/tools/not-dsh' }],
      verifyExecutable: () => Promise.resolve(false),
    })

    await expect(harness.installer.selectExecutable()).rejects.toMatchObject({
      code: 'DSH_INCOMPATIBLE',
      context: { operation: 'runtime.select', reason: 'invalid-executable' },
    })
    expect(harness.update).not.toHaveBeenCalled()
  })

  it('leaves settings alone when the dialog is dismissed', async () => {
    const harness = createHarness()

    await expect(harness.installer.selectExecutable()).resolves.toBeUndefined()

    expect(harness.verifyExecutable).not.toHaveBeenCalled()
    expect(harness.update).not.toHaveBeenCalled()
  })

  it('copies the pinned install command and opens the documentation link', async () => {
    const harness = createHarness()

    await harness.installer.copyInstallCommand()
    await harness.installer.openDocumentation()

    expect(harness.writeText).toHaveBeenCalledWith(INSTALL_COMMAND)
    expect(harness.openExternal).toHaveBeenCalledWith({
      value: 'https://github.com/deepseek-ai/deepseek-harness',
    })
  })
})
