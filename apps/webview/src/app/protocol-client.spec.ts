import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROTOCOL_VERSION,
  type FeatureRequest,
  type ProtocolEnvelope,
  type WebviewRequest,
} from '@dsh-vscode/webview-protocol'
import { ProtocolClient, publicProtocolErrorMessage } from './protocol-client.js'

const listeners = new Set<(event: MessageEvent<unknown>) => void>()

beforeEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: (_name: string, listener: (event: MessageEvent<unknown>) => void) => {
        listeners.add(listener)
      },
      removeEventListener: (_name: string, listener: (event: MessageEvent<unknown>) => void) => {
        listeners.delete(listener)
      },
      setTimeout,
      clearTimeout,
    },
  })
})

afterEach(() => listeners.clear())

describe('ProtocolClient', () => {
  it.each([
    { request: { type: 'app.ready', requestId: 'startup' }, elapsed: 60_001 },
    { request: { type: 'connection.retry', requestId: 'retry' }, elapsed: 60_001 },
    {
      request: { type: 'runtime.update.check', requestId: 'check', payload: { force: true } },
      elapsed: 60_001,
    },
    {
      request: {
        type: 'runtime.update.install',
        requestId: 'install',
        payload: { version: '0.2.1-rc.3' },
      },
      elapsed: 600_001,
    },
    {
      request: {
        type: 'session.export',
        requestId: 'export',
        payload: { sessionId: 's1', format: 'zip', includeAttachments: true, includeReasoning: true },
      },
      elapsed: 120_001,
    },
    { request: { type: 'workspace.addFolder', requestId: 'picker' }, elapsed: 120_001 },
  ] satisfies readonly { request: WebviewRequest; elapsed: number }[])(
    'accepts the Host result after slow $request.type work exceeds an ordinary RPC',
    async ({ request, elapsed }) => {
      await completeSlowRequest({ request }, elapsed)
    },
  )

  it.each([
    {
      type: 'editor.companion.action',
      requestId: 'companion',
      payload: { action: 'setup' },
    },
    {
      type: 'plugin.bundle.install',
      requestId: 'plugin',
      payload: { spec: '@dsh-community/review', installRequestId: 'install-id' },
    },
    {
      type: 'plugin.bundle.waitForInstall',
      requestId: 'recovery',
      payload: { installRequestId: 'install-id' },
    },
    {
      type: 'checkpoint.restore',
      requestId: 'restore',
      payload: {
        checkpointId: 'checkpoint-1',
        sessionId: 's1',
        workspaceFolderId: 'folder-1',
        expectedCurrentRevision: 1,
        previewId: 'preview-1',
        conflictPolicy: 'overwrite',
      },
    },
  ] satisfies readonly FeatureRequest[])(
    'accepts the Host result after slow $type work exceeds an ordinary RPC',
    async (request) => {
      await completeSlowRequest({ request, feature: true }, 120_001)
    },
  )

  it('cancels only the requested Host operation and ignores its late response', async () => {
    const posted: ProtocolEnvelope[] = []
    const client = new ProtocolClient({
      postMessage: (value) => posted.push(value),
      getState: () => undefined,
      setState: () => undefined,
    })
    const controller = new AbortController()
    const sending = client.request(
      {
        type: 'session.sendPrompt',
        requestId: 'send-one',
        payload: { sessionId: 's1', text: 'hello', attachments: [], mode: 'queue' },
      },
      controller.signal,
    )
    const rejected = expect(sending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(posted[1]?.message).toMatchObject({
      type: 'feature.request.cancel',
      payload: { targetRequestId: 'send-one' },
    })
    client.handle({
      protocolVersion: PROTOCOL_VERSION,
      message: { type: 'response', requestId: 'send-one', ok: true, payload: {} },
    })
    const next = client.request({ type: 'app.ready', requestId: 'next' })
    client.handle({
      protocolVersion: PROTOCOL_VERSION,
      message: { type: 'response', requestId: 'next', ok: true, payload: {} },
    })
    await expect(next).resolves.toEqual({})
    client.dispose()
  })
  it('matches the response family as well as the request id', async () => {
    const client = new ProtocolClient({
      postMessage: () => undefined,
      getState: () => undefined,
      setState: () => undefined,
    })
    try {
      const resolved = vi.fn<(value: unknown) => void>()
      const legacy = client.request({ type: 'app.ready', requestId: 'legacy' }).then(resolved)
      const feature = client
        .featureRequest({
          type: 'feature.request.cancel',
          requestId: 'feature',
          payload: { targetRequestId: 'target' },
        })
        .then(resolved)
      void legacy.catch(() => undefined)
      void feature.catch(() => undefined)
      for (const [type, requestId] of [
        ['feature.response', 'legacy'],
        ['response', 'feature'],
      ])
        client.handle({
          protocolVersion: PROTOCOL_VERSION,
          message: { type, requestId, ok: true, payload: { kind: 'empty' } },
        })
      await Promise.resolve()
      expect(resolved).not.toHaveBeenCalled()
      for (const [type, requestId] of [
        ['response', 'legacy'],
        ['feature.response', 'feature'],
      ])
        client.handle({
          protocolVersion: PROTOCOL_VERSION,
          message: {
            type,
            requestId,
            ok: true,
            payload: type === 'response' ? { legacy: true } : { kind: 'empty' },
          },
        })
      await Promise.all([legacy, feature])
      expect(resolved.mock.calls.map(([value]) => value)).toEqual([{ legacy: true }, { kind: 'empty' }])
    } finally {
      client.dispose()
    }
  })

  it('validates messages before resolving requests or publishing events', async () => {
    const posted: ProtocolEnvelope[] = []
    const client = new ProtocolClient({
      postMessage: (message) => posted.push(message),
      getState: () => undefined,
      setState: () => undefined,
    })
    const events: unknown[] = []
    client.subscribe((message) => events.push(message))
    const request = client.request<unknown>({ type: 'app.ready', requestId: 'r1' })
    expect(posted).toHaveLength(1)
    client.handle({
      protocolVersion: PROTOCOL_VERSION,
      message: { type: 'event', name: 'bad', sequence: -1, payload: {} },
    })
    client.handle({
      protocolVersion: PROTOCOL_VERSION,
      message: { type: 'event', name: 'safe', sequence: 1, payload: { ok: true } },
    })
    client.handle({
      protocolVersion: PROTOCOL_VERSION,
      message: { type: 'response', requestId: 'r1', ok: true, payload: { connected: true } },
    })
    await expect(request).resolves.toEqual({ connected: true })
    expect(events).toHaveLength(1)
    client.dispose()
  })

  it('marks only a validated Host error summary for user display', async () => {
    const client = new ProtocolClient({
      postMessage: () => undefined,
      getState: () => undefined,
      setState: () => undefined,
    })
    const request = client.request({ type: 'app.ready', requestId: 'safe-host-error' })
    client.handle({
      protocolVersion: PROTOCOL_VERSION,
      message: {
        type: 'response',
        requestId: 'safe-host-error',
        ok: false,
        error: {
          code: 'BACKEND_BUSY',
          message: 'The DSH instance is busy.',
          retryable: true,
        },
      },
    })

    const reason = await request.catch((error: unknown) => error)
    expect(publicProtocolErrorMessage(reason)).toBe('The DSH instance is busy.')
    expect(publicProtocolErrorMessage(new Error('raw diagnostic'))).toBeUndefined()
    client.dispose()
  })

  it('bounds a prompt request, asks the Host to cancel it, and ignores a late success', async () => {
    const posted: ProtocolEnvelope[] = []
    const timeoutCallbacks: Array<() => void> = []
    const timeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation((handler) => {
      if (typeof handler === 'function') timeoutCallbacks.push(handler as () => void)
      return timeoutCallbacks.length as unknown as ReturnType<typeof setTimeout>
    })
    const client = new ProtocolClient({
      postMessage: (message) => posted.push(message),
      getState: () => undefined,
      setState: () => undefined,
    })
    try {
      const request = client.request<unknown>({
        type: 'session.sendPrompt',
        requestId: 'send-prompt-timeout',
        payload: { sessionId: 'session-1', text: 'hello', attachments: [], mode: 'queue' },
      })
      const outcome = request.then(
        (value) => ({ status: 'resolved' as const, value }),
        (reason: unknown) => ({
          status: 'rejected' as const,
          message: publicProtocolErrorMessage(reason),
        }),
      )

      expect(timeoutSpy.mock.calls[0]?.[1]).toBe(30_000)
      expect(timeoutCallbacks).toHaveLength(1)
      timeoutCallbacks[0]?.()
      const result = await outcome
      expect(result).toEqual({
        status: 'rejected',
        message:
          'The prompt response timed out. DSH may still have accepted it; check the session before retrying.',
      })
      expect(posted).toHaveLength(2)
      const cancellation = posted[1]?.message
      expect(cancellation?.type).toBe('feature.request.cancel')
      if (cancellation?.type !== 'feature.request.cancel') throw new Error('prompt cancel was not routed')
      expect(cancellation.payload.targetRequestId).toBe('send-prompt-timeout')

      client.handle({
        protocolVersion: PROTOCOL_VERSION,
        message: {
          type: 'feature.response',
          requestId: cancellation.requestId,
          ok: true,
          payload: { kind: 'operation', operationId: 'send-prompt-timeout', state: 'accepted' },
        },
      })
      client.handle({
        protocolVersion: PROTOCOL_VERSION,
        message: {
          type: 'response',
          requestId: 'send-prompt-timeout',
          ok: true,
          payload: { accepted: true },
        },
      })

      expect(await outcome).toBe(result)
      expect(publicProtocolErrorMessage(new Error('raw diagnostic'))).toBeUndefined()
    } finally {
      client.dispose()
      timeoutSpy.mockRestore()
    }
  })

  it('rejects every pending request on page disposal', async () => {
    const client = new ProtocolClient({
      postMessage: () => undefined,
      getState: () => undefined,
      setState: () => undefined,
    })
    const first = client.request({ type: 'app.ready', requestId: 'one' })
    const second = client.request({ type: 'connection.retry', requestId: 'two' })
    client.dispose()
    await expect(first).rejects.toThrow('This view has closed')
    await expect(second).rejects.toThrow('This view has closed')
  })

  it('does not persist prompts, tool output, endpoints, or credentials', () => {
    const getState = vi.fn(() => undefined)
    const setState = vi.fn()
    const client = new ProtocolClient({ postMessage: () => undefined, getState, setState })
    client.handle({
      protocolVersion: PROTOCOL_VERSION,
      message: {
        type: 'event',
        name: 'message.delta',
        sequence: 1,
        payload: { sessionId: 'session-1', delta: 'prompt body' },
      },
    })
    expect(getState).not.toHaveBeenCalled()
    expect(setState).not.toHaveBeenCalled()
    client.dispose()
  })

  it('rejects delayed feature events from an older connection generation', () => {
    const client = new ProtocolClient({
      postMessage: () => undefined,
      getState: () => undefined,
      setState: () => undefined,
    })
    const events: unknown[] = []
    client.subscribeFeature((message) => events.push(message))
    const event = (connectionGeneration: number, localSeq: number): unknown => ({
      protocolVersion: PROTOCOL_VERSION,
      message: {
        type: 'feature.event',
        name: 'editor.context.changed',
        identity: {
          backendInstanceId: 'backend-1',
          connectionGeneration,
          stream: 'local',
          localSeq,
        },
        contextRef: 'dsh-context-context-00000001',
        action: 'updated',
      },
    })

    client.handle(event(2, 1))
    client.handle(event(1, 99))
    client.handle(event(2, 1))
    client.handle(event(3, 1))
    expect(events).toHaveLength(2)
    client.dispose()
  })
})

async function completeSlowRequest(
  operation:
    | { readonly request: WebviewRequest; readonly feature?: false }
    | { readonly request: FeatureRequest; readonly feature: true },
  elapsed: number,
): Promise<void> {
  vi.useFakeTimers()
  const timer = vi
    .spyOn(window, 'setTimeout')
    .mockImplementation((handler, delay) => setTimeout(handler as () => void, delay))
  const clear = vi.spyOn(window, 'clearTimeout').mockImplementation((id) => clearTimeout(id))
  const client = new ProtocolClient({
    postMessage: () => undefined,
    getState: () => undefined,
    setState: () => undefined,
  })
  try {
    const pending = operation.feature
      ? client.featureRequest(operation.request)
      : client.request(operation.request)
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await vi.advanceTimersByTimeAsync(elapsed)
    expect(settled).toBe(false)
    const payload = operation.feature ? { kind: 'empty' } : { completed: true }
    client.handle({
      protocolVersion: PROTOCOL_VERSION,
      message: {
        type: operation.feature ? 'feature.response' : 'response',
        requestId: operation.request.requestId,
        ok: true,
        payload,
      },
    })
    await expect(pending).resolves.toEqual(payload)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    client.dispose()
    timer.mockRestore()
    clear.mockRestore()
    vi.useRealTimers()
  }
}
