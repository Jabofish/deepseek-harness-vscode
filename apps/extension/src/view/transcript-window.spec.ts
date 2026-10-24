import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import type { BackendEvent, SessionHistoryEvent, SessionHistoryPage } from '@dsh-vscode/domain'
import {
  TRANSCRIPT_MAX_CHARS,
  TRANSCRIPT_MAX_NODES,
  transcriptWindowSchema,
  type TranscriptWindow,
  type TranscriptPatch,
} from '@dsh-vscode/webview-protocol'
import { isTranscriptOnlyEvent, TranscriptWindowService } from './transcript-window.js'
import { sanitizePublicValue } from './public-value.js'

const sessionId = 'session-fixture'
const row = (sequence: number, event: BackendEvent): SessionHistoryEvent => ({
  sequence,
  time: '2026-10-14T00:00:00.000Z',
  event,
})
const message = (sequence: number, text = `Answer ${sequence}`): SessionHistoryEvent =>
  row(sequence, {
    type: 'message.completed',
    sessionId,
    messageId: `m-${sequence}`,
    markdown: text,
    sequence,
  })
function fixture(
  read = vi
    .fn<
      (
        sessionId: string,
        before: number | undefined,
        signal: AbortSignal,
        child: boolean,
      ) => Promise<SessionHistoryPage>
    >()
    .mockResolvedValue({ events: [], hasMore: false }),
): {
  service: TranscriptWindowService
  posted: TranscriptWindow[]
  read: typeof read
  open: (events?: readonly SessionHistoryEvent[]) => TranscriptWindow
} {
  const posted: TranscriptWindow[] = []
  const service = new TranscriptWindowService({
    read,
    publicValue: (value) => sanitizePublicValue(value),
    post: (value) => {
      posted.push(value)
      return Promise.resolve(true)
    },
  })
  const open = (events: readonly SessionHistoryEvent[] = []): TranscriptWindow =>
    service.installPage(sessionId, { events, hasMore: true, beforeSequence: 1 }, service.begin(sessionId))
  return { service, posted, read, open }
}
afterEach(() => vi.useRealTimers())

