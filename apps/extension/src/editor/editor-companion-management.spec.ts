import path from 'node:path'
import type * as vscode from 'vscode'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  type DshBackend,
  type PluginBundleRepository,
  type PluginBundleChangeResult,
} from '@dsh-vscode/domain'
import { EditorCompanionManagement } from './editor-companion-management.js'
import { FixtureUri, native, resetCompanionFixture } from './test-fixtures/companion-vscode.js'
vi.mock('vscode', async () =>
  (await import('./test-fixtures/companion-vscode.js')).createCompanionVscodeApi(),
)
const archives = vi.hoisted(() => ({ cache: vi.fn(), list: vi.fn(), alternate: vi.fn() }))
vi.mock('./companion-archive.js', () => ({
  EDITOR_COMPANION_PACKAGE: '@dsh-vscode/editor-bridge',
  cacheCompanionArchive: archives.cache,
  listCompanionArchives: archives.list,
  alternateCompanionArchive: archives.alternate,
}))
const applied: PluginBundleChangeResult = {
  name: '@dsh-vscode/editor-bridge',
  changed: true,
  application: 'applied',
}
const old = {
  name: '@dsh-vscode/editor-bridge',
  version: '0.1.0',
  installed: true,
  enabled: true,
  optional: true,
  removable: true,
  rows: [],
  overrides: [],
}
const nextFile = path.resolve('companion-cache-fixture', 'new.tgz')
const oldFile = path.resolve('companion-cache-fixture', 'old.tgz')
beforeEach(() => {
  resetCompanionFixture()
  archives.cache.mockReset().mockResolvedValue({ version: '0.2.0', file: nextFile })
  archives.list.mockReset().mockResolvedValue([])
  archives.alternate
    .mockReset()
    .mockResolvedValue({ version: '0.2.0', file: path.resolve('companion-cache-fixture', 'alternate.tgz') })
  native.warning.mockResolvedValue('Install')
})
interface Fixture {
  backend: DshBackend
  selectBackend: (backend: DshBackend | undefined) => void
  requestTimeoutMs: Mock<() => number>
  manager: EditorCompanionManagement
  repository: PluginBundleRepository
  listBundles: Mock<PluginBundleRepository['listBundles']>
  installBundle: Mock<PluginBundleRepository['installBundle']>
  removeBundle: Mock<PluginBundleRepository['removeBundle']>
  waitForInstall: Mock<PluginBundleRepository['waitForInstall']>
  cancelInstall: Mock<PluginBundleRepository['cancelInstall']>
  setBundleEnabled: Mock<PluginBundleRepository['setBundleEnabled']>
  stop: Mock<() => Promise<void>>
  enable: Mock<() => Promise<boolean>>
  checkPackageManager: Mock<(signal?: AbortSignal) => Promise<'ready' | 'missing' | 'broken'>>
  reconnect: Mock<() => Promise<void>>
}
function fixture(ownership: 'managed' | 'external' = 'managed'): Fixture {
  const listBundles = vi.fn<PluginBundleRepository['listBundles']>().mockResolvedValue([])
  const installBundle = vi.fn<PluginBundleRepository['installBundle']>().mockResolvedValue(applied)
  const removeBundle = vi.fn<PluginBundleRepository['removeBundle']>().mockResolvedValue(applied)
  const waitForInstall = vi.fn<PluginBundleRepository['waitForInstall']>().mockResolvedValue(null)
  const cancelInstall = vi
    .fn<PluginBundleRepository['cancelInstall']>()
    .mockResolvedValue({ status: 'cancelled' })
  const setBundleEnabled = vi.fn<PluginBundleRepository['setBundleEnabled']>().mockResolvedValue(applied)
  const repository = {
    listBundles,
    installBundle,
    removeBundle,
    waitForInstall,
    cancelInstall,
    setBundleEnabled,
  } as unknown as PluginBundleRepository
  const backend = {
    connection: { ownership, endpoint: { baseUrl: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000 } },
    pluginBundles: repository,
    editorBridge: {},
  } as unknown as DshBackend
  const stop = vi.fn().mockResolvedValue(undefined)
  const enable = vi.fn().mockResolvedValue(true)
  const checkPackageManager = vi
    .fn<(signal?: AbortSignal) => Promise<'ready' | 'missing' | 'broken'>>()
    .mockResolvedValue('ready')
  const reconnect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  let selected: DshBackend | undefined = backend
  const requestTimeoutMs = vi.fn(() => 30_000)
  const manager = new EditorCompanionManagement({
    backend: () => {
      if (selected === undefined) throw new Error('Fixture disconnected')
      return selected
    },
    current: (candidate) => candidate === selected,
    requestTimeoutMs,
    extensionUri: FixtureUri.file(path.resolve('extension-fixture')) as unknown as vscode.Uri,
    storageUri: FixtureUri.file(path.resolve('storage-fixture')) as unknown as vscode.Uri,
    reconnect,
    active: () => false,
    enable,
    stop,
    halt: stop,
    undo: vi.fn().mockResolvedValue(undefined),
    checkPackageManager,
  })
  return {
    backend,
    selectBackend: (next) => {
      selected = next
    },
    requestTimeoutMs,
    manager,
    repository,
    listBundles,
    installBundle,
    removeBundle,
    waitForInstall,
    cancelInstall,
    setBundleEnabled,
    stop,
    enable,
    checkPackageManager,
    reconnect,
  }
}
describe('native editor companion installation and recovery', () => {
  it('coalesces simultaneous catalog reads for the same connection', async () => {
    const { manager, listBundles } = fixture()
    let finish!: (value: readonly (typeof old)[]) => void
    listBundles.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const first = manager.refreshStatus(true)
    const second = manager.refreshStatus(true)
    await Promise.resolve()
    expect(listBundles).toHaveBeenCalledOnce()
    finish([old])
    await Promise.all([first, second])
    expect(manager.installationStatus).toEqual({ installed: true, packageManager: 'ready' })
  })

  it('starts a fresh post-install read while an older catalog read is still pending', async () => {
    const { manager, listBundles } = fixture()
    let finishOld!: (value: readonly (typeof old)[]) => void
    listBundles
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve
          }),
      )
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([old])
    const previous = manager.refreshStatus(true)
    await Promise.resolve()
    try {
      expect(await manager.installBundled({ silent: true })).toBe(true)
      const current = manager.refreshStatus(true)
      await Promise.resolve()
      expect(listBundles).toHaveBeenCalledTimes(3)
      await current
      expect(manager.installationStatus).toEqual({ installed: true, packageManager: 'ready' })
    } finally {
      finishOld([])
      await previous
    }
  })

  it.each(['resolve', 'reject'] as const)(
    'refreshes a replacement connection immediately while the old catalog later %ss',
    async (outcome) => {
      const { manager, backend, repository, listBundles, selectBackend } = fixture()
      let resolveOld!: (value: readonly (typeof old)[]) => void
      let rejectOld!: (reason: Error) => void
      listBundles.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            resolveOld = resolve
            rejectOld = reject
          }),
      )
      const prior = manager.refreshStatus(true)
      await Promise.resolve()
      const priorSignal = listBundles.mock.calls[0]?.[0]
      const listNew = vi.fn<PluginBundleRepository['listBundles']>().mockResolvedValue([old])
      selectBackend({ ...backend, pluginBundles: { ...repository, listBundles: listNew } })
      const current = manager.refreshStatus(true)
      await Promise.resolve()
      expect(listNew).toHaveBeenCalledOnce()
      expect(priorSignal?.aborted).toBe(true)
      await current
      expect(manager.installationStatus).toEqual({ installed: true, packageManager: 'ready' })
      if (outcome === 'resolve') resolveOld([])
      else rejectOld(new Error('Old connection failed'))
      await prior
      expect(manager.installationStatus).toEqual({ installed: true, packageManager: 'ready' })
    },
  )

  it('cancels an obsolete catalog when the backend disconnects', async () => {
    const { manager, listBundles, selectBackend } = fixture()
    listBundles.mockImplementationOnce(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('Disconnected')), { once: true })
        }),
    )
    const pending = manager.refreshStatus(true)
    await Promise.resolve()
    selectBackend(undefined)
    await manager.refreshStatus(true)
    expect(listBundles.mock.calls[0]?.[0]?.aborted).toBe(true)
    await pending
    expect(manager.installationStatus).toEqual({})
  })

  it('aborts the package-manager probe and retires status refreshes on disposal', async () => {
    const { manager, listBundles, checkPackageManager } = fixture()
    let probeStarted!: () => void
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve
    })
    checkPackageManager.mockImplementationOnce(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('Disposed')), { once: true })
          probeStarted()
        }),
    )
    const pending = manager.refreshStatus(true)
    await started
    await manager.dispose()
    expect(checkPackageManager.mock.calls[0]?.[0]?.aborted).toBe(true)
    await pending
    await manager.refreshStatus(true)
    expect(listBundles).toHaveBeenCalledOnce()
    expect(manager.installationStatus).toEqual({})
  })

  it('uses a configured catalog budget longer than the default', async () => {
    vi.useFakeTimers()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds)
      return controller.signal
    })
    try {
      const { manager, listBundles, requestTimeoutMs } = fixture()
      requestTimeoutMs.mockReturnValue(60_000)
      listBundles.mockImplementationOnce(
        (signal) =>
          new Promise((resolve, reject) => {
            setTimeout(() => resolve([old]), 45_000)
            signal?.addEventListener('abort', () => reject(new Error('Timed out')), { once: true })
          }),
      )
      const pending = manager.refreshStatus(true)
      await vi.advanceTimersByTimeAsync(45_000)
      await pending
      expect(manager.installationStatus).toEqual({ installed: true, packageManager: 'ready' })
    } finally {
      timeout.mockRestore()
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('gives the package-manager probe its own budget after a slow catalog succeeds', async () => {
    vi.useFakeTimers()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds)
      return controller.signal
    })
    try {
      const { manager, listBundles, checkPackageManager } = fixture()
      listBundles.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve([old]), 25_000)
          }),
      )
      checkPackageManager.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve('ready'), 8_000)
          }),
      )
      const pending = manager.refreshStatus(true)
      await vi.advanceTimersByTimeAsync(33_000)
      await pending
      expect(manager.installationStatus).toEqual({ installed: true, packageManager: 'ready' })
    } finally {
      timeout.mockRestore()
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('honors native progress cancellation before mutation and retains the final receipt after it starts', async () => {
    const { manager, installBundle, cancelInstall } = fixture()
    expect(await manager.installBundled({ silent: true, signal: AbortSignal.abort() })).toBe(false)
    expect(installBundle).not.toHaveBeenCalled()
    let finish: (result: PluginBundleChangeResult) => void = () => {}
    installBundle.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    cancelInstall.mockImplementationOnce(() => {
      finish({ ...applied, application: 'cancelled' })
      return Promise.resolve({ status: 'cancelled' })
    })
    const controller = new AbortController()
    const installing = manager.installBundled({ silent: true, signal: controller.signal })
    await vi.waitFor(() => expect(installBundle).toHaveBeenCalledOnce())
    controller.abort()
    await installing
    expect(cancelInstall).toHaveBeenCalledWith(
      installBundle.mock.calls[0]?.[1].requestId,
      expect.any(AbortSignal),
    )
    expect(installBundle.mock.calls[0]?.[2]?.aborted).toBe(false)
    expect(manager.installationState).toBe('cancelled')
    expect(manager.busy).toBe(false)
  })
  it('keeps sharing off when a replacement fails without a verified previous archive', async () => {
    const { manager, listBundles, installBundle } = fixture()
    listBundles.mockResolvedValue([old])
    installBundle.mockResolvedValueOnce({ ...applied, application: 'failed', failureKind: 'integrity' })
    expect(await manager.installBundled({ silent: true })).toBe(false)
    expect(manager.busy).toBe(false)
    expect(manager.sharingBlocked).toBe(true)
    expect(installBundle).toHaveBeenCalledOnce()
    expect(await manager.installBundled({ silent: true })).toBe(true)
    expect(manager.sharingBlocked).toBe(false)
  })

  it('offers only verified cached files through native selection, confirms the choice and handles an empty cache', async () => {
    const { manager, installBundle } = fixture()
    await manager.restoreCached()
    expect(native.info).toHaveBeenCalledWith(expect.stringContaining('No cached companion'))
    expect(installBundle).not.toHaveBeenCalled()
    archives.list.mockResolvedValue([{ version: '0.1.0', file: oldFile }])
    archives.cache.mockResolvedValue({ version: '0.1.0', file: oldFile })
    native.pick.mockResolvedValue({ archive: { version: '0.1.0', file: oldFile } })
    await manager.restoreCached()
    expect(archives.cache).toHaveBeenCalledWith(oldFile, expect.any(String))
    expect(native.pick).toHaveBeenLastCalledWith(
      [expect.objectContaining({ label: 'Editor companion v0.1.0', description: 'Build old' })],
      expect.anything(),
    )
    expect(native.warning).toHaveBeenCalledOnce()
    expect(installBundle).toHaveBeenCalledWith(oldFile, expect.anything(), expect.any(AbortSignal))
  })

  it('accepts a slow package catalog and still bounds an unresponsive status read', async () => {
    vi.useFakeTimers()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds)
      return controller.signal
    })
    try {
      const { manager, listBundles } = fixture()
      listBundles.mockImplementationOnce(
        (signal) =>
          new Promise((resolve, reject) => {
            setTimeout(() => resolve([]), 15_000)
            signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'TimeoutError')), {
              once: true,
            })
          }),
      )
      const slow = manager.refreshStatus(true)
      await vi.advanceTimersByTimeAsync(15_000)
      await slow
      expect(manager.installationStatus).toEqual({ installed: false, packageManager: 'ready' })

      listBundles.mockImplementationOnce(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'TimeoutError')), {
              once: true,
            })
          }),
      )
      const unresponsive = manager.refreshStatus(true)
      await vi.advanceTimersByTimeAsync(30_000)
      await unresponsive
      expect(listBundles.mock.calls.at(-1)?.[0]?.aborted).toBe(true)
      expect(manager.installationStatus).toEqual({})
    } finally {
      timeout.mockRestore()
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('reads native installed state independently from consent and blocks missing prerequisites before mutation', async () => {
    const { manager, checkPackageManager, installBundle, listBundles } = fixture()
    checkPackageManager.mockResolvedValue('missing')
    await manager.refreshStatus()
    expect(manager.installationStatus).toEqual({ installed: false, packageManager: 'missing' })
    expect(await manager.installBundled({ silent: true })).toBe(false)
    expect(installBundle).not.toHaveBeenCalled()
    checkPackageManager.mockResolvedValue('ready')
    listBundles.mockResolvedValue([old])
    await manager.refreshStatus(true)
    expect(manager.installationStatus).toEqual({ installed: true, packageManager: 'ready' })
  })

  it('refuses external runtimes before reading artifacts or mutating a profile', async () => {
    const { manager, installBundle, stop } = fixture('external')
    await manager.installBundled()
    expect(archives.cache).not.toHaveBeenCalled()
    expect(installBundle).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })
  it('installs a verified cached artifact only after native confirmation and revokes sharing first', async () => {
    const { manager, installBundle, stop, enable } = fixture()
    await manager.installBundled()
    expect(installBundle).toHaveBeenCalledWith(
      nextFile,
      expect.objectContaining({
        requestId: expect.any(String) as unknown,
        approvedBuilds: [],
        saveExact: true,
      }),
      expect.any(AbortSignal),
    )
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(installBundle.mock.invocationCallOrder[0] ?? 0)
    expect(enable).not.toHaveBeenCalled()
    expect(manager.busy).toBe(false)
  })
  it('does not start installation when the native confirmation is dismissed', async () => {
    const { manager, installBundle, stop } = fixture()
    native.warning.mockResolvedValue(undefined)
    await manager.installBundled()
    expect(installBundle).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })
  it('recovers a lost acknowledgement by its original request ID and blocks duplicate installations while unknown', async () => {
    const { manager, installBundle, waitForInstall } = fixture()
    installBundle.mockRejectedValue(new Error('private transport failure'))
    await manager.installBundled()
    expect(manager.busy).toBe(true)
    expect(manager.installationState).toBe('unknown')
    expect(manager.canCancelInstall).toBe(true)
    const id = installBundle.mock.calls[0]?.[1]?.requestId
    expect(waitForInstall).toHaveBeenCalledWith(id, expect.any(AbortSignal))
    await manager.installBundled()
    expect(installBundle).toHaveBeenCalledTimes(1)
    waitForInstall.mockResolvedValue(applied)
    await manager.manage()
    expect(waitForInstall).toHaveBeenLastCalledWith(id, expect.any(AbortSignal))
    expect(manager.busy).toBe(false)
    expect(manager.installationState).toBe('installed')
    expect(JSON.stringify(native.error.mock.calls)).not.toContain('private transport failure')
  })
  it('keeps a verified previous archive and restores it after a confirmed replacement failure', async () => {
    const { manager, listBundles, installBundle, removeBundle, enable } = fixture()
    archives.list.mockResolvedValue([{ version: '0.1.0', file: oldFile }])
    listBundles.mockResolvedValueOnce([old]).mockResolvedValue([])
    installBundle
      .mockResolvedValueOnce({ ...applied, application: 'failed', errorCode: 'operation-error' })
      .mockResolvedValueOnce(applied)
    await manager.installBundled()
    expect(removeBundle).not.toHaveBeenCalled()
    expect(installBundle.mock.calls.map((call) => call[0])).toEqual([nextFile, oldFile])
    expect(installBundle.mock.calls[0]?.[1]?.requestId).not.toBe(installBundle.mock.calls[1]?.[1]?.requestId)
    expect(enable).not.toHaveBeenCalled()
    expect(manager.busy).toBe(false)
  })
})
