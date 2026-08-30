import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type ProtocolEnvelope } from '@dsh-vscode/webview-protocol'
import { ProtocolClient } from './protocol-client.js'

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

  it('matches exactly one response to each request id', async () => {
    const postMessage = vi.fn()
    const client = new ProtocolClient({ postMessage, getState: () => undefined, setState: () => undefined })
    const request = client.request<unknown>({ type: 'app.ready', requestId: 'same' })
    await expect(client.request({ type: 'app.ready', requestId: 'same' })).rejects.toThrow(
      'Duplicate request id',
    )
    client.handle({
      protocolVersion: PROTOCOL_VERSION,
      message: {
        type: 'response',
        requestId: 'same',
        ok: false,
        error: { code: 'BACKEND_BUSY', message: 'busy', retryable: true },
      },
    })
    await expect(request).rejects.toMatchObject({ code: 'BACKEND_BUSY' })
    expect(postMessage).toHaveBeenCalledTimes(1)
    client.dispose()
  })

  it('keeps an npm DSH install request pending beyond the ordinary request timeout', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const client = new ProtocolClient({
      postMessage: () => undefined,
      getState: () => undefined,
      setState: () => undefined,
    })
    try {
      const request = client.request<unknown>({
        type: 'runtime.update.install',
        requestId: 'install-1',
        payload: { version: '0.1.1-rc.1' },
      })

      expect(setTimeoutSpy.mock.calls.some(([, timeout]) => timeout === 180_000)).toBe(true)
      client.handle({
        protocolVersion: PROTOCOL_VERSION,
        message: { type: 'response', requestId: 'install-1', ok: true, payload: { status: 'ready' } },
      })
      await expect(request).resolves.toEqual({ status: 'ready' })
    } finally {
      setTimeoutSpy.mockRestore()
      client.dispose()
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
    await expect(first).rejects.toThrow('disposed')
    await expect(second).rejects.toThrow('disposed')
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

  it('rejects delayed feature events from a replaced backend instance', () => {
    const client = new ProtocolClient({
      postMessage: () => undefined,
      getState: () => undefined,
      setState: () => undefined,
    })
    const events: unknown[] = []
    client.subscribeFeature((message) => events.push(message))
    const snapshot = (sequence: number, backendInstanceId: string): unknown => ({
      protocolVersion: PROTOCOL_VERSION,
      message: {
        type: 'event',
        name: 'connection.snapshot',
        sequence,
        payload: { kind: 'connected', backendInstanceId, connectionGeneration: 1 },
      },
    })
    const event = (backendInstanceId: string, localSeq: number): unknown => ({
      protocolVersion: PROTOCOL_VERSION,
      message: {
        type: 'feature.event',
        name: 'editor.context.changed',
        identity: {
          backendInstanceId,
          connectionGeneration: 1,
          stream: 'local',
          localSeq,
        },
        contextRef: 'dsh-context-context-00000001',
        action: 'updated',
      },
    })

    client.handle(snapshot(1, 'backend-1'))
    client.handle(event('backend-1', 1))
    client.handle(snapshot(2, 'backend-2'))
    client.handle(event('backend-1', 2))
    client.handle(event('backend-2', 1))

    expect(events).toHaveLength(2)
    client.dispose()
  })
})
