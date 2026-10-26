import { describe, expect, it, vi } from 'vitest'
import type {
  AsyncEventSource,
  BackendEvent,
  ChangeObservation,
  DshBackend,
  FeatureEventIdentity,
  ToolCallView,
} from '@dsh-vscode/domain'
import { rc6Mapper } from '@dsh-vscode/dsh-adapter'

import { ChangeSetTracker } from './change-set-tracker.js'

const identity = (serverSeq: number): FeatureEventIdentity => ({
  backendInstanceId: 'backend-1',
  connectionGeneration: 4,
  stream: 'mux',
  sessionId: 'session-1',
  serverSeq,
})

function observation(tool: ToolCallView, serverSeq: number): ChangeObservation {
  return {
    sessionId: 'session-1',
    workspaceFolderId: 'workspace-1',
    identity: { ...identity(serverSeq), toolCallId: tool.id },
    tool,
    observedAt: 1_000 + serverSeq,
  }
}

function diffTool(
  status: ToolCallView['status'],
  phase: 'call' | 'result',
  overrides: Partial<ToolCallView> = {},
): ToolCallView {
  return {
    id: 'tool-1',
    name: 'edit',
    category: 'edit',
    title: 'Edit file',
    status,
    metadata: {},
    presentation: {
      phase,
      card: 'diff',
      title: 'Edit file',
      diffs: [{ path: 'src/main.ts', oldText: 'old', newText: 'new' }],
    },
    ...overrides,
  }
}

/** The shape a real host sends: `meta.diffs[].path` is drive-absolute. */
function absoluteDiffTool(): ToolCallView {
  return diffTool('completed', 'result', {
    id: 'absolute-tool',
    presentation: {
      phase: 'result',
      card: 'diff',
      title: 'Edit D:\\ws\\src\\main.ts',
      diffs: [{ path: 'D:\\ws\\src\\main.ts', oldText: 'old', newText: 'new' }],
    },
  })
}

interface TestEventSource extends AsyncEventSource<BackendEvent> {
  emit(event: BackendEvent): void
}

