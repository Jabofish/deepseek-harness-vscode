import { describe, expect, it, vi } from 'vitest'
import type {
  AsyncEventSource,
  BackendEvent,
  ChangeObservation,
  DshBackend,
  FeatureEventIdentity,
  ToolCallView,
} from '@dsh-vscode/domain'

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
  it('aggregates structured proposals and promotes only a hash-matched success', async () => {
    const updates: string[] = []
    const proposedHash = 'a'.repeat(64)
    const tracker = new ChangeSetTracker({
      now: () => 1_000,
      readObservedHash: () => Promise.resolve(proposedHash),
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

  it('deduplicates replayed identity and does not let an older proposal downgrade success', async () => {
    const tracker = new ChangeSetTracker({ now: () => 1_000 })
    const result = diffTool('completed', 'result', { metadata: { proposalNewHash: 'b'.repeat(64) } })
    await tracker.observeNow(observation(result, 4))
    await tracker.observeNow(observation(result, 4))
    await tracker.observeNow(observation(diffTool('running', 'call'), 3))

    const changes = await tracker.list()
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ evidence: 'structuredToolSuccess', applicationState: 'proposed' })
    expect(changes[0]?.sourceIds).toEqual(['tool-1'])
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
    expect(detail.redactedDiff).toContain('--- old')
    expect(detail.diffTruncated).toBe(false)
    expect((await tracker.list({ cursor: '1' })).length).toBe(0)
    expect((await tracker.list({ status: 'deleted' })).length).toBe(0)
  })

  it('does not attribute a delayed old-connection event to a new attachment', async () => {
    const firstEvents = eventSource()
    const secondEvents = eventSource()
    let releaseHash: (() => void) | undefined
    const hashReady = new Promise<void>((resolve) => {
      releaseHash = resolve
    })
    const tracker = new ChangeSetTracker({
      readObservedHash: async () => {
        await hashReady
        return 'c'.repeat(64)
      },
    })

    tracker.attach(backend(firstEvents, 1), () => 'workspace-1')
    firstEvents.emit({
      type: 'tool.updated',
      sessionId: 'session-1',
      sequence: 1,
      tool: diffTool('completed', 'result', { metadata: { proposalNewHash: 'c'.repeat(64) } }),
    })
    await Promise.resolve()
    tracker.attach(backend(secondEvents, 2), () => 'workspace-1')
    releaseHash?.()
    await vi.waitFor(async () => expect(await tracker.list()).toHaveLength(0))
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
})
