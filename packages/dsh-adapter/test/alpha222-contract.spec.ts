import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent, SessionHistoryPage } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import { Alpha222VersionAdapter } from '../src/versions/alpha222/adapter.js'
import { Alpha222SessionRepository } from '../src/versions/alpha222/session-repository.js'
import { Alpha222PluginBundleRepository } from '../src/versions/alpha222/plugin-manager-repository.js'
import { Alpha214PluginBundleRepository } from '../src/versions/alpha214/plugin-manager-repository.js'
import type { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'
import { Rc6WorkspaceRepository } from '../src/repositories/workspace-repository.js'
import { FakeWebSocket } from './support/fake-web-socket.js'
import { endpoint, transportOptions, wrappedResponse } from './support/contract-harness.js'
import {
  imageData,
  imageReference,
  toolImageResult,
  unsupportedPlatform,
} from './fixtures/alpha222-contract.js'
import { alpha222SessionProfile } from '../src/versions/alpha222/session-wire.js'
import { expandHistoryRecords } from '../src/versions/alpha/session-wire.js'
import { normalizeAlpha222GlobalEvent } from '../src/versions/alpha222/interaction-events.js'
import { normalizeEnvelope } from '../src/stream-envelopes.js'

describe('alpha222 changed contracts', () => {
  it.each([
    [
      'mismatched tool identity',
      {
        ...toolImageResult,
        data: {
          ...toolImageResult.data,
          message: {
            ...toolImageResult.data.message,
            source: { kind: 'tool', callId: 'another-call' },
          },
        },
      },
    ],
    [
      'invalid image reference',
      {
        ...toolImageResult,
        data: {
          ...toolImageResult.data,
          message: {
            ...toolImageResult.data.message,
            content: [{ type: 'image', attachment: { ...imageReference, width: 0 } }],
          },
        },
      },
    ],
  ] as const)('refuses byte reads from a history record with %s', async (_description, event) => {
    const requests: string[] = []
    const transport: DshTransport = {
      request: <T>(method: string) => {
        requests.push(method)
        const events = expandHistoryRecords(
          [{ type: 'event', event }],
          's',
          'v4',
          false,
          alpha222SessionProfile,
        ).map((event) => ({ event }))
        return Promise.resolve({ result: { ok: true, value: { events, hasMore: false } } } as T)
      },
      remoteRequest: () => Promise.reject(new Error('unexpected Remote')),
      async *openEventStream() {},
      close: () => Promise.resolve(),
    }
    await expect(
      new Alpha222SessionRepository(
        transport,
        new Rc6WorkspaceRepository(transport),
        undefined,
        {},
      ).readAttachment('s', imageReference.attachmentId),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(requests).toEqual(['session.history'])
  })
  it('reads a tool-result-only image from an older history page and refuses it in another session', async () => {
    const reads: unknown[] = []
    const transport: DshTransport = {
      request: <T>(method: string, payload: unknown) => {
        reads.push({ method, payload })
        const request = payload as { sessionId: string; beforeSeq?: number }
        const value =
          method === 'session.attachment'
            ? { attachment: imageReference, data: imageData }
            : request.sessionId !== 's'
              ? { events: [], hasMore: false }
              : request.beforeSeq === undefined
                ? {
                    events: [
                      {
                        event: {
                          type: 'user/message',
                          seq: 10,
                          time: 10,
                          data: {
                            message: {
                              id: 'recent-user',
                              role: 'user',
                              content: [{ type: 'text', text: 'newer message without images' }],
                            },
                          },
                        },
                      },
                    ],
                    hasMore: true,
                  }
                : {
                    events: expandHistoryRecords(
                      [{ type: 'event', event: toolImageResult }],
                      's',
                      'v4',
                      false,
                      alpha222SessionProfile,
                    ).map((event) => ({ event })),
                    hasMore: false,
                  }
        return Promise.resolve({ result: { ok: true, value } } as T)
      },
      remoteRequest: () => Promise.reject(new Error('unexpected Remote')),
      async *openEventStream() {},
      close: () => Promise.resolve(),
    }
    const repository = new Alpha222SessionRepository(
      transport,
      new Rc6WorkspaceRepository(transport),
      undefined,
      {},
    )
    const page = await repository.history('s', 10)
    expect(page.events).toMatchObject([
      { event: { type: 'tool.updated', tool: { images: [imageReference] } } },
    ])
    reads.length = 0
    await expect(repository.readAttachment('s', imageReference.attachmentId)).resolves.toMatchObject({
      uri: `data:image/png;base64,${imageData}`,
    })
    expect(reads).toEqual([
      { method: 'session.history', payload: { sessionId: 's', maxMessages: 500 } },
      { method: 'session.history', payload: { sessionId: 's', maxMessages: 500, beforeSeq: 10 } },
      { method: 'session.attachment', payload: { sessionId: 's', attachment: imageReference } },
    ])
    reads.length = 0
    await expect(repository.readAttachment('other', imageReference.attachmentId)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(reads).toEqual([{ method: 'session.history', payload: { sessionId: 'other', maxMessages: 500 } }])
  })
  it('projects blocking approvals as fixed actions and rejects incomplete authority', () => {
    const question = {
      id: 'access',
      question: 'Allow fixture access?',
      detail: 'Fixture scope',
      options: [{ label: 'Allow once' }, { label: 'Reject' }],
      intent: {
        kind: 'approval',
        approve: 'Allow once',
        reject: 'Reject',
        subject: { name: 'Fixture', icon: 'https://private.invalid/image' },
      },
    }
    const frame = {
      type: 'question/requested',
      rpcId: 'rpc-access',
      sessionId: 'fixture-session',
      questions: [question],
    }
    expect(normalizeAlpha222GlobalEvent(frame)).toMatchObject({
      type: 'question.requested',
      question: {
        rpcId: 'rpc-access',
        allowFreeText: false,
        multiSelect: false,
        items: [{ id: 'access', allowFreeText: false, choices: [{ id: 'Allow once' }, { id: 'Reject' }] }],
      },
    })
    expect(JSON.stringify(normalizeAlpha222GlobalEvent(frame))).not.toMatch(/private.invalid|subject/)
    expect(normalizeEnvelope(frame)?.type).toBe('unknown')
    for (const invalid of [
      { ...frame, wait: { callId: 'not-blocking' } },
      { ...frame, questions: [{ ...question, multiSelect: true }] },
      { ...frame, questions: [{ ...question, options: [{ label: 'Allow once' }] }] },
      { ...frame, rpcId: undefined },
    ])
      expect(() => normalizeAlpha222GlobalEvent(invalid)).toThrow()
  })
  it('requests activation for a live follow, including when transient previews are disabled, and releases it', async () => {
    const transport = new Alpha222VersionAdapter({
      ...transportOptions(globalThis.fetch),
      webSocket: FakeWebSocket,
    }).createTransport(endpoint) as AlphaLoopbackApiClient
    const abort = new AbortController()
    const stream = transport.openSessionStream('fixture-session', abort.signal, false)
    const next = stream[Symbol.asyncIterator]().next()
    const socket = FakeWebSocket.instances.at(-1)!
    socket.open()
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0))
    const opening = JSON.parse(socket.sent[0]!) as { streamId: string; payload: unknown }
    expect(opening.payload).toMatchObject({
      args: { request: { activate: true, address: { kind: 'session', sessionId: 'fixture-session' } } },
    })
    abort.abort()
    await next
    expect(socket.sent.map((s) => JSON.parse(s) as { type: string }).some((f) => f.type === 'cancel')).toBe(
      true,
    )
    await transport.close()
    expect(socket.closeCalls).toBe(1)
  })

  it('normalises live model invalidation without exposing provider payloads', () => {
    class Adapter extends Alpha222VersionAdapter {
      public map(event: BackendEvent): BackendEvent {
        return this.mapBackendEvent(event)
      }
    }
    const adapter = new Adapter(transportOptions(globalThis.fetch))
    expect(
      adapter.map({ type: 'remote.event', name: 'llm/models-updated', args: ['fixture-provider'] }),
    ).toEqual({ type: 'remote.event', name: 'llm/adapters-updated', args: [] })
    expect(() => adapter.map({ type: 'remote.event', name: 'llm/models-updated', args: [{}] })).toThrow()
  })

  it('carries unsupported-platform through strict protocol and keeps older wire strict', async () => {
    const transport = new Alpha222VersionAdapter(
      transportOptions((_input, init) => Promise.resolve(wrappedResponse(init, unsupportedPlatform))),
    ).createTransport(endpoint)
    try {
      const result = await new Alpha222PluginBundleRepository(transport).setBundleEnabled(
        'fixture-bundle',
        true,
      )
      expect(result.errorCode).toBe('unsupported-platform')
      expect(JSON.stringify(result)).not.toMatch(/private|diagnostic/)
      await expect(
        new Alpha214PluginBundleRepository(transport).setBundleEnabled('fixture-bundle', true),
      ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    } finally {
      await transport.close()
    }
  })

  it('looks up the complete image reference in the addressed history before reading bytes', async () => {
    const calls: unknown[] = []
    const transport: DshTransport = {
      request: <T>(method: string, payload: unknown) => {
        calls.push({ method, payload })
        return Promise.resolve({
          result: { ok: true, value: { attachment: imageReference, data: imageData } },
        } as T)
      },
      remoteRequest: () => Promise.reject(new Error('unexpected Remote')),
      async *openEventStream() {},
      close: () => Promise.resolve(),
    }
    let page: SessionHistoryPage = { events: [], hasMore: true, beforeSequence: 10 }
    class Repository extends Alpha222SessionRepository {
      public override history = vi.fn(() => Promise.resolve(page))
    }
    const repository = new Repository(transport, new Rc6WorkspaceRepository(transport), undefined, {})
    const olderPage = page
    repository.history.mockImplementationOnce(() => Promise.resolve(olderPage))
    page = {
      events: [
        {
          sequence: 1,
          time: '1970-01-01T00:00:00.001Z',
          event: {
            type: 'message.user',
            sessionId: 's',
            messageId: 'm',
            markdown: '',
            images: [imageReference],
          },
        },
      ],
      hasMore: false,
    }
    const result = await repository.readAttachment('s', imageReference.attachmentId)
    expect(result.uri).toBe(`data:image/png;base64,${imageData}`)
    expect(calls).toEqual([
      { method: 'session.attachment', payload: { sessionId: 's', attachment: imageReference } },
    ])
    calls.length = 0
    page = { events: [], hasMore: false }
    await expect(
      repository.readAttachment('other-session', imageReference.attachmentId),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(calls).toEqual([])
    const duringRead = new AbortController()
    repository.history.mockImplementationOnce(() => {
      duringRead.abort()
      return Promise.resolve(page)
    })
    await expect(
      repository.readAttachment('s', imageReference.attachmentId, duringRead.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toEqual([])
    const abort = new AbortController()
    abort.abort()
    await expect(repository.readAttachment('s', imageReference.attachmentId, abort.signal)).rejects.toThrow()
    expect(calls).toEqual([])
    page = { events: [], hasMore: true, beforeSequence: 10 }
    await expect(repository.readAttachment('s', imageReference.attachmentId)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    expect(calls).toEqual([])
  })
})