function eventSource(): TestEventSource {
  const listeners = new Set<(event: BackendEvent) => void>()
  return {
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
}

function backend(events: TestEventSource, generation: number): DshBackend {
  return {
    connection: {
      endpoint: { host: '127.0.0.1', port: 3080, baseUrl: 'http://127.0.0.1:3080' },
      ownership: 'external',
      capabilities: { protocolVersion: 'rc6', dshVersion: '0.1.0-rc.6', features: new Set<string>() },
      backendInstanceId: 'backend-1',
      connectionGeneration: generation,
    },
    events,
  } as unknown as DshBackend
}

describe('ChangeSetTracker', () => {
  it('reports a removal-only edit, mapped from the DSH wire shape, as deleted', async () => {
    // The pinned DSH `edit` result carries `newText: ''` for a hunk that only
    // removes lines. The chain that has to keep it is mapper -> tracker: if
    // any layer filters an empty text out, the file disappears from the review
    // instead of being reported as deleted.
    const event = rc6Mapper.event('tool/result', {
      sessionId: 'session-1',
      data: {
        callId: 'call-removal',
        name: 'edit',
        status: 'completed',
        view: {
          for: 'result',
          view: {
            card: 'diff',
            title: 'Edit src/main.ts',
            diffs: [{ path: 'src/main.ts', oldText: 'const removed = 1', newText: '' }],
          },
        },
      },
    })
    if (event.type !== 'tool.updated') throw new Error(`Expected tool.updated, got ${event.type}`)

    const tracker = new ChangeSetTracker({ now: () => 1_000 })
    await tracker.observeNow(observation(event.tool, 1))
    const changes = await tracker.list({ sessionId: 'session-1' })

    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      relativePath: 'src/main.ts',
      status: 'deleted',
      evidence: 'structuredToolSuccess',
      additions: 0,
      deletions: 1,
      diffAvailable: true,
      diffs: [{ oldText: 'const removed = 1', newText: '' }],
    })
  })

  it('aggregates structured proposals and promotes only a hash-matched success', async () => {
    const updates: string[] = []
    const proposedHash = 'a'.repeat(64)
    const tracker = new ChangeSetTracker({
      now: () => 1_000,
      observeChangePath: () => Promise.resolve({ kind: 'hash', hash: proposedHash }),
      onChange: (change) => updates.push(`${change.applicationState}:${change.evidence}`),
    })

    await tracker.observeNow(observation(diffTool('running', 'call'), 1))
    let changes = await tracker.list({ sessionId: 'session-1' })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      status: 'modified',
      evidence: 'structuredProposal',
      applicationState: 'proposed',
      additions: 1,
      deletions: 1,
      diffAvailable: true,
    })

    await tracker.observeNow(
      observation(diffTool('completed', 'result', { metadata: { proposalNewHash: proposedHash } }), 2),
    )
    changes = await tracker.list()
    expect(changes[0]).toMatchObject({
      evidence: 'structuredToolSuccess',
      applicationState: 'appliedObserved',
      observedHash: proposedHash,
    })
    expect(updates).toEqual([
      'proposed:structuredProposal',
      'proposed:structuredToolSuccess',
      'appliedObserved:structuredToolSuccess',
    ])
  })

  it('keeps every hunk of a multi-hunk edit instead of only the last one', async () => {
    // The host computes one diff per applied hunk (`computeHunkDiffs`, three
    // context lines each), so a scattered `replace_all` arrives as a list. The
    // review keyed candidates by path and kept the last entry, losing every
    // earlier hunk from the diff text and the line totals — and because a
    // trailing pure-insertion hunk states `oldText: null`, it also relabelled a
    // modification of an existing file as an addition of a new one.
    const resultEvent = rc6Mapper.event('tool/result', {
      sessionId: 'session-1',
      data: {
        callId: 'call-scattered',
        name: 'edit',
        status: 'completed',
        message: { content: [{ type: 'text', text: 'Edited src/main.ts' }] },
        meta: {
          diffs: [
            {
              path: 'src/main.ts',
              oldText: 'a\nb\nc\nold\nd\ne\nf',
              newText: 'a\nb\nc\nnew\nd\ne\nf',
            },
            { path: 'src/main.ts', oldText: null, newText: 'inserted' },
          ],
        },
      },
    })
    if (resultEvent.type !== 'tool.updated') throw new Error(`Expected tool.updated, got ${resultEvent.type}`)

    const tracker = new ChangeSetTracker({ now: () => 1_000 })
    await tracker.observeNow(observation(resultEvent.tool, 1))
    const [change] = await tracker.list({ sessionId: 'session-1' })

    expect(change).toMatchObject({
      relativePath: 'src/main.ts',
      status: 'modified',
      evidence: 'structuredToolSuccess',
      additions: 8,
      deletions: 7,
      diffAvailable: true,
    })
    expect(change?.diffs).toEqual([
      { oldText: 'a\nb\nc\nold\nd\ne\nf', newText: 'a\nb\nc\nnew\nd\ne\nf' },
      { oldText: null, newText: 'inserted' },
    ])

    const detail = await tracker.get(change!.changeId)
    expect(detail.redactedDiff?.split('\n')).toEqual([
      '- a',
      '- b',
      '- c',
      '- old',
      '- d',
      '- e',
      '- f',
      '+ a',
      '+ b',
      '+ c',
      '+ new',
      '+ d',
      '+ e',
      '+ f',
      '⋯',
      '+ inserted',
    ])
  })

  it('keeps location-only mutation evidence and ignores malformed or non-mutation locations', async () => {
    const tracker = new ChangeSetTracker({ now: () => 1_000 })
    await tracker.observeNow(
      observation(
        {
          id: 'location-tool',
          name: 'edit',
          category: 'edit',
          title: 'Edit location',
          status: 'completed',
          locations: [
            { path: 'src/valid.ts', line: 4 },
            { path: '../escape.ts', line: 5 },
            { path: 'src\\foreign.ts', line: -1 },
          ],
          metadata: {},
        },
        5,
      ),
    )
    await tracker.observeNow(
      observation(
        {
          id: 'read-tool',
          name: 'read',
          category: 'read',
          title: 'Read location',
          status: 'completed',
          locations: [{ path: 'src/read.ts', line: 1 }],
          metadata: {},
        },
        6,
      ),
    )

    const changes = await tracker.list()
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      relativePath: 'src/valid.ts',
      status: 'unknown',
      evidence: 'structuredLocationOnly',
      applicationState: 'unknown',
      diffAvailable: false,
      locations: [{ path: 'src/valid.ts', line: 4 }],
    })
  })

  it('separates failed evidence, review state, detail bounds and list filters', async () => {
    const tracker = new ChangeSetTracker({ now: () => 2_000 })
    await tracker.observeNow(
      observation(
        diffTool('failed', 'result', {
          id: 'failed-tool',
          metadata: { interactionId: 'interaction-1' },
          locations: [{ path: 'src/failure.ts', line: 8 }],
          presentation: {
            phase: 'result',
            card: 'diff',
            title: 'Failed edit',
            diffs: [{ path: 'src/failure.ts', oldText: 'before', newText: 'after' }],
          },
        }),
        7,
      ),
    )
    const change = (await tracker.list({ status: 'modified' }))[0]
    expect(change).toBeDefined()
    const reviewed = await tracker.markReviewed(change!.changeId, 'viewed')
    expect(reviewed.reviewState).toBe('viewed')
    const detail = await tracker.get(change!.changeId)
    expect(detail.redactedDiff).toContain('- before')
    expect(detail.diffTruncated).toBe(false)
    expect((await tracker.list({ cursor: '1' })).length).toBe(0)
    expect((await tracker.list({ status: 'deleted' })).length).toBe(0)
  })

  it('filters structured events by the authoritative session workspace', async () => {
    const events = eventSource()
    const tracker = new ChangeSetTracker({
      resolveSessionWorkspaceFolderId: (_backend, sessionId) =>
        Promise.resolve(sessionId === 'session-1' ? 'workspace-1' : 'workspace-2'),
    })
    tracker.attach(backend(events, 1), () => 'workspace-1')
    events.emit({
      type: 'tool.updated',
      sessionId: 'session-1',
      sequence: 1,
      tool: diffTool('running', 'call'),
    })
    events.emit({
      type: 'tool.updated',
      sessionId: 'session-2',
      sequence: 2,
      tool: diffTool('running', 'call', { id: 'tool-2' }),
    })
    await vi.waitFor(async () => expect(await tracker.list()).toHaveLength(1))
    expect((await tracker.list())[0]?.sessionId).toBe('session-1')
  })

  it('drops a host path the workspace hook cannot fit and never stores it raw', async () => {
    const unfittable = new ChangeSetTracker({ now: () => 1_000, toWorkspaceRelativePath: () => undefined })
    await unfittable.observeNow(observation(absoluteDiffTool(), 12))
    expect(await unfittable.list()).toHaveLength(0)

    // A hook answering outside the canonical shape is a Host bug, not a licence
    // to store a path the renderer cannot resolve against its workspace.
    for (const answer of ['D:\\ws\\src\\main.ts', '../../escape.ts', '/etc/passwd', '']) {
      const leaking = new ChangeSetTracker({
        now: () => 1_000,
        toWorkspaceRelativePath: () => answer,
      })
      await leaking.observeNow(observation(absoluteDiffTool(), 13))
      expect(await leaking.list(), `hook answer ${answer}`).toHaveLength(0)
    }
  })

  it('fits a rename source so a host-absolute move stays a rename', async () => {
    const tracker = new ChangeSetTracker({
      now: () => 1_000,
      toWorkspaceRelativePath: (_workspaceFolderId, hostPath) =>
        hostPath.endsWith('new.ts') ? 'src/new.ts' : hostPath.endsWith('old.ts') ? 'src/old.ts' : undefined,
    })
    await tracker.observeNow(
      observation(
        diffTool('completed', 'result', {
          metadata: { previousRelativePath: 'D:\\ws\\src\\old.ts' },
          presentation: {
            phase: 'result',
            card: 'diff',
            title: 'Move src/old.ts to src/new.ts',
            diffs: [{ path: 'D:\\ws\\src\\new.ts', oldText: null, newText: 'moved' }],
          },
        }),
        16,
      ),
    )

    const [change] = await tracker.list()
    expect(change).toMatchObject({
      relativePath: 'src/new.ts',
      previousRelativePath: 'src/old.ts',
      status: 'renamed',
    })
  })
})

