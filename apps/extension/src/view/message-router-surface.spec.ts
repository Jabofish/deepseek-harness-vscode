import { describe, expect, it, vi } from 'vitest'
import { WebviewMessageRouter } from './message-router.js'

const request = (requestId: string): unknown => ({
  protocolVersion: 1,
  message: { type: 'diagnostics.snapshot', requestId },
})

describe('WebviewMessageRouter surface routing', () => {
  it('answers the surface that sent the request', async () => {
    const delivered: { readonly surfaceId: string | undefined; readonly requestId: string }[] = []
    const router = new WebviewMessageRouter({
      postMessage: (message, surfaceId) => {
        const entry = message as { readonly type: string; readonly requestId?: string }
        delivered.push({
          surfaceId,
          requestId: entry.type === 'response' ? (entry.requestId ?? '') : '',
        })
        return Promise.resolve(true)
      },
      handleRequest: () => Promise.resolve({ answered: true }),
    })

    await router.handle(request('editor-request'), 'editor:session-1')
    await router.handle(request('sidebar-request'), 'sidebar')

    expect(delivered.map((entry) => entry.surfaceId)).toEqual(['editor:session-1', 'sidebar'])
    expect(delivered.map((entry) => entry.requestId)).toEqual(['editor-request', 'sidebar-request'])
  })

  it('broadcasts only when the caller has no surface identity', async () => {
    const surfaceIds: (string | undefined)[] = []
    const router = new WebviewMessageRouter({
      postMessage: (_message, surfaceId) => {
        surfaceIds.push(surfaceId)
        return Promise.resolve(true)
      },
      handleRequest: () => Promise.resolve(undefined),
    })

    await router.handle(request('anonymous'))

    expect(surfaceIds).toEqual([undefined])
  })

  it('cancels only the disposed surface while another surface keeps working', async () => {
    const signals = new Map<string, AbortSignal>()
    const router = new WebviewMessageRouter({
      postMessage: () => Promise.resolve(true),
      handleRequest: (incoming, signal) => {
        signals.set(incoming.requestId, signal)
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      },
    })

    const sidebar = router.handle(request('sidebar-slow'), 'sidebar')
    const editor = router.handle(request('editor-slow'), 'editor:session-1')
    await Promise.resolve()

    router.cancelSurface('sidebar')

    expect(signals.get('sidebar-slow')?.aborted).toBe(true)
    expect(signals.get('editor-slow')?.aborted).toBe(false)
    await sidebar
    router.cancelAll()
    await editor
  })

  it('keeps a duplicate request id owned by the surface that registered it first', async () => {
    const surfaceIds: (string | undefined)[] = []
    let release: (() => void) | undefined
    const router = new WebviewMessageRouter({
      postMessage: (_message, surfaceId) => {
        surfaceIds.push(surfaceId)
        return Promise.resolve(true)
      },
      handleRequest: () =>
        new Promise((resolve) => {
          release = () => resolve({ answered: true })
        }),
    })

    const first = router.handle(request('shared-id'), 'sidebar')
    await Promise.resolve()
    // A second surface reusing the id must not steal the terminal response.
    await router.handle(request('shared-id'), 'editor:session-1')
    expect(surfaceIds).toEqual([])

    release?.()
    await first
    expect(surfaceIds).toEqual(['sidebar'])
  })

  it('reports a cancelled surface request as an unanswered operation', async () => {
    const postMessage = vi.fn().mockResolvedValue(true)
    const router = new WebviewMessageRouter({
      postMessage,
      handleRequest: (_incoming, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    })

    const pending = router.handle(request('cancel-me'), 'editor:session-9')
    await Promise.resolve()
    router.cancelSurface('editor:session-9')
    await pending

    // The entry is gone, so the late handler completion cannot answer anybody.
    expect(postMessage).not.toHaveBeenCalled()
  })
})

describe('WebviewMessageRouter question waits', () => {
  const waitRequest = (type: string, requestId: string, callId: string): unknown => ({
    protocolVersion: 1,
    message: { type, requestId, payload: { sessionId: 'session-1', callId } },
  })

  it('keeps a wait owned by the surface that attached it', async () => {
    const signals = new Map<string, AbortSignal>()
    const router = new WebviewMessageRouter({
      postMessage: () => Promise.resolve(true),
      handleFeatureRequest: (request, signal) => {
        // Only the attach owns the long-lived wait; the release that follows
        // carries its own short-lived request signal.
        if (request.type === 'user-question.wait.attach') {
          const callId = (request as { readonly payload: { readonly callId: string } }).payload.callId
          signals.set(callId, signal)
        }
        return Promise.resolve({ kind: 'question.wait', remainingMs: 5_000 })
      },
    })

    await router.handle(waitRequest('user-question.wait.attach', 'attach-a', 'call-a'), 'sidebar')
    await router.handle(waitRequest('user-question.wait.attach', 'attach-b', 'call-b'), 'editor:s1')

    // Another surface releasing (or closing) the same session/call must not
    // cancel the question the first surface is still showing.
    await router.handle(waitRequest('user-question.wait.release', 'release-b', 'call-a'), 'editor:s1')
    expect(signals.get('call-a')?.aborted).toBe(false)
    expect(signals.get('call-b')?.aborted).toBe(false)

    await router.handle(waitRequest('user-question.wait.release', 'release-a', 'call-a'), 'sidebar')
    expect(signals.get('call-a')?.aborted).toBe(true)
    expect(signals.get('call-b')?.aborted).toBe(false)

    router.cancelAll()
  })

  it('aborts only its own surface waits when a surface is cancelled', async () => {
    const signals = new Map<string, AbortSignal>()
    const router = new WebviewMessageRouter({
      postMessage: () => Promise.resolve(true),
      handleFeatureRequest: (request, signal) => {
        // Only the attach owns the long-lived wait; the release that follows
        // carries its own short-lived request signal.
        if (request.type === 'user-question.wait.attach') {
          const callId = (request as { readonly payload: { readonly callId: string } }).payload.callId
          signals.set(callId, signal)
        }
        return Promise.resolve({ kind: 'question.wait', remainingMs: 5_000 })
      },
    })

    await router.handle(waitRequest('user-question.wait.attach', 'attach-a', 'call-a'), 'sidebar')
    await router.handle(waitRequest('user-question.wait.attach', 'attach-b', 'call-b'), 'editor:s1')

    router.cancelSurface('sidebar')

    expect(signals.get('call-a')?.aborted).toBe(true)
    expect(signals.get('call-b')?.aborted).toBe(false)

    router.cancelAll()
  })
})
