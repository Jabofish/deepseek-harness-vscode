import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '@dsh-vscode/domain'
import type { BackendEvent } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import { historyGapRecovery, Rc6SessionRepository } from '../src/repositories/session-repository.js'
import { DshStreamController } from '../src/stream-controller.js'

describe('DshStreamController', () => {
  const controllers: DshStreamController[] = []

  afterEach(async () => {
    await Promise.all(controllers.splice(0).map((controller) => controller.close()))
  })

  it('keeps projection keys that share one durable event sequence', async () => {
    const sessionId = 's1'
    const sequence = 4
    const transport = streamTransport([
      {
        payload: { type: 'session/subscribed', sessionId, lastSeq: sequence - 1 },
      },
      {
        payload: {
          type: 'session/projection',
          sessionId,
          key: 'tokenUsage',
          value: { uncachedInputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
          seq: sequence,
        },
      },
      {
        payload: {
          type: 'session/projection',
          sessionId,
          key: 'contextPressure',
          value: { pressureTokens: 12, projectedTokens: 12, contextWindow: 128_000 },
          seq: sequence,
        },
      },
    ])
    const received: string[] = []
    const controller = new DshStreamController(transport)
    controllers.push(controller)
    controller.subscribe((event) => {
      if (event.type === 'session.projection') received.push(event.key)
    })

    await waitFor(() => received.length === 2)
    expect(received).toEqual(['tokenUsage', 'contextPressure'])
  })

  it('retains complete projection baselines and resets projection watermarks for a new generation', async () => {
    const transport = streamTransport([
      {
        payload: {
          type: 'session/projection-baseline',
          projections: { s1: { asOfSequence: 12, values: { live: 'baseline' } } },
        },
      },
      {
        payload: { type: 'session/projection', sessionId: 's1', key: 'live', value: 'before drop', seq: 13 },
      },
      {
        payload: {
          type: 'session/projection-baseline',
          projections: { s1: { asOfSequence: 7, values: {} } },
        },
      },
      {
        payload: {
          type: 'session/projection',
          sessionId: 's1',
          key: 'live',
          value: 'after reconnect',
          seq: 8,
        },
      },
    ])
    const received: BackendEvent[] = []
    const controller = new DshStreamController(transport)
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitFor(() => received.length === 4)
    expect(received).toEqual([
      {
        type: 'session.projection.baseline',
        projections: { s1: { asOfSequence: 12, values: { live: 'baseline' } } },
      },
      { type: 'session.projection', sessionId: 's1', key: 'live', value: 'before drop', sequence: 13 },
      { type: 'session.projection.baseline', projections: { s1: { asOfSequence: 7, values: {} } } },
      { type: 'session.projection', sessionId: 's1', key: 'live', value: 'after reconnect', sequence: 8 },
    ])
  })

  it('dedupes an exact durable row duplicated inside an authoritative follow snapshot', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: stream.source,
      closeTransport: false,
    })
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    // The follow snapshot is authoritative before its cursor is established.
    // A retried page must not create two identical conversation nodes, while
    // distinct records sharing a sequence remain valid elsewhere in the fold.
    const row = canonicalFrame('s1', 1, 'turn/start', { turn: 1 })
    stream.push(row)
    stream.push(row)
    stream.push(subscribeFrame('s1', 1))

    await waitFor(() => received.some((event) => event.type === 'session.subscribed'))
    expect(received.filter((event) => event.type === 'turn.started')).toHaveLength(1)
  })

  it('does not drop the final assistant message when it is in the opening snapshot', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: stream.source,
      closeTransport: false,
    })
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(
      canonicalFrame('s1', 1, 'assistant/message', {
        turn: 5,
        step: 5,
        message: {
          id: 'assistant-final',
          role: 'assistant',
          source: { kind: 'model', provider: 'minimax-cn', model: 'MiniMax-M3' },
          content: [
            {
              type: 'text',
              text: '替换成功 ✅\n\n**结果对比：**\n\n| 行 | 之前 | 现在 |\n|---|---|---|\n| 1 | `Hello, World!` | `Greetings from MiniMax-M3!` |',
            },
          ],
        },
      }),
    )
    stream.push(subscribeFrame('s1', 1))

    await waitFor(() => received.some((event) => event.type === 'message.completed'))
    const completed = received.find((event) => event.type === 'message.completed')
    expect(completed?.type).toBe('message.completed')
    if (completed?.type !== 'message.completed') return
    expect(completed.sequence).toBe(1)
    expect(completed.messageId).toBe('assistant-final')
    expect(completed.markdown).toContain('Greetings from MiniMax-M3!')
  })

  it('keeps a live compaction replacement out of the transcript without losing its sequence', async () => {
    const sessionId = 's1'
    const transport = streamTransport([
      canonicalFrame(sessionId, 0, 'user/message', {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: 'Refactor the parser' }],
        source: { kind: 'user' },
      }),
      {
        payload: {
          type: 'session/event',
          sessionId,
          event: {
            type: 'user/message',
            seq: 1,
            time: 1,
            surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
            data: {
              id: 'compaction-checkpoint',
              role: 'user',
              content: [{ type: 'text', text: 'Summary of the shadowed range.' }],
              source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' },
            },
          },
        },
      },
      canonicalFrame(sessionId, 2, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'a1',
          role: 'assistant',
          source: { kind: 'model', provider: 'provider-1', model: 'model-1' },
          content: [{ type: 'text', text: 'Parser refactored' }],
        },
      }),
    ])
    const received: BackendEvent[] = []
    const controller = new DshStreamController(transport)
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitFor(() => received.length === 3)
    // The copy restates a shadowed range for the model alone, so it must not
    // reach the transcript as a user turn. Its sequence still has to be
    // delivered in order: the ordered-delivery watermark reads a missing
    // sequence as a hole in the log and would recover history for it.
    expect(received.map((event) => event.type)).toEqual([
      'message.user',
      'session.system',
      'message.completed',
    ])
    expect(received[1]).toMatchObject({ type: 'session.system', sessionId, sequence: 1 })
    expect(JSON.stringify(received)).not.toContain('Summary of the shadowed range.')
  })

  it('stops a same-sequence bucket when a listener closes the controller', async () => {
    const stream = new ControlledStream()
    const received: BackendEvent[] = []
    let closePromise: Promise<void> | undefined
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: stream.source,
      closeTransport: false,
    })
    controllers.push(controller)
    controller.subscribe((event) => {
      received.push(event)
      if (event.type === 'turn.started') closePromise = controller.close()
    })

    stream.push(subscribeFrame('s1', 0))
    stream.push(liveTurnFrame('s1', 1))
    stream.push(canonicalFrame('s1', 1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await waitFor(() => received.some((event) => event.type === 'turn.started'))
    await closePromise

    expect(received.filter((event) => event.sequence === 1)).toHaveLength(1)
    expect(received.some((event) => event.type === 'turn.ended')).toBe(false)
  })

  it('keeps delivery alive when an observer rejects one event', async () => {
    const stream = new ControlledStream()
    const received: BackendEvent[] = []
    const controller = new DshStreamController(
      streamTransport([]),
      () => {
        throw new Error('cache observer failed')
      },
      undefined,
      { streamSource: stream.source, closeTransport: false },
    )
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    stream.push(subscribeFrame('s1', 0))
    stream.push(liveTurnFrame('s1', 1))
    stream.push(liveTurnFrame('s1', 2))
    await waitFor(() => received.some((event) => event.sequence === 2))

    expect(
      received.map((event) => event.sequence).filter((value): value is number => value !== undefined),
    ).toEqual([1, 2])
  })

  it('delivers the teardown event before an observer closes the controller', async () => {
    const received: BackendEvent[] = []
    const controllerHolder: { current?: DshStreamController } = {}
    const controller = new DshStreamController(
      streamTransport([{ payload: { type: 'host/session-removed', sessionId: 's1' } }]),
      () => {
        void controllerHolder.current?.close()
      },
    )
    controllerHolder.current = controller
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitFor(() => received.some((event) => event.type === 'session.removed'))
    expect(received).toContainEqual({ type: 'session.removed', sessionId: 's1' })
  })

  it('orders nested model retry events with the durable session stream', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(
      streamTransport([]),
      undefined,
      () => Promise.resolve([recoveredTurn('s1', 1)]),
      { streamSource: stream.source, closeTransport: false },
    )
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(subscribeFrame('s1', 0))
    stream.push(
      canonicalFrame('s1', 2, 'llm/retry', {
        retryId: 'retry-1',
        turn: 1,
        step: 1,
        provider: 'deepseek',
        mode: 'normal',
        policyKey: 'deepseek-normal',
        retry: 1,
        maxRetries: 2,
        delayMs: 10,
        failure: { code: 'RATE_LIMIT', message: 'rate limited' },
      }),
    )

    await waitFor(() => received.some((event) => event.type === 'model.retry'))
    const durable = received.filter(
      (event) => event.type !== 'session.subscribed' && event.type !== 'session.gap',
    )
    expect(durable.map((event) => event.sequence)).toEqual([1, 2])
    expect(durable.map((event) => event.type)).toEqual(['turn.started', 'model.retry'])
  })

  it('restarts the stream for a listener that subscribes during teardown', async () => {
    const transport = streamTransport([
      { payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 0 } },
    ])
    const received: string[] = []
    const controller = new DshStreamController(transport)
    controllers.push(controller)
    const first = controller.subscribe((event) => received.push(`first:${event.type}`))
    first()
    // Re-subscribe while the aborted generation is still unwinding: the
    // reader promise exists, so subscribe() cannot start a stream itself.
    controller.subscribe((event) => received.push(`second:${event.type}`))

    await waitFor(() => received.includes('second:session.subscribed'))
    expect(received.filter((entry) => entry.startsWith('second:'))).toEqual(['second:session.subscribed'])
  })

  it('restarts the reconnect backoff after a generation proved the stream alive', async () => {
    // A streamSource-based controller (alpha workspace/session streams) never
    // sees a session/subscribed frame, so its backoff level previously only
    // ratcheted up across generations: a healthy generation followed by a
    // clean end still waited seconds for the next reconnect. Any received
    // frame proves the transport alive and must restart the backoff ladder.
    const healthyGeneration = [{ payload: { type: 'host/workspace-changed', workspaceId: 'w1' } }]
    let generation = 0
    const open = (): AsyncIterable<unknown> => {
      generation += 1
      const frames = generation <= 3 ? healthyGeneration : []
      return {
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
          let index = 0
          return {
            async next() {
              await Promise.resolve()
              if (frames.length === 0) throw new Error('stream down after healthy generations')
              return index < frames.length
                ? { done: false as const, value: frames[index++] }
                : { done: true as const, value: undefined }
            },
          }
        },
      }
    }
    const controller = new DshStreamController(
      { ...streamTransport([]), close: () => Promise.resolve() },
      undefined,
      undefined,
      {
        streamSource: open,
        closeTransport: false,
      },
    )
    controllers.push(controller)
    controller.subscribe(() => undefined)

    // Three healthy generations plus the failing one open immediately or at
    // the 250ms base backoff; without the reset the fourth open waits ~1s and
    // the fifth ~2s, so five opens within 2s is only reachable with a reset.
    await waitForAtMost(() => generation >= 5, 2_000)
    await controller.close()
  })

  it('re-baselines a stream after a transient assistant sequence gap', async () => {
    const transport = reconnectingTransport([
      [subscribeFrame('s1', 0), assistantFrame('s1', 1, 'first'), assistantFrame('s1', 3, 'gap-after-drop')],
      [subscribeFrame('s1', 0), assistantFrame('s1', 1, 'recovered')],
    ])
    const received: BackendEvent[] = []
    const controller = new DshStreamController(transport, undefined, undefined, {
      streamSource: (signal) =>
        transport.openMuxStream?.(signal) ?? streamTransport([]).openEventStream(signal),
      closeTransport: false,
    })
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitForAtMost(
      () => received.some((event) => event.type === 'message.delta' && event.delta === 'recovered'),
      2_000,
    )
    expect(received.some((event) => event.type === 'message.delta' && event.delta === 'gap-after-drop')).toBe(
      false,
    )
  })

  it('hands an unfinished durable drain to the next reconnect generation', async () => {
    const firstStream = new ControlledStream()
    const secondStream = new ControlledStream()
    let releaseRecovery = (): void => undefined
    const recoveryBarrier = new Promise<void>((resolve) => {
      releaseRecovery = resolve
    })
    let recoveryCalls = 0
    const controller = new DshStreamController(
      controlledGenerationTransport([firstStream, secondStream]),
      undefined,
      async (_sessionId, _fromSequence, _toSequence) => {
        recoveryCalls += 1
        if (recoveryCalls === 1) await recoveryBarrier
        return recoveryCalls === 2 ? [recoveredTurn('s1', 1)] : []
      },
    )
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    firstStream.push(subscribeFrame('s1', 0))
    firstStream.push(liveTurnFrame('s1', 2))
    await waitFor(() => recoveryCalls === 1)
    firstStream.end()

    await waitForAtMost(() => secondStream.signal !== undefined, 2_000)
    secondStream.push(subscribeFrame('s1', 2))
    secondStream.push(liveTurnFrame('s1', 3))
    releaseRecovery()

    await waitForAtMost(() => received.some((event) => event.sequence === 3), 2_000)
    expect(
      received
        .map((event) => event.sequence)
        .filter((sequence): sequence is number => sequence !== undefined),
    ).toEqual([1, 2, 3])
  })

  it('projects an abandoned assistant stream as a host-only interrupted completion', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: stream.source,
      closeTransport: false,
    })
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push({
      payload: {
        type: 'session/assistant-interrupted',
        sessionId: 's1',
        attemptId: 'attempt-abandoned',
        turn: 2,
        step: 1,
      },
    })
    await waitFor(() => received.some((event) => event.type === 'message.completed'))

    expect(received).toContainEqual({
      type: 'message.completed',
      sessionId: 's1',
      messageId: 'assistant:2:1',
      turn: 2,
      step: 1,
      interrupted: true,
    })
  })

  it('carries the DSH attempt start cursor through transient assistant chunks', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: stream.source,
      closeTransport: false,
    })
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push({
      payload: {
        type: 'session/assistant-stream',
        sessionId: 's1',
        transientSequence: 1,
        frame: {
          type: 'start',
          attemptId: 'attempt-retry',
          revision: 1,
          startedAfterSeq: 7,
          turn: 1,
          step: 1,
        },
      },
    })
    stream.push({
      payload: {
        type: 'session/assistant-stream',
        sessionId: 's1',
        transientSequence: 2,
        frame: {
          type: 'chunk',
          attemptId: 'attempt-retry',
          revision: 2,
          index: 0,
          time: 2,
          turn: 1,
          step: 1,
          startedAfterSeq: 7,
          chunk: { type: 'text-delta', index: 0, text: 'retrying' },
        },
      },
    })

    await waitFor(() => received.some((event) => event.type === 'message.delta'))
    expect(received).toContainEqual(
      expect.objectContaining({
        type: 'message.delta',
        sessionId: 's1',
        transientAttemptId: 'attempt-retry',
        transientStartedAfterSequence: 7,
      }),
    )
  })

  it('keeps multiple assistant attempts visible across interleaved durable events', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: stream.source,
      closeTransport: false,
    })
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(subscribeFrame('s1', 0))
    stream.push(assistantAttemptFrame('s1', 1, 'attempt-first', 1, 'first attempt'))
    stream.push(
      canonicalFrame('s1', 1, 'llm/retry', {
        retryId: 'retry-1',
        turn: 1,
        step: 1,
        provider: 'deepseek',
        mode: 'normal',
        policyKey: 'deepseek-normal',
        retry: 1,
        maxRetries: 2,
        delayMs: 10,
        failure: { code: 'RATE_LIMIT', message: 'rate limited' },
      }),
    )
    stream.push(assistantAttemptFrame('s1', 2, 'attempt-retry', 2, 'retry attempt'))

    await waitFor(() => received.filter((event) => event.type === 'message.delta').length === 2)
    const visible = received.filter((event) => event.type === 'message.delta' || event.type === 'model.retry')
    expect(visible.map((event) => event.type)).toEqual(['message.delta', 'model.retry', 'message.delta'])
    expect(visible.filter((event) => event.type === 'message.delta').map((event) => event.delta)).toEqual([
      'first attempt',
      'retry attempt',
    ])
    expect(
      visible.filter((event) => event.type === 'message.delta').map((event) => event.transientAttemptId),
    ).toEqual(['attempt-first', 'attempt-retry'])
  })

  it('keeps reconnect backoff instead of hot-looping a failing stream', async () => {
    const received: string[] = []
    const failingStream: NonNullable<DshTransport['openMuxStream']> = (_signal) => ({
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {
          async next() {
            await Promise.resolve()
            throw new Error('stream down')
          },
        }
      },
    })
    const transport: DshTransport = { ...streamTransport([]), openMuxStream: failingStream }
    const controller = new DshStreamController(transport)
    controllers.push(controller)
    controller.subscribe((event) => received.push(event.type))

    await waitFor(() => received.includes('connection.lost'))
    await new Promise((resolve) => setTimeout(resolve, 80))
    // The reconnect backoff is at least 250ms, so a failing stream must not
    // burn generations (and connection.lost notices) in a microtask loop.
    expect(received.filter((type) => type === 'connection.lost')).toHaveLength(1)
  })

  it('releases sequence watermarks when a session is removed', async () => {
    const sessionId = 's1'
    const transport = streamTransport([
      { payload: { type: 'session/subscribed', sessionId, lastSeq: 9 } },
      { payload: { type: 'session/projection', sessionId, key: 'title', value: 'old', seq: 9 } },
      { payload: { type: 'host/session-removed', sessionId } },
      { payload: { type: 'session/subscribed', sessionId, lastSeq: 0 } },
      { payload: { type: 'session/projection', sessionId, key: 'title', value: 'new', seq: 0 } },
    ])
    const values: unknown[] = []
    const controller = new DshStreamController(transport)
    controllers.push(controller)
    controller.subscribe((event) => {
      if (event.type === 'session.projection') values.push(event.value)
    })

    await waitFor(() => values.length === 2)
    expect(values).toEqual(['old', 'new'])
  })

  it('resumes live events when the host re-subscribes below the cached watermark', async () => {
    // The v1 mux ignores the client's `since` resume hook and re-subscribes
    // from the host's own lastSeq baseline. When a host returns with a shorter
    // session log (no session-removed notice), the cached watermark refers to
    // entries the host no longer has: the controller must follow the host's
    // baseline down instead of silently dropping the new event epoch.
    const sessionId = 's1'
    const transport = reconnectingTransport([
      [
        { payload: { type: 'session/subscribed', sessionId, lastSeq: 9 } },
        {
          payload: {
            type: 'session/event',
            sessionId,
            event: { type: 'turn/end', seq: 9, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
          },
        },
      ],
      [
        { payload: { type: 'session/subscribed', sessionId, lastSeq: 2 } },
        {
          payload: {
            type: 'session/event',
            sessionId,
            event: { type: 'turn/end', seq: 3, time: 2, data: { turn: 2, reason: { kind: 'completed' } } },
          },
        },
      ],
    ])
    const received: BackendEvent[] = []
    const controller = new DshStreamController(transport)
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitForAtMost(
      () =>
        received.some(
          (event) =>
            event.type === 'turn.ended' &&
            event.sequence === 3 &&
            'sessionId' in event &&
            event.sessionId === sessionId,
        ),
      2_000,
    )
  })

  it('keeps the authoritative pre-subscription snapshot after a natural reconnect to a shorter log', async () => {
    const first = new ControlledStream()
    const second = new ControlledStream()
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: controlledGenerationSource([first, second]),
      closeTransport: false,
    })
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    first.push(subscribeFrame('s1', 9))
    first.push(canonicalFrame('s1', 10, 'turn/start', { turn: 10 }))
    await waitFor(() => received.some((event) => event.sequence === 10))
    first.end()

    await waitForAtMost(() => second.signal !== undefined && !second.signal.aborted, 2_000)
    // Session/follow sends its bounded snapshot before session/subscribed. On
    // a reconnect to a shorter epoch those rows are the only copy of the new
    // log prefix and must not be discarded against the old watermark.
    second.push(canonicalFrame('s1', 1, 'turn/start', { turn: 1 }))
    second.push(canonicalFrame('s1', 2, 'turn/start', { turn: 2 }))
    second.push(subscribeFrame('s1', 2))
    second.push(canonicalFrame('s1', 3, 'turn/start', { turn: 3 }))

    await waitFor(() => received.some((event) => event.type === 'turn.started' && event.sequence === 3))

    expect(received.filter((event) => event.type === 'turn.started').map((event) => event.sequence)).toEqual([
      10, 1, 2, 3,
    ])
  })

  it('resets projection dedupe after a shorter follow baseline starts a new epoch', async () => {
    const first = new ControlledStream()
    const second = new ControlledStream()
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: controlledGenerationSource([first, second]),
      closeTransport: false,
    })
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    first.push(subscribeFrame('s1', 0))
    first.push(projectionFrame('s1', 1, 'tokenUsage', { outputTokens: 9 }))
    first.push(canonicalFrame('s1', 10, 'turn/start', { turn: 10 }))
    await waitFor(() => received.some((event) => event.sequence === 10))
    first.end()

    await waitForAtMost(() => second.signal !== undefined && !second.signal.aborted, 2_000)
    // A lower subscription marker proves that the host started a new log
    // epoch. Its first live projection may reuse a sequence from the old
    // epoch and must not be dropped by the old per-key watermark.
    second.push(subscribeFrame('s1', 1))
    second.push(projectionFrame('s1', 1, 'tokenUsage', { outputTokens: 1 }))

    await waitFor(() => received.filter((event) => event.type === 'session.projection').length === 2)
    expect(
      received.filter((event) => event.type === 'session.projection').map((event) => event.value),
    ).toEqual([{ outputTokens: 9 }, { outputTokens: 1 }])
  })

  it('records projection sequences emitted from a follow snapshot before deduping its live replay', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: stream.source,
      closeTransport: false,
    })
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(projectionFrame('s1', 1, 'tokenUsage', { outputTokens: 1 }))
    stream.push(subscribeFrame('s1', 1))
    stream.push(projectionFrame('s1', 1, 'tokenUsage', { outputTokens: 1 }))

    await waitFor(() => received.filter((event) => event.type === 'session.projection').length === 1)
    expect(received.filter((event) => event.type === 'session.projection')).toHaveLength(1)
  })

  it('seeds projection dedupe from the subscribed baseline before live replay', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: stream.source,
      closeTransport: false,
    })
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push({
      payload: {
        type: 'session/subscribed',
        sessionId: 's1',
        lastSeq: 10,
        projections: {
          asOfSeq: 10,
          values: { tokenUsage: { outputTokens: 10 } },
        },
      },
    })
    stream.push(projectionFrame('s1', 9, 'tokenUsage', { outputTokens: 9 }))
    stream.push(projectionFrame('s1', 11, 'tokenUsage', { outputTokens: 11 }))

    await waitFor(() => received.filter((event) => event.type === 'session.projection').length === 1)
    expect(received.filter((event) => event.type === 'session.projection')).toEqual([
      {
        type: 'session.projection',
        sessionId: 's1',
        key: 'tokenUsage',
        value: { outputTokens: 11 },
        sequence: 11,
      },
    ])
  })

  it('fences delayed projections for keys omitted by a complete subscribed baseline', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: stream.source,
      closeTransport: false,
    })
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push({
      payload: {
        type: 'session/subscribed',
        sessionId: 's1',
        lastSeq: 10,
        projections: { asOfSeq: 10, values: {} },
      },
    })
    await waitFor(() => received.some((event) => event.type === 'session.subscribed'))
    stream.push(projectionFrame('s1', 9, 'removedKey', { stale: true }))
    stream.push(projectionFrame('s1', 11, 'newKey', { fresh: true }))
    await waitFor(() => received.some((event) => event.type === 'session.projection'))

    expect(received.filter((event) => event.type === 'session.projection')).toEqual([
      {
        type: 'session.projection',
        sessionId: 's1',
        key: 'newKey',
        value: { fresh: true },
        sequence: 11,
      },
    ])
  })

  it('crosses a recovery range made only of filtered projection rows', async () => {
    const stream = new ControlledStream()
    const recoveryRanges: Array<[number, number]> = []
    const controller = new DshStreamController(
      streamTransport([]),
      undefined,
      (_sessionId, fromSequence, toSequence) => {
        recoveryRanges.push([fromSequence, toSequence])
        return Promise.resolve([
          {
            type: 'session.projection',
            sessionId: 's1',
            key: 'tokenUsage',
            value: { outputTokens: 9 },
            sequence: 9,
          },
          {
            type: 'session.projection',
            sessionId: 's1',
            key: 'tokenUsage',
            value: { outputTokens: 10 },
            sequence: 10,
          },
        ])
      },
      { streamSource: stream.source, closeTransport: false },
    )
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(subscribeFrame('s1', 8))
    stream.push(projectionFrame('s1', 11, 'tokenUsage', { outputTokens: 11 }))
    stream.push(canonicalFrame('s1', 11, 'turn/start', { turn: 1 }))

    await waitFor(() => received.some((event) => event.type === 'turn.started' && event.sequence === 11))

    expect(recoveryRanges).toEqual([[9, 10]])
    expect(received.filter((event) => event.type === 'session.gap')).toHaveLength(0)
    expect(received.filter((event) => event.type === 'session.projection')).toEqual([
      {
        type: 'session.projection',
        sessionId: 's1',
        key: 'tokenUsage',
        value: { outputTokens: 11 },
        sequence: 11,
      },
    ])
  })

  it('orders a reconnect snapshot tail after recovered events and later live events', async () => {
    const first = new ControlledStream()
    const second = new ControlledStream()
    const recoveryRanges: Array<[number, number]> = []
    let releaseRecovery: (() => void) | undefined
    const recoveryBarrier = new Promise<void>((resolve) => {
      releaseRecovery = resolve
    })
    let recoveryStartedResolve: (() => void) | undefined
    const recoveryReady = new Promise<void>((resolve) => {
      recoveryStartedResolve = resolve
    })
    const controller = new DshStreamController(
      streamTransport([]),
      undefined,
      async (_sessionId, fromSequence, toSequence) => {
        recoveryRanges.push([fromSequence, toSequence])
        recoveryStartedResolve?.()
        await recoveryBarrier
        return [recoveredTurn('s1', 2), recoveredTurn('s1', 3)]
      },
      {
        streamSource: controlledGenerationSource([first, second]),
        closeTransport: false,
      },
    )
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    first.push(subscribeFrame('s1', 0))
    first.push(canonicalFrame('s1', 1, 'turn/start', { turn: 1 }))
    await waitFor(() => received.some((event) => event.sequence === 1))
    first.end()

    await waitForAtMost(() => second.signal !== undefined && !second.signal.aborted, 2_000)
    // The snapshot is a bounded tail from the new generation. It must remain
    // behind the missing prefix returned by history, while seq 6 proves that
    // live frames can continue arriving during the asynchronous recovery.
    second.push(canonicalFrame('s1', 4, 'turn/start', { turn: 4 }))
    second.push(canonicalFrame('s1', 5, 'turn/start', { turn: 5 }))
    second.push(subscribeFrame('s1', 5))
    await recoveryReady
    second.push(canonicalFrame('s1', 6, 'turn/start', { turn: 6 }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(received.some((event) => event.sequence === 4)).toBe(false)
    expect(received.some((event) => event.sequence === 6)).toBe(false)

    releaseRecovery?.()
    await waitFor(() => received.some((event) => event.sequence === 6))

    expect(recoveryRanges).toEqual([[2, 5]])
    expect(received.filter((event) => event.type === 'turn.started').map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6,
    ])
  })

  it('forwards the durable turn end and host idle status from rc.6 frames', async () => {
    const sessionId = 's1'
    const transport = streamTransport([
      { payload: { type: 'session/subscribed', sessionId, lastSeq: 0 } },
      {
        payload: {
          type: 'session/event',
          sessionId,
          event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
        },
      },
      {
        payload: {
          type: 'session/event',
          sessionId,
          event: {
            type: 'assistant/message',
            seq: 2,
            time: 2,
            data: {
              turn: 1,
              step: 0,
              message: {
                id: 'assistant-1',
                role: 'assistant',
                content: [{ type: 'text', text: 'done' }],
                source: { kind: 'model', provider: 'provider-1', model: 'model-1' },
              },
            },
          },
        },
      },
      {
        payload: {
          type: 'session/event',
          sessionId,
          event: { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
        },
      },
      { payload: { type: 'host/session-status', sessionId, running: false } },
    ])
    const received: string[] = []
    const controller = new DshStreamController(transport)
    controllers.push(controller)
    controller.subscribe((event) => received.push(event.type))

    await waitFor(() => received.includes('session.status'))
    expect(received).toEqual([
      'session.subscribed',
      'turn.started',
      'message.completed',
      'turn.ended',
      'session.status',
    ])
  })

  it('does not replay malformed canonical session events as synthetic domain state', async () => {
    const sessionId = 's1'
    const malformed = [
      { type: 'turn/end', data: { turn: 1 } },
      { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta' } } },
      { type: 'assistant/message', data: { turn: 1, step: 1, markdown: 'not canonical' } },
      { type: 'user/message', data: { id: 'user-1', content: [] } },
      {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 2,
          message: {
            id: 'assistant-image-1',
            role: 'assistant',
            content: [{ type: 'image', attachment: { attachmentId: 'missing-metadata' } }],
            source: { kind: 'model', provider: 'provider-1', model: 'model-1' },
          },
        },
      },
      { type: 'tool/call', data: { turn: 1, step: 1, name: 'shell', arguments: '{}' } },
      { type: 'tool/result', data: { turn: 1, step: 1, callId: 'call-1' } },
      { type: 'request/context', data: { provider: 'provider-1' } },
    ] as const
    const transport = streamTransport(
      malformed.map((event, index) => ({
        payload: {
          type: 'session/event',
          sessionId,
          event: { ...event, seq: index + 1, time: index + 1 },
        },
      })),
    )
    const received: BackendEvent[] = []
    const controller = new DshStreamController(transport)
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitFor(() => received.filter((event) => event.type === 'unknown').length === malformed.length)
    const unknown = received.filter((event) => event.type === 'unknown')
    expect(unknown.map((event) => event.type)).toEqual(Array(malformed.length).fill('unknown'))
    expect(unknown.map((event) => ('name' in event ? event.name : undefined))).toEqual(
      malformed.map((event) => event.type),
    )
  })

  it('keeps future frame types as redacted unknown events', async () => {
    const received: BackendEvent[] = []
    const controller = new DshStreamController(
      streamTransport([
        {
          payload: {
            type: 'future/frame',
            sessionId: 's1',
            seq: 3,
            token: 'secret',
            path: 'C:\\private\\file.txt',
            data: { text: 'x'.repeat(2_000) },
            safe: 'ok',
          },
        },
      ]),
    )
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitFor(() => received.some((event) => event.type === 'unknown'))
    const unknown = received.find((event) => event.type === 'unknown')
    expect(unknown).toMatchObject({ type: 'unknown', name: 'future/frame', sessionId: 's1', sequence: 3 })
    expect(JSON.stringify(unknown)).not.toContain('secret')
    expect(JSON.stringify(unknown)).not.toContain('private')
    expect(JSON.stringify(unknown)).toContain('ok')
    expect(JSON.stringify(unknown)).not.toContain('x'.repeat(513))
  })

  it('keeps frame types removed from the pinned schema in the unknown bucket', async () => {
    const received: BackendEvent[] = []
    const controller = new DshStreamController(
      streamTransport([{ payload: { type: 'session/title', sessionId: 's1', title: 'stale' } }]),
    )
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitFor(() => received.some((event) => event.type === 'unknown'))
    expect(received.find((event) => event.type === 'unknown')).toMatchObject({
      type: 'unknown',
      name: 'session/title',
      sessionId: 's1',
    })
  })

  it('reports bounded stream error diagnostics without exposing secrets', async () => {
    const received: BackendEvent[] = []
    const controller = new DshStreamController(
      streamTransport([
        {
          payload: {
            type: 'stream/error',
            error: {
              code: 'internal',
              message: 'request failed token=secret',
              details: {},
            },
          },
        },
      ]),
    )
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitFor(() => received.some((event) => event.type === 'connection.lost'))
    const lost = received.find((event) => event.type === 'connection.lost')
    expect(lost).toMatchObject({
      type: 'connection.lost',
      reason: 'DSH event stream reported internal: request failed token: [redacted]',
    })
  })

  it('includes safe transport context when a stream reader fails', async () => {
    const received: BackendEvent[] = []
    const failingStream: NonNullable<DshTransport['openMuxStream']> = (_signal) => ({
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {
          async next() {
            await Promise.resolve()
            throw new AppError({
              code: 'BACKEND_UNREACHABLE',
              message: 'request failed',
              retryable: true,
              context: { method: 'session.history', status: 503 },
            })
          },
        }
      },
    })
    const transport: DshTransport = {
      ...streamTransport([]),
      openMuxStream: failingStream,
    }
    const controller = new DshStreamController(transport)
    controllers.push(controller)
    controller.subscribe((event) => received.push(event))

    await waitFor(() => received.some((event) => event.type === 'connection.lost'))
    expect(received.find((event) => event.type === 'connection.lost')).toMatchObject({
      reason: 'DSH event stream request session.history failed (HTTP 503).',
    })
  })
})

