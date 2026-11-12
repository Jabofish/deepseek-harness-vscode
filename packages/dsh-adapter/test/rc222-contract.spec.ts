import { describe, expect, it, vi, type Mock } from 'vitest'
import type { BackendEvent, SessionProjectionValues } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import { Rc222VersionAdapter } from '../src/versions/rc222/adapter.js'
import { Rc222AccountLifecycleRepository } from '../src/versions/rc222/account-repository.js'
import { Rc222PluginBundleRepository } from '../src/versions/rc222/plugin-manager-repository.js'
import type { AccountRemoteTransport } from '../src/versions/rc172/account-repository.js'
import { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'
import { ProbeFixtureTransport } from './support/probe-fixture.js'
import {
  bodyText,
  candidate,
  endpoint,
  transportOptions,
  wrappedResponse,
} from './support/contract-harness.js'
import {
  rc222AccountState,
  rc222Notification,
  rc222NamedChild,
  rc222Team,
} from './fixtures/rc222-contract.js'

const client = { version: 'fixture', locale: 'en', timezoneOffsetSeconds: 0 }

class Adapter extends Rc222VersionAdapter {
  public normalize(value: unknown): readonly unknown[] | undefined {
    return this.createTransportOptions(endpoint).normalizeControlFrame?.(value)
  }
  public project(values: Readonly<Record<string, unknown>>): SessionProjectionValues {
    return this.mapProjectionValues(values)
  }
  public event(event: BackendEvent): BackendEvent {
    return this.mapBackendEvent(event)
  }
}

function accountFixture(
  reply: unknown,
  updates: readonly unknown[] = [],
): {
  readonly repository: Rc222AccountLifecycleRepository
  readonly remoteRequest: Mock<AccountRemoteTransport['remoteRequest']>
  readonly openRemoteStream: Mock<AccountRemoteTransport['openRemoteStream']>
  readonly streamsClosed: () => number
} {
  let streamsClosed = 0
  const remoteRequest = vi.fn<AccountRemoteTransport['remoteRequest']>((_method, _args, signal) => {
    signal?.throwIfAborted()
    return Promise.resolve({ ok: true, value: reply })
  })
  const openRemoteStream = vi.fn<AccountRemoteTransport['openRemoteStream']>(async function* () {
    try {
      await Promise.resolve()
      yield* updates
    } finally {
      streamsClosed += 1
    }
  })
  return {
    repository: new Rc222AccountLifecycleRepository({ remoteRequest, openRemoteStream }),
    remoteRequest,
    openRemoteStream,
    streamsClosed: () => streamsClosed,
  }
}

describe('published rc222 consumed contracts', () => {
  it.each(['valid', 'malformed', 'business-error', 'protocol-error', 'timeout'] as const)(
    'probes %s with an exact identity and releases its transport',
    async (mode) => {
      const transport = new ProbeFixtureTransport(mode)
      class ProbeAdapter extends Rc222VersionAdapter {
        public override createTransport(): DshTransport {
          return transport
        }
      }
      const adapter = new ProbeAdapter(transportOptions(globalThis.fetch))
      const result = await adapter.probe(candidate('0.2.2-rc.2'))
      if (mode === 'valid')
        expect(result).toMatchObject({
          adapterId: 'dsh-0.2.2-rc.2',
          protocolVersion: 'rc222',
          dshVersion: '0.2.2-rc.2',
        })
      else expect(result).toBeUndefined()
      expect(transport.closeCalls).toBe(1)
      expect(await adapter.probe(candidate('0.2.2-rc.1'))).toBeUndefined()
      expect(await adapter.probe(candidate('0.2.2-rc.3'))).toBeUndefined()
      expect(await adapter.probeCompatibility()).toBeUndefined()
      expect(transport.closeCalls).toBe(1)
    },
  )

  it('applies the named catalog, Team and MCP boundaries through the release adapter', () => {
    const adapter = new Adapter(transportOptions(globalThis.fetch))
    expect(
      adapter.project({
        subagentCatalog: [rc222NamedChild],
        agentTeam: rc222Team,
        conversationContinuation: 4,
      }),
    ).toMatchObject({ subagentCatalog: [rc222NamedChild], conversationContinuation: 4 })
    expect(adapter.project({ agentTeam: rc222Team })).not.toHaveProperty('agentTeam')
    expect(() =>
      adapter.project({ subagentCatalog: [rc222NamedChild, { ...rc222NamedChild, id: 'other' }] }),
    ).toThrow()
    expect(() =>
      adapter.normalize({
        type: 'projection',
        sessionId: 's',
        seq: 3,
        changes: [{ key: 'conversationContinuation', val: 4 }],
      }),
    ).toThrow()
    expect(() =>
      adapter.normalize({
        type: 'projection',
        sessionId: 's',
        seq: 5,
        changes: [
          { key: 'conversationContinuation', val: 4 },
          { key: 'agentTeam', val: { enabled: true, tasks: 'invalid' } },
        ],
      }),
    ).toThrow()
    expect(
      adapter.event({
        type: 'remote.event',
        name: 'mcp-manager/status',
        args: ['fixture', { state: 'connecting', attempt: 0 }],
      }),
    ).toEqual({ type: 'remote.event', name: 'mcp-manager/status', args: ['fixture'] })
  })

  it('unwraps account updates, tracks stored-grant replacement and strips account links', async () => {
    const fixture = accountFixture(rc222AccountState, [
      { type: 'snapshot', state: rc222AccountState },
      { type: 'credentials-changed', state: rc222AccountState },
      { type: 'snapshot', state: rc222AccountState },
    ])
    const snapshots = []
    for await (const snapshot of fixture.repository.watch(new AbortController().signal))
      snapshots.push(snapshot)
    expect(snapshots.map(({ credentialRevision }) => credentialRevision)).toEqual([0, 1, 1])
    expect(await fixture.repository.getState()).toEqual({
      status: 'credential-stored',
      attempt: null,
      credentialRevision: 1,
    })
    expect(JSON.stringify(snapshots)).not.toContain('usageUrl')
    expect(fixture.streamsClosed()).toBe(1)
  })

  it.each([rc222AccountState, { type: 'unknown', state: rc222AccountState }, { type: 'snapshot' }])(
    'rejects malformed account stream updates and closes the iterator',
    async (update) => {
      const fixture = accountFixture(rc222AccountState, [update])
      await expect(
        fixture.repository.watch(new AbortController().signal)[Symbol.asyncIterator]().next(),
      ).rejects.toMatchObject({
        code: 'PROTOCOL_ERROR',
      })
      expect(fixture.streamsClosed()).toBe(1)
    },
  )

  it('cancels account stream consumption without publishing another snapshot', async () => {
    const fixture = accountFixture(rc222AccountState, [
      { type: 'snapshot', state: rc222AccountState },
      { type: 'credentials-changed', state: rc222AccountState },
    ])
    const controller = new AbortController()
    const iterator = fixture.repository.watch(controller.signal)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ credentialRevision: 0 })
    controller.abort()
    expect(await iterator.next()).toMatchObject({ done: true })
    expect(fixture.streamsClosed()).toBe(1)
  })

  it('maps generic notifications without business JSON or removed bonus-order RPCs', async () => {
    const fixture = accountFixture({ nextPollAfterSeconds: 60, notifications: [rc222Notification] })
    expect(await fixture.repository.notifications.getNotifications(client)).toEqual({
      nextPollAfterSeconds: 60,
      notifications: [
        {
          id: 'notice-1',
          title: 'Fixture notice',
          body: 'Fixture content',
          displayUntil: null,
          actions: [
            { label: 'Account', style: 'primary', target: 'account' },
            { label: 'Dismiss', style: 'secondary', target: 'dismiss' },
          ],
        },
      ],
    })
    expect(await fixture.repository.getUnnotifiedBonuses(client)).toBeNull()
    expect(await fixture.repository.ackBonusNotified('fixture-account', 'notice-1', client)).toBe(false)
    expect(fixture.remoteRequest).toHaveBeenCalledExactlyOnceWith(
      'account/getNotifications',
      { client },
      undefined,
    )
  })

  it.each([
    { nextPollAfterSeconds: 0, notifications: [] },
    { nextPollAfterSeconds: 60, notifications: [rc222Notification, rc222Notification] },
    { nextPollAfterSeconds: 60, notifications: [{ ...rc222Notification, id: '' }] },
    {
      nextPollAfterSeconds: 60,
      notifications: [
        {
          ...rc222Notification,
          actions: [
            { label: 'Bad', style: 'primary', target: { type: 'url', url: 'https://example.invalid' } },
          ],
        },
      ],
    },
  ])('rejects invalid polling, duplicate identities and unsupported notification actions', async (value) => {
    await expect(
      accountFixture(value).repository.notifications.getNotifications(client),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it.each([true, false])(
    'preserves notification event acceptance %s and rejects malformed receipts',
    async (accepted) => {
      const fixture = accountFixture(accepted)
      expect(
        await fixture.repository.notifications.reportNotificationEvent('notice-1', 'displayed', client),
      ).toBe(accepted)
      expect(fixture.remoteRequest).toHaveBeenCalledExactlyOnceWith(
        'account/reportNotificationEvent',
        { id: 'notice-1', event: 'displayed', client },
        undefined,
      )
      await expect(
        accountFixture({}).repository.notifications.reportNotificationEvent('notice-1', 'displayed', client),
      ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    },
  )

  it('never retries a notification event after a lost receipt', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('Fixture receipt lost.'))
    const transport = new AlphaLoopbackApiClient({
      ...transportOptions(fetch),
      endpoint,
      retryPolicy: { maximumAttempts: 3, baseDelayMs: 1, maximumDelayMs: 1 },
    })
    try {
      await expect(
        new Rc222AccountLifecycleRepository(transport).notifications.reportNotificationEvent(
          'notice-1',
          'displayed',
          client,
        ),
      ).rejects.toMatchObject({ code: 'BACKEND_UNREACHABLE' })
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      await transport.close()
    }
  })

  it('sends the expected package constraint, preserves refusal and rejects invalid names before dispatch', async () => {
    const requests: unknown[] = []
    const options = transportOptions((_url, init) => {
      requests.push(JSON.parse(bodyText(init)) as unknown)
      return Promise.resolve(
        wrappedResponse(init, {
          stage: 'install',
          target: 'fixture@1.0.0',
          changed: false,
          enabled: true,
          application: 'failed',
          error: { code: 'unexpected-package', diagnostic: 'Private fixture diagnostic' },
          packageResult: { unmet: 'unexpected-package' },
        }),
      )
    })
    const transport = new AlphaLoopbackApiClient({ ...options, endpoint })
    try {
      const repository = new Rc222PluginBundleRepository(transport)
      const result = await repository.installBundle('fixture@1.0.0', {
        requestId: 'fixture',
        expected: { name: 'fixture', version: '1.0.0' },
      })
      expect(result).toMatchObject({ errorCode: 'unexpected-package', application: 'failed' })
      expect(result).not.toHaveProperty('diagnostic')
      expect(requests).toMatchObject([
        { payload: { args: { options: { expected: { name: 'fixture', version: '1.0.0' } } } } },
      ])
      await expect(
        repository.installBundle('fixture', {
          requestId: 'invalid',
          expected: { name: '../private', version: '1.0.0' },
        }),
      ).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_NOT_STARTED' })
      expect(requests).toHaveLength(1)
    } finally {
      await transport.close()
    }
  })
})
