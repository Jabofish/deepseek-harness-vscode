import { describe, expect, it, vi, type Mock, type Mocked } from 'vitest'
import type { DshBackend, SessionSummary } from '@dsh-vscode/domain'
import { createSessionNavigation, type SessionNavigation } from './session-navigation.js'

const state = vi.hoisted(() => ({ trusted: true, execute: vi.fn().mockResolvedValue(undefined) }))
vi.mock('vscode', () => ({
  workspace: {
    get isTrusted() {
      return state.trusted
    },
  },
  commands: { executeCommand: state.execute },
}))

interface Fixture {
  readonly navigation: SessionNavigation
  readonly deps: Mocked<Parameters<typeof createSessionNavigation>[0]>
  readonly request: Mock<Parameters<typeof createSessionNavigation>[2]>
  readonly open: Mock<Parameters<typeof createSessionNavigation>[3]>
  readonly ready: Mock<() => Promise<boolean>>
  readonly retitleEditorTab: Mock<(sessionId: string, title: string) => void>
  readonly editorTitles: Map<string, string>
  readonly signal: AbortSignal
}

function fixture(): Fixture {
  state.trusted = true
  state.execute.mockClear()
  const summary = (id: string, workspaceId: string): SessionSummary => ({
    id,
    workspaceId,
    title: 'Chat',
    blank: false,
    status: 'idle',
    createdAt: '2026-10-18',
    updatedAt: '2026-10-18',
    cwd: '/private/project',
  })
  type Deps = Parameters<typeof createSessionNavigation>[0]
  const deps = {
    backendService: {
      requireBackend: vi.fn<Deps['backendService']['requireBackend']>().mockReturnValue({} as DshBackend),
    },
    sessionUseCases: {
      list: vi.fn<Deps['sessionUseCases']['list']>().mockResolvedValue({
        items: [
          summary('s1', 'w1'),
          summary('archived', 'w1'),
          summary('foreign', 'w2'),
          { ...summary('child', 'w1'), origin: 'subagent' },
        ],
      }),
    },
    currentWorkspaceFolders: vi.fn<Deps['currentWorkspaceFolders']>().mockReturnValue([]),
    listCurrentWorkspaces: vi.fn<Deps['listCurrentWorkspaces']>().mockResolvedValue([
      {
        id: 'w1',
        name: 'Project',
        path: '/private/project',
        sessionCount: 2,
        createdAt: '',
        updatedAt: '',
      },
    ]),
    listCurrentArchivedSessionIds: vi
      .fn<Deps['listCurrentArchivedSessionIds']>()
      .mockResolvedValue(['archived']),
    requireCurrentWorkspaceSession: vi.fn<Deps['requireCurrentWorkspaceSession']>(),
    postEventTo: vi.fn<Deps['postEventTo']>().mockResolvedValue(true),
    postEvent: vi.fn<Deps['postEvent']>().mockResolvedValue(true),
  } satisfies Deps
  const request = vi.fn<Parameters<typeof createSessionNavigation>[2]>().mockResolvedValue(undefined)
  const open = vi.fn<Parameters<typeof createSessionNavigation>[3]>().mockResolvedValue(undefined)
  const ready = vi.fn().mockResolvedValue(true)
  const editorTitles = new Map<string, string>()
  const retitleEditorTab = vi.fn((sessionId: string, title: string): void => {
    editorTitles.set(sessionId, title)
  })
  const depsWithRetitle = { ...deps, retitleEditorTab } satisfies Deps
  const navigation = createSessionNavigation(depsWithRetitle, { waitUntilReady: ready }, request, open)
  return {
    deps,
    request,
    open,
    ready,
    retitleEditorTab,
    editorTitles,
    navigation,
    signal: new AbortController().signal,
  }
}

