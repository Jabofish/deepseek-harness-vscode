import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorCompanionBinding, EditorCompanionResult, EditorCompanionPoll } from '@dsh-vscode/domain'
import { EditorCompanionBroker } from './companion-broker.js'
const signal = (): AbortSignal => new AbortController().signal
function value<T>(result: EditorCompanionResult<T>): T {
  if (result.status !== 'ok') throw new Error(result.reason)
  return result.value
}
function request(result: EditorCompanionResult<EditorCompanionPoll>): string {
  const event = value(result)
  if (event.kind !== 'request') throw new Error('Missing request')
  return event.requestId
}
afterEach(() => vi.useRealTimers())
describe('multi-session editor tool grants', () => {
  it('waits for automatic setup on the first request and cancels/releases pending handshakes', async () => {
    const broker = new EditorCompanionBroker()
    const call = broker.read('restored-session', { kind: 'document' }, signal())
    const binding = value(broker.attach('restored-session', 'owner', 'peer', ['content']))
    await Promise.resolve()
    const id = request(await broker.poll(binding.bindingId, 'peer', signal()))
    broker.respond(binding.bindingId, 'peer', id, { ok: false, reason: 'no-editor' })
    await expect(call).rejects.toMatchObject({ reason: 'no-editor' })
    const controller = new AbortController()
    const waiting = broker.waitForSession('other-session', controller.signal)
    controller.abort()
    expect(await waiting).toBe(false)
    const last = broker.waitForSession('last-session', signal())
    broker.dispose()
    expect(await last).toBe(false)
  })
  it('isolates windows/Peers and checks capabilities before dispatch', async () => {
    const broker = new EditorCompanionBroker()
    const a: EditorCompanionBinding = value(broker.attach('session-a', 'owner-a', 'peer-a', ['content']))
    const b = value(broker.attach('session-b', 'owner-b', 'peer-b', []))
    try {
      expect(broker.attach('session-a', 'owner-b', 'peer-b', [])).toEqual({ status: 'error', reason: 'busy' })
      expect(await broker.poll(a.bindingId, 'peer-b', signal())).toEqual({
        status: 'error',
        reason: 'not-bound',
      })
      await expect(broker.read('session-b', { kind: 'document' }, signal())).rejects.toMatchObject({
        reason: 'denied',
      })
      const call = broker.read('session-a', { kind: 'document' }, signal())
      const id = request(await broker.poll(a.bindingId, 'peer-a', signal()))
      expect(broker.respond(b.bindingId, 'peer-b', id, { ok: false, reason: 'no-editor' })).toEqual({
        status: 'error',
        reason: 'stale-request',
      })
      broker.respond(a.bindingId, 'peer-a', id, { ok: false, reason: 'no-editor' })
      await expect(call).rejects.toMatchObject({ reason: 'no-editor' })
      expect(broker.hasSession('session-b')).toBe(true)
    } finally {
      broker.dispose()
    }
  })
  it('delivers cancellation, drops late replies and keeps the grant usable', async () => {
    const broker = new EditorCompanionBroker()
    const binding = value(broker.attach('session-a', 'owner-a', 'peer-a', ['content']))
    const controller = new AbortController()
    const call = expect(
      broker.read('session-a', { kind: 'selection' }, controller.signal),
    ).rejects.toMatchObject({ reason: 'cancelled' })
    const id = request(await broker.poll(binding.bindingId, 'peer-a', signal()))
    controller.abort()
    await call
    expect(value(await broker.poll(binding.bindingId, 'peer-a', signal()))).toEqual({
      kind: 'cancel',
      requestId: id,
    })
    expect(broker.respond(binding.bindingId, 'peer-a', id, { ok: false, reason: 'no-editor' })).toEqual({
      status: 'error',
      reason: 'stale-request',
    })
    const next = broker.read('session-a', { kind: 'selection' }, signal())
    const nextId = request(await broker.poll(binding.bindingId, 'peer-a', signal()))
    broker.respond(binding.bindingId, 'peer-a', nextId, { ok: false, reason: 'no-editor' })
    await expect(next).rejects.toMatchObject({ reason: 'no-editor' })
    broker.dispose()
  })
  it('expires requests independently, bounds queues and releases timers and polls', async () => {
    vi.useFakeTimers()
    const broker = new EditorCompanionBroker({ leaseMs: 100, pollMs: 5, callMs: 10 })
    const binding = value(broker.attach('session-a', 'owner-a', 'peer-a', ['content']))
    const calls = Array.from({ length: 4 }, () =>
      expect(broker.read('session-a', { kind: 'selection' }, signal())).rejects.toMatchObject({
        reason: 'timeout',
      }),
    )
    await expect(broker.read('session-a', { kind: 'selection' }, signal())).rejects.toMatchObject({
      reason: 'busy',
    })
    await vi.advanceTimersByTimeAsync(10)
    await Promise.all(calls)
    const poll = broker.poll(binding.bindingId, 'peer-a', signal())
    broker.dispose()
    expect(await poll).toEqual({ status: 'error', reason: 'not-bound' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
