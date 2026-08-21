import { describe, expect, it, vi } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc6SessionRepository } from '../src/repositories/session-repository.js'

describe('Rc6SessionRepository session removal', () => {
  it('maps removal to the pinned rc.6 archive RPC', async () => {
    const requestImplementation = <TResponse>(
      method: string,
      params: unknown,
      _signal?: AbortSignal,
    ): Promise<TResponse> => {
      expect(method).toBe('workspace.archiveSession')
      expect(params).toEqual({ sessionId: 'session-1' })
      return Promise.resolve({
        result: { ok: true, value: { archivedSessionIds: ['session-1'] } },
      } as TResponse)
    }
    const request = vi.fn(requestImplementation) as unknown as DshTransport['request']
    const transport: DshTransport = {
      request,
      remoteRequest: <TResponse>() => Promise.resolve({ result: { ok: true, value: [] } } as TResponse),
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    }

    await new Rc6SessionRepository(transport).remove('session-1')

    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('Rc6SessionRepository prompt delivery modes', () => {
  function recordingTransport(params: { method: string; params: unknown }[]): DshTransport {
    return {
      request: <TResponse>(method: string, requestParams: unknown) => {
        params.push({ method, params: requestParams })
        return Promise.resolve({ result: { ok: true, value: { accepted: true } } } as TResponse)
      },
      remoteRequest: <TResponse>() => Promise.resolve({ result: { ok: true, value: [] } } as TResponse),
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    }
  }

  it('defaults sendPrompt to the pinned queue delivery mode', async () => {
    const calls: { method: string; params: unknown }[] = []
    await new Rc6SessionRepository(recordingTransport(calls)).sendPrompt({
      sessionId: 'session-1',
      text: 'hello',
      attachments: [],
    })
    expect(calls).toEqual([
      {
        method: 'session.prompt',
        params: {
          sessionId: 'session-1',
          mode: 'queue',
          content: [{ type: 'text', text: 'hello' }],
        },
      },
    ])
  })

  it('forwards the steer delivery mode through the pinned prompt RPC', async () => {
    const calls: { method: string; params: unknown }[] = []
    await new Rc6SessionRepository(recordingTransport(calls)).sendPrompt(
      { sessionId: 'session-1', text: 'redirect', attachments: [] },
      'steer',
    )
    expect(calls).toEqual([
      {
        method: 'session.prompt',
        params: {
          sessionId: 'session-1',
          mode: 'steer',
          content: [{ type: 'text', text: 'redirect' }],
        },
      },
    ])
  })

  it('rejects a malformed prompt receipt instead of consuming attachment handles as success', async () => {
    const transport = recordingTransport([])
    transport.request = <TResponse>() => Promise.resolve({ result: { ok: true, value: {} } } as TResponse)

    await expect(
      new Rc6SessionRepository(transport).sendPrompt({
        sessionId: 'session-1',
        text: 'hello',
        attachments: [],
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('does not send a duplicate prompt while an accepted request is awaiting a late queue identity', async () => {
    vi.useFakeTimers()
    try {
      const calls: { method: string; params: unknown }[] = []
      const transport: DshTransport = {
        request: <TResponse>(method: string, params: unknown) => {
          calls.push({ method, params })
          return Promise.resolve({
            rpcId: 'rpc-1',
            result: { ok: true, value: { accepted: true } },
          } as TResponse)
        },
        remoteRequest: <TResponse>() => Promise.reject<TResponse>(new Error('unexpected Remote')),
        openEventStream: async function* () {
          /* fixture stream */
        },
        close: () => Promise.resolve(),
      }
      const repository = new Rc6SessionRepository(transport)
      const input = { sessionId: 'session-1', text: 'same text', attachments: [] }
      const first = repository.enqueuePrompt(input, 'queue')
      const firstRejection = expect(first).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
      await vi.advanceTimersByTimeAsync(2_000)
      await firstRejection

      const retry = repository.enqueuePrompt(input, 'queue')
      expect(calls.filter((call) => call.method === 'session.prompt')).toHaveLength(1)
      repository.remember({
        type: 'queue.updated',
        sessionId: 'session-1',
        items: [
          {
            id: 'queued-1',
            sessionId: 'session-1',
            text: 'same text',
            attachments: [],
            mode: 'queue',
            createdAt: new Date().toISOString(),
            rpcId: 'rpc-1',
          },
        ],
      })
      await expect(retry).resolves.toMatchObject({ id: 'queued-1' })
      expect(calls.filter((call) => call.method === 'session.prompt')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves a sanitized image name in the pinned prompt content part', async () => {
    const calls: { method: string; params: unknown }[] = []
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')

    await new Rc6SessionRepository(recordingTransport(calls)).sendPrompt({
      sessionId: 'session-1',
      text: '',
      attachments: [
        {
          uri: `data:image/png;base64,${png}`,
          name: 'folder\\preview.png',
          mimeType: 'image/png',
        },
      ],
    })

    expect(calls[0]?.params).toEqual({
      sessionId: 'session-1',
      mode: 'queue',
      content: [
        { type: 'text', text: '' },
        { type: 'image', mediaType: 'image/png', data: png, name: 'preview.png' },
      ],
    })
  })

  it('rejects decoder-tolerated non-canonical prompt Base64', async () => {
    const repository = new Rc6SessionRepository(recordingTransport([]))

    await expect(
      repository.sendPrompt({
        sessionId: 'session-1',
        text: '',
        attachments: [
          {
            uri: 'data:image/png;base64,iVBORw0KGgp=',
            name: 'preview.png',
            mimeType: 'image/png',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
  })
})

describe('Rc6SessionRepository historical attachments', () => {
  function attachmentTransport(data: string): DshTransport {
    return {
      request: <TResponse>(method: string) => {
        expect(method).toBe('session.attachment')
        return Promise.resolve({
          result: {
            ok: true,
            value: {
              attachment: {
                attachmentId: 'attachment-1',
                name: 'image.png',
                mediaType: 'image/png',
                bytes: 8,
                width: 1,
                height: 1,
              },
              data,
            },
          },
        } as TResponse)
      },
      remoteRequest: <TResponse>() => Promise.reject<TResponse>(new Error('unexpected Remote')),
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    }
  }

  it('accepts canonical image bytes and rejects equivalent non-canonical Base64', async () => {
    const canonical = 'iVBORw0KGgo='
    const repository = new Rc6SessionRepository(attachmentTransport(canonical))

    await expect(repository.readAttachment('session-1', 'attachment-1')).resolves.toMatchObject({
      uri: `data:image/png;base64,${canonical}`,
      mimeType: 'image/png',
    })

    await expect(
      new Rc6SessionRepository(attachmentTransport('iVBORw0KGgp=')).readAttachment(
        'session-1',
        'attachment-1',
      ),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
})

describe('Rc6SessionRepository configuration safety', () => {
  function configurationTransport(failingCommand?: string): {
    readonly transport: DshTransport
    readonly calls: { method: string; params: unknown }[]
  } {
    const calls: { method: string; params: unknown }[] = []
    const transport: DshTransport = {
      request: async <TResponse>(method: string, params: unknown) => {
        await Promise.resolve()
        calls.push({ method, params })
        if (method === 'session.list')
          return {
            result: {
              ok: true,
              value: {
                items: [
                  {
                    sessionId: 'session-1',
                    updatedAt: 1_000,
                    running: false,
                    blank: false,
                    agentPreset: 'standard',
                  },
                ],
              },
            },
          } as TResponse
        if (method === 'session.history')
          return {
            result: {
              ok: true,
              value: {
                events: [
                  {
                    event: {
                      type: 'request/header',
                      seq: 1,
                      time: 1_000,
                      data: {
                        header: {
                          config: { provider: 'provider-old', model: 'model-old', reasoningEffort: 'low' },
                        },
                      },
                    },
                  },
                ],
                hasMore: false,
                projections: {
                  asOfSeq: 1,
                  values: {
                    permissions: { options: [{ value: 'workspace-write' }, { value: 'read-only' }] },
                  },
                },
              },
            },
          } as TResponse
        if (method === 'session.selectModel')
          return {
            result: {
              ok: true,
              value: { selected: { provider: 'provider-new', model: 'model-new', reasoningEffort: 'high' } },
            },
          } as TResponse
        throw new Error(`unexpected request ${method}`)
      },
      remoteRequest: async <TResponse>(_endpoint: string, params: unknown) => {
        await Promise.resolve()
        calls.push({ method: 'commands/execute', params })
        const line = (params as { readonly line?: unknown }).line
        if (line === failingCommand)
          return {
            ok: false,
            error: { code: 'command-error', message: 'command rejected', details: {} },
          } as TResponse
        return { ok: true, value: { result: { kind: 'success' } } } as TResponse
      },
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    }
    return { transport, calls }
  }

  it('does not pretend to support archived filtering without workspace state', async () => {
    const { transport } = configurationTransport()
    await expect(new Rc6SessionRepository(transport).list({ archived: true })).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
  })

  it('rejects an unadvertised permission before mutating the model', async () => {
    const { transport, calls } = configurationTransport()
    const repository = new Rc6SessionRepository(transport)

    await expect(
      repository.setConfiguration('session-1', {
        preset: 'standard',
        toolMode: 'native',
        permissionPreset: 'custom',
        planMode: false,
        model: { providerId: 'provider-new', modelId: 'model-new', reasoningLevel: 'high' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(calls.some((call) => call.method === 'session.selectModel')).toBe(false)
  })

  it('rolls back a permission change when a later configuration command fails', async () => {
    const { transport, calls } = configurationTransport('/plan')
    const repository = new Rc6SessionRepository(transport)

    await expect(
      repository.setConfiguration('session-1', {
        preset: 'standard',
        toolMode: 'native',
        permissionPreset: 'read-only',
        planMode: true,
        model: { providerId: 'provider-new', modelId: 'model-new', reasoningLevel: 'high' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(
      calls
        .filter((call) => call.method === 'commands/execute')
        .map((call) => (call.params as { readonly line: string }).line),
    ).toEqual(['/permission read-only', '/plan', '/permission workspace-write'])
    expect(calls.some((call) => call.method === 'session.selectModel')).toBe(false)
  })
})

describe('Rc6SessionRepository history windows', () => {
  it('uses the official tail-page and beforeSeq contract without reading the whole log', async () => {
    const calls: { method: string; params: unknown }[] = []
    const transport: DshTransport = {
      request: <TResponse>(method: string, params: unknown) => {
        calls.push({ method, params })
        return Promise.resolve({
          result: {
            ok: true,
            value: {
              events: [
                {
                  event: { type: 'turn/start', seq: 14, time: 1_000 },
                },
                {
                  event: { type: 'assistant/message', seq: 20, time: 2_000, data: { markdown: 'older' } },
                },
              ],
              hasMore: true,
            },
          },
        } as TResponse)
      },
      remoteRequest: <TResponse>() => Promise.reject<TResponse>(new Error('unexpected Remote')),
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    }

    const page = await new Rc6SessionRepository(transport).history('session-1', 42)

    expect(calls).toEqual([
      {
        method: 'session.history',
        params: { sessionId: 'session-1', maxMessages: 200, beforeSeq: 42 },
      },
    ])
    expect(page).toMatchObject({ hasMore: true, beforeSequence: 14 })
    expect(page.events.map((entry) => entry.sequence)).toEqual([14, 20])
  })
})
