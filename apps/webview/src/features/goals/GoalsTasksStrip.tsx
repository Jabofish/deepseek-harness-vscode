import { memo, useId, useRef, useState, type ReactElement } from 'react'
import type { GoalView, TodoView } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { useQuietActivity } from '../../app/AccessibilityProvider.js'
import { GoalBar } from './GoalBar.js'
import { GoalTodoStrip } from './GoalTodoStrip.js'
import { TodoList } from './TodoList.js'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
import { useViewportMenuPosition } from '../../components/common/useViewportMenuPosition.js'

export interface GoalsTasksStripProps {
  readonly goals: readonly GoalView[]
  readonly todos: readonly TodoView[]
  readonly onUpdateGoal?: (
    goalId: string,
    update: Partial<Pick<GoalView, 'title' | 'status' | 'maxGoalRounds'>>,
  ) => Promise<void>
  readonly onClearGoal?: (goalId: string) => Promise<void>
}

/** One compact, collapsed-by-default dock for goals and tasks. The active goal
 * is the everyday signal; the rest is folded behind it for the rare cases where
 * a goal blocks or a task needs a closer look. */
export const GoalsTasksStrip = memo(function GoalsTasksStrip(
  props: GoalsTasksStripProps,
): ReactElement | null {
  const { t } = useI18n()
  const quiet = useQuietActivity()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const panelPosition = useViewportMenuPosition({
    open,
    anchorRef: triggerRef,
    menuRef: panelRef,
    placement: 'below',
    align: 'end',
  })
  useDismissibleLayer({
    open,
    refs: [rootRef],
    onDismiss: () => setOpen(false),
    onEscape: () => {
      setOpen(false)
      triggerRef.current?.focus()
    },
  })
  const { goals, todos } = props

  if (goals.length === 0 && todos.length === 0) return null

  const activeGoal = goals.find((goal) => goal.status !== 'completed')
  const completedGoals = goals.filter((goal) => goal.status === 'completed').length
  const completedTodos = todos.filter((todo) => todo.status === 'completed').length
  const total = goals.length + todos.length
  const completed = completedGoals + completedTodos
  const label = activeGoal?.title ?? (todos.length > 0 ? t('todo.title') : t('goals.title'))

  return (
    <section
      ref={rootRef}
      className={`dsh-goals-tasks${open ? ' dsh-goals-tasks--open' : ''}`}
      aria-label={t('goalsTasks.aria')}
    >
      <button
        ref={triggerRef}
        className="dsh-goals-tasks__toggle"
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? t('goalsTasks.collapse') : t('goalsTasks.expand')}
        title={label}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="dsh-goals-tasks__glyph" aria-hidden="true">
          <Icon name={activeGoal === undefined ? 'list' : 'target'} />
        </span>
        <span className="dsh-goals-tasks__label" title={activeGoal?.title}>
          {label}
        </span>
        {activeGoal === undefined ? null : (
          <span className={`dsh-status-pill dsh-status-pill--${activeGoal.status}`}>
            {t(`goal.status.${activeGoal.status}`)}
          </span>
        )}
        <span
          className="dsh-goals-tasks__count"
          role={quiet ? undefined : 'status'}
          aria-label={t('goals.complete', { completed, total })}
        >
          {completed}/{total}
        </span>
        <span className="dsh-goals-tasks__chevron" aria-hidden="true">
          <Icon name="chevron-down" />
        </span>
      </button>
      <div
        ref={panelRef}
        id={panelId}
        className="dsh-disclosure dsh-goals-tasks__disclosure"
        style={panelPosition}
        data-open={open}
        hidden={!open}
      >
        <div className="dsh-disclosure__inner">
          {activeGoal === undefined ? null : (
            <GoalBar
              goals={goals}
              {...(props.onUpdateGoal === undefined ? {} : { onUpdate: props.onUpdateGoal })}
              {...(props.onClearGoal === undefined ? {} : { onClear: props.onClearGoal })}
            />
          )}
          {goals.length === 0 ? null : <GoalTodoStrip goals={goals} />}
          {todos.length === 0 ? null : <TodoList todos={todos} />}
        </div>
      </div>
    </section>
  )
})
