import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent, DshBackend } from '@dsh-vscode/domain'
import { BackendService } from '../src/services/backend-service.js'

function fixture(): { readonly backend: DshBackend; readonly emit: (event: BackendEvent) => void } {
  let sink!: (event: BackendEvent) => void
  const subscribe = vi.fn((listener: (event: BackendEvent) => void) => {
    sink = listener
    return () => undefined
  })
  return {
    backend: { events: { subscribe } } as unknown as DshBackend,
    emit: (event: BackendEvent) => sink(event),
  }
}

describe('backend replay lifecycle regressions', () => {
  it('ignores an already queued callback from a replaced or detached subscription', async () => {
    const service = new BackendService()
    const old = fixture()
    const current = fixture()
    const oldSink = vi.fn()
    service.attach(old.backend, oldSink)
    service.attach(current.backend, () => undefined)
    old.emit({ type: 'session.status', sessionId: 'old', status: 'busy' })
    const replay = vi.fn()
    service.attach(current.backend, replay)
    expect(oldSink).not.toHaveBeenCalled()
    expect(replay).not.toHaveBeenCalled()
    await service.detach()
    current.emit({ type: 'session.status', sessionId: 'current', status: 'busy' })
    service.attach(current.backend, replay)
    expect(replay).not.toHaveBeenCalled()
  })

  it('retires all removed-session replay state, including the global projection baseline', () => {
    const service = new BackendService()
    const source = fixture()
    service.attach(source.backend, () => undefined)
    source.emit({
      type: 'session.projection.baseline',
      projections: {
        gone: { asOfSequence: 1, values: { title: 'Gone' } },
        kept: { asOfSequence: 2, values: { title: 'Kept' } },
      },
    })
    source.emit({ type: 'session.status', sessionId: 'gone', status: 'busy' })
    source.emit({
      type: 'question.requested',
      question: {
        id: 'q',
        rpcId: 'rpc',
        sessionId: 'gone',
        prompt: '?',
        allowFreeText: true,
      },
    })
    source.emit({ type: 'session.removed', sessionId: 'gone' })
    const replay: BackendEvent[] = []
    service.attach(source.backend, (event) => replay.push(event))
    expect(replay).toEqual([
      {
        type: 'session.projection.baseline',
        projections: {
          kept: { asOfSequence: 2, values: { title: 'Kept' } },
        },
      },
    ])
  })

  it('replays cumulative configuration fields instead of only the final patch', () => {
    const service = new BackendService()
    const source = fixture()
    service.attach(source.backend, () => undefined)
    source.emit({
      type: 'session.configuration',
      sessionId: 's',
      patch: { model: { modelId: 'm', providerId: 'p' }, planMode: true },
    })
    source.emit({ type: 'session.configuration', sessionId: 's', patch: { permissionPreset: 'default' } })
    const replay: BackendEvent[] = []
    service.attach(source.backend, (event) => replay.push(event))
    expect(replay).toEqual([
      {
        type: 'session.configuration',
        sessionId: 's',
        patch: {
          model: { modelId: 'm', providerId: 'p' },
          planMode: true,
          permissionPreset: 'default',
        },
      },
    ])
  })

  it('resolves by RPC identity without also removing a sibling with that display id', () => {
    const service = new BackendService()
    const source = fixture()
    service.attach(source.backend, () => undefined)
    const sibling: BackendEvent = {
      type: 'question.requested',
      question: {
        id: 'rpc-first',
        rpcId: 'rpc-second',
        sessionId: 's',
        prompt: 'second?',
        allowFreeText: true,
      },
    }
    source.emit({
      type: 'question.requested',
      question: {
        id: 'first',
        rpcId: 'rpc-first',
        sessionId: 's',
        prompt: 'first?',
        allowFreeText: true,
      },
    })
    source.emit(sibling)
    source.emit({ type: 'question.resolved', sessionId: 's', questionRpcId: 'rpc-first' })
    const replay: BackendEvent[] = []
    service.attach(source.backend, (event) => replay.push(event))
    expect(replay).toEqual([sibling])
  })
})
