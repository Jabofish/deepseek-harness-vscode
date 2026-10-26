import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '@dsh-vscode/domain'

import type { DshTransport } from '../src/contracts.js'
import { AlphaEventSource } from '../src/versions/alpha/events.js'
import type { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'
import { Rc6InteractionRepository } from '../src/repositories/interaction-repository.js'

interface FakeAlphaTransport extends DshTransport {
  readonly sessionStreamOpens: Map<string, number>
  openWorkspaceStream(signal: AbortSignal): AsyncIterable<unknown>
  openSessionStream(sessionId: string, signal: AbortSignal): AsyncIterable<unknown>
}

function fakeAlphaTransport(
  options: {
    readonly failSessionStream?: string
    readonly removeSession?: string
    readonly archiveSession?: string
  } = {},
): FakeAlphaTransport {
  const sessionStreamOpens = new Map<string, number>()
  const holdUntilAborted = (signal: AbortSignal): AsyncIterable<unknown> => ({
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<never>> {
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve()
              return
            }
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          return { done: true, value: undefined }
        },
      }
    },
  })
  return {
    request: <T>() => Promise.reject<T>(new Error('request is not used by this test')),
    remoteRequest: <T>() => Promise.reject<T>(new Error('remoteRequest is not used by this test')),
    openEventStream: async function* (signal: AbortSignal) {
      if (options.removeSession !== undefined)
        yield { payload: { type: 'host/session-removed', sessionId: options.removeSession } }
      yield* holdUntilAborted(signal)
    },
    openWorkspaceStream: (signal: AbortSignal) =>
      (async function* () {
        if (options.archiveSession !== undefined) {
          while (!signal.aborted && (sessionStreamOpens.get(options.archiveSession) ?? 0) === 0)
            await new Promise((resolve) => setTimeout(resolve, 5))
          if (!signal.aborted)
            yield {
              payload: {
                type: 'host/archived-sessions-changed',
                sessionIds: [options.archiveSession],
              },
            }
        }
        yield* holdUntilAborted(signal)
      })(),
    openSessionStream: (sessionId: string) => {
      sessionStreamOpens.set(sessionId, (sessionStreamOpens.get(sessionId) ?? 0) + 1)
      const firstFrame: Promise<unknown> =
        options.failSessionStream === sessionId
          ? Promise.reject(new Error('session follow stream failed for this test'))
          : Promise.resolve({ payload: { type: 'session/subscribed', sessionId, lastSeq: 0 } })
      // A failing stream rejects on first read; a removed session's host ends
      // the stream after the subscribed frame.
      return (async function* () {
        yield await firstFrame
      })()
    },
    close: () => Promise.resolve(),
    sessionStreamOpens,
  }
}

async function waitForAtMost(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !predicate()) await new Promise((resolve) => setTimeout(resolve, 25))
  expect(predicate()).toBe(true)
}

describe('AlphaEventSource session lifecycle', () => {
  it('changes preview demand by rebaselining only that session and retains its durable subscription', async () => {
    const transport = fakeAlphaTransport()
    const open = vi.fn((sessionId: string, signal: AbortSignal, _preview?: boolean) =>
      (async function* () {
        yield { payload: { type: 'session/subscribed', sessionId, lastSeq: 0 } }
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
      })(),
    )
    transport.openSessionStream = open
    const source = new AlphaEventSource(transport as unknown as AlphaLoopbackApiClient & DshTransport)
    const received: BackendEvent[] = []
    const unsubscribe = source.subscribe((event) => received.push(event))
    try {
      source.watchSession('s1')
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
      source.setSessionPreview('s1', false)
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2))
      expect(open.mock.calls[1]?.[2]).toBe(false)
      source.setSessionPreview('s1', false)
      await Promise.resolve()
      expect(open).toHaveBeenCalledTimes(2)
      source.setSessionPreview('s1', true)
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(3))
      expect(open.mock.calls[2]?.[2]).toBe(true)
      expect(received.some((event) => event.type === 'connection.lost')).toBe(false)
    } finally {
      unsubscribe()
      await source.close()
    }
  })
  it('stops following a session after the host announces its removal', async () => {
    const transport = fakeAlphaTransport({ removeSession: 's1' })
    const source = new AlphaEventSource(transport as unknown as AlphaLoopbackApiClient & DshTransport)
    const received: BackendEvent[] = []
    const unsubscribe = source.subscribe((event) => received.push(event))
    source.watchSession('s1')
    await waitForAtMost(() => transport.sessionStreamOpens.get('s1') === 1, 1_000)

    await waitForAtMost(() => received.some((event) => event.type === 'session.removed'), 1_000)
    // A removed session's follow stream cannot come back: the controller must
    // not reconnect against a session the host no longer has.
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(transport.sessionStreamOpens.get('s1')).toBe(1)

    unsubscribe()
    await source.close()
  })
})

