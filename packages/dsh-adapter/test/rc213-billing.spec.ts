import { describe, expect, it } from 'vitest'
import { rc213BillingPage } from '../src/versions/rc213/billing.js'
import { Rc213SessionRepository } from '../src/versions/rc213/session-repository.js'
import { Rc6WorkspaceRepository } from '../src/repositories/workspace-repository.js'
import type { DshTransport } from '../src/contracts.js'

// Sanitized dsh-v0.2.1-rc.3 / 1f81c047fc48fa190a683e469daa699857e9afe8.
// core/session/src/types.ts SessionEventMap, llm/src/message.ts ModelMessageSource.
const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
const event = (seq: number, type: string, data: unknown): unknown => ({
  event: { seq, type, time: seq, data },
})
const chunk = (value: unknown): unknown => ({ type: 'chunk', chunk: { type: 'usage', usage: value } })

describe('rc213 prompt-free accounting contract', () => {
  it('retains original compact-stream time bounds for conditional pricing', () => {
    const page = rc213BillingPage(
      [
        {
          event: {
            seq: 0,
            type: 'assistant/attempt',
            time: 1200,
            data: {
              stream: [
                { type: 'text-chunks', time0: 1000, dt: [0, 100], texts: ['a', 'b'], index: 0 },
                { type: 'chunk', time: 1150, chunk: { type: 'usage', usage } },
              ],
            },
          },
        },
      ],
      false,
    )
    expect(page.facts[0]).toMatchObject({ startedAt: 1000, time: 1200, usage })
  })
  it('uses the verified history route without mutating transcript/projection caches; propagates failures and cancellation', async () => {
    let result: unknown = {
      ok: true,
      value: { events: [event(0, 'assistant/attempt', { stream: [chunk(usage)] })], hasMore: false },
    }
    let request: unknown
    const transport: DshTransport = {
      request: <T>(method: string, payload: unknown): Promise<T> => {
        request = { method, payload }
        return Promise.resolve({ result } as T)
      },
      remoteRequest: (): never => {
        throw new Error('unexpected remote')
      },
      async *openEventStream() {
        /* no background stream is required */
      },
      close: () => Promise.resolve(),
    }
    const repository = new Rc213SessionRepository(
      transport,
      new Rc6WorkspaceRepository(transport),
      undefined,
      {},
    )
    expect((await repository.readBillingPage('s', 5)).facts).toMatchObject([
      { sequence: 0, kind: 'attempt', usage },
    ])
    expect(request).toEqual({
      method: 'session.history',
      payload: { sessionId: 's', maxMessages: 500, beforeSeq: 5 },
    })
    result = { ok: true, value: { events: 'malformed', hasMore: false } }
    await expect(repository.readBillingPage('s')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    result = { ok: false, error: { code: 'cancelled' } }
    await expect(repository.readBillingPage('s')).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    const controller = new AbortController()
    controller.abort()
    await expect(repository.readBillingPage('s', undefined, controller.signal)).rejects.toThrow()
  })
  it('preserves header routes, actual message routes and each retry settlement', () => {
    const result = rc213BillingPage(
      [
        event(0, 'request/header', {
          header: { config: { provider: 'route-a', model: 'model-a' }, tools: [{ secret: 'not-public' }] },
        }),
        event(1, 'assistant/attempt', {
          turn: 0,
          step: 0,
          stream: [chunk({ ...usage, outputTokens: 1 }), chunk(usage)],
        }),
        event(2, 'assistant/message', {
          turn: 0,
          step: 0,
          message: {
            content: [{ text: 'private-body' }],
            source: { kind: 'model', provider: 'route-b', model: 'model-b', replayState: 'private-state' },
          },
          usage,
          stream: [chunk({ ...usage, outputTokens: 999 })],
        }),
      ],
      false,
    )
    expect(result).toMatchObject({
      fromSequence: 0,
      toSequence: 2,
      contiguous: true,
      facts: [
        { kind: 'route', route: { providerId: 'route-a', modelId: 'model-a' } },
        { kind: 'attempt', usage },
        { kind: 'message', route: { providerId: 'route-b', modelId: 'model-b' }, usage },
      ],
    })
    expect(JSON.stringify(result)).not.toMatch(/private|secret|content|tools/)
  })
  it('omits replacement copies and keeps malformed usage visible as unknown', () => {
    const replacement = {
      event: { seq: 0, type: 'assistant/message', surfaceOp: { op: 'replace', refs: [0] }, data: { usage } },
    }
    const result = rc213BillingPage(
      [
        replacement,
        event(1, 'assistant/attempt', { stream: [chunk({ ...usage, inputTokens: 1.5 })] }),
        event(2, 'assistant/attempt', {}),
        event(3, 'request/header', { header: { config: { provider: 'incomplete' } } }),
      ],
      false,
    )
    expect(result.facts).toEqual([
      { kind: 'attempt', sequence: 1, time: 1, invalidUsage: true },
      { kind: 'attempt', sequence: 2, time: 2 },
      { kind: 'route', sequence: 3 },
    ])
    expect(() => rc213BillingPage([event(-1, 'assistant/attempt', {})], false)).toThrow()
    expect(rc213BillingPage([event(1, 'turn/start', {}), event(3, 'turn/end', {})], false).contiguous).toBe(
      false,
    )
  })
})
