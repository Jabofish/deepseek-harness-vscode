import { describe, expect, it, vi } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc6SessionRepository } from '../src/repositories/session-repository.js'

function sessionCreateTransport(calls: { method: string; params: unknown }[]): DshTransport {
  return {
    request: <TResponse>(method: string, params: unknown) => {
      calls.push({ method, params })
      const value =
        method === 'session.create'
          ? { sessionId: 'session-blank' }
          : method === 'session.list'
            ? {
                items: [
                  {
                    sessionId: 'session-blank',
                    updatedAt: 1,
                    running: false,
                    blank: true,
                    workspaceId: 'workspace-1',
                    cwd: 'C:\\workspace',
                  },
                ],
              }
            : { events: [], hasMore: false }
      return Promise.resolve({ result: { ok: true, value } } as TResponse)
    },
    remoteRequest: <TResponse>() => Promise.resolve({ result: { ok: true, value: [] } } as TResponse),
    openEventStream: async function* () {
      /* fixture stream */
    },
    close: () => Promise.resolve(),
  }
}

const createInput = {
  workspaceId: 'workspace-1',
  sessionId: 'session-blank',
  reuseWorkspaceBlank: true as const,
  configuration: {
    preset: 'standard',
    toolMode: 'native' as const,
    permissionPreset: 'workspace-write',
    planMode: false,
    model: { providerId: '', modelId: '' },
  },
}

describe('SessionRepository workspace blank reuse compatibility', () => {
  it('keeps the rc.6 request shape unchanged when reuse is requested by a newer client', async () => {
    const calls: { method: string; params: unknown }[] = []
    await new Rc6SessionRepository(sessionCreateTransport(calls)).create(createInput)

    expect(calls.find((call) => call.method === 'session.create')?.params).toEqual({
      workspaceId: 'workspace-1',
      agentPreset: 'standard',
    })
  })

  it('sends the exact rc.1 adoption fields only when the version adapter enables them', async () => {
    const calls: { method: string; params: unknown }[] = []
    await new Rc6SessionRepository(sessionCreateTransport(calls), undefined, undefined, {
      reuseWorkspaceBlank: true,
    }).create(createInput)

    expect(calls.find((call) => call.method === 'session.create')?.params).toEqual({
      workspaceId: 'workspace-1',
      sessionId: 'session-blank',
      reuseWorkspaceBlank: true,
    })
  })

  it('uses rc.2 session idempotency without sending the removed rc.1 field', async () => {
    const calls: { method: string; params: unknown }[] = []
    await new Rc6SessionRepository(sessionCreateTransport(calls), undefined, undefined, {
      preallocatedSessionId: true,
    }).create(createInput)

    expect(calls.find((call) => call.method === 'session.create')?.params).toEqual({
      workspaceId: 'workspace-1',
      sessionId: 'session-blank',
      agentPreset: 'standard',
    })
  })
})

