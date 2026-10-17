import type { SessionProjectionValues, TodoView } from '@dsh-vscode/domain'
import type { TranscriptWindow } from '@dsh-vscode/webview-protocol'
import { translate } from '../../i18n.js'
import { parseTodoViews } from './event-values.js'
import type { AppState } from './types.js'
import { sameTodoList } from './list-equality.js'

const EMPTY_TODOS: readonly TodoView[] = []

/** Use the whole DSH value, or the Host's current-state bridge for older DSH. */
export function currentTodos(
  values: SessionProjectionValues | undefined,
  transcript?: TranscriptWindow,
): readonly TodoView[] {
  if (values !== undefined && Object.hasOwn(values, 'todoList')) {
    if (values.todoList === null) return EMPTY_TODOS
    const todos = parseTodoViews(values.todoList)
    if (todos === undefined) throw new Error(translate('app.error.malformedProjection'))
    return todos
  }
  return transcript?.currentTodos ?? EMPTY_TODOS
}

export function withCurrentTodos(state: AppState): AppState {
  if (state.activeSessionId === undefined) return state
  const todos = currentTodos(state.projections[state.activeSessionId], state.transcript)
  return sameTodoList(state.todos, todos) ? state : { ...state, todos }
}
