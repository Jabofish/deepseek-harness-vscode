import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import type {
  AgentConfiguration,
  ContextPressure,
  ModelDescriptor,
  PromptAttachment,
  SessionSummary,
  SessionStatsProjection,
  TokenUsage,
} from '@dsh-vscode/domain'
import { cacheHitRate } from '@dsh-vscode/timeline'
import { EmptyState } from '@dsh-vscode/ui'
import { Composer } from './features/composer/Composer.js'
import { ExportDialog } from './features/export/ExportDialog.js'
import { AppErrorBoundary } from './features/errors/AppErrorBoundary.js'
import { Timeline } from './features/chat/Timeline.js'
import { StatsLine } from './features/chat/StatsLine.js'
import { ApprovalCard } from './features/interactions/ApprovalCard.js'
import { UserQuestionCard } from './features/interactions/UserQuestionCard.js'
import { GoalTodoStrip } from './features/goals/GoalTodoStrip.js'
import { TodoList } from './features/goals/TodoList.js'
import { JobsDrawer } from './features/jobs/JobsDrawer.js'
import { QueuePanel } from './features/input/QueuePanel.js'
import { RuntimeMissingView } from './features/runtime/RuntimeMissingView.js'
import { SessionDrawer } from './features/sessions/SessionDrawer.js'
import { SubagentDrawer } from './features/subagents/SubagentDrawer.js'
import { SettingsDrawer } from './features/settings/SettingsDrawer.js'
import { TrajectoryView } from './features/trajectory/TrajectoryView.js'
import { createAppStore, type OpenFileCandidate } from './app/store.js'
import { useI18n, type Translate } from './i18n.js'
import { Icon } from './ui/Icon.js'
import { hasVsCodeApi } from './vscode-api.js'