/** Streams hang open until aborted, so a live-set member is one open stream. */
interface HangingAlphaTransport extends DshTransport {
  readonly sessionStreamOpens: Map<string, number>
  readonly jobStreamOpens: Map<string, number>
  readonly liveSessionStreams: Set<string>
  readonly liveJobStreams: Set<string>
  readonly announce: (frame: unknown) => void
  readonly jobRows: (sessionId: string, signal: AbortSignal) => AsyncIterable<unknown>
  openWorkspaceStream(signal: AbortSignal): AsyncIterable<unknown>
  openSessionStream(sessionId: string, signal: AbortSignal): AsyncIterable<unknown>
}

function hangingAlphaTransport(): HangingAlphaTransport {
  const sessionStreamOpens = new Map<string, number>()
  const jobStreamOpens = new Map<string, number>()
  const liveSessionStreams = new Set<string>()
  const liveJobStreams = new Set<string>()
  const hostFrames: unknown[] = []
  const hang = (signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  const holdOpen = (signal: AbortSignal): AsyncIterable<never> => ({
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<never>> {
          await hang(signal)
          return { done: true, value: undefined }
        },
      }
    },
  })
  const count = (opens: Map<string, number>, sessionId: string): number => {
    const next = (opens.get(sessionId) ?? 0) + 1
    opens.set(sessionId, next)
    return next
  }
  return {
    request: <T>() => Promise.reject<T>(new Error('request is not used by this test')),
    remoteRequest: <T>() => Promise.reject<T>(new Error('remoteRequest is not used by this test')),
    // The host-wide stream drains announced frames whenever they arrive.
    openEventStream: (signal: AbortSignal) =>
      (async function* () {
        while (!signal.aborted) {
          const frame = hostFrames.shift()
          if (frame === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 10))
            continue
          }
          yield { payload: frame }
        }
      })(),
    openWorkspaceStream: (signal: AbortSignal) => holdOpen(signal),
    openSessionStream: (sessionId: string, signal: AbortSignal) =>
      (async function* () {
        count(sessionStreamOpens, sessionId)
        liveSessionStreams.add(sessionId)
        try {
          yield { payload: { type: 'session/subscribed', sessionId, lastSeq: 0 } }
          await hang(signal)
        } finally {
          liveSessionStreams.delete(sessionId)
        }
      })(),
    jobRows: (sessionId: string, signal: AbortSignal) =>
      (async function* () {
        count(jobStreamOpens, sessionId)
        liveJobStreams.add(sessionId)
        try {
          yield { type: 'jobs.updated', sessionId, jobs: [] }
          await hang(signal)
        } finally {
          liveJobStreams.delete(sessionId)
        }
      })(),
    close: () => Promise.resolve(),
    sessionStreamOpens,
    jobStreamOpens,
    liveSessionStreams,
    liveJobStreams,
    announce: (frame) => {
      hostFrames.push(frame)
    },
  }
}

