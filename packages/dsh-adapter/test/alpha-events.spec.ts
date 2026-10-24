import { describe, expect, it } from 'vitest'
import type { BackendEvent } from '@dsh-vscode/domain'

import type { DshTransport } from '../src/contracts.js'
import { AlphaEventSource } from '../src/versions/alpha/events.js'
import type { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'

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

  it('keeps per-session stream retries off the shared connection.lost signal', async () => {
    // One session's follow stream failing is not a backend connection loss:
    // the global stream stays healthy and the per-session controller keeps
    // its own retry loop. Publishing connection.lost for it tears down
    // connection-scoped consumers while the backend is still connected.
    const transport = fakeAlphaTransport({
      failSessionStream: 's1',
    })
    const source = new AlphaEventSource(transport as unknown as AlphaLoopbackApiClient & DshTransport)
    const received: BackendEvent[] = []
    const unsubscribe = source.subscribe((event) => received.push(event))
    source.watchSession('s1')

    // The failing per-session stream keeps retrying...
    await waitForAtMost(() => (transport.sessionStreamOpens.get('s1') ?? 0) >= 2, 1_500)
    // ...without ever announcing a backend connection loss.
    expect(received.some((event) => event.type === 'connection.lost')).toBe(false)
    expect(received.filter((event) => event.type === 'notice')).toHaveLength(1)

    unsubscribe()
    await source.close()
  })

  it('re-baselines an existing follow stream when a session is opened again', async () => {
    const transport = fakeAlphaTransport()
    const source = new AlphaEventSource(transport as unknown as AlphaLoopbackApiClient & DshTransport)
    const unsubscribe = source.subscribe(() => undefined)
    source.watchSession('s1')
    await waitForAtMost(() => transport.sessionStreamOpens.get('s1') === 1, 1_000)

    await source.refreshSession('s1')
    await waitForAtMost(() => transport.sessionStreamOpens.get('s1') === 2, 1_000)

    unsubscribe()
    await source.close()
  })

  it('stops following a session after it enters the archive set', async () => {
    const transport = fakeAlphaTransport({ archiveSession: 's1' })
    const source = new AlphaEventSource(transport as unknown as AlphaLoopbackApiClient & DshTransport)
    const received: BackendEvent[] = []
    const unsubscribe = source.subscribe((event) => received.push(event))
    source.watchSession('s1')

    await waitForAtMost(() => received.some((event) => event.type === 'archived.sessions.changed'), 1_000)
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
  it('does not report a workspace-only interruption as a host connection loss', async () => {
    const transport = hangingAlphaTransport()
    let attempted = false
    transport.openWorkspaceStream = async function* () {
      attempted = true
      yield await Promise.reject(new Error('fixture workspace failure'))
    }
    const source = new AlphaEventSource(transport as unknown as AlphaLoopbackApiClient & DshTransport)
    const received: BackendEvent[] = []
    const unsubscribe = source.subscribe((event) => received.push(event))
    try {
      await waitForAtMost(() => attempted, 1_000)
      transport.announce({ type: 'host/session-added', sessionId: 'healthy', blank: false })
      await waitForAtMost(() => received.some((event) => event.type === 'session.added'), 1_000)
      expect(received.some((event) => event.type === 'connection.lost')).toBe(false)
    } finally {
      unsubscribe()
      await source.close()
    }
  })

  it('archiving also closes a Job stream retained after conversation unwatch', async () => {
    const transport = hangingAlphaTransport()
    const source = new AlphaEventSource(
      transport as unknown as AlphaLoopbackApiClient & DshTransport,
      undefined,
      undefined,
      transport.jobRows,
    )
    const received: BackendEvent[] = []
    const unsubscribe = source.subscribe((event) => received.push(event))
    try {
      source.watchSession('s')
      await waitForAtMost(() => transport.liveJobStreams.has('s'), 1_000)
      source.unwatchSession('s', { keepJobRows: true })
      await waitForAtMost(() => !transport.liveSessionStreams.has('s'), 1_000)
      transport.announce({ type: 'host/archived-sessions-changed', sessionIds: ['s'] })
      await waitForAtMost(() => received.some((event) => event.type === 'archived.sessions.changed'), 1_000)
      await waitForAtMost(() => !transport.liveJobStreams.has('s'), 1_000)
    } finally {
      unsubscribe()
      await source.close()
    }
  })
  it('does not open a follow stream for a session the host announces', async () => {
    const transport = hangingAlphaTransport()
    transport.announce({ type: 'host/session-added', sessionId: 's-new', blank: false })
    const source = new AlphaEventSource(
      transport as unknown as AlphaLoopbackApiClient & DshTransport,
      undefined,
      undefined,
      transport.jobRows,
    )
    const received: BackendEvent[] = []
    const unsubscribe = source.subscribe((event) => received.push(event))

    await waitForAtMost(() => received.some((event) => event.type === 'session.added'), 1_000)
    expect(transport.sessionStreamOpens.get('s-new')).toBeUndefined()
    expect(transport.liveSessionStreams.size).toBe(0)

    unsubscribe()
    await source.close()
  })

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

  it('a removed session releases its preserved Job row stream as well', async () => {
    const transport = hangingAlphaTransport()
    const source = new AlphaEventSource(
      transport as unknown as AlphaLoopbackApiClient & DshTransport,
      undefined,
      undefined,
      transport.jobRows,
    )
    const received: BackendEvent[] = []
    const unsubscribe = source.subscribe((event) => received.push(event))
    source.watchSession('s1')
    await waitForAtMost(() => transport.jobStreamOpens.get('s1') === 1, 1_000)

    source.unwatchSession('s1', { keepJobRows: true })
    await waitForAtMost(() => transport.liveSessionStreams.size === 0, 1_000)
    expect(transport.liveJobStreams.has('s1')).toBe(true)

    transport.announce({ type: 'host/session-removed', sessionId: 's1' })
    await waitForAtMost(() => received.some((event) => event.type === 'session.removed'), 1_000)
    await waitForAtMost(
      () => transport.liveSessionStreams.size === 0 && transport.liveJobStreams.size === 0,
      1_000,
    )

    unsubscribe()
    await source.close()
  })
})
