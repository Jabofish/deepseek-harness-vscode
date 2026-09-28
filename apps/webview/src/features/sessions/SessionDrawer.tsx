import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'
import type {
  PermissionRequest,
  UserQuestion,
  SessionPage,
  SessionSummary,
  WorkspaceSummary,
} from '@dsh-vscode/domain'
import { PopoverCard } from '../../components/common/PopoverCard.js'
import { SelectMenu } from '../../components/common/SelectMenu.js'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
import { Icon } from '../../ui/Icon.js'
import { displaySessionTitle } from './session-title.js'
import { DeleteSessionDialog, RemoveWorkspaceDialog, RenameDialog } from './session-drawer-dialogs.js'
import { SessionRow, WorkspaceCard } from './session-list-rows.js'
import { useI18n } from '../../i18n.js'
import {
  ARCHIVE_FILTERS,
  SEARCH_QUERY_MAX_CODE_UNITS,
  projectSessionLists,
  renameConflictFor,
  sanitizeSearchQuery,
  workspaceDisplayName,
  workspaceSessionsFor,
  type ArchiveFilter,
  type RenameTarget,
  type SessionListProjectionInput,
  type SessionSorting,
  type WorkspaceDisplay,
} from './session-drawer-model.js'
import { useSessionContentSearch } from './useSessionContentSearch.js'

export interface SessionDrawerProps {
  readonly permissions?: readonly PermissionRequest[]
  readonly questions?: readonly UserQuestion[]
  readonly sessions: readonly SessionSummary[]
  readonly workspaces: readonly WorkspaceSummary[]
  readonly activeSessionId: string | undefined
  readonly preferredWorkspaceId?: string | undefined
  /** Omitted or `undefined` leaves the switcher uncontrolled: it owns `open`. */
  readonly open?: boolean | undefined
  readonly onOpenChange?: (open: boolean) => void
  readonly showTrigger?: boolean
  readonly onOpen: (sessionId: string) => void
  readonly onCreate: (workspaceId: string | undefined) => void
  readonly onArchive: (sessionId: string) => Promise<void>
  /** Archived rows the host still holds; fetched on demand by the section. */
  readonly archivedSessions: readonly SessionSummary[]
  readonly onLoadArchived: () => Promise<void>
  readonly canRestoreSessions?: boolean
  readonly onRestore: (sessionId: string) => Promise<void>
  /** Destructive: removes the archived conversation record from DSH. */
  readonly onDelete: (sessionId: string) => Promise<void>
  readonly onRename: (sessionId: string, title: string) => Promise<void>
  readonly onRenameWorkspace: (workspaceId: string, name: string) => Promise<void>
  readonly onAddWorkspace: () => Promise<void>
  readonly onRemoveWorkspace: (workspaceId: string) => Promise<void>
  readonly onMoveWorkspace: (workspaceId: string, beforeWorkspaceId?: string) => Promise<void>
  readonly onMoveSession: (workspaceId: string, sessionId: string, beforeSessionId?: string) => Promise<void>
  readonly onSearch: (query: string) => Promise<SessionPage>
}

