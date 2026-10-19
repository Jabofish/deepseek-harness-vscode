import { describe, expect, it, vi } from 'vitest'
import { Rc212EditorCompanionRepository } from '../src/versions/rc212/editor-companion-repository.js'

// Companion protocol 2 on dsh-v0.2.1-rc.2 / 687f282e; fake identities only.
describe('rc212 negotiated editor tool protocol', () => {
  it('negotiates strict capabilities and sends only fixed named Remote calls', async () => {
    const description = {
      protocolVersion: 2,
      packageVersion: '0.2.0',
      capabilities: ['content'],
      maxGrants: 16,
    }
    const remoteRequest = vi.fn().mockResolvedValue({ ok: true, value: { status: 'ok', value: description } })
    const repository = new Rc212EditorCompanionRepository({ remoteRequest })
    expect(await repository.describe()).toEqual(description)
    expect(remoteRequest).toHaveBeenCalledWith('vscodeEditorCompanion/describe', { request: {} }, undefined)
    remoteRequest.mockResolvedValue({ ok: true, value: { status: 'ok', value: 'a'.repeat(64) } })
    expect(await repository.buildIdentity()).toBe('a'.repeat(64))
    expect(remoteRequest).toHaveBeenLastCalledWith(
      'vscodeEditorCompanion/buildIdentity',
      { request: {} },
      undefined,
    )
    remoteRequest.mockResolvedValue({ ok: true, value: { status: 'ok', value: 'invalid build text' } })
    await expect(repository.buildIdentity()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    remoteRequest.mockResolvedValue({
      ok: true,
      value: { status: 'ok', value: { ...description, protocolVersion: 9 } },
    })
    await expect(repository.describe()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    const calls = remoteRequest.mock.calls.length
    await expect(
      repository.attach('session-a', 'fixture_owner_1234', ['content', 'content']),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(remoteRequest).toHaveBeenCalledTimes(calls)
    remoteRequest.mockResolvedValue({ ok: true, value: { status: 'ok', value: { proof: 'a'.repeat(64) } } })
    expect(await repository.verifyHost('fixture_nonce_1234')).toEqual({ proof: 'a'.repeat(64) })
    expect(remoteRequest).toHaveBeenLastCalledWith(
      'vscodeEditorCompanion/verifyHost',
      { request: { nonce: 'fixture_nonce_1234' } },
      undefined,
    )
    remoteRequest.mockResolvedValue({ ok: true, value: { status: 'ok', value: { proof: '../invalid' } } })
    await expect(repository.verifyHost('fixture_nonce_1234')).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })
  it('keeps stale replies request-local, rejects unavailable peers and observes cancellation without retry', async () => {
    const remoteRequest = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { status: 'error', reason: 'stale-request' } })
    const repository = new Rc212EditorCompanionRepository({ remoteRequest })
    await expect(
      repository.respond('fixture_binding_1234', 'fixture_request_1234', { ok: false, reason: 'cancelled' }),
    ).rejects.toMatchObject({ code: 'STALE_INTERACTION' })
    remoteRequest.mockResolvedValue({ ok: true, value: { status: 'error', reason: 'not-bound' } })
    await expect(repository.poll('fixture_binding_1234')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    await expect(repository.describe(AbortSignal.abort())).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    })
    expect(remoteRequest).toHaveBeenCalledTimes(2)
  })
})
