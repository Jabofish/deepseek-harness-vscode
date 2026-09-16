import { describe, expect, it, vi } from 'vitest'

import type { BackendEndpoint, BackendEvent } from '@dsh-vscode/domain'

import { Rc6JobRepository } from '../src/repositories/job-repository.js'
import { rc6Mapper } from '../src/versions/rc6/mapper.js'
import { AlphaLoopbackApiClient, type AlphaWebSocket } from '../src/versions/alpha/transport.js'

/**
 * Wire shapes below are copied from the installed 0.1.6-alpha.1 host
 * (`@deepseek-ai/dsh-api-session-controller`): the `session/control` stream
 * answers one baseline with `queues`/`jobs`/`projections` for every session
 * `ctx.sessions.list()` returns, then pushes a whole replacement `jobs` array
 * per session on every registry change (an empty array once the last job
 * settles). `@deepseek-ai/dsh-jobs` guarantees the field invariants the mapper
 * relies on: `<kind>-N` ids, non-empty labels, a non-negative integer
 * `startedAt`, `finishedAt` present exactly for terminal statuses and never
 * earlier than `startedAt`.
 */

class FakeWebSocket implements AlphaWebSocket {
  public static readonly instances: FakeWebSocket[] = []
  public readyState = 0
  public readonly sent: string[] = []
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  public constructor(
    public readonly url: string,
    public readonly options?: unknown,
  ) {
    FakeWebSocket.instances.push(this)
  }

  public send(data: string): void {
    this.sent.push(data)
  }

  public close(): void {
    this.readyState = 3
    this.emit('close', {})
  }

  public addEventListener(type: string, listener: (event: unknown) => void): void {
    const entries = this.listeners.get(type) ?? new Set<(event: unknown) => void>()
    entries.add(listener)
    this.listeners.set(type, entries)
  }

  public removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  public open(): void {
    this.readyState = 1
    this.emit('open', {})
  }

  public message(value: unknown): void {
    this.emit('message', { data: JSON.stringify(value) })
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const endpoint: BackendEndpoint = {
  host: '127.0.0.1',
  port: 4567,
  baseUrl: 'http://127.0.0.1:4567',
}

function client(fetch: typeof globalThis.fetch): AlphaLoopbackApiClient {
  return new AlphaLoopbackApiClient({
    endpoint,
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch,
    authCookie: () => 'dsh_session=test-cookie',
    webSocket: FakeWebSocket,
  })
}

function streamItem(socket: FakeWebSocket, value: unknown): unknown {
  const opening = JSON.parse(socket.sent[0] ?? '{}') as { readonly streamId?: unknown }
  return { type: 'item', streamId: opening.streamId, value }
}

async function waitForSocket(): Promise<FakeWebSocket> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const socket = FakeWebSocket.instances[0]
    if (socket !== undefined) return socket
    await Promise.resolve()
  }
  throw new Error('the alpha mux socket was not created')
}

async function waitForSent(socket: FakeWebSocket, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (socket.sent.length >= count) return
    await Promise.resolve()
  }
  throw new Error(`the alpha mux socket sent ${socket.sent.length} frames; expected ${count}`)
}

/** Project one normalized control frame the way the stream controller does. */
function project(repository: Rc6JobRepository, frame: unknown): void {
  const normalized = frame as { readonly type: string }
  const event: BackendEvent = rc6Mapper.event(normalized.type, normalized)
  expect(event.type).toBe('jobs.updated')
  repository.remember(event)
}

