import { describe, expect, it, vi } from 'vitest'
import type { AsyncEventSource, BackendEvent, DshBackend, SessionSummary } from '@dsh-vscode/domain'

import { TaskCenterRegistry } from './task-center-registry.js'

interface TestEventSource extends AsyncEventSource<BackendEvent> {
  emit(event: BackendEvent): void
}

interface TestBackend extends DshBackend {
  readonly events: TestEventSource
}

function backend(
  overrides: {
    readonly session?: SessionSummary
    readonly cancel?: ReturnType<typeof vi.fn>
    readonly interrupt?: ReturnType<typeof vi.fn>
    readonly subagentMode?: 'one-shot' | 'continuable'
    readonly sessions?: readonly SessionSummary[]
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
  const sessionItems = overrides.sessions ?? [session]
  const sessionById = new Map(sessionItems.map((item) => [item.id, item]))
  const getSession = vi.fn().mockImplementation((sessionId: string) => {
    const found = sessionById.get(sessionId)
    return Promise.resolve(found ?? session)
  })
  return {
    connection: {
      endpoint: { host: '127.0.0.1', port: 3080, baseUrl: 'http://127.0.0.1:3080' },
      ownership: 'external',
      capabilities: { protocolVersion: 'rc.6', dshVersion: '0.1.0-rc.6', features: new Set<string>() },
      backendInstanceId: 'backend-1',
      connectionGeneration: 1,
    },
    sessions: {
      list: vi.fn().mockResolvedValue({ items: sessionItems }),
      get: getSession,
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
    workspaces: {
      listArchivedSessionIds: vi.fn().mockResolvedValue([]),
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
  })

  it('keeps readable workspace tasks bounded when one task metadata read fails', async () => {
    const background: SessionSummary = {
      id: 'session-2',
      workspaceId: 'dsh-workspace-1',
      title: 'Unavailable session',
      blank: false,
      status: 'running',
      createdAt: '2026-08-29T00:02:00.000Z',
      updatedAt: '2026-08-29T00:03:00.000Z',
    }
    const current = backend({ sessions: [background] })
    vi.spyOn(current.jobs, 'list').mockRejectedValue(new Error('Cannot read background tasks'))
    const registry = new TaskCenterRegistry({
      resolveSessionWorkspaceFolderId: () => 'folder-1',
      workspaceFolderIds: () => ['folder-1'],
      isWorkspaceFolderOpen: () => true,
    })
    registry.attach(current, () => 'folder-1')

    const snapshot = await registry.listSnapshot({ scope: 'workspace' })

    expect(snapshot.items).toEqual([])
    expect(snapshot.omittedSessions).toBe(1)
    expect(snapshot.complete).toBe(false)
  })

  it('uses a revision compare-and-set and only cancels a DSH session', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const registry = new TaskCenterRegistry({ now: () => 3_000 })
    registry.attach(backend({ cancel }), () => 'folder-1')
    registry.setCurrentSession('session-1')
    const task = (await registry.list({ sessionId: 'session-1' })).find((item) => item.kind === 'session')
    if (task === undefined) throw new Error('session task was not projected')
    await expect(registry.stop('session:session-1', task.taskRevision + 1)).rejects.toMatchObject({
      code: 'TASK_STATE_STALE',
    })
    const stopped = await registry.stop('session:session-1', task.taskRevision)
    expect(cancel).toHaveBeenCalledWith('session-1', undefined)
    expect(stopped.status).toBe('cancelled')
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
    await registry.stop(child.taskId, child.taskRevision)

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
    await expect(registry.stop(child.taskId, child.taskRevision)).rejects.toMatchObject({
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
})