export const SessionDrawer = memo(function SessionDrawer(props: SessionDrawerProps): ReactElement {
  const { t } = useI18n()
  const displayWorkspaceName = (name: string): string => workspaceDisplayName(name, t)
  const { onLoadArchived, onSearch } = props
  const [internalOpen, setInternalOpen] = useState(false)
  const [removingSessionId, setRemovingSessionId] = useState<string>()
  const [searchQuery, setSearchQuery] = useState('')
  const [sorting, setSorting] = useState<SessionSorting>('manual')
  const [workspaceDisplay, setWorkspaceDisplay] = useState<WorkspaceDisplay>('current')
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>('hide')
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>()
  const [renameTarget, setRenameTarget] = useState<RenameTarget>()
  const [renameDraft, setRenameDraft] = useState('')
  const [renameError, setRenameError] = useState<string>()
  const [removeWorkspace, setRemoveWorkspace] = useState<WorkspaceSummary>()
  const [removeError, setRemoveError] = useState<string>()
  const [archiveError, setArchiveError] = useState<string>()
  const [moveError, setMoveError] = useState<string>()
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [archivedLoading, setArchivedLoading] = useState(false)
  const [archivedError, setArchivedError] = useState<string>()
  const [restoringSessionId, setRestoringSessionId] = useState<string>()
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary>()
  const [deleteError, setDeleteError] = useState<string>()
  const [mutationBusy, setMutationBusy] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const renameDialogRef = useRef<HTMLFormElement>(null)
  const removeDialogRef = useRef<HTMLDivElement>(null)
  const deleteDialogRef = useRef<HTMLDivElement>(null)
  /** Both dialogs are portalled `aria-modal` surfaces; the row control that
   * opened one takes the keyboard back when it closes. */
  const dialogTriggerRef = useRef<HTMLElement | null>(null)
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
  const archivedWorkspaceIds = new Set(props.archivedSessions.map((session) => session.workspaceId))
  const visibleWorkspaces =
    archiveFilter === 'archived'
      ? props.workspaces.filter(
          (workspace) =>
            archivedWorkspaceIds.has(workspace.id) ||
            workspace.sessionIds?.some((sessionId) =>
              props.archivedSessions.some((session) => session.id === sessionId),
            ) === true,
        )
      : props.workspaces
  const selectedWorkspace =
    visibleWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId) ??
    visibleWorkspaces.find((workspace) => workspace.id === props.preferredWorkspaceId) ??
    visibleWorkspaces.find((workspace) => workspace.id === activeSession?.workspaceId) ??
    visibleWorkspaces[0]
  const selectedWorkspaceKey = selectedWorkspace?.id
  const trimmedSearchQuery = searchQuery.trim()
  const { contentSearch, unavailable: contentSearchUnavailable } = useSessionContentSearch({
    open,
    query: trimmedSearchQuery,
    archiveFilter,
    onSearch,
  })
  const contentMatches = contentSearch.query === trimmedSearchQuery ? contentSearch.matches : []
  const contentSearchHasMore = contentSearch.query === trimmedSearchQuery && contentSearch.searchHasMore
  const query = trimmedSearchQuery.toLowerCase()
  const closeRenameDialog = useCallback((): void => {
    if (mutationBusy) return
    setRenameTarget(undefined)
    setRenameDraft('')
    setRenameError(undefined)
  }, [mutationBusy])
  const closeRemoveDialog = useCallback((): void => {
    if (mutationBusy) return
    setRemoveWorkspace(undefined)
  }, [mutationBusy])
  const closeDeleteDialog = useCallback((): void => {
    if (mutationBusy) return
    setDeleteTarget(undefined)
    setDeleteError(undefined)
  }, [mutationBusy])
  const closeSwitcher = (): void => {
    setOpen(false)
  }
  const closeSwitcherAndRefocus = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }
  const chooseArchiveFilter = (value: string): void => {
    if (value !== 'hide' && value !== 'all' && value !== 'archived') return
    setArchiveFilter(value)
    if (value !== 'hide') setArchivedOpen(true)
  }
  // The switcher is the outer layer; its two portalled dialogs each own the
  // innermost layer, so one Escape closes the dialog and leaves the switcher
  // (and its search and scroll position) in place. The trigger belongs to the
  // layer as well: without it a real press (pointerdown then click) closes the
  // switcher on the pointerdown and the click toggles it straight back open.
  useDismissibleLayer({
    open,
    refs: [triggerRef, panelRef, renameDialogRef, removeDialogRef, deleteDialogRef],
    onDismiss: closeSwitcher,
    onEscape: closeSwitcherAndRefocus,
  })
  useDismissibleLayer({
    open: renameTarget !== undefined,
    refs: [renameDialogRef],
    onDismiss: closeRenameDialog,
    trapFocus: true,
  })
  useDismissibleLayer({
    open: removeWorkspace !== undefined,
    refs: [removeDialogRef],
    onDismiss: closeRemoveDialog,
    trapFocus: true,
  })
  useDismissibleLayer({
    open: deleteTarget !== undefined,
    refs: [deleteDialogRef],
    onDismiss: closeDeleteDialog,
    trapFocus: true,
  })

  useEffect(() => {
    if (renameTarget === undefined) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [renameTarget])

  useEffect(() => {
    if (!open || archiveFilter === 'hide' || !archivedOpen) return
    let cancelled = false
    setArchivedError(undefined)
    setArchivedLoading(true)
    // A refused load must read as "the host did not answer", not as an empty
    // archive: only the host can say which rows it still holds.
    void onLoadArchived()
      .catch((reason: unknown) => {
        if (cancelled) return
        setArchivedError(reason instanceof Error ? reason.message : t('sessions.archivedLoadFailed'))
      })
      .finally(() => {
        if (!cancelled) setArchivedLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [archiveFilter, archivedOpen, open, onLoadArchived, t])

  const dialogOpen = renameTarget !== undefined || removeWorkspace !== undefined || deleteTarget !== undefined
  const dialogWasOpen = useRef(false)
  useEffect(() => {
    if (dialogWasOpen.current && !dialogOpen) {
      const target = dialogTriggerRef.current
      dialogTriggerRef.current = null
      if (target !== null && target.isConnected) target.focus()
      else (triggerRef.current ?? panelRef.current)?.focus()
    }
    dialogWasOpen.current = dialogOpen
  }, [dialogOpen])

  const listProjectionInput: SessionListProjectionInput = {
    sessions: props.sessions,
    archivedSessions: props.archivedSessions,
    visibleWorkspaces,
    activeSessionId: props.activeSessionId,
    selectedWorkspace,
    contentMatches,
    query,
    sorting,
    archiveFilter,
    workspaceDisplay,
    t,
  }

  const workspaceSessions = (workspace: WorkspaceSummary): readonly SessionSummary[] =>
    workspaceSessionsFor(listProjectionInput, workspace)

  const {
    current: currentWorkspaceSessions,
    grouped: groupedWorkspaceSessions,
    contentMatches: contentSearchResults,
    archivedInScope: archivedSessionsToShow,
    archived: filteredArchivedSessions,
  } = projectSessionLists(listProjectionInput)

  const openSession = (session: SessionSummary): void => {
    setSelectedWorkspaceId(session.workspaceId)
    setOpen(false)
    props.onOpen(session.id)
  }

  const archiveSession = (session: SessionSummary): void => {
    setArchiveError(undefined)
    setRemovingSessionId(session.id)
    void props
      .onArchive(session.id)
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : ''
        setArchiveError(message.trim() === '' ? t('app.error.archiveSession') : message)
      })
      .finally(() => setRemovingSessionId((current) => (current === session.id ? undefined : current)))
  }

  /**
   * Restore and delete are host operations whose refusal must be visible: a
   * silent failure would leave the row in the archived list looking untouched
   * even though nothing was written.
   */
  const restoreArchivedSession = (session: SessionSummary): void => {
    setArchivedError(undefined)
    setRestoringSessionId(session.id)
    void props
      .onRestore(session.id)
      .catch((reason: unknown) => {
        setArchivedError(reason instanceof Error ? reason.message : t('sessions.restoreFailed'))
      })
      .finally(() => setRestoringSessionId((current) => (current === session.id ? undefined : current)))
  }

  const confirmDeleteSession = (): void => {
    if (deleteTarget === undefined || mutationBusy) return
    setMutationBusy(true)
    setDeleteError(undefined)
    void props
      .onDelete(deleteTarget.id)
      .then(() => setDeleteTarget(undefined))
      .catch((reason: unknown) => {
        setDeleteError(reason instanceof Error ? reason.message : t('sessions.deleteFailed'))
      })
      .finally(() => setMutationBusy(false))
  }

  /**
   * Reorder drops are host work like any other mutation: a refused move leaves
   * the list unchanged, so without a report the drag is indistinguishable from
   * a no-op.
   */
  const moveSession = (workspaceId: string, sessionId: string, beforeSessionId: string): void => {
    setMoveError(undefined)
    void props.onMoveSession(workspaceId, sessionId, beforeSessionId).catch((reason: unknown) => {
      setMoveError(reason instanceof Error ? reason.message : t('sessions.moveFailed'))
    })
  }

  const moveWorkspace = (workspaceId: string, beforeWorkspaceId: string): void => {
    setMoveError(undefined)
    void props.onMoveWorkspace(workspaceId, beforeWorkspaceId).catch((reason: unknown) => {
      setMoveError(reason instanceof Error ? reason.message : t('sessions.moveFailed'))
    })
  }

  const startRename = (target: RenameTarget): void => {
    setRenameTarget(target)
    setRenameDraft(
      target.kind === 'workspace' ? displayWorkspaceName(target.title.trim()) : target.title.trim(),
    )
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
    if (renameTarget.kind === 'workspace' && title === displayWorkspaceName(renameTarget.title.trim())) {
      closeRenameDialog()
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
  ): ReactElement => (
    <SessionRow
      key={session.id}
      session={session}
      active={session.id === props.activeSessionId}
      {...(workspaceName === undefined ? {} : { workspaceName })}
      {...(reorderWorkspaceId === undefined ? {} : { reorderWorkspaceId })}
      {...(props.permissions === undefined ? {} : { permissions: props.permissions })}
      {...(props.questions === undefined ? {} : { questions: props.questions })}
      removing={removingSessionId === session.id}
      disabled={removingSessionId !== undefined || mutationBusy}
      sorting={sorting}
      onOpen={openSession}
      onArchive={archiveSession}
      onRename={(target, trigger) => {
        dialogTriggerRef.current = trigger
        startRename({
          kind: 'session',
          id: target.id,
          title: target.title,
          workspaceId: target.workspaceId,
        })
      }}
      onMove={moveSession}
    />
  )

  const renderWorkspaceCard = (workspace: WorkspaceSummary): ReactElement => (
    <WorkspaceCard
      key={workspace.id}
      workspace={workspace}
      selected={workspace.id === selectedWorkspaceKey}
      sorting={sorting}
      sessionCount={
        archiveFilter === 'archived'
          ? props.archivedSessions.filter(
              (session) =>
                session.workspaceId === workspace.id || workspace.sessionIds?.includes(session.id) === true,
            ).length
          : workspaceSessions(workspace).length
      }
      busy={mutationBusy}
      onSelect={(target) => {
        setSelectedWorkspaceId(target.id)
        setWorkspaceDisplay('current')
      }}
      onRename={(target, trigger) => {
        dialogTriggerRef.current = trigger
        startRename({ kind: 'workspace', id: target.id, title: target.name })
      }}
      onRemove={(target, trigger) => {
        dialogTriggerRef.current = trigger
        setRemoveError(undefined)
        setRemoveWorkspace(target)
      }}
      onMove={moveWorkspace}
    />
  )

  const renderContentSearchResults = (): ReactElement | null => {
    if (contentSearchResults.length === 0) return null
    return (
      <>
        <p className="dsh-session-switcher__group-label">{t('sessions.contentMatches')}</p>
        <ul className="dsh-session-switcher__list" aria-label={t('sessions.otherMatches')}>
          {contentSearchResults.map((session) => {
            const workspace = visibleWorkspaces.find((candidate) => candidate.id === session.workspaceId)
            return renderSessionRow(
              session,
              workspace === undefined ? undefined : displayWorkspaceName(workspace.name),
            )
          })}
        </ul>
      </>
    )
  }

  const renameConflict = renameConflictFor({
    target: renameTarget,
    draft: renameDraft,
    sessions: props.sessions,
    workspaces: props.workspaces,
    t,
  })

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
          ref={triggerRef}
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
          onClick={() => {
            setMoveError(undefined)
            setOpen((current) => !current)
          }}
        >
          <span className="dsh-session-switcher__icon" aria-hidden="true">
            <Icon name="session" />
          </span>
          <span className="dsh-session-switcher__trigger-label">
            {activeSession === undefined
              ? activeWorkspace === undefined
                ? t('sessions.open')
                : displayWorkspaceName(activeWorkspace.name)
              : displaySessionTitle(activeSession.title, t)}
          </span>
          <span className="dsh-session-switcher__chevron" aria-hidden="true">
            <Icon name="chevron-down" />
          </span>
        </button>
      ) : null}
      {open ? (
        <PopoverCard
          ref={panelRef}
          id={panelId}
          className="dsh-session-switcher__panel"
          role="dialog"
          aria-label={t('sessions.title')}
          tabIndex={-1}
        >
          <header className="dsh-session-switcher__panel-header">
            <span
              className="dsh-session-switcher__panel-title"
              title={
                selectedWorkspace === undefined
                  ? t('sessions.title')
                  : displayWorkspaceName(selectedWorkspace.name)
              }
            >
              {selectedWorkspace === undefined
                ? t('sessions.title')
                : displayWorkspaceName(selectedWorkspace.name)}
            </span>
            <div className="dsh-session-switcher__panel-actions">
              <button
                className="dsh-icon-button"
                type="button"
                aria-label={t('sessions.addWorkspace')}
                title={t('sessions.addWorkspace')}
                disabled={mutationBusy}
                onClick={() => {
                  setMutationBusy(true)
                  setMoveError(undefined)
                  void props
                    .onAddWorkspace()
                    .catch((reason: unknown) =>
                      setMoveError(
                        reason instanceof Error ? reason.message : t('sessions.addWorkspaceFailed'),
                      ),
                    )
                    .finally(() => setMutationBusy(false))
                }}
              >
                <Icon name="folder" />
                <span>+</span>
              </button>
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
          <div className="dsh-session-switcher__search">
            <input
              type="search"
              value={searchQuery}
              placeholder={t('sessions.search')}
              aria-label={t('sessions.searchAria')}
              maxLength={SEARCH_QUERY_MAX_CODE_UNITS}
              onChange={(event) => setSearchQuery(sanitizeSearchQuery(event.target.value))}
            />
            <SelectMenu
              className="dsh-session-switcher__archive-filter"
              icon="box"
              label={t(`sessions.archiveFilter.${archiveFilter}`)}
              ariaLabel={t('sessions.archiveFilter')}
              title={t('sessions.archiveFilter')}
              value={archiveFilter}
              options={ARCHIVE_FILTERS.map((value) => ({
                value,
                label: t(`sessions.archiveFilter.${value}`),
              }))}
              onChange={chooseArchiveFilter}
            />
          </div>
          {archiveFilter !== 'archived' && contentSearchUnavailable ? (
            <p className="dsh-session-switcher__warning" role="status">
              {t('sessions.searchUnavailable')}
            </p>
          ) : null}
          {archiveFilter !== 'archived' && contentSearchHasMore ? (
            <p className="dsh-session-switcher__warning" role="status">
              {t('sessions.searchMore')}
            </p>
          ) : null}
          {archiveError === undefined ? null : (
            <p className="dsh-session-switcher__error" role="alert">
              {archiveError}
            </p>
          )}
          {moveError === undefined ? null : (
            <p className="dsh-session-switcher__error" role="alert">
              {moveError}
            </p>
          )}
          <div className="dsh-session-switcher__results">
            {visibleWorkspaces.length === 0 ? null : (
              <div
                role="group"
                className="dsh-session-switcher__workspaces"
                aria-label={t('sessions.workspaces')}
              >
                {visibleWorkspaces.map(renderWorkspaceCard)}
              </div>
            )}
            {archiveFilter === 'archived' ? null : selectedWorkspace === undefined && query === '' ? (
              <p className="dsh-session-switcher__empty">{t('sessions.temporary')}</p>
            ) : workspaceDisplay === 'grouped' ? (
              <>
                <div className="dsh-session-switcher__groups">
                  {groupedWorkspaceSessions.map(({ workspace, sessions: groupSessions }) => (
                    <section
                      className="dsh-session-switcher__group"
                      key={workspace.id}
                      aria-labelledby={`workspace-${workspace.id}`}
                    >
                      <header className="dsh-session-switcher__group-header">
                        <strong id={`workspace-${workspace.id}`}>
                          {displayWorkspaceName(workspace.name)}
                        </strong>
                        <span>{workspaceSessions(workspace).length}</span>
                      </header>
                      {groupSessions.length === 0 ? (
                        <p className="dsh-session-switcher__empty">
                          {query === '' ? t('sessions.empty') : t('sessions.noMatch')}
                        </p>
                      ) : (
                        <ul
                          className="dsh-session-switcher__list"
                          aria-label={displayWorkspaceName(workspace.name)}
                        >
                          {groupSessions.map((session) => renderSessionRow(session, undefined, workspace.id))}
                        </ul>
                      )}
                    </section>
                  ))}
                </div>
                {renderContentSearchResults()}
              </>
            ) : currentWorkspaceSessions.length === 0 && contentSearchResults.length === 0 ? (
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
                {renderContentSearchResults()}
              </>
            )}
            {archiveFilter === 'hide' ? null : (
              <section className="dsh-session-switcher__archived" aria-label={t('sessions.archived')}>
                <button
                  className="dsh-session-switcher__archived-toggle"
                  type="button"
                  aria-expanded={archivedOpen}
                  disabled={archiveFilter === 'archived'}
                  onClick={() => setArchivedOpen((current) => !current)}
                >
                  <Icon name="box" />
                  <span className="dsh-session-switcher__archived-label">{t('sessions.archived')}</span>
                  {archivedSessionsToShow.length === 0 ? null : (
                    <small className="dsh-session-switcher__archived-count">
                      {archivedSessionsToShow.length}
                    </small>
                  )}
                  <span className="dsh-session-switcher__chevron" aria-hidden="true">
                    <Icon name="chevron-down" />
                  </span>
                </button>
                {archivedOpen ? (
                  <div className="dsh-session-switcher__archived-body">
                    {archivedError === undefined ? null : (
                      <p className="dsh-session-switcher__error" role="alert">
                        {archivedError}
                      </p>
                    )}
                    {archivedLoading ? (
                      <p className="dsh-session-switcher__empty">{t('sessions.archivedLoading')}</p>
                    ) : filteredArchivedSessions.length === 0 ? (
                      <p className="dsh-session-switcher__empty">{t('sessions.archivedEmpty')}</p>
                    ) : (
                      <ul className="dsh-session-switcher__list" aria-label={t('sessions.archived')}>
                        {filteredArchivedSessions.map((session) => {
                          const title = displaySessionTitle(session.title, t)
                          const workspace = props.workspaces.find(
                            (candidate) => candidate.id === session.workspaceId,
                          )
                          const workspaceName =
                            workspace === undefined ? undefined : displayWorkspaceName(workspace.name)
                          return (
                            <li
                              key={session.id}
                              className="dsh-session-item"
                              aria-busy={restoringSessionId === session.id}
                            >
                              <span className="dsh-session-item__copy">
                                <strong title={title}>{title}</strong>
                                {workspaceName === undefined ? null : (
                                  <span className="dsh-session-item__workspace" title={workspaceName}>
                                    {workspaceName}
                                  </span>
                                )}
                              </span>
                              <div className="dsh-session-item__actions">
                                <button
                                  className="dsh-icon-button"
                                  type="button"
                                  aria-label={t('sessions.restore', { title })}
                                  title={t(
                                    props.canRestoreSessions === true
                                      ? 'sessions.restoreTitle'
                                      : 'sessions.restoreUnavailable',
                                  )}
                                  disabled={
                                    props.canRestoreSessions !== true ||
                                    mutationBusy ||
                                    restoringSessionId !== undefined
                                  }
                                  onClick={() => restoreArchivedSession(session)}
                                >
                                  <Icon name="refresh" />
                                </button>
                                <button
                                  className="dsh-icon-button"
                                  type="button"
                                  aria-label={t('sessions.delete', { title })}
                                  title={t('sessions.deleteUnavailable')}
                                  disabled
                                  onClick={(event) => {
                                    dialogTriggerRef.current = event.currentTarget
                                    setDeleteError(undefined)
                                    setDeleteTarget(session)
                                  }}
                                >
                                  <Icon name="trash" />
                                </button>
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                ) : null}
              </section>
            )}
          </div>
        </PopoverCard>
      ) : null}
      {renameTarget === undefined || typeof document === 'undefined'
        ? null
        : createPortal(
            <RenameDialog
              target={renameTarget}
              draft={renameDraft}
              conflict={renameConflict}
              error={renameError}
              busy={mutationBusy}
              dialogId={renameDialogId}
              dialogRef={renameDialogRef}
              inputRef={renameInputRef}
              onDraftChange={setRenameDraft}
              onCancel={closeRenameDialog}
              onSubmit={submitRename}
            />,
            document.body,
          )}
      {removeWorkspace === undefined || typeof document === 'undefined'
        ? null
        : createPortal(
            <RemoveWorkspaceDialog
              name={displayWorkspaceName(removeWorkspace.name)}
              sessionCount={removeWorkspace.sessionCount}
              error={removeError}
              busy={mutationBusy}
              titleId={`${panelId}-remove-title`}
              dialogRef={removeDialogRef}
              onCancel={closeRemoveDialog}
              onConfirm={confirmRemoveWorkspace}
            />,
            document.body,
          )}
      {deleteTarget === undefined || typeof document === 'undefined'
        ? null
        : createPortal(
            <DeleteSessionDialog
              title={displaySessionTitle(deleteTarget.title, t)}
              error={deleteError}
              busy={mutationBusy}
              titleId={`${panelId}-delete-title`}
              dialogRef={deleteDialogRef}
              onCancel={closeDeleteDialog}
              onConfirm={confirmDeleteSession}
            />,
            document.body,
          )}
    </section>
  )
})
