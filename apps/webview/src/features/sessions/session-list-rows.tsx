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
  /** Absent when the surface cannot host an editor tab (no such action shown). */
  readonly onOpenInEditor?: (session: SessionSummary) => void
  /** A drag from this row started; the panel decides whether it becomes a tear-off. */
  readonly onDragBegin?: (session: SessionSummary) => void
  readonly onDragEnd?: (session: SessionSummary, dropEffect: string | undefined) => void
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
  onOpenInEditor,
  onDragBegin,
  onDragEnd,
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
  // A row is always draggable: even when the list is not in manual order, the
  // drag can leave the panel and open the session in the editor area. Only the
  // in-list drop targets stay gated on `canReorder`, so reordering is unchanged.
  const dragHint =
    onOpenInEditor === undefined
      ? canReorder
        ? t('sessions.dragSession')
        : undefined
      : canReorder
        ? t('sessions.dragSession')
        : t('sessions.dragSessionToEditor')
  return (
    <li
      aria-busy={removing}
      draggable
      title={dragHint}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        // A custom MIME keeps the payload unreadable to editors and other drop
        // targets; the empty workspace id marks a row that must not reorder.
        event.dataTransfer.setData(
          ORDER_DRAG_MIME,
          JSON.stringify({
            kind: 'session',
            workspaceId: reorderWorkspaceId ?? '',
            itemId: session.id,
          }),
        )
        onDragBegin?.(session)
      }}
      onDragEnd={(event) => onDragEnd?.(session, event.dataTransfer?.dropEffect)}
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
          {session.formatStatus === 'migration-required' ? (
            <span>{t('sessions.migrationRequired')}</span>
          ) : null}
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
        {onOpenInEditor === undefined ? null : (
          <button
            className="dsh-icon-button dsh-session-item__open-in-editor"
            type="button"
            aria-label={t('sessions.openInEditor', { title })}
            title={t('sessions.openInEditorTitle')}
            disabled={disabled}
            onClick={() => onOpenInEditor(session)}
          >
            <Icon name="open-in-editor" />
          </button>
        )}
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