describe('Host transcript windows', () => {
  it('posts subsequent text and executed tool context before the preceding IPC receipt settles', async () => {
    vi.useFakeTimers()
    const sent: (TranscriptWindow | TranscriptPatch)[] = []
    let release!: (value: boolean) => void
    const firstReceipt = new Promise<boolean>((resolve) => {
      release = resolve
    })
    const service = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value) => value,
      post: (value) => {
        sent.push(value)
        return sent.length === 1 ? firstReceipt : Promise.resolve(true)
      },
      postPatch: (value) => {
        sent.push(value)
        return Promise.resolve(true)
      },
    })
    service.installPage(sessionId, { events: [message(0)], hasMore: false }, service.begin(sessionId))
    service.accept({ type: 'message.delta', sessionId, messageId: 'live', delta: 'first' })
    service.accept({ type: 'message.delta', sessionId, messageId: 'live', delta: ' second' })
    service.accept({
      type: 'tool.updated',
      sessionId,
      sequence: 1,
      tool: {
        id: 'call',
        name: 'ask_user_question',
        category: 'other',
        title: 'Question',
        status: 'running',
        metadata: {},
      },
    })
    expect(sent).toHaveLength(3)
    expect((sent[1] as TranscriptPatch).changedNodes).toContainEqual(
      expect.objectContaining({ markdown: 'first second' }),
    )
    expect((sent[2] as TranscriptPatch).changedNodes).toContainEqual(
      expect.objectContaining({ kind: 'tool', id: 'call' }),
    )
    expect(vi.getTimerCount()).toBe(0)
    release(false)
    for (let index = 0; index < 6; index++) await Promise.resolve()
    expect(sent.at(-1)).toHaveProperty('eventFacts')
    expect((sent.at(-1) as TranscriptWindow).nodes).toContainEqual(
      expect.objectContaining({ markdown: 'first second' }),
    )
    service.dispose()
  })
  it.each(['message.delta', 'reasoning.delta'] as const)(
    'keeps all %s content intact above the former preview budget',
    async (type) => {
      const client = fixture()
      client.open()
      client.service.accept({ type, sessionId, messageId: 'live', delta: 'old '.repeat(40_000), turn: 1 })
      await Promise.resolve()
      client.service.acknowledge(sessionId, client.posted.at(-1)!.revision)
      client.service.accept({ type, sessionId, messageId: 'live', delta: 'LATEST_PROGRESS', turn: 1 })
      await Promise.resolve()
      await vi.waitFor(() => {
        const latest = client.posted.at(-1)?.nodes.find((item) => item.id === 'live')
        const body =
          latest?.kind === 'assistant-message'
            ? type === 'message.delta'
              ? latest.markdown
              : latest.reasoning?.markdown
            : undefined
        expect(body?.includes('LATEST_PROGRESS')).toBe(true)
      })
      const window = client.posted.at(-1)
      const node = window?.nodes.find((item) => item.id === 'live')
      if (node?.kind !== 'assistant-message') throw new Error('Missing live answer')
      const body = type === 'message.delta' ? node.markdown : node.reasoning?.markdown
      expect(body?.includes('LATEST_PROGRESS')).toBe(true)
      expect(window?.omittedNodeIds).not.toContain('live')
      expect(transcriptWindowSchema.safeParse(window).success).toBe(true)
      client.service.dispose()
    },
  )

  it.each([
    { markdown: '\\\n'.repeat(60_000), reasoning: undefined },
    { markdown: 'answer '.repeat(18_000), reasoning: 'thinking '.repeat(15_000) },
  ])(
    'publishes complete prose and reasoning above the former serialized budget',
    async ({ markdown, reasoning }) => {
      const event: BackendEvent = {
        type: 'message.completed',
        sessionId,
        messageId: 'large-answer',
        markdown,
        ...(reasoning === undefined ? {} : { reasoning }),
        sequence: 1,
      }
      const client = fixture(vi.fn().mockResolvedValue({ events: [row(1, event)], hasMore: false }))
      const window = client.open([row(1, event)])
      expect(window.nodes[0]).toMatchObject({ kind: 'assistant-message', id: 'large-answer' })
      const node = window.nodes[0]
      if (node?.kind !== 'assistant-message') throw new Error('Answer was discarded')
      expect(node.markdown.length).toBeGreaterThan(1_000)
      expect(markdown.startsWith(node.markdown)).toBe(true)
      expect(node.markdown).toBe(markdown)
      expect(window.omittedNodeIds).not.toContain('large-answer')
      expect(transcriptWindowSchema.safeParse(window).success).toBe(true)
      expect(
        await client.service.content(sessionId, node.id, window.revision, new AbortController().signal),
      ).toBe(reasoning === undefined ? markdown : `${reasoning}\n\n${markdown}`)
      client.service.dispose()
    },
  )

  it('retains full-content access when a clipped live answer ends without a replacement body', async () => {
    const full = 'a'.repeat(TRANSCRIPT_MAX_CHARS + 1024)
    const client = fixture(vi.fn().mockResolvedValue({ events: [message(2, full)], hasMore: false }))
    client.open()
    client.service.accept({ type: 'turn.started', sessionId, turn: 1, sequence: 1 })
    client.service.accept({
      type: 'message.delta',
      sessionId,
      messageId: 'm-2',
      turn: 1,
      delta: full,
      sequence: 2,
    })
    client.service.accept({ type: 'turn.ended', sessionId, turn: 1, reason: 'completed', sequence: 3 })
    const window = client.service['snapshot']()
    expect(window.omittedNodeIds).toContain('m-2')
    expect(
      await client.service.content(sessionId, 'm-2', window.revision, new AbortController().signal),
    ).toBe(full)
    client.service.dispose()
  })

  it('preserves the whole live body through viewport eviction and later deltas', async () => {
    const client = fixture()
    client.open()
    const full = 'ORIGINAL_START ' + 'x'.repeat(TRANSCRIPT_MAX_CHARS + 1024)
    client.service.accept({
      type: 'message.delta',
      sessionId,
      messageId: 'live',
      delta: full,
      turn: 1,
      sequence: 1,
    })
    // Force the live node out of the visible node window.
    for (let index = 0; index < 260; index++) client.service.accept(message(index + 2).event)
    client.service.accept({
      type: 'message.delta',
      sessionId,
      messageId: 'live',
      delta: ' COMPLETE_TAIL',
      turn: 1,
      sequence: 300,
    })
    const resident = client.service['tail']!
    const restored = resident.liveBodies.get('live')
    expect(restored).toMatchObject({ markdown: full + ' COMPLETE_TAIL' })
    await Promise.resolve()
    client.service.dispose()
  })

  it('returns complete live nodes, rejects stale session/revision reads, and honors cancellation', () => {
    const client = fixture()
    const window = client.open([message(1, 'Whole body')])
    const signal = new AbortController().signal
    expect(client.service.fullNode(sessionId, 'm-1', window.revision, signal)).toMatchObject({
      markdown: 'Whole body',
    })
    expect(() => client.service.fullNode('other', 'm-1', window.revision, signal)).toThrow()
    expect(() => client.service.fullNode(sessionId, 'm-1', window.revision + 1, signal)).toThrow()
    expect(() => client.service.fullNode(sessionId, 'missing', window.revision, signal)).toThrow()
    const aborted = new AbortController()
    aborted.abort()
    expect(() => client.service.fullNode(sessionId, 'm-1', window.revision, aborted.signal)).toThrow()
    client.service.dispose()
  })

  it('serves an active approval tool after its row leaves the displayed window', () => {
    const client = fixture()
    const opened = client.open()
    client.service.accept({
      type: 'tool.updated',
      sessionId,
      sequence: 1,
      tool: {
        id: 'pending-call',
        name: 'bash',
        category: 'terminal',
        title: 'bash',
        status: 'running',
        inputSummary: '{"command":"whole command"}',
        metadata: {},
        presentation: { phase: 'call', card: 'terminal', title: 'whole command' },
      },
    })
    const resident = client.service['tail']!
    expect(resident.liveBodies.has('pending-call')).toBe(true)
    resident.timeline = { ...resident.timeline, nodes: [] }
    expect(
      client.service.fullNode(sessionId, 'pending-call', opened.revision, new AbortController().signal),
    ).toMatchObject({
      kind: 'tool',
      tool: { inputSummary: '{"command":"whole command"}', presentation: { title: 'whole command' } },
    })
    client.service.dispose()
  })

  it('keeps compacted history stable when follow replays native rows below the read cut', async () => {
    const invalidated = vi.fn()
    const posted: TranscriptWindow[] = []
    const service = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value) => value,
      post: (value) => {
        posted.push(value)
        return Promise.resolve(true)
      },
      invalidate: invalidated,
    })
    const first = service.installPage(
      sessionId,
      {
        events: [message(10, 'Compacted answer')],
        hasMore: false,
        projection: { asOfSequence: 12, values: {} },
      },
      service.begin(sessionId),
    )
    const replay = [
      { type: 'turn.started', sessionId, turn: 1, sequence: 2, replayed: true },
      {
        type: 'message.delta',
        sessionId,
        messageId: 'm-10',
        delta: 'Original chunk',
        sequence: 4,
        replayed: true,
      },
      { type: 'turn.ended', sessionId, turn: 1, reason: 'completed', sequence: 12, replayed: true },
    ] as const
    for (const event of replay) {
      service.accept(event)
      expect(isTranscriptOnlyEvent(event)).toBe(true)
    }
    await Promise.resolve()
    expect(invalidated).not.toHaveBeenCalled()
    expect(posted).toHaveLength(0)
    service.accept({
      type: 'message.delta',
      sessionId,
      messageId: 'live',
      delta: 'Next answer',
      sequence: 13,
    })
    await Promise.resolve()
    expect(posted.at(-1)?.nodes[0]).toEqual(first.nodes[0])
    expect(posted.at(-1)?.nodes.at(-1)).toMatchObject({ markdown: 'Next answer' })
    expect(
      isTranscriptOnlyEvent({ type: 'turn.ended', sessionId, turn: 2, reason: 'completed', sequence: 14 }),
    ).toBe(false)
    service.dispose()
  })

  it('sends sanitized text suffixes and publishes terminal metadata without resending history facts per token', async () => {
    const sent: (TranscriptWindow | TranscriptPatch)[] = []
    const publicValue = vi.fn(
      (value: unknown) =>
        JSON.parse(JSON.stringify(value).replaceAll('fixture-secret', '[redacted]')) as unknown,
    )
    const service = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue,
      post: (value) => {
        sent.push(value)
        return Promise.resolve(true)
      },
      postPatch: (value) => {
        sent.push(value)
        return Promise.resolve(true)
      },
    })
    service.installPage(sessionId, { events: [message(0)], hasMore: false }, service.begin(sessionId))
    service.accept({ type: 'turn.started', sessionId, turn: 1, sequence: 1 })
    await Promise.resolve()
    service.accept({
      type: 'message.delta',
      sessionId,
      messageId: 'live',
      delta: 'prefix '.repeat(400),
      turn: 1,
      step: 1,
    })
    await Promise.resolve()
    publicValue.mockClear()
    service.accept({
      type: 'message.delta',
      sessionId,
      messageId: 'live',
      delta: 'fixture-secret suffix',
      turn: 1,
      step: 1,
    })
    await Promise.resolve()
    const patch = sent.at(-1) as TranscriptPatch
    expect(patch.textUpdates?.[0]).toMatchObject({
      markdownLength: 2800,
      node: { markdown: '[redacted] suffix' },
    })
    expect(patch).not.toHaveProperty('metadata')
    expect(publicValue.mock.calls[0]?.[0]).not.toHaveProperty('eventFacts')
    expect(JSON.stringify(patch)).not.toContain('fixture-secret')
    service.accept({ type: 'turn.ended', sessionId, turn: 1, reason: 'completed', sequence: 2 })
    await Promise.resolve()
    const terminal = sent.at(-1) as TranscriptPatch
    expect(terminal.metadata).toHaveProperty('lastSequence', 2)
    expect(terminal.metadata).not.toHaveProperty('activeTurn')
    service.dispose()
  })
  it('never substitutes raw append text for an equally long sanitized suffix', async () => {
    const sent: (TranscriptWindow | TranscriptPatch)[] = []
    const service = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value) =>
        JSON.parse(JSON.stringify(value).replaceAll('fixture-secret', 'xxxxxxxxxxxxxx')) as unknown,
      post: (value) => {
        sent.push(value)
        return Promise.resolve(true)
      },
      postPatch: (value) => {
        sent.push(value)
        return Promise.resolve(true)
      },
    })
    try {
      service.installPage(sessionId, { events: [message(0)], hasMore: false }, service.begin(sessionId))
      service.accept({ type: 'message.delta', sessionId, messageId: 'live', delta: 'x'.repeat(300) })
      await Promise.resolve()
      service.accept({ type: 'message.delta', sessionId, messageId: 'live', delta: 'fixture-secret' })
      await Promise.resolve()
      expect((sent.at(-1) as TranscriptPatch).textUpdates?.[0]?.node.markdown).toBe('xxxxxxxxxxxxxx')
      expect(JSON.stringify(sent)).not.toContain('fixture-secret')
    } finally {
      service.dispose()
    }
  })

  it('publishes current durable facts even when the stream pauses before 32 events', async () => {
    const sent: (TranscriptWindow | TranscriptPatch)[] = []
    const service = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value) => value,
      post: (value) => {
        sent.push(value)
        return Promise.resolve(true)
      },
      postPatch: (value) => {
        sent.push(value)
        return Promise.resolve(true)
      },
    })
    try {
      service.installPage(sessionId, { events: [message(0)], hasMore: false }, service.begin(sessionId))
      for (let sequence = 1; sequence <= 3; sequence++) {
        service.accept({
          type: 'message.delta',
          sessionId,
          messageId: 'live',
          delta: 'x'.repeat(300),
          sequence,
        })
        await Promise.resolve()
      }
      const patch = sent.at(-1) as TranscriptPatch
      expect(patch.metadata?.eventFacts.at(-1)?.sequence).toBe(3)
    } finally {
      service.dispose()
    }
  })

  it('carries completion state for a long streamed node in an empty text update', async () => {
    const sent: (TranscriptWindow | TranscriptPatch)[] = []
    const service = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value) => value,
      post: (value) => {
        sent.push(value)
        return Promise.resolve(true)
      },
      postPatch: (value) => {
        sent.push(value)
        return Promise.resolve(true)
      },
    })
    service.installPage(sessionId, { events: [message(0)], hasMore: false }, service.begin(sessionId))
    const text = 'x'.repeat(300)
    service.accept({ type: 'message.delta', sessionId, messageId: 'live', delta: text, turn: 1, step: 1 })
    await Promise.resolve()
    expect(sent[0]).toHaveProperty('eventFacts')

    service.accept({
      type: 'message.completed',
      sessionId,
      messageId: 'live',
      markdown: text,
      turn: 1,
      step: 1,
      sequence: 2,
    })
    await Promise.resolve()
    const patch = sent.at(-1) as TranscriptPatch
    const update = patch.textUpdates?.find((entry) => entry.node.id === 'live')
    expect(update).toBeDefined()
    // The markdown did not grow, so the node travels as an empty append. Every
    // other field is still a complete replacement; the Webview merges the
    // acknowledged prefix with this suffix, which is how `streaming` clears.
    expect(update?.markdownLength).toBe(text.length)
    expect(update?.node).toMatchObject({ streaming: false, markdown: '' })
    service.dispose()
  })

  it('retries the newest window after a failed delivery instead of dropping it', async () => {
    vi.useFakeTimers()
    const sent: (TranscriptWindow | TranscriptPatch)[] = []
    const report = vi.fn()
    const invalidate = vi.fn()
    let failNextPatch = false
    const service = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value) => value,
      post: (value) => {
        sent.push(value)
        return Promise.resolve(true)
      },
      postPatch: (value) => {
        sent.push(value)
        if (failNextPatch) {
          failNextPatch = false
          return Promise.resolve(false)
        }
        return Promise.resolve(true)
      },
      report,
      invalidate,
    })
    service.installPage(sessionId, { events: [message(0)], hasMore: false }, service.begin(sessionId))
    service.accept({ type: 'turn.started', sessionId, turn: 1, sequence: 1 })
    await Promise.resolve()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toHaveProperty('eventFacts')

    failNextPatch = true
    service.accept({ type: 'message.delta', sessionId, messageId: 'live', delta: 'x', turn: 1, step: 1 })
    await Promise.resolve()
    expect(sent).toHaveLength(3)
    expect(sent[1]).toHaveProperty('baseRevision')
    expect(report).toHaveBeenCalledWith({ attempt: 1, retrying: true })
    await Promise.resolve()
    expect(sent).toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)
    // The failed patch invalidated the renderer baseline, so the retry must be
    // a full window that carries the newest text.
    expect(sent[2]).toHaveProperty('eventFacts')
    expect((sent[2] as TranscriptWindow).nodes.at(-1)).toMatchObject({ markdown: 'x' })
    expect(invalidate).not.toHaveBeenCalled()
    service.dispose()
  })

  it('reports a permanently lost delivery and asks for a reread after bounded retries', async () => {
    vi.useFakeTimers()
    const sent: (TranscriptWindow | TranscriptPatch)[] = []
    const report = vi.fn()
    const invalidate = vi.fn()
    let fullPosts = 0
    const service = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value) => value,
      post: (value) => {
        sent.push(value)
        fullPosts += 1
        return Promise.resolve(fullPosts === 1)
      },
      postPatch: (value) => {
        sent.push(value)
        return Promise.resolve(false)
      },
      report,
      invalidate,
    })
    service.installPage(sessionId, { events: [message(0)], hasMore: false }, service.begin(sessionId))
    service.accept({ type: 'turn.started', sessionId, turn: 1, sequence: 1 })
    await Promise.resolve()
    service.accept({ type: 'message.delta', sessionId, messageId: 'live', delta: 'x', turn: 1, step: 1 })
    await Promise.resolve()
    for (let index = 0; index < 8; index++) await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)

    expect(report.mock.calls).toEqual([
      [{ attempt: 1, retrying: true }],
      [{ attempt: 2, retrying: true }],
      [{ attempt: 3, retrying: true }],
      [{ attempt: 4, retrying: false }],
    ])
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(sessionId)
    const delivered = sent.length
    await vi.advanceTimersByTimeAsync(4_000)
    expect(sent).toHaveLength(delivered)
    service.dispose()
  })

  it('sends immediately without advancing time and coalesces only after bounded credits are exhausted', async () => {
    vi.useFakeTimers()
    const sent: (TranscriptWindow | TranscriptPatch)[] = []
    const service = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value) => value,
      post: (value) => {
        sent.push(value)
        return Promise.resolve(true)
      },
      postPatch: (value) => {
        sent.push(value)
        return Promise.resolve(true)
      },
    })
    service.installPage(sessionId, { events: [message(1)], hasMore: false }, service.begin(sessionId))
    for (let index = 0; index < 68; index++) {
      service.accept({
        type: 'message.delta',
        sessionId,
        messageId: 'live',
        delta: String(index) + ',',
        turn: 1,
        step: 1,
      })
      expect(sent).toHaveLength(Math.min(index + 1, 64))
      await Promise.resolve()
    }
    expect(sent).toHaveLength(64)
    expect('changedNodes' in sent[1]!).toBe(true)
    service.acknowledge('wrong-session', sent[63]!.revision)
    await vi.advanceTimersByTimeAsync(100)
    expect(sent).toHaveLength(64)
    service.acknowledge(sessionId, sent[63]!.revision)
    expect(sent).toHaveLength(65)
    const latest = sent[64]!
    expect('changedNodes' in latest && latest.changedNodes.at(-1)).toMatchObject({
      markdown: Array.from({ length: 68 }, (_, i) => `${i},`).join(''),
    })
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds outstanding streaming bytes as well as frame count', async () => {
    vi.useFakeTimers()
    const sent: (TranscriptWindow | TranscriptPatch)[] = []
    const service = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value) => value,
      post: (value) => {
        sent.push(value)
        return Promise.resolve(true)
      },
      postPatch: (value) => {
        sent.push(value)
        return Promise.resolve(true)
      },
    })
    service.installPage(
      sessionId,
      { events: Array.from({ length: 80 }, (_, i) => message(i, 'x'.repeat(4000))), hasMore: false },
      service.begin(sessionId),
    )
    for (let index = 0; index < 12; index++) {
      service.accept({
        type: 'message.delta',
        sessionId,
        messageId: 'live',
        delta: 'word '.repeat(5000) + String(index),
        turn: 1,
        step: 1,
      })
      await vi.advanceTimersByTimeAsync(16)
    }
    expect(sent.length).toBeGreaterThan(1)
    expect(sent.length).toBeLessThan(8)
    expect(sent.reduce((total, value) => total + JSON.stringify(value).length, 0)).toBeLessThanOrEqual(
      TRANSCRIPT_MAX_CHARS,
    )
    service.acknowledge(sessionId, sent.at(-1)!.revision)
    await vi.advanceTimersByTimeAsync(16)
    const live = sent
      .flatMap((value) =>
        'changedNodes' in value
          ? [...value.changedNodes, ...(value.textUpdates?.map((entry) => entry.node) ?? [])]
          : [],
      )
      .find((entry) => entry.kind === 'assistant-message')
    // The live answer is still delivered after the byte budget releases; the
    // representation may be a clipped prefix or a suffix, not necessarily a tail.
    expect(live).toBeDefined()
    service.dispose()
  })

  it('keeps a streamed patch proportional to the changed node, not to the window', async () => {
    const sent: (TranscriptWindow | TranscriptPatch)[] = []
    const service = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value) => value,
      post: (value) => {
        sent.push(value)
        return Promise.resolve(true)
      },
      postPatch: (value) => {
        sent.push(value)
        return Promise.resolve(true)
      },
    })
    service.installPage(
      sessionId,
      { events: Array.from({ length: 800 }, (_, i) => message(i, `Answer ${String(i)} `)), hasMore: false },
      service.begin(sessionId),
    )
    sent.length = 0
    for (let index = 0; index < 5; index++) {
      service.accept({
        type: 'message.delta',
        sessionId,
        messageId: 'assistant:9:1',
        delta: 'token ',
        turn: 9,
        step: 1,
        transientSequence: index + 1,
        transientAttemptId: 'a1',
        transientIndex: index,
      })
      await Promise.resolve()
    }
    const patches = sent.filter((value): value is TranscriptPatch => 'changedNodes' in value)
    expect(patches.length).toBeGreaterThan(0)
    for (const patch of patches) {
      // The node-id list and event facts stay in the renderer: re-sending them
      // per token made a revision cost O(window) bytes and visibly stuttered.
      expect(patch.changedNodes).toHaveLength(1)
      expect(JSON.stringify(patch).length).toBeLessThan(2_048)
    }
    service.dispose()
  })

  it('keeps legacy current Todos independent of historical pages and stops deriving them once DSH provides the projection', async () => {
    const current = [{ id: 'current', content: 'Current task', status: 'in-progress' as const }]
    const old = [{ id: 'old', content: 'Old task', status: 'completed' as const }]
    const f = fixture()
    f.read.mockResolvedValue({
      events: [row(1, { type: 'todo.updated', sessionId, todos: old, sequence: 1 })],
      hasMore: false,
    })
    const view = f.service.installPage(
      sessionId,
      {
        events: [row(10, { type: 'todo.updated', sessionId, todos: current, sequence: 10 })],
        hasMore: true,
        beforeSequence: 10,
      },
      f.service.begin(sessionId),
    )
    expect(view.currentTodos).toEqual(current)
    const historical = await f.service.navigate(
      sessionId,
      'older',
      view.revision,
      new AbortController().signal,
    )
    expect(historical.nodes).toContainEqual(expect.objectContaining({ kind: 'todo', todos: current }))
    expect(historical.currentTodos).toEqual(current)
    f.service.accept({ type: 'session.projection', sessionId, key: 'todoList', value: null, sequence: 20 })
    expect(f.service.accept({ type: 'todo.updated', sessionId, todos: current, sequence: 21 })).toBe(true)
    const latest = await f.service.navigate(
      sessionId,
      'latest',
      historical.revision,
      new AbortController().signal,
    )
    expect(latest).not.toHaveProperty('currentTodos')
    f.service.dispose()
  })

  it('retains gap notices without a second backfill engine and retires them only on authoritative coverage', () => {
    const f = fixture()
    f.open([message(1)])
    f.service.accept({ type: 'session.gap', sessionId, fromSequence: 3, toSequence: 5 })
    expect(f.read).not.toHaveBeenCalled()
    const reopen = (covered = false): TranscriptWindow =>
      f.service.installPage(
        sessionId,
        {
          events: [message(10)],
          hasMore: false,
          ...(covered ? { coveredSequenceRanges: [{ from: 1, to: 10 }] } : {}),
        },
        f.service.begin(sessionId),
      )
    expect(reopen().nodes).toContainEqual(expect.objectContaining({ id: `gap:${sessionId}:3:5` }))
    expect(reopen(true).nodes.some((node) => node.id.startsWith('gap:'))).toBe(false)
    expect(reopen().nodes.some((node) => node.id.startsWith('gap:'))).toBe(false)
    f.service.dispose()
  })
  it('keeps a bounded parent closure for a long PTC turn without using its context row as the older-page cursor', () => {
    const client = fixture()
    const parent: BackendEvent = {
      type: 'tool.updated',
      sessionId,
      sequence: 1,
      tool: {
        id: 'parent',
        name: 'code',
        category: 'execute',
        title: 'Execute code',
        status: 'running',
        inputSummary: 'Structured call',
        metadata: {},
      },
    }
    const children = Array.from({ length: 1000 }, (_, index) =>
      row(index + 2, {
        type: 'tool.updated',
        sessionId,
        sequence: index + 2,
        tool: {
          id: `child-${index}`,
          parentCallId: 'parent',
          name: 'read',
          category: 'read',
          title: 'Read',
          status: 'completed',
          outputSummary: 'Result',
          metadata: {},
        },
      }),
    )
    const window = client.open([row(1, parent), ...children])
    expect(window.nodes.length).toBeLessThanOrEqual(256)
    expect(window.nodes.some((node) => node.kind === 'tool' && node.id === 'parent')).toBe(true)
    expect(window.beforeSequence).toBeGreaterThan(1)
    client.service.dispose()
  })
  it('uses authoritative workingDirectory to qualify relative file models inside the authorized roots', () => {
    const root = path.resolve('synthetic-transcript-root')
    const service = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      post: () => Promise.resolve(true),
      publicValue: (value, cwd) => sanitizePublicValue(value, undefined, [root], cwd),
    })
    const event: BackendEvent = {
      type: 'deliverables.presented',
      sessionId,
      sequence: 1,
      turn: 1,
      callId: 'present',
      files: [{ path: 'result.txt' }],
    }
    const window = service.installPage(
      sessionId,
      {
        events: [row(1, event)],
        hasMore: false,
        projection: { asOfSequence: 1, values: { workingDirectory: path.join(root, 'child') } },
      },
      service.begin(sessionId),
    )
    expect(window.nodes[0]).toMatchObject({ kind: 'deliverables', files: [{ path: 'child/result.txt' }] })
    expect(JSON.stringify(window)).not.toContain(root)
    service.dispose()
  })
  it('keeps distinct Host notices across session switches and restores their anchors', async () => {
    const client = fixture()
    client.open([message(1)])
    client.service.accept({ type: 'notice', sessionId, level: 'info', text: 'First notice' })
    client.service.accept({ type: 'notice', sessionId, level: 'warning', text: 'Second notice' })
    const other = client.service.begin('other')
    client.service.installPage('other', { events: [], hasMore: false }, other)
    const restored = client.open([message(1), message(2)])
    const notices = restored.nodes.filter((node) => node.kind === 'notice')
    expect(notices).toHaveLength(2)
    expect(new Set(notices.map((node) => node.id)).size).toBe(2)
    expect(restored.nodes.map((node) => node.id)).toEqual(['m-1', ...notices.map((node) => node.id), 'm-2'])
    expect(
      await client.service.content(
        sessionId,
        notices[0]!.id,
        restored.revision,
        new AbortController().signal,
      ),
    ).toBe('First notice')
    client.service.dispose()
  })
  it.each([false, true])(
    'keeps mode acknowledgements out of opening, replayed and reopened transcripts, buffered=%s',
    async (buffered) => {
      const client = fixture()
      const generation = buffered ? client.service.begin(sessionId) : undefined
      const events: SessionHistoryEvent[] = []
      // Pinned rc.3 command/done has commandId/kind/text, but no command name.
      for (const [index, commandName] of ['permission', 'plan', 'permission'].entries()) {
        const commandId = `mode-${index}`
        const run = row(index * 2, {
          type: 'notice',
          sessionId,
          sequence: index * 2,
          level: 'info',
          text: `${commandName} started.`,
          commandId,
          commandName,
          commandPhase: 'run',
          commandInput: `/${commandName}`,
        })
        const done = row(index * 2 + 1, {
          type: 'notice',
          sessionId,
          sequence: index * 2 + 1,
          level: 'info',
          text: 'Mode applied.',
          commandId,
          commandPhase: 'done',
        })
        events.push(run, done)
        client.service.accept(run.event)
        client.service.accept(done.event)
      }
      const window = client.service.installPage(
        sessionId,
        { events, hasMore: false },
        generation ?? client.service.begin(sessionId),
      )
      expect(window.nodes).toEqual([])
      for (const entry of events) client.service.accept(entry.event)
      client.service.setVisible(true)
      await vi.waitFor(() => expect(client.posted.at(-1)?.nodes).toEqual([]))
      expect(client.open(events).nodes).toEqual([])
      client.service.dispose()
    },
  )

  it.each([false, true])(
    'preserves ordinary output and mode failures exactly once, buffered=%s',
    (buffered) => {
      const client = fixture()
      const generation = buffered ? client.service.begin(sessionId) : undefined
      const events: SessionHistoryEvent[] = []
      for (const [index, commandName] of ['help', 'permission'].entries()) {
        const commandId = `command-${index}`
        const run: BackendEvent = {
          type: 'notice',
          sessionId,
          sequence: index * 2,
          level: 'info',
          text: `${commandName} started.`,
          commandName,
          commandId,
          commandPhase: 'run',
        }
        const done: BackendEvent = {
          type: 'notice',
          sessionId,
          sequence: index * 2 + 1,
          level: index === 0 ? 'info' : 'error',
          text: index === 0 ? 'Command help' : 'Permission update failed',
          commandId,
          commandPhase: 'done',
        }
        events.push(row(index * 2, run), row(index * 2 + 1, done))
        client.service.accept(run)
        client.service.accept(done)
      }
      const window = client.service.installPage(
        sessionId,
        { events, hasMore: false },
        generation ?? client.service.begin(sessionId),
      )
      expect(window.nodes).toHaveLength(2)
      expect(window.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'notice', level: 'info', text: 'Command help' }),
          expect.objectContaining({ kind: 'notice', level: 'error', text: 'Permission update failed' }),
        ]),
      )
      expect(client.open(events).nodes).toHaveLength(2)
      client.service.dispose()
    },
  )
  it('retains named Host command receipts without caching orphan mode acknowledgements', () => {
    const client = fixture()
    client.service.accept({
      type: 'notice',
      sessionId,
      level: 'info',
      text: 'Permission started.',
      commandId: 'host-mode',
      commandName: 'permission',
      commandPhase: 'run',
    })
    client.service.accept({
      type: 'notice',
      sessionId,
      level: 'info',
      text: 'Mode applied.',
      commandId: 'host-mode',
      commandPhase: 'done',
    })
    client.service.accept({
      type: 'notice',
      sessionId,
      level: 'info',
      text: 'Command finished.',
      commandName: 'compact',
      commandPhase: 'done',
      commandInput: '/compact',
    })
    for (let attempt = 0; attempt < 2; attempt++) {
      const window = client.open()
      expect(window.nodes).toHaveLength(2)
      expect(window.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'command-input', text: '/compact' }),
          expect.objectContaining({ kind: 'notice', text: 'Command finished.' }),
        ]),
      )
    }
    client.service.dispose()
  })
  it('retires prefixes already settled by the opening cut and preserves a newer retry attempt', () => {
    const client = fixture()
    const generation = client.service.begin(sessionId)
    client.service.accept({
      type: 'message.delta',
      sessionId,
      messageId: 'transient',
      delta: 'old prefix',
      turn: 1,
      step: 1,
      transientAttemptId: 'old',
      transientIndex: 0,
      transientStartedAfterSequence: 9,
    })
    const final = row(11, {
      type: 'message.completed',
      sessionId,
      messageId: 'durable',
      markdown: 'Complete response',
      turn: 1,
      step: 1,
      sequence: 11,
    })
    const window = client.service.installPage(sessionId, { events: [final], hasMore: false }, generation)
    expect(window.nodes).toHaveLength(1)
    expect(window.nodes[0]).toMatchObject({ id: 'durable', markdown: 'Complete response', streaming: false })
    const retry = client.service.begin(sessionId)
    client.service.accept({
      type: 'message.delta',
      sessionId,
      messageId: 'retry',
      delta: 'new attempt',
      turn: 1,
      step: 1,
      transientAttemptId: 'new',
      transientIndex: 0,
      transientStartedAfterSequence: 11,
    })
    const next = client.service.installPage(sessionId, { events: [final], hasMore: false }, retry)
    expect(next.nodes).toContainEqual(expect.objectContaining({ markdown: 'Complete response' }))
    expect(next.nodes).toContainEqual(expect.objectContaining({ markdown: 'new attempt', streaming: true }))
    client.service.dispose()
  })
  it('keeps terminal render intent after removing host-only cwd and degrades an out-of-scope read card alone', () => {
    const client = fixture()
    const terminal: BackendEvent = {
      type: 'tool.updated',
      sessionId,
      sequence: 1,
      tool: {
        id: 'shell',
        name: 'bash',
        category: 'execute',
        title: 'Run',
        status: 'running',
        metadata: {},
        presentation: { phase: 'call', card: 'terminal', title: 'Run', cwd: 'C:\\fixture\\private' },
      },
    }
    const outside: BackendEvent = {
      type: 'tool.updated',
      sessionId,
      sequence: 2,
      tool: {
        id: 'outside',
        name: 'read',
        category: 'read',
        title: 'Read',
        status: 'completed',
        metadata: {},
        presentation: {
          phase: 'result',
          card: 'read',
          path: 'C:\\other\\private.txt',
          offset: 0,
          lines: [{ number: 1, text: 'Visible result' }],
          totalLines: 1,
        },
      },
    }
    const window = client.open([row(1, terminal), row(2, outside)])
    expect(window.nodes[0]).toMatchObject({ kind: 'tool', tool: { presentation: { card: 'terminal' } } })
    expect(JSON.stringify(window)).not.toContain('private')
    expect(window.nodes[1]).toMatchObject({ kind: 'tool', tool: { status: 'completed' } })
    expect(window.omittedNodeIds).toEqual(['outside'])
    const complete = client.service.fullNode(
      sessionId,
      'outside',
      window.revision,
      new AbortController().signal,
    )
    expect(complete).toMatchObject({ kind: 'tool', tool: { presentation: { card: 'generic' } } })
    expect(JSON.stringify(complete)).toContain('Visible result')
    expect(JSON.stringify(complete)).not.toContain('private.txt')
    client.service.dispose()
  })

  it('keeps a long conversation message instead of collapsing it to the historical preview limit', () => {
    const { service, open } = fixture()
    const text = `BEGIN-${'a'.repeat(6_000)}-END`
    const window = open([message(1, text)])
    const node = window.nodes[0]
    expect(node).toMatchObject({ kind: 'assistant-message', id: 'm-1' })
    if (node?.kind !== 'assistant-message') throw new Error('Expected an assistant message.')
    expect(node.markdown).toBe(text)
    expect(window.omittedNodeIds).toEqual([])
    service.dispose()
  })

  it('bounds only transport and retains an oversized message in full', () => {
    const { service, open } = fixture()
    const text = `BEGIN-${'b'.repeat(TRANSCRIPT_MAX_CHARS + 1024)}-END`
    const window = open([message(1, text)])
    const node = window.nodes[0]
    if (node?.kind !== 'assistant-message') throw new Error('Expected an assistant message.')
    expect(node.markdown.length).toBeGreaterThan(4_096)
    expect(node.markdown.length).toBeLessThan(text.length)
    expect(node.markdown.startsWith('BEGIN-')).toBe(true)
    expect(window.omittedNodeIds).toEqual(['m-1'])
    expect(service.fullNode(sessionId, 'm-1', window.revision, new AbortController().signal)).toMatchObject({
      markdown: text,
    })
    service.dispose()
  })

  it('invalidates a published view once after Adapter recovery instead of maintaining a second gap-healing journal', () => {
    const invalidations: string[] = []
    const service = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value) => value,
      post: () => Promise.resolve(true),
      invalidate: (id) => {
        invalidations.push(id)
      },
    })
    service.installPage(
      sessionId,
      { events: [message(1), message(10)], hasMore: true, beforeSequence: 1 },
      service.begin(sessionId),
    )
    service.accept(message(1).event)
    expect(invalidations).toEqual([])
    service.accept(message(5, 'Recovered').event)
    service.accept(message(6, 'Recovered again').event)
    expect(invalidations).toEqual([sessionId])
    const refreshed = service.installPage(
      sessionId,
      {
        events: [message(1), message(5, 'Recovered'), message(6, 'Recovered again'), message(10)],
        hasMore: false,
      },
      service.begin(sessionId),
    )
    expect(refreshed.nodes).toHaveLength(4)
    expect(refreshed.nodes[1]).toMatchObject({ markdown: 'Recovered' })
    service.dispose()
  })
  for (const count of [TRANSCRIPT_MAX_NODES + 1, 10_000])
    it(
      `bounds ${count} loaded nodes without exposing reducer bookkeeping`,
      { tags: count > TRANSCRIPT_MAX_NODES + 1 ? ['stress'] : [], timeout: 15_000 },
      () => {
        const client = fixture()
        const events = Array.from({ length: count }, (_, index) => message(index + 1))
        const window = client.open(events)
        expect(window.nodes.length).toBeLessThanOrEqual(TRANSCRIPT_MAX_NODES)
        expect(JSON.stringify(window).length).toBeLessThanOrEqual(TRANSCRIPT_MAX_CHARS)
        expect(window.nodes.at(-1)).toMatchObject({ markdown: `Answer ${count}` })
        expect(window).not.toHaveProperty('closedTurns')
        expect(window).not.toHaveProperty('history')
        expect(window.hasMore).toBe(true)
        expect(window.beforeSequence).toBeGreaterThan(1)
        client.service.dispose()
      },
    )

  for (const repeats of [1_200, 100_000])
    it(
      `previews oversized tool results (${repeats} repeats) and rereads authorized content`,
      { tags: repeats > 1_200 ? ['stress'] : [] },
      async () => {
        const text = 'Result content '.repeat(repeats)
        const event: BackendEvent = {
          type: 'tool.updated',
          sessionId,
          sequence: 9,
          tool: {
            id: 'call',
            name: 'read',
            category: 'read',
            title: 'Read',
            status: 'completed',
            outputSummary: text,
            metadata: { apiKey: 'fixture-secret' },
          },
        }
        const client = fixture(vi.fn().mockResolvedValue({ events: [row(9, event)], hasMore: false }))
        const window = client.open([row(9, event)])
        expect(window.omittedNodeIds).toEqual(['call'])
        expect(JSON.stringify(window)).not.toContain('fixture-secret')
        expect(JSON.stringify(window).length).toBeLessThan(20_000)
        const full = await client.service.content(
          sessionId,
          'call',
          window.revision,
          new AbortController().signal,
        )
        expect(full).toContain(text)
        expect(full).not.toContain('fixture-secret')
        expect(client.read).not.toHaveBeenCalled()
        client.service.dispose()
      },
    )

  it('keeps distinct same-sequence mappings and ignores exact baseline replays', async () => {
    vi.useFakeTimers()
    const client = fixture()
    const first = message(2, 'First')
    client.open([first])
    client.service.accept(first.event)
    client.service.accept({
      type: 'message.completed',
      sessionId,
      sequence: 2,
      messageId: 'other',
      markdown: 'Second',
    })
    await vi.advanceTimersByTimeAsync(32)
    expect(client.posted[0]?.nodes).toHaveLength(2)
    expect(client.posted[0]?.nodes.map((node) => node.id)).toEqual(['m-2', 'other'])
    client.service.dispose()
  })

  it('prepends older history without replacing recent messages and keeps the expanded view live', async () => {
    const older = [
      ...Array.from({ length: 100 }, (_, index) => message(index + 1)),
      message(200, 'Outdated overlap'),
    ]
    const client = fixture(vi.fn().mockResolvedValue({ events: older, hasMore: false, beforeSequence: 0 }))
    const initial = client.open([message(200)])
    const historical = await client.service.navigate(
      sessionId,
      'older',
      initial.revision,
      new AbortController().signal,
    )
    expect(historical.historical).toBe(false)
    expect(historical.nodes).toContainEqual(expect.objectContaining({ id: 'm-200' }))
    expect(historical.nodes).toHaveLength(101)
    expect(historical.nodes.at(-1)).toMatchObject({ id: 'm-200', markdown: 'Answer 200' })
    client.service.accept(message(201, 'Live final reply').event)
    const latest = await client.service.navigate(
      sessionId,
      'latest',
      historical.revision,
      new AbortController().signal,
    )
    expect(latest.historical).toBe(false)
    expect(latest.nodes.at(-1)).toMatchObject({ markdown: 'Live final reply', streaming: false })
    expect(latest.nodes[0]?.id).toBe('m-1')
    client.service.dispose()
  })

  it('sends one unacknowledged window and pauses while hidden, then publishes the latest snapshot', async () => {
    vi.useFakeTimers()
    const client = fixture()
    client.open()
    client.service.accept(message(1).event)
    await vi.advanceTimersByTimeAsync(32)
    expect(client.posted).toHaveLength(1)
    for (let seq = 2; seq <= 1000; seq++) client.service.accept(message(seq).event)
    await vi.advanceTimersByTimeAsync(1000)
    expect(client.posted).toHaveLength(1)
    client.service.acknowledge(sessionId, client.posted[0]!.revision)
    await vi.advanceTimersByTimeAsync(32)
    expect(client.posted).toHaveLength(2)
    expect(client.posted[1]?.nodes.at(-1)).toMatchObject({ markdown: 'Answer 1000' })
    client.service.setVisible(false)
    client.service.accept(message(1001).event)
    await vi.advanceTimersByTimeAsync(1000)
    expect(client.posted).toHaveLength(2)
    client.service.setVisible(true)
    await vi.advanceTimersByTimeAsync(32)
    expect(client.posted[2]?.nodes.at(-1)).toMatchObject({ markdown: 'Answer 1001' })
    client.service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('invalidates stale and overflowing opens, cancels reads, and keeps lifecycle events available to watchers', async () => {
    const client = fixture()
    const stale = client.service.begin('other')
    const current = client.service.begin(sessionId)
    expect(() => client.service.installPage('other', { events: [], hasMore: false }, stale)).toThrow()
    for (let seq = 1; seq <= 300; seq++) client.service.accept(message(seq).event)
    expect(client.service.needsRefresh(current)).toBe(true)
    expect(() => client.service.installPage(sessionId, { events: [], hasMore: false }, current)).toThrow()
    client.service.restart(current)
    const window = client.service.installPage(sessionId, { events: [], hasMore: false }, current)
    expect(client.service.accept({ type: 'turn.started', sessionId, turn: 1, sequence: 1 })).toBe(false)
    expect(
      client.service.accept({ type: 'turn.ended', sessionId, turn: 1, reason: 'completed', sequence: 2 }),
    ).toBe(false)
    const abort = new AbortController()
    abort.abort()
    await expect(client.service.navigate(sessionId, 'older', window.revision, abort.signal)).rejects.toThrow()
    expect(
      transcriptWindowSchema.safeParse({
        ...window,
        nodes: [{ kind: 'notice', id: 'n', text: 'Bad', level: 'info', secret: 'bad' }],
      }).success,
    ).toBe(false)
    client.service.dispose()
  })
})
