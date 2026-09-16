import { describe, expect, it, vi } from 'vitest'

import type { BackendEndpoint, BackendEvent } from '@dsh-vscode/domain'

import { DshStreamController } from '../src/stream-controller.js'
import { AlphaLoopbackApiClient, type AlphaWebSocket } from '../src/versions/alpha/transport.js'

/**
 * Wire shapes below are copied from the installed 0.1.6-alpha.1 host: the
 * recorder in `@deepseek-ai/dsh-tool-workflow` appends four durable records to
 * the calling Session — `tool-workflow/run-start {runId, name}`,
 * `agent-start {runId, seq, label, phase?, childId}`, `agent-end {runId, seq,
 * outcome}` and `run-end {runId, stopReason}` — and its
 * `@deepseek-ai/dsh-tool-workflow/invariant` companion fences the same fields
 * (non-empty name/runId/childId, 1-based positive integer seq, phase only as a
 * string when present, closed outcome/stopReason unions). The workflow tool is
 * foreground: `run-end` is recorded before the tool result, so a run is only
 * ever left open by an interrupted step. The Ralph loop rides the same family
 * (`meta.name: 'ralph-loop'`), so these records are also its only client-visible
 * projection.
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

function client(): AlphaLoopbackApiClient {
  return new AlphaLoopbackApiClient({
    endpoint,
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch: vi.fn(() => Promise.resolve(new Response('{}'))),
    authCookie: () => 'dsh_session=test-cookie',
    webSocket: FakeWebSocket,
    sessionWireVersion: 'v3',
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

async function waitForReceived(
  received: readonly BackendEvent[],
  predicate: (event: BackendEvent) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (received.some(predicate)) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(
    `timed out waiting for the expected controller event: ${received.map((event) => `${event.type}:${String(event.sequence ?? '')}`).join(',')}`,
  )
}

/** One durable v3 record as `session/follow` carries it: no surface metadata. */
function record(type: string, seq: number, time: number, data: Record<string, unknown>): unknown {
  return { type: 'event', event: { type, seq, time, data } }
}

function workflowEvents(received: readonly BackendEvent[]): BackendEvent[] {
  return received.filter((event) => event.type.startsWith('workflow.'))
}

