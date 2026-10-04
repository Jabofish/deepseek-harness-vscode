import { describe, expect, it } from 'vitest'

import { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'
import { Alpha211AccountLifecycleRepository } from '../src/versions/alpha211/account-repository.js'
import { Alpha211PluginBundleRepository } from '../src/versions/alpha211/plugin-manager-repository.js'
import { Alpha211ScheduleRepository } from '../src/versions/alpha211/schedule-repository.js'
import { Rc201ScheduleRepository } from '../src/versions/rc201/schedule-repository.js'
import { Rc172AccountLifecycleRepository } from '../src/versions/rc172/account-repository.js'
import {
  failedAccountAttempt,
  installedBundle,
  retiredBundle,
  scheduleUpdate,
  subagentScheduleRefusal,
} from './fixtures/alpha211-contract.js'
import { endpoint, transportOptions, wrappedResponse } from './support/contract-harness.js'

describe('DSH 0.2.1-alpha.1 incremental contract', () => {
  it('preserves upstream removal eligibility for retired selections while omitting bundle source', async () => {
    const fetch: typeof globalThis.fetch = (_url, init) =>
      Promise.resolve(wrappedResponse(init, [retiredBundle]))
    const transport = new AlphaLoopbackApiClient({ endpoint, ...transportOptions(fetch) })
    try {
      await expect(new Alpha211PluginBundleRepository(transport).listBundles()).resolves.toEqual([
        {
          name: retiredBundle.name,
          enabled: true,
          installed: false,
          optional: false,
          removable: true,
          errorCode: 'not-bundle',
          rows: [],
          overrides: [],
        },
      ])
    } finally {
      await transport.close()
    }
  })
  it.each([undefined, '', 42, 'x'.repeat(2_001)])(
    'rejects a malformed refusal message (%s)',
    async (message) => {
      const fetch: typeof globalThis.fetch = (_url, init) =>
        Promise.resolve(wrappedResponse(init, { code: 'subagent_session', message }))
      const transport = new AlphaLoopbackApiClient({ endpoint, ...transportOptions(fetch) })
      try {
        await expect(new Alpha211ScheduleRepository(transport).update(scheduleUpdate)).rejects.toMatchObject({
          code: 'PROTOCOL_ERROR',
        })
      } finally {
        await transport.close()
      }
    },
  )

  it('keeps older Schedule and account contracts strict', async () => {
    const fetch: typeof globalThis.fetch = (_url, init) =>
      Promise.resolve(wrappedResponse(init, subagentScheduleRefusal))
    const transport = new AlphaLoopbackApiClient({ endpoint, ...transportOptions(fetch) })
    try {
      await expect(new Rc201ScheduleRepository(transport).update(scheduleUpdate)).rejects.toMatchObject({
        code: 'PROTOCOL_ERROR',
      })
      const account = new Rc172AccountLifecycleRepository({
        remoteRequest: () => Promise.resolve({ ok: true, value: failedAccountAttempt }),
        async *openRemoteStream() {
          /* No subscription on this older profile. */
        },
      })
      await expect(account.getState()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    } finally {
      await transport.close()
    }
  })

  it('rejects an unknown account failure and leaves the upstream snapshot immutable', async () => {
    const account = new Alpha211AccountLifecycleRepository({
      remoteRequest: () =>
        Promise.resolve({
          ok: true,
          value: {
            ...failedAccountAttempt,
            attempt: { ...failedAccountAttempt.attempt, errorCode: 'future-error' },
          },
        }),
      async *openRemoteStream() {
        /* No subscription is needed for this read. */
      },
    })
    await expect(account.getState()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(failedAccountAttempt.attempt.errorCode).toBe('no-response')
  })

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

  it('keeps the installed manifest version through install recovery and omits source', async () => {
    const fetch: typeof globalThis.fetch = (_url, init) =>
      Promise.resolve(wrappedResponse(init, installedBundle))
    const transport = new AlphaLoopbackApiClient({ endpoint, ...transportOptions(fetch) })
    const repository = new Alpha211PluginBundleRepository(transport)
    try {
      const installed = await repository.installBundle('fixture-bundle', { requestId: 'install-1' })
      expect(installed).toEqual({
        name: 'fixture-bundle',
        stage: 'install',
        bundle: 'fixture-bundle',
        version: '1.2.3',
        enabled: true,
        changed: true,
        application: 'restart-required',
      })
      await expect(repository.waitForInstall('install-1')).resolves.toEqual(installed)
    } finally {
      await transport.close()
    }
  })
})
