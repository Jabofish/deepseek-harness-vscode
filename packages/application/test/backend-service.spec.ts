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

  it('retires every question of the session when a resolution names none of them', () => {
    const backend = new FakeBackend()
    const service = new BackendService()
    service.attach(backend as unknown as DshBackend, () => undefined)
    backend.emit(requested(question('plan', 'rpc-1')))
    backend.emit(requested(question('scope', 'rpc-2')))
    backend.emit({ type: 'question.resolved', sessionId: 's1', outcome: 'cancelled' })

    const replayed: BackendEvent[] = []
    service.attach(backend as unknown as DshBackend, (event) => replayed.push(event))

    expect(replayed).toEqual([])
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

  it('keeps a question pending in another session', () => {
    const backend = new FakeBackend()
    const service = new BackendService()
    service.attach(backend as unknown as DshBackend, () => undefined)
    backend.emit(requested(question('plan', 'rpc-1')))
    backend.emit({
      type: 'question.requested',
      question: { id: 'other', rpcId: 'rpc-9', sessionId: 's2', prompt: 'other?', allowFreeText: true },
    })
    backend.emit({ type: 'question.resolved', sessionId: 's1', questionRpcId: 'rpc-1', outcome: 'answered' })

    const replayed: BackendEvent[] = []
    service.attach(backend as unknown as DshBackend, (event) => replayed.push(event))

    expect(replayed).toEqual([
      {
        type: 'question.requested',
        question: { id: 'other', rpcId: 'rpc-9', sessionId: 's2', prompt: 'other?', allowFreeText: true },
      },
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

  it('still bounds streamed state that is not a pending prompt', () => {
    // Keeping a pending prompt must not turn the cache into a leak: the shipped
    // state that a session streams continuously is what the bound is for.
    const backend = new FakeBackend()
    const service = new BackendService()
    service.attach(backend as unknown as DshBackend, () => undefined)
    for (let index = 0; index < 1_000; index += 1) {
      backend.emit({ type: 'session.status', sessionId: `s-${index}`, status: 'idle' })
    }

    const replayed: BackendEvent[] = []
    service.attach(backend as unknown as DshBackend, (event) => replayed.push(event))

    expect(replayed).toHaveLength(256)
  })
})
