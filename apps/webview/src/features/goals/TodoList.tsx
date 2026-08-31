import { memo, useMemo, useState, type ReactElement } from 'react'
import type { TodoView } from '@dsh-vscode/domain'
import { ContentFlow } from '../../components/common/ContentFlow.js'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface TodoListProps {
  readonly todos: readonly TodoView[]
}

/** Persistent task progress directly above the composer. */
export const TodoList = memo(function TodoList({ todos }: TodoListProps): ReactElement | null {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const { completed, inProgress, pending, current } = useMemo(() => summarizeTodos(todos), [todos])
  if (todos.length === 0) return null
  const summary = t('todo.summary', { completed, inProgress, pending })
  return (
    <section
      className={`dsh-todo-list${open ? '' : ' dsh-todo-list--collapsed'}`}
      aria-label={t('todo.aria')}
    >
      <button
        className="dsh-todo-list__toggle"
        type="button"
        aria-expanded={open}
        aria-label={open ? t('todo.collapse') : t('todo.expand')}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        {open ? (
          <>
            <span className="dsh-todo-list__heading">
              <Icon name="list" />
              <strong>{t('todo.title')}</strong>
            </span>
            <span className="dsh-todo-list__progress" role="status">
              {t('todo.progress', { completed, total: todos.length })}
            </span>
            <span className="dsh-todo-list__summary" title={summary}>
              {summary}
            </span>
          </>
        ) : (
          <span className="dsh-todo-list__collapsed-copy">
            <span className="dsh-todo-list__heading">
              <Icon name="list" />
              <strong>{t('todo.title')}</strong>
            </span>
            <span className="dsh-todo-list__progress" role="status">
              {t('todo.progress', { completed, total: todos.length })}
            </span>
            {current === undefined ? (
              <span className="dsh-todo-list__current">{t('todo.allCompleted')}</span>
            ) : (
              <>
                <TodoStateIcon status={current.status} />
                <ContentFlow as="span" className="dsh-todo-list__current">
                  {current.content}
                </ContentFlow>
                <span className="dsh-todo-list__status">{t(`todo.status.${current.status}`)}</span>
              </>
            )}
          </span>
        )}
        <span className="dsh-todo-list__chevron" aria-hidden="true">
          <Icon name="chevron-down" />
        </span>
      </button>
      <div className="dsh-disclosure dsh-todo-list__disclosure" data-open={open}>
        <div className="dsh-disclosure__inner">
          <ol className="dsh-todo-list__items" aria-hidden={!open}>
            {todos.map((todo) => (
              <li className={`dsh-todo-list__item dsh-todo-list__item--${todo.status}`} key={todo.id}>
                <TodoStateIcon status={todo.status} />
                <ContentFlow as="span" className="dsh-todo-list__content">
                  {todo.content}
                </ContentFlow>
                <span className="dsh-todo-list__status">{t(`todo.status.${todo.status}`)}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
})

interface TodoSummary {
  readonly completed: number
  readonly inProgress: number
  readonly pending: number
  readonly current: TodoView | undefined
}

function summarizeTodos(todos: readonly TodoView[]): TodoSummary {
  let completed = 0
  let inProgress = 0
  let pending = 0
  let firstInProgress: TodoView | undefined
  let firstPending: TodoView | undefined

  for (const todo of todos) {
    if (todo.status === 'completed') {
      completed += 1
    } else if (todo.status === 'in-progress') {
      inProgress += 1
      firstInProgress ??= todo
    } else {
      pending += 1
      firstPending ??= todo
    }
  }

  return {
    completed,
    inProgress,
    pending,
    current: firstInProgress ?? firstPending,
  }
}

function TodoStateIcon({ status }: { readonly status: TodoView['status'] }): ReactElement {
  return (
    <span className={`dsh-todo-list__state-icon dsh-todo-list__state-icon--${status}`} aria-hidden="true">
      {status === 'completed' ? (
        <Icon name="check" />
      ) : status === 'in-progress' ? (
        <Icon name="play" />
      ) : (
        <span className="dsh-todo-list__pending-dot" />
      )}
    </span>
  )
}
