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
