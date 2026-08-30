import { describe, expect, it, vi } from 'vitest'
import type {
  AsyncEventSource,
  BackendEvent,
  DshBackend,
  SessionDetail,
  SessionSummary,
} from '@dsh-vscode/domain'

import { TaskCenterRegistry } from './task-center-registry.js'

interface TestEventSource extends AsyncEventSource<BackendEvent> {
  emit(event: BackendEvent): void
}

interface TestBackend extends DshBackend {
  readonly events: TestEventSource
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function backend(
  overrides: {
    readonly session?: SessionSummary
    readonly cancel?: ReturnType<typeof vi.fn>
    readonly interrupt?: ReturnType<typeof vi.fn>
    readonly subagentMode?: 'one-shot' | 'continuable'
  } = {},
): TestBackend {
  const session =
    overrides.session ??
    ({
      id: 'session-1',
      workspaceId: 'dsh-workspace-1',
      title: 'Main session',
      blank: false,
      status: 'running',
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:01:00.000Z',
    } satisfies SessionSummary)
  const listeners = new Set<(event: BackendEvent) => void>()
  const events: TestEventSource = {
    subscribe(listener: (event: BackendEvent) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    close: () => Promise.resolve(),
    emit(event: BackendEvent): void {
      for (const listener of listeners) listener(event)
    },
  }
  const cancel = overrides.cancel ?? vi.fn().mockResolvedValue(undefined)
  const interrupt = overrides.interrupt ?? vi.fn().mockResolvedValue(undefined)
  return {
    connection: {
      endpoint: { host: '127.0.0.1', port: 3080, baseUrl: 'http://127.0.0.1:3080' },
      ownership: 'external',
      capabilities: { protocolVersion: 'rc.6', dshVersion: '0.1.0-rc.6', features: new Set<string>() },
      backendInstanceId: 'backend-1',
      connectionGeneration: 1,
    },
    sessions: {
      get: vi.fn().mockResolvedValue(session),
      cancel,
    },
    jobs: {
      list: vi
        .fn()
        .mockResolvedValue([
          { id: 'job-1', kind: 'shell', label: 'npm test', status: 'running', startedAt: 1 },
        ]),
    },
    goals: { list: vi.fn().mockResolvedValue([{ id: 'goal-1', title: 'Ship it', status: 'in-progress' }]) },
    subagents: {
      list: vi.fn().mockResolvedValue({
        parentAvailable: true,
        entries: [
          {
            kind: 'child',
            id: 'child-1',
            label: 'Review child',
            activity: 'running',
            parentSessionId: 'session-1',
            mode: overrides.subagentMode ?? 'continuable',
            hasChildren: false,
          },
        ],
      }),
      interrupt,
    },
    interactions: {
      respondToPermission: vi.fn().mockResolvedValue(undefined),
      respondToQuestion: vi.fn().mockResolvedValue(undefined),
    },
    events,
  } as unknown as TestBackend
}

describe('TaskCenterRegistry', () => {
  it('builds a current-session-only projection from existing repositories', async () => {
    const registry = new TaskCenterRegistry({ now: () => 2_000 })
    registry.attach(backend(), () => 'folder-1')
    registry.setCurrentSession('session-1')

    const tasks = await registry.list({ sessionId: 'session-1' })

    expect(tasks.map((task) => task.kind)).toEqual(
      expect.arrayContaining(['subagent', 'session', 'goal', 'job']),
    )
    expect(tasks).toHaveLength(4)
    expect(tasks.every((task) => task.workspaceFolderId === 'folder-1')).toBe(true)
    expect(tasks.every((task) => task.canProcessStop === false)).toBe(true)
  })

  it('uses a revision compare-and-set and only cancels a DSH session', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const registry = new TaskCenterRegistry({ now: () => 3_000 })
    registry.attach(backend({ cancel }), () => 'folder-1')
    registry.setCurrentSession('session-1')
    const task = (await registry.list({ sessionId: 'session-1' })).find((item) => item.kind === 'session')
    if (task === undefined) throw new Error('session task was not projected')
    await expect(
      registry.stop('session:session-1', 'session-cancel', task.taskRevision + 1),
    ).rejects.toMatchObject({
      code: 'TASK_STATE_STALE',
    })
    const stopped = await registry.stop('session:session-1', 'session-cancel', task.taskRevision)
    expect(cancel).toHaveBeenCalledWith('session-1', undefined)
    expect(stopped.status).toBe('cancelled')
    await expect(
      registry.stop('session:session-1', 'process-stop', stopped.taskRevision),
    ).rejects.toMatchObject({
      code: 'TASK_NOT_OWNED',
    })
  })

  it('uses the subagent interrupt port for continuable children and not the parent session cancel', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const interrupt = vi.fn().mockResolvedValue(undefined)
    const current = backend({ cancel, interrupt })
    const registry = new TaskCenterRegistry({ now: () => 3_500 })
    registry.attach(current, () => 'folder-1')
    registry.setCurrentSession('session-1')

    const child = (await registry.list({ sessionId: 'session-1' })).find((task) => task.kind === 'subagent')
    if (child === undefined) throw new Error('subagent task was not projected')
    await registry.stop(child.taskId, 'session-cancel', child.taskRevision)

    expect(interrupt).toHaveBeenCalledWith('child-1', undefined)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('does not expose a stop action for one-shot children', async () => {
    const current = backend({ subagentMode: 'one-shot' })
    const registry = new TaskCenterRegistry()
    registry.attach(current, () => 'folder-1')
    registry.setCurrentSession('session-1')

    const child = (await registry.list({ sessionId: 'session-1' })).find((task) => task.kind === 'subagent')
    if (child === undefined) throw new Error('one-shot subagent task was not projected')
    expect(child.canSessionCancel).toBe(false)
    await expect(registry.stop(child.taskId, 'session-cancel', child.taskRevision)).rejects.toMatchObject({
      code: 'TASK_NOT_OWNED',
    })
  })

  it('turns a structured question event into an answerable task and removes it after answer', async () => {
    const current = backend()
    const registry = new TaskCenterRegistry({ now: () => 4_000 })
    registry.attach(current, () => 'folder-1')
    registry.setCurrentSession('session-1')
    current.events.emit({
      type: 'question.requested',
      question: { id: 'q-1', sessionId: 'session-1', prompt: 'Continue?', allowFreeText: true },
    })
    const pending = (await registry.list({ sessionId: 'session-1' })).find(
      (task) => task.interactionId === 'q-1',
    )
    expect(pending?.canAnswer).toBe(true)
    await registry.answer('interaction:question:q-1', 'q-1', 'yes')
    expect(
      (await registry.list({ sessionId: 'session-1' })).some((task) => task.interactionId === 'q-1'),
    ).toBe(false)
  })

  it('drops all task state on detach so late events cannot reappear', async () => {
    const current = backend()
    const registry = new TaskCenterRegistry()
    registry.attach(current, () => 'folder-1')
    registry.setCurrentSession('session-1')
    registry.detach()
    current.events.emit({
      type: 'question.requested',
      question: { id: 'q-1', sessionId: 'session-1', prompt: 'Continue?', allowFreeText: true },
    })
    await expect(registry.list({ sessionId: 'session-1' })).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
    })
  })

  it('does not repopulate tasks when detach happens during repository reads', async () => {
    const current = backend()
    const sessionRead = deferred<SessionDetail>()
    vi.spyOn(current.sessions, 'get').mockReturnValue(sessionRead.promise)
    const registry = new TaskCenterRegistry()
    registry.attach(current, () => 'folder-1')
    registry.setCurrentSession('session-1')

    const listing = registry.list({ sessionId: 'session-1' })
    registry.detach()
    sessionRead.resolve({
      id: 'session-1',
      workspaceId: 'dsh-workspace-1',
      title: 'Late session',
      blank: false,
      status: 'running',
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:01:00.000Z',
      configuration: {
        preset: 'standard',
        toolMode: 'native',
        permissionPreset: 'workspace-write',
        planMode: false,
        model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
      },
      goalIds: [],
    })

    await expect(listing).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    await expect(registry.get('session:session-1')).rejects.toMatchObject({ code: 'TASK_NOT_OWNED' })
  })
})
