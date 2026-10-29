import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionDetail } from '@dsh-vscode/domain'

const host = vi.hoisted(() => {
  const panels: {
    readonly title: string
    disposeCount: number
    receive(message: unknown): void
    setVisible(visible: boolean): void
  }[] = []
  return {
    panels,
    isTrusted: true,
    renamedTitle: 'Renamed session',
    commands: [] as string[],
    contexts: [] as { readonly key: unknown; readonly value: unknown }[],
    focusFails: false,
    deliveryFails: false,
    sessionGate: undefined as Promise<void> | undefined,
    createGate: undefined as Promise<void> | undefined,
    createStarted: false,
    connectCount: 0,
    responseRendered: vi.fn(() => ({ bell: true })),
  }
})

vi.mock('vscode', () => ({
  workspace: {
    get isTrusted() {
      return host.isTrusted
    },
  },
  commands: {
    executeCommand: (command: string, ...args: unknown[]) => {
      host.commands.push(command)
      if (command === 'setContext') host.contexts.push({ key: args[0], value: args[1] })
      if (host.focusFails) return Promise.reject(new Error('The sidebar cannot be focused.'))
      return Promise.resolve(undefined)
    },
  },
  window: {
    createWebviewPanel: (viewType: string, title: string) => {
      void viewType
      const listeners = new Set<() => void>()
      const visibilityListeners = new Set<() => void>()
      let receive: ((message: unknown) => void) | undefined
      const panel = {
        title,
        disposeCount: 0,
        visible: true,
        webview: {
          options: undefined,
          html: '',
          cspSource: 'vscode-resource:',
          asWebviewUri: (uri: unknown) => uri,
          postMessage: () => Promise.resolve(true),
          onDidReceiveMessage: (listener: (message: unknown) => void) => {
            receive = listener
            return { dispose: () => undefined }
          },
        },
        onDidDispose: (listener: () => void) => {
          listeners.add(listener)
          return { dispose: () => listeners.delete(listener) }
        },
        onDidChangeViewState: (listener: () => void) => {
          visibilityListeners.add(listener)
          return { dispose: () => visibilityListeners.delete(listener) }
        },
        receive: (message: unknown) => receive?.(message),
        setVisible: (visible: boolean) => {
          panel.visible = visible
          for (const listener of visibilityListeners) listener()
        },
        reveal: () => undefined,
        dispose: () => {
          panel.disposeCount += 1
          for (const listener of [...listeners]) listener()
        },
      }
      host.panels.push(panel)
      return panel
    },
  },
  env: { language: 'en' },
  ViewColumn: { Active: -1 },
  Uri: {
    joinPath: (base: { readonly toString: () => string }, ...parts: readonly string[]) => ({
      toString: () => [base.toString(), ...parts].join('/'),
    }),
  },
}))

import { createRequestGateway } from './request-handler.js'
import { WebviewSurfaceRegistry } from '../view/webview-surface-registry.js'
import { transcriptWindowFixture } from '../view/transcript-window.fixture.js'

type Sent = {
  readonly surfaceId: string | undefined
  readonly type: string
  readonly requestId?: string
  readonly name?: string
  readonly payload?: unknown
  readonly ok?: boolean
  readonly error?: { readonly code?: string }
}

interface Harness {
  readonly transcript: ReturnType<typeof transcriptWindowFixture>
  readonly gateway: ReturnType<typeof createRequestGateway>
  readonly sent: Sent[]
  readonly events: Sent[]
  readonly surfaces: WebviewSurfaceRegistry
  readonly teardowns: string[]
  readonly watchShown: { readonly surfaceId: string; readonly sessionId: string }[]
  readonly watchReleased: string[]
  readonly watchVisibility: { readonly surfaceId: string; readonly visible: boolean }[]
  readonly openSidebar: () => void
  readonly setSidebarVisible: (visible: boolean) => void
  readonly receive: (message: unknown) => void
  readonly rejectSession: (sessionId: string) => void
}

function detail(id: string): SessionDetail {
  return {
    id,
    workspaceId: 'w1',
    title: 'Session title',
    blank: true,
    status: 'idle',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    history: [],
    configuration: {
      preset: 'default',
      toolMode: 'native',
      permissionPreset: 'default',
      planMode: false,
      model: { providerId: 'fixture', modelId: 'fixture' },
    },
  }
}

