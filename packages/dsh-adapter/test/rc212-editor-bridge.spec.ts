import { describe, expect, it, vi } from 'vitest'
import { Rc212EditorBridgeRepository } from '../src/versions/rc212/editor-bridge-repository.js'

// Our companion protocol v1 on dsh-v0.2.1-rc.2 / 687f282e; fake identities only.
const binding = { protocolVersion: 1, bindingId: 'fixture_binding_1234' }
const success = (value: unknown): unknown => ({ ok: true, value: { status: 'ok', value } })
describe('rc212 optional editor companion protocol', () => {
  it('uses fixed endpoints and named arguments and validates the complete result', async () => {
    const remoteRequest = vi.fn().mockResolvedValue(success(binding))
    const repository = new Rc212EditorBridgeRepository({ remoteRequest })
    expect(await repository.attach('session-one', 'fixture_owner_1234')).toEqual(binding)
    expect(remoteRequest).toHaveBeenCalledWith(
      'vscodeEditorBridge/attach',
      {
        request: { sessionId: 'session-one', ownerId: 'fixture_owner_1234', protocolVersion: 1 },
      },
      undefined,
    )
    remoteRequest.mockResolvedValue(success({ ...binding, endpoint: 'private' }))
    await expect(repository.attach('session-one', 'fixture_owner_1234')).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })
  it('does not treat malformed data or a missing plugin as an empty editor state', async () => {
    const remoteRequest = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { status: 'error', reason: 'unavailable' } })
    const repository = new Rc212EditorBridgeRepository({ remoteRequest })
    await expect(repository.attach('session-one', 'fixture_owner_1234')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    remoteRequest.mockResolvedValue(success({ kind: 'request', requestId: '../private' }))
    await expect(repository.poll(binding.bindingId)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
  it('propagates cancellation and never retries mutations', async () => {
    const controller = new AbortController()
    const remoteRequest = vi.fn().mockRejectedValue(new Error('private body'))
    const repository = new Rc212EditorBridgeRepository({ remoteRequest })
    await expect(repository.detach(binding.bindingId, controller.signal)).rejects.toMatchObject({
      message: 'The editor companion request failed.',
    })
    expect(remoteRequest).toHaveBeenCalledTimes(1)
    controller.abort()
    await expect(repository.poll(binding.bindingId, controller.signal)).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    })
    expect(remoteRequest).toHaveBeenCalledTimes(1)
  })
})
