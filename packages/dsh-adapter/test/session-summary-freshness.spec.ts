import { describe, expect, it, vi } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc6SessionRepository } from '../src/repositories/session-repository.js'
import type { Rc6SessionRepositoryOptions } from '../src/repositories/session/options.js'

// Host API: 47f9438 packages/host/apiproxy/src/api/{sessions,events}.ts.
// Alpha212: d743267 packages/api/session-controller/src/list.ts and
// packages/preset/agent-preset-registry/src/session.ts. Activity is the last
// human prompt; blank clears at turn/start; runtime status is a live event.
const CREATED = 1_700_000_000_000
const PROMPT = CREATED + 60_000
const FINISHED = PROMPT + 30_000
const SESSION = 'session-1'

function history(values: Readonly<Record<string, unknown>> = {}, sequence = 3): unknown {
  return {
    events: [
      { event: { type: 'turn/start', seq: 1, time: CREATED, data: { turn: 1 } } },
      {
        event: {
          type: 'user/message',
          seq: 2,
          time: PROMPT,
          data: {
            id: 'message-1',
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'A test task' }],
          },
        },
      },
      {
        event: { type: 'turn/end', seq: 3, time: FINISHED, data: { turn: 1, reason: { kind: 'completed' } } },
      },
    ],
    hasMore: false,
    projections: { asOfSeq: sequence, values },
  }
}

interface Fixture {
  readonly repository: Rc6SessionRepository
  readonly listed: {
    sessionId: string
    updatedAt: number
    running: boolean
    blank: boolean
    agentPreset: string
    title: string
  }
  readonly replies: { list: () => Promise<unknown>; history: () => Promise<unknown> }
  readonly calls: string[]
}

function fixture(options: Rc6SessionRepositoryOptions = {}): Fixture {
  const listed = {
    sessionId: SESSION,
    updatedAt: CREATED,
    running: false,
    blank: true,
    agentPreset: 'standard',
    title: 'Old title',
  }
  const calls: string[] = []
  const replies = {
    list: () => Promise.resolve<unknown>({ items: [{ ...listed }] }),
    history: () =>
      Promise.resolve(
        history({
          title: 'Current title',
          agentPreset: 'fast',
          sessionListMetadata: { blank: false, lastPromptAt: PROMPT },
        }),
      ),
  }
  const transport: DshTransport = {
    request: async <T>(method: string) => {
      calls.push(method)
      const value =
        method === 'session.list'
          ? await replies.list()
          : method === 'session.history'
            ? await replies.history()
            : (() => {
                throw new Error(`Unexpected RPC ${method}`)
              })()
      return { result: { ok: true, value } } as T
    },
    remoteRequest: <T>() => Promise.reject<T>(new Error('Unexpected Remote')),
    openEventStream: async function* () {},
    close: async () => {},
  }
  return {
    repository: new Rc6SessionRepository(transport, undefined, undefined, options),
    listed,
    replies,
    calls,
  }
}

function deferred(): { readonly promise: Promise<unknown>; readonly resolve: (value: unknown) => void } {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Session summary freshness', () => {
  it.each([false, true])('reads durable summary fields with cached list=%s', async (cached) => {
    const { repository, calls } = fixture()
    if (cached) await repository.list()
    const detail = await repository.get(SESSION)
    expect(detail).toMatchObject({
      title: 'Current title',
      blank: false,
      updatedAt: new Date(PROMPT).toISOString(),
      agentPreset: 'fast',
      configuration: { preset: 'fast' },
    })
    expect(calls).toEqual(cached ? ['session.list', 'session.history'] : ['session.history'])
  })

  it('keeps a live idle event received during history loading', async () => {
    const { repository, replies, listed } = fixture()
    listed.running = true
    await repository.list()
    const pending = deferred()
    replies.history = () => pending.promise
    const detail = repository.get(SESSION)
    repository.remember({ type: 'session.status', sessionId: SESSION, status: 'idle' })
    pending.resolve(history())
    expect((await detail).status).toBe('idle')
    expect((await repository.get(SESSION)).status).toBe('idle')
  })

  it('does not turn runtime activity alone into a durable nonblank session', async () => {
    const { repository, replies } = fixture()
    await repository.list()
    replies.history = () => Promise.resolve({ events: [], hasMore: false })
    repository.remember({ type: 'session.status', sessionId: SESSION, status: 'running' })
    expect(await repository.get(SESSION)).toMatchObject({ status: 'running', blank: true })
  })

  it('uses the projected human activity time when an uncached history tail starts with a later tool event', async () => {
    const { repository, replies } = fixture()
    replies.history = () =>
      Promise.resolve({
        events: [
          {
            event: {
              type: 'turn/end',
              seq: 3,
              time: FINISHED,
              data: { turn: 1, reason: { kind: 'completed' } },
            },
          },
        ],
        hasMore: true,
        projections: { asOfSeq: 3, values: { sessionListMetadata: { blank: false, lastPromptAt: PROMPT } } },
      })
    expect(await repository.get(SESSION)).toMatchObject({
      blank: false,
      updatedAt: new Date(PROMPT).toISOString(),
    })
  })

  it('rejects preset changes on a started session before invoking mutation callbacks', async () => {
    const select = vi.fn(async () => {})
    const { repository } = fixture({ selectAgentPreset: select })
    await repository.list()
    await expect(
      repository.setConfiguration(SESSION, {
        preset: 'review',
        toolMode: 'native',
        permissionPreset: 'workspace-write',
        planMode: false,
        model: { providerId: '', modelId: '' },
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    expect(select).not.toHaveBeenCalled()
  })

  it('does not apply malformed advisory metadata or let it throw a date error', async () => {
    const { repository, replies } = fixture()
    await repository.list()
    replies.history = () =>
      Promise.resolve({
        events: [],
        hasMore: false,
        projections: {
          asOfSeq: 3,
          values: { sessionListMetadata: { blank: false, lastPromptAt: Number.MAX_VALUE } },
        },
      })
    expect(await repository.get(SESSION)).toMatchObject({
      blank: true,
      updatedAt: new Date(CREATED).toISOString(),
    })
  })

  it('does not classify a partial history tail without human messages as blank', async () => {
    const { repository, replies } = fixture()
    replies.history = () => Promise.resolve({ events: [], hasMore: true })
    expect((await repository.get(SESSION)).blank).toBe(false)
  })
})
