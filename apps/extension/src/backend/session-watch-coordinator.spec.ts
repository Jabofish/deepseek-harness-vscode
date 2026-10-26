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
})