function streamTransport(frames: readonly unknown[]): DshTransport {
  const open = async function* (signal: AbortSignal): AsyncIterable<unknown> {
    yield* frames
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }
  return {
    request: <T>() => Promise.reject<T>(new Error('request is not used by this test')),
    remoteRequest: <T>() => Promise.reject<T>(new Error('remoteRequest is not used by this test')),
    openEventStream: open,
    openMuxStream: open,
    close: () => Promise.resolve(),
  }
}

/** A pushable stream source so tests can drive gaps and recovery interactively. */
class ControlledStream {
  private readonly pending: unknown[] = []
  private wake: (() => void) | undefined
  private finished = false
  public signal: AbortSignal | undefined

  public push(frame: unknown): void {
    if (this.finished) return
    this.pending.push(frame)
    const resume = this.wake
    this.wake = undefined
    resume?.()
  }

  public end(): void {
    this.finished = true
    this.wake?.()
  }

  public readonly source = (signal: AbortSignal): AsyncIterable<unknown> => {
    this.signal = signal
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<unknown> => {
        return {
          next: async (): Promise<IteratorResult<unknown>> => {
            for (;;) {
              if (this.pending.length > 0) return { done: false as const, value: this.pending.shift() }
              if (this.finished || signal.aborted) return { done: true as const, value: undefined }
              await new Promise<void>((resolve) => {
                this.wake = resolve
                if (signal.aborted) resolve()
                else signal.addEventListener('abort', () => resolve(), { once: true })
              })
            }
          },
        }
      },
    }
  }
}

