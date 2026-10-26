import { describe, expect, it, vi } from 'vitest'
import { EditorBridgeService } from '../src/services/editor-bridge-service.js'
import {
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
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
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

  it('rejects malformed captures and terminates the grant', async () => {
    const { repository, respond } = harness()
    const service = new EditorBridgeService()
    await service.start(repository, 'session-a', 'fixture_owner_1234', {
      read: () => Promise.resolve({ ...snapshot, relativePath: '/private' }),
    })
    await vi.waitFor(() => expect(service.active).toBe(false))
    expect(respond.mock.calls[0]?.[2]).toEqual({ ok: false, reason: 'invalid-response' })
  })
})
