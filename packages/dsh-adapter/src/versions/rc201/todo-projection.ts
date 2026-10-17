import {
  AppError,
  type BackendEvent,
  type SessionProjectionValues,
  type SessionTodoProjection,
} from '@dsh-vscode/domain'
import { recordOrUndefined } from '../../repositories/shared/guards.js'

/** A wire-to-DTO translation, not a todo/write fold. DSH owns the current list. */
function todoList(value: unknown): SessionTodoProjection {
  if (value === null) return null
  if (!Array.isArray(value)) throw malformed()
  return value.map((entry, index) => {
    const item = recordOrUndefined(entry)
    if (
      item === undefined ||
      Object.keys(item).some((key) => key !== 'content' && key !== 'status') ||
      typeof item.content !== 'string' ||
      (item.status !== 'pending' && item.status !== 'in_progress' && item.status !== 'completed')
    )
      throw malformed()
    return {
      id: `todo:${index}`,
      content: item.content,
      status: item.status === 'in_progress' ? ('in-progress' as const) : item.status,
    }
  })
}

/** todoList is the domain key; reserve it so arbitrary wire keys cannot impersonate the DTO. */
export function mapRc201ProjectionValues(values: Readonly<Record<string, unknown>>): SessionProjectionValues {
  if (Object.hasOwn(values, 'todoList')) throw malformed()
  const { todos, ...remaining } = values
  // A complete baseline omitting the optional service is not a reason to revive old history.
  return { ...remaining, todoList: Object.hasOwn(values, 'todos') ? todoList(todos) : null }
}

export function mapRc201BackendEvent(event: BackendEvent): BackendEvent {
  if (event.type === 'session.projection') {
    if (event.key === 'todoList') throw malformed()
    return event.key === 'todos' ? { ...event, key: 'todoList', value: todoList(event.value) } : event
  }
  if (event.type === 'session.subscribed' && event.projection !== undefined)
    return {
      ...event,
      projection: { ...event.projection, values: mapRc201ProjectionValues(event.projection.values) },
    }
  if (event.type === 'session.projection.baseline')
    return {
      ...event,
      projections: Object.fromEntries(
        Object.entries(event.projections).map(([sessionId, projection]) => [
          sessionId,
          { ...projection, values: mapRc201ProjectionValues(projection.values) },
        ]),
      ),
    }
  return event
}

function malformed(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed todo projection.',
    retryable: false,
  })
}
