import { AppError } from '@dsh-vscode/domain'
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

  it('keeps a verified application when a same-rank duplicate event arrives', async () => {
    // DSH can publish the same tool card twice for one call (a host-local event
    // and the sequenced mux frame carry different identities but the same
    // change id). Once the file was edited again the duplicate cannot be
    // re-verified, and erasing the earlier verification would show a change
    // that *was* applied as "proposal only".
    const proposedHash = 'c'.repeat(64)
    let observedHash = proposedHash
    const tracker = new ChangeSetTracker({
      now: () => 1_000,
      observeChangePath: () => Promise.resolve({ kind: 'hash', hash: observedHash }),
    })
    const result = diffTool('completed', 'result', { metadata: { proposalNewHash: proposedHash } })
    await tracker.observeNow(observation(result, 4))
    expect((await tracker.list())[0]).toMatchObject({
      applicationState: 'appliedObserved',
      observedHash: proposedHash,
    })

    observedHash = 'd'.repeat(64)
    await tracker.observeNow(observation(result, 5))

    const [change] = await tracker.list()
    expect(change).toMatchObject({
      evidence: 'structuredToolSuccess',
      applicationState: 'appliedObserved',
      observedHash: proposedHash,
    })
  })

  it('carries an alpha no-view mutation from running proposal to settled observation', async () => {
    // The alpha line sends no view envelope on either row: the running card has
    // to be derived from the call arguments and the settled one from the durable
    // `meta`. If the running row derives nothing, the file only appears in the
    // review once it is already written — and a `str_replace_editor`-style row
    // that never derives a card would never appear at all.
    const callEvent = rc6Mapper.event('tool/call', {
      sessionId: 'session-1',
      data: {
        callId: 'call-write',
        name: 'write',
        arguments: JSON.stringify({ file_path: 'src/main.ts', content: 'export const answer = 42' }),
      },
    })
    if (callEvent.type !== 'tool.updated') throw new Error(`Expected tool.updated, got ${callEvent.type}`)
    const resultEvent = rc6Mapper.event('tool/result', {
      sessionId: 'session-1',
      data: {
        callId: 'call-write',
        name: 'write',
        status: 'completed',
        message: { content: [{ type: 'text', text: 'Wrote src/main.ts' }] },
        meta: {
          diffs: [{ path: 'src/main.ts', oldText: 'const answer = 41', newText: 'export const answer = 42' }],
        },
      },
    })
    if (resultEvent.type !== 'tool.updated') throw new Error(`Expected tool.updated, got ${resultEvent.type}`)

    const tracker = new ChangeSetTracker({ now: () => 1_000 })
    await tracker.observeNow(observation(callEvent.tool, 1))
    let changes = await tracker.list({ sessionId: 'session-1' })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      relativePath: 'src/main.ts',
      status: 'added',
      evidence: 'structuredProposal',
      applicationState: 'proposed',
      diffAvailable: true,
      diffs: [{ oldText: null, newText: 'export const answer = 42' }],
    })

    await tracker.observeNow(observation(resultEvent.tool, 2))
    changes = await tracker.list({ sessionId: 'session-1' })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      relativePath: 'src/main.ts',
      status: 'modified',
      evidence: 'structuredToolSuccess',
      applicationState: 'proposed',
      additions: 1,
      deletions: 1,
      diffs: [{ oldText: 'const answer = 41', newText: 'export const answer = 42' }],
    })
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

  it('keeps a long hunk list instead of a first thirty-two slice of it', async () => {
    // `computeHunkDiffs` bounds the hunk count nowhere: one scattered
    // `replace_all` over a large file arrives as dozens of hunks, and the review
    // used to slice the list at 32 with nothing on screen naming the tail loss.
    const hunks = Array.from({ length: 40 }, (_unused, index) => ({
      path: 'src/main.ts',
      oldText: `old-${index}`,
      newText: `new-${index}`,
    }))
    const tracker = new ChangeSetTracker({ now: () => 1_000 })
    await tracker.observeNow(
      observation(
        diffTool('completed', 'result', {
          id: 'wide-tool',
          presentation: { phase: 'result', card: 'diff', title: 'Edit src/main.ts', diffs: hunks },
        }),
        3,
      ),
    )
    const [change] = await tracker.list()

    expect(change?.diffs).toHaveLength(40)
    expect(change?.additions).toBe(40)
    expect(change?.deletions).toBe(40)
  })

  it('reads a file whose every hunk removed content as deleted', async () => {
    // A full deletion is the only case where no hunk brings new content back;
    // partial removals keep their context lines on the added side, so they stay
    // modifications.
    const tracker = new ChangeSetTracker({ now: () => 1_000 })
    await tracker.observeNow(
      observation(
        diffTool('completed', 'result', {
          id: 'delete-tool',
          presentation: {
            phase: 'result',
            card: 'diff',
            title: 'Edit src/main.ts',
            diffs: [
              { path: 'src/main.ts', oldText: 'first\nsecond', newText: '' },
              { path: 'src/main.ts', oldText: 'third', newText: '' },
            ],
          },
        }),
        2,
      ),
    )
    const [change] = await tracker.list()

    expect(change).toMatchObject({ status: 'deleted', additions: 0, deletions: 3 })
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

  it('marks a completed deletion as applied once the path is observed absent', async () => {
    // No hash can ever match a path that no longer exists, so absence is the
    // only evidence a deletion can produce. Without it every removed file stays
    // "Not verified" in the review even though the tool completed.
    const updates: string[] = []
    const tracker = new ChangeSetTracker({
      now: () => 1_000,
      observeChangePath: () => Promise.resolve({ kind: 'absent' }),
      onChange: (change) => updates.push(`${change.applicationState}:${change.evidence}`),
    })

    await tracker.observeNow(
      observation(
        diffTool('completed', 'result', {
          presentation: {
            phase: 'result',
            card: 'diff',
            title: 'Delete src/main.ts',
            diffs: [{ path: 'src/main.ts', oldText: 'const removed = 1', newText: '' }],
          },
        }),
        9,
      ),
    )

    const [change] = await tracker.list()
    expect(change).toMatchObject({
      status: 'deleted',
      evidence: 'structuredToolSuccess',
      applicationState: 'appliedObserved',
    })
    expect(change?.observedHash).toBeUndefined()
    expect(updates).toEqual(['proposed:structuredToolSuccess', 'appliedObserved:structuredToolSuccess'])
  })

  it('never credits an absent path to a change that proposed content', async () => {
    const tracker = new ChangeSetTracker({
      now: () => 1_000,
      observeChangePath: () => Promise.resolve({ kind: 'absent' }),
    })

    await tracker.observeNow(observation(diffTool('completed', 'result'), 10))

    expect((await tracker.list())[0]).toMatchObject({ applicationState: 'proposed' })
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

  it('does not attribute a delayed old-connection event to a new attachment', async () => {
    const firstEvents = eventSource()
    const secondEvents = eventSource()
    let releaseHash: (() => void) | undefined
    const hashReady = new Promise<void>((resolve) => {
      releaseHash = resolve
    })
    const tracker = new ChangeSetTracker({
      observeChangePath: async () => {
        await hashReady
        return { kind: 'hash', hash: 'c'.repeat(64) }
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

  it('fits a host-absolute diff path through the workspace hook instead of dropping the change', async () => {
    // A real host states `meta.diffs[].path` as an absolute host path
    // (`D:\ws\src\main.ts`; every one of 182 observed entries, both on the raw
    // log and through the live API). The canonical-path gate rejected all of
    // them, so the review stayed empty for real edits while the tool card still
    // rendered. The Host fits the path to the workspace folder before it enters
    // the tracker.
    const seen: string[] = []
    const tracker = new ChangeSetTracker({
      now: () => 1_000,
      toWorkspaceRelativePath: (workspaceFolderId, hostPath) => {
        seen.push(`${workspaceFolderId}:${hostPath}`)
        return hostPath === 'D:\\ws\\src\\main.ts' ? 'src/main.ts' : undefined
      },
    })
    await tracker.observeNow(
      observation(
        diffTool('completed', 'result', {
          presentation: {
            phase: 'result',
            card: 'diff',
            title: 'Edit D:\\ws\\src\\main.ts',
            diffs: [{ path: 'D:\\ws\\src\\main.ts', oldText: 'old', newText: 'new' }],
          },
        }),
        11,
      ),
    )

    const changes = await tracker.list({ sessionId: 'session-1' })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      relativePath: 'src/main.ts',
      status: 'modified',
      evidence: 'structuredToolSuccess',
      additions: 1,
      deletions: 1,
      diffAvailable: true,
    })
    expect(changes[0]?.diffs).toEqual([{ oldText: 'old', newText: 'new' }])
    expect(seen).toEqual(['workspace-1:D:\\ws\\src\\main.ts'])
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

  it('merges two host spellings that fit to one workspace path into a single change', async () => {
    // One file can arrive under two spellings (the call argument keeps the
    // separator style it was typed with, the result meta is drive-absolute).
    // Fitting them into separate rows would show one file twice in the review.
    const tracker = new ChangeSetTracker({
      now: () => 1_000,
      toWorkspaceRelativePath: (_workspaceFolderId, hostPath) =>
        hostPath.endsWith('main.ts') ? 'src/main.ts' : undefined,
    })
    await tracker.observeNow(
      observation(
        diffTool('completed', 'result', {
          presentation: {
            phase: 'result',
            card: 'diff',
            title: 'Edit src/main.ts',
            diffs: [
              { path: 'D:\\ws\\src\\main.ts', oldText: 'a', newText: 'b' },
              { path: 'D:/ws/src/main.ts', oldText: null, newText: 'inserted' },
            ],
          },
        }),
        14,
      ),
    )

    const changes = await tracker.list()
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      relativePath: 'src/main.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
    })
    expect(changes[0]?.diffs).toEqual([
      { oldText: 'a', newText: 'b' },
      { oldText: null, newText: 'inserted' },
    ])
  })

  it('fits host location evidence so a location-only mutation still appears', async () => {
    const tracker = new ChangeSetTracker({
      now: () => 1_000,
      toWorkspaceRelativePath: (_workspaceFolderId, hostPath) =>
        hostPath === 'D:\\ws\\src\\touched.ts' ? 'src/touched.ts' : undefined,
    })
    await tracker.observeNow(
      observation(
        {
          id: 'location-only-tool',
          name: 'edit',
          category: 'edit',
          title: 'Edit D:\\ws\\src\\touched.ts',
          status: 'completed',
          locations: [{ path: 'D:\\ws\\src\\touched.ts', line: 3 }],
          metadata: {},
        },
        15,
      ),
    )

    const [change] = await tracker.list()
    expect(change).toMatchObject({
      relativePath: 'src/touched.ts',
      evidence: 'structuredLocationOnly',
      locations: [{ path: 'src/touched.ts', line: 3 }],
    })
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

  it('resolves each session workspace once per attachment instead of per event', async () => {
    const events = eventSource()
    let resolutions = 0
    const tracker = new ChangeSetTracker({
      resolveSessionWorkspaceFolderId: (_backend, sessionId) => {
        resolutions += 1
        return Promise.resolve(sessionId === 'session-1' ? 'workspace-1' : undefined)
      },
    })
    tracker.attach(backend(events, 1), () => 'workspace-1')
    for (let index = 0; index < 3; index += 1)
      events.emit({
        type: 'tool.updated',
        sessionId: 'session-1',
        sequence: index + 1,
        tool: diffTool('running', 'call', { id: `tool-${index}` }),
      })
    await vi.waitFor(async () => expect(await tracker.list()).toHaveLength(3))
    // The session-to-workspace mapping is stable for one attachment; a full
    // session.list + session.history lookup per tool event multiplies RPC
    // load across an active turn before the seen-events dedupe runs.
    expect(resolutions).toBe(1)

    // A new attachment starts a fresh resolution (mapping may have changed).
    tracker.attach(backend(events, 2), () => 'workspace-1')
    events.emit({
      type: 'tool.updated',
      sessionId: 'session-1',
      sequence: 9,
      tool: diffTool('running', 'call', { id: 'tool-after-reattach' }),
    })
    await vi.waitFor(() => expect(resolutions).toBe(2))
  })
})

it.each(['empty', 'filtered'] as const)(
  'invalidates shell-only changes after a %s snapshot',
  async (mode) => {
    const events = eventSource()
    let sequence = 8
    let files = [{ path: 'shell.txt', additions: 2, deletions: 0, diffAvailable: true }]
    const live = {
      ...backend(events, 1),
      sessions: {
        get: vi.fn().mockResolvedValue({ id: 'session-1' }),
        history: vi.fn(() =>
          Promise.resolve({
            hasMore: false,
            events: [
              {
                sequence,
                time: '',
                event: { type: 'unknown', name: 'workspace/changes', sessionId: 'session-1' },
              },
            ],
          }),
        ),
      },
      workspaceChanges: {
        summary: vi.fn(() => Promise.resolve({ turn: 1, total: files.length, files })),
        diff: vi.fn().mockResolvedValue('@@ -0,0 +1,2 @@\n+one\n+two'),
      },
    } as unknown as DshBackend
    const onInvalidate = vi.fn()
    let filterAll = false
    const tracker = new ChangeSetTracker({
      onInvalidate,
      toWorkspaceRelativePath: (_workspace, value) => (filterAll ? undefined : value),
    })
    tracker.attach(live, () => 'workspace-1')
    await tracker.refreshAuthoritative(live, 'session-1', 'workspace-1')
    await tracker.observeNow(observation(diffTool('completed', 'result', { turn: 1 }), 7))
    const changes = await tracker.list()
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      relativePath: 'shell.txt',
      additions: 2,
      applicationState: 'appliedObserved',
    })
    expect((await tracker.get(changes[0]!.changeId)).redactedDiff).toContain('+two')
    sequence = 9
    onInvalidate.mockClear()
    files =
      mode === 'empty'
        ? []
        : [{ path: '/outside/shell.txt', additions: 2, deletions: 0, diffAvailable: true }]
    filterAll = mode === 'filtered'
    await tracker.refreshAuthoritative(live, 'session-1', 'workspace-1')
    expect(await tracker.list()).toEqual([])
    expect(onInvalidate).toHaveBeenCalledExactlyOnceWith('session-1')
    tracker.dispose()
  },
)

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

it.each(['get', 'history', 'summary', 'cancel'] as const)(
  'preserves local review rows when authoritative %s fails',
  async (failure) => {
    const error = new AppError({
      code: failure === 'cancel' ? 'REQUEST_CANCELLED' : 'BACKEND_UNREACHABLE',
      message: 'Unavailable',
      retryable: false,
    })
    const live = {
      ...backend(eventSource(), 1),
      sessions: {
        get: failure === 'get' ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue({}),
        history:
          failure === 'history'
            ? vi.fn().mockRejectedValue(error)
            : vi.fn().mockResolvedValue({
                hasMore: false,
                events: [{ sequence: 8, event: { type: 'unknown', name: 'workspace/changes' } }],
              }),
      },
      workspaceChanges: { summary: vi.fn().mockRejectedValue(error) },
    } as unknown as DshBackend
    const tracker = new ChangeSetTracker()
    tracker.attach(live, () => 'workspace-1')
    await tracker.observeNow(observation(diffTool('completed', 'result'), 7))
    const before = await tracker.list()
    expect(before.length).toBeGreaterThan(0)
    try {
      const refresh = tracker.refreshAuthoritative(live, 'session-1', 'workspace-1')
      if (failure === 'cancel') await expect(refresh).rejects.toBe(error)
      else await expect(refresh).resolves.toBe(false)
      expect(await tracker.list()).toEqual(before)
    } finally {
      tracker.dispose()
    }
  },
)
