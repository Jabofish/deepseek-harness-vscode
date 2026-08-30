import { describe, expect, it, vi } from 'vitest'

import type { BackendEndpoint, BackendEvent } from '@dsh-vscode/domain'

import { Rc6VersionAdapter } from '../src/versions/rc6/adapter.js'

const endpoint: BackendEndpoint = {
  host: '127.0.0.1',
  port: 4567,
  baseUrl: 'http://127.0.0.1:4567',
}

class FakeWebSocket {
  public static instances: FakeWebSocket[] = []
  public readyState = 0
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  public constructor(_url: string, _options?: unknown) {
    FakeWebSocket.instances.push(this)
  }
  public send(_data: string): void {
    /* the event mux is a read-only downlink */
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

function muxFrame(payload: unknown): unknown {
  return { type: 'server-request', rpcId: 'mux-push', method: 'mux', payload }
}

function sessionEvent(seq: number): unknown {
  return {
    type: 'session/event',
    sessionId: 's1',
    event: { type: 'turn/start', seq, time: seq, data: { turn: 1 } },
  }
}

function historyRow(seq: number): {
  event: { type: string; seq: number; time: number; data: { turn: number } }
} {
  return { event: { type: 'turn/start', seq, time: seq, data: { turn: 1 } } }
}

function requestRpcId(init?: RequestInit): string {
  return (JSON.parse(String(init?.body)) as { rpcId: string }).rpcId
}

function ok(init: RequestInit | undefined, value: unknown): Response {
  return okBody(requestRpcId(init), value)
}

function okBody(rpcId: string, value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }), {
    headers: { 'content-type': 'application/json' },
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !predicate()) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}

describe('session gap recovery through paginated history', () => {
  it('walks history pages until a reconnect gap wider than one page is filled', async () => {
    // The pinned hosts page session.history at 50 events. Events 11..20 live
    // only on the second page: a recovery that reads just the newest page
    // cannot fill a reconnect gap spanning more than one page.
    const allEvents = Array.from({ length: 71 }, (_item, index) => historyRow(index))
    const historyAnchors: (number | undefined)[] = []
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)).pathname
      if (url === '/api/session.list')
        return Promise.resolve(
          ok(init, {
            items: [
              { sessionId: 's1', updatedAt: 1_000, running: false, blank: false, cwd: 'C:\\workspace' },
            ],
          }),
        )
      if (url === '/api/workspace.list')
        return Promise.resolve(ok(init, { items: [], archivedSessionIds: [] }))
      if (url === '/api/session.history') {
        const body = JSON.parse(String(init?.body)) as { rpcId: string; payload: { beforeSeq?: number } }
        const beforeSeq = body.payload?.beforeSeq
        historyAnchors.push(beforeSeq)
        const eligible =
          beforeSeq === undefined ? allEvents : allEvents.filter((row) => row.event.seq < beforeSeq)
        const events = eligible.slice(-50)
        const oldest = events[0]?.event.seq
        return Promise.resolve(okBody(body.rpcId, { events, hasMore: oldest !== undefined && oldest > 0 }))
      }
      return Promise.reject(new Error(`unexpected ${url}`))
    })
    FakeWebSocket.instances = []
    const adapter = new Rc6VersionAdapter({
      requestTimeoutMs: 1_000,
      retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch: fetch as unknown as typeof globalThis.fetch,
      webSocket: FakeWebSocket as unknown as typeof WebSocket,
    })
    const backend = await adapter.createBackend({
      endpoint,
      ownership: 'external',
      capabilities: { protocolVersion: 'rc6', dshVersion: '0.1.0-rc.6', features: new Set(['events']) },
    })
    const received: BackendEvent[] = []
    const unsubscribe = backend.events.subscribe((event) => received.push(event))
    try {
      await waitFor(() => FakeWebSocket.instances.length > 0)
      const socket = FakeWebSocket.instances[0]
      if (socket === undefined) throw new Error('the events mux socket was not created')
      socket.open()
      socket.message(muxFrame(sessionEvent(10)))
      await waitFor(() => received.some((event) => event.sequence === 10))
      console.log(
        'FETCH CALLS:',
        fetch.mock.calls.map((c) => String(c[0]).replace('http://127.0.0.1:4567', '')),
      )
      console.log(
        'RECEIVED:',
        received.map((e) => `${e.type}:${e.sequence ?? ''}`),
      )

      // The host jumps from watermark 10 straight to 70: the recovery must
      // fill [11..69] from history, including events that live on the second
      // page (11..20), before the live event is delivered.
      socket.message(muxFrame(sessionEvent(70)))
      await waitFor(() => received.some((event) => event.sequence === 70))
      console.log(
        'AFTER-70 FETCH:',
        fetch.mock.calls.map((c) => String(c[0]).replace('http://127.0.0.1:4567', '')),
      )
      console.log(
        'AFTER-70 RECEIVED:',
        received.map((e) =>
          JSON.stringify(
            e.type === 'session.gap' ? { gap: [e.fromSequence, e.toSequence] } : { t: e.type, s: e.sequence },
          ),
        ),
      )

      const delivered = received
        .map((event) => event.sequence)
        .filter((sequence): sequence is number => sequence !== undefined)
      for (let sequence = 11; sequence <= 69; sequence += 1) expect(delivered).toContain(sequence)
      expect(received.some((event) => event.type === 'session.gap')).toBe(false)
    } finally {
      unsubscribe()
      await backend.close()
    }
  })
})
