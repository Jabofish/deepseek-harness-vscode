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
  proof: vi.fn(),
}))
vi.mock('vscode', () => ({
  workspace: {
    get isTrusted() {
      return ui.trusted
    },
    workspaceFolders: [{ uri: { scheme: 'file', fsPath: path.resolve('editor-bridge-fixture') } }],
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
  },
  window: {
    showErrorMessage: ui.errors,
    showQuickPick: ui.pick,
    showWarningMessage: ui.warning,
    createStatusBarItem: () => ({ show: ui.show, hide: ui.hide, dispose: ui.dispose }),
  },
  StatusBarAlignment: { Right: 2 },
}))
vi.mock('./companion-host-proof.js', () => ({ verifyCompanionHost: ui.proof }))
vi.mock('./editor-companion-provider.js', () => ({
  EditorCompanionProvider: class {
    readonly proposals = { pending: () => [] }
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
): {
  host: EditorBridgeHost
  attach: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  navigation: { activeSessionId: string | undefined }
  changeSelection: () => void
  disconnect: () => void
} {
  ui.errors.mockClear()
  ui.show.mockClear()
  ui.hide.mockClear()
  ui.trusted = true
  ui.pick.mockReset().mockResolvedValue([])
  ui.warning.mockReset().mockResolvedValue('Continue')
  ui.proof.mockReset().mockResolvedValue(undefined)
  const attach = vi.fn().mockResolvedValue({ bindingId: 'fixture_binding_1234', protocolVersion: 1 })
  const detach = vi.fn().mockResolvedValue(undefined)
  const backend = {
    connection: { ownership, endpoint: { baseUrl: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000 } },
    sessions: { get: () => Promise.resolve({ id: 'session-a', cwd: path.resolve('editor-bridge-fixture') }) },
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
  let selection: () => void = () => undefined
  const navigation = {
    activeSessionId: 'session-a' as string | undefined,
    onDidChange: (callback: () => void) => {
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
    changeSelection: () => selection(),
    disconnect: () => listener({ kind: 'idle' }),
  }
}
describe('native editor sharing lifetime', () => {
  it('negotiates capabilities, defaults to metadata and revokes a rich grant on session change', async () => {
    const { host, attach, detach, navigation, changeSelection } = harness('managed', true)
    expect(await host.enable()).toBe(true)
    expect(ui.proof).toHaveBeenCalledTimes(1)
    expect(ui.pick).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ capability: 'content', picked: false })]),
      expect.objectContaining({ canPickMany: true }),
    )
    expect(attach).toHaveBeenCalledWith('session-a', expect.any(String), [], expect.any(AbortSignal))
    navigation.activeSessionId = 'session-b'
    changeSelection()
    await vi.waitFor(() => expect(detach).toHaveBeenCalledTimes(1))
    await host.dispose()
  })
  it('rejects a failed same-host proof and dismissed external consent before creating a grant', async () => {
    const failed = harness('managed', true)
    ui.proof.mockRejectedValue(new Error('different filesystem'))
    expect(await failed.host.enable()).toBe(false)
    expect(failed.attach).not.toHaveBeenCalled()
    await failed.host.dispose()
    const external = harness('external', true)
    ui.warning.mockResolvedValue(undefined)
    expect(await external.host.enable()).toBe(false)
    expect(external.attach).not.toHaveBeenCalled()
    ui.warning.mockResolvedValue('Continue')
    ui.pick.mockResolvedValue([{ capability: 'content' }])
    expect(await external.host.enable()).toBe(true)
    expect(external.attach).toHaveBeenCalledWith(
      'session-a',
      expect.any(String),
      ['content'],
      expect.any(AbortSignal),
    )
    await external.host.dispose()
  })
  it('starts only on the native action and revokes when the selected session changes', async () => {
    const { host, attach, detach, navigation, changeSelection } = harness()
    expect(attach).not.toHaveBeenCalled()
    expect(await host.enable()).toBe(true)
    expect(ui.show).toHaveBeenCalledTimes(1)
    navigation.activeSessionId = 'session-b'
    changeSelection()
    await vi.waitFor(() => expect(detach).toHaveBeenCalledTimes(1))
    expect(ui.hide).toHaveBeenCalled()
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
  it('cancels sharing and clears its native indicator on disconnect', async () => {
    const { host, disconnect, detach } = harness()
    expect(await host.enable()).toBe(true)
    disconnect()
    await vi.waitFor(() => expect(detach).toHaveBeenCalledTimes(1))
    await host.dispose()
  })
})
