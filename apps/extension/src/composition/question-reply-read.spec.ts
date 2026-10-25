import { describe, expect, it, vi } from 'vitest'
import type { BackendService } from '@dsh-vscode/application'
import { AppError, type QuestionReplyStatus } from '@dsh-vscode/domain'
vi.mock('vscode', () => ({ workspace: { isTrusted: true } }))
import { createFeatureRequestHandler } from './feature-request-handler.js'
import { WebviewMessageRouter } from '../view/message-router.js'

describe('question reply read Host boundary', () => {
  it('authorizes the session and returns only reply metadata through the strict router', async () => {
    const read = vi.fn(() => Promise.resolve({ state: 'queued', asOfSequence: 101 }))
    const backend = { userQuestions: { readReplyStatus: read } }
    const owned = vi.fn(() => Promise.resolve({ id: 's1' }))
    const { handleFeatureRequest } = createFeatureRequestHandler({
      backendService: { requireBackend: () => backend } as unknown as BackendService,
      requireCurrentWorkspaceSession: owned,
    } as never)
    const posted: unknown[] = []
    const router = new WebviewMessageRouter({
      handleFeatureRequest,
      postMessage: (value) => {
        posted.push(value)
        return Promise.resolve(true)
      },
    })
    try {
      await router.handle({
        protocolVersion: 1,
        message: {
          type: 'user-question.reply.read',
          requestId: 'read',
          payload: { sessionId: 's1', callId: 'call-q' },
        },
      })
      expect(owned).toHaveBeenCalledWith('s1', expect.any(AbortSignal))
      expect(read).toHaveBeenCalledWith('s1', 'call-q', expect.any(AbortSignal))
      expect(posted).toContainEqual({
        type: 'feature.response',
        requestId: 'read',
        ok: true,
        payload: { kind: 'question.reply', status: { state: 'queued', asOfSequence: 101 } },
      })
    } finally {
      router.cancelAll()
    }
  })

  it('rejects another workspace and discards a baseline from a replaced backend', async () => {
    let finish!: (value: QuestionReplyStatus) => void
    const read = vi.fn(
      () =>
        new Promise<QuestionReplyStatus>((resolve) => {
          finish = resolve
        }),
    )
    let backend = { userQuestions: { readReplyStatus: read } }
    const owned = vi
      .fn()
      .mockRejectedValueOnce(
        new AppError({ code: 'PERMISSION_DENIED', message: 'Wrong workspace', retryable: false }),
      )
      .mockResolvedValue({ id: 's1' })
    const { handleFeatureRequest } = createFeatureRequestHandler({
      backendService: { requireBackend: () => backend } as unknown as BackendService,
      requireCurrentWorkspaceSession: owned,
    } as never)
    const request = {
      type: 'user-question.reply.read',
      requestId: 'read',
      payload: { sessionId: 's1', callId: 'call-q' },
    } as const
    const signal = new AbortController().signal
    await expect(handleFeatureRequest(request, signal)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(read).not.toHaveBeenCalled()
    const pending = handleFeatureRequest(request, signal)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    backend = { userQuestions: { readReplyStatus: vi.fn() } }
    finish({ state: 'released', asOfSequence: 102 })
    await expect(pending).rejects.toMatchObject({ code: 'STALE_INTERACTION' })
  })
})
