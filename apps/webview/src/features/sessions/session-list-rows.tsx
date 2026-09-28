import type { PermissionRequest, SessionSummary, UserQuestion, WorkspaceSummary } from '@dsh-vscode/domain'
import type { ReactElement } from 'react'

import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import {
  ORDER_DRAG_MIME,
  readOrderDrag,
  sessionStatusIcon,
  sessionStatusTone,
  workspaceDisplayName,
  type SessionSorting,
} from './session-drawer-model.js'
import { displaySessionTitle } from './session-title.js'

export interface SessionRowProps {
  readonly session: SessionSummary
  readonly active: boolean
  readonly workspaceName?: string
  readonly reorderWorkspaceId?: string
  readonly permissions?: readonly PermissionRequest[]
  readonly questions?: readonly UserQuestion[]
  /** The row's own archive/mutation is in flight. */
  readonly removing: boolean
  /** Every row action is locked while any mutation is in flight. */
  readonly disabled: boolean
  readonly sorting: SessionSorting
  readonly onOpen: (session: SessionSummary) => void
  readonly onArchive: (session: SessionSummary) => void
  readonly onRename: (session: SessionSummary, trigger: HTMLElement) => void
  readonly onMove: (workspaceId: string, sessionId: string, beforeSessionId: string) => void
}

export function SessionRow({
  session,
  active,
  workspaceName,
  reorderWorkspaceId,
  permissions,
  questions,
  removing,
  disabled,
  sorting,
  onOpen,
  onArchive,
  onRename,
  onMove,
}: SessionRowProps): ReactElement {
  const { t } = useI18n()
  const title = displaySessionTitle(session.title, t)
  const waiting = permissions?.some((request) => request.sessionId === session.id)
    ? 'approval'
    : questions?.some(
          (question) => question.sessionId === session.id && question.intent?.kind === 'plan-review',
        )
      ? 'plan-review'
      : questions?.some((question) => question.sessionId === session.id)
        ? 'answer'
        : undefined
  const statusLabel = t(
    waiting === undefined ? `sessions.status.${session.status}` : `sessions.waiting.${waiting}`,
  )
  const canReorder = sorting === 'manual' && reorderWorkspaceId !== undefined
  return (
    <li
      aria-busy={removing}
      draggable={canReorder}
      title={canReorder ? t('sessions.dragSession') : undefined}
      onDragStart={(event) => {
        if (!canReorder) return
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(
          ORDER_DRAG_MIME,
          JSON.stringify({ kind: 'session', workspaceId: reorderWorkspaceId, itemId: session.id }),
        )
      }}
      onDragOver={(event) => {
        if (!canReorder) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        if (!canReorder) return
        const drag = readOrderDrag(event.dataTransfer)
        if (drag?.kind !== 'session' || drag.workspaceId !== reorderWorkspaceId || drag.itemId === session.id)
          return
        event.preventDefault()
        onMove(reorderWorkspaceId, drag.itemId, session.id)
      }}
    >
      <button
        className={`dsh-session-item__button${active ? ' dsh-session-item__button--active' : ''}`}
        type="button"
        aria-current={active ? 'page' : undefined}
        disabled={disabled}
        onClick={() => onOpen(session)}
      >
        <span
          className={`dsh-session-item__icon dsh-session-item__icon--${session.status}`}
          role="img"
          aria-label={statusLabel}
          title={statusLabel}
        >
          <Icon name={waiting === undefined ? sessionStatusIcon(session.status) : 'alert'} />
        </span>
        <span className="dsh-session-item__copy">
          <strong title={title}>{title}</strong>
          {workspaceName === undefined ? null : (
            <span className="dsh-session-item__workspace" title={workspaceName}>
              {workspaceName}
            </span>
          )}
        </span>
        <span
          className={`dsh-status-pill dsh-session-item__status dsh-session-item__status--${waiting === undefined ? sessionStatusTone(session.status) : 'amber'}`}
          title={statusLabel}
        >
          <span className="dsh-session-item__status-dot" aria-hidden="true" />
          <span className="dsh-session-item__status-label">{statusLabel}</span>
        </span>
      </button>
      <div className="dsh-session-item__actions">
        <button
          className="dsh-icon-button dsh-session-item__rename"
          type="button"
          aria-label={t('sessions.rename', { title })}
          title={t('sessions.renameTitle')}
          disabled={disabled}
          onClick={(event) => onRename(session, event.currentTarget)}
        >
          <Icon name="edit" />
        </button>
        {session.blank ? null : (
          <button
            className="dsh-icon-button dsh-session-item__remove"
            type="button"
            aria-label={t('sessions.archive', { title })}
            title={t('sessions.archiveTitle')}
            disabled={disabled}
            onClick={() => onArchive(session)}
          >
            <Icon name="box" />
          </button>
        )}
      </div>
    </li>
  )
}

