import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent, JobFollowFrame } from '@dsh-vscode/domain'

vi.mock('vscode', () => ({}))

import { JobFollowRegistry, relayJobFollowFrames, resolveJobFollowOffset } from './composition-root.js'

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
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

  it('does not let a delayed stop for an older generation abort the replacement follow', async () => {
    const follows = new JobFollowRegistry()
    const key = 'session-1/job-1'
    const olderController = new AbortController()
    const newerController = new AbortController()
    const olderStream = new AbortController()
    const newerStream = new AbortController()

    await follows.start(
      key,
      'follow-old',
      olderController.signal,
      () => Promise.resolve(undefined),
      (_value, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              olderStream.abort()
              resolve()
            },
            { once: true },
          ),
        ),
    )
    await follows.start(
      key,
      'follow-new',
      newerController.signal,
      () => Promise.resolve(undefined),
      (_value, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              newerStream.abort()
              resolve()
            },
            { once: true },
          ),
        ),
    )

    // This represents a stop request that was queued for the first start and
    // only reaches the Host after the replacement has become active.
    expect(follows.stop(key, 'follow-old')).toBe(false)

    expect({ olderAborted: olderStream.signal.aborted, newerAborted: newerStream.signal.aborted }).toEqual({
      olderAborted: true,
      newerAborted: false,
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

  it('does not publish a failure event when the user stops the observer', async () => {
    const follows = new JobFollowRegistry()
    const events: BackendEvent[] = []
    const reportedErrors: unknown[] = []
    const waitingForStop = deferred()
    const relayFinished = deferred()

    const started = await follows.start(
      'session-1/job-1',
      identity.followId,
      new AbortController().signal,
      () => Promise.resolve(undefined),
      (_value, signal) => {
        const frames: AsyncIterable<JobFollowFrame> = {
          async *[Symbol.asyncIterator]() {
            yield frame
            waitingForStop.resolve()
            await new Promise<never>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
            })
          },
        }
        return relayJobFollowFrames({
          ...identity,
          frames,
          signal,
          publish: (event) => events.push(event),
          onFailure: (error) => reportedErrors.push(error),
        }).finally(relayFinished.resolve)
      },
    )

    await waitingForStop.promise
    expect(follows.stop('session-1/job-1', identity.followId)).toBe(true)
    await relayFinished.promise

    expect(started).toBe(true)
    expect(events).toEqual([{ type: 'job.follow.updated', ...identity, frame }])
    expect(reportedErrors).toEqual([])
  })
})
