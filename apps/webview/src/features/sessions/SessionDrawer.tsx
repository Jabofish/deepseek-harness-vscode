import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { SessionSummary, WorkspaceSummary } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'
import { displaySessionTitle } from './session-title.js'
import { useI18n } from '../../i18n.js'

export interface SessionDrawerProps {
  readonly sessions: readonly SessionSummary[]
  readonly workspaces: readonly WorkspaceSummary[]
  readonly activeSessionId: string | undefined
  readonly open?: boolean
  readonly onOpenChange?: (open: boolean) => void
  readonly showTrigger?: boolean
  readonly onOpen: (sessionId: string) => void
  readonly onCreate: (workspaceId: string | undefined) => void
  readonly onArchive: (sessionId: string) => Promise<void>
  readonly onRename: (sessionId: string, title: string) => Promise<void>
  readonly onRenameWorkspace: (workspaceId: string, name: string) => Promise<void>
  readonly onRemoveWorkspace: (workspaceId: string) => Promise<void>
  readonly onMoveWorkspace: (workspaceId: string, beforeWorkspaceId?: string) => Promise<void>
  readonly onMoveSession: (workspaceId: string, sessionId: string, beforeSessionId?: string) => Promise<void>
  readonly onSearch: (query: string) => Promise<readonly SessionSummary[]>
}

type SessionSorting = 'manual' | 'updated'
type WorkspaceDisplay = 'current' | 'grouped'
type RenameTarget =
  | { readonly kind: 'session'; readonly id: string; readonly title: string }
  | { readonly kind: 'workspace'; readonly id: string; readonly title: string }

const SEARCH_DEBOUNCE_MS = 250
const SEARCH_RESULT_LIMIT = 20
const ORDER_DRAG_MIME = 'application/x-dsh-order'

type OrderDrag =
  | { readonly kind: 'workspace'; readonly itemId: string }
  | { readonly kind: 'session'; readonly workspaceId: string; readonly itemId: string }

function readOrderDrag(dataTransfer: DataTransfer): OrderDrag | undefined {
  try {
    const value: unknown = JSON.parse(dataTransfer.getData(ORDER_DRAG_MIME))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (record.kind === 'workspace' && typeof record.itemId === 'string' && record.itemId !== '')
      return { kind: 'workspace', itemId: record.itemId }
    if (
      record.kind === 'session' &&
      typeof record.workspaceId === 'string' &&
      record.workspaceId !== '' &&
      typeof record.itemId === 'string' &&
      record.itemId !== ''
    )
      return { kind: 'session', workspaceId: record.workspaceId, itemId: record.itemId }
  } catch {
    return undefined
  }
  return undefined
}