function subscribeFrame(sessionId: string, lastSeq: number): unknown {
  return { payload: { type: 'session/subscribed', sessionId, lastSeq } }
}

function liveTurnFrame(sessionId: string, seq: number): unknown {
  return {
    payload: {
      type: 'session/event',
      sessionId,
      event: { type: 'turn/start', seq, time: seq, data: { turn: 1 } },
    },
  }
}

function assistantFrame(sessionId: string, transientSequence: number, text: string): unknown {
  return {
    payload: {
      type: 'session/assistant-stream',
      sessionId,
      transientSequence,
      frame: {
        type: 'chunk',
        attemptId: 'attempt-1',
        revision: transientSequence,
        index: transientSequence - 1,
        time: transientSequence,
        turn: 1,
        step: 0,
        chunk: { type: 'text-delta', index: transientSequence - 1, text },
      },
    },
  }
}

function assistantAttemptFrame(
  sessionId: string,
  transientSequence: number,
  attemptId: string,
  revision: number,
  text: string,
): unknown {
  return {
    payload: {
      type: 'session/assistant-stream',
      sessionId,
      transientSequence,
      frame: {
        type: 'chunk',
        attemptId,
        revision,
        index: 0,
        time: revision,
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text },
      },
    },
  }
}

function canonicalFrame(sessionId: string, sequence: number, type: string, data: unknown): unknown {
  return {
    payload: {
      type: 'session/event',
      sessionId,
      event: { type, seq: sequence, time: sequence, data },
    },
  }
}

