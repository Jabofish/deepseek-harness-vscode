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
