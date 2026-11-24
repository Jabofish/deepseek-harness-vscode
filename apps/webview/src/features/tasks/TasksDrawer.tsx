import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { TaskListScope, TaskSummary } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
import { useViewportMenuPosition } from '../../components/common/useViewportMenuPosition.js'
import { Icon } from '../../ui/Icon.js'

export interface TasksDrawerProps {
  readonly tasks: readonly TaskSummary[]
  readonly loading: boolean
  readonly scope?: TaskListScope
  readonly includeCompleted?: boolean
  readonly complete?: boolean
  readonly omittedSessions?: number
  readonly alwaysVisible?: boolean
  readonly onRefresh: () => Promise<void>
  readonly onScopeChange?: (scope: TaskListScope) => Promise<void>
  readonly onIncludeCompletedChange?: (includeCompleted: boolean) => Promise<void>
  readonly onOpen: (task: TaskSummary) => Promise<void>
  readonly onStop: (task: TaskSummary) => Promise<void>
  readonly onAnswer?: (task: TaskSummary, answer: string) => Promise<void>
}

function live(task: TaskSummary): boolean {
  return task.status === 'running' || task.status === 'needs-input' || task.status === 'blocked'
}

function taskStatusKey(task: TaskSummary): string {
  return `tasks.status.${task.status}`
}

