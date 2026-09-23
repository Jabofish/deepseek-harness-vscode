import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({}))

import { JobFollowRegistry } from './composition-root.js'

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
      new AbortController().signal,
      async () => {
        checkStarted.resolve()
        await releaseCheck.promise
        return 0
      },
      streamStarted,
    )

    await checkStarted.promise
    const stopped = follows.stop('session-1/job-1')
    releaseCheck.resolve()
    const started = await starting

    expect({ stopped, started, streams: streamStarted.mock.calls.length }).toEqual({
      stopped: true,
      started: false,
      streams: 0,
    })
  })
})