export function SessionDrawer(props: SessionDrawerProps): ReactElement {
  const { t } = useI18n()
  const { onSearch } = props
  const [internalOpen, setInternalOpen] = useState(false)
  const [removingSessionId, setRemovingSessionId] = useState<string>()
  const [searchQuery, setSearchQuery] = useState('')
  const [contentSearch, setContentSearch] = useState<{
    readonly query: string
    readonly matches: readonly SessionSummary[]
  }>({ query: '', matches: [] })
  const [sorting, setSorting] = useState<SessionSorting>('manual')
  const [workspaceDisplay, setWorkspaceDisplay] = useState<WorkspaceDisplay>('current')
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>()
  const [renameTarget, setRenameTarget] = useState<RenameTarget>()
  const [renameDraft, setRenameDraft] = useState('')
  const [renameError, setRenameError] = useState<string>()
  const [removeWorkspace, setRemoveWorkspace] = useState<WorkspaceSummary>()
  const [removeError, setRemoveError] = useState<string>()
  const [mutationBusy, setMutationBusy] = useState(false)
  const searchSequence = useRef(0)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const panelId = useId()
  const renameDialogId = useId()
  const isControlled = props.open !== undefined
  const open = props.open ?? internalOpen
  const showTrigger = props.showTrigger !== false
  const setOpen = (next: boolean | ((current: boolean) => boolean)): void => {
    const resolved = typeof next === 'function' ? next(open) : next
    if (!isControlled) setInternalOpen(resolved)
    props.onOpenChange?.(resolved)
  }
  const activeSession = props.sessions.find((session) => session.id === props.activeSessionId)
  const activeWorkspace =
    props.workspaces.find((workspace) => workspace.id === activeSession?.workspaceId) ?? props.workspaces[0]
  const selectedWorkspace =
    props.workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? activeWorkspace
  const selectedWorkspaceKey = selectedWorkspace?.id
  const trimmedSearchQuery = searchQuery.trim()
  const contentMatches = contentSearch.query === trimmedSearchQuery ? contentSearch.matches : []
  const query = trimmedSearchQuery.toLowerCase()
  const closeRenameDialog = useCallback((): void => {
    if (mutationBusy) return
    setRenameTarget(undefined)
    setRenameDraft('')
    setRenameError(undefined)
  }, [mutationBusy])

  useEffect(() => {
    if (renameTarget === undefined) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeRenameDialog()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [closeRenameDialog, renameTarget])

  const workspaceSessions = (workspace: WorkspaceSummary): readonly SessionSummary[] =>
    props.sessions.filter(
      (session) =>
        session.origin !== 'subagent' &&
        (session.workspaceId === workspace.id || workspace.sessionIds?.includes(session.id) === true) &&
        (!session.blank || session.id === props.activeSessionId),
    )

  const filterSessions = (workspace: WorkspaceSummary): readonly SessionSummary[] => {
    const sessions = workspaceSessions(workspace)
    const filtered =
      query === ''
        ? sessions
        : sessions.filter((session) => displaySessionTitle(session.title, t).toLowerCase().includes(query))
    return sortSessions(filtered, sorting, workspace.sessionIds, props.activeSessionId)
  }

  const currentWorkspaceSessions = selectedWorkspace === undefined ? [] : filterSessions(selectedWorkspace)
  const groupedWorkspaceSessions = props.workspaces.map((workspace) => ({
    workspace,
    sessions: filterSessions(workspace),
  }))
  const locallyVisibleIds = new Set(
    (workspaceDisplay === 'grouped'
      ? groupedWorkspaceSessions.flatMap((group) => group.sessions)
      : currentWorkspaceSessions
    ).map((session) => session.id),
  )

  useEffect(() => {
    const sequence = searchSequence.current + 1
    searchSequence.current = sequence
    if (trimmedSearchQuery === '') return
    const timer = window.setTimeout(() => {
      void onSearch(trimmedSearchQuery)
        .then((matches) => {
          if (searchSequence.current !== sequence) return
          setContentSearch({
            query: trimmedSearchQuery,
            matches: matches.slice(0, SEARCH_RESULT_LIMIT),
          })
        })
        .catch(() => {
          if (searchSequence.current !== sequence) return
          setContentSearch({ query: trimmedSearchQuery, matches: [] })
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [onSearch, trimmedSearchQuery])

  const otherWorkspaceMatches = sortSessions(
    contentMatches.filter(
      (session) =>
        !locallyVisibleIds.has(session.id) &&
        session.origin !== 'subagent' &&
        !session.blank &&
        session.id !== props.activeSessionId,
    ),
    sorting,
  )

  const openSession = (session: SessionSummary): void => {
    setSelectedWorkspaceId(session.workspaceId)
    setOpen(false)
    props.onOpen(session.id)
  }

  const archiveSession = (session: SessionSummary): void => {
    setRemovingSessionId(session.id)
    void props
      .onArchive(session.id)
      .catch(() => undefined)
      .finally(() => setRemovingSessionId((current) => (current === session.id ? undefined : current)))
  }

  const startRename = (target: RenameTarget): void => {
    setRenameTarget(target)
    setRenameDraft(target.title.trim())
    setRenameError(undefined)
  }

  const submitRename = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (renameTarget === undefined || mutationBusy) return
    const title = renameDraft.trim()
    if (title === '') {
      setRenameError(t('sessions.renameInvalid'))
      return
    }
    setMutationBusy(true)
    setRenameError(undefined)
    const operation =
      renameTarget.kind === 'session'
        ? props.onRename(renameTarget.id, title)
        : props.onRenameWorkspace(renameTarget.id, title)
    void operation
      .then(() => closeRenameDialog())
      .catch((reason: unknown) => {
        setRenameError(reason instanceof Error ? reason.message : t('sessions.renameFailed'))
      })
      .finally(() => setMutationBusy(false))
  }

  const confirmRemoveWorkspace = (): void => {
    if (removeWorkspace === undefined || mutationBusy) return
    setMutationBusy(true)
    setRemoveError(undefined)
    void props
      .onRemoveWorkspace(removeWorkspace.id)
      .then(() => {
        setSelectedWorkspaceId((current) => (current === removeWorkspace.id ? undefined : current))
        setRemoveWorkspace(undefined)
      })
      .catch((reason: unknown) => {
        setRemoveError(reason instanceof Error ? reason.message : t('sessions.workspaceRemoveFailed'))
      })
      .finally(() => setMutationBusy(false))
  }

  const renderSessionRow = (
    session: SessionSummary,
    workspaceName?: string,
    reorderWorkspaceId?: string,
  ): ReactElement => {
    const title = displaySessionTitle(session.title, t)
    const statusLabel = t(`sessions.status.${session.status}`)
    const canReorder = sorting === 'manual' && reorderWorkspaceId !== undefined
    return (
      <li
        key={session.id}
        aria-busy={removingSessionId === session.id}
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
          if (
            drag?.kind !== 'session' ||
            drag.workspaceId !== reorderWorkspaceId ||
            drag.itemId === session.id
          )
            return
          event.preventDefault()
          void props.onMoveSession(reorderWorkspaceId, drag.itemId, session.id)
        }}
      >
        <button
          className={`dsh-session-item__button${session.id === props.activeSessionId ? ' dsh-session-item__button--active' : ''}`}
          type="button"
          aria-current={session.id === props.activeSessionId ? 'page' : undefined}
          disabled={removingSessionId !== undefined || mutationBusy}
          onClick={() => openSession(session)}
        >
          <span
            className={`dsh-session-item__icon dsh-session-item__icon--${session.status}`}
            role="img"
            aria-label={statusLabel}
            title={statusLabel}
          >
            <Icon name={sessionStatusIcon(session.status)} />
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
            className={`dsh-status-pill dsh-session-item__status dsh-session-item__status--${sessionStatusTone(session.status)}`}
          >
            {statusLabel}
          </span>
        </button>
        <div className="dsh-session-item__actions">
          <button
            className="dsh-icon-button dsh-session-item__rename"
            type="button"
            aria-label={t('sessions.rename', { title })}
            title={t('sessions.renameTitle')}
            disabled={removingSessionId !== undefined || mutationBusy}
            onClick={() => startRename({ kind: 'session', id: session.id, title: session.title })}
          >
            <Icon name="edit" />
          </button>
          {session.blank ? null : (
            <button
              className="dsh-icon-button dsh-session-item__remove"
              type="button"
              aria-label={t('sessions.archive', { title })}
              title={t('sessions.archiveTitle')}
              disabled={removingSessionId !== undefined || mutationBusy}
              onClick={() => archiveSession(session)}
            >
              <Icon name="box" />
            </button>
          )}
        </div>
      </li>
    )
  }

  const renderWorkspaceCard = (workspace: WorkspaceSummary): ReactElement => {
    const selected = workspace.id === selectedWorkspaceKey
    return (
      <div
        className={`dsh-session-switcher__workspace${selected ? ' dsh-session-switcher__workspace--active' : ''}`}
        key={workspace.id}
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
          void props.onMoveWorkspace(drag.itemId, workspace.id)
        }}
      >
        <button
          className="dsh-session-switcher__workspace-button"
          type="button"
          aria-pressed={selected}
          onClick={() => {
            setSelectedWorkspaceId(workspace.id)
            setWorkspaceDisplay('current')
          }}
        >
          <span className="dsh-session-switcher__workspace-icon" aria-hidden="true">
            <Icon name="folder" />
          </span>
          <span title={workspace.name}>{workspace.name}</span>
          <small>{workspace.sessionCount}</small>
        </button>
        <div className="dsh-session-switcher__workspace-actions">
          <button
            className="dsh-icon-button"
            type="button"
            aria-label={t('sessions.renameWorkspace', { name: workspace.name })}
            title={t('sessions.renameWorkspaceTitle')}
            disabled={mutationBusy}
            onClick={() => startRename({ kind: 'workspace', id: workspace.id, title: workspace.name })}
          >
            <Icon name="edit" />
          </button>
          <button
            className="dsh-icon-button dsh-session-switcher__workspace-remove"
            type="button"
            aria-label={t('sessions.removeWorkspace', { name: workspace.name })}
            title={t('sessions.removeWorkspaceTitle')}
            disabled={mutationBusy}
            onClick={() => {
              setRemoveError(undefined)
              setRemoveWorkspace(workspace)
            }}
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>
    )
  }

  const renameConflict =
    renameTarget === undefined
      ? false
      : renameTarget.kind === 'session'
        ? props.sessions.some(
            (session) =>
              session.id !== renameTarget.id &&
              session.workspaceId === selectedWorkspaceKey &&
              session.title.trim().toLocaleLowerCase() === renameDraft.trim().toLocaleLowerCase() &&
              renameDraft.trim() !== '',
          )
        : props.workspaces.some(
            (workspace) =>
              workspace.id !== renameTarget.id &&
              workspace.name.trim().toLocaleLowerCase() === renameDraft.trim().toLocaleLowerCase() &&
              renameDraft.trim() !== '',
          )

  return (
    <section
      className={`dsh-session-switcher${showTrigger ? '' : ' dsh-session-switcher--headless'}`}
      aria-labelledby="sessions-title"
    >
      <h2 id="sessions-title" className="dsh-sr-only">
        {t('sessions.title')}
      </h2>
      {showTrigger ? (
        <button
          className={`dsh-session-switcher__trigger${open ? ' dsh-session-switcher__trigger--open' : ''}`}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-haspopup="dialog"
          aria-label={
            activeSession === undefined
              ? t('sessions.open')
              : t('sessions.switch', { title: displaySessionTitle(activeSession.title, t) })
          }
          title={
            activeSession === undefined ? t('sessions.open') : displaySessionTitle(activeSession.title, t)
          }
          onClick={() => setOpen((current) => !current)}
        >
          <span className="dsh-session-switcher__icon" aria-hidden="true">
            <Icon name="session" />
          </span>
          <span className="dsh-sr-only">
            {activeSession === undefined
              ? (activeWorkspace?.name ?? t('sessions.open'))
              : displaySessionTitle(activeSession.title, t)}
          </span>
          <span className="dsh-session-switcher__chevron" aria-hidden="true">
            <Icon name="chevron-down" />
          </span>
        </button>
      ) : null}
      {open ? (
        <div
          id={panelId}
          className="dsh-session-switcher__panel"
          role="dialog"
          aria-label={t('sessions.title')}
        >
          <header className="dsh-session-switcher__panel-header">
            <span
              className="dsh-session-switcher__panel-title"
              title={selectedWorkspace?.name ?? t('sessions.title')}
            >
              {selectedWorkspace?.name ?? t('sessions.title')}
            </span>
            <div className="dsh-session-switcher__panel-actions">
              <button
                className="dsh-icon-button"
                type="button"
                aria-pressed={workspaceDisplay === 'grouped'}
                aria-label={
                  workspaceDisplay === 'grouped'
                    ? t('sessions.showCurrentWorkspace')
                    : t('sessions.groupWorkspaces')
                }
                title={
                  workspaceDisplay === 'grouped'
                    ? t('sessions.showCurrentWorkspaceTitle')
                    : t('sessions.groupWorkspacesTitle')
                }
                onClick={() =>
                  setWorkspaceDisplay((current) => (current === 'current' ? 'grouped' : 'current'))
                }
              >
                <Icon name="folder" />
              </button>
              <button
                className="dsh-icon-button"
                type="button"
                aria-label={sorting === 'manual' ? t('sessions.sortUpdated') : t('sessions.sortManual')}
                title={sorting === 'manual' ? t('sessions.sortUpdatedTitle') : t('sessions.sortManualTitle')}
                onClick={() => setSorting((current) => (current === 'manual' ? 'updated' : 'manual'))}
              >
                <Icon name={sorting === 'manual' ? 'list' : 'clock'} />
              </button>
              <button
                className="dsh-button dsh-button--primary dsh-button--compact"
                type="button"
                aria-label={t('sessions.new')}
                title={t('sessions.new')}
                onClick={() => {
                  setOpen(false)
                  props.onCreate(selectedWorkspaceKey)
                }}
              >
                <Icon name="add" />
                <span className="dsh-sr-only">{t('sessions.new')}</span>
              </button>
            </div>
          </header>
          {props.workspaces.length === 0 ? null : (
            <div className="dsh-session-switcher__workspaces" aria-label={t('sessions.workspaces')}>
              {props.workspaces.map(renderWorkspaceCard)}
            </div>
          )}
          <div className="dsh-session-switcher__search">
            <input
              type="search"
              value={searchQuery}
              placeholder={t('sessions.search')}
              aria-label={t('sessions.searchAria')}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
          {selectedWorkspace === undefined && query === '' ? (
            <p className="dsh-session-switcher__empty">{t('sessions.temporary')}</p>
          ) : workspaceDisplay === 'grouped' ? (
            <div className="dsh-session-switcher__groups">
              {groupedWorkspaceSessions.map(({ workspace, sessions: groupSessions }) => (
                <section
                  className="dsh-session-switcher__group"
                  key={workspace.id}
                  aria-labelledby={`workspace-${workspace.id}`}
                >
                  <header className="dsh-session-switcher__group-header">
                    <strong id={`workspace-${workspace.id}`}>{workspace.name}</strong>
                    <span>{workspace.sessionCount}</span>
                  </header>
                  {groupSessions.length === 0 ? (
                    <p className="dsh-session-switcher__empty">
                      {query === '' ? t('sessions.empty') : t('sessions.noMatch')}
                    </p>
                  ) : (
                    <ul className="dsh-session-switcher__list" aria-label={workspace.name}>
                      {groupSessions.map((session) => renderSessionRow(session, undefined, workspace.id))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          ) : currentWorkspaceSessions.length === 0 && otherWorkspaceMatches.length === 0 ? (
            <p className="dsh-session-switcher__empty">
              {query === '' ? t('sessions.empty') : t('sessions.noMatch')}
            </p>
          ) : (
            <>
              <ul className="dsh-session-switcher__list" aria-label={t('sessions.title')}>
                {currentWorkspaceSessions.map((session) =>
                  renderSessionRow(session, undefined, selectedWorkspace?.id),
                )}
              </ul>
              {otherWorkspaceMatches.length === 0 ? null : (
                <>
                  <p className="dsh-session-switcher__group-label">{t('sessions.contentMatches')}</p>
                  <ul className="dsh-session-switcher__list" aria-label={t('sessions.otherMatches')}>
                    {otherWorkspaceMatches.map((session) =>
                      renderSessionRow(
                        session,
                        props.workspaces.find((workspace) => workspace.id === session.workspaceId)?.name,
                      ),
                    )}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      ) : null}
      {renameTarget === undefined || typeof document === 'undefined'
        ? null
        : createPortal(
            <div className="dsh-session-dialog__backdrop" role="presentation">
              <form
                className="dsh-session-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={renameDialogId}
                onSubmit={submitRename}
              >
                <h2 id={renameDialogId} className="dsh-session-dialog__title">
                  {renameTarget.kind === 'session'
                    ? t('sessions.renameTitle')
                    : t('sessions.renameWorkspaceTitle')}
                </h2>
                <label className="dsh-session-dialog__label" htmlFor={`${renameDialogId}-input`}>
                  {renameTarget.kind === 'session' ? t('sessions.sessionName') : t('sessions.workspaceName')}
                </label>
                <input
                  ref={renameInputRef}
                  id={`${renameDialogId}-input`}
                  className="dsh-session-dialog__input"
                  value={renameDraft}
                  maxLength={renameTarget.kind === 'session' ? 512 : 256}
                  onChange={(event) => setRenameDraft(event.target.value)}
                />
                {renameConflict ? (
                  <p className="dsh-session-dialog__warning" role="status">
                    {renameTarget.kind === 'session'
                      ? t('sessions.renameConflict')
                      : t('sessions.workspaceRenameConflict')}
                  </p>
                ) : null}
                {renameError === undefined ? null : (
                  <p className="dsh-session-dialog__error" role="alert">
                    {renameError}
                  </p>
                )}
                <div className="dsh-session-dialog__actions">
                  <button
                    className="dsh-button dsh-button--secondary"
                    type="button"
                    disabled={mutationBusy}
                    onClick={closeRenameDialog}
                  >
                    {t('common.cancel')}
                  </button>
                  <button className="dsh-button dsh-button--primary" type="submit" disabled={mutationBusy}>
                    {mutationBusy ? t('common.saving') : t('common.save')}
                  </button>
                </div>
              </form>
            </div>,
            document.body,
          )}
      {removeWorkspace === undefined || typeof document === 'undefined'
        ? null
        : createPortal(
            <div className="dsh-session-dialog__backdrop" role="presentation">
              <div
                className="dsh-session-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby={`${panelId}-remove-title`}
              >
                <h2 id={`${panelId}-remove-title`} className="dsh-session-dialog__title">
                  {t('sessions.removeWorkspaceTitle')}
                </h2>
                <p className="dsh-session-dialog__description">
                  {t('sessions.removeWorkspaceConfirm', {
                    name: removeWorkspace.name,
                    count: removeWorkspace.sessionCount,
                  })}
                </p>
                {removeError === undefined ? null : (
                  <p className="dsh-session-dialog__error" role="alert">
                    {removeError}
                  </p>
                )}
                <div className="dsh-session-dialog__actions">
                  <button
                    className="dsh-button dsh-button--secondary"
                    type="button"
                    disabled={mutationBusy}
                    onClick={() => setRemoveWorkspace(undefined)}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    className="dsh-button dsh-button--danger"
                    type="button"
                    disabled={mutationBusy}
                    onClick={confirmRemoveWorkspace}
                  >
                    {mutationBusy ? t('common.removing') : t('common.remove')}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )}
    </section>
  )
}

function sortSessions(
  sessions: readonly SessionSummary[],
  sorting: SessionSorting,
  manualOrder?: readonly string[],
  activeSessionId?: string,
): readonly SessionSummary[] {
  if (sorting === 'manual') {
    const position = new Map((manualOrder ?? []).map((id, index) => [id, index]))
    const sorted = [...sessions].sort(
      (left, right) =>
        (position.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (position.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    )
    return pinCurrentBlank(sorted, activeSessionId)
  }
  return [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

/**
 * The official workspace runtime promotes the current blank New Session row
 * to the head of the workspace order. Keep that visual invariant even when a
 * stale session-order projection still places another row first.
 */
function pinCurrentBlank(
  sessions: readonly SessionSummary[],
  activeSessionId: string | undefined,
): readonly SessionSummary[] {
  if (activeSessionId === undefined) return sessions
  const index = sessions.findIndex((session) => session.id === activeSessionId && session.blank)
  if (index <= 0) return sessions
  const active = sessions[index]
  if (active === undefined) return sessions
  return [active, ...sessions.slice(0, index), ...sessions.slice(index + 1)]
}

function sessionStatusIcon(status: SessionSummary['status']): 'alert' | 'check' | 'clock' | 'play' {
  switch (status) {
    case 'running':
      return 'play'
    case 'completed':
      return 'check'
    case 'failed':
    case 'awaiting-input':
      return 'alert'
    case 'idle':
      return 'clock'
  }
}

function sessionStatusTone(status: SessionSummary['status']): 'blue' | 'green' | 'amber' | 'red' | 'muted' {
  switch (status) {
    case 'running':
      return 'blue'
    case 'awaiting-input':
      return 'amber'
    case 'completed':
      return 'green'
    case 'failed':
      return 'red'
    case 'idle':
      return 'muted'
  }
}
