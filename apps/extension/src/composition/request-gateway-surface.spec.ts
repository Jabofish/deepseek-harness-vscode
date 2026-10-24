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

  it('rereads recovery state without starting a connection', async () => {
    await harness.gateway.router.handle(
      request('app.ready', 'recover-state', { snapshotOnly: true }),
      'sidebar',
    )
    expect(host.connectCount).toBe(0)
    expect(harness.events.find((event) => event.name === 'connection.snapshot')?.payload).toMatchObject({
      kind: 'idle',
    })
    expect(harness.sent).toContainEqual(expect.objectContaining({ requestId: 'recover-state', ok: true }))
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

  it('updates title-bar layout only from the sidebar, independently of connection and trust', async () => {
    host.isTrusted = false
    await harness.gateway.router.handle(
      request('surface.titlebarLayout', 'layout-editor', { layout: 'compact' }),
      'editor-1',
    )
    expect(host.contexts).toEqual([])
    for (const layout of ['wide', 'regular', 'compact', 'wide'])
      await harness.gateway.router.handle(
        request('surface.titlebarLayout', `layout-${host.contexts.length}`, { layout }),
        'sidebar',
      )
    expect(host.contexts).toEqual(
      ['wide', 'regular', 'compact', 'wide'].map((value) => ({ key: 'dsh.chatTitlebarLayout', value })),
    )
    const responseCount = harness.sent.length
    await harness.gateway.router.handle(
      request('surface.titlebarLayout', 'invalid-layout', { layout: 'invented' }),
      'sidebar',
    )
    expect(host.contexts).toHaveLength(4)
    expect(harness.sent).toHaveLength(responseCount)
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

  it('tracks actual editor visibility and readiness independently of tab lifetime', async () => {
    const signal = new AbortController().signal
    await harness.gateway.openDroppedSession('session-1', 2, signal)
    expect(harness.watchShown).toEqual([{ surfaceId: 'editor:session-1', sessionId: 'session-1' }])
    expect(harness.watchReleased).toEqual([])

    const panel = host.panels[0]!
    panel.receive(request('app.ready', 'editor-ready'))
    await vi.waitFor(() =>
      expect(harness.watchVisibility).toContainEqual({ surfaceId: 'editor:session-1', visible: true }),
    )
    panel.setVisible(false)
    expect(harness.watchVisibility.at(-1)).toEqual({ surfaceId: 'editor:session-1', visible: false })
    panel.setVisible(true)
    expect(harness.watchVisibility.at(-1)).toEqual({ surfaceId: 'editor:session-1', visible: true })
    expect(harness.watchReleased).toEqual([])

    harness.gateway.editorSurfaces.close('editor:session-1')
    expect(harness.watchReleased).toEqual(['editor:session-1'])
    expect(harness.watchShown).toEqual([{ surfaceId: 'editor:session-1', sessionId: 'session-1' }])
  })

  it('does not open a native drop cancelled during ownership validation', async () => {
    const abort = new AbortController()
    let finish = (): void => undefined
    host.sessionGate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const pending = harness.gateway.openDroppedSession('session-1', 2, abort.signal)
    abort.abort()
    finish()
    await pending
    expect(harness.gateway.editorSurfaces.count).toBe(0)
  })

  it('does not replace a newer selection when an older create request finishes late', async () => {
    harness.openSidebar()
    let finish!: () => void
    host.createGate = new Promise<void>((done) => {
      finish = done
    })
    const pending = harness.gateway.router.handle(
      request('session.create', 'slow-create', { configuration: detail('new').configuration }),
      'sidebar',
    )
    await vi.waitFor(() => expect(host.createStarted).toBe(true))
    await harness.gateway.router.handle(
      request('session.open', 'fast-open', { sessionId: 'current' }),
      'sidebar',
    )
    expect(harness.sent.find((entry) => entry.requestId === 'fast-open')?.error).toBeUndefined()
    expect(harness.watchShown).toEqual([{ surfaceId: 'sidebar', sessionId: 'current' }])
    finish()
    await pending
    expect(harness.sent).toContainEqual(expect.objectContaining({ requestId: 'slow-create', ok: true }))
    expect(harness.watchShown).toEqual([{ surfaceId: 'sidebar', sessionId: 'current' }])
    expect(harness.gateway.sessionNavigation.activeSessionId).toBe('current')
    harness.setSidebarVisible(false)
    expect(harness.watchVisibility.at(-1)).toEqual({ surfaceId: 'sidebar', visible: false })
    harness.setSidebarVisible(true)
    expect(harness.watchVisibility.at(-1)).toEqual({ surfaceId: 'sidebar', visible: true })
  })

  it('opens a native-list selection in the sidebar without closing editor chats', async () => {
    harness.openSidebar()
    const signal = new AbortController().signal
    await harness.gateway.openDroppedSession('editor-session', 2, signal)
    await harness.gateway.sessionNavigation.open('sidebar-session', false, signal)
    expect(harness.gateway.editorSurfaces.count).toBe(1)
    expect(host.panels[0]?.disposeCount).toBe(0)
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        surfaceId: 'sidebar',
        name: 'ui.surface.openInSidebar',
        payload: { sessionId: 'sidebar-session' },
      }),
    )
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

  it('retitles only an already-open editor from upstream title views using the shared label sanitizer', async () => {
    await harness.gateway.openDroppedSession('s1', 2, new AbortController().signal)
    harness.gateway.sessionNavigation.acceptEvent('session.projection', {
      sessionId: 's1',
      key: 'title',
      value: `  Updated\n\u0007${'title '.repeat(30)}  `,
    })
    expect(host.panels[0]?.title).toBe(`Updated ${'title '.repeat(30)}`.trim().slice(0, 120))
    harness.gateway.sessionNavigation.acceptEvent('session.title', { sessionId: 's1', title: ' \n ' })
    harness.gateway.sessionNavigation.acceptEvent('session.title', { sessionId: 'unopened', title: 'Other' })
    expect(host.panels).toHaveLength(1)
    expect(host.panels[0]?.title).toHaveLength(120)
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

  it('sanitizes the editor tab title instead of trusting the Webview label', async () => {
    await harness.gateway.router.handle(
      request('surface.openInEditor', 'r1', { sessionId: 'session-1', title: '  Bad\u0000\n\tTitle  ' }),
      'sidebar',
    )

    expect(host.panels[0]?.title).toBe('Bad Title')
  })

  it('cannot open a late editor after the originating surface is closed during ownership validation', async () => {
    let release!: () => void
    host.sessionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const opening = harness.gateway.router.handle(
      request('surface.openInEditor', 'late', { sessionId: 'session-1' }),
      'sidebar',
    )
    harness.gateway.router.cancelSurface('sidebar')
    release()
    await opening
    expect(host.panels).toHaveLength(0)
    expect(harness.gateway.editorSurfaces.count).toBe(0)
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

  it('retitles an open editor tab when its session is renamed', async () => {
    await harness.gateway.router.handle(
      request('surface.openInEditor', 'r1', { sessionId: 'session-1', title: 'Original title' }),
      'sidebar',
    )
    expect(host.panels[0]?.title).toBe('Original title')

    host.renamedTitle = 'A much better title'
    await harness.gateway.router.handle(
      request('session.rename', 'r2', { sessionId: 'session-1', title: 'ignored by the host' }),
      'sidebar',
    )

    // The Host applies the title it accepted, so the tab never shows a name the
    // session log does not hold.
    expect(host.panels[0]?.title).toBe('A much better title')
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

  it.each(['focus', 'delivery'] as const)('preserves editor chats when sidebar %s fails', async (failure) => {
    harness.openSidebar()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await harness.gateway.router.handle(
      request('surface.openInEditor', 'open', { sessionId: 'session-1' }),
      'sidebar',
    )
    host.focusFails = failure === 'focus'
    host.deliveryFails = failure === 'delivery'
    await harness.gateway.router.handle(request('surface.moveToSidebar', 'move'), 'sidebar')
    expect(host.panels[0]?.disposeCount).toBe(0)
    expect(harness.sent.find((entry) => entry.requestId === 'move')?.ok).toBe(false)
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

  it('announces the sidebar surface identity once its Webview is ready', async () => {
    harness.openSidebar()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The identity and the current editor-tab count travel together, so a
    // surface that becomes ready after a handoff broadcast still learns it.
    expect(harness.events).toEqual([
      { surfaceId: 'sidebar', type: 'event', name: 'connection.snapshot', payload: { kind: 'idle' } },
      { surfaceId: 'sidebar', type: 'event', name: 'ui.surface.assigned', payload: { kind: 'sidebar' } },
      {
        surfaceId: 'sidebar',
        type: 'event',
        name: 'ui.surface.handoff',
        payload: { editorChats: 0 },
      },
    ])
  })

  it('keeps the sidebar routable across a re-resolved view and out of a sibling tab close', async () => {
    harness.openSidebar()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Closing an editor tab while the sidebar is ready must not tear down
    // another surface's job follows or editor context.
    await harness.gateway.router.handle(
      request('surface.openInEditor', 'r1', { sessionId: 'session-1' }),
      'sidebar',
    )
    harness.gateway.editorSurfaces.closeAll()
    expect(harness.teardowns).toEqual([])

    // Hiding and re-showing the view disposes the Webview, not the surface: the
    // registration and the ready handshake must both come back.
    const surface = harness.gateway.provider
    harness.openSidebar()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.surfaces.get('sidebar')).toBe(surface)
    // Phase 1 keeps the pre-existing behaviour that re-resolving the view runs
    // the shared teardown; making that idle-aware is a Phase 4 follow-up.
    expect(harness.teardowns).toEqual(['job-follows', 'editor-context'])

    harness.sent.length = 0
    await harness.gateway.router.handle(request('diagnostics.show', 'r2'), 'sidebar')
    expect(harness.sent.filter((entry) => entry.type === 'response').map((entry) => entry.surfaceId)).toEqual(
      ['sidebar'],
    )

    // Disposing the provider is the end of the surface: it leaves routing and
    // the shared teardown runs because no ready surface is left.
    surface.dispose()
    expect(harness.surfaces.get('sidebar')).toBeUndefined()
    expect(harness.teardowns.slice(-2)).toEqual(['job-follows', 'editor-context'])
  })

  it('registers the sidebar surface and reports the handoff count when tabs change', async () => {
    expect(harness.surfaces.get('sidebar')).toBe(harness.gateway.provider)

    await harness.gateway.router.handle(
      request('surface.openInEditor', 'r1', { sessionId: 'session-1' }),
      'sidebar',
    )
    harness.gateway.editorSurfaces.closeAll()

    const handoff = harness.events.filter((entry) => entry.name === 'ui.surface.handoff')
    expect(handoff.map((entry) => entry.payload)).toEqual([{ editorChats: 1 }, { editorChats: 0 }])
  })
})
