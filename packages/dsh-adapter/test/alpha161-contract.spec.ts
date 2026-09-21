import { describe, expect, it, vi } from 'vitest'

import type { BackendCandidate, BackendEndpoint, BackendEvent } from '@dsh-vscode/domain'

import type { DshTransport } from '../src/contracts.js'
import { Rc6SessionRepository } from '../src/repositories/session-repository.js'
import { DshStreamController } from '../src/stream-controller.js'
import { rc6Mapper } from '../src/versions/rc6/mapper.js'
import { Alpha161VersionAdapter, type Alpha161AdapterOptions } from '../src/versions/alpha161/adapter.js'
import { validAlpha151SessionEvent } from '../src/versions/alpha151/session-wire.js'

const endpoint: BackendEndpoint = {
  host: '127.0.0.1',
  port: 4567,
  baseUrl: 'http://127.0.0.1:4567',
}

function candidate(runtimeVersion: string): BackendCandidate {
  return { endpoint, source: 'configured', runtimeVersion, confidence: 1 }
}

function response(init: RequestInit | undefined, value: unknown): Response {
  if (typeof init?.body !== 'string') throw new Error('test request body is not a string')
  const request = JSON.parse(init.body) as { readonly rpcId?: string }
  return new Response(
    JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }),
    { headers: { 'content-type': 'application/json' } },
  )
}

function options(fetch: typeof globalThis.fetch): Alpha161AdapterOptions {
  return {
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch,
  }
}