function projectionFrame(sessionId: string, sequence: number, key: string, value: unknown): unknown {
  return {
    payload: { type: 'session/projection', sessionId, key, value, seq: sequence },
  }
}

function historyRow(
  sequence: number,
  type: string,
  data: unknown,
): {
  event: { type: string; seq: number; time: number; data: unknown }
} {
  return { event: { type, seq: sequence, time: 1_700_000_000_000 + sequence, data } }
}

function toolResultData(
  callId: string,
  messageId: string,
  output: string,
  isError: boolean,
  error?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    turn: callId === 'call-3' ? 2 : 1,
    step: 1,
    callId,
    message: {
      id: messageId,
      role: 'user',
      source: { kind: 'tool', callId },
      content: [
        {
          type: 'tool-result',
          toolCallId: callId,
          isError,
          content: [{ type: 'text', text: output }],
        },
      ],
    },
    ...(error === undefined ? {} : { error }),
  }
}

function recoveredTurn(sessionId: string, sequence: number): BackendEvent {
  return { type: 'turn.started', sessionId, turn: 1, sequence } as unknown as BackendEvent
}

function eventForSession(event: BackendEvent, sessionId: string): boolean {
  return 'sessionId' in event && event.sessionId === sessionId
}

function recoveredMessage(
  sessionId: string,
  sequence: number,
  messageId: string,
  markdown: string,
): BackendEvent {
  return { type: 'message.user', sessionId, messageId, markdown, source: 'user', sequence }
}

