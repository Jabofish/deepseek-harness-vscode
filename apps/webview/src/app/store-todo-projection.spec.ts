import { describe, expect, it } from 'vitest'
import type { TodoView } from '@dsh-vscode/domain'
import type { HostMessage } from '@dsh-vscode/webview-protocol'
import { applyHostMessage } from './store/host-message-reducers.js'
import { createInitialState } from './store/initial-state.js'
import type { AppState } from './store/types.js'
import type { ProjectionSequenceIndex } from './store/session-projection.js'

const todos: readonly TodoView[] = [{ id: 'todo:0', content: 'Current task', status: 'in-progress' }]
const historical: readonly TodoView[] = [{ id: 'todo:0', content: 'Previous turn', status: 'completed' }]

function fixture(): { readonly state: AppState; emit(name: string, payload: unknown): void } {
  let state: AppState = {
    ...createInitialState({}),
    activeSessionId: 's',
    timeline: { sessionId: 's', nodes: [], lastSequence: -1, nodeChangeStart: 0, eventCount: 0 },
  }
  const sequences: ProjectionSequenceIndex = {
    perKey: new Map(),
    baselines: new Map(),
    queueBySession: new Map(),
    connectionIdentity: undefined,
  }
  let transportSequence = 0
  return {
    get state() {
      return state
    },
    emit(name: string, payload: unknown) {
      const message: HostMessage = { type: 'event', name, sequence: ++transportSequence, payload }
      applyHostMessage(
        message,
        state,
        (next) => {
          state = typeof next === 'function' ? next(state) : next
        },
        undefined,
        sequences,
      )
    },
  }
}

describe('DSH current todos are independent of historical cards', () => {
  it('uses whole projection values and ignores raw historical Todo events', () => {
    const client = fixture()
    client.emit('session.projection', { sessionId: 's', key: 'todoList', value: todos, sequence: 20 })
    expect(client.state.todos).toEqual(todos)
    client.emit('todo.updated', { sessionId: 's', todos: historical, sequence: 10 })
    expect(client.state.timeline.nodes).toEqual([])
    expect(client.state.todos).toEqual(todos)
    client.emit('session.projection', { sessionId: 's', key: 'todoList', value: null, sequence: 21 })
    expect(client.state.todos).toEqual([])
    client.emit('todo.updated', { sessionId: 's', todos: historical, sequence: 11 })
    expect(client.state.todos).toEqual([])
  })

  it('takes the accepted follow baseline, protects newer control values, and isolates sessions', () => {
    const client = fixture()
    client.emit('session.subscribed', {
      sessionId: 's',
      lastSequence: 20,
      projection: { asOfSequence: 20, values: { todoList: todos } },
    })
    expect(client.state.todos).toEqual(todos)
    client.emit('session.projection', { sessionId: 's', key: 'todoList', value: null, sequence: 25 })
    client.emit('session.subscribed', {
      sessionId: 's',
      lastSequence: 21,
      projection: { asOfSequence: 21, values: { todoList: historical } },
    })
    expect(client.state.todos).toEqual([])
    client.emit('session.projection', { sessionId: 'other', key: 'todoList', value: todos, sequence: 30 })
    expect(client.state.todos).toEqual([])
  })

  it('clears a removed optional service and rejects malformed values before accepting their watermark', () => {
    const client = fixture()
    client.emit('session.projection', { sessionId: 's', key: 'todoList', value: todos, sequence: 20 })
    client.emit('session.projection', {
      sessionId: 's',
      key: 'todoList',
      value: [{ content: 'Invalid' }],
      sequence: 100,
    })
    client.emit('session.projection', { sessionId: 's', key: 'todoList', value: null, sequence: 21 })
    expect(client.state.todos).toEqual([])
    client.emit('session.projection', { sessionId: 's', key: 'todoList', value: todos, sequence: 22 })
    client.emit('session.projection.baseline', { projections: {} })
    expect(client.state.todos).toEqual([])
    client.emit('todo.updated', { sessionId: 's', todos: historical, sequence: 23 })
    expect(client.state.todos).toEqual([])
  })
})
