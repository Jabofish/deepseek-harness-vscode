import { describe, expect, it, vi } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc213VersionAdapter } from '../src/versions/rc213/adapter.js'
import { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'

import { Alpha213PluginBundleRepository } from '../src/versions/alpha213/plugin-manager-repository.js'

import { callRpc } from '../src/versions/rc6/rpc.js'
import { endpoint, transportOptions, failureResponse } from './support/contract-harness.js'
import { FakeWebSocket } from './support/fake-web-socket.js'

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

describe('0.2.1-rc.3 incremental contracts', () => {
  class FixtureAdapter extends Rc213VersionAdapter {
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
    const send = (value: unknown): void => socket.message({ type: 'item', streamId: opening.streamId, value })
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
    const transport = new Rc213VersionAdapter(
      transportOptions((_input, init) => {
        requests++
        return Promise.resolve(failureResponse(init, wireCode, 'private path and token'))
      }),
    ).createTransport(endpoint)
    await expect(callRpc(transport, 'session.create', {})).rejects.toMatchObject({ code })
    expect(requests).toBe(1)
    await transport.close()
  })
})

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
})
