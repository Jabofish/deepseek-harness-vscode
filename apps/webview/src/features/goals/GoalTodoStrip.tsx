import type { ReactElement } from 'react'
import type { GoalView } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export function GoalTodoStrip({
  goals,
  label,
}: {
  readonly goals: readonly GoalView[]
  readonly label?: string
}): ReactElement {
  const { t } = useI18n()
  const title = label ?? t('goals.title')
  const completed = goals.filter((goal) => goal.status === 'completed').length
  return (
    <details className="dsh-goal-strip">
      <summary className="dsh-goal-strip__summary">
        <span className="dsh-goal-strip__heading">
          <span className="dsh-goal-strip__icon" aria-hidden="true">
            <Icon name="check" />
          </span>
          <span>{goals.length === 0 ? t('goals.noActive', { label: title }) : title}</span>
        </span>
        {goals.length === 0 ? null : (
          <span className="dsh-goal-strip__count">
            {t('goals.complete', { completed, total: goals.length })}
          </span>
        )}
      </summary>
      {goals.length === 0 ? null : (
        <ol className="dsh-goal-strip__list">
          {goals.map((goal) => (
            <li key={goal.id}>
              <span className="dsh-goal-strip__title">{goal.title}</span>
              <span className={`dsh-status-pill dsh-status-pill--${goal.status}`}>
                {t(`goal.status.${goal.status}`)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </details>
  )
}