function recoveredStep(sessionId: string, sequence: number): BackendEvent {
  return { type: 'step.started', sessionId, turn: 1, step: 1, sequence }
}

function recoveredReasoning(sessionId: string, sequence: number, delta: string): BackendEvent {
  return { type: 'reasoning.delta', sessionId, messageId: 'assistant-1', turn: 1, step: 1, delta, sequence }
}

function recoveredTool(
  sessionId: string,
  sequence: number,
  id: string,
  status: 'completed' | 'running',
  outputSummary?: string,
): BackendEvent {
  return {
    type: 'tool.updated',
    sessionId,
    sequence,
    tool: {
      id,
      name: 'shell',
      category: 'execution',
      title: 'Shell',
      status,
      ...(outputSummary === undefined ? {} : { outputSummary }),
      metadata: {},
    },
  }
}

describe('DshStreamController ordered gap recovery', () => {
  const controllers: DshStreamController[] = []

  afterEach(async () => {
    await Promise.all(controllers.splice(0).map((controller) => controller.close()))
  })

  it('delivers a recovered hole before the live edge without blocking the reader', async () => {
    const stream = new ControlledStream()
    const recovered: Array<[string, number, number]> = []
    const controller = new DshStreamController(
      streamTransport([]),
      undefined,
      async (sessionId, fromSequence, toSequence) => {
        recovered.push([sessionId, fromSequence, toSequence])
        return Promise.resolve([6, 7, 8, 9].map((sequence) => recoveredTurn('s1', sequence)))
      },
      { streamSource: stream.source, closeTransport: false },
    )
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(subscribeFrame('s1', 5))
    await waitFor(() => received.some((event) => event.type === 'session.subscribed'))
    stream.push(liveTurnFrame('s1', 10))
    // Recovery runs alongside the host reader, while the live event remains
    // buffered until the preceding history range has been accounted for.
    await waitFor(() => received.some((event) => event.sequence === 6))
    await waitFor(() => received.some((event) => event.sequence === 9))
    await waitFor(() => received.some((event) => event.sequence === 10))

    expect(recovered).toEqual([['s1', 6, 9]])
    expect(
      received
        .map((event) => event.sequence)
        .filter((sequence): sequence is number => sequence !== undefined),
    ).toEqual([6, 7, 8, 9, 10])
    expect(received.some((event) => event.type === 'session.gap')).toBe(false)
    // A redelivered older frame is still deduplicated after the ordered
    // dispatcher has crossed the live edge.
    stream.push(liveTurnFrame('s1', 9))
    stream.push(liveTurnFrame('s1', 11))
    await waitFor(() => received.some((event) => event.sequence === 11))
    expect(received.filter((event) => event.sequence === 9)).toHaveLength(1)
  })

  it('keeps simultaneous history gaps and delivery cursors isolated per session', async () => {
    const stream = new ControlledStream()
    const recoveryStarted: Array<[string, number, number]> = []
    const releases = new Map<string, () => void>()
    const recoveryBarriers = new Map<string, Promise<void>>()
    for (const sessionId of ['s1', 's2'])
      recoveryBarriers.set(sessionId, new Promise<void>((resolve) => releases.set(sessionId, resolve)))
    const controller = new DshStreamController(
      streamTransport([]),
      undefined,
      async (sessionId, fromSequence, toSequence) => {
        recoveryStarted.push([sessionId, fromSequence, toSequence])
        await recoveryBarriers.get(sessionId)
        return [recoveredTurn(sessionId, fromSequence)]
      },
      { streamSource: stream.source, closeTransport: false },
    )
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(subscribeFrame('s1', 0))
    stream.push(subscribeFrame('s2', 10))
    await waitFor(() => received.filter((event) => event.type === 'session.subscribed').length === 2)
    stream.push(liveTurnFrame('s1', 2))
    stream.push(liveTurnFrame('s2', 12))

    await waitFor(() => recoveryStarted.length === 2)
    expect(recoveryStarted).toEqual([
      ['s1', 1, 1],
      ['s2', 11, 11],
    ])

    releases.get('s2')?.()
    await waitFor(() => received.some((event) => eventForSession(event, 's2') && event.sequence === 12))
    expect(
      received
        .filter((event) => eventForSession(event, 's2') && event.sequence !== undefined)
        .map((event) => event.sequence),
    ).toEqual([11, 12])
    expect(received.some((event) => eventForSession(event, 's1') && event.sequence !== undefined)).toBe(false)

    releases.get('s1')?.()
    await waitFor(() => received.some((event) => eventForSession(event, 's1') && event.sequence === 2))
    expect(
      received
        .filter((event) => eventForSession(event, 's1') && event.sequence !== undefined)
        .map((event) => event.sequence),
    ).toEqual([1, 2])
    expect(received.some((event) => event.type === 'session.gap')).toBe(false)
  })

  it('does not let a late old-session recovery block another session after reconnect', async () => {
    const firstStream = new ControlledStream()
    const secondStream = new ControlledStream()
    let releaseOldRecovery = (): void => undefined
    const oldRecoveryBarrier = new Promise<void>((resolve) => {
      releaseOldRecovery = resolve
    })
    const recoveryCalls: Array<[string, number, number]> = []
    const controller = new DshStreamController(
      controlledGenerationTransport([firstStream, secondStream]),
      undefined,
      async (sessionId, fromSequence, toSequence) => {
        recoveryCalls.push([sessionId, fromSequence, toSequence])
        if (sessionId === 's1' && recoveryCalls.filter(([id]) => id === 's1').length === 1) {
          // Deliberately ignore the abort signal to model a late history result.
          await oldRecoveryBarrier
          return [recoveredTurn('s1', 1)]
        }
        return [recoveredTurn(sessionId, fromSequence)]
      },
      { closeTransport: false },
    )
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    firstStream.push(subscribeFrame('s1', 0))
    firstStream.push(subscribeFrame('s2', 0))
    await waitFor(() => received.filter((event) => event.type === 'session.subscribed').length === 2)
    firstStream.push(liveTurnFrame('s1', 2))
    await waitFor(() => recoveryCalls.some(([sessionId]) => sessionId === 's1'))
    firstStream.push({
      payload: {
        type: 'session/event',
        sessionId: 's1',
        event: {
          type: 'assistant/message',
          time: 1,
          data: { turn: 1, step: 1, message: { id: 'bad-sequence' }, stream: [] },
        },
      },
    })
    await waitFor(() => received.some((event) => event.type === 'connection.lost'))

    try {
      await waitForAtMost(() => secondStream.signal !== undefined, 2_000)
      secondStream.push(subscribeFrame('s1', 2))
      secondStream.push(subscribeFrame('s2', 0))
      await waitFor(() => received.filter((event) => event.type === 'session.subscribed').length === 4)
      secondStream.push(liveTurnFrame('s2', 2))

      await waitForAtMost(
        () => received.some((event) => eventForSession(event, 's2') && event.sequence === 2),
        2_000,
      )
      expect(
        received
          .filter((event) => eventForSession(event, 's2') && event.sequence !== undefined)
          .map((event) => event.sequence),
      ).toEqual([1, 2])
      expect(recoveryCalls).toContainEqual(['s2', 1, 1])
      expect(received.some((event) => eventForSession(event, 's1') && event.sequence === 1)).toBe(false)

      releaseOldRecovery()
      await waitFor(() => recoveryCalls.filter(([sessionId]) => sessionId === 's1').length === 2)
      await waitForAtMost(
        () => received.some((event) => eventForSession(event, 's1') && event.sequence === 2),
        2_000,
      )
      expect(
        received
          .filter((event) => eventForSession(event, 's1') && event.sequence !== undefined)
          .map((event) => event.sequence),
      ).toEqual([1, 2])
      expect(received.some((event) => event.type === 'session.gap')).toBe(false)
    } finally {
      releaseOldRecovery()
    }
  })

  it('keeps a complex interleaved multi-tool stream complete and ordered during recovery', async () => {
    const stream = new ControlledStream()
    const releaseRecovery = { resolve: (): void => undefined }
    const recoveryBarrier = new Promise<void>((resolve) => {
      releaseRecovery.resolve = resolve
    })
    const recoveryRanges: Array<[number, number]> = []
    const controller = new DshStreamController(
      streamTransport([]),
      undefined,
      async (_sessionId, fromSequence, toSequence) => {
        recoveryRanges.push([fromSequence, toSequence])
        if (recoveryRanges.length === 1) await recoveryBarrier
        return [
          recoveredMessage('s1', 6, 'user-1', 'inspect the repository'),
          recoveredTurn('s1', 7),
          recoveredStep('s1', 8),
          recoveredReasoning('s1', 9, 'I will inspect two tools.'),
          recoveredTool('s1', 11, 'call-1', 'completed', 'first tool result'),
        ].filter(
          (event) =>
            event.sequence !== undefined && event.sequence >= fromSequence && event.sequence <= toSequence,
        )
      },
      { streamSource: stream.source, closeTransport: false },
    )
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(subscribeFrame('s1', 5))
    await waitFor(() => received.some((event) => event.type === 'session.subscribed'))
    stream.push(
      canonicalFrame('s1', 10, 'tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'shell',
        arguments: '{}',
      }),
    )
    stream.push(projectionFrame('s1', 10, 'tokenUsage', { outputTokens: 2 }))
    stream.push(projectionFrame('s1', 10, 'contextPressure', { pressureTokens: 12 }))
    stream.push(
      canonicalFrame('s1', 12, 'tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-2',
        name: 'read',
        arguments: '{"path":"README.md"}',
      }),
    )
    stream.push(
      canonicalFrame('s1', 13, 'tool/result', {
        turn: 1,
        step: 1,
        callId: 'call-2',
        message: {
          id: 'tool-message-2',
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-2',
              content: [{ type: 'text', text: 'README contents' }],
            },
          ],
          source: { kind: 'tool', callId: 'call-2' },
        },
      }),
    )
    stream.push(
      canonicalFrame('s1', 14, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'The repository is consistent.' }],
          source: { kind: 'model', provider: 'provider-1', model: 'model-1' },
        },
      }),
    )
    stream.push(canonicalFrame('s1', 15, 'step/end', { turn: 1, step: 1 }))
    stream.push(canonicalFrame('s1', 16, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))

    // Projection state is allowed to arrive while history is loading, but no
    // durable conversation record may jump over the recovery barrier.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(received.some((event) => event.sequence === 10 && event.type === 'tool.updated')).toBe(false)
    expect(received.filter((event) => event.type === 'session.projection').map((event) => event.key)).toEqual(
      ['tokenUsage', 'contextPressure'],
    )

    releaseRecovery.resolve()
    await waitFor(() => received.some((event) => event.sequence === 16))

    const durable = received
      .filter((event) => event.type !== 'session.projection' && event.type !== 'session.subscribed')
      .filter((event) => event.sequence !== undefined)
    expect(durable.map((event) => event.sequence)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    expect(durable.map((event) => event.type)).toEqual([
      'message.user',
      'turn.started',
      'step.started',
      'reasoning.delta',
      'tool.updated',
      'tool.updated',
      'tool.updated',
      'tool.updated',
      'message.completed',
      'step.ended',
      'turn.ended',
    ])
    expect(recoveryRanges).toEqual([
      [6, 9],
      [11, 11],
    ])
    expect(received.some((event) => event.type === 'session.gap')).toBe(false)
  })

  it('replays an upstream-shaped multi-request stream losslessly across several live holes', async () => {
    const stream = new ControlledStream()
    const sessionId = 's1'
    const rawHistory = [
      historyRow(0, 'system/message', { message: { content: [{ type: 'text', text: 'private prompt' }] } }),
      historyRow(1, 'turn/start', { turn: 1 }),
      historyRow(2, 'user/message', {
        id: 'user-1',
        role: 'user',
        source: { kind: 'user', rpcId: 'request-1' },
        content: [{ type: 'text', text: 'inspect two tools' }],
      }),
      historyRow(3, 'step/start', { turn: 1, step: 1 }),
      historyRow(4, 'assistant/chunk', {
        turn: 1,
        step: 1,
        messageId: 'assistant-1',
        chunk: { type: 'text-delta', index: 0, text: 'I will inspect both tools. ' },
      }),
      historyRow(5, 'tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'read_file',
        arguments: '{"path":"src/a.ts"}',
      }),
      historyRow(6, 'tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-2',
        name: 'read_file',
        arguments: '{"path":"src/b.ts"}',
      }),
      historyRow(
        7,
        'tool/result',
        toolResultData('call-1', 'tool-result-1', 'permission denied', true, {
          name: 'ToolError',
          code: 'PERMISSION_DENIED',
          message: 'permission denied',
        }),
      ),
      historyRow(8, 'tool/result', toolResultData('call-2', 'tool-result-2', 'file b contents', false)),
      historyRow(9, 'deliverables/presented', {
        turn: 1,
        callId: 'call-2',
        files: [
          { path: 'artifacts/inspection.md', description: 'inspection report' },
          { path: 'artifacts/summary.json', description: 'machine-readable summary' },
        ],
      }),
      historyRow(10, 'assistant/chunk', {
        turn: 1,
        step: 1,
        messageId: 'assistant-1',
        chunk: { type: 'text-delta', index: 1, text: 'The first tool failed, but the second succeeded.' },
      }),
      historyRow(11, 'step/end', { turn: 1, step: 1 }),
      historyRow(12, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      historyRow(13, 'turn/start', { turn: 2 }),
      historyRow(14, 'user/message', {
        id: 'user-2',
        role: 'user',
        source: { kind: 'user', rpcId: 'request-2' },
        content: [{ type: 'text', text: 'now verify the report' }],
      }),
      historyRow(15, 'step/start', { turn: 2, step: 1 }),
      historyRow(16, 'tool/call', {
        turn: 2,
        step: 1,
        callId: 'call-3',
        name: 'code_interpreter',
        arguments: '{"code":"verify()"}',
      }),
      historyRow(17, 'tool/ptc-dispatch-start', {
        rootCallId: 'call-3',
        parentCallId: 'call-3',
        subCallId: 'call-3:ptc:1',
        name: 'read_file',
        arguments: { path: 'artifacts/inspection.md' },
      }),
      historyRow(18, 'tool/ptc-dispatch', {
        rootCallId: 'call-3',
        parentCallId: 'call-3',
        subCallId: 'call-3:ptc:1',
        name: 'read_file',
        arguments: { path: 'artifacts/inspection.md' },
        isError: true,
        content: [{ type: 'text', text: 'file changed during verification' }],
      }),
      historyRow(19, 'tool/ptc-dispatch-start', {
        rootCallId: 'call-3',
        parentCallId: 'call-3',
        subCallId: 'call-3:ptc:2',
        name: 'read_file',
        arguments: { path: 'artifacts/summary.json' },
      }),
      historyRow(20, 'tool/ptc-dispatch', {
        rootCallId: 'call-3',
        parentCallId: 'call-3',
        subCallId: 'call-3:ptc:2',
        name: 'read_file',
        arguments: { path: 'artifacts/summary.json' },
        content: [{ type: 'text', text: '{"ok":true}' }],
      }),
      historyRow(
        21,
        'tool/result',
        toolResultData('call-3', 'tool-result-3', 'verification completed', false),
      ),
      historyRow(22, 'assistant/message', {
        turn: 2,
        step: 1,
        message: {
          id: 'assistant-2',
          role: 'assistant',
          content: [{ type: 'text', text: 'The report is verified.' }],
          source: { kind: 'model', provider: 'fake', model: 'fake-1' },
        },
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0 },
      }),
      historyRow(23, 'deliverables/presented', {
        turn: 2,
        callId: 'call-3',
        files: [{ path: 'artifacts/verified.txt', description: 'verification result' }],
      }),
      historyRow(24, 'step/end', { turn: 2, step: 1 }),
      historyRow(25, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ]
    const recoveryRanges: Array<[number, number]> = []
    let releaseFirstHistory: (() => void) | undefined
    const firstHistoryBarrier = new Promise<void>((resolve) => {
      releaseFirstHistory = resolve
    })
    let historyStarted: (() => void) | undefined
    const historyRequestStarted = new Promise<void>((resolve) => {
      historyStarted = resolve
    })
    const transport: DshTransport = {
      request: async <TResponse>(method: string, params: unknown, signal?: AbortSignal) => {
        if (method !== 'session.history') throw new Error(`unexpected ${method}`)
        const beforeSequence = (params as { readonly beforeSeq?: number }).beforeSeq
        if (beforeSequence === 5) {
          historyStarted?.()
          await firstHistoryBarrier
        }
        signal?.throwIfAborted()
        const events = rawHistory.filter(
          (entry) => beforeSequence === undefined || entry.event.seq < beforeSequence,
        )
        return {
          result: { ok: true, value: { events, hasMore: false } },
        } as TResponse
      },
      remoteRequest: <TResponse>() => Promise.reject<TResponse>(new Error('unexpected Remote')),
      openEventStream: stream.source,
      close: () => Promise.resolve(),
    }
    const repository = new Rc6SessionRepository(transport)
    const controller = new DshStreamController(
      transport,
      undefined,
      (streamSessionId, fromSequence, toSequence, signal) => {
        recoveryRanges.push([fromSequence, toSequence])
        return historyGapRecovery(repository)(streamSessionId, fromSequence, toSequence, signal)
      },
      { closeTransport: false },
    )
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(subscribeFrame(sessionId, -1))
    stream.push(canonicalFrame(sessionId, 5, 'tool/call', rawHistory[5]?.event.data))
    stream.push(canonicalFrame(sessionId, 5, 'tool/call', rawHistory[5]?.event.data))
    stream.push(projectionFrame(sessionId, 5, 'tokenUsage', { outputTokens: 4 }))
    stream.push(projectionFrame(sessionId, 5, 'contextPressure', { pressureTokens: 32 }))
    stream.push(projectionFrame(sessionId, 5, 'tokenUsage', { outputTokens: 4 }))
    await historyRequestStarted
    await waitFor(() => received.filter((event) => event.type === 'session.projection').length >= 2)
    expect(
      received.filter((event) => event.type !== 'session.subscribed' && event.type !== 'session.projection'),
    ).toEqual([])
    stream.push(canonicalFrame(sessionId, 8, 'tool/result', rawHistory[8]?.event.data))
    stream.push(canonicalFrame(sessionId, 13, 'turn/start', rawHistory[13]?.event.data))
    stream.push(canonicalFrame(sessionId, 16, 'tool/call', rawHistory[16]?.event.data))
    stream.push(canonicalFrame(sessionId, 22, 'assistant/message', rawHistory[22]?.event.data))
    stream.push(projectionFrame(sessionId, 22, 'tokenUsage', { inputTokens: 100, outputTokens: 20 }))
    stream.push(projectionFrame(sessionId, 22, 'contextPressure', { pressureTokens: 64 }))
    stream.push(canonicalFrame(sessionId, 25, 'turn/end', rawHistory[25]?.event.data))

    releaseFirstHistory?.()
    await waitFor(() => received.some((event) => event.sequence === 25))

    const durable = received.filter(
      (event) => event.type !== 'session.subscribed' && event.type !== 'session.projection',
    )
    expect(durable.map((event) => event.sequence)).toEqual(
      Array.from({ length: 26 }, (_value, index) => index),
    )
    expect(durable.map((event) => event.type)).toEqual([
      'session.system',
      'turn.started',
      'message.user',
      'step.started',
      'message.delta',
      'tool.updated',
      'tool.updated',
      'tool.updated',
      'tool.updated',
      'deliverables.presented',
      'message.delta',
      'step.ended',
      'turn.ended',
      'turn.started',
      'message.user',
      'step.started',
      'tool.updated',
      'tool.updated',
      'tool.updated',
      'tool.updated',
      'tool.updated',
      'tool.updated',
      'message.completed',
      'deliverables.presented',
      'step.ended',
      'turn.ended',
    ])
    expect(recoveryRanges).toEqual([
      [0, 4],
      [6, 7],
      [9, 12],
      [14, 15],
      [17, 21],
      [23, 24],
    ])
    expect(received.filter((event) => event.type === 'session.projection').map((event) => event.key)).toEqual(
      ['tokenUsage', 'contextPressure', 'tokenUsage', 'contextPressure'],
    )
    expect(received.filter((event) => event.sequence === 5 && event.type === 'tool.updated')).toHaveLength(1)
    expect(received.filter((event) => event.type === 'session.gap')).toHaveLength(0)
    expect(durable.find((event) => event.sequence === 7)).toMatchObject({
      type: 'tool.updated',
      tool: { id: 'call-1', status: 'failed', error: 'permission denied' },
    })
    expect(durable.find((event) => event.sequence === 18)).toMatchObject({
      type: 'tool.updated',
      tool: { id: 'call-3:ptc:1', parentCallId: 'call-3', status: 'failed' },
    })
    expect(durable.find((event) => event.sequence === 17)).toMatchObject({
      type: 'tool.updated',
      tool: { id: 'call-3:ptc:1', parentCallId: 'call-3', status: 'running' },
    })
    expect(durable.find((event) => event.sequence === 9)).toMatchObject({
      type: 'deliverables.presented',
      files: [{ path: 'artifacts/inspection.md' }, { path: 'artifacts/summary.json' }],
    })
    expect(durable.find((event) => event.sequence === 23)).toMatchObject({
      type: 'deliverables.presented',
      files: [{ path: 'artifacts/verified.txt' }],
    })
  })

  it('holds a reconnect tail behind the higher subscription baseline', async () => {
    const stream = new ControlledStream()
    const recoveryRanges: Array<[number, number]> = []
    const controller = new DshStreamController(
      streamTransport([]),
      undefined,
      (_sessionId, fromSequence, toSequence) => {
        recoveryRanges.push([fromSequence, toSequence])
        return Promise.resolve([recoveredTurn('s1', 2), recoveredTurn('s1', 3)])
      },
      { streamSource: stream.source, closeTransport: false },
    )
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(subscribeFrame('s1', 0))
    stream.push(liveTurnFrame('s1', 1))
    await waitFor(() => received.some((event) => event.sequence === 1))
    stream.push(subscribeFrame('s1', 3))
    stream.push(liveTurnFrame('s1', 4))
    await waitFor(() => received.some((event) => event.sequence === 4))

    expect(recoveryRanges).toEqual([[2, 3]])
    expect(
      received
        .map((event) => event.sequence)
        .filter((sequence): sequence is number => sequence !== undefined),
    ).toEqual([1, 2, 3, 4])
  })

  it('does not treat a pre-subscription history snapshot as a live gap', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: stream.source,
      closeTransport: false,
    })
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    // Alpha session/follow can return a bounded tail beginning above zero,
    // followed by the cursor that makes the snapshot's boundary explicit.
    stream.push(liveTurnFrame('s1', 1))
    stream.push(liveTurnFrame('s1', 2))
    stream.push(subscribeFrame('s1', 2))
    await waitFor(() => received.some((event) => event.type === 'session.subscribed'))

    expect(received.some((event) => event.type === 'session.gap')).toBe(false)
    expect(received.filter((event) => event.sequence === 1)).toHaveLength(1)
    expect(received.filter((event) => event.sequence === 2)).toHaveLength(1)
  })

  it('announces the whole hole as a gap when history recovery fails', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(
      streamTransport([]),
      undefined,
      () => Promise.reject(new Error('history is unavailable')),
      { streamSource: stream.source, closeTransport: false },
    )
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(subscribeFrame('s1', 5))
    await waitFor(() => received.some((event) => event.type === 'session.subscribed'))
    stream.push(liveTurnFrame('s1', 10))
    await waitFor(() => received.some((event) => event.type === 'session.gap'))
    const gap = received.find((event) => event.type === 'session.gap')
    expect(gap).toMatchObject({
      type: 'session.gap',
      sessionId: 's1',
      fromSequence: 6,
      toSequence: 9,
    })
    // The live event still reached consumers despite the failed replay.
    expect(received.some((event) => event.sequence === 10)).toBe(true)
  })

  it.each([
    { label: 'missing', seq: undefined },
    { label: 'negative', seq: -1 },
    { label: 'negative zero', seq: -0 },
    { label: 'unsafe integer', seq: Number.MAX_SAFE_INTEGER + 1 },
    { label: 'string', seq: '1' },
  ])(
    'rejects a durable session event with $label seq and heals its position from history after reconnect',
    async ({ seq }) => {
      const firstStream = new ControlledStream()
      const secondStream = new ControlledStream()
      const recoveryRanges: Array<[number, number]> = []
      const recovered: BackendEvent = {
        type: 'message.completed',
        sessionId: 's1',
        messageId: 'assistant-gap-fill',
        markdown: 'Recovered answer',
        turn: 1,
        step: 1,
        sequence: 1,
      }
      const controller = new DshStreamController(
        controlledGenerationTransport([firstStream, secondStream]),
        undefined,
        (_sessionId, fromSequence, toSequence) => {
          recoveryRanges.push([fromSequence, toSequence])
          return Promise.resolve([recovered])
        },
        { closeTransport: false },
      )
      controllers.push(controller)
      const received: BackendEvent[] = []
      controller.subscribe((event) => received.push(event))

      firstStream.push(subscribeFrame('s1', 0))
      await waitFor(() => received.some((event) => event.type === 'session.subscribed'))
      firstStream.push({
        payload: {
          type: 'session/event',
          sessionId: 's1',
          event: {
            type: 'assistant/message',
            ...(seq === undefined ? {} : { seq }),
            time: 1,
            data: {
              turn: 1,
              step: 1,
              message: {
                id: 'assistant-gap-fill',
                role: 'assistant',
                source: { kind: 'model', provider: 'provider-a', model: 'model-a' },
                content: [{ type: 'text', text: 'Recovered answer' }],
              },
              stream: [],
            },
          },
        },
      })

      await waitFor(() => received.some((event) => event.type === 'connection.lost'))
      expect(received.some((event) => event.type === 'message.completed')).toBe(false)
      expect(received.find((event) => event.type === 'connection.lost')).toMatchObject({
        reason: 'DSH event stream disconnected: Malformed DSH session event sequence.',
      })

      await waitForAtMost(() => secondStream.signal !== undefined, 2_000)
      secondStream.push(subscribeFrame('s1', 0))
      await waitFor(() => received.filter((event) => event.type === 'session.subscribed').length === 2)
      secondStream.push(canonicalFrame('s1', 2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))

      await waitForAtMost(() => received.some((event) => event.sequence === 2), 2_000)
      expect(recoveryRanges).toEqual([[1, 1]])
      expect(
        received.filter((event) => event.type === 'message.completed').map((event) => event.sequence),
      ).toEqual([1])
      expect(
        received
          .map((event) => event.sequence)
          .filter((sequence): sequence is number => sequence !== undefined),
      ).toEqual([1, 2])
      expect(received.some((event) => event.type === 'session.gap')).toBe(false)
    },
  )

  it('announces the uncovered remainder after a partial history replay', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(
      streamTransport([]),
      undefined,
      () => Promise.resolve([recoveredTurn('s1', 6)]),
      { streamSource: stream.source, closeTransport: false },
    )
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(subscribeFrame('s1', 5))
    await waitFor(() => received.some((event) => event.type === 'session.subscribed'))
    stream.push(liveTurnFrame('s1', 10))
    await waitFor(() => received.some((event) => event.type === 'session.gap'))
    expect(received.find((event) => event.type === 'session.gap')).toMatchObject({
      type: 'session.gap',
      sessionId: 's1',
      fromSequence: 7,
      toSequence: 9,
    })
  })

  it('emits the gap synchronously when no recovery callback is configured', async () => {
    const stream = new ControlledStream()
    const controller = new DshStreamController(streamTransport([]), undefined, undefined, {
      streamSource: stream.source,
      closeTransport: false,
    })
    controllers.push(controller)
    const received: BackendEvent[] = []
    controller.subscribe((event) => received.push(event))

    stream.push(subscribeFrame('s1', 5))
    await waitFor(() => received.some((event) => event.type === 'session.subscribed'))
    stream.push(liveTurnFrame('s1', 10))
    await waitFor(() => received.some((event) => event.sequence === 10))
    const gapIndex = received.findIndex((event) => event.type === 'session.gap')
    expect(gapIndex).toBeGreaterThanOrEqual(0)
    expect(received.findIndex((event) => event.sequence === 10)).toBeGreaterThan(gapIndex)
    expect(received[gapIndex]).toMatchObject({ fromSequence: 6, toSequence: 9 })
  })

  it('serializes recoveries per session and aborts them on close', async () => {
    const stream = new ControlledStream()
    const releaseFirst = { resolve: (): void => undefined }
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst.resolve = resolve
    })
    const recoverSignals: AbortSignal[] = []
    const controller = new DshStreamController(
      streamTransport([]),
      undefined,
      async (_sessionId, _from, _to, signal) => {
        recoverSignals.push(signal)
        if (recoverSignals.length === 1) await firstBarrier
        return []
      },
      { streamSource: stream.source, closeTransport: false },
    )
    controllers.push(controller)
    controller.subscribe(() => undefined)

    stream.push(subscribeFrame('s1', 0))
    await new Promise((resolve) => setTimeout(resolve, 10))
    stream.push(liveTurnFrame('s1', 10))
    await new Promise((resolve) => setTimeout(resolve, 10))
    stream.push(liveTurnFrame('s1', 20))
    await new Promise((resolve) => setTimeout(resolve, 10))
    // Both holes queued for one session; only the first recovery is running.
    expect(recoverSignals).toHaveLength(1)
    releaseFirst.resolve()
    await waitFor(() => recoverSignals.length === 2)
    await controller.close()
    expect(recoverSignals.every((signal) => signal.aborted)).toBe(true)
    // Closing while the second recovery runs must not leave it hanging.
    stream.end()
  })
})