export interface WorkspaceCardProps {
  readonly workspace: WorkspaceSummary
  readonly selected: boolean
  readonly sorting: SessionSorting
  readonly sessionCount: number
  readonly busy: boolean
  readonly onSelect: (workspace: WorkspaceSummary) => void
  readonly onRename: (workspace: WorkspaceSummary, trigger: HTMLElement) => void
  readonly onRemove: (workspace: WorkspaceSummary, trigger: HTMLElement) => void
  readonly onMove: (workspaceId: string, beforeWorkspaceId: string) => void
}

export function WorkspaceCard({
  workspace,
  selected,
  sorting,
  sessionCount,
  busy,
  onSelect,
  onRename,
  onRemove,
  onMove,
}: WorkspaceCardProps): ReactElement {
  const { t } = useI18n()
  const displayName = workspaceDisplayName(workspace.name, t)
  return (
    <div
      className={`dsh-session-switcher__workspace${selected ? ' dsh-session-switcher__workspace--active' : ''}`}
      draggable={sorting === 'manual'}
      title={sorting === 'manual' ? t('sessions.dragWorkspace') : undefined}
      onDragStart={(event) => {
        if (sorting !== 'manual') return
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(
          ORDER_DRAG_MIME,
          JSON.stringify({ kind: 'workspace', itemId: workspace.id }),
        )
      }}
      onDragOver={(event) => {
        if (sorting !== 'manual') return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        if (sorting !== 'manual') return
        const drag = readOrderDrag(event.dataTransfer)
        if (drag?.kind !== 'workspace' || drag.itemId === workspace.id) return
        event.preventDefault()
        onMove(drag.itemId, workspace.id)
      }}
    >
      <button
        className="dsh-session-switcher__workspace-button"
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(workspace)}
      >
        <span className="dsh-session-switcher__workspace-icon" aria-hidden="true">
          <Icon name="folder" />
        </span>
        <span className="dsh-session-switcher__workspace-name" title={displayName}>
          {displayName}
        </span>
        <small className="dsh-session-switcher__workspace-count">{sessionCount}</small>
      </button>
      <div className="dsh-session-switcher__workspace-actions">
        <button
          className="dsh-icon-button"
          type="button"
          aria-label={t('sessions.renameWorkspace', { name: displayName })}
          title={t('sessions.renameWorkspaceTitle')}
          disabled={busy}
          onClick={(event) => onRename(workspace, event.currentTarget)}
        >
          <Icon name="edit" />
        </button>
        <button
          className="dsh-icon-button dsh-session-switcher__workspace-remove"
          type="button"
          aria-label={t('sessions.removeWorkspace', { name: displayName })}
          title={t('sessions.removeWorkspaceTitle')}
          disabled={busy}
          onClick={(event) => onRemove(workspace, event.currentTarget)}
        >
          <Icon name="trash" />
        </button>
      </div>
    </div>
  )
}
