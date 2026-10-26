import { beforeEach, describe, expect, it, vi } from 'vitest'

const vscodeMock = vi.hoisted(() => {
  interface FakePanel {
    title: string
    viewColumn: unknown
    visible: boolean
    readonly webview: {
      options: unknown
      html: string
      readonly cspSource: string
      asWebviewUri(uri: unknown): unknown
      postMessage(message: unknown): Promise<boolean>
      onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void }
    }
    onDidDispose(listener: () => void): { dispose(): void }
    onDidChangeViewState(listener: () => void): { dispose(): void }
    reveal(column?: unknown, preserveFocus?: boolean): void
    dispose(): void
    close(): void
  }
  const panels: FakePanel[] = []
  const receiveListeners: ((message: unknown) => void)[] = []
  const createWebviewPanel = (
    viewType: string,
    title: string,
    options: { viewColumn?: unknown } = {},
  ): FakePanel => {
    void viewType
    const listeners = new Set<() => void>()
    const panel: FakePanel = {
      title,
      viewColumn: options.viewColumn,
      visible: true,
      webview: {
        options: undefined,
        html: '',
        cspSource: 'vscode-resource:',
        asWebviewUri: (uri: unknown) => uri,
        postMessage: () => Promise.resolve(true),
        onDidReceiveMessage: (listener: (message: unknown) => void) => {
          receiveListeners.push(listener)
          return { dispose: () => undefined }
        },
      },
      onDidDispose: (listener: () => void) => {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },
      onDidChangeViewState: () => ({ dispose: () => undefined }),
      reveal: (column) => {
        if (column !== undefined) panel.viewColumn = column
      },
      dispose: () => {
        for (const listener of [...listeners]) listener()
      },
      close: () => undefined,
    }
    panels.push(panel)
    return panel
  }
  return { panels, receiveListeners, createWebviewPanel }
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

import { EditorChatSurfaceManager } from './editor-chat-surface-manager.js'

import { WebviewSurfaceRegistry } from './webview-surface-registry.js'

const extensionUri = { toString: () => 'extension-root' } as never

interface Harness {
  readonly manager: EditorChatSurfaceManager
  readonly surfaces: WebviewSurfaceRegistry
  readonly counts: number[]
  readonly ready: string[]
  readonly disposed: string[]
  readonly messages: string[]
  readonly lastPanel: () => (typeof vscodeMock.panels)[number]
}

function createHarness(): Harness {
  const counts: number[] = []
  const ready: string[] = []
  const disposed: string[] = []
  const messages: string[] = []
  const surfaces = new WebviewSurfaceRegistry()
  const manager = new EditorChatSurfaceManager({
    surfaces,
    extensionUri,
    onMessage: (surfaceId) => {
      messages.push(surfaceId)
      return Promise.resolve()
    },
    onMessageError: () => undefined,
    onBecameReady: (surface) => ready.push(surface.surfaceId),
    onDisposed: (surface) => disposed.push(surface.surfaceId),
    onCountChanged: (count) => counts.push(count),
  })
  return {
    manager,
    surfaces,
    counts,
    ready,
    disposed,
    messages,
    lastPanel: () => vscodeMock.panels.at(-1) as (typeof vscodeMock.panels)[number],
  }
}

describe('EditorChatSurfaceManager', () => {
  beforeEach(() => {
    vscodeMock.panels.length = 0
  })

  it('opens one editor tab per session and reveals the existing one', async () => {
    const harness = createHarness()

    const first = harness.manager.open('session-1', 'First session')
    const second = harness.manager.open('session-1', 'First session')

    expect(vscodeMock.panels).toHaveLength(1)
    expect(second).toBe(first)
    expect(first.surfaceId).toBe('editor:session-1')
    expect(first.sessionId).toBe('session-1')
    expect(harness.manager.count).toBe(1)
    expect(harness.counts).toEqual([1])
    expect(harness.surfaces.get('editor:session-1')).toBe(first)
    expect(harness.lastPanel().title).toBe('First session')
    await Promise.resolve()
  })

  it('opens into the native drop group and moves an existing tab there without duplicating it', () => {
    const harness = createHarness()
    harness.manager.open('session-1', 'One', 2)
    const panel = harness.lastPanel()
    expect(panel.viewColumn).toBe(2)
    harness.manager.open('session-1', 'One', 3)
    expect(panel.viewColumn).toBe(3)
    expect(harness.manager.count).toBe(1)
    expect(vscodeMock.panels).toHaveLength(1)
  })

  it('cannot create or bind a late editor after disposal', () => {
    const harness = createHarness()
    const surface = harness.manager.open('session-1')
    harness.manager.dispose()
    expect(() => harness.manager.open('session-2')).toThrow('closed')
    expect(() => harness.manager.bind(surface.surfaceId, 'session-2')).toThrow('closed')
    expect(harness.manager.count).toBe(0)
    expect(vscodeMock.panels).toHaveLength(1)
  })

  it('adopts a panel restored after a window reload without creating a new one', () => {
    const harness = createHarness()
    const restored = {
      title: 'Restored session',
      visible: true,
      webview: {
        options: undefined,
        html: '',
        cspSource: 'vscode-resource:',
        asWebviewUri: (uri: unknown) => uri,
        postMessage: () => Promise.resolve(true),
        onDidReceiveMessage: () => ({ dispose: () => undefined }),
      },
      onDidDispose: () => ({ dispose: () => undefined }),
      onDidChangeViewState: () => ({ dispose: () => undefined }),
      reveal: () => undefined,
      dispose: () => undefined,
    }

    const surface = harness.manager.adopt(restored as never, 'session-9')

    expect(vscodeMock.panels).toHaveLength(0)
    expect(surface.surfaceId).toBe('editor:session-9')
    expect(harness.manager.count).toBe(1)
    expect(harness.manager.forSession('session-9')).toBe(surface)
    expect(harness.counts).toEqual([1])
  })

  it('routes a panel message with the surface identity', async () => {
    const harness = createHarness()
    harness.manager.open('session-1', 'One')

    for (const listener of [...vscodeMock.receiveListeners]) {
      listener({ protocolVersion: 1, message: { type: 'app.ready', requestId: 'ready-1' } })
    }
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(harness.messages).toEqual(['editor:session-1'])
    expect(harness.ready).toEqual(['editor:session-1'])
  })

  it('disposes every tab when the extension shuts down', () => {
    const harness = createHarness()
    harness.manager.open('session-1', 'One')
    harness.manager.open('session-2', 'Two')

    harness.manager.dispose()

    expect(harness.manager.count).toBe(0)
    expect(harness.disposed).toEqual(['editor:session-1', 'editor:session-2'])
    // A second dispose is a no-op.
    harness.manager.dispose()
    expect(harness.disposed).toHaveLength(2)
  })
})
