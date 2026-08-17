import { useState, type ReactElement } from 'react'
import type { TodoView } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface TodoListProps {
  readonly todos: readonly TodoView[]
}

/** Persistent task progress directly above the composer. */
export function TodoList({ todos }: TodoListProps): ReactElement | null {
  const { t } = useI18n()
  const [open, setOpen] = useState(true)
  if (todos.length === 0) return null
  const completed = todos.filter((todo) => todo.status === 'completed').length
  const current =
    todos.find((todo) => todo.status === 'in-progress') ?? todos.find((todo) => todo.status === 'pending')
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
          </>
        ) : current === undefined ? (
          <span className="dsh-todo-list__collapsed-copy">
            <TodoStateIcon status="completed" />
            <span className="dsh-todo-list__current">{t('todo.allCompleted')}</span>
          </span>
        ) : (
          <span className="dsh-todo-list__collapsed-copy">
            <TodoStateIcon status={current.status} />
            <span className="dsh-todo-list__current">{current.content}</span>
            <span className="dsh-todo-list__status">{t(`todo.status.${current.status}`)}</span>
          </span>
        )}
        <span className="dsh-todo-list__chevron" aria-hidden="true">
          <Icon name="chevron-down" />
        </span>
      </button>
      {open ? (
        <ol className="dsh-todo-list__items">
          {todos.map((todo) => (
            <li className={`dsh-todo-list__item dsh-todo-list__item--${todo.status}`} key={todo.id}>
              <TodoStateIcon status={todo.status} />
              <span className="dsh-todo-list__content">{todo.content}</span>
              <span className="dsh-todo-list__status">{t(`todo.status.${todo.status}`)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  )
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
