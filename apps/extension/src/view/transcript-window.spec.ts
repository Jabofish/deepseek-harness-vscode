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
    await Promise.resolve()
    client.service.acknowledge(sessionId, client.posted.at(-1)!.revision)
    await vi.waitFor(() => expect(client.posted.at(-1)?.omittedNodeIds).toContain('m-2'))
    const window = client.posted.at(-1)!
    expect(
      await client.service.content(sessionId, 'm-2', window.revision, new AbortController().signal),
    ).toBe(full)
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

  it('bounds the retry rate for a permanently refused renderer without restarting the burst on rereads', async () => {
    vi.useFakeTimers()
    const sent: (TranscriptWindow | TranscriptPatch)[] = []
    const report = vi.fn()
    const invalidate = vi.fn()
    const read = vi.fn(() => Promise.resolve({ events: [], hasMore: false }))
    let fullPosts = 0
    const service = new TranscriptWindowService({
      read,
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
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ retrying: false })),
    )
    expect(invalidate).toHaveBeenCalledWith(sessionId)
    const immediate = sent.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sent).toHaveLength(immediate + 3)
    expect(report).toHaveBeenLastCalledWith({ attempt: 7, retrying: false })
    const delivered = sent.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(sent).toHaveLength(delivered + 12)
    expect(invalidate).toHaveBeenCalledTimes(1)
    const beforeReread = sent.length
    await service.resync(sessionId, new AbortController().signal)
    service.accept({
      type: 'message.delta',
      sessionId,
      messageId: 'live',
      delta: ' after reread',
      turn: 1,
      step: 1,
    })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(sent).toHaveLength(beforeReread + 3)
    expect(read).not.toHaveBeenCalled()
    service.dispose()
  })

  it.each(['hidden', 'switched', 'disposed'] as const)(
    'releases delayed delivery recovery when the surface is %s',
    async (action) => {
      vi.useFakeTimers()
      const post = vi.fn(() => Promise.resolve(false))
      const service = new TranscriptWindowService({
        read: () => Promise.resolve({ events: [], hasMore: false }),
        publicValue: (value) => value,
        post,
      })
      service.installPage(sessionId, { events: [], hasMore: false }, service.begin(sessionId))
      service.accept(message(0).event)
      for (let index = 0; index < 20; index++) await Promise.resolve()
      expect(post).toHaveBeenCalledTimes(4)
      if (action === 'hidden') service.setVisible(false)
      else if (action === 'switched') service.begin('another-session')
      else service.dispose()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(post).toHaveBeenCalledTimes(4)
      service.dispose()
    },
  )

  it.each(['reopen', 'latest', 'resync rebase', 'visibility rebase'] as const)(
    'restores delivery through %s after a refused renderer also loses invalidation',
    async (route) => {
      vi.useFakeTimers()
      let available = false
      const delivered: TranscriptWindow[] = []
      const page = { events: [message(0), message(1), message(2)], hasMore: false }
      const read = vi.fn(() => Promise.resolve(page))
      const invalidate = vi.fn()
      const service: TranscriptWindowService = new TranscriptWindowService({
        read,
        publicValue: (value) => value,
        invalidate,
        post: (window) => {
          if (available) {
            delivered.push(window)
            service.acknowledge(window.sessionId, window.revision)
          }
          return Promise.resolve(available)
        },
      })
      try {
        const initial = service.installPage(
          sessionId,
          { events: [], hasMore: false },
          service.begin(sessionId),
        )
        service.accept(message(0).event)
        await vi.advanceTimersByTimeAsync(5_000)
        expect(invalidate).toHaveBeenCalledTimes(1)
        available = true
        if (route === 'reopen') service.installPage(sessionId, page, service.begin(sessionId))
        else if (route === 'latest')
          await service.navigate(sessionId, 'latest', initial.revision + 1, new AbortController().signal)
        else {
          service.accept(message(2).event)
          service.accept(message(1).event)
          if (route === 'visibility rebase') {
            service.setVisible(false)
            service.setVisible(true)
            expect(invalidate).toHaveBeenCalledTimes(2)
          }
          await service.resync(sessionId, new AbortController().signal)
          expect(read).toHaveBeenCalledTimes(1)
        }
        service.accept(message(3).event)
        await vi.advanceTimersByTimeAsync(15_000)
        expect(delivered.at(-1)?.nodes.at(-1)).toMatchObject({ markdown: 'Answer 3' })
      } finally {
        service.dispose()
      }
    },
  )

  it('notifies a later delivery outage again after successful recovery', async () => {
    vi.useFakeTimers()
    let available = false
    const invalidate = vi.fn()
    const service: TranscriptWindowService = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value) => value,
      invalidate,
      post: (window) => {
        if (available) service.acknowledge(window.sessionId, window.revision)
        return Promise.resolve(available)
      },
    })
    try {
      service.installPage(sessionId, { events: [], hasMore: false }, service.begin(sessionId))
      service.accept(message(0).event)
      await vi.advanceTimersByTimeAsync(0)
      expect(invalidate).toHaveBeenCalledTimes(1)
      available = true
      await vi.advanceTimersByTimeAsync(500)
      available = false
      service.accept(message(1).event)
      await vi.advanceTimersByTimeAsync(0)
      expect(invalidate).toHaveBeenCalledTimes(2)
    } finally {
      service.dispose()
    }
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