describe('jobs over the alpha control stream', () => {
  it('tracks a multi-session live set through baseline, settlement and empty replacement frames', async () => {
    FakeWebSocket.instances.length = 0
    const transport = client(vi.fn(() => Promise.resolve(new Response('{}'))))
    const repository = new Rc6JobRepository(transport, { resetOnSubscribe: false })
    const stream = transport.openHostStream(new AbortController().signal)
    const iterator = stream[Symbol.asyncIterator]()
    const first = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)

    // The host sends one baseline covering every session it lists: live jobs
    // where the registry has them, and an explicit empty array where it does
    // not (a session without a live agent has no jobs, which is real state).
    socket.message(
      streamItem(socket, {
        type: 'baseline',
        value: {
          queues: {},
          jobs: {
            's-1': [
              {
                id: 'bash-7',
                kind: 'bash',
                label: 'pnpm test --filter dsh-adapter',
                status: 'running',
                startedAt: 1_700_000_000_000,
              },
              {
                id: 'subagent-3',
                kind: 'subagent',
                label: 'Review the adapter diff',
                status: 'running',
                startedAt: 1_700_000_000_500,
              },
            ],
            's-2': [{ id: 'bash-1', kind: 'bash', label: 'pnpm build', status: 'running', startedAt: 1 }],
            's-3': [],
          },
          projections: {},
        },
      }),
    )
    const frames = [(await first).value, (await iterator.next()).value, (await iterator.next()).value]
    expect(frames).toMatchObject([
      { type: 'session/jobs', sessionId: 's-1' },
      { type: 'session/jobs', sessionId: 's-2' },
      { type: 'session/jobs', sessionId: 's-3', jobs: [] },
    ])
    for (const frame of frames) project(repository, frame)

    await expect(repository.list('s-1')).resolves.toEqual([
      {
        id: 'bash-7',
        kind: 'bash',
        label: 'pnpm test --filter dsh-adapter',
        status: 'running',
        startedAt: 1_700_000_000_000,
      },
      {
        id: 'subagent-3',
        kind: 'subagent',
        label: 'Review the adapter diff',
        status: 'running',
        startedAt: 1_700_000_000_500,
      },
    ])
    await expect(repository.list('s-2')).resolves.toEqual([
      { id: 'bash-1', kind: 'bash', label: 'pnpm build', status: 'running', startedAt: 1 },
    ])
    await expect(repository.list('s-3')).resolves.toEqual([])

    // The registry settles bash-7 and pushes the whole replacement list for
    // that one session: finishedAt arrives with the terminal status, and the
    // sibling row keeps its live shape.
    const settled = iterator.next()
    socket.message(
      streamItem(socket, {
        type: 'jobs',
        sessionId: 's-1',
        jobs: [
          {
            id: 'bash-7',
            kind: 'bash',
            label: 'pnpm test --filter dsh-adapter',
            status: 'completed',
            detail: 'exit code: 0',
            startedAt: 1_700_000_000_000,
            finishedAt: 1_700_000_042_000,
          },
          {
            id: 'subagent-3',
            kind: 'subagent',
            label: 'Review the adapter diff',
            status: 'stopping',
            startedAt: 1_700_000_000_500,
          },
        ],
      }),
    )
    project(repository, (await settled).value)
    await expect(repository.list('s-1')).resolves.toEqual([
      {
        id: 'bash-7',
        kind: 'bash',
        label: 'pnpm test --filter dsh-adapter',
        status: 'completed',
        detail: 'exit code: 0',
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_042_000,
      },
      {
        id: 'subagent-3',
        kind: 'subagent',
        label: 'Review the adapter diff',
        status: 'stopping',
        startedAt: 1_700_000_000_500,
      },
    ])
    // A frame for one session never touches another session's snapshot.
    await expect(repository.list('s-2')).resolves.toEqual([
      { id: 'bash-1', kind: 'bash', label: 'pnpm build', status: 'running', startedAt: 1 },
    ])

    // The last row settles: the host's replacement list is empty, which is the
    // authoritative "this session no longer has jobs" answer.
    const cleared = iterator.next()
    socket.message(streamItem(socket, { type: 'jobs', sessionId: 's-1', jobs: [] }))
    project(repository, (await cleared).value)
    await expect(repository.list('s-1')).resolves.toEqual([])

    await transport.close()
  })

  it('fails closed on a forged job row instead of publishing a partial snapshot', async () => {
    const repository = new Rc6JobRepository(client(vi.fn(() => Promise.resolve(new Response('{}')))), {
      resetOnSubscribe: false,
    })
    repository.remember(
      rc6Mapper.event('session/jobs', {
        sessionId: 's-1',
        jobs: [{ id: 'bash-7', kind: 'bash', label: 'pnpm test', status: 'running', startedAt: 1 }],
      }),
    )
    // The host never emits a status outside the closed union; a forged one must
    // not silently drop the row and leave a truncated list behind.
    expect(() =>
      rc6Mapper.event('session/jobs', {
        sessionId: 's-1',
        jobs: [
          { id: 'bash-7', kind: 'bash', label: 'pnpm test', status: 'running', startedAt: 1 },
          { id: 'bash-8', kind: 'bash', label: 'pnpm build', status: 'cancelled', startedAt: 2 },
        ],
      }),
    ).toThrow(/malformed job/i)
    await expect(repository.list('s-1')).resolves.toEqual([
      { id: 'bash-7', kind: 'bash', label: 'pnpm test', status: 'running', startedAt: 1 },
    ])
  })
})
