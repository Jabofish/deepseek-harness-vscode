import { describe, expect, it, vi } from 'vitest'
import type { TaskSummary } from '@dsh-vscode/domain'
import { featureHostEventSchema, type FeatureHostEvent } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from '../protocol-client.js'
import { createInitialState } from './initial-state.js'
import { createFeatureActions } from './feature-actions.js'
import type { AppState } from './types.js'

function deferred(): {
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void
  const promise = new Promise<unknown>((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}

function harness(initialTasks: readonly TaskSummary[] = []): {
  features: ReturnType<typeof createFeatureActions>
  requests: ReturnType<typeof deferred>[]
  featureRequest: ReturnType<typeof vi.fn<() => Promise<unknown>>>
  invalidated: (sessionId?: string) => FeatureHostEvent
  getState: () => AppState
  switchSession: (id: string) => void
} {
  let state: AppState = { ...createInitialState({}), activeSessionId: 'session-1', tasks: initialTasks }
  const requests: ReturnType<typeof deferred>[] = []
  const featureRequest = vi.fn(() => {
    const request = deferred()
    requests.push(request)
    return request.promise
  })
  const features = createFeatureActions({
    client: { featureRequest } as unknown as ProtocolClient,
    getState: () => state,
    setState: (update) => {
      state = typeof update === 'function' ? update(state) : update
    },
    sessionWorkspaceFolderId: () => 'folder-1',
  })
  const invalidated = (sessionId = 'session-1'): FeatureHostEvent =>
    featureHostEventSchema.parse({
      type: 'feature.event',
      name: 'tasks.invalidated',
      sessionId,
      identity: {
        backendInstanceId: 'backend-1',
        connectionGeneration: 1,
        stream: 'local',
        localSeq: 1,
        sessionId,
      },
    })
  return {
    features,
    requests,
    featureRequest,
    invalidated,
    getState: () => state,
    switchSession: (id: string) => {
      state = { ...state, activeSessionId: id }
      features.retireForSessionSwitch()
    },
  }
}

const snapshot = {
  kind: 'tasks',
  scope: 'current-session',
  source: 'current-session',
  items: [],
  complete: true,
  omittedSessions: 0,
}

describe('task invalidation reads', () => {
  it('starts immediately, folds a burst into one fresh read, and removes resolved interactions from the snapshot', async () => {
    const question: TaskSummary = {
      taskId: 'interaction:question:q',
      sourceId: 'q',
      interactionId: 'q',
      sessionId: 'session-1',
      workspaceFolderId: 'folder-1',
      kind: 'interaction',
      title: 'Continue?',
      status: 'needs-input',
      needsUserAction: true,
      actionKind: 'question',
      startedAt: 1,
      updatedAt: 1,
      childCount: 0,
      canOpen: true,
      canAnswer: true,
      canSessionCancel: true,
      ownerKind: 'unknown',
      taskRevision: 1,
    }
    const h = harness([question])
    const first = h.features.methods.refreshTasks('session-1')
    expect(h.featureRequest).toHaveBeenCalledOnce()
    for (let i = 0; i < 100; i++) h.features.applyFeatureEvent(h.invalidated())
    expect(h.featureRequest).toHaveBeenCalledOnce()
    h.requests[0]!.resolve({ ...snapshot, items: [question] })
    await vi.waitFor(() => expect(h.featureRequest).toHaveBeenCalledTimes(2))
    expect(h.getState().tasks).toContainEqual(expect.objectContaining({ interactionId: 'q' }))
    h.requests[1]!.resolve(snapshot)
    await first
    expect(h.getState().tasks).toEqual([])
    expect(h.getState().tasksLoading).toBe(false)
    const next = h.features.methods.refreshTasks('session-1')
    expect(h.featureRequest).toHaveBeenCalledTimes(3)
    h.requests[2]!.resolve(snapshot)
    await next
  })

  it('retires a dirty old-session read and does not publish its snapshot after switching', async () => {
    const h = harness()
    const old = h.features.methods.refreshTasks('session-1')
    h.features.applyFeatureEvent(h.invalidated())
    h.switchSession('session-2')
    const current = h.features.methods.refreshTasks('session-2')
    h.requests[0]!.resolve({ ...snapshot, complete: false, omittedSessions: 9 })
    await old
    expect(h.featureRequest).toHaveBeenCalledTimes(2)
    expect(h.getState().tasksOmittedSessions).toBe(0)
    h.requests[1]!.resolve(snapshot)
    await current
    expect(h.getState().tasksLoading).toBe(false)
  })

  it('releases a failed read for retry and keeps workspace reads bound to the active folder', async () => {
    const h = harness()
    const failed = h.features.methods.refreshTasks('session-1')
    h.requests[0]!.reject(new Error('offline'))
    await expect(failed).rejects.toThrow('offline')
    const retry = h.features.methods.refreshTasks(undefined, false, 'workspace')
    expect(h.featureRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'tasks.list',
        payload: { scope: 'workspace', workspaceFolderId: 'folder-1', includeCompleted: false, limit: 200 },
      }),
    )
    h.requests[1]!.resolve({ ...snapshot, scope: 'workspace', source: 'workspace-composed' })
    await retry
    expect(h.getState().taskScope).toBe('workspace')
    h.features.applyFeatureEvent(h.invalidated('background-session'))
    expect(h.featureRequest).toHaveBeenCalledTimes(3)
    h.requests[2]!.resolve({ ...snapshot, scope: 'workspace', source: 'workspace-composed' })
    await vi.waitFor(() => expect(h.getState().tasksLoading).toBe(false))
  })
})
