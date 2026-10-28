import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BackendService } from '@dsh-vscode/application'
import {
  EditorCompanionError,
  type DshBackend,
  type BackendState,
  type EditorCompanionCapability,
  type EditorCompanionReply,
  type EditorCompanionResult,
} from '@dsh-vscode/domain'
import { EditorCompanionBroker } from '../../../../packages/dsh-editor-bridge/src/companion-broker.js'
import { EditorBridgeHost } from './editor-bridge-host.js'
import { EditorCompanionManagement } from './editor-companion-management.js'

import { companionNeedsUpdate } from './companion-update.js'

const ui = vi.hoisted(() => ({
  errors: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
  trusted: true,
  pick: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  proof: vi.fn(),
  execute: vi.fn(),
  command: vi.fn(),
  settings: { enabled: true, autoSetup: true, allowEdits: true },
  workspaceOpen: true,
  workspaceFile: false,
  updateSettings: vi.fn(),
  cancelProgress: (): void => {},
  changeConfiguration: (_event: { affectsConfiguration: (section: string) => boolean }): void => {},
}))
vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  workspace: {
    get isTrusted() {
      return ui.trusted
    },
    get workspaceFolders() {
      return ui.workspaceOpen
        ? [{ uri: { scheme: 'file', fsPath: path.resolve('editor-bridge-fixture') } }]
        : undefined
    },
    get workspaceFile() {
      return ui.workspaceFile ? { scheme: 'untitled' } : undefined
    },
    getConfiguration: () => ({
      get: (key: keyof typeof ui.settings) => ui.settings[key],
      update: ui.updateSettings,
    }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: (listener: typeof ui.changeConfiguration) => {
      ui.changeConfiguration = listener
      return { dispose() {} }
    },
    onDidGrantWorkspaceTrust: () => ({ dispose() {} }),
  },
  window: {
    withProgress: (
      _options: unknown,
      task: (
        _progress: unknown,
        token: { onCancellationRequested(callback: () => void): { dispose(): void } },
      ) => Promise<unknown>,
    ) =>
      task(
        {},
        {
          onCancellationRequested: (callback) => {
            ui.cancelProgress = callback
            return { dispose() {} }
          },
        },
      ),
    showErrorMessage: ui.errors,
    showInformationMessage: ui.info,
    showQuickPick: ui.pick,
    showWarningMessage: ui.warning,
    createStatusBarItem: () => ({ show: ui.show, hide: ui.hide, dispose: ui.dispose }),
  },
  StatusBarAlignment: { Right: 2 },
  ProgressLocation: { Notification: 15 },
  Uri: {
    joinPath: (root: { fsPath: string }, ...parts: string[]) => ({
      fsPath: path.join(root.fsPath, ...parts),
    }),
  },
  commands: { executeCommand: ui.command },
}))
vi.mock('./companion-host-proof.js', () => ({ verifyCompanionHost: ui.proof }))
vi.mock('./companion-update.js', () => ({ companionNeedsUpdate: vi.fn(() => Promise.resolve(false)) }))
vi.mock('./companion-prerequisites.js', () => ({
  checkCompanionPackageManager: () => Promise.resolve('ready'),
  prepareCompanionPackageManager: vi.fn(() => Promise.resolve()),
  PNPM_INSTALL_COMMAND: 'npm install --global pnpm@11.19.0 --ignore-scripts',
  PNPM_INSTALL_GUIDE: 'https://pnpm.io/installation',
}))
vi.mock('./editor-companion-provider.js', () => ({
  EditorCompanionProvider: class {
    readonly execute = ui.execute
    readonly proposals = { lastApplied: () => undefined, undo: () => Promise.resolve(false) }
    dispose(): void {}
  },
}))
vi.mock('./editor-state-provider.js', () => ({
  EditorStateProvider: class {
    read(): Promise<never> {
      return Promise.reject(new Error('No fixture tool request.'))
    }
  },
}))