/** Compact task center with an explicit current-session/workspace scope switch. */
export function TasksDrawer(props: TasksDrawerProps): ReactElement | null {
  const { t } = useI18n()
  const scope = props.scope ?? 'current-session'
  const complete = props.complete ?? true
  const omittedSessions = props.omittedSessions ?? 0
  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const pendingAction = useRef(false)
  const actionGeneration = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuPosition = useViewportMenuPosition({
    open,
    anchorRef: triggerRef,
    menuRef,
    placement: 'below',
    align: 'end',
  })

  useEffect(() => {
    if (busy) menuRef.current?.focus()
  }, [busy])

  const close = (): void => {
    actionGeneration.current += 1
    setOpen(false)
    setFailure(undefined)
  }

  /**
   * Every row action is host work that can be refused (a stale revision, a task
   * owned by another view). Surfacing the refusal is the only way the user can
   * tell "applied" from "silently dropped".
   */
  const runAction = async (action: () => Promise<void>): Promise<void> => {
    if (pendingAction.current) return
    pendingAction.current = true
    const generation = actionGeneration.current
    setBusy(true)
    setFailure(undefined)
    try {
      await action()
    } catch (reason) {
      if (generation === actionGeneration.current)
        setFailure(reason instanceof Error ? reason.message : t('tasks.actionFailed'))
    } finally {
      pendingAction.current = false
      setBusy(false)
    }
  }

  useDismissibleLayer({
    open,
    refs: [rootRef, menuRef],
    onDismiss: close,
    onEscape: () => {
      close()
      triggerRef.current?.focus()
    },
  })

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
  if (visibleTasks.length === 0 && !props.loading && props.alwaysVisible !== true) return null
  const countLabel =
    needsInputCount > 0
      ? t('tasks.count.needsInput', { count: needsInputCount })
      : liveCount > 0
        ? t('tasks.count.live', { count: liveCount })
        : t('tasks.count', { count: visibleTasks.length })

  const changeScope = (next: TaskListScope): void => {
    const onScopeChange = props.onScopeChange
    if (next === scope || onScopeChange === undefined) return
    void runAction(() => onScopeChange(next))
  }

  const openTaskAndClose = (task: TaskSummary): void => {
    void runAction(async () => {
      await props.onOpen(task)
      close()
    })
  }

  return (
    <div ref={rootRef} className="dsh-tasks-popover">
      <button
        ref={triggerRef}
        type="button"
        className="dsh-tasks-popover__trigger"
        aria-expanded={open}
        aria-label={countLabel}
        onClick={() => {
          if (open) close()
          else {
            setOpen(true)
            void runAction(() => props.onRefresh())
          }
        }}
      >
        {needsInputCount > 0 ? <span className="dsh-tasks-popover__dot" data-state="warning" /> : null}
        <Icon name="list" />
        <span>{countLabel}</span>
        <Icon name="chevron-down" />
      </button>
      {open ? (
        <div
          ref={menuRef}
          style={menuPosition}
          className="dsh-tasks-popover__menu"
          role="dialog"
          tabIndex={-1}
          aria-label={t(scope === 'workspace' ? 'tasks.workspaceList.aria' : 'tasks.list.aria')}
        >
          <div className="dsh-tasks-popover__header">
            <strong>{t('tasks.title')}</strong>
            <button
              type="button"
              className="dsh-icon-button"
              aria-label={t('tasks.refresh')}
              title={t('tasks.refresh')}
              disabled={busy || props.loading}
              onClick={() => void runAction(() => props.onRefresh())}
            >
              <Icon name="refresh" />
            </button>
          </div>
          <div className="dsh-tasks-popover__scope" role="group" aria-label={t('tasks.scope.label')}>
            <button
              type="button"
              className="dsh-tasks-popover__scope-button"
              aria-pressed={scope === 'current-session'}
              // The pressed scope stays tabbable and reads as "selected";
              // changeScope ignores a re-pick of the current scope.
              disabled={busy || props.loading || props.onScopeChange === undefined}
              onClick={() => changeScope('current-session')}
            >
              {t('tasks.scope.current')}
            </button>
            <button
              type="button"
              className="dsh-tasks-popover__scope-button"
              aria-pressed={scope === 'workspace'}
              disabled={busy || props.loading || props.onScopeChange === undefined}
              onClick={() => changeScope('workspace')}
            >
              {t('tasks.scope.workspace')}
            </button>
            {props.onIncludeCompletedChange === undefined ? null : (
              <button
                type="button"
                className="dsh-tasks-popover__scope-button"
                aria-pressed={props.includeCompleted === true}
                disabled={busy || props.loading}
                onClick={() =>
                  void runAction(() => props.onIncludeCompletedChange!(props.includeCompleted !== true))
                }
              >
                {t('tasks.includeCompleted')}
              </button>
            )}
          </div>
          {scope === 'workspace' && (!complete || omittedSessions > 0) ? (
            <div className="dsh-tasks-popover__notice" role="status">
              {omittedSessions > 0
                ? t('tasks.partial.omitted', { count: omittedSessions })
                : t('tasks.partial.workspace')}
            </div>
          ) : null}
          {props.loading && visibleTasks.length === 0 ? (
            <div className="dsh-tasks-popover__status">{t('tasks.loading')}</div>
          ) : null}
          {failure === undefined ? null : (
            <p className="dsh-tasks-popover__error" role="alert">
              {failure}
            </p>
          )}
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
                  disabled={busy || !task.canOpen}
                  onClick={() => openTaskAndClose(task)}
                >
                  <span
                    className="dsh-tasks-popover__status-dot"
                    data-state={task.status}
                    aria-hidden="true"
                  />
                  <span className="dsh-tasks-popover__kind">{t(`tasks.kind.${task.kind}`)}</span>
                  {scope === 'workspace' && task.kind !== 'session' && task.sessionTitle !== undefined ? (
                    <span className="dsh-tasks-popover__session" title={task.sessionTitle}>
                      {task.sessionTitle}
                    </span>
                  ) : null}
                  <span className="dsh-tasks-popover__title" title={task.title}>
                    {task.title}
                  </span>
                  {task.progress === undefined ? null : (
                    <span className="dsh-tasks-popover__meta">
                      {`${Math.round(Math.max(0, Math.min(1, task.progress)) * 100)}%`}
                    </span>
                  )}
                  {task.modelLabel === undefined ? null : (
                    <span className="dsh-tasks-popover__meta">{task.modelLabel}</span>
                  )}
                  <span className="dsh-tasks-popover__status">{t(taskStatusKey(task))}</span>
                </button>
                {task.canSessionCancel ? (
                  <button
                    type="button"
                    className="dsh-icon-button"
                    aria-label={t('tasks.stop', { title: task.title })}
                    title={t('tasks.stop', { title: task.title })}
                    disabled={busy}
                    onClick={() => void runAction(() => props.onStop(task))}
                  >
                    <Icon name="stop" />
                  </button>
                ) : null}
                {task.needsUserAction && task.canOpen ? (
                  <button
                    type="button"
                    className="dsh-tasks-popover__answer-button"
                    disabled={busy}
                    onClick={() => openTaskAndClose(task)}
                  >
                    {t('tasks.reviewInSession')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {visibleTasks.length === 0 && !props.loading ? (
            <div className="dsh-tasks-popover__status">
              {t(scope === 'workspace' ? 'tasks.workspaceEmpty' : 'tasks.empty')}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
