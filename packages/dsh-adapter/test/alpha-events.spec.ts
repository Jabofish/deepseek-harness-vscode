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
  options: { readonly failSessionStream?: string; readonly removeSession?: string } = {},
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
    openWorkspaceStream: (signal: AbortSignal) => holdUntilAborted(signal),
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

    unsubscribe()
    await source.close()
  })
})