function harness(
  ownership: 'managed' | 'external' = 'managed',
  rich = false,
  cwd = path.resolve('editor-bridge-fixture'),
  broker?: EditorCompanionBroker,
  withSetup = false,
): {
  host: EditorBridgeHost
  attach: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  navigation: { activeSessionId: string | undefined }
  changeSelection: () => void
  disconnect: () => void
  connectionReady: () => void
  replaceBackend: () => void
  backendService: BackendService
  reconnect: ReturnType<typeof vi.fn<(signal?: AbortSignal) => Promise<unknown>>>
} {
  ui.errors.mockClear()
  vi.mocked(companionNeedsUpdate).mockReset().mockResolvedValue(false)
  ui.show.mockClear()
  ui.hide.mockClear()
  ui.trusted = true
  ui.settings = { enabled: true, autoSetup: true, allowEdits: true }
  ui.workspaceOpen = true
  ui.workspaceFile = false
  ui.updateSettings
    .mockReset()
    .mockImplementation((key: keyof typeof ui.settings, value: boolean, target: number) => {
      if (target === 2 && !ui.workspaceOpen && !ui.workspaceFile)
        return Promise.reject(new Error('No workspace is open to save workspace settings.'))
      ui.settings[key] = value
      return Promise.resolve()
    })
  ui.pick.mockReset().mockResolvedValue([])
  ui.warning.mockReset().mockResolvedValue('Continue')
  ui.info.mockReset().mockResolvedValue(undefined)
  ui.proof.mockReset().mockResolvedValue(undefined)
  ui.command.mockReset().mockResolvedValue(undefined)
  ui.execute.mockReset().mockResolvedValue({
    kind: 'document',
    relativePath: 'sample.ts',
    version: 1,
    languageId: 'typescript',
    dirty: false,
    text: 'selected',
    truncated: false,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 9 } },
  })
  const value = <T>(result: EditorCompanionResult<T>): T => {
    if (result.status === 'error') throw new EditorCompanionError(result.reason)
    return result.value
  }
  const attach = vi.fn().mockResolvedValue({ bindingId: 'fixture_binding_1234', protocolVersion: 1 })
  const detach = vi.fn().mockResolvedValue(undefined)
  let backend = {
    connection: { ownership, endpoint: { baseUrl: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000 } },
    sessions: { get: () => Promise.resolve({ id: 'session-a', cwd }) },
    pluginBundles: { listBundles: vi.fn().mockResolvedValue([]) },
    events: { subscribe: () => () => undefined },
    editorBridge: {
      ...(rich
        ? {
            companion: {
              describe: () =>
                Promise.resolve({
                  protocolVersion: 2,
                  packageVersion: '0.2.0',
                  capabilities: ['content', 'edit'],
                  maxGrants: 16,
                }),
              attach: vi
                .fn()
                .mockImplementation(
                  (
                    sessionId: string,
                    ownerId: string,
                    capabilities: readonly EditorCompanionCapability[],
                    signal: AbortSignal,
                  ) => {
                    attach(sessionId, ownerId, capabilities, signal)
                    return Promise.resolve(
                      broker === undefined
                        ? { bindingId: 'fixture_binding_1234', protocolVersion: 2 }
                        : value(broker.attach(sessionId, ownerId, 'fixture-peer', capabilities)),
                    )
                  },
                ),
              detach: (binding: string) => {
                detach(binding)
                if (broker !== undefined) value(broker.detach(binding, 'fixture-peer'))
                return Promise.resolve()
              },
              respond: (binding: string, id: string, reply: EditorCompanionReply) => {
                if (broker !== undefined) value(broker.respond(binding, 'fixture-peer', id, reply))
                return Promise.resolve()
              },
              poll: (binding: string, signal: AbortSignal) =>
                broker === undefined
                  ? new Promise((_resolve, reject) =>
                      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
                    )
                  : broker.poll(binding, 'fixture-peer', signal).then(value),
            },
          }
        : {}),
      attach,
      detach,
      respond: vi.fn(),
      poll: (_binding: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          if (signal.aborted) reject(new Error('cancelled'))
          else signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        }),
    },
  } as unknown as DshBackend
  const backendService = new BackendService()
  backendService.attach(backend, () => undefined)
  let listener: (state: BackendState) => void = () => undefined
  let selection: (change?: string) => void = () => undefined
  const navigation = {
    activeSessionId: 'session-a' as string | undefined,
    select: (id: string) => {
      navigation.activeSessionId = id
      selection('selection')
    },
    onDidChange: (callback: (change?: string) => void) => {
      selection = callback
      return { dispose() {} }
    },
  }
  const reconnect = vi.fn<(signal?: AbortSignal) => Promise<unknown>>().mockResolvedValue(undefined)
  const dependencies = {
    ...(withSetup
      ? { context: { extensionUri: { fsPath: path.resolve('extension-fixture') } }, reconnect }
      : {}),
    backendService,
    coordinator: {
      getState: () => ({ kind: 'connected', backend: backend.connection }),
      subscribe: (callback: typeof listener) => {
        listener = callback
        return () => undefined
      },
    },
    sessionNavigation: navigation,
  } as unknown as ConstructorParameters<typeof EditorBridgeHost>[0]
  return {
    host: new EditorBridgeHost(dependencies),
    reconnect,
    attach,
    detach,
    navigation,
    changeSelection: () => selection('selection'),
    disconnect: () => listener({ kind: 'idle' }),
    connectionReady: () => selection('connection'),
    backendService,
    replaceBackend: () => {
      backend = { ...backend, connection: { ...backend.connection } }
      backendService.attach(backend, () => undefined)
      listener({ kind: 'connected', backend: backend.connection })
    },
  }
}
describe('automatic editor sharing', () => {
  it.each([
    { workspaceOpen: false, workspaceFile: false, target: 1 },
    { workspaceOpen: true, workspaceFile: false, target: 2 },
    { workspaceOpen: false, workspaceFile: true, target: 2 },
  ])(
    'starts installation with the actual preference writer in window $workspaceOpen/$workspaceFile',
    async (window) => {
      const install = vi.spyOn(EditorCompanionManagement.prototype, 'installBundled').mockResolvedValue(true)
      const { host } = harness('managed', true, undefined, undefined, true)
      ui.workspaceOpen = window.workspaceOpen
      ui.workspaceFile = window.workspaceFile
      ui.settings.autoSetup = false
      try {
        await host.action('setup')
        expect(install).toHaveBeenCalledWith({ silent: true })
        expect(ui.updateSettings).toHaveBeenCalledWith('enabled', true, window.target)
        expect(ui.updateSettings).toHaveBeenCalledWith('autoSetup', true, window.target)
        expect(host.snapshot().preferences).toMatchObject({ enabled: true, autoSetup: true })
      } finally {
        await host.dispose()
        install.mockRestore()
      }
    },
  )
  it('preserves read-only and off controls in an empty window', async () => {
    const { host } = harness('managed', true)
    ui.workspaceOpen = false
    try {
      expect((await host.configure({ allowEdits: false })).preferences.allowEdits).toBe(false)
      expect(await host.configure({ enabled: false })).toMatchObject({
        phase: 'off',
        preferences: { enabled: false, allowEdits: false },
      })
      expect(ui.updateSettings).toHaveBeenCalledWith('allowEdits', false, 1)
      expect(ui.updateSettings).toHaveBeenCalledWith('enabled', false, 1)
    } finally {
      await host.dispose()
    }
  })

  it('blocks sharing after failed recovery and routes restoration through the native manager', async () => {
    const blocked = vi
      .spyOn(EditorCompanionManagement.prototype, 'sharingBlocked', 'get')
      .mockReturnValue(true)
    const restore = vi
      .spyOn(EditorCompanionManagement.prototype, 'restoreCached')
      .mockResolvedValue(undefined)
    const { host, attach } = harness('managed', true, undefined, undefined, true)
    try {
      expect(await host.enable()).toBe(false)
      expect(attach).not.toHaveBeenCalled()
      expect(host.snapshot()).toMatchObject({ phase: 'limited', reason: 'setup-failed' })
      await host.action('restore')
      expect(restore).toHaveBeenCalledOnce()
    } finally {
      await host.dispose()
      blocked.mockRestore()
      restore.mockRestore()
    }
  })

  it('does not install a missing plugin package in the background even with automatic updates enabled', async () => {
    const install = vi.spyOn(EditorCompanionManagement.prototype, 'installBundled').mockResolvedValue(false)
    const { host } = harness('managed', false, undefined, undefined, true)
    try {
      await host.prepareSession('session-a', new AbortController().signal)
      await vi.waitFor(() => expect(host.snapshot().reason).toBe('missing'))
      expect(install).not.toHaveBeenCalled()
    } finally {
      await host.dispose()
      install.mockRestore()
    }
  })

  it('installs the standard bundle only after an explicit setup action', async () => {
    const install = vi.spyOn(EditorCompanionManagement.prototype, 'installBundled').mockResolvedValue(true)
    const { host, reconnect } = harness('managed', true, undefined, undefined, true)
    ui.settings.autoSetup = false
    try {
      await host.prepareSession('session-a', new AbortController().signal)
      expect(ui.settings.autoSetup).toBe(false)
      expect(reconnect).not.toHaveBeenCalled()
      expect(host.snapshot().canInstall).toBe(true)
      await host.action('setup')
      expect(ui.settings).toMatchObject({ autoSetup: true, enabled: true })
      expect(install).toHaveBeenCalledWith({ silent: true })
      expect(reconnect).not.toHaveBeenCalled()
      install.mockResolvedValue(false)
      expect(await host.action('setup')).toMatchObject({ phase: 'limited', reason: 'setup-failed' })
    } finally {
      await host.dispose()
    }
    const external = harness('external', true, undefined, undefined, true)
    try {
      ui.settings.autoSetup = false
      expect(external.host.snapshot().canInstall).toBe(false)
      await external.host.action('setup')
      expect(external.reconnect).not.toHaveBeenCalled()
      expect(ui.settings.autoSetup).toBe(false)
    } finally {
      await external.host.dispose()
      install.mockRestore()
    }
  })

  it('executes selection tools across a new-session switch with an unrelated cwd through the real broker and service', async () => {
    const broker = new EditorCompanionBroker()
    const { host } = harness('managed', true, path.resolve('some-other-project'), broker)
    try {
      await host.enable()
      await expect(
        broker.read('session-a', { kind: 'selection' }, new AbortController().signal),
      ).resolves.toMatchObject({ text: 'selected' })
      await host.prepareSession('new-session', new AbortController().signal)
      await vi.waitFor(() => expect(broker.hasSession('session-a')).toBe(false))
      await expect(
        broker.read('new-session', { kind: 'selection' }, new AbortController().signal),
      ).resolves.toMatchObject({ text: 'selected' })
      expect(host.snapshot().phase).toBe('ready')
    } finally {
      await host.dispose()
      broker.dispose()
    }
  })
  it('prompts on the first actual tool request and resumes after trust, without silent not-bound errors', async () => {
    const broker = new EditorCompanionBroker()
    const { host } = harness('managed', true, path.resolve('some-other-project'), broker)
    ui.trusted = false
    try {
      await host.prepareSession('new-session', new AbortController().signal)
      expect(ui.info).not.toHaveBeenCalled()
      await expect(
        broker.read('new-session', { kind: 'selection' }, new AbortController().signal),
      ).rejects.toMatchObject({ reason: 'untrusted' })
      expect(ui.info).toHaveBeenCalledWith(
        expect.stringContaining('Trust this VS Code workspace'),
        'Manage Workspace Trust',
      )
      expect(ui.execute).not.toHaveBeenCalled()
      ui.trusted = true
      await expect(
        broker.read('new-session', { kind: 'selection' }, new AbortController().signal),
      ).resolves.toMatchObject({ text: 'selected' })
      expect(host.snapshot()).toMatchObject({ phase: 'ready' })
    } finally {
      await host.dispose()
      broker.dispose()
    }
  })

  it('rejects a failed same-host proof before creating a grant', async () => {
    const failed = harness('managed', true)
    ui.proof.mockRejectedValue(new Error('different filesystem'))
    expect(await failed.host.enable()).toBe(false)
    expect(failed.attach).not.toHaveBeenCalled()
    await failed.host.dispose()
  })
  it('does not resume after an explicit stop until it is turned back on', async () => {
    const { host, attach, changeSelection } = harness('managed', true)
    expect(await host.enable()).toBe(true)
    await host.stopByUser()
    changeSelection()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(attach).toHaveBeenCalledTimes(1)
    expect(await host.enable()).toBe(true)
    expect(attach).toHaveBeenCalledTimes(2)
    await host.dispose()
  })
  it('rejects external instances and untrusted workspaces before contacting the companion', async () => {
    const external = harness('external')
    expect(await external.host.enable()).toBe(false)
    expect(external.attach).not.toHaveBeenCalled()
    await external.host.dispose()
    const untrusted = harness()
    ui.trusted = false
    expect(await untrusted.host.enable()).toBe(false)
    expect(untrusted.attach).not.toHaveBeenCalled()
    await untrusted.host.dispose()
  })

  it('binds a request channel in restricted mode without reading files or prompting during navigation', async () => {
    const { host, attach } = harness('managed', true)
    ui.trusted = false
    expect(await host.enable()).toBe(true)
    expect(attach).toHaveBeenCalledTimes(1)
    expect(host.snapshot()).toMatchObject({ phase: 'waiting', reason: 'untrusted' })
    expect(ui.info).not.toHaveBeenCalled()
    await host.dispose()
  })

  it('cancels sharing and clears its native indicator on disconnect', async () => {
    const { host, disconnect, detach } = harness()
    expect(await host.enable()).toBe(true)
    disconnect()
    await vi.waitFor(() => expect(detach).toHaveBeenCalledTimes(1))
    await host.dispose()
  })
})
