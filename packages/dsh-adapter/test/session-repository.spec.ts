import { describe, expect, it, vi } from 'vitest'

import type { DshTransport } from '../src/contracts.js'
import { Rc6SessionRepository } from '../src/repositories/session-repository.js'

describe('Rc6SessionRepository session removal', () => {
  it('rejects permanent deletion without issuing an archive RPC', async () => {
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

    await expect(new Rc6SessionRepository(transport).remove('session-1')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })

    expect(request).not.toHaveBeenCalled()
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
                    permissions: { currentValue: 'workspace-write', options: permissionOptions },
                    plan: { active: false, pending: false },
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
    expect(page.searchHasMore).toBe(true)
  })
})

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
