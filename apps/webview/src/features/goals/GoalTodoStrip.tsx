import type { ReactElement } from 'react'
import type { GoalView } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'

export function GoalTodoStrip({
  goals,
  label = 'Goals',
}: {
  readonly goals: readonly GoalView[]
  readonly label?: string
}): ReactElement {
  const completed = goals.filter((goal) => goal.status === 'completed').length
  return (
    <details className="dsh-goal-strip">
      <summary className="dsh-goal-strip__summary">
        <span className="dsh-goal-strip__heading">
          <span className="dsh-goal-strip__icon" aria-hidden="true">
            <Icon name="check" />
          </span>
          <span>{goals.length === 0 ? `No active ${label.toLowerCase()}` : label}</span>
        </span>
        {goals.length === 0 ? null : (
          <span className="dsh-goal-strip__count">
            {completed}/{goals.length} complete
          </span>
        )}
      </summary>
      {goals.length === 0 ? null : (
        <ol className="dsh-goal-strip__list">
          {goals.map((goal) => (
            <li key={goal.id}>
              <span className="dsh-goal-strip__title">{goal.title}</span>
              <span className={`dsh-status-pill dsh-status-pill--${goal.status}`}>{goal.status}</span>
            </li>
          ))}
        </ol>
      )}
    </details>
  )
}
