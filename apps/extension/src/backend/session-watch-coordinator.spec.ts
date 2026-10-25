import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendEvent, DshBackend, JobView, SessionStatus, SessionSummary } from '@dsh-vscode/domain'

import { createSessionWatchController, SESSION_UNWATCH_DELAY_MS } from './session-watch-coordinator.js'

interface FakeBackend {
  readonly backend: DshBackend
  readonly watchCalls: string[]
  readonly unwatchCalls: { readonly sessionId: string; readonly keepJobRows?: boolean }[]
  readonly directory: { readonly id: string; readonly status: SessionStatus }[]
  readonly jobs: Map<string, readonly JobView[]>
  readonly emit: (event: BackendEvent) => void
  readonly listenerCount: () => number
}

function sessionSummary(sessionId: string, status: SessionStatus): SessionSummary {
  return {
    id: sessionId,
    workspaceId: 'w1',
    title: sessionId,
    blank: false,
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function fakeBackend(): FakeBackend {
  const watchCalls: string[] = []
  const unwatchCalls: { readonly sessionId: string; readonly keepJobRows?: boolean }[] = []
  const listeners = new Set<(event: BackendEvent) => void>()
  const directory: { readonly id: string; readonly status: SessionStatus }[] = []
  const jobs = new Map<string, readonly JobView[]>()
  const backend = {
    events: {
      subscribe: (listener: (event: BackendEvent) => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      watchSession: (sessionId: string) => {
        watchCalls.push(sessionId)
      },
      unwatchSession: (sessionId: string, options?: { readonly keepJobRows?: boolean }) => {
        unwatchCalls.push({ sessionId, ...(options?.keepJobRows === true ? { keepJobRows: true } : {}) })
      },
    },
    sessions: {
      list: () => Promise.resolve({ items: directory.map((item) => sessionSummary(item.id, item.status)) }),
    },
    jobs: { list: (sessionId: string) => Promise.resolve(jobs.get(sessionId) ?? []) },
  } as unknown as DshBackend
  return {
    backend,
    watchCalls,
    unwatchCalls,
    directory,
    jobs,
    emit: (event) => {
      for (const listener of [...listeners]) listener(event)
    },
    listenerCount: () => listeners.size,
  }
}

function permissionRequested(sessionId: string, requestId: string): BackendEvent {
  return {
    type: 'permission.requested',
    request: {
      id: requestId,
      sessionId,
      title: 'Run tool',
      description: 'Run tool',
      risk: 'low',
      options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }],
    },
  }
}

function questionRequested(sessionId: string, questionId: string, rpcId?: string): BackendEvent {
  return {
    type: 'question.requested',
    question: {
      id: questionId,
      ...(rpcId === undefined ? {} : { rpcId }),
      sessionId,
      prompt: 'Choose',
      allowFreeText: false,
    },
  }
}

function jobsUpdated(
  sessionId: string,
  status: 'running' | 'completed',
): Extract<BackendEvent, { type: 'jobs.updated' }> {
  return {
    type: 'jobs.updated',
    sessionId,
    jobs: [{ id: 'job-1', kind: 'shell', label: 'Build', status, startedAt: 0 }],
  }
}

describe('session watch coordinator', () => {
  it('disables transient preview only when every displayed consumer is hidden or blocked, retaining durable/control follow', () => {
    const fake = fakeBackend()
    const preview = vi.fn()
    fake.backend.events.setSessionPreview = preview
    const controller = createSessionWatchController({ readDirectory: () => Promise.resolve([]) })
    try {
      controller.attach(fake.backend)
      controller.surfaceDisplaysSession('sidebar', 's1')
      controller.surfaceDisplaysSession('editor:s1', 's1')
      fake.emit({ type: 'session.status', sessionId: 's1', status: 'running' })
      controller.surfaceCapacityChanged('sidebar', false)
      expect(preview).toHaveBeenLastCalledWith('s1', true)
      controller.surfaceVisibilityChanged('editor:s1', false)
      expect(preview).toHaveBeenLastCalledWith('s1', false)
      expect(fake.unwatchCalls).toEqual([])
      controller.surfaceCapacityChanged('sidebar', true)
      expect(preview).toHaveBeenLastCalledWith('s1', true)
      controller.surfaceVisibilityChanged('sidebar', false)
      expect(preview).toHaveBeenLastCalledWith('s1', false)
      expect(fake.watchCalls).toEqual(['s1'])
    } finally {
      controller.dispose()
    }
  })
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('follows a displayed session and releases it after the idle delay', () => {
    const fake = fakeBackend()
    const controller = createSessionWatchController({ readDirectory: () => Promise.resolve([]) })
    controller.attach(fake.backend)

    controller.surfaceDisplaysSession('sidebar', 's1')
    expect(fake.watchCalls).toEqual(['s1'])

    controller.surfaceReleased('sidebar')
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS - 1)
    expect(fake.unwatchCalls).toEqual([])
    vi.advanceTimersByTime(1)
    expect(fake.unwatchCalls).toEqual([{ sessionId: 's1' }])

    controller.dispose()
  })

  it('keeps a shared subscription across panels and releases only after the last one closes', () => {
    const fake = fakeBackend()
    const controller = createSessionWatchController({ readDirectory: () => Promise.resolve([]) })
    controller.attach(fake.backend)

    controller.surfaceDisplaysSession('sidebar', 's1')
    controller.surfaceDisplaysSession('editor:s1', 's1')
    // One subscription serves both panels.
    expect(fake.watchCalls).toEqual(['s1'])

    controller.surfaceReleased('sidebar')
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS * 2)
    expect(fake.unwatchCalls).toEqual([])

    controller.surfaceReleased('editor:s1')
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS)
    expect(fake.unwatchCalls).toEqual([{ sessionId: 's1' }])

    controller.dispose()
  })

  it('rapid switching back inside the delay never unfollows the session', () => {
    const fake = fakeBackend()
    const controller = createSessionWatchController({ readDirectory: () => Promise.resolve([]) })
    controller.attach(fake.backend)

    controller.surfaceDisplaysSession('sidebar', 'a')
    controller.surfaceDisplaysSession('sidebar', 'b')
    expect(fake.watchCalls).toEqual(['a', 'b'])
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS / 2)
    controller.surfaceDisplaysSession('sidebar', 'a')
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS * 2)
    // `b` was left behind and is released; `a` is displayed again and stays.
    expect(fake.unwatchCalls).toEqual([{ sessionId: 'b' }])

    controller.dispose()
  })

  it('releases hidden tabs, retains shared visible panels, and restores a hidden binding when shown again', () => {
    const fake = fakeBackend()
    const controller = createSessionWatchController({ readDirectory: () => Promise.resolve([]) })
    controller.attach(fake.backend)
    controller.surfaceDisplaysSession('sidebar', 's')
    controller.surfaceDisplaysSession('editor', 's')
    controller.surfaceVisibilityChanged('editor', false)
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS)
    expect(fake.unwatchCalls).toEqual([])
    controller.surfaceVisibilityChanged('sidebar', false)
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS)
    expect(fake.unwatchCalls).toEqual([{ sessionId: 's' }])
    controller.surfaceVisibilityChanged('editor', true)
    expect(fake.watchCalls).toEqual(['s', 's'])
    controller.surfaceReleased('editor')
    controller.detach()
    const second = fakeBackend()
    controller.attach(second.backend)
    // The remaining sidebar is still hidden across the reconnect.
    expect(second.watchCalls).toEqual([])
    controller.surfaceVisibilityChanged('sidebar', true)
    expect(second.watchCalls).toEqual(['s'])
    controller.dispose()
  })

  it('a pending permission keeps the session followed until it is resolved', () => {
    const fake = fakeBackend()
    const controller = createSessionWatchController({ readDirectory: () => Promise.resolve([]) })
    controller.attach(fake.backend)

    controller.surfaceDisplaysSession('sidebar', 's1')
    controller.surfaceReleased('sidebar')
    fake.emit(permissionRequested('s1', 'req-1'))
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS * 3)
    expect(fake.unwatchCalls).toEqual([])

    fake.emit({ type: 'permission.resolved', sessionId: 's1', requestId: 'req-1' })
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS)
    expect(fake.unwatchCalls).toEqual([{ sessionId: 's1' }])

    controller.dispose()
  })

  it('a pending question holds the session and resolves by rpc id', () => {
    const fake = fakeBackend()
    const controller = createSessionWatchController({ readDirectory: () => Promise.resolve([]) })
    controller.attach(fake.backend)

    controller.surfaceDisplaysSession('sidebar', 's1')
    controller.surfaceReleased('sidebar')
    fake.emit(questionRequested('s1', 'q-1', 'rpc-9'))
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS * 2)
    expect(fake.unwatchCalls).toEqual([])

    fake.emit({ type: 'question.resolved', sessionId: 's1', questionRpcId: 'rpc-9' })
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS)
    expect(fake.unwatchCalls).toEqual([{ sessionId: 's1' }])

    controller.dispose()
  })

  it('a running turn holds the session; idle releases it after the delay', () => {
    const fake = fakeBackend()
    const controller = createSessionWatchController({ readDirectory: () => Promise.resolve([]) })
    controller.attach(fake.backend)

    fake.emit({ type: 'session.status', sessionId: 's1', status: 'running' })
    expect(fake.watchCalls).toEqual(['s1'])
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS * 2)
    expect(fake.unwatchCalls).toEqual([])

    fake.emit({ type: 'session.status', sessionId: 's1', status: 'idle' })
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS - 1)
    expect(fake.unwatchCalls).toEqual([])
    vi.advanceTimersByTime(1)
    expect(fake.unwatchCalls).toEqual([{ sessionId: 's1' }])

    controller.dispose()
  })

  it('running background jobs keep only the Job row stream alive', () => {
    const fake = fakeBackend()
    const controller = createSessionWatchController({ readDirectory: () => Promise.resolve([]) })
    controller.attach(fake.backend)

    controller.surfaceDisplaysSession('sidebar', 's1')
    fake.emit(jobsUpdated('s1', 'running'))
    controller.surfaceReleased('sidebar')
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS)
    expect(fake.unwatchCalls).toEqual([{ sessionId: 's1', keepJobRows: true }])

    // Reopening rebuilds the conversation stream; one watch serves it again.
    controller.surfaceDisplaysSession('editor:s1', 's1')
    expect(fake.watchCalls).toEqual(['s1', 's1'])
    controller.surfaceReleased('editor:s1')
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS)
    expect(fake.unwatchCalls).toEqual([
      { sessionId: 's1', keepJobRows: true },
      { sessionId: 's1', keepJobRows: true },
    ])

    // The last job settles: the remaining Job row stream closes immediately.
    fake.emit(jobsUpdated('s1', 'completed'))
    expect(fake.unwatchCalls).toEqual([
      { sessionId: 's1', keepJobRows: true },
      { sessionId: 's1', keepJobRows: true },
      { sessionId: 's1' },
    ])

    controller.dispose()
  })

  it('does not replay completed child histories merely because their parent is displayed', () => {
    const fake = fakeBackend()
    const controller = createSessionWatchController({ readDirectory: () => Promise.resolve([]) })
    controller.attach(fake.backend)

    controller.surfaceDisplaysSession('sidebar', 'parent')
    fake.emit({
      type: 'subagent.catalog.updated',
      sessionId: 'parent',
      entry: { id: 'child', createdAt: 0, mode: 'one-shot' },
    })
    expect(fake.watchCalls).toEqual(['parent'])
    fake.emit({ type: 'session.status', sessionId: 'child', status: 'running' })
    expect(fake.watchCalls).toEqual(['parent', 'child'])

    controller.surfaceReleased('sidebar')
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS)
    expect(fake.unwatchCalls).toContainEqual({ sessionId: 'parent' })
    expect(fake.unwatchCalls).not.toContainEqual({ sessionId: 'child' })
    fake.emit({ type: 'session.status', sessionId: 'child', status: 'idle' })
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS)
    expect(fake.unwatchCalls).toContainEqual({ sessionId: 'child' })

    controller.dispose()
  })

  it('reattaching re-applies the watch set and re-seeds running sessions', async () => {
    const first = fakeBackend()
    const second = fakeBackend()
    second.directory.push({ id: 's9', status: 'running' })
    const controller = createSessionWatchController()
    controller.attach(first.backend)
    controller.surfaceDisplaysSession('sidebar', 's1')
    expect(first.watchCalls).toEqual(['s1'])

    // A pending delayed release must not fire against the detached backend.
    controller.surfaceReleased('sidebar')
    controller.detach()
    expect(first.listenerCount()).toBe(0)
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS * 2)
    expect(first.unwatchCalls).toEqual([])

    // The panel shows the session again while no backend is attached; the
    // display fact survives and must not crash or start streams.
    controller.surfaceDisplaysSession('sidebar', 's1')
    controller.attach(second.backend)
    await vi.advanceTimersByTimeAsync(0)
    // The displayed session resumes on the new backend, and the directory seed
    // follows the already-running session.
    expect(second.watchCalls).toEqual(['s1', 's9'])

    controller.dispose()
  })

  it('attach is idempotent for the same backend', () => {
    const fake = fakeBackend()
    const controller = createSessionWatchController({ readDirectory: () => Promise.resolve([]) })
    controller.attach(fake.backend)
    controller.attach(fake.backend)
    expect(fake.listenerCount()).toBe(1)

    controller.dispose()
  })

  it('dispose cancels pending releases and unsubscribes', () => {
    const fake = fakeBackend()
    const controller = createSessionWatchController({ readDirectory: () => Promise.resolve([]) })
    controller.attach(fake.backend)
    controller.surfaceDisplaysSession('sidebar', 's1')
    controller.surfaceReleased('sidebar')
    controller.dispose()
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS * 2)
    expect(fake.unwatchCalls).toEqual([])
    expect(fake.listenerCount()).toBe(0)

    controller.dispose()
  })

  it('an established stream observed via session.subscribed is reclaimed when unwanted', () => {
    const fake = fakeBackend()
    const controller = createSessionWatchController({ readDirectory: () => Promise.resolve([]) })
    controller.attach(fake.backend)

    // A repository read started a follow stream opportunistically.
    fake.emit({ type: 'session.subscribed', sessionId: 's7', lastSequence: 3 })
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS)
    expect(fake.unwatchCalls).toEqual([{ sessionId: 's7' }])

    controller.dispose()
  })

  it('keeps permission and question holds separate when ids overlap or a question resolution has no id', () => {
    const fake = fakeBackend()
    const controller = createSessionWatchController({ readDirectory: () => Promise.resolve([]) })
    controller.attach(fake.backend)
    fake.emit(permissionRequested('s', 'shared'))
    fake.emit(questionRequested('s', 'shared'))
    fake.emit({ type: 'question.resolved', sessionId: 's' })
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS)
    expect(fake.unwatchCalls).toEqual([])
    fake.emit({ type: 'permission.resolved', sessionId: 's', requestId: 'shared' })
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS)
    expect(fake.unwatchCalls).toEqual([{ sessionId: 's' }])
    fake.emit(permissionRequested('s', 'shared'))
    fake.emit(questionRequested('s', 'shared'))
    fake.emit({ type: 'permission.resolved', sessionId: 's', requestId: 'shared' })
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS)
    expect(fake.unwatchCalls).toHaveLength(1)
    fake.emit({ type: 'question.resolved', sessionId: 's', questionId: 'shared' })
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS)
    expect(fake.unwatchCalls).toHaveLength(2)
    controller.dispose()
  })

  it('does not let a late directory seed override newer running or idle events', async () => {
    const fake = fakeBackend()
    let resolve!: (rows: readonly { id: string; status: string }[]) => void
    const controller = createSessionWatchController({
      readDirectory: () =>
        new Promise((done) => {
          resolve = done
        }),
    })
    controller.attach(fake.backend)
    fake.emit({ type: 'session.status', sessionId: 'active', status: 'running' })
    fake.emit({ type: 'session.status', sessionId: 'finished', status: 'idle' })
    resolve([
      { id: 'active', status: 'idle' },
      { id: 'finished', status: 'running' },
    ])
    await vi.advanceTimersByTimeAsync(SESSION_UNWATCH_DELAY_MS * 2)
    expect(fake.watchCalls).toEqual(['active'])
    expect(fake.unwatchCalls).toEqual([])
    controller.dispose()
  })

  it('finds already-running background jobs in idle sessions without keeping their history streams', async () => {
    const fake = fakeBackend()
    fake.directory.push({ id: 's', status: 'idle' })
    fake.jobs.set('s', jobsUpdated('s', 'running').jobs)
    const controller = createSessionWatchController()
    controller.attach(fake.backend)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.watchCalls).toEqual(['s'])
    await vi.advanceTimersByTimeAsync(SESSION_UNWATCH_DELAY_MS)
    expect(fake.unwatchCalls).toEqual([{ sessionId: 's', keepJobRows: true }])
    fake.emit(jobsUpdated('s', 'completed'))
    expect(fake.unwatchCalls).toEqual([{ sessionId: 's', keepJobRows: true }, { sessionId: 's' }])
    controller.dispose()
  })

  it('reconciles running sessions after an in-place transport reconnect and ignores deleted seed rows', async () => {
    const fake = fakeBackend()
    const controller = createSessionWatchController()
    controller.attach(fake.backend)
    await vi.advanceTimersByTimeAsync(0)
    fake.directory.push({ id: 'background', status: 'running' })
    fake.emit({ type: 'connection.restored' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.watchCalls).toEqual(['background'])
    fake.emit({ type: 'session.removed', sessionId: 'background' })
    fake.emit({ type: 'connection.restored' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.watchCalls).toEqual(['background'])
    controller.dispose()
  })

  it('replaces disconnected interaction holds with replayed requests instead of retaining stale ids', () => {
    const fake = fakeBackend()
    const controller = createSessionWatchController({ readDirectory: () => Promise.resolve([]) })
    controller.attach(fake.backend)
    fake.emit(permissionRequested('s', 'old'))
    fake.emit({ type: 'connection.lost', reason: 'fixture disconnect' })
    fake.emit(permissionRequested('s', 'replayed'))
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS)
    expect(fake.unwatchCalls).toEqual([])
    fake.emit({ type: 'permission.resolved', sessionId: 's', requestId: 'replayed' })
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS)
    expect(fake.unwatchCalls).toEqual([{ sessionId: 's' }])
    controller.dispose()
  })

  it('does not revive archived sessions from late events, timers, or old surface visibility', () => {
    const fake = fakeBackend()
    const controller = createSessionWatchController({ readDirectory: () => Promise.resolve([]) })
    controller.attach(fake.backend)
    controller.surfaceDisplaysSession('editor', 's')
    controller.surfaceVisibilityChanged('editor', false)
    fake.emit({ type: 'archived.sessions.changed', sessionIds: ['s'] })
    fake.emit({ type: 'session.status', sessionId: 's', status: 'running' })
    fake.emit(jobsUpdated('s', 'running'))
    fake.emit(permissionRequested('s', 'late'))
    controller.surfaceVisibilityChanged('editor', true)
    vi.advanceTimersByTime(SESSION_UNWATCH_DELAY_MS * 2)
    expect(fake.watchCalls).toEqual(['s'])
    expect(fake.unwatchCalls).toEqual([{ sessionId: 's' }])
    fake.emit({ type: 'archived.sessions.changed', sessionIds: [] })
    controller.surfaceDisplaysSession('editor', 's')
    expect(fake.watchCalls).toEqual(['s', 's'])
    controller.dispose()
  })

  it('ignores stale job snapshots and directory reads from a detached backend', async () => {
    const fake = fakeBackend()
    fake.directory.push({ id: 's', status: 'idle' })
    let finishJobs!: (jobs: readonly JobView[]) => void
    vi.spyOn(fake.backend.jobs, 'list').mockImplementation(
      () =>
        new Promise((done) => {
          finishJobs = done
        }),
    )
    const controller = createSessionWatchController()
    controller.attach(fake.backend)
    await vi.advanceTimersByTimeAsync(0)
    fake.emit(jobsUpdated('s', 'completed'))
    finishJobs(jobsUpdated('s', 'running').jobs)
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.watchCalls).toEqual([])
    fake.emit({ type: 'connection.restored' })
    await vi.advanceTimersByTimeAsync(0)
    controller.detach()
    const second = fakeBackend()
    controller.attach(second.backend)
    finishJobs(jobsUpdated('s', 'running').jobs)
    await vi.advanceTimersByTimeAsync(0)
    expect(second.watchCalls).toEqual([])
    controller.dispose()
  })
})
