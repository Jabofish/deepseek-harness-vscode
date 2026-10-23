import { describe, expect, it, vi } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc211VersionAdapter } from '../src/versions/rc211/adapter.js'
import { Rc212VersionAdapter } from '../src/versions/rc212/adapter.js'
import { Rc213VersionAdapter } from '../src/versions/rc213/adapter.js'
import { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'
import { Alpha212PluginBundleRepository } from '../src/versions/alpha212/plugin-manager-repository.js'
import { Alpha213PluginBundleRepository } from '../src/versions/alpha213/plugin-manager-repository.js'
import { Alpha214PluginBundleRepository } from '../src/versions/alpha214/plugin-manager-repository.js'
import { Alpha215AccountLifecycleRepository } from '../src/versions/alpha215/account-repository.js'
import { Alpha211AccountLifecycleRepository } from '../src/versions/alpha211/account-repository.js'
import { callRpc } from '../src/versions/rc6/rpc.js'
import { endpoint, transportOptions, failureResponse } from './support/contract-harness.js'
import { FakeWebSocket } from './support/fake-web-socket.js'
import { ProbeFixtureTransport } from './support/probe-fixture.js'

// Fixed tags/commits are recorded in rc211-contract.spec.ts. Source types:
// workspace-controller/src/types.ts WorkspaceFollowIncrement (alpha.3),
// gateway/src/remote-error-codes.ts (alpha.3), plugin-manager/src/types.ts (alpha.3/.4),
// deepseek-account/src/types.ts AccountBonusNotification (alpha.5).
function fixture(value: () => unknown): DshTransport {
  return {
    request: () => Promise.reject(new Error('Unexpected legacy RPC')),
    remoteRequest: <T>() => Promise.resolve({ ok: true, value: value() } as T),
    openEventStream: async function* () {
      /* No fixture events. */
    },
    close: () => Promise.resolve(),
  }
}

describe.each([Rc211VersionAdapter, Rc212VersionAdapter, Rc213VersionAdapter])(
  '%s incremental contracts',
  (Adapter) => {
    class FixtureAdapter extends Adapter {
      public transport(): AlphaLoopbackApiClient {
        return new AlphaLoopbackApiClient({
          ...this.createTransportOptions(endpoint),
          webSocket: FakeWebSocket,
        })
      }
    }
    it('accepts Workspace replacement within a generation and replaces archive/pin projections', async () => {
      const transport = new FixtureAdapter(transportOptions(globalThis.fetch)).transport()
      const signal = new AbortController()
      const iterator = transport.openWorkspaceStream(signal.signal)[Symbol.asyncIterator]()
      const first = iterator.next()
      const socket = FakeWebSocket.instances.at(-1)!
      socket.open()
      await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0))
      const opening = JSON.parse(socket.sent[0]!) as { streamId: string }
      const send = (value: unknown): void =>
        socket.message({ type: 'item', streamId: opening.streamId, value })
      send({ type: 'baseline', value: { items: [], archivedSessionIds: ['old'], pinnedSessionIds: ['old'] } })
      expect((await first).value).toEqual({ type: 'host/workspace-changed' })
      expect((await iterator.next()).value).toMatchObject({ sessionIds: ['old'] })
      expect((await iterator.next()).value).toMatchObject({ sessionIds: ['old'] })
      send({ type: 'replace', value: { items: [], archivedSessionIds: [], pinnedSessionIds: ['new'] } })
      expect((await iterator.next()).value).toEqual({ type: 'host/workspace-changed' })
      expect((await iterator.next()).value).toEqual({
        type: 'host/archived-sessions-changed',
        sessionIds: [],
      })
      expect((await iterator.next()).value).toEqual({
        type: 'host/pinned-sessions-changed',
        sessionIds: ['new'],
      })
      send({ type: 'replace', value: { items: [], archivedSessionIds: [], pinnedSessionIds: null } })
      await expect(iterator.next()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
      signal.abort()
      await transport.close()
      expect(socket.closeCalls).toBe(1)
    })

    it.each([
      ['gateway/interactions-forbidden', 'PERMISSION_DENIED'],
      ['gateway/peer-disposed', 'BACKEND_UNREACHABLE'],
      ['gateway/unrecognized', 'PROTOCOL_ERROR'],
    ])('maps %s without exposing diagnostics or replaying writes', async (wireCode, code) => {
      let requests = 0
      const transport = new Adapter(
        transportOptions((_input, init) => {
          requests++
          return Promise.resolve(failureResponse(init, wireCode, 'private path and token'))
        }),
      ).createTransport(endpoint)
      await expect(callRpc(transport, 'session.create', {})).rejects.toMatchObject({ code })
      expect(requests).toBe(1)
      await transport.close()
    })

    it('closes declined/cancelled probes for malformed, business, protocol and timeout failures', async () => {
      for (const mode of ['malformed', 'business-error', 'protocol-error', 'timeout'] as const) {
        const transport = new ProbeFixtureTransport(mode)
        class FixtureVersionAdapter extends Adapter {
          public override createTransport(): DshTransport {
            return transport
          }
        }
        const adapter = new FixtureVersionAdapter(transportOptions(globalThis.fetch))
        const candidate = {
          endpoint,
          source: 'configured' as const,
          confidence: 1,
          runtimeVersion: adapter.supportedVersion,
        }
        expect(await adapter.probe(candidate)).toBeUndefined()
        expect(transport.closeCalls).toBe(1)
        const abort = new AbortController()
        abort.abort()
        await expect(adapter.probe(candidate, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
        expect(transport.closeCalls).toBe(2)
      }
    })
  },
)

describe('shared 0.2.1 incremental repository contracts', () => {
  it('keeps restart reasons on install, recovery, enable and remove; refuses malformed reasons', async () => {
    let value: unknown = {
      target: 'fixture',
      bundle: 'fixture',
      enabled: true,
      changed: true,
      application: 'restart-required',
      stage: 'enable',
      restartReason: 'host-module',
      version: '1.0.0',
    }
    const transport = fixture(() => value)
    const repository = new Alpha213PluginBundleRepository(transport)
    for (const result of [
      await repository.installBundle('fixture', { requestId: 'install-1' }),
      await repository.waitForInstall('install-1'),
      await repository.setBundleEnabled('fixture', true),
      await repository.setPluginEnabled('fixture', true),
    ])
      expect(result).toMatchObject({ restartReason: 'host-module' })
    value = { ...(value as object), stage: 'remove' }
    expect(await repository.removeBundle('fixture')).toMatchObject({ restartReason: 'host-module' })
    for (const reason of ['unknown', null, '/private/path']) {
      value = { ...(value as object), restartReason: reason }
      await expect(repository.removeBundle('fixture')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    }
  })

  it('accepts already-installed only from alpha.4 onward and omits raw errors and sources', async () => {
    const transport = fixture(() => ({
      target: 'fixture',
      enabled: true,
      changed: false,
      stage: 'enable',
      application: 'failed',
      error: { code: 'already-installed', diagnostic: '/private/path token=secret' },
    }))
    await expect(
      new Alpha214PluginBundleRepository(transport).setBundleEnabled('fixture', true),
    ).resolves.toEqual({
      name: 'fixture',
      enabled: true,
      changed: false,
      stage: 'enable',
      application: 'failed',
      errorCode: 'already-installed',
    })
    for (const Repository of [Alpha212PluginBundleRepository, Alpha213PluginBundleRepository])
      await expect(new Repository(transport).setBundleEnabled('fixture', true)).rejects.toMatchObject({
        code: 'PROTOCOL_ERROR',
      })
  })

  it('reads localized notices without optional Platform metadata, retaining old strict admission', async () => {
    const notice = {
      orderId: 'd80ff092-0cdd-4a34-b5fb-05503d8574d8',
      title: 'Notice',
      message: 'Granted',
      expiresAt: '',
    }
    let value: unknown = {
      accountId: 'account-1',
      bonuses: [{ ...notice, amount: { private: true }, campaign: ['private'], currency: 1 }],
    }
    const transport = {
      ...fixture(() => value),
      openRemoteStream: async function* () {
        /* No stream. */
      },
    }
    const repository = new Alpha215AccountLifecycleRepository(transport)
    const client = { version: '1.0.0', locale: 'en', timezoneOffsetSeconds: 0 }
    await expect(repository.getUnnotifiedBonuses(client)).resolves.toEqual({
      accountId: 'account-1',
      bonuses: [notice],
    })
    await expect(
      new Alpha211AccountLifecycleRepository(transport).getUnnotifiedBonuses(client),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    for (const invalid of [{ title: 1 }, { message: null }, { orderId: 'invalid' }, { expiresAt: null }]) {
      value = { accountId: 'account-1', bonuses: [{ ...notice, ...invalid }] }
      await expect(repository.getUnnotifiedBonuses(client)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    }
    value = null
    await expect(repository.getUnnotifiedBonuses(client)).resolves.toBeNull()
  })
})