describe('AlphaEventSource follow policy', () => {
  it.each(['session', 'workspace', 'job', 'host'] as const)(
    'preserves live question ownership across a %s stream failure only when the host remains connected',
    async (scope) => {
      const transport = hangingAlphaTransport()
      let fail!: (reason: Error) => void
      const failure = new Promise<never>((_resolve, reject) => {
        fail = reject
      })
      let interrupted = false
      let first = true
      const failFirst = (next: () => AsyncIterable<unknown>): AsyncIterable<unknown> =>
        (async function* () {
          if (first) {
            first = false
            try {
              yield await failure
            } finally {
              interrupted = true
            }
          }
          yield* next()
        })()
      if (scope === 'host') {
        const original = transport.openEventStream.bind(transport)
        transport.openEventStream = (signal) => failFirst(() => original(signal))
      } else if (scope === 'workspace') {
        const original = transport.openWorkspaceStream.bind(transport)
        transport.openWorkspaceStream = (signal) => failFirst(() => original(signal))
      } else if (scope === 'session') {
        const original = transport.openSessionStream.bind(transport)
        transport.openSessionStream = (sessionId, signal) =>
          sessionId === 's1' ? failFirst(() => original(sessionId, signal)) : original(sessionId, signal)
      }
      const jobRows =
        scope === 'job'
          ? (sessionId: string, signal: AbortSignal): AsyncIterable<unknown> =>
              sessionId === 's1'
                ? failFirst(() => transport.jobRows(sessionId, signal))
                : transport.jobRows(sessionId, signal)
          : transport.jobRows
      const respondEnvelope = vi.fn(() => Promise.resolve({ accepted: true }))
      const interactions = new Rc6InteractionRepository(
        { ...transport, respondEnvelope },
        {
          resetPendingOnSubscribe: false,
          onSettled: (event) => source.publish(event),
        },
      )
      const observed: BackendEvent[] = []
      const source = new AlphaEventSource(
        transport as unknown as AlphaLoopbackApiClient & DshTransport,
        (event) => {
          observed.push(event)
          interactions.remember(event)
        },
        undefined,
        jobRows,
      )
      const received: BackendEvent[] = []
      const unsubscribe = source.subscribe((event) => received.push(event))
      source.watchSession('s1')
      source.watchSession('s2')
      try {
        for (const sessionId of ['s1', 's2'])
          source.publish({
            type: 'question.requested',
            question: {
              id: `q-${sessionId}`,
              rpcId: `rpc-${sessionId}`,
              sessionId,
              prompt: 'Fixture question',
              allowFreeText: true,
            },
          })
        expect(interactions.sessionForQuestion('q-s1')).toBe('s1')
        expect(interactions.sessionForQuestion('q-s2')).toBe('s2')
        fail(new Error('Fixture stream interruption'))
        await waitForAtMost(() => interrupted, 1000)
        // Let the controller's observer and listener delivery both finish.
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (scope === 'host') {
          expect(observed.some((event) => event.type === 'connection.lost')).toBe(true)
          expect(received.some((event) => event.type === 'connection.lost')).toBe(true)
          expect(interactions.sessionForQuestion('q-s1')).toBeUndefined()
          expect(interactions.sessionForQuestion('q-s2')).toBeUndefined()
          await expect(interactions.respondToQuestion('q-s1', 'answer')).rejects.toMatchObject({
            code: 'STALE_INTERACTION',
          })
          expect(respondEnvelope).not.toHaveBeenCalled()
        } else {
          expect(interactions.sessionForQuestion('q-s1')).toBe('s1')
          expect(interactions.sessionForQuestion('q-s2')).toBe('s2')
          expect(observed.some((event) => event.type === 'connection.lost')).toBe(false)
          expect(received.some((event) => event.type === 'connection.lost')).toBe(false)
          await expect(interactions.respondToQuestion('q-s1', 'answer')).resolves.toBeUndefined()
          await expect(interactions.cancelQuestion('q-s2')).resolves.toBeUndefined()
          expect(respondEnvelope.mock.calls).toHaveLength(2)
        }
      } finally {
        fail(new Error('Fixture cleanup'))
        unsubscribe()
        await source.close()
      }
    },
  )

  it('keepJobRows releases the conversation stream but preserves Job row updates', async () => {
    const transport = hangingAlphaTransport()
    const source = new AlphaEventSource(
      transport as unknown as AlphaLoopbackApiClient & DshTransport,
      undefined,
      undefined,
      transport.jobRows,
    )
    const unsubscribe = source.subscribe(() => undefined)
    source.watchSession('s1')
    await waitForAtMost(
      () => transport.sessionStreamOpens.get('s1') === 1 && transport.jobStreamOpens.get('s1') === 1,
      1_000,
    )

    source.unwatchSession('s1', { keepJobRows: true })
    await waitForAtMost(() => transport.liveSessionStreams.size === 0, 1_000)
    expect(transport.liveJobStreams.has('s1')).toBe(true)

    // Re-following reuses the preserved Job stream instead of leaking a second
    // one for the same session.
    source.watchSession('s1')
    await waitForAtMost(() => transport.liveSessionStreams.has('s1'), 1_000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(transport.jobStreamOpens.get('s1')).toBe(1)

    // A full unwatch closes both streams.
    source.unwatchSession('s1')
    await waitForAtMost(
      () => transport.liveSessionStreams.size === 0 && transport.liveJobStreams.size === 0,
      1_000,
    )

    unsubscribe()
    await source.close()
  })
})
