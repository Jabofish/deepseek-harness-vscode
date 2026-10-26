import { describe, expect, it, vi } from 'vitest'
import type { BackendEndpoint, BackendEvent, JobFollowFrame } from '@dsh-vscode/domain'

vi.mock('vscode', () => ({}))

import {
  createManagedEndpointLoginHandler,
  JobFollowRegistry,
  relayJobFollowFrames,
  resolveJobFollowOffset,
} from './composition-root.js'

function deferred<T = void>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('JobFollowRegistry', () => {
  it('lets stop cancel a follow reserved while start validation is pending', async () => {
    const follows = new JobFollowRegistry()
    const checkStarted = deferred()
    const releaseCheck = deferred()
    const streamStarted = vi.fn()

    const starting = follows.start(
      'session-1/job-1',
      'follow-pending',
      new AbortController().signal,
      async () => {
        checkStarted.resolve()
        await releaseCheck.promise
        return 0
      },
      streamStarted,
    )

    await checkStarted.promise
    const stopped = follows.stop('session-1/job-1', 'follow-pending')
    releaseCheck.resolve()
    const started = await starting

    expect({ stopped, started, streams: streamStarted.mock.calls.length }).toEqual({
      stopped: true,
      started: false,
      streams: 0,
    })
  })

  it('releases a previously authorized observer after its session leaves the workspace', async () => {
    const follows = new JobFollowRegistry()
    const key = 'session-1/job-1'
    const signal = new AbortController().signal
    const stream = new AbortController()
    let sessionIsCurrent = true
    const started = await follows.start(
      key,
      'follow-authorized',
      signal,
      () =>
        sessionIsCurrent
          ? Promise.resolve(undefined)
          : Promise.reject(new Error('session is no longer current')),
      (_value, followSignal) =>
        new Promise<void>((resolve) =>
          followSignal.addEventListener(
            'abort',
            () => {
              stream.abort()
              resolve()
            },
            { once: true },
          ),
        ),
    )

    sessionIsCurrent = false

    expect(started).toBe(true)
    expect(follows.stop(key, 'follow-authorized')).toBe(true)
    expect(stream.signal.aborted).toBe(true)
  })
})

describe('Job follow cursor validation', () => {
  it('preserves a safe resume cursor beyond the latest list snapshot tail', () => {
    const staleJob = { output: { earliest: 0, total: 4 } }

    expect(resolveJobFollowOffset(staleJob, 12)).toBe(12)
  })
})

describe('Job follow stream relay', () => {
  const identity = { sessionId: 'session-1', jobId: 'job-1', followId: 'follow-1' }
  const frame: JobFollowFrame = { type: 'output', chunks: [], next: 1 }

  it('publishes a generic failure event with the authorized stream identity', async () => {
    const events: BackendEvent[] = []
    const reportedErrors: unknown[] = []
    const frames: AsyncIterable<JobFollowFrame> = {
      async *[Symbol.asyncIterator]() {
        yield frame
        await Promise.resolve()
        throw new Error('sensitive upstream response')
      },
    }

    await relayJobFollowFrames({
      ...identity,
      frames,
      signal: new AbortController().signal,
      publish: (event) => events.push(event),
      onFailure: (error) => reportedErrors.push(error),
    })

    expect(events).toEqual([
      { type: 'job.follow.updated', ...identity, frame },
      { type: 'job.follow.failed', ...identity, reason: 'stream-failed' },
    ])
    expect(JSON.stringify(events)).not.toContain('sensitive upstream response')
    expect(reportedErrors).toHaveLength(1)
  })
})

describe('managed endpoint login cancellation', () => {
  const endpoint: BackendEndpoint = {
    host: '127.0.0.1',
    port: 4317,
    baseUrl: 'http://127.0.0.1:4317',
  }

  it('rejects a managed login URL with a different origin before sending its token', async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>()
    const handler = createManagedEndpointLoginHandler(new Map(), new Map(), fetcher)
    await expect(
      handler(endpoint, 'https://other.example/?token=fixture', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
