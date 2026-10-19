import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BackendService } from '@dsh-vscode/application'
import type { DshBackend, BackendState } from '@dsh-vscode/domain'
import { EditorBridgeHost } from './editor-bridge-host.js'

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
  settings: { enabled: true, autoSetup: true, allowEdits: true },
  changeConfiguration: (_event: { affectsConfiguration: (section: string) => boolean }): void => {},
}))
vi.mock('./editor-integration-settings.js', () => ({
  readEditorPreferences: () => ui.settings,
  saveEditorPreferences: (change: Partial<typeof ui.settings>) => {
    Object.assign(ui.settings, change)
    return Promise.resolve()
  },
}))
vi.mock('vscode', () => ({
  workspace: {
    get isTrusted() {
      return ui.trusted
    },
    workspaceFolders: [{ uri: { scheme: 'file', fsPath: path.resolve('editor-bridge-fixture') } }],
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: (listener: typeof ui.changeConfiguration) => {
      ui.changeConfiguration = listener
      return { dispose() {} }
    },
    onDidGrantWorkspaceTrust: () => ({ dispose() {} }),
  },
  window: {
    showErrorMessage: ui.errors,
    showInformationMessage: ui.info,
    showQuickPick: ui.pick,
    showWarningMessage: ui.warning,
    createStatusBarItem: () => ({ show: ui.show, hide: ui.hide, dispose: ui.dispose }),
  },
  StatusBarAlignment: { Right: 2 },
}))
vi.mock('./companion-host-proof.js', () => ({ verifyCompanionHost: ui.proof }))
vi.mock('./editor-companion-provider.js', () => ({
  EditorCompanionProvider: class {
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
): {
  host: EditorBridgeHost
  attach: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  navigation: { activeSessionId: string | undefined }
  changeSelection: () => void
  disconnect: () => void
  connectionReady: () => void
} {
  ui.errors.mockClear()
  ui.show.mockClear()
  ui.hide.mockClear()
  ui.trusted = true
  ui.settings = { enabled: true, autoSetup: true, allowEdits: true }
  ui.pick.mockReset().mockResolvedValue([])
  ui.warning.mockReset().mockResolvedValue('Continue')
  ui.info.mockReset().mockResolvedValue(undefined)
  ui.proof.mockReset().mockResolvedValue(undefined)
  const attach = vi.fn().mockResolvedValue({ bindingId: 'fixture_binding_1234', protocolVersion: 1 })
  const detach = vi.fn().mockResolvedValue(undefined)
  const backend = {
    connection: { ownership, endpoint: { baseUrl: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000 } },
    sessions: { get: () => Promise.resolve({ id: 'session-a', cwd }) },
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
              attach: vi.fn().mockImplementation((...args: unknown[]) => {
                attach(...args)
                return Promise.resolve({ bindingId: 'fixture_binding_1234', protocolVersion: 2 })
              }),
              detach,
              poll: (_binding: string, signal: AbortSignal) =>
                new Promise((_resolve, reject) =>
                  signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
                ),
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
  const dependencies = {
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
    attach,
    detach,
    navigation,
    changeSelection: () => selection('selection'),
    disconnect: () => listener({ kind: 'idle' }),
    connectionReady: () => selection('connection'),
  }
}
describe('automatic editor sharing', () => {
  it('resumes from native settings after a previous explicit stop and reapplies read-only access', async () => {
    const { host, attach } = harness('managed', true)
    expect(await host.enable()).toBe(true)
    await host.stopByUser()
    ui.settings.enabled = true
    ui.settings.allowEdits = false
    ui.changeConfiguration({ affectsConfiguration: (section) => section === 'dsh.editor' })
    await vi.waitFor(() =>
      expect(attach).toHaveBeenLastCalledWith(
        'session-a',
        expect.any(String),
        ['content'],
        expect.any(AbortSignal),
      ),
    )
    expect(host.snapshot().phase).toBe('ready')
    await host.dispose()
  })
  it('reconciles after backend attachment and prepares a restored session before its first prompt', async () => {
    const { host, attach, navigation, connectionReady } = harness('managed', true)
    navigation.activeSessionId = undefined
    connectionReady()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(attach).not.toHaveBeenCalled()
    await host.prepareSession('restored-session', new AbortController().signal)
    expect(attach).toHaveBeenCalledWith(
      'restored-session',
      expect.any(String),
      ['content', 'edit'],
      expect.any(AbortSignal),
    )
    expect(host.snapshot().phase).toBe('ready')
    await host.stop()
    connectionReady()
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2))
    await host.dispose()
  })
  it('persists read-only/off settings and reattaches the latest selected session after rapid changes', async () => {
    const { host, attach, navigation, changeSelection } = harness('managed', true)
    expect(await host.enable()).toBe(true)
    const readonly = await host.configure({ allowEdits: false })
    expect(readonly.preferences.allowEdits).toBe(false)
    expect(attach).toHaveBeenLastCalledWith(
      'session-a',
      expect.any(String),
      ['content'],
      expect.any(AbortSignal),
    )
    navigation.activeSessionId = 'session-b'
    changeSelection()
    navigation.activeSessionId = 'session-c'
    changeSelection()
    await vi.waitFor(() =>
      expect(attach).toHaveBeenLastCalledWith(
        'session-c',
        expect.any(String),
        ['content'],
        expect.any(AbortSignal),
      ),
    )
    await host.configure({ enabled: false })
    const calls = attach.mock.calls.length
    changeSelection()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(attach).toHaveBeenCalledTimes(calls)
    expect(host.snapshot().phase).toBe('off')
    await host.dispose()
  })
  it('grants every advertised capability on the native action without a prompt', async () => {
    const { host, attach } = harness('managed', true)
    expect(await host.enable()).toBe(true)
    expect(ui.proof).toHaveBeenCalledTimes(1)
    expect(ui.pick).not.toHaveBeenCalled()
    expect(ui.warning).not.toHaveBeenCalled()
    expect(attach).toHaveBeenCalledWith(
      'session-a',
      expect.any(String),
      ['content', 'edit'],
      expect.any(AbortSignal),
    )
    expect(ui.info).not.toHaveBeenCalled()
    await host.dispose()
  })
  it('shares automatically for the selected session and follows session changes', async () => {
    const { host, attach, detach, navigation, changeSelection } = harness('managed', true)
    changeSelection()
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1))
    navigation.activeSessionId = 'session-b'
    changeSelection()
    await vi.waitFor(() => expect(detach).toHaveBeenCalledTimes(1))
    await host.dispose()
  })
  it('is idempotent while a grant is active', async () => {
    const { host, attach } = harness('managed', true)
    expect(await host.enable()).toBe(true)
    expect(await host.enable()).toBe(true)
    expect(attach).toHaveBeenCalledTimes(1)
    await host.dispose()
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
  it('shares a session that runs in a subfolder of the open root and rejects unrelated roots', async () => {
    const inside = harness('managed', true, path.resolve('editor-bridge-fixture/packages/app'))
    expect(await inside.host.enable()).toBe(true)
    expect(inside.attach).toHaveBeenCalledTimes(1)
    await inside.host.dispose()
    const outside = harness('managed', true, path.resolve('some-other-project'))
    expect(await outside.host.enable()).toBe(false)
    expect(outside.attach).not.toHaveBeenCalled()
    await outside.host.dispose()
  })
  it('reports when there is no applied edit to undo', async () => {
    const { host } = harness()
    await host.undoLastEdit()
    expect(ui.info).toHaveBeenCalledWith('No applied editor edit to undo.')
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