export function App(): ReactElement {
  const { locale, setLocale, t } = useI18n()
  const store = useMemo(() => createAppStore(), [])
  const state = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState(),
    () => store.getState(),
  )
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<PromptAttachment[]>([])
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({})
  const [openFileCandidates, setOpenFileCandidates] = useState<readonly OpenFileCandidate[]>([])
  const [openFilePickerOpen, setOpenFilePickerOpen] = useState(false)
  const [openFilePickerLoading, setOpenFilePickerLoading] = useState(false)
  const [attachingOpenFileId, setAttachingOpenFileId] = useState<string | undefined>()
  const [openFileAttachmentIds, setOpenFileAttachmentIds] = useState<Record<string, string>>({})
  const attachingOpenFileRef = useRef<string | undefined>(undefined)
  const attachmentGenerationRef = useRef(0)
  const [busyAction, setBusyAction] = useState<'install' | 'select' | undefined>()
  const [respondingInteractionId, setRespondingInteractionId] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [dismissedConnection, setDismissedConnection] = useState<string | undefined>()
  const [modelPickerOpenRequest, setModelPickerOpenRequest] = useState(0)
  const [conversationView, setConversationView] = useState<'chat' | 'trajectory'>('chat')
  const [exportOpen, setExportOpen] = useState(false)
  const [localeOpen, setLocaleOpen] = useState(false)
  const localeControlRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!hasVsCodeApi()) return
    void store
      .initialize()
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.initialize')),
      )
    return () => store.dispose()
    // t is stable per locale; re-running initialize on a locale change would
    // dispose the store while the view is still mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  useEffect(() => {
    if (error === undefined) return
    const timer = window.setTimeout(() => setError(undefined), 8_000)
    return () => window.clearTimeout(timer)
  }, [error])

  useEffect(() => {
    if (!localeOpen) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setLocaleOpen(false)
    }
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!localeControlRef.current?.contains(event.target as Node)) setLocaleOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    window.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => {
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('pointerdown', closeOnOutsidePointer)
    }
  }, [localeOpen])

  useEffect(() => {
    const missing = attachments.filter(
      (attachment) =>
        attachment.mimeType?.startsWith('image/') === true &&
        attachmentPreviews[attachment.uri] === undefined,
    )
    if (missing.length === 0) return
    let cancelled = false
    for (const attachment of missing) {
      void store
        .previewAttachment(attachment.uri)
        .then((dataUri) => {
          if (!cancelled && dataUri !== undefined)
            setAttachmentPreviews((current) => ({ ...current, [attachment.uri]: dataUri }))
        })
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
    }
  }, [attachments, attachmentPreviews, store])

  const backend = state.backend
  const connectionMessage =
    backend.kind === 'failed' || backend.kind === 'port-conflict' ? backend.message : undefined
  const connectionKey = connectionMessage === undefined ? undefined : `${backend.kind}:${connectionMessage}`

  useEffect(() => {
    if (connectionKey === undefined) return
    const timer = window.setTimeout(() => setDismissedConnection(connectionKey), 10_000)
    return () => window.clearTimeout(timer)
  }, [connectionKey])

  const runRuntimeAction = (action: 'install' | 'select' | 'copy-command' | 'open-docs'): void => {
    if (action === 'install' || action === 'select') setBusyAction(action)
    void store
      .runtimeAction(action)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.runtimeAction')),
      )
      .finally(() => setBusyAction(undefined))
  }
  if (backend.kind === 'runtime-missing')
    return (
      <AppErrorBoundary>
        <RuntimeMissingView
          searchedLocations={backend.searchedLocations}
          busyAction={busyAction}
          onAction={runRuntimeAction}
          onRetry={() => {
            void store
              .reconnect()
              .catch((reason: unknown) =>
                setError(reason instanceof Error ? reason.message : t('app.error.reconnect')),
              )
          }}
        />
      </AppErrorBoundary>
    )

  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId)
  let activeSubagentState = state.activeSubagent
  if (activeSubagentState?.entry.id !== state.activeSessionId) activeSubagentState = undefined
  const activeSubagent = activeSubagentState?.entry
  const active: SessionSummary | undefined =
    activeSession ??
    (activeSubagent === undefined
      ? undefined
      : {
          id: activeSubagent.id,
          workspaceId: activeSubagentState?.workspaceId ?? '',
          title: activeSubagent.label?.trim() || t('subagents.unnamed'),
          blank: false,
          status: activeSubagent.activity === 'running' ? 'running' : 'idle',
          createdAt: '',
          updatedAt: '',
        })
  const pendingPermissions =
    active === undefined ? [] : state.permissions.filter((request) => request.sessionId === active.id)
  const pendingQuestions =
    active === undefined ? [] : state.questions.filter((question) => question.sessionId === active.id)
  const assistantLabel = resolveAssistantModelLabel(active, state.configuration, state.models, t)
  const activeProjection = active === undefined ? undefined : state.projections[active.id]
  const contextPressure = readContextPressure(activeProjection?.contextPressure)
  const estimatedContextTokens = contextPressure?.projectedTokens ?? contextPressure?.pressureTokens
  const contextWindowTokens = contextPressure?.contextWindow
  const projectedTokenUsage = readTokenUsageProjection(activeProjection?.tokenUsage)
  const sessionStats = readSessionStatsProjection(activeProjection?.sessionStats)
  const streaming = state.timeline.nodes.some(
    (node) =>
      (node.kind === 'assistant-message' && (node.streaming || node.reasoning?.streaming === true)) ||
      (node.kind === 'reasoning' && node.streaming),
  )
  const activeRunning =
    activeSubagent === undefined ? active?.status === 'running' : activeSubagent.activity === 'running'
  const subagentReadOnlyReason =
    activeSubagent?.mode === 'one-shot'
      ? 'oneShot'
      : activeSubagent !== undefined && activeSubagentState?.parentAvailable === false && !activeRunning
        ? 'parent'
        : undefined
  const appendAttachment = (
    attachment: PromptAttachment,
    openFileId?: string,
    generation = attachmentGenerationRef.current,
  ): void => {
    if (generation !== attachmentGenerationRef.current) {
      void store.releaseAttachments([attachment.uri]).catch(() => undefined)
      return
    }
    setAttachments((current) =>
      current.some((item) => item.uri === attachment.uri) ? current : [...current, attachment],
    )
    if (openFileId !== undefined)
      setOpenFileAttachmentIds((current) => ({ ...current, [attachment.uri]: openFileId }))
  }
  const removeAttachmentDrafts = (uris: readonly string[], release: boolean): void => {
    if (uris.length === 0) return
    const removed = new Set(uris)
    setAttachments((current) => current.filter((attachment) => !removed.has(attachment.uri)))
    setAttachmentPreviews((current) =>
      Object.fromEntries(Object.entries(current).filter(([uri]) => !removed.has(uri))),
    )
    setOpenFileAttachmentIds((current) =>
      Object.fromEntries(Object.entries(current).filter(([uri]) => !removed.has(uri))),
    )
    if (release)
      void store
        .releaseAttachments(uris)
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : t('app.error.releaseAttachment')),
        )
  }
  const discardAttachmentDrafts = (): void => {
    attachmentGenerationRef.current += 1
    removeAttachmentDrafts(
      attachments.map((attachment) => attachment.uri),
      true,
    )
    setOpenFilePickerOpen(false)
  }
  const ingestFiles = (files: readonly File[]): void => {
    const generation = attachmentGenerationRef.current
    for (const file of files) {
      void readFileAsBase64(file, t)
        .then((payload) => store.ingestAttachment(payload))
        .then((attachment) => {
          if (attachment !== undefined) appendAttachment(attachment, undefined, generation)
        })
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : t('app.error.attachPasted')),
        )
    }
  }
  const submitPrompt = (mode: 'queue' | 'steer'): void => {
    if (active === undefined) return
    const text = draft
    const attachmentSnapshot = attachments
    void store
      .sendPrompt(active.id, text, attachmentSnapshot, mode)
      .then(() => {
        setDraft((current) => (current === text ? '' : current))
        // The Extension Host consumes only the handles admitted by this send;
        // keep any draft attachments the user added while it was in flight.
        removeAttachmentDrafts(
          attachmentSnapshot.map((attachment) => attachment.uri),
          false,
        )
        setOpenFilePickerOpen(false)
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t('app.error.prompt')))
  }
  const toggleOpenFilePicker = (): void => {
    if (openFilePickerOpen) {
      setOpenFilePickerOpen(false)
      return
    }
    setOpenFilePickerOpen(true)
    setOpenFilePickerLoading(true)
    void store
      .listOpenFiles()
      .then(setOpenFileCandidates)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.listOpenFiles')),
      )
      .finally(() => setOpenFilePickerLoading(false))
  }
  const selectOpenFile = (candidateId: string): void => {
    if (
      attachingOpenFileRef.current !== undefined ||
      attachingOpenFileId !== undefined ||
      Object.values(openFileAttachmentIds).some((id) => id === candidateId)
    )
      return
    attachingOpenFileRef.current = candidateId
    setAttachingOpenFileId(candidateId)
    const generation = attachmentGenerationRef.current
    void store
      .attachOpenFile(candidateId)
      .then((attachment) => {
        if (attachment === undefined) {
          setError(t('app.error.openFileGone'))
          return
        }
        store.rememberOpenFile(candidateId)
        appendAttachment(attachment, candidateId, generation)
        setOpenFilePickerOpen(false)
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.attachSelectedFile')),
      )
      .finally(() => {
        attachingOpenFileRef.current = undefined
        setAttachingOpenFileId(undefined)
      })
  }
  return (
    <AppErrorBoundary>
      <main className="dsh-app">
        <div className="dsh-app__session-drawer-anchor">
          <SessionDrawer
            sessions={state.sessions}
            workspaces={state.workspaces}
            activeSessionId={state.activeSessionId}
            open={state.drawer === 'sessions'}
            showTrigger={false}
            onOpenChange={(open) => store.setDrawer(open ? 'sessions' : undefined)}
            onOpen={(sessionId) => {
              discardAttachmentDrafts()
              void store
                .openSession(sessionId)
                .catch((reason: unknown) =>
                  setError(reason instanceof Error ? reason.message : t('app.error.openSession')),
                )
            }}
            onCreate={(workspaceId) => {
              void store
                .createSession(workspaceId)
                .catch((reason: unknown) =>
                  setError(reason instanceof Error ? reason.message : t('app.error.createSession')),
                )
            }}
            onArchive={(sessionId) =>
              store.removeSession(sessionId).catch((reason: unknown) => {
                const message = reason instanceof Error ? reason.message : t('app.error.archiveSession')
                setError(message)
                throw reason
              })
            }
            onSearch={(query) => store.searchSessions(query)}
          />
        </div>
        <SettingsDrawer
          open={state.drawer === 'settings'}
          onOpenChange={(open) => store.setDrawer(open ? 'settings' : undefined)}
          connected={backend.kind === 'connected'}
          connectedDshVersion={state.connectedDshVersion}
          providers={state.providers}
          models={state.models}
          onLoadSettings={() => store.readSettings()}
          onLoadDshSettings={() => store.readDshSettings()}
          onUpdateDshSetting={(path, value) => store.updateDshSetting(path, value)}
          onConfigureSecret={(providerId, field) => store.configureProviderSecret(providerId, field)}
          onRemoveSecret={(providerId, field) => store.removeProviderSecret(providerId, field)}
          onRefreshCatalog={() => store.refreshModelCatalog()}
          onLoadPresetRoster={() => store.loadPresetRoster()}
          onReadPresetDocument={(presetId) => store.readPresetDocument(presetId)}
          onCopyPreset={(from, presetId, name) => store.copyPreset(from, presetId, name)}
          onRemovePreset={(presetId) => store.removePreset(presetId)}
          onOpenPresetDocument={(presetId) => store.openPresetDocument(presetId)}
          onLoadPluginInventory={() => store.loadPluginInventory()}
        />
        {error === undefined ? null : (
          <div className="dsh-app__error" role="alert">
            <span>{error}</span>
            <button
              className="dsh-icon-button"
              type="button"
              aria-label={t('app.dismissError')}
              title={t('app.dismissError')}
              onClick={() => setError(undefined)}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        {connectionMessage === undefined || connectionKey === dismissedConnection ? null : (
          <div className="dsh-app__connection-alert" role="alert">
            <div>
              <strong>
                {backend.kind === 'port-conflict' ? t('app.portConflict') : t('app.connectionFailed')}
              </strong>
              <span>{connectionMessage}</span>
            </div>
            <button
              className="dsh-icon-button"
              type="button"
              aria-label={t('app.dismissConnectionError')}
              title={t('app.dismissConnectionError')}
              onClick={() => setDismissedConnection(connectionKey)}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        <section className="dsh-app__body">
          {active === undefined ? (
            <div className="dsh-app__empty">
              <EmptyState
                title={t('app.noActiveSession')}
                description={state.sessions.length === 0 ? t('app.createSession') : t('app.chooseSession')}
              />
            </div>
          ) : (
            <section
              className="dsh-conversation"
              aria-label={active.title.trim() === '' ? t('app.conversation') : active.title}
            >
              <div className="dsh-conversation__popovers">
                {/* The keys reset popover state when the last entry disappears,
                    so a refilled catalog never reopens stale. */}
                <JobsDrawer key={state.jobs.length > 0 ? 'jobs' : 'jobs-empty'} jobs={state.jobs} />
                <SubagentDrawer
                  key={active.id}
                  parentSessionId={active.id}
                  catalog={state.subagents}
                  onLoadChildren={(sessionId) => store.loadSubagentChildren(sessionId)}
                  onOpenChild={(entry, parentAvailable) => {
                    // subagent.prompt accepts text ContentBlocks only. Clear
                    // ordinary-session attachment handles at navigation time.
                    discardAttachmentDrafts()
                    void store
                      .openSubagent(entry, parentAvailable)
                      .catch((reason: unknown) =>
                        setError(reason instanceof Error ? reason.message : t('app.error.openSubagent')),
                      )
                  }}
                />
                {activeSubagent === undefined ? (
                  <button
                    type="button"
                    className="dsh-conversation__export-trigger"
                    aria-expanded={exportOpen}
                    onClick={() => setExportOpen((current) => !current)}
                  >
                    {t('export.trigger')}
                  </button>
                ) : null}
                <span ref={localeControlRef} className="dsh-conversation__locale-control">
                  <button
                    type="button"
                    className="dsh-conversation__locale-switch"
                    aria-label={t('locale.label')}
                    title={t('locale.label')}
                    aria-haspopup="listbox"
                    aria-expanded={localeOpen}
                    onClick={() => setLocaleOpen((current) => !current)}
                  >
                    <span>{locale === 'zh' ? t('locale.chinese') : t('locale.english')}</span>
                    <Icon name="chevron-down" />
                  </button>
                  {localeOpen ? (
                    <div
                      className="dsh-conversation__locale-menu"
                      role="listbox"
                      aria-label={t('locale.label')}
                    >
                      {(['en', 'zh'] as const).map((option) => (
                        <button
                          key={option}
                          type="button"
                          role="option"
                          aria-selected={locale === option}
                          className={`dsh-conversation__locale-option${
                            locale === option ? ' dsh-conversation__locale-option--selected' : ''
                          }`}
                          onClick={() => {
                            setLocale(option)
                            setLocaleOpen(false)
                          }}
                        >
                          {option === 'zh' ? t('locale.chinese') : t('locale.english')}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </span>
              </div>
              {exportOpen && activeSubagent === undefined ? (
                <ExportDialog
                  sessionId={active.id}
                  onExport={(options) => {
                    setExportOpen(false)
                    void store
                      .exportSession(options)
                      .catch((reason: unknown) =>
                        setError(reason instanceof Error ? reason.message : t('export.failed')),
                      )
                  }}
                />
              ) : null}
              {state.goals.length > 0 ? <GoalTodoStrip goals={state.goals} /> : null}
              <div className="dsh-conversation__views" role="tablist" aria-label={t('app.conversationView')}>
                <button
                  className={`dsh-conversation__view-tab${
                    conversationView === 'chat' ? ' dsh-conversation__view-tab--active' : ''
                  }`}
                  type="button"
                  role="tab"
                  aria-selected={conversationView === 'chat'}
                  onClick={() => setConversationView('chat')}
                >
                  {t('app.chat')}
                </button>
                <button
                  className={`dsh-conversation__view-tab${
                    conversationView === 'trajectory' ? ' dsh-conversation__view-tab--active' : ''
                  }`}
                  type="button"
                  role="tab"
                  aria-selected={conversationView === 'trajectory'}
                  onClick={() => setConversationView('trajectory')}
                >
                  {t('app.trajectory')}
                </button>
              </div>
              {conversationView === 'chat' ? (
                <Timeline
                  sessionId={active.id}
                  nodes={state.timeline.nodes}
                  streaming={streaming}
                  assistantLabel={assistantLabel}
                  onOpenLink={(href) => {
                    void store
                      .openLink(href)
                      .catch((reason: unknown) =>
                        setError(reason instanceof Error ? reason.message : t('app.error.openLink')),
                      )
                  }}
                  onOpenSession={(sessionId) => {
                    discardAttachmentDrafts()
                    void store
                      .openSession(sessionId)
                      .catch((reason: unknown) =>
                        setError(reason instanceof Error ? reason.message : t('app.error.openSession')),
                      )
                  }}
                />
              ) : (
                <TrajectoryView sessionId={active.id} nodes={state.timeline.nodes} streaming={streaming} />
              )}
              {state.queue.length === 0 ? null : (
                <QueuePanel
                  items={state.queue}
                  onEdit={(inputId, text) => {
                    void store
                      .updateQueue(inputId, text)
                      .catch((reason: unknown) =>
                        setError(reason instanceof Error ? reason.message : t('app.error.editQueue')),
                      )
                  }}
                  onRemove={(inputId) => {
                    void store
                      .removeQueue(inputId)
                      .catch((reason: unknown) =>
                        setError(reason instanceof Error ? reason.message : t('app.error.removeQueue')),
                      )
                  }}
                  onModeChange={(inputId, mode) => {
                    if (mode !== 'steer') return
                    void store
                      .steerQueue(inputId)
                      .catch((reason: unknown) =>
                        setError(reason instanceof Error ? reason.message : t('app.error.steerQueue')),
                      )
                  }}
                />
              )}
              <div className="dsh-compose-area">
                <TodoList todos={state.todos} />
                <StatsLine
                  nodes={state.timeline.nodes}
                  usage={projectedTokenUsage ?? state.timeline.tokenUsage}
                  cacheHit={cacheHitRate(projectedTokenUsage ?? state.timeline.tokenUsage)}
                  {...(sessionStats === undefined ? {} : { sessionStats })}
                />
                {pendingPermissions.length === 0 && pendingQuestions.length === 0 ? (
                  subagentReadOnlyReason === undefined ? (
                    <Composer
                      disabled={backend.kind !== 'connected'}
                      inputDisabled={
                        activeSubagent !== undefined && activeSubagentState?.parentAvailable === false
                      }
                      attachmentsDisabled={activeSubagent !== undefined}
                      running={activeRunning}
                      draft={draft}
                      attachments={attachments}
                      configuration={state.configuration}
                      models={state.models}
                      presets={state.presets}
                      permissionPresets={state.permissionPresets}
                      commands={state.commands}
                      busyEnter={state.busyEnter}
                      modelPickerOpenRequest={modelPickerOpenRequest}
                      {...(estimatedContextTokens === undefined ? {} : { estimatedContextTokens })}
                      {...(contextWindowTokens === undefined ? {} : { contextWindowTokens })}
                      configurationDisabled={backend.kind !== 'connected' || activeRunning}
                      presetMutable={activeSubagent === undefined && active.status === 'idle'}
                      onConfigurationChange={(configuration) => {
                        void store
                          .configureSession(active.id, configuration)
                          .catch((reason: unknown) =>
                            setError(
                              reason instanceof Error ? reason.message : t('app.error.sessionSettings'),
                            ),
                          )
                      }}
                      onCommand={(command) => {
                        if (command.trim() === '/model') {
                          setModelPickerOpenRequest((current) => current + 1)
                          return
                        }
                        void store
                          .executeCommand(active.id, command)
                          .catch((reason: unknown) =>
                            setError(reason instanceof Error ? reason.message : t('app.error.dshMode')),
                          )
                      }}
                      onCommandQueryChange={(query) => {
                        if (query === undefined || state.commands.length > 0) return
                        void store.refreshCommands(active.id)
                      }}
                      onDraftChange={setDraft}
                      onPickAttachment={() => {
                        const generation = attachmentGenerationRef.current
                        void store
                          .pickAttachment()
                          .then((attachment) => {
                            if (attachment !== undefined) appendAttachment(attachment, undefined, generation)
                          })
                          .catch((reason: unknown) =>
                            setError(
                              reason instanceof Error ? reason.message : t('app.error.attachmentSelection'),
                            ),
                          )
                      }}
                      onIngestFiles={ingestFiles}
                      attachmentPreviews={attachmentPreviews}
                      openFileCandidates={openFileCandidates}
                      openFilePickerOpen={openFilePickerOpen}
                      openFilePickerLoading={openFilePickerLoading}
                      {...(state.preferredOpenFileId === undefined
                        ? {}
                        : { preferredOpenFileId: state.preferredOpenFileId })}
                      attachedOpenFileIds={Object.values(openFileAttachmentIds)}
                      {...(attachingOpenFileId === undefined ? {} : { attachingOpenFileId })}
                      onToggleOpenFilePicker={toggleOpenFilePicker}
                      onSelectOpenFile={selectOpenFile}
                      onRemoveAttachment={(uri) => {
                        removeAttachmentDrafts([uri], true)
                      }}
                      onSubmit={submitPrompt}
                      onCancel={() => {
                        void store
                          .cancelSession(active.id)
                          .catch((reason: unknown) =>
                            setError(reason instanceof Error ? reason.message : t('app.error.cancel')),
                          )
                      }}
                      onSteerQueue={() => {
                        void store
                          .steerAllQueued()
                          .catch((reason: unknown) =>
                            setError(reason instanceof Error ? reason.message : t('app.error.steerAll')),
                          )
                      }}
                      queue={state.queue}
                    />
                  ) : (
                    <div className="dsh-subagent-readonly" role="status">
                      <strong>{t('subagents.readOnly.title')}</strong>
                      <span>
                        {t(
                          subagentReadOnlyReason === 'oneShot'
                            ? 'subagents.readOnly.oneShot'
                            : 'subagents.readOnly.parent',
                        )}
                      </span>
                    </div>
                  )
                ) : (
                  <div className="dsh-compose-area__interactions" aria-live="polite">
                    {pendingPermissions.map((request) => (
                      <ApprovalCard
                        key={request.id}
                        request={request}
                        disabled={respondingInteractionId !== undefined}
                        onRespond={(optionId) => {
                          setRespondingInteractionId(request.id)
                          void store
                            .respondToPermission(request.id, optionId)
                            .catch((reason: unknown) =>
                              setError(
                                reason instanceof Error ? reason.message : t('app.error.answerApproval'),
                              ),
                            )
                            .finally(() => setRespondingInteractionId(undefined))
                        }}
                      />
                    ))}
                    {pendingQuestions.map((question) => (
                      <UserQuestionCard
                        key={question.id}
                        question={question}
                        disabled={respondingInteractionId !== undefined}
                        onRespond={(response) => {
                          setRespondingInteractionId(question.id)
                          void store
                            .respondToQuestion(question.id, response)
                            .catch((reason: unknown) =>
                              setError(
                                reason instanceof Error ? reason.message : t('app.error.answerQuestion'),
                              ),
                            )
                            .finally(() => setRespondingInteractionId(undefined))
                        }}
                        onCancel={() => {
                          setRespondingInteractionId(question.id)
                          void store
                            .cancelQuestion(question.id)
                            .catch((reason: unknown) =>
                              setError(
                                reason instanceof Error ? reason.message : t('app.error.cancelQuestion'),
                              ),
                            )
                            .finally(() => setRespondingInteractionId(undefined))
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}
        </section>
      </main>
    </AppErrorBoundary>
  )
}

function readContextPressure(value: unknown): ContextPressure | undefined {
  const record = object(value)
  if (record === undefined) return undefined
  const pressureTokens = nonNegativeTokenCount(record.pressureTokens)
  const projectedTokens = nonNegativeTokenCount(record.projectedTokens)
  const contextWindow = positiveTokenCount(record.contextWindow)
  if (pressureTokens === undefined && projectedTokens === undefined && contextWindow === undefined)
    return undefined
  return {
    ...(pressureTokens === undefined ? {} : { pressureTokens }),
    ...(projectedTokens === undefined ? {} : { projectedTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  }
}

function readTokenUsageProjection(value: unknown): TokenUsage | undefined {
  const record = object(value)
  if (record === undefined) return undefined
  const inputTokens = nonNegativeTokenCount(record.uncachedInputTokens ?? record.inputTokens)
  const outputTokens = nonNegativeTokenCount(record.outputTokens)
  const cacheReadTokens = nonNegativeTokenCount(record.cacheReadTokens)
  const cacheWriteTokens = nonNegativeTokenCount(record.cacheWriteTokens)
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined
  )
    return undefined
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  }
}

function readSessionStatsProjection(value: unknown): SessionStatsProjection | undefined {
  const record = object(value)
  if (record === undefined) return undefined
  const turns = nonNegativeTokenCount(record.turns)
  const steps = nonNegativeTokenCount(record.steps)
  const ttftSteps = nonNegativeTokenCount(record.ttftSteps)
  const llmMs = nonNegativeMetric(record.llmMs)
  const toolMs = nonNegativeMetric(record.toolMs)
  const ttftMs = nonNegativeMetric(record.ttftMs)
  const decodeMs = nonNegativeMetric(record.decodeMs)
  const decodeTokens = nonNegativeMetric(record.decodeTokens)
  if (
    turns === undefined ||
    steps === undefined ||
    ttftSteps === undefined ||
    llmMs === undefined ||
    toolMs === undefined ||
    ttftMs === undefined ||
    decodeMs === undefined ||
    decodeTokens === undefined
  )
    return undefined
  return { turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readFileAsBase64(
  file: File,
  t: Translate,
): Promise<{ name: string; mimeType?: string; dataBase64: string }> {
  if (file.size === 0) return Promise.reject(new Error(t('app.error.fileEmpty', { name: file.name })))
  if (file.size > 8 * 1024 * 1024)
    return Promise.reject(new Error(t('app.error.fileTooLarge', { name: file.name })))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(t('app.error.readFile', { name: file.name })))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(result)
      const dataBase64 = match?.[2]
      if (match === null || dataBase64 === undefined || dataBase64 === '') {
        reject(new Error(t('app.error.readFile', { name: file.name })))
        return
      }
      const mimeType = file.type === '' ? (match[1] ?? 'application/octet-stream') : file.type
      resolve({ name: file.name, mimeType, dataBase64 })
    }
    reader.readAsDataURL(file)
  })
}

function nonNegativeTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function nonNegativeMetric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function positiveTokenCount(value: unknown): number | undefined {
  const count = nonNegativeTokenCount(value)
  return count === undefined || count === 0 ? undefined : count
}

function resolveAssistantModelLabel(
  session: SessionSummary | undefined,
  configuration: AgentConfiguration | undefined,
  models: readonly ModelDescriptor[],
  t: Translate,
): string {
  const selected =
    configuration === undefined
      ? undefined
      : models.find(
          (model) =>
            model.providerId === configuration.model.providerId && model.id === configuration.model.modelId,
        )
  return (
    selected?.label.trim() ||
    session?.modelLabel?.trim() ||
    configuration?.model.modelId.trim() ||
    t('timeline.assistant')
  )
}
