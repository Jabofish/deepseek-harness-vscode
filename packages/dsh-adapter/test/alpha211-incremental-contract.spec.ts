import { describe, expect, it } from 'vitest'

import { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'
import { Alpha211AccountLifecycleRepository } from '../src/versions/alpha211/account-repository.js'
import { Alpha211PluginBundleRepository } from '../src/versions/alpha211/plugin-manager-repository.js'
import { Alpha211ScheduleRepository } from '../src/versions/alpha211/schedule-repository.js'

import {
  failedAccountAttempt,
  installedBundle,
  scheduleUpdate,
  subagentScheduleRefusal,
} from './fixtures/alpha211-contract.js'
import { endpoint, transportOptions, wrappedResponse } from './support/contract-harness.js'

describe('DSH 0.2.1-alpha.1 incremental contract', () => {
  it.each(['', '/private/bundle', 42, '1.2.3 secret', '1'.repeat(129)])(
    'rejects an unsafe installed version (%s) without retrying the mutation',
    async (version) => {
      let calls = 0
      const fetch: typeof globalThis.fetch = (_url, init) => {
        calls += 1
        return Promise.resolve(wrappedResponse(init, { ...installedBundle, version }))
      }
      const transport = new AlphaLoopbackApiClient({
        endpoint,
        ...transportOptions(fetch),
        retryPolicy: { maximumAttempts: 3, baseDelayMs: 1, maximumDelayMs: 1 },
      })
      try {
        await expect(
          new Alpha211PluginBundleRepository(transport).installBundle('fixture-bundle', {
            requestId: 'install-1',
          }),
        ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
        expect(calls).toBe(1)
      } finally {
        await transport.close()
      }
    },
  )

  it('preserves the non-mutating delegated Session refusal', async () => {
    const fetch: typeof globalThis.fetch = (_url, init) =>
      Promise.resolve(wrappedResponse(init, subagentScheduleRefusal))
    const transport = new AlphaLoopbackApiClient({ endpoint, ...transportOptions(fetch) })
    try {
      await expect(new Alpha211ScheduleRepository(transport).update(scheduleUpdate)).resolves.toEqual(
        subagentScheduleRefusal,
      )
    } finally {
      await transport.close()
    }
  })

  it('maps no-response to the stable network failure in reads and watch frames', async () => {
    const repository = new Alpha211AccountLifecycleRepository({
      remoteRequest: () => Promise.resolve({ ok: true, value: failedAccountAttempt }),
      async *openRemoteStream() {
        yield await Promise.resolve(failedAccountAttempt)
      },
    })
    const expected = {
      status: 'signed-out',
      attempt: { ...failedAccountAttempt.attempt, errorCode: 'network' },
    }
    await expect(repository.getState()).resolves.toEqual(expected)
    const watch = repository.watch(new AbortController().signal)[Symbol.asyncIterator]()
    expect((await watch.next()).value).toEqual(expected)
    await watch.return?.()
  })
})
