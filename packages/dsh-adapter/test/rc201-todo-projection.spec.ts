import { describe, expect, it } from 'vitest'
import type { BackendEvent, SessionProjectionValues } from '@dsh-vscode/domain'
import { Rc202VersionAdapter } from '../src/versions/rc202/adapter.js'
import { transportOptions } from './support/contract-harness.js'

/**
 * dsh-v0.2.0-rc.1 / 4878cdabd87d4041bdaff61d04c966883b9fd07a,
 * packages/todo/tool-todo/src/index.ts: todos is a whole-value projection;
 * turn/start clears it to null. rc.2 and alpha.2 retain this contract.
 */
class ProjectionAdapter extends Rc202VersionAdapter {
  public project(values: Readonly<Record<string, unknown>>): SessionProjectionValues {
    return this.mapProjectionValues(values)
  }

  public event(event: BackendEvent): BackendEvent {
    return this.mapBackendEvent(event)
  }
}

const wireTodos = [{ content: 'Fixture task', status: 'in_progress' }] as const
const todos = [{ id: 'todo:0', content: 'Fixture task', status: 'in-progress' }] as const
const adapter = new ProjectionAdapter(transportOptions(globalThis.fetch))

describe('authoritative DSH todo projection', () => {
  it('maps the current whole value, preserves null and absence, and composes rc.2 projections', () => {
    expect(adapter.project({ todos: wireTodos })).toEqual({ todoList: todos })
    expect(adapter.project({ todos: null })).toEqual({ todoList: null })
    expect(adapter.project({})).toEqual({ todoList: null })
    expect(adapter.project({ todos: [], userQuestions: { active: [], settled: [] } })).toEqual({
      todoList: [],
      userQuestions: { active: [], settled: [] },
    })
  })

  it('maps control updates, follow openings and control baselines without replaying todo/write', () => {
    expect(
      adapter.event({ type: 'session.projection', sessionId: 's', key: 'todos', value: null, sequence: 8 }),
    ).toEqual({ type: 'session.projection', sessionId: 's', key: 'todoList', value: null, sequence: 8 })
    expect(
      adapter.event({
        type: 'session.subscribed',
        sessionId: 's',
        lastSequence: 8,
        projection: { asOfSequence: 8, values: { todos: wireTodos } },
      }),
    ).toMatchObject({ projection: { values: { todoList: todos } } })
    expect(
      adapter.event({
        type: 'session.projection.baseline',
        projections: { s: { asOfSequence: 8, values: { todos: wireTodos } } },
      }),
    ).toMatchObject({ projections: { s: { values: { todoList: todos } } } })
  })

  it.each([
    { todos: {} },
    { todos: [{ content: 'Fixture task', status: 'deleted' }] },
    { todos: [{ content: 7, status: 'pending' }] },
    { todos: [{ content: 'Fixture task', status: 'pending', privateValue: 'fixture' }] },
    { todos: wireTodos, todoList: [] },
  ])('rejects malformed or colliding wire data rather than manufacturing an empty list: %j', (values) => {
    expect(() => adapter.project(values)).toThrow()
  })
})
