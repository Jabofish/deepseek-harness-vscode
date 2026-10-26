import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorBridgeBroker } from './broker.js'
import type { EditorBridgeBinding, EditorBridgeResult, EditorStateSnapshot } from '@dsh-vscode/domain'

const snapshot: EditorStateSnapshot = {
  relativePath: 'src/example.ts',
  languageId: 'typescript',
  documentVersion: 2,
  dirty: true,
  selection: { start: { line: 1, column: 1 }, end: { line: 2, column: 3 } },
  diagnostics: { errors: 1, warnings: 0 },
  capturedAt: '2026-01-01T00:00:00.000Z',
}
function binding(result: EditorBridgeResult<EditorBridgeBinding>): EditorBridgeBinding {
  if (result.status !== 'ok') throw new Error('Fixture attach failed.')
  return result.value
}
afterEach(() => vi.useRealTimers())
describe('editor bridge lease and tool ownership', () => {
  it('routes only the bound session and owning peer and consumes each result once', async () => {
    const broker = new EditorBridgeBroker()
    const { bindingId } = binding(broker.attach('session-a', 'owner-a', 'peer-a'))
    expect(broker.attach('session-a', 'owner-b', 'peer-b')).toEqual({ status: 'error', reason: 'busy' })
    await expect(broker.read('session-b', new AbortController().signal)).rejects.toMatchObject({
      reason: 'not-bound',
    })
    expect(await broker.poll(bindingId, 'peer-b', new AbortController().signal)).toEqual({
      status: 'error',
      reason: 'not-bound',
    })
    const read = broker.read('session-a', new AbortController().signal)
    const poll = await broker.poll(bindingId, 'peer-a', new AbortController().signal)
    if (poll.status !== 'ok' || poll.value.kind !== 'request') throw new Error('Missing fixture request.')
    const { requestId } = poll.value
    expect(broker.respond(bindingId, 'peer-b', requestId, { ok: true, snapshot })).toEqual({
      status: 'error',
      reason: 'not-bound',
    })
    expect(broker.respond(bindingId, 'peer-a', requestId, { ok: true, snapshot })).toEqual({
      status: 'ok',
      value: true,
    })
    expect(await read).toEqual(snapshot)
    expect(broker.respond(bindingId, 'peer-a', requestId, { ok: true, snapshot })).toEqual({
      status: 'error',
      reason: 'stale-request',
    })
    broker.dispose()
  })
  it('bounds concurrent reads, cancels pending tools and drops their late replies', async () => {
    const broker = new EditorBridgeBroker()
    const { bindingId } = binding(broker.attach('session-a', 'owner-a', 'peer-a'))
    const controller = new AbortController()
    const read = expect(broker.read('session-a', controller.signal)).rejects.toMatchObject({
      reason: 'cancelled',
    })
    await expect(broker.read('session-a', new AbortController().signal)).rejects.toMatchObject({
      reason: 'busy',
    })
    const request = await broker.poll(bindingId, 'peer-a', new AbortController().signal)
    controller.abort()
    await read
    if (request.status !== 'ok' || request.value.kind !== 'request') throw new Error('Missing request.')
    expect(broker.respond(bindingId, 'peer-a', request.value.requestId, { ok: true, snapshot })).toEqual({
      status: 'error',
      reason: 'stale-request',
    })
    broker.dispose()
  })
  it('expires abandoned leases and releases outstanding polls and calls on disposal', async () => {
    vi.useFakeTimers()
    const broker = new EditorBridgeBroker({ leaseMs: 20, pollMs: 5, callMs: 10 })
    const { bindingId } = binding(broker.attach('session-a', 'owner-a', 'peer-a'))
    const read = expect(broker.read('session-a', new AbortController().signal)).rejects.toMatchObject({
      reason: 'timeout',
    })
    await vi.advanceTimersByTimeAsync(10)
    await read
    await vi.advanceTimersByTimeAsync(10)
    expect(await broker.poll(bindingId, 'peer-a', new AbortController().signal)).toEqual({
      status: 'error',
      reason: 'not-bound',
    })
    const next = binding(broker.attach('session-b', 'owner-b', 'peer-b'))
    const poll = broker.poll(next.bindingId, 'peer-b', new AbortController().signal)
    broker.dispose()
    expect(await poll).toEqual({ status: 'error', reason: 'not-bound' })
  })
})
