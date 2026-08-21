import { useRef, useState, type ReactElement } from 'react'
import type { GoalView } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface GoalBarProps {
  readonly goals: readonly GoalView[]
  readonly onUpdate?: (goalId: string, update: Partial<Pick<GoalView, 'title' | 'status'>>) => Promise<void>
  readonly onClear?: (goalId: string) => Promise<void>
}

/** Docked live-goal strip. Creation remains the host `/goal` command; this
 * surface owns only edit, pause/resume and clear mutations. */
export function GoalBar(props: GoalBarProps): ReactElement | null {
  const { t } = useI18n()
  const goal = props.goals.find((entry) => entry.status !== 'completed')
  const [editingGoalId, setEditingGoalId] = useState<string | undefined>()
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const pendingRef = useRef(false)
  const goalId = goal?.id

  if (goal === undefined) return null

  const editing = editingGoalId === goalId

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(undefined)
    try {
      await action()
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t('goals.actionFailed'))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  const saveEdit = (): void => {
    const title = draft.trim()
    if (title === '' || props.onUpdate === undefined) return
    void run(async () => {
      await props.onUpdate!(goal.id, { title })
      setEditingGoalId(undefined)
    })
  }

  if (editing) {
    return (
      <div className="dsh-goal-bar" data-goal-bar>
        <div className="dsh-goal-bar__edit">
          <input
            autoFocus
            className="dsh-goal-bar__input"
            type="text"
            aria-label={t('goals.objective')}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveEdit()
              if (event.key === 'Escape') setEditingGoalId(undefined)
            }}
          />
          <button
            className="dsh-icon-button"
            type="button"
            aria-label={t('goals.save')}
            title={t('goals.save')}
            disabled={pending || draft.trim() === ''}
            onClick={saveEdit}
          >
            <Icon name="check" />
          </button>
          <button
            className="dsh-icon-button"
            type="button"
            aria-label={t('goals.cancelEdit')}
            title={t('goals.cancelEdit')}
            disabled={pending}
            onClick={() => setEditingGoalId(undefined)}
          >
            <Icon name="close" />
          </button>
        </div>
        {error === undefined ? null : (
          <span className="dsh-goal-bar__error" role="alert">
            {error}
          </span>
        )}
      </div>
    )
  }

  const canPause = goal.status === 'in-progress' && props.onUpdate !== undefined
  const canResume = goal.status === 'pending' && props.onUpdate !== undefined
  return (
    <div className="dsh-goal-bar" data-goal-bar>
      <div className="dsh-goal-bar__content">
        <span className="dsh-goal-bar__glyph" aria-hidden="true">
          <Icon name="target" />
        </span>
        <span className="dsh-goal-bar__phase">{t(`goal.status.${goal.status}`)}</span>
        <span className="dsh-goal-bar__title" title={goal.title}>
          {goal.title}
        </span>
        <div className="dsh-goal-bar__actions">
          {canPause ? (
            <button
              className="dsh-icon-button"
              type="button"
              aria-label={t('goals.pause')}
              title={t('goals.pause')}
              disabled={pending}
              onClick={() => void run(() => props.onUpdate!(goal.id, { status: 'pending' }))}
            >
              <Icon name="stop" />
            </button>
          ) : null}
          {canResume ? (
            <button
              className="dsh-icon-button"
              type="button"
              aria-label={t('goals.resume')}
              title={t('goals.resume')}
              disabled={pending}
              onClick={() => void run(() => props.onUpdate!(goal.id, { status: 'in-progress' }))}
            >
              <Icon name="play" />
            </button>
          ) : null}
          {props.onUpdate === undefined ? null : (
            <button
              className="dsh-icon-button"
              type="button"
              aria-label={t('goals.edit')}
              title={t('goals.edit')}
              disabled={pending}
              onClick={() => {
                setDraft(goal.title)
                setError(undefined)
                setEditingGoalId(goal.id)
              }}
            >
              <Icon name="edit" />
            </button>
          )}
          {props.onClear === undefined ? null : (
            <button
              className="dsh-icon-button"
              type="button"
              aria-label={t('goals.clear')}
              title={t('goals.clear')}
              disabled={pending}
              onClick={() => void run(() => props.onClear!(goal.id))}
            >
              <Icon name="trash" />
            </button>
          )}
        </div>
      </div>
      {error === undefined ? null : (
        <span className="dsh-goal-bar__error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
