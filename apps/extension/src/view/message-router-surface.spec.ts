import { describe, expect, it } from 'vitest'
import { WebviewMessageRouter } from './message-router.js'

const request = (requestId: string): unknown => ({
  protocolVersion: 1,
  message: { type: 'diagnostics.snapshot', requestId },
})

describe('WebviewMessageRouter surface routing', () => {
  it('refuses a cancellation from a different surface', async () => {
    let targetSignal: AbortSignal | undefined
    let release!: () => void
    const router = new WebviewMessageRouter({
      postMessage: () => Promise.resolve(true),
      handleRequest: (_request, signal) => {
        targetSignal = signal
        return new Promise((resolve) => {
          release = () => resolve({ answered: true })
        })
      },
    })
    const pending = router.handle(request('owned-by-editor'), 'editor:s1')
    await router.handle(
      {
        protocolVersion: 1,
        message: {
          type: 'feature.request.cancel',
          requestId: 'cancel-from-sidebar',
          payload: { targetRequestId: 'owned-by-editor' },
        },
      },
      'sidebar',
    )
    const aborted = targetSignal?.aborted
    release()
    await pending
    expect(aborted).toBe(false)
  })
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

  it('isolates identical correlation ids across surfaces and preserves duplicates within one surface', async () => {
    const delivered: (string | undefined)[] = []
    const releases: (() => void)[] = []
    const router = new WebviewMessageRouter({
      postMessage: (_message, surfaceId) => {
        delivered.push(surfaceId)
        return Promise.resolve(true)
      },
      handleRequest: () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ answered: true }))
        }),
    })
    const first = router.handle(request('shared-id'), 'sidebar')
    const second = router.handle(request('shared-id'), 'editor:s1')
    await router.handle(request('shared-id'), 'sidebar')
    expect(releases).toHaveLength(2)
    releases.forEach((release) => release())
    await Promise.all([first, second])
    expect(delivered).toEqual(['sidebar', 'editor:s1'])
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