describe('workflow/Ralph records over the alpha session follow stream', () => {
  it('folds a whole run from the history snapshot and the live member frames', async () => {
    FakeWebSocket.instances.length = 0
    const transport = client()
    const controller = new DshStreamController(transport, undefined, undefined, {
      streamSource: (signal) => transport.openSessionStream('s1', signal),
      closeTransport: false,
    })
    const received: BackendEvent[] = []
    const unsubscribe = controller.subscribe((next) => received.push(next))

    try {
      const socket = await waitForSocket()
      socket.open()
      await waitForSent(socket, 1)

      // Snapshot: the run was opened earlier and two members started inside the
      // bounded history window. One member declared a phase, the other omitted
      // the field entirely — absent and empty phase identities must not merge.
      socket.message(
        streamItem(socket, {
          type: 'snapshot',
          header: { version: 3, id: 's1', createdAt: 1, isSeeded: false },
          cursor: 4,
          records: [
            record('tool/call', 3, 3, {
              turn: 1,
              step: 1,
              callId: 'call-1',
              name: 'workflow',
              arguments: '{"script":"await agent(...)"}',
            }),
            record('tool-workflow/run-start', 4, 4, { runId: 'run-1', name: 'ralph-loop' }),
            record('tool-workflow/agent-start', 5, 5, {
              runId: 'run-1',
              seq: 1,
              label: 'audit the adapter',
              phase: 'Fresh-agent rounds',
              childId: 'child-1',
            }),
            record('tool-workflow/agent-start', 6, 6, {
              runId: 'run-1',
              seq: 2,
              label: '',
              childId: 'child-2',
            }),
          ],
          hasMore: false,
          projections: { asOfSeq: 6, values: {} },
          assistantStream: { revision: 0 },
        }),
      )

      await waitForReceived(received, (event) => event.type === 'workflow.member.started')
      expect(workflowEvents(received)).toEqual([
        {
          type: 'workflow.started',
          sessionId: 's1',
          sequence: 4,
          workflow: {
            id: 'run-1',
            sessionId: 's1',
            name: 'ralph-loop',
            status: 'running',
            stages: [],
          },
        },
        {
          type: 'workflow.member.started',
          sessionId: 's1',
          sequence: 5,
          runId: 'run-1',
          phase: 'Fresh-agent rounds',
          member: {
            seq: 1,
            label: 'audit the adapter',
            childId: 'child-1',
            status: 'running',
          },
        },
        {
          type: 'workflow.member.started',
          sessionId: 's1',
          sequence: 6,
          runId: 'run-1',
          phase: null,
          member: { seq: 2, label: '', childId: 'child-2', status: 'running' },
        },
      ])

      // Live frames: both members settle and the run ends. The tool is
      // foreground, so the run settles before the step that owns it closes.
      const send = (value: unknown): void => socket.message(streamItem(socket, value))
      send(record('tool-workflow/agent-end', 7, 7, { runId: 'run-1', seq: 1, outcome: 'completed' }))
      send(record('tool-workflow/agent-end', 8, 8, { runId: 'run-1', seq: 2, outcome: 'cancelled' }))
      send(record('tool-workflow/run-end', 9, 9, { runId: 'run-1', stopReason: 'cancelled' }))

      await waitForReceived(received, (event) => event.type === 'workflow.ended' && event.sequence === 9)
      expect(workflowEvents(received).slice(3)).toEqual([
        {
          type: 'workflow.member.ended',
          sessionId: 's1',
          sequence: 7,
          runId: 'run-1',
          seq: 1,
          outcome: 'completed',
        },
        {
          type: 'workflow.member.ended',
          sessionId: 's1',
          sequence: 8,
          runId: 'run-1',
          seq: 2,
          outcome: 'cancelled',
        },
        { type: 'workflow.ended', sessionId: 's1', sequence: 9, runId: 'run-1', stopReason: 'cancelled' },
      ])
    } finally {
      unsubscribe()
      await controller.close()
      await transport.close()
    }
  })

  it('degrades a forged workflow record into a redacted unknown row', async () => {
    FakeWebSocket.instances.length = 0
    const transport = client()
    const controller = new DshStreamController(transport, undefined, undefined, {
      streamSource: (signal) => transport.openSessionStream('s1', signal),
      closeTransport: false,
    })
    const received: BackendEvent[] = []
    const unsubscribe = controller.subscribe((next) => received.push(next))

    try {
      const socket = await waitForSocket()
      socket.open()
      await waitForSent(socket, 1)
      // The host invariant refuses an empty run name, so this record can only be
      // forged or written by a future host. It must not mint a nameless run.
      socket.message(
        streamItem(socket, {
          type: 'snapshot',
          header: { version: 3, id: 's1', createdAt: 1, isSeeded: false },
          cursor: 2,
          records: [
            record('tool-workflow/run-start', 1, 1, {
              runId: 'run-1',
              name: '',
              token: 'dsh-live-value',
            }),
            record('tool-workflow/agent-start', 2, 2, {
              runId: 'run-1',
              seq: 0,
              label: 'audit',
              childId: 'child-1',
            }),
          ],
          hasMore: false,
          projections: { asOfSeq: 2, values: {} },
          assistantStream: { revision: 0 },
        }),
      )

      await waitForReceived(received, (event) => event.type === 'unknown' && event.sequence === 2)
      expect(workflowEvents(received)).toEqual([])
      const unknown = received.filter((event) => event.type === 'unknown')
      expect(unknown.map((event) => event.name)).toEqual([
        'tool-workflow/run-start',
        'tool-workflow/agent-start',
      ])
      // The degraded row is bounded and field-name redacted: the opaque run id
      // stays for correlation while credential-class fields are dropped.
      const serialized = JSON.stringify(unknown)
      expect(serialized).not.toContain('dsh-live-value')
      expect(serialized).toContain('run-1')
    } finally {
      unsubscribe()
      await controller.close()
      await transport.close()
    }
  })
})