function buildGateway(): Harness {
  host.panels.length = 0
  host.commands = []
  host.contexts = []
  host.isTrusted = true
  host.focusFails = false
  host.deliveryFails = false
  host.sessionGate = undefined
  host.createGate = undefined
  host.createStarted = false
  host.connectCount = 0
  host.responseRendered.mockClear()
  const sent: Sent[] = []
  const events: Sent[] = []
  const rejected = new Set<string>()
  const listeners: ((message: unknown) => void)[] = []
  const teardowns: string[] = []
  const surfaces = new WebviewSurfaceRegistry()
  const record = (target: Sent[], surfaceId: string | undefined, message: unknown): void => {
    const parsed = message as { readonly message?: { readonly type?: string } }
    const entry = message as Sent
    target.push({
      ...entry,
      surfaceId,
      type: parsed.message?.type ?? entry.type ?? 'unknown',
    })
  }
  const transcript = transcriptWindowFixture()
  const watchShown: { readonly surfaceId: string; readonly sessionId: string }[] = []
  const watchReleased: string[] = []
  const watchVisibility: { readonly surfaceId: string; readonly visible: boolean }[] = []
  let sidebarVisible: ((visible: boolean) => void) | undefined
  const gateway = createRequestGateway({
    responseRendered: host.responseRendered,
    transcript,
    post: (message: unknown) => {
      record(sent, undefined, message)
      return Promise.resolve(true)
    },
    postTo: (surfaceId: string, message: unknown) => {
      record(sent, surfaceId, message)
      return Promise.resolve(true)
    },
    postEvent: (name: string, payload: unknown) => {
      events.push({ surfaceId: undefined, type: 'event', name, payload })
      return Promise.resolve(true)
    },
    postEventTo: (surfaceId: string, name: string, payload: unknown) => {
      events.push({ surfaceId, type: 'event', name, payload })
      return Promise.resolve(!host.deliveryFails)
    },
    surfaces,
    diagnostics: { log: () => {}, show: () => {}, recentEvents: () => [] },
    context: {
      extensionUri: { fsPath: '/extension' },
      subscriptions: [],
      workspaceState: { update: () => Promise.resolve() },
    },
    currentWorkspaceFolders: () => [{ uri: { fsPath: '/project' }, name: 'project', index: 0 }],
    stopAllJobFollows: () => teardowns.push('job-follows'),
    sessionWatch: {
      surfaceDisplaysSession: (surfaceId: string, sessionId: string) => {
        watchShown.push({ surfaceId, sessionId })
      },
      surfaceReleased: (surfaceId: string) => {
        watchReleased.push(surfaceId)
      },
      surfaceVisibilityChanged: (surfaceId: string, visible: boolean) => {
        watchVisibility.push({ surfaceId, visible })
      },
      attach: () => undefined,
      detach: () => undefined,
      dispose: () => undefined,
    },
    backendService: {
      replayEvents: () => [],
      requireBackend: () => ({ sessions: { rename: () => Promise.resolve(host.renamedTitle) } }),
    },
    editorContextProvider: { dispose: () => teardowns.push('editor-context') },
    connect: () => {
      host.connectCount += 1
      return Promise.resolve()
    },
    coordinator: { getState: () => ({ kind: 'idle' }) },
    workspaceFolderIdForSession: () => undefined,
    temporaryWorkspaceManager: {},
    ensureCurrentWorkspace: () => Promise.resolve({ id: 'w1' }),
    modelUseCases: { resolveSessionConfiguration: () => Promise.resolve(detail('new').configuration) },
    sessionUseCases: {
      create: async () => {
        host.createStarted = true
        await host.createGate
        return detail('created')
      },
    },
    requireCurrentWorkspaceSession: (sessionId: string) =>
      Promise.resolve(host.sessionGate).then(() => {
        if (rejected.has(sessionId)) throw new Error('the session is not owned by this workspace')
        return detail(sessionId)
      }),
  } as never)
  const openSidebar = (): void => {
    let changed: (() => void) | undefined
    const view = {
      webview: {
        cspSource: 'vscode-resource:',
        asWebviewUri: (uri: unknown) => uri,
        postMessage: () => Promise.resolve(true),
        onDidReceiveMessage: (listener: (message: unknown) => void) => {
          listeners.push(listener)
          return { dispose: () => undefined }
        },
      },
      visible: true,
      onDidDispose: () => ({ dispose: () => undefined }),
      onDidChangeVisibility: (listener: () => void) => {
        changed = listener
        return { dispose: () => undefined }
      },
    }
    sidebarVisible = (visible) => {
      view.visible = visible
      changed?.()
    }
    gateway.provider.resolveWebviewView(view as never)
    for (const listener of [...listeners]) {
      listener({ protocolVersion: 1, message: { type: 'app.ready', requestId: 'ready-1' } })
    }
  }
  return {
    transcript,
    gateway,
    sent,
    events,
    surfaces,
    teardowns,
    watchShown,
    watchReleased,
    watchVisibility,
    openSidebar,
    setSidebarVisible: (visible) => sidebarVisible?.(visible),
    receive: (message: unknown) => {
      for (const listener of [...listeners]) listener(message)
    },
    rejectSession: (sessionId: string) => rejected.add(sessionId),
  }
}

