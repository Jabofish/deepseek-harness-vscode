import { describe, expect, it, vi } from 'vitest'
import { EditorBridgeService } from '../src/services/editor-bridge-service.js'
import {
  AppError,
  type EditorBridgeRepository,
  type EditorBridgePoll,
  type EditorStateSnapshot,
} from '@dsh-vscode/domain'

const snapshot: EditorStateSnapshot = {
  relativePath: 'sample.ts',
  languageId: 'typescript',
  documentVersion: 1,
  dirty: true,
  selection: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
  diagnostics: { errors: 1, warnings: 0 },
  capturedAt: '2026-01-01T00:00:00.000Z',
}
function harness(requestIds: readonly string[] = ['fixture_request_1234']): {
  repository: EditorBridgeRepository
  respond: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
} {
  const respond = vi.fn().mockResolvedValue(undefined)
  const detach = vi.fn().mockResolvedValue(undefined)
  let next = 0
  return {
    respond,
    detach,
    repository: {
      attach: () => Promise.resolve({ bindingId: 'fixture_binding_1234', protocolVersion: 1 }),
      poll: (_bindingId, signal) => {
        const requestId = requestIds[next++]
        if (requestId !== undefined) return Promise.resolve({ kind: 'request', requestId })
        return new Promise<EditorBridgePoll>((_resolve, reject) => {
          if (signal?.aborted) reject(new Error('cancelled'))
          else signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        })
      },
      respond,
      detach,
    },
  }
}
describe('explicit editor sharing grant', () => {
  it('answers a request and releases the binding on stop', async () => {
    const { repository, respond, detach } = harness()
    const service = new EditorBridgeService()
    await service.start(repository, 'session-a', 'fixture_owner_1234', {
      read: () => Promise.resolve(snapshot),
    })
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1))
    expect(respond.mock.calls[0]?.[2]).toEqual({ ok: true, snapshot })
    await service.stop()
    expect(detach).toHaveBeenCalledTimes(1)
    expect(service.active).toBe(false)
  })
  it('rejects concurrent activation and never publishes a capture completing after revocation', async () => {
    const { repository, respond, detach } = harness()
    let resolve!: (value: EditorStateSnapshot) => void
    const read = vi.fn(
      () =>
        new Promise<EditorStateSnapshot>((settle) => {
          resolve = settle
        }),
    )
    const service = new EditorBridgeService()
    await service.start(repository, 'session-a', 'fixture_owner_1234', { read })
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    await expect(
      service.start(repository, 'session-b', 'another_owner_1234', { read }),
    ).rejects.toMatchObject({ reason: 'busy' })
    await service.stop()
    expect(respond).not.toHaveBeenCalled()
    resolve(snapshot)
    await Promise.resolve()
    expect(respond).not.toHaveBeenCalled()
    expect(detach).toHaveBeenCalledTimes(1)
  })
  it('keeps the same grant after a delayed capture replies to an expired tool request', async () => {
    const { repository, respond, detach } = harness(['expired_request_1234', 'current_request_1234'])
    const attach = vi.spyOn(repository, 'attach')
    const onStopped = vi.fn()
    const service = new EditorBridgeService(onStopped)
    let resolve!: (value: EditorStateSnapshot) => void
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<EditorStateSnapshot>((settle) => {
            resolve = settle
          }),
      )
      .mockResolvedValue({ ...snapshot, documentVersion: 2 })
    respond.mockRejectedValueOnce(
      new AppError({ code: 'STALE_INTERACTION', message: 'Expired request.', retryable: false }),
    )
    try {
      await service.start(repository, 'session-a', 'fixture_owner_1234', { read })
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
      resolve(snapshot)
      await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2))
      expect(respond.mock.calls[1]).toEqual([
        'fixture_binding_1234',
        'current_request_1234',
        { ok: true, snapshot: { ...snapshot, documentVersion: 2 } },
        expect.any(AbortSignal),
      ])
      expect(service.active).toBe(true)
      expect(attach).toHaveBeenCalledTimes(1)
      expect(detach).not.toHaveBeenCalled()
      expect(onStopped).not.toHaveBeenCalled()
    } finally {
      await service.stop()
    }
    expect(detach).toHaveBeenCalledTimes(1)
  })
  it('still terminates the grant when a response fails with a protocol error', async () => {
    const { repository, respond, detach } = harness()
    respond.mockRejectedValueOnce(
      new AppError({ code: 'PROTOCOL_ERROR', message: 'Invalid response.', retryable: false }),
    )
    const service = new EditorBridgeService()
    await service.start(repository, 'session-a', 'fixture_owner_1234', {
      read: () => Promise.resolve(snapshot),
    })
    await vi.waitFor(() => expect(service.active).toBe(false))
    expect(detach).toHaveBeenCalledTimes(1)
  })
  it('rejects malformed captures and terminates the grant', async () => {
    const { repository, respond } = harness()
    const service = new EditorBridgeService()
    await service.start(repository, 'session-a', 'fixture_owner_1234', {
      read: () => Promise.resolve({ ...snapshot, relativePath: '/private' }),
    })
    await vi.waitFor(() => expect(service.active).toBe(false))
    expect(respond.mock.calls[0]?.[2]).toEqual({ ok: false, reason: 'invalid-response' })
  })
  it('revokes an unsafe capture even when its tool request has already expired', async () => {
    const { repository, respond, detach } = harness()
    respond.mockRejectedValueOnce(
      new AppError({ code: 'STALE_INTERACTION', message: 'Expired request.', retryable: false }),
    )
    const service = new EditorBridgeService()
    await service.start(repository, 'session-a', 'fixture_owner_1234', {
      read: () => Promise.resolve({ ...snapshot, relativePath: '/private' }),
    })
    await vi.waitFor(() => expect(service.active).toBe(false))
    expect(detach).toHaveBeenCalledTimes(1)
    expect(respond.mock.calls[0]?.[2]).toEqual({ ok: false, reason: 'invalid-response' })
  })
})