it('does not attribute an unowned session snapshot to the current workspace', async () => {
  const events = eventSource()
  const resolve = vi.fn(() => Promise.resolve(undefined))
  const summary = vi.fn()
  const live = {
    ...backend(events, 1),
    sessions: { get: vi.fn().mockResolvedValue({ id: 'other', cwd: '/outside' }) },
    workspaceChanges: { summary },
  } as unknown as DshBackend
  const tracker = new ChangeSetTracker({ resolveSessionWorkspaceFolderId: resolve })
  tracker.attach(live, () => 'workspace-1')
  events.emit({ type: 'unknown', name: 'workspace/changes', sessionId: 'other', sequence: 8, payload: {} })
  await vi.waitFor(() => expect(resolve).toHaveBeenCalled())
  expect(summary).not.toHaveBeenCalled()
  expect(await tracker.list()).toEqual([])
  tracker.dispose()
})

it('reports unavailable authoritative changes instead of a successful empty refresh', async () => {
  const tracker = new ChangeSetTracker()
  const live = backend(eventSource(), 1)
  tracker.attach(live, () => 'workspace-1')
  try {
    await expect(tracker.refreshAuthoritative(live, 'session-1', 'workspace-1')).resolves.toBe(false)
  } finally {
    tracker.dispose()
  }
})
