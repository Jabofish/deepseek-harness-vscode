import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RuntimeInstaller } from './install-runtime.js'

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
  // The Extension Host and npm may use different Node versions.
  Object.defineProperty(process.versions, 'node', { value: '24.0.0', configurable: true })
})

afterEach(() => {
  if (originalNodeVersion !== undefined) Object.defineProperty(process.versions, 'node', originalNodeVersion)
})

describe('runtime installer', () => {
  it('reports an unverified install as a not-found runtime instead of success', async () => {
    const harness = createHarness({ verifyInstall: () => Promise.resolve(false) })

    await expect(harness.installer.install()).rejects.toMatchObject({
      code: 'DSH_NOT_FOUND',
      retryable: true,
      context: { operation: 'runtime.install', reason: 'verify-failed' },
    })
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
})
