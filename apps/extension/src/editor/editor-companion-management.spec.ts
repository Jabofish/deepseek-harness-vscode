import path from 'node:path'
import type * as vscode from 'vscode'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  AppError,
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
  checkPackageManager: Mock<() => Promise<'ready' | 'missing' | 'broken'>>
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
    .fn<() => Promise<'ready' | 'missing' | 'broken'>>()
    .mockResolvedValue('ready')
  const reconnect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const manager = new EditorCompanionManagement({
    backend: () => backend,
    current: (candidate) => candidate === backend,
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
  it('retains the required restart when the user defers reconnecting', async () => {
    const { manager, installBundle, reconnect } = fixture()
    installBundle.mockResolvedValue({ ...applied, application: 'restart-required' })
    expect(await manager.installBundled()).toBe(true)
    expect(manager.needsRestart).toBe(true)
    expect(reconnect).not.toHaveBeenCalled()
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
  it('repairs a native already-installed refusal with one verified alternate path and a new request ID', async () => {
    const { manager, installBundle, removeBundle } = fixture()
    installBundle.mockResolvedValueOnce({ ...applied, application: 'failed', errorCode: 'already-installed' })
    expect(await manager.installBundled({ silent: true })).toBe(true)
    expect(installBundle).toHaveBeenCalledTimes(2)
    expect(installBundle.mock.calls[0]?.[0]).not.toBe(installBundle.mock.calls[1]?.[0])
    expect(installBundle.mock.calls[0]?.[1].requestId).not.toBe(installBundle.mock.calls[1]?.[1].requestId)
    expect(removeBundle).not.toHaveBeenCalled()
    expect(manager.installationFailure.recovery).toBeUndefined()
  })
  it('stops after one alternate-path refusal and permits cancellation before the retry starts', async () => {
    const { manager, installBundle } = fixture()
    installBundle.mockResolvedValue({ ...applied, application: 'failed', errorCode: 'already-installed' })
    expect(await manager.installBundled({ silent: true })).toBe(false)
    expect(installBundle).toHaveBeenCalledTimes(2)
    expect(manager.busy).toBe(false)
    let finish: (archive: { version: string; file: string }) => void = () => {}
    archives.alternate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const installing = manager.installBundled({ silent: true })
    await vi.waitFor(() => expect(archives.alternate).toHaveBeenCalledTimes(2))
    await manager.cancelInstallation()
    finish({ version: '0.2.0', file: oldFile })
    await installing
    expect(installBundle).toHaveBeenCalledTimes(3)
    expect(manager.installationState).toBe('cancelled')
    expect(manager.busy).toBe(false)
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
    expect(native.warning).toHaveBeenCalledOnce()
    expect(installBundle).toHaveBeenCalledWith(oldFile, expect.anything(), expect.any(AbortSignal))
  })
  it('releases a failed recovery and reports its native failure without allowing sharing', async () => {
    const { manager, listBundles, installBundle } = fixture()
    archives.list.mockResolvedValue([{ version: '0.1.0', file: oldFile }])
    listBundles.mockResolvedValue([old])
    installBundle.mockResolvedValueOnce({ ...applied, application: 'failed' }).mockResolvedValueOnce({
      ...applied,
      application: 'failed',
      errorCode: 'operation-error',
      failureKind: 'network',
    })
    await manager.installBundled({ silent: true })
    expect(manager.busy).toBe(false)
    expect(manager.installationState).toBe('failed')
    expect(manager.installationFailure.installationFailureKind).toBe('network')
    expect(manager.sharingBlocked).toBe(true)
    expect(JSON.stringify(native.error.mock.calls)).not.toContain('could not be confirmed')
    await manager.installBundled({ silent: true })
    expect(installBundle).toHaveBeenCalledTimes(3)
    expect(manager.sharingBlocked).toBe(false)
  })
  it('uses a fresh signal to recover after the recovery install times out', async () => {
    const { manager, listBundles, installBundle, waitForInstall } = fixture()
    archives.list.mockResolvedValue([{ version: '0.1.0', file: oldFile }])
    listBundles.mockResolvedValue([old])
    const recovery = new AbortController()
    installBundle.mockResolvedValueOnce({ ...applied, application: 'failed' }).mockImplementationOnce(() => {
      recovery.abort()
      return Promise.reject(new Error('timeout'))
    })
    waitForInstall.mockImplementation((_id, signal) => {
      expect(signal?.aborted).toBe(false)
      return Promise.resolve(applied)
    })
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    const timer = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => (ms === 60_000 ? recovery.signal : timeout(ms)))
    try {
      await manager.installBundled({ silent: true })
      expect(manager.busy).toBe(false)
      expect(native.info).toHaveBeenCalledWith(expect.stringContaining('was restored'))
    } finally {
      timer.mockRestore()
    }
  })
  it('recovers a delayed rollback receipt without claiming the failed upgrade succeeded', async () => {
    const { manager, listBundles, installBundle, waitForInstall, reconnect } = fixture()
    archives.list.mockResolvedValue([{ version: '0.1.0', file: oldFile }])
    listBundles.mockResolvedValue([old])
    installBundle
      .mockResolvedValueOnce({ ...applied, application: 'failed', failureKind: 'integrity' })
      .mockRejectedValueOnce(new Error('lost rollback receipt'))
    await manager.installBundled({ silent: true })
    expect(manager.installationState).toBe('unknown')
    const restoreId = installBundle.mock.calls[1]?.[1].requestId
    waitForInstall.mockResolvedValue({ ...applied, application: 'restart-required' })
    await manager.recoverInstallation()
    expect(waitForInstall).toHaveBeenLastCalledWith(restoreId, expect.any(AbortSignal))
    expect(manager.busy).toBe(false)
    expect(manager.installationState).toBe('failed')
    expect(manager.installationFailure.installationFailureKind).toBe('integrity')
    expect(reconnect).toHaveBeenCalledOnce()
  })
  it('retries restoring the disabled state without losing the completed install receipt', async () => {
    const { manager, listBundles, installBundle, setBundleEnabled, waitForInstall } = fixture()
    archives.list.mockResolvedValue([{ version: '0.1.0', file: oldFile }])
    listBundles.mockResolvedValue([{ ...old, enabled: false }])
    installBundle.mockResolvedValueOnce({ ...applied, application: 'failed' }).mockResolvedValueOnce(applied)
    setBundleEnabled.mockRejectedValueOnce(new Error('connection interrupted'))
    await manager.installBundled({ silent: true })
    expect(manager.busy).toBe(true)
    expect(manager.canCancelInstall).toBe(false)
    await manager.recoverInstallation()
    expect(setBundleEnabled).toHaveBeenCalledTimes(2)
    expect(installBundle).toHaveBeenCalledTimes(2)
    expect(waitForInstall).not.toHaveBeenCalled()
    expect(manager.busy).toBe(false)
  })
  it('cancels the recovery request rather than the finished upgrade request', async () => {
    const { manager, listBundles, installBundle, cancelInstall } = fixture()
    archives.list.mockResolvedValue([{ version: '0.1.0', file: oldFile }])
    listBundles.mockResolvedValue([old])
    let finish: (result: PluginBundleChangeResult) => void = () => {}
    installBundle.mockResolvedValueOnce({ ...applied, application: 'failed' }).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const installing = manager.installBundled({ silent: true })
    await vi.waitFor(() => expect(installBundle).toHaveBeenCalledTimes(2))
    await manager.cancelInstallation()
    expect(cancelInstall).toHaveBeenLastCalledWith(
      installBundle.mock.calls[1]?.[1].requestId,
      expect.any(AbortSignal),
    )
    finish({ ...applied, application: 'cancelled' })
    await installing
    expect(manager.busy).toBe(false)
  })
  it('honors cancellation while preparing the alternate recovery path', async () => {
    const { manager, listBundles, installBundle } = fixture()
    archives.list.mockResolvedValue([{ version: '0.1.0', file: oldFile }])
    listBundles.mockResolvedValue([old])
    installBundle
      .mockResolvedValueOnce({ ...applied, application: 'failed' })
      .mockResolvedValueOnce({ ...applied, application: 'failed', errorCode: 'already-installed' })
    let finish: (archive: { version: string; file: string }) => void = () => {}
    archives.alternate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const installing = manager.installBundled({ silent: true })
    await vi.waitFor(() => expect(archives.alternate).toHaveBeenCalledOnce())
    await manager.cancelInstallation()
    finish({ version: '0.1.0', file: oldFile })
    await installing
    expect(installBundle).toHaveBeenCalledTimes(2)
    expect(manager.busy).toBe(false)
    expect(manager.sharingBlocked).toBe(true)
  })
  it('serializes repeated recovery requests', async () => {
    const { manager, installBundle, waitForInstall } = fixture()
    installBundle.mockRejectedValue(new Error('lost receipt'))
    await manager.installBundled({ silent: true })
    let finish: (result: PluginBundleChangeResult) => void = () => {}
    waitForInstall.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const recovering = manager.recoverInstallation()
    await manager.recoverInstallation()
    expect(waitForInstall).toHaveBeenCalledTimes(2)
    finish(applied)
    await recovering
    expect(manager.busy).toBe(false)
  })
  it('does not reinstall a previous bundle when the replacement never started', async () => {
    const { manager, listBundles, installBundle } = fixture()
    archives.list.mockResolvedValue([{ version: '0.1.0', file: oldFile }])
    listBundles.mockResolvedValue([old])
    installBundle.mockRejectedValue(
      new AppError({ code: 'PLUGIN_INSTALL_NOT_STARTED', message: 'Not started', retryable: false }),
    )
    expect(await manager.installBundled({ silent: true })).toBe(false)
    expect(installBundle).toHaveBeenCalledTimes(1)
    expect(manager.busy).toBe(false)
    expect(manager.installationState).toBe('failed')
  })

  it.each(['success', 'failure'])(
    'does not let a stale status read overwrite a completed installation on %s',
    async (outcome) => {
      const { manager, listBundles, checkPackageManager, installBundle } = fixture()
      let finishProbe: (status: 'ready') => void = () => {}
      let failProbe: (error: Error) => void = () => {}
      checkPackageManager.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finishProbe = resolve
            failProbe = reject
          }),
      )
      const refresh = manager.refreshStatus(true)
      await vi.waitFor(() => expect(checkPackageManager).toHaveBeenCalledOnce())
      let finishInstall: (result: PluginBundleChangeResult) => void = () => {}
      installBundle.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishInstall = resolve
          }),
      )
      listBundles.mockResolvedValue([old])
      const installing = manager.installBundled({ silent: true })
      await vi.waitFor(() => expect(installBundle).toHaveBeenCalledOnce())
      finishInstall(applied)
      await installing
      if (outcome === 'success') finishProbe('ready')
      else failProbe(new Error('obsolete status read failed'))
      await refresh
      expect(manager.installationStatus.installed).toBe(true)
    },
  )

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
  it('retains the safe native installation failure for the settings panel', async () => {
    const { manager, installBundle } = fixture()
    installBundle.mockResolvedValue({
      ...applied,
      application: 'failed',
      errorCode: 'operation-error',
      failureKind: 'pnpm-missing',
    })
    expect(await manager.installBundled({ silent: true })).toBe(false)
    expect(manager.installationFailure).toEqual({
      installationErrorCode: 'operation-error',
      installationFailureKind: 'pnpm-missing',
    })
  })
  it.each(['cancelled', 'applied'] as const)(
    'reports the native %s outcome after cancellation',
    async (application) => {
      const { manager, installBundle, cancelInstall, waitForInstall } = fixture()
      let finish: (result: PluginBundleChangeResult) => void = () => {}
      installBundle.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      cancelInstall.mockImplementation(() => {
        finish({ ...applied, application })
        return Promise.resolve({ status: application === 'applied' ? 'too-late' : 'cancelled' })
      })
      const installing = manager.installBundled({ silent: true })
      await vi.waitFor(() => expect(installBundle).toHaveBeenCalledOnce())
      expect(manager.installationState).toBe('installing')
      expect(manager.canCancelInstall).toBe(true)
      await manager.cancelInstallation()
      await installing
      expect(cancelInstall).toHaveBeenCalledWith(
        installBundle.mock.calls[0]?.[1].requestId,
        expect.any(AbortSignal),
      )
      expect(manager.installationState).toBe(application === 'applied' ? 'installed' : 'cancelled')
      expect(manager.canCancelInstall).toBe(false)
      expect(manager.busy).toBe(false)
      expect(installBundle.mock.calls[0]?.[2]?.aborted).toBe(false)
      expect(waitForInstall).not.toHaveBeenCalled()
    },
  )
  it('restores the disabled state of the previous bundle after a failed upgrade', async () => {
    const { manager, listBundles, installBundle, setBundleEnabled } = fixture()
    archives.list.mockResolvedValue([{ version: '0.1.0', file: oldFile }])
    listBundles.mockResolvedValueOnce([{ ...old, enabled: false }]).mockResolvedValue([])
    installBundle.mockResolvedValueOnce({ ...applied, application: 'failed' }).mockResolvedValueOnce(applied)
    await manager.installBundled()
    expect(setBundleEnabled).toHaveBeenCalledWith('@dsh-vscode/editor-bridge', false, expect.any(AbortSignal))
    expect(manager.busy).toBe(false)
  })
  it('allows cancellation to be retried when it reaches DSH before installation is registered', async () => {
    const { manager, installBundle, cancelInstall } = fixture()
    let finishInstall: (result: PluginBundleChangeResult) => void = () => {}
    installBundle.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishInstall = resolve
        }),
    )
    cancelInstall.mockResolvedValueOnce({ status: 'not-running' }).mockImplementationOnce(() => {
      finishInstall({ ...applied, application: 'cancelled' })
      return Promise.resolve({ status: 'cancelled' })
    })
    const installing = manager.installBundled({ silent: true })
    await vi.waitFor(() => expect(installBundle).toHaveBeenCalledOnce())
    await manager.cancelInstallation()
    expect(manager.canCancelInstall).toBe(true)
    await manager.cancelInstallation()
    await installing
    expect(cancelInstall).toHaveBeenCalledTimes(2)
    expect(cancelInstall.mock.calls[0]?.[0]).toBe(cancelInstall.mock.calls[1]?.[0])
    expect(manager.installationState).toBe('cancelled')
    expect(manager.busy).toBe(false)
  })
  it('installs silently without a modal when the host asks for it', async () => {
    const { manager, installBundle } = fixture()
    expect(await manager.installBundled({ silent: true })).toBe(true)
    expect(native.warning).not.toHaveBeenCalled()
    expect(installBundle).toHaveBeenCalledTimes(1)
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
  it('cancels the original install and restores the previous artifact with an independent recovery signal', async () => {
    const { manager, listBundles, installBundle, waitForInstall, cancelInstall } = fixture()
    archives.list.mockResolvedValue([{ version: '0.1.0', file: oldFile }])
    listBundles.mockResolvedValueOnce([old]).mockResolvedValue([])
    installBundle
      .mockImplementationOnce(
        (_file, _options, signal) =>
          new Promise((_resolve, reject) =>
            signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
          ),
      )
      .mockResolvedValueOnce(applied)
    waitForInstall.mockResolvedValue({ ...applied, application: 'cancelled' })
    const operation = manager.installBundled()
    await vi.waitFor(() => expect(installBundle).toHaveBeenCalledTimes(1))
    manager.cancel()
    await operation
    expect(cancelInstall).toHaveBeenCalledWith(
      installBundle.mock.calls[0]?.[1]?.requestId,
      expect.any(AbortSignal),
    )
    expect(installBundle.mock.calls[1]?.[0]).toBe(oldFile)
    expect(installBundle.mock.calls[1]?.[2]?.aborted).toBe(false)
  })
})
