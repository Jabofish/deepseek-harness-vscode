import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { TaskSummary } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface TasksDrawerProps {
  readonly tasks: readonly TaskSummary[]
  readonly loading: boolean
  readonly onRefresh: () => Promise<void>
  readonly onOpen: (task: TaskSummary) => Promise<void>
  readonly onStop: (task: TaskSummary) => Promise<void>
  readonly onAnswer: (task: TaskSummary, answer: string) => Promise<void>
}

function live(task: TaskSummary): boolean {
  return task.status === 'running' || task.status === 'needs-input' || task.status === 'blocked'
}

function taskStatusKey(task: TaskSummary): string {
  return `tasks.status.${task.status}`
}

/** Compact current-session task center; it never implies global task ownership. */
export function TasksDrawer(props: TasksDrawerProps): ReactElement | null {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [answering, setAnswering] = useState<string | undefined>()
  const [answer, setAnswer] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  const visibleTasks = props.tasks
  const taskCounts = useMemo(() => {
    let liveCount = 0
    let needsInputCount = 0
    for (const task of visibleTasks) {
      if (live(task)) liveCount += 1
      if (task.needsUserAction) needsInputCount += 1
    }
    return { liveCount, needsInputCount }
  }, [visibleTasks])
  const { liveCount, needsInputCount } = taskCounts
  if (visibleTasks.length === 0 && !props.loading) return null
  const countLabel =
    needsInputCount > 0
      ? t('tasks.count.needsInput', { count: needsInputCount })
      : liveCount > 0
        ? t('tasks.count.live', { count: liveCount })
        : t('tasks.count', { count: visibleTasks.length })

  const submitAnswer = async (task: TaskSummary): Promise<void> => {
    const interactionId = task.interactionId
    if (interactionId === undefined || answer.trim() === '') return
    await props.onAnswer(task, answer)
    setAnswer('')
    setAnswering(undefined)
  }

  return (
    <div ref={rootRef} className="dsh-tasks-popover">
      <button
        ref={triggerRef}
        type="button"
        className="dsh-tasks-popover__trigger"
        aria-expanded={open}
        aria-label={countLabel}
        onClick={() => setOpen((current) => !current)}
      >
        {needsInputCount > 0 ? <span className="dsh-tasks-popover__dot" data-state="warning" /> : null}
        <Icon name="list" />
        <span>{countLabel}</span>
        <Icon name="chevron-down" />
      </button>
      {open ? (
        <div className="dsh-tasks-popover__menu" role="dialog" aria-label={t('tasks.list.aria')}>
          <div className="dsh-tasks-popover__header">
            <strong>{t('tasks.title')}</strong>
            <button
              type="button"
              className="dsh-icon-button"
              aria-label={t('tasks.refresh')}
              title={t('tasks.refresh')}
              onClick={() => void props.onRefresh().catch(() => undefined)}
            >
              <Icon name="refresh" />
            </button>
          </div>
          {props.loading && visibleTasks.length === 0 ? (
            <div className="dsh-tasks-popover__status">{t('tasks.loading')}</div>
          ) : null}
          <ul className="dsh-tasks-popover__rows">
            {visibleTasks.map((task) => (
              <li
                key={task.taskId}
                className="dsh-tasks-popover__row"
                data-needs-input={task.needsUserAction}
              >
                <button
                  type="button"
                  className="dsh-tasks-popover__main"
                  disabled={!task.canOpen}
                  onClick={() => void props.onOpen(task).catch(() => undefined)}
                >
                  <span
                    className="dsh-tasks-popover__status-dot"
                    data-state={task.status}
                    aria-hidden="true"
                  />
                  <span className="dsh-tasks-popover__kind">{t(`tasks.kind.${task.kind}`)}</span>
                  <span className="dsh-tasks-popover__title" title={task.title}>
                    {task.title}
                  </span>
                  <span className="dsh-tasks-popover__status">{t(taskStatusKey(task))}</span>
                </button>
                {task.canSessionCancel ? (
                  <button
                    type="button"
                    className="dsh-icon-button"
                    aria-label={t('tasks.stop', { title: task.title })}
                    title={t('tasks.stop', { title: task.title })}
                    onClick={() => void props.onStop(task).catch(() => undefined)}
                  >
                    <Icon name="stop" />
                  </button>
                ) : null}
                {task.canAnswer && task.interactionId !== undefined ? (
                  answering === task.taskId ? (
                    <form
                      className="dsh-tasks-popover__answer"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void submitAnswer(task).catch(() => undefined)
                      }}
                    >
                      <input
                        autoFocus
                        value={answer}
                        aria-label={t('tasks.answerInput')}
                        onChange={(event) => setAnswer(event.target.value)}
                      />
                      <button type="submit" disabled={answer.trim() === ''}>
                        {t('tasks.answer')}
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="dsh-tasks-popover__answer-button"
                      onClick={() => {
                        setAnswering(task.taskId)
                        setAnswer('')
                      }}
                    >
                      {t('tasks.answer')}
                    </button>
                  )
                ) : null}
              </li>
            ))}
          </ul>
          {visibleTasks.length === 0 && !props.loading ? (
            <div className="dsh-tasks-popover__status">{t('tasks.empty')}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