describe('Rc6SessionRepository session listing', () => {
  it('omits an empty pagination cursor from the pinned request', async () => {
    const calls: { method: string; params: unknown }[] = []
    const repository = new Rc6SessionRepository(sessionCreateTransport(calls))

    await repository.list({ cursor: '' })
    await repository.list({ cursor: '   ' })

    expect(calls.filter((call) => call.method === 'session.list').map((call) => call.params)).toEqual([
      {},
      {},
    ])
  })

  it('does not let a partial list projection erase a valid image-limit cell', async () => {
    const calls: { method: string; params: unknown }[] = []
    const repository = new Rc6SessionRepository({
      request: <TResponse>(method: string, params: unknown) => {
        calls.push({ method, params })
        return Promise.resolve({
          result: {
            ok: true,
            value: {
              items: [
                {
                  sessionId: 'session-1',
                  updatedAt: 1,
                  running: false,
                  blank: false,
                  projections: {
                    asOfSeq: 1,
                    values: { sessionListMetadata: { blank: false, lastPromptAt: 1 } },
                  },
                },
              ],
            },
          },
        } as TResponse)
      },
      remoteRequest: <TResponse>() => Promise.reject<TResponse>(new Error('unexpected Remote')),
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    })
    repository.remember({
      type: 'session.projection',
      sessionId: 'session-1',
      key: 'imageLimits',
      value: {
        maxImageBytes: 8,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 8,
        maxImagePixels: 1_000,
        mediaTypes: ['image/jpeg'],
      },
    })

    await repository.list()

    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')
    await expect(
      repository.sendPrompt({
        sessionId: 'session-1',
        text: 'list hint must not widen admission',
        attachments: [{ uri: `data:image/png;base64,${png}`, name: 'preview.png', mimeType: 'image/png' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(calls.map((call) => call.method)).toEqual(['session.list'])
  })

  it('does not treat a partial list projection as authoritative during open', async () => {
    const calls: { method: string; params: unknown }[] = []
    const repository = new Rc6SessionRepository({
      request: <TResponse>(method: string, params: unknown) => {
        calls.push({ method, params })
        const value =
          method === 'session.list'
            ? {
                items: [
                  {
                    sessionId: 'session-1',
                    updatedAt: 1,
                    running: false,
                    blank: false,
                    projections: {
                      asOfSeq: 1,
                      values: { sessionListMetadata: { blank: false, lastPromptAt: 1 } },
                    },
                  },
                ],
              }
            : { events: [], hasMore: false }
        return Promise.resolve({ result: { ok: true, value } } as TResponse)
      },
      remoteRequest: <TResponse>() => Promise.reject<TResponse>(new Error('unexpected Remote')),
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    })
    repository.remember({
      type: 'session.projection',
      sessionId: 'session-1',
      key: 'imageLimits',
      value: {
        maxImageBytes: 8,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 8,
        maxImagePixels: 1_000,
        mediaTypes: ['image/jpeg'],
      },
    })

    await repository.list()
    await repository.get('session-1')

    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')
    await expect(
      repository.sendPrompt({
        sessionId: 'session-1',
        text: 'open hint must not widen admission',
        attachments: [{ uri: `data:image/png;base64,${png}`, name: 'preview.png', mimeType: 'image/png' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(calls.map((call) => call.method)).toEqual(['session.list', 'session.history'])
  })
})

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
          clientTimeZone: expect.stringMatching(/^[A-Za-z_]+\/[A-Za-z_0-9+-]+$|^UTC$/u) as unknown,
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
          clientTimeZone: expect.stringMatching(/^[A-Za-z_]+\/[A-Za-z_0-9+-]+$|^UTC$/u) as unknown,
        },
      },
    ])
  })

  it('only widens the prompt image envelope when the rc.2 adapter opts in', async () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 1)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
    const uri = `data:image/png;base64,${bytes.toString('base64')}`
    const input = {
      sessionId: 'session-1',
      text: 'inspect this image',
      attachments: [{ uri, name: 'large.png', mimeType: 'image/png' }],
    }

    await expect(new Rc6SessionRepository(recordingTransport([])).sendPrompt(input)).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    })

    const calls: { method: string; params: unknown }[] = []
    await new Rc6SessionRepository(recordingTransport(calls), undefined, undefined, {
      maxPromptAttachmentBytes: 20 * 1024 * 1024,
      maxPromptAttachmentTotalBytes: 200 * 1024 * 1024,
    }).sendPrompt(input)
    expect(calls[0]?.method).toBe('session.prompt')
    expect(calls[0]?.params).toMatchObject({
      content: [
        { type: 'text', text: 'inspect this image' },
        { type: 'image', mediaType: 'image/png' },
      ],
    })
  })

  it('uses the DSH imageLimits projection for Host-side prompt admission', async () => {
    const calls: { method: string; params: unknown }[] = []
    const repository = new Rc6SessionRepository(recordingTransport(calls))
    repository.remember({
      type: 'session.projection',
      sessionId: 'session-1',
      key: 'imageLimits',
      value: {
        maxImageBytes: 8,
        maxImagesPerMessage: 2,
        maxMessageImageBytes: 8,
        maxImagePixels: 1_000,
        maxImageDimension: 100,
        mediaTypes: ['image/png'],
      },
    })
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')
    const image = { uri: `data:image/png;base64,${png}`, name: 'preview.png', mimeType: 'image/png' }

    await expect(
      repository.sendPrompt({ sessionId: 'session-1', text: 'one', attachments: [image] }),
    ).resolves.toBeUndefined()
    await expect(
      repository.sendPrompt({ sessionId: 'session-1', text: 'two', attachments: [image, image] }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    repository.remember({
      type: 'session.projection',
      sessionId: 'session-1',
      key: 'imageLimits',
      value: {
        maxImageBytes: 8,
        maxImagesPerMessage: 2,
        maxMessageImageBytes: 8,
        maxImagePixels: 1_000,
        mediaTypes: ['image/jpeg'],
      },
    })
    await expect(
      repository.sendPrompt({ sessionId: 'session-1', text: 'wrong type', attachments: [image] }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(calls).toHaveLength(1)
  })

  it('preserves the last valid image limits when a later projection is malformed', async () => {
    const calls: { method: string; params: unknown }[] = []
    const repository = new Rc6SessionRepository(recordingTransport(calls))
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')
    const image = { uri: `data:image/png;base64,${png}`, name: 'preview.png', mimeType: 'image/png' }
    const limits = {
      maxImageBytes: 8,
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 8,
      maxImagePixels: 1_000,
      mediaTypes: ['image/jpeg'],
    }

    repository.remember({
      type: 'session.projection',
      sessionId: 'session-1',
      key: 'imageLimits',
      value: limits,
    })
    await expect(
      repository.sendPrompt({ sessionId: 'session-1', text: 'wrong type', attachments: [image] }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })

    repository.remember({
      type: 'session.projection',
      sessionId: 'session-1',
      key: 'imageLimits',
      value: { ...limits, mediaTypes: ['image/jpeg', {}] },
    })
    await expect(
      repository.sendPrompt({ sessionId: 'session-1', text: 'still wrong type', attachments: [image] }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(calls).toHaveLength(0)
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
      const firstRejection = expect(first).rejects.toMatchObject({ code: 'BACKEND_UNREACHABLE' })
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
      clientTimeZone: expect.stringMatching(/^[A-Za-z_]+\/[A-Za-z_0-9+-]+$|^UTC$/u) as unknown,
    })
  })

  it('does not replace a queued image message with a text-only edit', async () => {
    const calls: { method: string; params: unknown }[] = []
    const repository = new Rc6SessionRepository(recordingTransport(calls))
    repository.remember({
      type: 'queue.updated',
      sessionId: 'session-1',
      items: [
        {
          id: 'image-queued',
          sessionId: 'session-1',
          text: 'describe this',
          attachments: [],
          images: [
            {
              attachmentId: 'image-1',
              mediaType: 'image/png',
              bytes: 4,
              width: 2,
              height: 2,
            },
          ],
          mode: 'queue',
          createdAt: new Date().toISOString(),
        },
      ],
    })

    await expect(repository.updateQueuedInput('image-queued', 'new text')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    expect(calls).toEqual([])
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
  function configurationTransport(
    failingCommand?: string,
    permissionOptions: readonly unknown[] = [{ value: 'workspace-write' }, { value: 'read-only' }],
  ): {
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
                    permissions: { options: permissionOptions },
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

  it('fails closed when a permission roster contains a malformed option', async () => {
    const { transport, calls } = configurationTransport(undefined, [
      { value: 'workspace-write' },
      { value: { unexpected: true } },
    ])
    const repository = new Rc6SessionRepository(transport)

    await expect(
      repository.setConfiguration('session-1', {
        preset: 'standard',
        toolMode: 'native',
        permissionPreset: 'read-only',
        planMode: false,
        model: { providerId: 'provider-new', modelId: 'model-new', reasoningLevel: 'high' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(
      calls.some((call) => call.method === 'commands/execute' || call.method === 'session.selectModel'),
    ).toBe(false)
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
  it('opens from the authoritative history page without a redundant session.list read', async () => {
    const calls: { method: string; params: unknown }[] = []
    const transport: DshTransport = {
      request: <TResponse>(method: string, params: unknown) => {
        calls.push({ method, params })
        if (method !== 'session.history')
          return Promise.reject<TResponse>(new Error('unexpected session.list'))
        return Promise.resolve({
          result: { ok: true, value: { events: [], hasMore: false } },
        } as TResponse)
      },
      remoteRequest: <TResponse>() => Promise.reject<TResponse>(new Error('unexpected Remote')),
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    }

    await expect(new Rc6SessionRepository(transport).get('session-1')).resolves.toMatchObject({
      id: 'session-1',
      history: [],
    })
    expect(calls).toEqual([
      {
        method: 'session.history',
        params: { sessionId: 'session-1', maxMessages: 50 },
      },
    ])
  })

  it('runs the session-open rebaseline only after the authoritative history read', async () => {
    const order: string[] = []
    const transport: DshTransport = {
      request: <TResponse>(method: string) => {
        order.push(method)
        return Promise.resolve({
          result: { ok: true, value: { events: [], hasMore: false } },
        } as TResponse)
      },
      remoteRequest: <TResponse>() => Promise.reject<TResponse>(new Error('unexpected Remote')),
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    }
    const repository = new Rc6SessionRepository(transport, undefined, undefined, {
      onSessionAccess: () => order.push('follow.start'),
      onSessionOpen: () => {
        order.push('follow.rebaseline')
      },
    })

    await repository.open('session-1')

    expect(order).toEqual(['follow.start', 'session.history', 'follow.rebaseline'])
  })

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
        params: { sessionId: 'session-1', maxMessages: 50, beforeSeq: 42 },
      },
    ])
    expect(page).toMatchObject({ hasMore: true, beforeSequence: 14 })
    expect(page.events.map((entry) => entry.sequence)).toEqual([14, 20])
  })

  it('salvages the published session when workspace attachment fails', async () => {
    const calls: { method: string; params: unknown }[] = []
    const transport: DshTransport = {
      request: <TResponse>(method: string, params: unknown) => {
        calls.push({ method, params })
        if (method === 'session.create')
          return Promise.resolve({
            result: {
              ok: false,
              error: {
                code: 'workspace-attach-failed',
                message: 'attach failed',
                details: { sessionId: 'published-1' },
              },
            },
          } as TResponse)
        const value = method === 'session.history' ? { events: [], hasMore: false } : { items: [] }
        return Promise.resolve({ result: { ok: true, value } } as TResponse)
      },
      remoteRequest: <TResponse>() => Promise.reject<TResponse>(new Error('unexpected Remote')),
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    }

    const detail = await new Rc6SessionRepository(transport).create({
      workspaceId: 'workspace-1',
      configuration: {
        preset: '',
        toolMode: 'native',
        permissionPreset: 'workspace-write',
        planMode: false,
        model: { providerId: '', modelId: '' },
      },
    })

    expect(detail.id).toBe('published-1')
    expect(
      calls.filter((call) => call.method === 'session.create' || call.method === 'session.history'),
    ).toEqual([
      { method: 'session.create', params: { workspaceId: 'workspace-1' } },
      { method: 'session.history', params: { sessionId: 'published-1', maxMessages: 50 } },
    ])
  })

  it('keeps partial session.search results instead of failing broad queries', async () => {
    const transport: DshTransport = {
      request: <TResponse>(method: string) => {
        const value =
          method === 'session.list'
            ? {
                items: [
                  { sessionId: 'session-a', updatedAt: 2, running: false, blank: false },
                  { sessionId: 'session-b', updatedAt: 1, running: false, blank: false },
                ],
              }
            : method === 'session.search'
              ? { items: [{ sessionId: 'session-a', snippet: 'match' }], hasMore: true }
              : { events: [], hasMore: false }
        return Promise.resolve({ result: { ok: true, value } } as TResponse)
      },
      remoteRequest: <TResponse>() => Promise.reject<TResponse>(new Error('unexpected Remote')),
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    }

    const page = await new Rc6SessionRepository(transport).list({ search: 'wide query' })

    expect(page.items.map((item) => item.id)).toEqual(['session-a'])
  })
})

describe('Rc6SessionRepository concurrent identical enqueues', () => {
  it('does not send a second session.prompt while the first round trip is in flight', async () => {
    const calls: { method: string; params: unknown }[] = []
    const resolvers: Array<(value: unknown) => void> = []
    let rpcCounter = 0
    const transport: DshTransport = {
      request: <TResponse>(method: string, params: unknown) => {
        calls.push({ method, params })
        if (method !== 'session.prompt') return Promise.reject(new Error(`unexpected RPC ${method}`))
        rpcCounter += 1
        const rpcId = `rpc-${rpcCounter}`
        return new Promise<TResponse>((resolve) => {
          resolvers.push((value) => resolve({ rpcId, result: { ok: true, value } } as TResponse))
        })
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
    const second = repository.enqueuePrompt(input, 'queue')
    // The identity guard must be registered before the network round trip, or
    // a concurrent identical enqueue sends a duplicate prompt to the host.
    expect(calls.filter((call) => call.method === 'session.prompt')).toHaveLength(1)

    for (const resolve of resolvers) resolve({ accepted: true })
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
    await expect(first).resolves.toMatchObject({ id: 'queued-1' })
    await expect(second).resolves.toMatchObject({ id: 'queued-1' })
    expect(calls.filter((call) => call.method === 'session.prompt')).toHaveLength(1)
  })
})

describe('Rc6SessionRepository failed enqueue retries', () => {
  it('lets a concurrent identical enqueue retry after the first attempt is rejected', async () => {
    const calls: { method: string; params: unknown }[] = []
    const resolvers: Array<(value: unknown) => void> = []
    let rpcCounter = 0
    const transport: DshTransport = {
      request: <TResponse>(method: string, params: unknown) => {
        calls.push({ method, params })
        if (method !== 'session.prompt') return Promise.reject(new Error(`unexpected RPC ${method}`))
        rpcCounter += 1
        const rpcId = `rpc-${rpcCounter}`
        return new Promise<TResponse>((resolve) => {
          resolvers.push((value) => resolve({ rpcId, result: { ok: true, value } } as TResponse))
        })
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
    const second = repository.enqueuePrompt(input, 'queue')

    // The first attempt is rejected by the host; the concurrent waiter must
    // fall through and send its own prompt instead of hanging on the shared
    // identity promise.
    resolvers[0]?.({ ok: false, error: { code: 'bad-request', message: 'rejected' } })
    await expect(first).rejects.toBeTruthy()

    resolvers[1]?.({ accepted: true })
    repository.remember({
      type: 'queue.updated',
      sessionId: 'session-1',
      items: [
        {
          id: 'queued-2',
          sessionId: 'session-1',
          text: 'same text',
          attachments: [],
          mode: 'queue',
          createdAt: new Date().toISOString(),
          rpcId: 'rpc-2',
        },
      ],
    })
    await expect(second).resolves.toMatchObject({ id: 'queued-2' })
    expect(calls.filter((call) => call.method === 'session.prompt')).toHaveLength(2)
  })
})