describe('DSH 0.1.6-alpha.1 contract seams', () => {
  it('selects the exact v3 adapter and keeps it out of compatibility fallback', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { items: [] })),
    )
    const adapter = new Alpha161VersionAdapter(options(fetch))

    await expect(adapter.probe(candidate('0.1.6-alpha.1'))).resolves.toMatchObject({
      protocolVersion: 'alpha161',
      dshVersion: '0.1.6-alpha.1',
    })
    await expect(adapter.probe(candidate('0.1.5-rc.2'))).resolves.toBeUndefined()
    await expect(adapter.probeCompatibility(candidate('0.1.6-alpha.1'))).resolves.toBeUndefined()
  })

  it('preserves the new image offload projection event as an opaque v3 event', () => {
    const wireEvent = {
      type: 'image/offload',
      seq: 3,
      time: 300,
      data: { targets: [{ seq: 2, imageIndexes: [0] }] },
    }

    expect(validAlpha151SessionEvent(wireEvent)).toBe(true)
    const mapped = rc6Mapper.event('image/offload', {
      sessionId: 'session-1',
      data: wireEvent.data,
    })
    expect(mapped).toMatchObject({
      type: 'unknown',
      sessionId: 'session-1',
      name: 'image/offload',
      payload: {
        sessionId: 'session-1',
        data: { targets: [{ seq: '[truncated]', imageIndexes: '[truncated]' }] },
      },
    })
  })

  it('does not let image offload acquire surface replacement semantics', () => {
    expect(
      validAlpha151SessionEvent({
        type: 'image/offload',
        seq: 3,
        time: 300,
        data: { targets: [{ seq: 2, imageIndexes: [0] }] },
        surfaceOp: 'append',
      }),
    ).toBe(false)
  })

  it('keeps image offload inside the known vocabulary instead of hiding behind ignorable', () => {
    // `image/offload` is a generated member of the upstream vocabulary, so the
    // `ignorable` escape hatch that admits unknown external events must not
    // apply: upstream refuses any known type that carries surface metadata.
    const offload = { type: 'image/offload', seq: 3, time: 300, data: { targets: [] } }
    expect(validAlpha151SessionEvent({ ...offload, ignorable: true })).toBe(true)
    expect(validAlpha151SessionEvent({ ...offload, ignorable: true, surfaceOp: 'append' })).toBe(false)
    expect(validAlpha151SessionEvent({ ...offload, ignorable: true, sourceEventSeqs: [2] })).toBe(false)
    expect(
      validAlpha151SessionEvent({
        type: 'image/offload',
        seq: 3,
        time: 300,
        data: { targets: [] },
        surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
      }),
    ).toBe(false)
  })

  it('admits unknown external events as opaque rows while refusing surface metadata on known ones', () => {
    // The Session Controller wire validator (which this file mirrors) tolerates
    // an unknown type; the persistence read path's stricter "ignorable or
    // reject" rule does not apply here because unknown rows are preserved as
    // redacted opaque events instead of being skipped.
    const external = { type: 'plugin/third-party-row', seq: 3, time: 300, data: {} }
    expect(validAlpha151SessionEvent({ ...external, ignorable: true })).toBe(true)
    expect(validAlpha151SessionEvent({ ...external, ignorable: true, surfaceOp: 'append' })).toBe(true)
    expect(validAlpha151SessionEvent(external)).toBe(true)
  })

  it('maps the version-2 Team events this tag emits', () => {
    // The tag's own projector validates every Team payload as `z.literal(2)`
    // with strict snapshot objects, and upstream dropped the v1 `delivery`
    // field when peer messages unified onto steer, so the mode is simply
    // absent here. Refusing version 2 would turn each Team row into an
    // unreadable event on the one host line this adapter exists for.
    const member = rc6Mapper.event('team/member', {
      sessionId: 'session-1',
      data: {
        version: 2,
        teamId: 'team-1',
        member: {
          id: 'member-1',
          name: 'Planner',
          description: 'private detail is not projected',
          provider: 'spawn',
          context: 'fresh',
          phase: 'active',
        },
      },
    })
    expect(member).toMatchObject({
      type: 'team.updated',
      sessionId: 'session-1',
      activity: { kind: 'member', teamId: 'team-1', memberId: 'member-1', name: 'Planner', phase: 'active' },
    })

    expect(
      rc6Mapper.event('team/task', {
        sessionId: 'session-1',
        data: {
          version: 2,
          teamId: 'team-1',
          task: {
            id: 'task-1',
            revision: 2,
            subject: 'Review',
            description: 'private detail is not projected',
            status: 'in_progress',
            ownerId: 'member-1',
            blockedBy: ['task-0'],
            writeScopes: ['src/'],
          },
        },
      }),
    ).toMatchObject({
      type: 'team.updated',
      activity: {
        kind: 'task',
        taskId: 'task-1',
        status: 'in_progress',
        blockedByCount: 1,
        writeScopeCount: 1,
      },
    })

    const queued = rc6Mapper.event('team/message/queued', {
      sessionId: 'session-1',
      data: {
        version: 2,
        teamId: 'team-1',
        message: {
          id: 'message-1',
          senderId: 'session-2',
          senderName: 'Planner',
          targetId: 'member-1',
          content: [{ type: 'text', text: 'check this' }],
        },
      },
    })
    expect(queued).toMatchObject({
      type: 'team.updated',
      activity: {
        kind: 'message.queued',
        senderName: 'Planner',
        targetId: 'member-1',
        content: 'check this',
      },
    })
    expect(queued.type === 'team.updated' && Object.hasOwn(queued.activity, 'delivery')).toBe(false)

    expect(
      rc6Mapper.event('team/message/delivered', {
        sessionId: 'session-1',
        data: { version: 2, teamId: 'team-1', messageId: 'message-1', targetId: 'member-1' },
      }),
    ).toMatchObject({ type: 'team.updated', activity: { kind: 'message.delivered', messageId: 'message-1' } })
  })

  it('keeps host-legal long peer message bodies and member failure reasons whole', () => {
    // The mailbox measures only the framed delivery against `maxMessageBytes`
    // (default 65,536 on this tag, and the config may raise it) and the roster
    // stores `errorMessage(error)` verbatim, so both fields are host-legal far
    // past 4,096 characters. The wire budget is orders of magnitude above
    // either, and the timeline renders exactly what this seam keeps: clipping
    // here is the only place the text can disappear.
    const body = `Migration report:\n${'the peer asked for this row, verbatim. '.repeat(200)}`
    const reason = `provisioning failed: ${'the provider rejected the route; '.repeat(200)}`
    expect(body.length).toBeGreaterThan(4_096)
    expect(reason.length).toBeGreaterThan(4_096)

    const queued = rc6Mapper.event('team/message/queued', {
      sessionId: 'session-1',
      data: {
        version: 2,
        teamId: 'team-1',
        message: {
          id: 'message-1',
          senderId: 'session-2',
          senderName: 'planner',
          targetId: 'member-1',
          content: [{ type: 'text', text: body }],
        },
      },
    })
    expect(
      queued.type === 'team.updated' && queued.activity.kind === 'message.queued'
        ? queued.activity.content
        : undefined,
    ).toBe(body)

    const failed = rc6Mapper.event('team/member', {
      sessionId: 'session-1',
      data: {
        version: 2,
        teamId: 'team-1',
        member: {
          id: 'member-1',
          name: 'planner',
          description: 'owns the migration',
          provider: 'spawn',
          context: 'fresh',
          phase: 'failed',
          error: reason,
        },
      },
    })
    expect(
      failed.type === 'team.updated' && failed.activity.kind === 'member' ? failed.activity.error : undefined,
    ).toBe(reason)
  })

  it('maps the control queue item shape DSH 0.1.6 publishes', () => {
    // The host builds pending items in queueItemsFromInbox: the item carries
    // placement/rpcId and its message keeps only the id and content blocks.
    // There is no `role` or `source` to read.
    const mapped = rc6Mapper.event('session/queue', {
      sessionId: 'session-1',
      items: [
        {
          id: 'queued-1',
          placement: 'queued',
          rpcId: 'rpc-queued-1',
          message: { id: 'message-1', content: [{ type: 'text', text: 'queue this prompt' }] },
        },
        {
          id: 'queued-2',
          placement: 'steering',
          message: { id: 'message-2', content: [{ type: 'text', text: 'steer this prompt' }] },
        },
        {
          id: 'queued-3',
          placement: 'context',
          message: { id: 'message-3', content: [{ type: 'text', text: 'inbox context' }] },
        },
      ],
    })

    expect(mapped).toMatchObject({
      type: 'queue.updated',
      sessionId: 'session-1',
      items: [
        { id: 'queued-1', mode: 'queue', text: 'queue this prompt', rpcId: 'rpc-queued-1', textOnly: true },
        { id: 'queued-2', mode: 'steer', text: 'steer this prompt', textOnly: true },
      ],
    })
  })

  it('reports a queued prompt that carries an image or a file as non-text', () => {
    // A queue edit replaces the whole content with one text block, so the
    // panel has to know which rows would lose something. The host admits
    // `file` parts on this same wire; the client cannot read those bytes back,
    // so the name is the whole projection.
    expect(
      rc6Mapper.event('session/queue', {
        sessionId: 'session-1',
        items: [
          {
            id: 'queued-image',
            placement: 'queued',
            message: {
              id: 'message-image',
              content: [
                { type: 'text', text: 'describe this' },
                {
                  type: 'image',
                  attachment: {
                    attachmentId: 'image-1',
                    mediaType: 'image/png',
                    bytes: 4,
                    width: 2,
                    height: 2,
                  },
                },
              ],
            },
          },
          {
            id: 'queued-file',
            placement: 'queued',
            message: {
              id: 'message-file',
              content: [
                { type: 'text', text: 'summarize this' },
                { type: 'file', attachment: { attachmentId: 'file-1', name: 'spec.md', bytes: 2048 } },
              ],
            },
          },
        ],
      }),
    ).toMatchObject({
      type: 'queue.updated',
      items: [
        {
          id: 'queued-image',
          text: 'describe this',
          textOnly: false,
          images: [{ attachmentId: 'image-1' }],
        },
        { id: 'queued-file', text: 'summarize this', textOnly: false, files: ['spec.md'] },
      ],
    })
  })

  it('rejects a queue item whose present role or source is invalid', () => {
    const item = (message: Record<string, unknown>): Record<string, unknown> => ({
      sessionId: 'session-1',
      items: [{ id: 'queued-1', placement: 'queued', message }],
    })

    expect(() =>
      rc6Mapper.event(
        'session/queue',
        item({ id: 'message-1', role: 'tool', content: [{ type: 'text', text: 'x' }] }),
      ),
    ).toThrow()
    expect(() =>
      rc6Mapper.event(
        'session/queue',
        item({ id: 'message-1', source: {}, content: [{ type: 'text', text: 'x' }] }),
      ),
    ).toThrow()
  })

  it('keeps the control queue frame on the queue path instead of degrading it to unknown', async () => {
    const frame = {
      type: 'session/queue',
      sessionId: 'session-1',
      items: [
        {
          id: 'queued-1',
          placement: 'queued',
          rpcId: 'rpc-queued-1',
          message: { id: 'message-1', content: [{ type: 'text', text: 'queue this prompt' }] },
        },
      ],
    }
    const transport = controlTransport(frame)
    const controller = new DshStreamController(transport)
    const sessions = new Rc6SessionRepository(transport)
    const received: BackendEvent[] = []
    controller.subscribe((event) => {
      received.push(event)
      sessions.remember(event)
    })
    try {
      await waitFor(() => received.length > 0)
      expect(received).toMatchObject([{ type: 'queue.updated', sessionId: 'session-1' }])
      await expect(sessions.listQueue('session-1')).resolves.toMatchObject([
        { id: 'queued-1', mode: 'queue', text: 'queue this prompt', rpcId: 'rpc-queued-1' },
      ])
    } finally {
      await controller.close()
    }
  })

  it('maps the alpha.1 tool failure reason without exposing the structured identity', () => {
    const mapped = rc6Mapper.event('tool/result', {
      sessionId: 'session-1',
      data: {
        callId: 'call-1',
        error: {
          name: 'ToolOutputError',
          code: 'INVALID_TOOL_OUTPUT',
          reason: '工具输出无法保存',
        },
        message: {
          content: [{ type: 'tool-result', toolCallId: 'call-1', isError: true, content: [] }],
        },
      },
    })

    expect(mapped).toMatchObject({
      type: 'tool.updated',
      tool: { id: 'call-1', status: 'failed', error: '工具输出无法保存' },
    })
    expect(JSON.stringify(mapped)).not.toContain('ToolOutputError')
  })
})