describe('shared Host session navigation', () => {
  it('reuses the scoped directory and projects only lightweight rows without paths, history or children', async () => {
    const { navigation, deps, signal } = fixture()
    expect(await navigation.read(signal)).toEqual({
      workspaces: [{ id: 'w1', name: 'Project' }],
      sessions: [{ id: 's1', workspaceId: 'w1', title: 'Chat', blank: false }],
    })
    expect(deps.sessionUseCases.list).toHaveBeenCalledWith({ archived: false }, signal)
    state.trusted = false
    await expect(navigation.read(signal)).rejects.toThrow('Trust')
  })

  it('opens the sidebar only after ownership, focus and readiness, and keeps editor opening on its existing route', async () => {
    const { navigation, deps, open, ready, signal } = fixture()
    await navigation.open('s1', false, signal)
    expect(deps.requireCurrentWorkspaceSession).toHaveBeenCalledWith('s1', signal)
    expect(deps.postEventTo).toHaveBeenCalledWith('sidebar', 'ui.surface.openInSidebar', { sessionId: 's1' })
    await navigation.open('s1', true, signal)
    expect(open).toHaveBeenCalledWith('s1', undefined, signal)
    ready.mockResolvedValue(false)
    await expect(navigation.open('s1', false, signal)).rejects.toThrow('not ready')
    expect(deps.postEventTo).toHaveBeenCalledOnce()
    deps.requireCurrentWorkspaceSession.mockRejectedValue(new Error('foreign session'))
    await expect(navigation.open('foreign', false, signal)).rejects.toThrow('foreign')
    expect(deps.postEventTo).toHaveBeenCalledOnce()
  })

  it.each([
    ['session.projection', { sessionId: 's1', key: 'title', value: 'Projected title' }],
    [
      'session.projection.baseline',
      { projections: { s1: { asOfSequence: 12, values: { title: 'Projected title' } } } },
    ],
    [
      'session.subscribed',
      { sessionId: 's1', projection: { asOfSequence: 12, values: { title: 'Projected title' } } },
    ],
  ])('retitles from the authoritative title in %s', (name, payload) => {
    const { navigation, editorTitles } = fixture()
    navigation.acceptEvent(name, payload)
    expect(editorTitles.get('s1')).toBe('Projected title')
  })

  it('applies latest-wins by sequence so a replayed fallback title cannot flip the tab', () => {
    const { navigation, editorTitles } = fixture()
    navigation.acceptEvent('session.title', { sessionId: 's1', title: 'Fallback title', sequence: 5 })
    expect(editorTitles.get('s1')).toBe('Fallback title')
    navigation.acceptEvent('session.title', { sessionId: 's1', title: 'Provider title', sequence: 6 })
    expect(editorTitles.get('s1')).toBe('Provider title')
    navigation.acceptEvent('session.title', { sessionId: 's1', title: 'Fallback title', sequence: 5 })
    expect(editorTitles.get('s1')).toBe('Provider title')
    navigation.acceptEvent('session.title', { sessionId: 's1', title: 'Provider title', sequence: 6 })
    expect(editorTitles.get('s1')).toBe('Provider title')
  })

  it('uses validated existing mutation routes and refreshes archives without clearing editor context', async () => {
    const { navigation, request, deps, signal } = fixture()
    await navigation.rename('s1', 'Renamed', signal)
    await navigation.archive('s1', signal)
    expect(
      request.mock.calls.map(([request]) => [
        request.type,
        'payload' in request ? request.payload : undefined,
      ]),
    ).toEqual([
      ['session.rename', { sessionId: 's1', title: 'Renamed' }],
      ['session.archive', { sessionId: 's1', archived: true }],
    ])
    expect(deps.postEvent).toHaveBeenCalledExactlyOnceWith('archived.sessions.changed', {
      sessionIds: ['archived'],
    })
    request.mockRejectedValueOnce(new Error('denied'))
    await expect(navigation.archive('s1', signal)).rejects.toThrow('denied')
    expect(deps.postEvent).toHaveBeenCalledOnce()
    deps.listCurrentArchivedSessionIds.mockRejectedValueOnce(new Error('lost'))
    await expect(navigation.archive('s1', signal)).rejects.toThrow('was archived')
  })
})
