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
    createStatusBarItem: () => ({ show: ui.show, hide: ui.hide, dispose: ui.dispose }),
  },
  StatusBarAlignment: { Right: 2 },
}))
vi.mock('./editor-state-provider.js', () => ({
  EditorStateProvider: class {
    read(): Promise<never> {
      return Promise.reject(new Error('No fixture tool request.'))
    }
  },
}))

function harness(ownership: 'managed' | 'external' = 'managed'): {
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
  const attach = vi.fn().mockResolvedValue({ bindingId: 'fixture_binding_1234', protocolVersion: 1 })
  const detach = vi.fn().mockResolvedValue(undefined)
  const backend = {
    connection: { ownership, endpoint: { baseUrl: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000 } },
    sessions: { get: () => Promise.resolve({ id: 'session-a', cwd: path.resolve('editor-bridge-fixture') }) },
    events: { subscribe: () => () => undefined },
    editorBridge: {
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
