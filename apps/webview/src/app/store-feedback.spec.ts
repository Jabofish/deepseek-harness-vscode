// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

class FeedbackClient {
  public readonly requests: WebviewRequest[] = []
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public constructor(private readonly answer: (request: WebviewRequest) => unknown) {}

  public request<T>(request: WebviewRequest): Promise<T> {
    this.requests.push(request)
    return Promise.resolve(this.answer(request) as T)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public dispose(): void {
    this.listeners.clear()
  }
}

const feedback = {
  messageId: 'message-1',
  rating: 'negative',
  note: 'needs work',
  category: 'instruction-following',
  version: 'v2',
  createdAt: 10,
  updatedAt: 20,
} as const

describe('AppStore rc.2 feedback submission', () => {
  it('sends the upstream category and validates the returned feedback shape', async () => {
    const client = new FeedbackClient((request) => {
      if (request.type !== 'feedback.toggle') throw new Error(`unexpected ${request.type}`)
      return feedback
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.submitFeedback(
      'session-1',
      feedback.messageId,
      feedback.rating,
      feedback.note,
      feedback.category,
    )

    const request = client.requests[0]
    expect(request?.type).toBe('feedback.toggle')
    if (request?.type !== 'feedback.toggle') throw new Error('expected feedback.toggle request')
    expect(request.payload).toEqual({
      sessionId: 'session-1',
      messageId: 'message-1',
      rating: 'negative',
      note: 'needs work',
      category: 'instruction-following',
    })
    store.dispose()
  })

  it('omits optional note and category fields when the dialog submits no details', async () => {
    const client = new FeedbackClient((request) => {
      if (request.type !== 'feedback.toggle') throw new Error(`unexpected ${request.type}`)
      return { ...feedback, rating: 'positive', note: undefined, category: undefined }
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.submitFeedback('session-1', feedback.messageId, 'positive')

    const request = client.requests[0]
    if (request?.type !== 'feedback.toggle') throw new Error('expected feedback.toggle request')
    expect(request.payload).toEqual({
      sessionId: 'session-1',
      messageId: 'message-1',
      rating: 'positive',
    })
    store.dispose()
  })

  it('rejects a response containing a category outside the pinned taxonomy', async () => {
    const client = new FeedbackClient((request) => {
      if (request.type !== 'feedback.toggle') throw new Error(`unexpected ${request.type}`)
      return { ...feedback, category: 'not-a-category' }
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await expect(
      store.submitFeedback(
        'session-1',
        feedback.messageId,
        feedback.rating,
        feedback.note,
        feedback.category,
      ),
    ).rejects.toThrow('feedback')
    store.dispose()
  })

  it('propagates an unavailable feedback sidecar so the dialog cannot acknowledge false success', async () => {
    const client = new FeedbackClient((request) => {
      if (request.type !== 'feedback.toggle') throw new Error(`unexpected ${request.type}`)
      return Promise.reject(
        Object.assign(new Error('feedback unavailable'), { code: 'CAPABILITY_UNAVAILABLE' }),
      )
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await expect(store.submitFeedback('session-1', feedback.messageId, 'positive')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    store.dispose()
  })
})
