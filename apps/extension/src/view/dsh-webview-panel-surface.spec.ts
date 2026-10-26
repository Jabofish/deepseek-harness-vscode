import { beforeEach, describe, expect, it, vi } from 'vitest'

const vscodeMock = vi.hoisted(() => {
  interface FakeWebview {
    options: unknown
    html: string
    readonly cspSource: string
    asWebviewUri(uri: unknown): unknown
    postMessage(message: unknown): Promise<boolean>
    onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void }
  }
  interface FakePanel {
    title: string
    readonly viewColumn: unknown
    visible: boolean
    readonly webview: FakeWebview
    received: unknown[]
    posts: unknown[]
    revealed: { column: unknown; preserveFocus: unknown }[]
    onDidDispose(listener: () => void): { dispose(): void }
    onDidChangeViewState(listener: () => void): { dispose(): void }
    reveal(column?: unknown, preserveFocus?: boolean): void
    dispose(): void
    receive(message: unknown): void
    fireViewState(visible: boolean): void
    createdWith: {
      readonly viewType: string
      readonly title: string
      readonly showOptions: unknown
      readonly options: unknown
    }
  }
  const panels: FakePanel[] = []
  const createPanel = (
    viewType: string,
    title: string,
    showOptions: unknown,
    options: unknown,
  ): FakePanel => {
    const disposeListeners = new Set<() => void>()
    const viewStateListeners = new Set<() => void>()
    const received: unknown[] = []
    const posts: unknown[] = []
    const revealed: { column: unknown; preserveFocus: unknown }[] = []
    const panel: FakePanel = {
      title,
      viewColumn: showOptions,
      visible: true,
      received,
      posts,
      revealed,
      createdWith: { viewType, title, showOptions, options },
      webview: {
        options: undefined,
        html: '',
        cspSource: 'vscode-resource:',
        asWebviewUri: (uri: unknown) => uri,
        postMessage: (message: unknown) => {
          posts.push(message)
          return Promise.resolve(true)
        },
        onDidReceiveMessage: (listener: (message: unknown) => void) => {
          receiveListeners.push(listener)
          return { dispose: () => undefined }
        },
      },
      onDidDispose: (listener: () => void) => {
        disposeListeners.add(listener)
        return { dispose: () => disposeListeners.delete(listener) }
      },
      onDidChangeViewState: (listener: () => void) => {
        viewStateListeners.add(listener)
        return { dispose: () => viewStateListeners.delete(listener) }
      },
      reveal: (column?: unknown, preserveFocus?: boolean) => {
        revealed.push({ column, preserveFocus })
      },
      dispose: () => {
        for (const listener of [...disposeListeners]) listener()
      },
      receive: (message: unknown) => {
        for (const listener of [...receiveListeners]) listener(message)
      },
      fireViewState: (visible: boolean) => {
        panel.visible = visible
        for (const listener of [...viewStateListeners]) listener()
      },
    }
    return panel
  }
  const receiveListeners: ((message: unknown) => void)[] = []
  return {
    panels,
    receiveListeners,
    createWebviewPanel: (
      viewType: string,
      title: string,
      showOptions: unknown,
      options: unknown,
    ): FakePanel => {
      const panel = createPanel(viewType, title, showOptions, options)
      panels.push(panel)
      return panel
    },
  }
})

vi.mock('vscode', () => ({
  window: { createWebviewPanel: vscodeMock.createWebviewPanel },
  env: { language: 'en' },
  ViewColumn: { Active: -1 },
  Uri: {
    joinPath: (base: { readonly toString: () => string }, ...parts: readonly string[]) => ({
      toString: () => [base.toString(), ...parts].join('/'),
    }),
  },
}))

import { DshWebviewPanelSurface } from './dsh-webview-panel-surface.js'

const extensionUri = { toString: () => 'extension-root' } as never
const ready = (): unknown => ({ protocolVersion: 1, message: { type: 'app.ready', requestId: 'r1' } })

function createSurface(
  sessionId: string | undefined = 's1',
  options: { readonly failingMessageHandler?: boolean } = {},
): {
  surface: DshWebviewPanelSurface
  panel: (typeof vscodeMock.panels)[number]
  onBecameReady: ReturnType<typeof vi.fn>
  onDisposed: ReturnType<typeof vi.fn>
  onMessage: ReturnType<typeof vi.fn>
  onMessageError: ReturnType<typeof vi.fn>
} {
  const onBecameReady = vi.fn()
  const onDisposed = vi.fn()
  const onMessage = options.failingMessageHandler
    ? vi.fn().mockRejectedValue(new Error('the router rejected the message'))
    : vi.fn().mockResolvedValue(undefined)
  const onMessageError = vi.fn()
  const surface = DshWebviewPanelSurface.create({
    surfaceId: sessionId === '__unbound__' ? 'editor:unbound:1' : `editor:${sessionId}`,
    sessionId: sessionId === '__unbound__' ? undefined : sessionId,
    extensionUri,
    title: 'Session title',
    onMessage,
    onMessageError,
    onBecameReady,
    onDisposed,
  })
  const panel = vscodeMock.panels.at(-1)
  if (panel === undefined) throw new Error('the panel was not created')
  return { surface, panel, onBecameReady, onDisposed, onMessage, onMessageError }
}

describe('DshWebviewPanelSurface', () => {
  it('drops a message queued before the user closes the panel', async () => {
    const { panel, onMessage } = createSurface()
    panel.receive(ready())
    panel.dispose()
    await Promise.resolve()
    expect(onMessage).not.toHaveBeenCalled()
  })
  beforeEach(() => {
    vscodeMock.panels.length = 0
    vscodeMock.receiveListeners.length = 0
  })

  it('creates an editor panel that keeps its context and loads the packaged bundle', () => {
    const { panel, surface } = createSurface()

    expect(panel.createdWith.viewType).toBe('dsh.chatPanel')
    expect(panel.createdWith.title).toBe('Session title')
    expect(panel.createdWith.showOptions).toEqual({ viewColumn: -1, preserveFocus: false })
    expect(panel.createdWith.options).toEqual({ retainContextWhenHidden: true, enableFindWidget: true })
    expect(panel.webview.html).toContain('media/webview.js')
    expect(panel.webview.options).toMatchObject({ enableScripts: true })
    expect(panel.webview.options).toHaveProperty('localResourceRoots')
    expect(surface.kind).toBe('editor')
    expect(surface.sessionId).toBe('s1')
  })

  it('refuses to post before the validated ready handshake', async () => {
    const { surface, panel } = createSurface()

    expect(await surface.postMessage({ message: 'assigned' })).toBe(false)

    // A non-envelope message is still handed to the router (which ignores it)
    // and must not count as readiness.
    panel.receive({ message: { type: 'app.ready' } })
    await Promise.resolve()
    expect(await surface.postMessage({ message: 'assigned' })).toBe(false)

    panel.receive(ready())
    await Promise.resolve()
    expect(await surface.postMessage({ message: 'assigned' })).toBe(true)
    expect(panel.posts).toEqual([{ message: 'assigned' }])
  })
})
