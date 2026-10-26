import { describe, expect, it } from 'vitest'
import type { BackendEvent, DshBackend, UserQuestion } from '@dsh-vscode/domain'
import { BackendService } from '../src/services/backend-service.js'

class FakeBackend {
  public readonly listeners = new Set<(event: BackendEvent) => void>()
  public readonly events = {
    subscribe: (listener: (event: BackendEvent) => void): (() => void) => {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    },
    close: (): Promise<void> => Promise.resolve(),
  }

  public emit(event: BackendEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

function question(id: string, rpcId: string): UserQuestion {
  return { id, rpcId, sessionId: 's1', prompt: `${id}?`, allowFreeText: true }
}

function requested(value: UserQuestion): BackendEvent {
  return { type: 'question.requested', question: value }
}

describe('BackendService event replay', () => {
  it('remembers the accepted call even when the request has already left the bounded replay cache', () => {
    const backend = new FakeBackend()
    const service = new BackendService()
    service.attach(backend as unknown as DshBackend, () => undefined)
    backend.emit({
      type: 'session.projection.baseline',
      projections: {
        s1: {
          asOfSequence: 10,
          values: {
            userQuestions: { active: [{ callId: 'call', state: 'continued', questions: [] }], settled: [] },
          },
        },
      },
    })
    backend.emit({
      type: 'question.resolved',
      sessionId: 's1',
      questionRpcId: 'rpc',
      outcome: 'answered',
      settledCallId: 'call',
    })
    expect(service.replayEvents().at(-1)).toMatchObject({
      type: 'question.reply.status',
      callId: 'call',
      state: 'settled',
    })
  })

  it('retains terminal request and call identities across rereads, reattach and delayed events', () => {
    const backend = new FakeBackend()
    const service = new BackendService()
    service.attach(backend as unknown as DshBackend, () => undefined)
    const first = { ...question('same-item', 'rpc-old'), callId: 'call-old' }
    backend.emit(requested(first))
    backend.emit({
      type: 'question.resolved',
      sessionId: 's1',
      questionRpcId: 'rpc-old',
      outcome: 'answered',
    })
    backend.emit(requested(first))
    backend.emit({ type: 'connection.lost', reason: 'Reconnect' })
    backend.emit(requested(first))
    const next = { ...first, rpcId: 'rpc-next', callId: 'call-next' }
    backend.emit(requested(next))
    expect(service.replayEvents().filter((event) => event.type === 'question.requested')).toEqual([
      requested(next),
    ])
    backend.emit({
      type: 'session.projection',
      sessionId: 's1',
      key: 'userQuestions',
      value: { active: [], settled: [{ callId: 'call-next', answers: [] }] },
    })
    backend.emit(requested(next))
    const replayed: BackendEvent[] = []
    service.attach(backend as unknown as DshBackend, (event) => replayed.push(event))
    expect(replayed.filter((event) => event.type === 'question.requested')).toEqual([])
  })

  it('keeps a timed question recoverable after foreground timeout and retires stale waterfalls on disconnect', () => {
    const backend = new FakeBackend()
    const service = new BackendService()
    service.attach(backend as unknown as DshBackend, () => undefined)
    const pending = { ...question('q', 'rpc-timeout'), callId: 'call-timed', timed: true }
    backend.emit(requested(pending))
    backend.emit({
      type: 'question.resolved',
      sessionId: 's1',
      questionRpcId: 'rpc-timeout',
      outcome: 'cancelled',
    })
    const projection: BackendEvent = {
      type: 'session.projection',
      sessionId: 's1',
      key: 'userQuestions',
      value: { active: [{ callId: 'call-timed', state: 'continued', questions: [] }], settled: [] },
    }
    backend.emit(projection)
    backend.emit(requested(question('new', 'rpc-new')))
    backend.emit({ type: 'connection.lost', reason: 'Reconnect' })
    expect(service.replayEvents()).toEqual([projection])
  })
  it('keeps a sibling pending question when another question in the session resolves', () => {
    const backend = new FakeBackend()
    const service = new BackendService()
    service.attach(backend as unknown as DshBackend, () => undefined)
    const first = question('plan', 'rpc-1')
    const second = question('scope', 'rpc-2')
    backend.emit(requested(first))
    backend.emit(requested(second))
    backend.emit({ type: 'question.resolved', sessionId: 's1', questionRpcId: 'rpc-1', outcome: 'answered' })

    // A re-attach (the Webview reload path: app.ready -> connect -> attach)
    // re-delivers what the Host still owes the panel.
    const replayed: BackendEvent[] = []
    service.attach(backend as unknown as DshBackend, (event) => replayed.push(event))

    expect(replayed).toEqual([requested(second)])
  })

  it('retires a settled approval and keeps a sibling one pending', () => {
    const backend = new FakeBackend()
    const service = new BackendService()
    service.attach(backend as unknown as DshBackend, () => undefined)
    const first = {
      id: 'ap-1',
      rpcId: 'rpc-1',
      sessionId: 's1',
      title: 'Run tests',
      description: 'Allow the test command.',
      risk: 'medium' as const,
      options: [
        { id: 'allowed-once', label: 'Allow once', kind: 'allow-once' as const },
        { id: 'rejected', label: 'Reject', kind: 'deny' as const },
      ],
    }
    backend.emit({ type: 'permission.requested', request: first })
    backend.emit({
      type: 'permission.requested',
      request: { ...first, id: 'ap-2', rpcId: 'rpc-2', title: 'Run build' },
    })
    backend.emit({ type: 'permission.resolved', sessionId: 's1', requestId: 'ap-1', outcome: 'allowed-once' })

    const replayed: BackendEvent[] = []
    service.attach(backend as unknown as DshBackend, (event) => replayed.push(event))

    expect(replayed).toEqual([
      { type: 'permission.requested', request: { ...first, id: 'ap-2', rpcId: 'rpc-2', title: 'Run build' } },
    ])
  })

  it('keeps an unanswered prompt while a busy session streams past the cache bound', () => {
    // The cache exists so a re-attach (the Webview reload path) still shows the
    // prompt the Host is waiting on. Its bound must therefore retire settled
    // entries first: evicting an unanswered approval leaves the agent blocked on
    // an answer the user can no longer see or give, and the turn just hangs.
    const backend = new FakeBackend()
    const service = new BackendService()
    service.attach(backend as unknown as DshBackend, () => undefined)
    const request = {
      id: 'ap-1',
      rpcId: 'rpc-1',
      sessionId: 's1',
      title: 'Run tests',
      description: 'Allow the test command.',
      risk: 'medium' as const,
      options: [
        { id: 'allowed-once', label: 'Allow once', kind: 'allow-once' as const },
        { id: 'rejected', label: 'Reject', kind: 'deny' as const },
      ],
    }
    backend.emit({ type: 'permission.requested', request })
    backend.emit(requested(question('scope', 'rpc-2')))
    // A working session keeps publishing status and projections. Each distinct
    // session id is a distinct key, so this arrives far past the bound.
    for (let index = 0; index < 400; index += 1) {
      backend.emit({ type: 'session.status', sessionId: `s-${index}`, status: 'idle' })
    }

    const replayed: BackendEvent[] = []
    service.attach(backend as unknown as DshBackend, (event) => replayed.push(event))

    expect(replayed).toContainEqual({ type: 'permission.requested', request })
    expect(replayed).toContainEqual(requested(question('scope', 'rpc-2')))
  })

  it('replays the projection baseline a reloaded panel cannot recover otherwise', () => {
    // The baseline is a whole-set replacement, not a delta: it is the panel's
    // only source for "which sessions have projections at all" and it clears
    // the per-key sequence index. A reloaded Webview joins an already-open
    // control stream, so the stream never re-emits it. Dropping it from the
    // cache blanks every projection readout until the process happens to push
    // that key again.
    const backend = new FakeBackend()
    const service = new BackendService()
    service.attach(backend as unknown as DshBackend, () => undefined)
    const baseline: BackendEvent = {
      type: 'session.projection.baseline',
      projections: {
        s1: {
          asOfSequence: 12,
          values: {
            contextPressure: { pressureTokens: 1_024, contextWindow: 1_000_000 },
          },
        },
      },
    }
    backend.emit(baseline)

    const replayed: BackendEvent[] = []
    service.attach(backend as unknown as DshBackend, (event) => replayed.push(event))

    expect(replayed).toContainEqual(baseline)
  })
})