/** Each mux (re)open yields the next generation's frames, then ends the stream. */
function reconnectingTransport(generations: readonly (readonly unknown[])[]): DshTransport {
  let nextGeneration = 0
  const open = async function* (signal: AbortSignal): AsyncIterable<unknown> {
    const index = nextGeneration
    nextGeneration += 1
    yield* generations[index] ?? generations[generations.length - 1] ?? []
    if (index >= generations.length - 1) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  }
  return {
    request: <T>() => Promise.reject<T>(new Error('request is not used by this test')),
    remoteRequest: <T>() => Promise.reject<T>(new Error('remoteRequest is not used by this test')),
    openEventStream: open,
    openMuxStream: open,
    close: () => Promise.resolve(),
  }
}

function controlledGenerationTransport(generations: readonly ControlledStream[]): DshTransport {
  let nextGeneration = 0
  const open = (signal: AbortSignal): AsyncIterable<unknown> => {
    const stream = generations[nextGeneration] ?? generations[generations.length - 1]
    nextGeneration += 1
    return stream?.source(signal) ?? streamTransport([]).openEventStream(signal)
  }
  return {
    request: <T>() => Promise.reject<T>(new Error('request is not used by this test')),
    remoteRequest: <T>() => Promise.reject<T>(new Error('remoteRequest is not used by this test')),
    openEventStream: open,
    openMuxStream: open,
    close: () => Promise.resolve(),
  }
}

function controlledGenerationSource(
  generations: readonly ControlledStream[],
): (signal: AbortSignal) => AsyncIterable<unknown> {
  const transport = controlledGenerationTransport(generations)
  return (signal) => transport.openEventStream(signal)
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
  expect(predicate()).toBe(true)
}

/** Waits long enough for a reconnect backoff to elapse before asserting. */
async function waitForAtMost(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !predicate()) await new Promise((resolve) => setTimeout(resolve, 25))
  expect(predicate()).toBe(true)
}
