import { describe, expect, it, vi } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { historyGapRecovery, Rc6SessionRepository } from '../src/repositories/session-repository.js'

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

describe('Rc6SessionRepository blank session detail', () => {
  it('reports a Session with no turn as idle, exactly like the list row the host publishes', async () => {
    const calls: string[] = []
    const repository = new Rc6SessionRepository({
      request: <TResponse>(method: string) => {
        calls.push(method)
        const value = method === 'session.history' ? { events: [], hasMore: false } : {}
        return Promise.resolve({ result: { ok: true, value } } as TResponse)
      },
      remoteRequest: <TResponse>() => Promise.reject<TResponse>(new Error('unexpected Remote')),
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    })

    const detail = await repository.get('session-fresh')

    // A brand-new Session is opened through this fallback before any list
    // response has cached a row for it. The host calls that Session blank and
    // its list row reads `idle`; a detail that answers `completed` instead
    // disables the composer's Agent-preset control the user has not used yet.
    expect(detail.blank).toBe(true)
    expect(detail.status).toBe('idle')
    expect(calls).toEqual(['session.history'])
  })

  it('still reports a finished Session with a human turn as completed', async () => {
    const repository = new Rc6SessionRepository({
      request: <TResponse>(method: string) =>
        Promise.resolve({
          result: {
            ok: true,
            value:
              method === 'session.history'
                ? {
                    events: [
                      {
                        event: {
                          type: 'user/message',
                          seq: 1,
                          time: 2,
                          data: {
                            id: 'user-1',
                            role: 'user',
                            source: { kind: 'user' },
                            content: [{ type: 'text', text: 'hello' }],
                          },
                        },
                      },
                    ],
                    hasMore: false,
                  }
                : {},
          },
        } as TResponse),
      remoteRequest: <TResponse>() => Promise.reject<TResponse>(new Error('unexpected Remote')),
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    })

    const detail = await repository.get('session-finished')

    expect(detail.blank).toBe(false)
    expect(detail.status).toBe('completed')
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
          clientTimeZone: expect.stringMatching(
            /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$|^UTC$/u,
          ) as unknown,
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
          clientTimeZone: expect.stringMatching(
            /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$|^UTC$/u,
          ) as unknown,
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

  it('keeps the enforceable image limits when DSH advertises a type this client cannot encode', async () => {
    const calls: { method: string; params: unknown }[] = []
    const repository = new Rc6SessionRepository(recordingTransport(calls))
    repository.remember({
      type: 'session.projection',
      sessionId: 'session-1',
      key: 'imageLimits',
      value: {
        maxImageBytes: 8,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 8,
        maxImagePixels: 1_000,
        mediaTypes: ['image/png', 'image/avif'],
      },
    })
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')
    const image = { uri: `data:image/png;base64,${png}`, name: 'preview.png', mimeType: 'image/png' }

    await expect(
      repository.sendPrompt({ sessionId: 'session-1', text: 'one', attachments: [image] }),
    ).resolves.toBeUndefined()
    // An unknown image type narrows what this client can send; it must not
    // discard the byte and count limits the same projection carries.
    await expect(
      repository.sendPrompt({ sessionId: 'session-1', text: 'two', attachments: [image, image] }),
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
            textOnly: true,
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
      clientTimeZone: expect.stringMatching(
        /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$|^UTC$/u,
      ) as unknown,
    })
  })

  it('rejects empty prompt content before sending it to DSH', async () => {
    const calls: { method: string; params: unknown }[] = []
    const repository = new Rc6SessionRepository(recordingTransport(calls))
    const input = { sessionId: 'session-1', text: ' \n\t', attachments: [] }

    await expect(repository.sendPrompt(input)).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    await expect(repository.enqueuePrompt(input, 'queue')).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    })
    expect(calls).toEqual([])
  })

  it('rejects a whitespace-only queue edit before sending it to DSH', async () => {
    const calls: { method: string; params: unknown }[] = []
    const repository = new Rc6SessionRepository(recordingTransport(calls))
    repository.remember({
      type: 'queue.updated',
      sessionId: 'session-1',
      items: [
        {
          id: 'queued-1',
          sessionId: 'session-1',
          text: 'original',
          attachments: [],
          textOnly: true,
          mode: 'queue',
          createdAt: new Date().toISOString(),
        },
      ],
    })

    await expect(repository.updateQueuedInput('queued-1', ' \n\t')).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    })
    expect(calls).toEqual([])
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
          textOnly: false,
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

  it('does not replace a queued file message with a text-only edit', async () => {
    // The host admits a `file` part on the same queue wire as text and images;
    // only the image branch was guarded before, so a file-bearing row passed
    // the text-only edit and lost the file the model was meant to read.
    const calls: { method: string; params: unknown }[] = []
    const repository = new Rc6SessionRepository(recordingTransport(calls))
    repository.remember({
      type: 'queue.updated',
      sessionId: 'session-1',
      items: [
        {
          id: 'file-queued',
          sessionId: 'session-1',
          text: 'summarize this',
          attachments: [],
          textOnly: false,
          files: ['spec.md'],
          mode: 'queue',
          createdAt: new Date().toISOString(),
        },
      ],
    })

    await expect(repository.updateQueuedInput('file-queued', 'new text')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    expect(calls).toEqual([])
  })

  it('edits a text-only queued prompt through the wire action the host accepts', async () => {
    const calls: { method: string; params: unknown }[] = []
    const repository = new Rc6SessionRepository(recordingTransport(calls))
    repository.remember({
      type: 'queue.updated',
      sessionId: 'session-1',
      items: [
        {
          id: 'queued-1',
          sessionId: 'session-1',
          text: 'original',
          attachments: [],
          textOnly: true,
          mode: 'queue',
          createdAt: new Date().toISOString(),
        },
      ],
    })

    await repository.updateQueuedInput('queued-1', 'edited')

    expect(calls).toEqual([
      {
        method: 'session.updateQueue',
        params: {
          sessionId: 'session-1',
          itemId: 'queued-1',
          action: { kind: 'edit', content: [{ type: 'text', text: 'edited' }] },
        },
      },
    ])
  })

  it('sends the remove and steer actions in the shared queue shape', async () => {
    const calls: { method: string; params: unknown }[] = []
    const repository = new Rc6SessionRepository(recordingTransport(calls))
    repository.remember({
      type: 'queue.updated',
      sessionId: 'session-1',
      items: [
        {
          id: 'queued-1',
          sessionId: 'session-1',
          text: 'original',
          attachments: [],
          textOnly: true,
          mode: 'queue',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'queued-2',
          sessionId: 'session-1',
          text: 'second',
          attachments: [],
          textOnly: true,
          mode: 'queue',
          createdAt: new Date().toISOString(),
        },
      ],
    })

    await repository.removeQueuedInput('queued-1')
    await repository.convertQueuedInputToSteer('queued-2')

    expect(calls).toEqual([
      {
        method: 'session.updateQueue',
        params: { sessionId: 'session-1', itemId: 'queued-1', action: { kind: 'remove' } },
      },
      {
        method: 'session.updateQueue',
        params: { sessionId: 'session-1', itemId: 'queued-2', action: { kind: 'steer' } },
      },
    ])
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

describe('Rc6SessionRepository queue steering convergence', () => {
  const failure = (code: string): DshTransport => ({
    request: <TResponse>() =>
      Promise.resolve({ result: { ok: false, error: { code, message: 'queue refused' } } } as TResponse),
    remoteRequest: <TResponse>() => Promise.resolve({ result: { ok: true, value: [] } } as TResponse),
    openEventStream: async function* () {
      /* fixture stream */
    },
    close: () => Promise.resolve(),
  })

  function steerable(transport: DshTransport): Rc6SessionRepository {
    const repository = new Rc6SessionRepository(transport)
    repository.remember({
      type: 'queue.updated',
      sessionId: 'session-1',
      items: [
        {
          id: 'queued-1',
          sessionId: 'session-1',
          text: 'steer me',
          attachments: [],
          textOnly: true,
          mode: 'queue',
          createdAt: new Date().toISOString(),
        },
      ],
    })
    return repository
  }

  it('treats an already-claimed item as converged instead of a failure', async () => {
    // The official client returns silently on both of these: the row is no
    // longer pending, which is exactly what the Steer gesture asked for.
    await expect(
      steerable(failure('queue-item-not-found')).convertQueuedInputToSteer('queued-1'),
    ).resolves.toBeUndefined()
    await expect(
      steerable(failure('steer-unavailable')).convertQueuedInputToSteer('queued-1'),
    ).resolves.toBeUndefined()
  })

  it('still reports a queue failure that did not converge', async () => {
    await expect(
      steerable(failure('agent-busy')).convertQueuedInputToSteer('queued-1'),
    ).rejects.toMatchObject({ code: 'BACKEND_BUSY' })
  })

  it('keeps remove and edit failures visible to the caller', async () => {
    await expect(
      steerable(failure('queue-item-not-found')).removeQueuedInput('queued-1'),
    ).rejects.toMatchObject({ code: 'STALE_INTERACTION' })
    await expect(
      steerable(failure('queue-item-not-found')).updateQueuedInput('queued-1', 'edited'),
    ).rejects.toMatchObject({ code: 'STALE_INTERACTION' })
  })
})

describe('Rc6SessionRepository historical attachments', () => {
  function attachmentTransport(data: string, bytes = 8): DshTransport {
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
                bytes,
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

  it('reads a historical image that exceeds the current prompt admission limit', async () => {
    const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(1_992, 7)])
    const repository = new Rc6SessionRepository(attachmentTransport(bytes.toString('base64'), bytes.length))
    repository.remember({
      type: 'session.projection',
      sessionId: 'session-1',
      key: 'imageLimits',
      value: {
        maxImageBytes: 1_000,
        maxImagesPerMessage: 2,
        maxMessageImageBytes: 2_000,
        maxImagePixels: 1_000,
        mediaTypes: ['image/png'],
      },
    })

    // `imageLimits` governs what may be *sent* now; DSH may still hold a larger
    // image from an earlier turn and the read has to display it.
    await expect(repository.readAttachment('session-1', 'attachment-1')).resolves.toMatchObject({
      mimeType: 'image/png',
    })
  })

  it('blames the size of a historical image beyond what this client can carry', async () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 1)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
    const repository = new Rc6SessionRepository(attachmentTransport(bytes.toString('base64'), bytes.length))

    await expect(repository.readAttachment('session-1', 'attachment-1')).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      message: expect.stringContaining('too large') as unknown,
    })
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

  it('fails the configuration when the host does not know the plan command', async () => {
    const { transport, calls } = configurationTransport()
    const unresolvedTransport: DshTransport = {
      ...transport,
      remoteRequest: async <TResponse>(_endpoint: string, params: Readonly<Record<string, unknown>>) => {
        const answer = await transport.remoteRequest<unknown>(_endpoint, params)
        return (
          params.line === '/plan' && _endpoint === 'commands/execute'
            ? { ok: true, value: undefined }
            : answer
        ) as TResponse
      },
    }
    const repository = new Rc6SessionRepository(unresolvedTransport)

    // An unresolved line is a skill gesture on the command surface, but a
    // session configuration command has to be applied: reporting it as unknown
    // must not let the configuration believe plan mode was entered.
    await expect(
      repository.setConfiguration('session-1', {
        preset: 'standard',
        toolMode: 'native',
        permissionPreset: 'workspace-write',
        planMode: true,
        model: { providerId: 'provider-new', modelId: 'model-new', reasoningLevel: 'high' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(
      calls
        .filter((call) => call.method === 'commands/execute')
        .map((call) => (call.params as { readonly line: string }).line),
    ).toEqual(['/plan'])
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

  it('keeps interleaved deltas in their durable order', async () => {
    const transport: DshTransport = {
      request: <TResponse>() =>
        Promise.resolve({
          result: {
            ok: true,
            value: {
              events: [
                {
                  event: {
                    type: 'assistant/chunk',
                    seq: 1,
                    time: 1_000,
                    data: {
                      turn: 1,
                      step: 1,
                      chunk: { type: 'text-delta', index: 0, text: 'first ' },
                    },
                  },
                },
                {
                  event: {
                    type: 'assistant/chunk',
                    seq: 2,
                    time: 2_000,
                    data: {
                      turn: 1,
                      step: 1,
                      chunk: { type: 'text-delta', index: 1, text: 'prefix ' },
                    },
                  },
                },
                {
                  event: {
                    type: 'tool/call',
                    seq: 3,
                    time: 3_000,
                    data: { turn: 1, step: 1, callId: 'call-1', name: 'shell', arguments: '{}' },
                  },
                },
                {
                  event: {
                    type: 'assistant/chunk',
                    seq: 4,
                    time: 4_000,
                    data: {
                      turn: 1,
                      step: 1,
                      chunk: { type: 'text-delta', index: 2, text: 'second' },
                    },
                  },
                },
                {
                  event: {
                    type: 'tool/result',
                    seq: 5,
                    time: 5_000,
                    data: {
                      turn: 1,
                      step: 1,
                      callId: 'call-1',
                      message: {
                        id: 'tool-result-1',
                        role: 'user',
                        source: { kind: 'tool', callId: 'call-1' },
                        content: [
                          {
                            type: 'tool-result',
                            toolCallId: 'call-1',
                            content: [{ type: 'text', text: 'ok' }],
                          },
                        ],
                      },
                    },
                  },
                },
              ],
              hasMore: false,
            },
          },
        } as TResponse),
      remoteRequest: <TResponse>() => Promise.reject<TResponse>(new Error('unexpected Remote')),
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    }

    const page = await new Rc6SessionRepository(transport).history('session-1')

    expect(page.events.map((entry) => entry.sequence)).toEqual([2, 3, 4, 5])
    expect(page.events.map((entry) => entry.event.type)).toEqual([
      'message.delta',
      'tool.updated',
      'message.delta',
      'tool.updated',
    ])
    expect(page.events[0]).toMatchObject({
      sequence: 2,
      event: { type: 'message.delta', sequence: 2, delta: 'first prefix ' },
      coveredSequences: [1, 2],
    })
    expect(page.events[2]).toMatchObject({
      sequence: 4,
      event: { type: 'message.delta', sequence: 4, delta: 'second' },
    })
  })

  it('uses an un-compacted internal history path for recovery without exposing system prompts', async () => {
    const rawEvents = [
      {
        event: {
          type: 'system/message',
          seq: 0,
          time: 1_000,
          data: { message: { content: [{ type: 'text', text: 'secret system prompt' }] } },
        },
      },
      {
        event: {
          type: 'assistant/chunk',
          seq: 1,
          time: 1_001,
          data: {
            turn: 1,
            step: 1,
            messageId: 'assistant-1',
            chunk: { type: 'text-delta', index: 0, text: 'first ' },
          },
        },
      },
      {
        event: {
          type: 'tool/call',
          seq: 2,
          time: 1_002,
          data: { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"a"}' },
        },
      },
      {
        event: {
          type: 'assistant/chunk',
          seq: 3,
          time: 1_003,
          data: {
            turn: 1,
            step: 1,
            messageId: 'assistant-1',
            chunk: { type: 'text-delta', index: 1, text: 'second' },
          },
        },
      },
      {
        event: {
          type: 'tool/result',
          seq: 4,
          time: 1_004,
          data: {
            turn: 1,
            step: 1,
            callId: 'call-1',
            message: {
              id: 'tool-result-1',
              role: 'user',
              source: { kind: 'tool', callId: 'call-1' },
              content: [
                {
                  type: 'tool-result',
                  toolCallId: 'call-1',
                  content: [{ type: 'text', text: 'ok' }],
                },
              ],
            },
          },
        },
      },
      {
        event: {
          type: 'deliverables/presented',
          seq: 5,
          time: 1_005,
          data: {
            turn: 1,
            callId: 'call-1',
            files: [
              { path: 'artifacts/report.md', description: 'report' },
              { path: 'artifacts/data.json', description: 'data' },
            ],
          },
        },
      },
    ]
    const calls: { method: string; params: unknown }[] = []
    const transport: DshTransport = {
      request: <TResponse>(method: string, params: unknown) => {
        calls.push({ method, params })
        const beforeSequence = (params as { readonly beforeSeq?: number }).beforeSeq
        const eligible =
          beforeSequence === undefined
            ? rawEvents
            : rawEvents.filter((entry) => entry.event.seq < beforeSequence)
        return Promise.resolve({
          result: { ok: true, value: { events: eligible, hasMore: false } },
        } as TResponse)
      },
      remoteRequest: <TResponse>() => Promise.reject<TResponse>(new Error('unexpected Remote')),
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    }
    const repository = new Rc6SessionRepository(transport)

    const publicPage = await repository.history('session-1')
    expect(publicPage.events.some((entry) => entry.event.type === 'session.system')).toBe(false)
    expect(publicPage.coveredSequenceRanges).toEqual([{ from: 0, to: 5 }])
    expect(
      publicPage.events.some((entry) => entry.sequence === 3 && entry.event.type === 'message.delta'),
    ).toBe(true)
    expect(
      publicPage.events.some(
        (entry) => entry.sequence === 5 && entry.event.type === 'deliverables.presented',
      ),
    ).toBe(true)

    const recovered = await historyGapRecovery(repository)('session-1', 0, 5, new AbortController().signal)
    expect(recovered.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5])
    expect(recovered.map((event) => event.type)).toEqual([
      'session.system',
      'message.delta',
      'tool.updated',
      'message.delta',
      'tool.updated',
      'deliverables.presented',
    ])
    expect(recovered[0]).toEqual({ type: 'session.system', sessionId: 'session-1', sequence: 0 })
    expect(recovered[3]).toMatchObject({ type: 'message.delta', sequence: 3, delta: 'second' })
    expect(recovered[5]).toMatchObject({
      type: 'deliverables.presented',
      sequence: 5,
      files: [{ path: 'artifacts/report.md' }, { path: 'artifacts/data.json' }],
    })
    expect(calls.filter((call) => call.method === 'session.history').length).toBe(2)
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
          textOnly: true,
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
          textOnly: true,
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

describe('Rc6SessionRepository rename receipts', () => {
  function renameTransport(value: unknown): DshTransport {
    return {
      request: <TResponse>() => Promise.resolve({ result: { ok: true, value } } as TResponse),
      remoteRequest: <TResponse>() => Promise.resolve({ result: { ok: true, value: [] } } as TResponse),
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    }
  }

  it('surfaces the title the host accepted rather than the requested text', async () => {
    // The host is the authority on what it stored: it strips ANSI and control
    // characters, collapses whitespace and truncates to its own UTF-8 byte
    // budget, then returns the accepted title. A client that keeps showing the
    // text it typed displays a title the session log does not contain.
    await expect(
      new Rc6SessionRepository(renameTransport({ title: 'Hello World', seq: 42 })).rename(
        'session-1',
        '  Hello\n\nWorld  ',
      ),
    ).resolves.toBe('Hello World')
  })

  it('rejects a rename receipt without an acceptable title', async () => {
    await expect(
      new Rc6SessionRepository(renameTransport({ title: '   ', seq: 1 })).rename('session-1', 'x'),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
})