const request = (type: string, requestId: string, payload?: unknown): unknown => ({
  protocolVersion: 1,
  message: { type, requestId, ...(payload === undefined ? {} : { payload }) },
})

describe('request gateway editor surface routes', () => {
  let harness: Harness

  beforeEach(() => {
    harness = buildGateway()
  })

  it('accepts response render receipts only from the ready surface displaying that session', async () => {
    harness.openSidebar()
    await harness.gateway.router.handle(request('app.ready', 'ready'), 'sidebar')
    const window = harness.transcript.forSurface('sidebar')
    window.installPage('s', { events: [], hasMore: false }, window.begin('s'))
    for (const [source, sessionId] of [
      ['editor-foreign', 's'],
      ['sidebar', 'foreign'],
    ] as const)
      await harness.gateway.router.handle(
        request('surface.responseRendered', `${source}-${sessionId}`, { sessionId, turn: 1 }),
        source,
      )
    expect(host.responseRendered).not.toHaveBeenCalled()
    await harness.gateway.router.handle(
      request('surface.responseRendered', 'rendered', { sessionId: 's', turn: 1 }),
      'sidebar',
    )
    expect(host.responseRendered).toHaveBeenCalledExactlyOnceWith('s', 1)
    expect(harness.sent.find((entry) => entry.requestId === 'rendered')?.payload).toEqual({ bell: true })
  })

  it('does not let a hidden surface consume the cue before a visible surface renders', async () => {
    harness.openSidebar()
    await harness.gateway.router.handle(request('app.ready', 'ready'), 'sidebar')
    const window = harness.transcript.forSurface('sidebar')
    window.installPage('s', { events: [], hasMore: false }, window.begin('s'))
    harness.setSidebarVisible(false)
    await harness.gateway.router.handle(
      request('surface.responseRendered', 'hidden', { sessionId: 's', turn: 1 }),
      'sidebar',
    )
    expect(host.responseRendered).not.toHaveBeenCalled()
    expect(harness.sent.find((entry) => entry.requestId === 'hidden')?.payload).toEqual({ bell: false })
    harness.setSidebarVisible(true)
    await harness.gateway.router.handle(
      request('surface.responseRendered', 'visible', { sessionId: 's', turn: 1 }),
      'sidebar',
    )
    expect(host.responseRendered).toHaveBeenCalledExactlyOnceWith('s', 1)
    expect(harness.sent.find((entry) => entry.requestId === 'visible')?.payload).toEqual({ bell: true })
  })

  it('serves complete live nodes only through the owning surface and scoped session', async () => {
    const window = harness.transcript.forSurface('sidebar')
    const snapshot = window.installPage(
      's',
      {
        events: [
          {
            sequence: 1,
            time: '2026-10-20T00:00:00Z',
            event: { type: 'message.delta', sessionId: 's', messageId: 'm', delta: 'Whole live body' },
          },
        ],
        hasMore: false,
      },
      window.begin('s'),
    )
    const payload = { sessionId: 's', nodeId: 'm', revision: snapshot.revision }
    await harness.gateway.router.handle(request('session.transcript.node', 'full-node', payload), 'sidebar')
    expect(harness.sent).toContainEqual(
      expect.objectContaining({
        requestId: 'full-node',
        ok: true,
      }),
    )
    expect(harness.sent.find((item) => item.requestId === 'full-node')?.payload).toMatchObject({
      node: { id: 'm', markdown: 'Whole live body' },
    })
    await harness.gateway.router.handle(
      request('session.transcript.node', 'other-surface', payload),
      'editor-1',
    )
    expect(harness.sent).toContainEqual(expect.objectContaining({ requestId: 'other-surface', ok: false }))
    harness.rejectSession('s')
    await harness.gateway.router.handle(
      request('session.transcript.node', 'foreign-node', payload),
      'sidebar',
    )
    expect(harness.sent).toContainEqual(expect.objectContaining({ requestId: 'foreign-node', ok: false }))
  })

  it('authorizes native resource drops and reuses the ordinary editor manager', async () => {
    const signal = new AbortController().signal
    await harness.gateway.openDroppedSession('session-1', 2, signal)
    await harness.gateway.openDroppedSession('session-1', 2, signal)
    expect(harness.gateway.editorSurfaces.count).toBe(1)
    expect(host.panels[0]?.title).toBe('Session title')
    harness.rejectSession('foreign')
    await expect(harness.gateway.openDroppedSession('foreign', 2, signal)).rejects.toThrow('not owned')
    host.isTrusted = false
    await expect(harness.gateway.openDroppedSession('session-2', 2, signal)).rejects.toThrow('Trust')
    expect(harness.gateway.editorSurfaces.count).toBe(1)
  })

  it('runs native renames through ownership checks and publishes the accepted full title to every list', async () => {
    const signal = new AbortController().signal
    host.renamedTitle = 'A long accepted title '.repeat(10)
    await harness.gateway.openDroppedSession('s1', 2, signal)
    await harness.gateway.sessionNavigation.rename('s1', 'Requested title', signal)
    expect(host.panels[0]?.title).toHaveLength(120)
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        name: 'session.title',
        payload: { sessionId: 's1', title: host.renamedTitle },
      }),
    )
    harness.rejectSession('foreign')
    await expect(harness.gateway.sessionNavigation.rename('foreign', 'Title', signal)).rejects.toThrow(
      'not owned',
    )
    host.isTrusted = false
    await expect(harness.gateway.sessionNavigation.rename('s1', 'Title', signal)).rejects.toThrow('Trust')
  })

  it('opens one editor tab per session and answers the surface that asked', async () => {
    await harness.gateway.router.handle(
      request('surface.openInEditor', 'r1', { sessionId: 'session-1', title: 'Session one' }),
      'sidebar',
    )
    await harness.gateway.router.handle(
      request('surface.openInEditor', 'r2', { sessionId: 'session-1' }),
      'sidebar',
    )

    expect(host.panels).toHaveLength(1)
    expect(host.panels[0]?.title).toBe('Session one')
    expect(harness.gateway.editorSurfaces.count).toBe(1)
    expect(harness.surfaces.editorCount).toBe(1)
    const responses = harness.sent.filter((entry) => entry.type === 'response')
    expect(responses.map((entry) => entry.surfaceId)).toEqual(['sidebar', 'sidebar'])
    expect(responses.map((entry) => entry.ok)).toEqual([true, true])
  })

  it('refuses a session this workspace does not own without opening a tab', async () => {
    harness.rejectSession('foreign-session')

    await harness.gateway.router.handle(
      request('surface.openInEditor', 'r1', { sessionId: 'foreign-session' }),
      'sidebar',
    )

    expect(host.panels).toHaveLength(0)
    expect(harness.sent[0]?.ok).toBe(false)
  })

  it('moves a single editor tab back but every tab from the sidebar', async () => {
    harness.openSidebar()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await harness.gateway.router.handle(
      request('surface.openInEditor', 'r1', { sessionId: 'session-1' }),
      'sidebar',
    )
    await harness.gateway.router.handle(
      request('surface.openInEditor', 'r2', { sessionId: 'session-2' }),
      'sidebar',
    )

    await harness.gateway.router.handle(request('surface.moveToSidebar', 'r3'), 'editor:session-1')
    expect(host.panels[0]?.disposeCount).toBe(1)
    expect(host.panels[1]?.disposeCount).toBe(0)
    expect(harness.gateway.editorSurfaces.count).toBe(1)
    expect(host.commands).toContain('dsh.chatView.focus')
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        surfaceId: 'sidebar',
        name: 'ui.surface.openInSidebar',
        payload: { sessionId: 'session-1' },
      }),
    )

    await harness.gateway.router.handle(request('surface.moveToSidebar', 'r4'), 'sidebar')
    expect(host.panels[1]?.disposeCount).toBe(1)
    expect(harness.gateway.editorSurfaces.count).toBe(0)
  })

  it('rebinds a created session using the Host sender identity and preserves both session lookups', async () => {
    await harness.gateway.router.handle(
      request('surface.openInEditor', 'open', { sessionId: 'session-1' }),
      'sidebar',
    )
    await harness.gateway.router.handle(
      request('surface.openInEditor', 'bind', { sessionId: 'session-2', replaceCurrent: true }),
      'editor:session-1',
    )
    expect(harness.gateway.editorSurfaces.forSession('session-2')?.surfaceId).toBe('editor:session-1')
    await harness.gateway.router.handle(
      request('surface.openInEditor', 'reopen', { sessionId: 'session-1' }),
      'sidebar',
    )
    expect(harness.gateway.editorSurfaces.count).toBe(2)
    expect(harness.gateway.editorSurfaces.forSession('session-1')?.surfaceId).not.toBe('editor:session-1')
    harness.gateway.editorSurfaces.closeAll()
    expect(harness.gateway.editorSurfaces.forSession('session-2')).toBeUndefined()
    expect(harness.gateway.editorSurfaces.forSession('session-1')).toBeUndefined()
  })
})
