import path from 'node:path'
import type * as vscode from 'vscode'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { DshBackend, PluginBundleRepository, PluginBundleChangeResult } from '@dsh-vscode/domain'
import { EditorCompanionManagement } from './editor-companion-management.js'
import { FixtureUri, native, resetCompanionFixture } from './test-fixtures/companion-vscode.js'
vi.mock('vscode', async () =>
  (await import('./test-fixtures/companion-vscode.js')).createCompanionVscodeApi(),
)
const archives = vi.hoisted(() => ({ cache: vi.fn(), list: vi.fn() }))
vi.mock('./companion-archive.js', () => ({
  EDITOR_COMPANION_PACKAGE: '@dsh-vscode/editor-bridge',
  cacheCompanionArchive: archives.cache,
  listCompanionArchives: archives.list,
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
  const manager = new EditorCompanionManagement({
    backend: () => backend,
    current: (candidate) => candidate === backend,
    extensionUri: FixtureUri.file(path.resolve('extension-fixture')) as unknown as vscode.Uri,
    storageUri: FixtureUri.file(path.resolve('storage-fixture')) as unknown as vscode.Uri,
    reconnect: undefined,
    active: () => false,
    enable,
    stop,
    halt: stop,
    undo: vi.fn().mockResolvedValue(undefined),
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
  }
}
describe('native editor companion installation and recovery', () => {
  it('restores the disabled state of the previous bundle after a failed upgrade', async () => {
    const { manager, listBundles, installBundle, setBundleEnabled } = fixture()
    archives.list.mockResolvedValue([{ version: '0.1.0', file: oldFile }])
    listBundles.mockResolvedValueOnce([{ ...old, enabled: false }]).mockResolvedValue([])
    installBundle.mockResolvedValueOnce({ ...applied, application: 'failed' }).mockResolvedValueOnce(applied)
    await manager.installBundled()
    expect(setBundleEnabled).toHaveBeenCalledWith('@dsh-vscode/editor-bridge', false, expect.any(AbortSignal))
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
    const id = installBundle.mock.calls[0]?.[1]?.requestId
    expect(waitForInstall).toHaveBeenCalledWith(id, expect.any(AbortSignal))
    await manager.installBundled()
    expect(installBundle).toHaveBeenCalledTimes(1)
    waitForInstall.mockResolvedValue(applied)
    await manager.manage()
    expect(waitForInstall).toHaveBeenLastCalledWith(id, expect.any(AbortSignal))
    expect(manager.busy).toBe(false)
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
    expect(removeBundle).toHaveBeenCalledWith('@dsh-vscode/editor-bridge', expect.any(AbortSignal))
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
