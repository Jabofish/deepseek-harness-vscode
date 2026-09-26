import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type ProtocolEnvelope } from '@dsh-vscode/webview-protocol'
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

  it('keeps a prompt success that settles before its timeout callback', async () => {
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
        requestId: 'send-prompt-success',
        payload: { sessionId: 'session-1', text: 'hello', attachments: [], mode: 'queue' },
      })
      client.handle({
        protocolVersion: PROTOCOL_VERSION,
        message: {
          type: 'response',
          requestId: 'send-prompt-success',
          ok: true,
          payload: { accepted: true },
        },
      })
      timeoutCallbacks[0]?.()

      await expect(request).resolves.toEqual({ accepted: true })
      expect(posted).toHaveLength(1)
    } finally {
      client.dispose()
      timeoutSpy.mockRestore()
    }
  })

  it('keeps a session export alive past the ordinary request timeout', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const client = new ProtocolClient({
      postMessage: () => undefined,
      getState: () => undefined,
      setState: () => undefined,
    })
    try {
      const request = client.request<unknown>({
        type: 'session.export',
        requestId: 'export-1',
        payload: {
          sessionId: 'session-1',
          format: 'zip',
          includeAttachments: true,
          includeReasoning: true,
        },
      })
      // Keep a pre-assertion failure from surfacing as an unhandled rejection
      // when dispose() settles the still-pending request below.
      void request.catch(() => undefined)

      // The Host deflates the whole session into the archive and reads a
      // paged history for the text formats, so the export outlives an ordinary
      // round trip. A client deadline below that reports a failure for a file
      // the Host then finishes writing.
      expect(setTimeoutSpy.mock.calls.some(([, timeout]) => timeout === 180_000)).toBe(true)
      client.handle({
        protocolVersion: PROTOCOL_VERSION,
        message: { type: 'response', requestId: 'export-1', ok: true, payload: { cancelled: false } },
      })
      await expect(request).resolves.toEqual({ cancelled: false })
    } finally {
      setTimeoutSpy.mockRestore()
      client.dispose()
    }
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

  it('outlasts the two npm calls a host update check runs in sequence', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const client = new ProtocolClient({
      postMessage: () => undefined,
      getState: () => undefined,
      setState: () => undefined,
    })
    try {
      const request = client.request<unknown>({
        type: 'runtime.update.check',
        requestId: 'update-check-1',
        payload: { force: true },
      })

      // The Host runs `npm view` and then `npm list --global`, each with its own
      // 30s budget, before it can answer. A shorter client budget aborts a check
      // the Host is still running, reports a timeout for work that succeeds, and
      // drops the version list the drawer was waiting for.
      const budgets = setTimeoutSpy.mock.calls.map(([, timeout]) => timeout)
      expect(budgets.some((timeout) => typeof timeout === 'number' && timeout >= 60_000)).toBe(true)
      client.handle({
        protocolVersion: PROTOCOL_VERSION,
        message: { type: 'response', requestId: 'update-check-1', ok: true, payload: { status: 'ready' } },
      })
      await expect(request).resolves.toEqual({ status: 'ready' })
    } finally {
      setTimeoutSpy.mockRestore()
      client.dispose()
    }
  })

  it('keeps a workspace-restoring feature request alive past the chat timeout', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const client = new ProtocolClient({
      postMessage: () => undefined,
      getState: () => undefined,
      setState: () => undefined,
    })
    try {
      const request = client.featureRequest<unknown>({
        type: 'checkpoint.restore',
        requestId: 'restore-1',
        payload: {
          checkpointId: 'checkpoint-1',
          sessionId: 'session-1',
          workspaceFolderId: 'workspace-1',
          expectedCurrentRevision: 1,
          previewId: 'dsh-preview-test-1',
          conflictPolicy: 'abort',
        },
      })

      // Restoring a checkpoint writes every recorded file back through the
      // Host file API and can exceed the chat request timeout.
      expect(setTimeoutSpy.mock.calls.map(([, timeout]) => timeout)).toContain(180_000)
      client.handle({
        protocolVersion: PROTOCOL_VERSION,
        message: {
          type: 'feature.response',
          requestId: 'restore-1',
          ok: true,
          payload: { kind: 'operation', operationId: 'restore-1', state: 'completed' },
        },
      })
      await expect(request).resolves.toMatchObject({ state: 'completed' })
    } finally {
      setTimeoutSpy.mockRestore()
      client.dispose()
    }
  })

  it('gives plugin install and same-request recovery enough time to finish', () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const client = new ProtocolClient({
      postMessage: () => undefined,
      getState: () => undefined,
      setState: () => undefined,
    })
    try {
      const install = client.featureRequest<unknown>({
        type: 'plugin.bundle.install',
        requestId: 'plugin-install-call-1',
        payload: { spec: '@dsh-community/review', installRequestId: 'plugin-install-id-1' },
      })
      const recovery = client.featureRequest<unknown>({
        type: 'plugin.bundle.waitForInstall',
        requestId: 'plugin-install-wait-1',
        payload: { installRequestId: 'plugin-install-id-1' },
      })
      void install.catch(() => undefined)
      void recovery.catch(() => undefined)

      expect(setTimeoutSpy.mock.calls.filter(([, timeout]) => timeout === 600_000)).toHaveLength(2)
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

describe('native picker request lifetime', () => {
  it('does not apply the ordinary RPC budget while the user selects a directory', async () => {
    const timeout = vi.spyOn(window, 'setTimeout')
    const client = new ProtocolClient({
      postMessage: () => undefined,
      getState: () => undefined,
      setState: () => undefined,
    })
    try {
      const pending = client.request({ type: 'workspace.addFolder', requestId: 'folder-picker' })
      expect(timeout.mock.calls.map(([, duration]) => duration)).toContain(600_000)
      client.handle({
        protocolVersion: PROTOCOL_VERSION,
        message: {
          type: 'response',
          requestId: 'folder-picker',
          ok: true,
          payload: { opened: true },
        },
      })
      await expect(pending).resolves.toEqual({ opened: true })
    } finally {
      client.dispose()
      timeout.mockRestore()
    }
  })
})