/** Host stream that replays the given control frames and then stays open. */
function controlTransport(...frames: readonly unknown[]): DshTransport {
  // The session stream stays open without ever publishing a frame, so it is an
  // explicit iterator rather than a generator that would need a dead `yield`.
  const forever = (signal: AbortSignal): AsyncIterable<unknown> => ({
    [Symbol.asyncIterator]: (): AsyncIterator<unknown> => ({
      next: async (): Promise<IteratorResult<unknown>> => {
        await parkUntilAborted(signal)
        return { done: true, value: undefined }
      },
    }),
  })
  return {
    request: <T>() => Promise.reject<T>(new Error('request is not used by this test')),
    remoteRequest: <T>() => Promise.reject<T>(new Error('remoteRequest is not used by this test')),
    openEventStream: forever,
    openHostStream: async function* (signal: AbortSignal): AsyncIterable<unknown> {
      yield* frames
      await parkUntilAborted(signal)
    },
    close: () => Promise.resolve(),
  }
}

function parkUntilAborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
  expect(predicate()).toBe(true)
}

it('retains offloaded image references for client display instead of parsing model placeholders', () => {
  const attachment = { attachmentId: 'image-1', mediaType: 'image/png', bytes: 68, width: 1, height: 1 }
  const event = rc6Mapper.event('user/message', {
    sessionId: 's1',
    data: { message: { id: 'm1', role: 'user', content: [{ type: 'image', attachment, offloaded: true }] } },
  })
  expect(event).toMatchObject({ type: 'message.user', images: [attachment] })
})
