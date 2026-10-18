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
  const retitleEditorTab = vi.fn<(sessionId: string, title: string) => void>()
  const depsWithRetitle = { ...deps, retitleEditorTab } satisfies Deps
  const navigation = createSessionNavigation(depsWithRetitle, { waitUntilReady: ready }, request, open)
  return { deps, request, open, ready, retitleEditorTab, navigation, signal: new AbortController().signal }
}

describe('shared Host session navigation', () => {
  it('reuses the scoped directory and projects only lightweight rows without paths, history or children', async () => {
    const { navigation, deps, signal } = fixture()
    expect(await navigation.read(signal)).toEqual({
      workspaces: [{ id: 'w1', name: 'Project' }],
      sessions: [{ id: 's1', workspaceId: 'w1', title: 'Chat', blank: false }],
    })
    expect(deps.listCurrentWorkspaces).toHaveBeenCalledOnce()
    expect(deps.sessionUseCases.list).toHaveBeenCalledWith({ archived: false }, signal)
    state.trusted = false
    await expect(navigation.read(signal)).rejects.toThrow('Trust')
    expect(deps.sessionUseCases.list).toHaveBeenCalledOnce()
  })

  it('synchronizes metadata and selection without turning streamed messages into directory reloads', () => {
    const { navigation } = fixture()
    const changed = vi.fn()
    const subscription = navigation.onDidChange(changed)
    navigation.acceptEvent('message.delta')
    navigation.acceptEvent('session.projection', { key: 'messages' })
    navigation.acceptEvent('connection.snapshot')
    expect(changed).not.toHaveBeenCalled()
    navigation.select('s1')
    navigation.select('s1')
    expect(changed).toHaveBeenCalledExactlyOnceWith('selection')
    navigation.acceptEvent('session.projection', { key: 'title' })
    expect(changed).toHaveBeenLastCalledWith('directory')
    changed.mockClear()
    navigation.acceptEvent('connection.snapshot', { kind: 'connected' })
    navigation.acceptEvent('connection.snapshot', { kind: 'connected' })
    expect(changed).toHaveBeenCalledExactlyOnceWith('connection')
    subscription.dispose()
    changed.mockClear()
    navigation.invalidate()
    expect(changed).not.toHaveBeenCalled()
  })

  it('blocks reads during attach and transport loss, then refreshes on recovery of the same backend', async () => {
    const { navigation, deps, signal } = fixture()
    const backend = deps.backendService.requireBackend()
    const changed = vi.fn()
    navigation.onDidChange(changed)
    vi.mocked(deps.backendService.requireBackend).mockImplementation(() => {
      throw new Error('not attached')
    })
    navigation.acceptEvent('connection.snapshot', { kind: 'connected' })
    expect(navigation.connected).toBe(false)
    await expect(navigation.read(signal)).rejects.toMatchObject({ code: 'BACKEND_UNREACHABLE' })
    expect(deps.sessionUseCases.list).not.toHaveBeenCalled()
    vi.mocked(deps.backendService.requireBackend).mockReturnValue(backend)
    navigation.acceptEvent('connection.snapshot', { kind: 'connected' })
    expect(navigation.connected).toBe(true)
    await navigation.read(signal)
    navigation.acceptEvent('connection.lost')
    expect(navigation.connected).toBe(false)
    await expect(navigation.read(signal)).rejects.toMatchObject({ code: 'BACKEND_UNREACHABLE' })
    changed.mockClear()
    navigation.acceptEvent('connection.snapshot', { kind: 'connected' })
    expect(changed).toHaveBeenCalledExactlyOnceWith('connection')
    expect(navigation.connected).toBe(true)
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

  it('retitles an open editor tab when a session title event arrives', () => {
    const { navigation, retitleEditorTab } = fixture()
    navigation.acceptEvent('session.title', { sessionId: 's1', title: 'Renamed by DSH' })
    expect(retitleEditorTab).toHaveBeenCalledExactlyOnceWith('s1', 'Renamed by DSH')
    retitleEditorTab.mockClear()
    // A malformed or title-less payload never reaches the tab-label route.
    navigation.acceptEvent('session.title', { sessionId: 's1' })
    navigation.acceptEvent('session.title', 'not an object')
    navigation.acceptEvent('session.title')
    expect(retitleEditorTab).not.toHaveBeenCalled()
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
    const { navigation, retitleEditorTab } = fixture()
    navigation.acceptEvent(name, payload)
    expect(retitleEditorTab).toHaveBeenCalledExactlyOnceWith('s1', 'Projected title')
  })

  it('ignores absent, malformed and unrelated title projections without hiding valid baseline entries', () => {
    const { navigation, retitleEditorTab } = fixture()
    navigation.acceptEvent('session.projection', { sessionId: 's1', key: 'messages', value: 'Text' })
    navigation.acceptEvent('session.projection', { sessionId: 's1', key: 'title', value: null })
    navigation.acceptEvent('session.projection', { key: 'title', value: 'Missing id' })
    navigation.acceptEvent('session.subscribed', { sessionId: 's1', projection: { values: {} } })
    navigation.acceptEvent('session.projection.baseline', { projections: null })
    navigation.acceptEvent('session.projection.baseline', {
      projections: {
        s1: { values: { title: null } },
        s2: { values: { title: 'Recovered title' } },
        s3: null,
        s4: { values: { title: 42 } },
      },
    })
    expect(retitleEditorTab).toHaveBeenCalledExactlyOnceWith('s2', 'Recovered title')
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
