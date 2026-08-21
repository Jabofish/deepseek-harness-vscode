import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import type {
  AgentConfiguration,
  AgentPresetDescriptor,
  ContextPressure,
  ImageAttachmentLimits,
  ModelDescriptor,
  PromptAttachment,
  SessionSummary,
  SessionStatsProjection,
  TokenUsage,
  WorkspaceSummary,
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
import { GoalBar } from './features/goals/GoalBar.js'
import { TodoList } from './features/goals/TodoList.js'
import { JobsDrawer } from './features/jobs/JobsDrawer.js'
import { QueuePanel } from './features/input/QueuePanel.js'
import { RuntimeMissingView } from './features/runtime/RuntimeMissingView.js'
import { SessionDrawer } from './features/sessions/SessionDrawer.js'
import { SubagentDrawer } from './features/subagents/SubagentDrawer.js'
import { SettingsDrawer } from './features/settings/SettingsDrawer.js'
import { TrajectoryView } from './features/trajectory/TrajectoryView.js'
import { createAppStore, type OpenFileCandidate, type ReferenceCandidate } from './app/store.js'
import { useI18n, type Translate } from './i18n.js'
import { Icon } from './ui/Icon.js'
import { hasVsCodeApi } from './vscode-api.js'
import { PopupSelectRegistry } from './features/commands/popupSelectRegistry.js'

const WELCOME_DISMISSED_KEY = 'dsh-welcome-dismissed'
const RUNTIME_UPDATE_DISMISSED_KEY = 'dsh-runtime-update-dismissed-version'

export function App(): ReactElement {
  const { locale, setLocale, t } = useI18n()
  const store = useMemo(() => createAppStore(), [])
  const popupSelects = useMemo(() => new PopupSelectRegistry(), [])
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
  const [referenceCandidates, setReferenceCandidates] = useState<readonly ReferenceCandidate[]>([])
  const [referenceLoading, setReferenceLoading] = useState(false)
  const [referenceSessionId, setReferenceSessionId] = useState<string | undefined>()
  const [referenceQuery, setReferenceQuery] = useState('')
  const [referenceQuoted, setReferenceQuoted] = useState(false)
  const [attachingOpenFileId, setAttachingOpenFileId] = useState<string | undefined>()
  const [openFileAttachmentIds, setOpenFileAttachmentIds] = useState<Record<string, string>>({})
  const attachingOpenFileRef = useRef<string | undefined>(undefined)
  const referenceRequestRef = useRef(0)
  const attachmentGenerationRef = useRef(0)
  const [busyAction, setBusyAction] = useState<'install' | 'select' | undefined>()
  const [respondingInteractionId, setRespondingInteractionId] = useState<string | undefined>()
  const [branching, setBranching] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [welcomeVisible, setWelcomeVisible] = useState(() => !welcomeWasDismissed())
  const [dismissedRuntimeUpdateVersion, setDismissedRuntimeUpdateVersion] = useState(() =>
    dismissedRuntimeUpdateVersionFromStorage(),
  )
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
    // `/model` is a client-owned popup decoration over the host command row.
    // The command remains invisible to this decoration when the current DSH
    // session does not advertise it in `command.list`.
    return popupSelects.register({
      command: 'model',
      onOpen: () => setModelPickerOpenRequest((current) => current + 1),
    })
  }, [popupSelects])

  useEffect(() => {
    if (error === undefined) return
    const timer = window.setTimeout(() => setError(undefined), 4_000)
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
  const compatibilityWarning = state.dshCompatibilityWarning
  const runtimeUpdateVersion = state.dshUpdate?.latestVersion ?? 'unknown'
  const runtimeUpdateVisible =
    state.dshUpdate?.updateAvailable === true && dismissedRuntimeUpdateVersion !== runtimeUpdateVersion
  const connectionMessage =
    backend.kind === 'failed' || backend.kind === 'port-conflict' ? backend.message : compatibilityWarning
  const connectionKey =
    connectionMessage === undefined
      ? undefined
      : `${compatibilityWarning !== undefined ? 'compatibility-warning' : backend.kind}:${connectionMessage}`

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
  const sessionModels = state.sessionModels.length > 0 ? state.sessionModels : state.models
  const pendingPermissions =
    active === undefined ? [] : state.permissions.filter((request) => request.sessionId === active.id)
  const pendingQuestions =
    active === undefined ? [] : state.questions.filter((question) => question.sessionId === active.id)
  const assistantLabel = resolveAssistantModelLabel(active, state.configuration, sessionModels, t)
  const activeProjection = active === undefined ? undefined : state.projections[active.id]
  const imageLimits = readImageAttachmentLimits(activeProjection?.imageLimits)
  const contextPressure = readContextPressure(
    activeProjection?.contextPressure,
    activeProjection?.contextBreakdown,
  )
  const estimatedContextTokens = contextPressure?.projectedTokens ?? contextPressure?.pressureTokens
  const contextWindowTokens = contextPressure?.contextWindow
  const projectedTokenUsage = readTokenUsageProjection(activeProjection?.tokenUsage)
  const sessionStats = readSessionStatsProjection(activeProjection?.sessionStats)
  const activeRunning =
    activeSubagent === undefined ? active?.status === 'running' : activeSubagent.activity === 'running'
  const updateReferenceQuery = (query: string | undefined, quoted: boolean): void => {
    const sessionId = active?.id
    const request = ++referenceRequestRef.current
    if (sessionId === undefined || query === undefined) {
      setReferenceCandidates([])
      setReferenceLoading(false)
      setReferenceSessionId(undefined)
      setReferenceQuery('')
      setReferenceQuoted(false)
      return
    }
    setReferenceSessionId(sessionId)
    setReferenceQuery(query)
    setReferenceQuoted(quoted)
    setReferenceLoading(true)
    void store
      .listReferences(sessionId, query, quoted)
      .then((candidates) => {
        if (request === referenceRequestRef.current && store.getState().activeSessionId === sessionId)
          setReferenceCandidates(candidates)
      })
      .catch(() => {
        if (request === referenceRequestRef.current && store.getState().activeSessionId === sessionId)
          setReferenceCandidates([])
      })
      .finally(() => {
        if (request === referenceRequestRef.current && store.getState().activeSessionId === sessionId)
          setReferenceLoading(false)
      })
  }
  const localSubagentReferences: readonly ReferenceCandidate[] =
    referenceQuoted || active === undefined
      ? []
      : state.subagents.entries.flatMap((entry) => {
          if (entry.kind !== 'child') return []
          const label = entry.label?.trim() || t('subagents.unnamed')
          if (!label.toLocaleLowerCase().includes(referenceQuery.trim().toLocaleLowerCase())) return []
          return [
            {
              id: `subagent:${entry.id}`,
              kind: 'session' as const,
              sessionId: entry.id,
              label,
              description: t('composer.referenceSubagent'),
              mention: `@[${label}](dsh-session:${entry.id})`,
            },
          ]
        })
  const visibleReferenceCandidates =
    referenceSessionId === active?.id ? [...referenceCandidates, ...localSubagentReferences] : []
  const visibleReferenceLoading = referenceSessionId === active?.id && referenceLoading
  // DSH's host/session-status is the authoritative running bit. Timeline
  // nodes describe durable content, but a settled assistant step can remain
  // inside an open turn while tools or a later model step are still active.
  const streaming = activeRunning
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
    const imageFiles = files.filter((file) => file.type.startsWith('image/'))
    if (imageLimits !== undefined && imageFiles.length > 0) {
      const existingImages = attachments.filter((attachment) =>
        attachment.mimeType?.startsWith('image/'),
      ).length
      if (existingImages + imageFiles.length > imageLimits.maxImagesPerMessage) {
        setError(t('app.error.imageCount', { count: imageLimits.maxImagesPerMessage }))
        return
      }
      const unsupported = imageFiles.find((file) => !imageLimits.mediaTypes.includes(file.type))
      if (unsupported !== undefined) {
        setError(t('app.error.imageType', { name: unsupported.name }))
        return
      }
      const oversized = imageFiles.find((file) => file.size > imageLimits.maxImageBytes)
      if (oversized !== undefined) {
        setError(
          t('app.error.imageTooLarge', {
            name: oversized.name,
            size: formatByteSize(imageLimits.maxImageBytes),
          }),
        )
        return
      }
    }
    const generation = attachmentGenerationRef.current
    for (const file of files) {
      void readFileAsBase64(file, t, imageLimits)
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
  const branchSession = (atSeq: number): void => {
    if (active === undefined || activeSubagent !== undefined || branching) return
    setBranching(true)
    void store
      .forkSession(active.id, atSeq)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.forkSession')),
      )
      .finally(() => setBranching(false))
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
            onRename={(sessionId, title) => store.renameSession(sessionId, title)}
            onRenameWorkspace={(workspaceId, name) => store.renameWorkspace(workspaceId, name)}
            onRemoveWorkspace={(workspaceId) => store.removeWorkspace(workspaceId)}
            onMoveWorkspace={(workspaceId, beforeWorkspaceId) =>
              store.moveWorkspace(workspaceId, beforeWorkspaceId)
            }
            onMoveSession={(workspaceId, sessionId, beforeSessionId) =>
              store.moveSession(workspaceId, sessionId, beforeSessionId)
            }
            onSearch={(query) => store.searchSessions(query)}
          />
        </div>
        <SettingsDrawer
          open={state.drawer === 'settings'}
          onOpenChange={(open) => store.setDrawer(open ? 'settings' : undefined)}
          connected={backend.kind === 'connected'}
          connectedDshVersion={state.connectedDshVersion}
          onConfigureConnection={(mode, endpoint) => store.configureConnection(mode, endpoint)}
          dshUpdate={state.dshUpdate}
          onCheckDshUpdates={(force) => store.checkDshUpdates(force)}
          onInstallDshVersion={(version) => store.installDshVersion(version)}
          providers={state.providers}
          models={state.models}
          onLoadSettings={() => store.readSettings()}
          onLoadDshSettings={() => store.readDshSettings()}
          onOpenDshSettingsDocument={() => store.openDshSettingsDocument()}
          onUpdateDshSetting={(path, value) => store.updateDshSetting(path, value)}
          onUnsetDshSetting={(path) => store.unsetDshSetting(path)}
          onDiscoverModels={(input) => store.discoverModels(input)}
          onConfigureSecret={(providerId, field) => store.configureProviderSecret(providerId, field)}
          onRemoveSecret={(providerId, field) => store.removeProviderSecret(providerId, field)}
          onRefreshCatalog={() => store.refreshModelCatalog()}
          onLoadPresetRoster={() => store.loadPresetRoster()}
          onReadPresetDocument={(presetId) => store.readPresetDocument(presetId)}
          onCopyPreset={(from, presetId, name) => store.copyPreset(from, presetId, name)}
          onRemovePreset={(presetId) => store.removePreset(presetId)}
          onOpenPresetDocument={(presetId) => store.openPresetDocument(presetId)}
          onStartCreatorDraft={async () => {
            store.setDrawer(undefined)
            try {
              await store.createSession(undefined, 'cordis')
            } catch (reason: unknown) {
              setError(reason instanceof Error ? reason.message : t('app.error.createSession'))
            }
          }}
          onLoadPluginInventory={() => store.loadPluginInventory()}
        />
        {runtimeUpdateVisible ? (
          <div className="dsh-app__runtime-update" role="status">
            <div className="dsh-app__runtime-update-copy">
              <strong>{t('runtime.updateAvailable')}</strong>
              <span>
                {t('runtime.updateAvailableDetail', {
                  version: state.dshUpdate.latestVersion ?? '—',
                })}
              </span>
              <div className="dsh-app__runtime-update-actions">
                <button
                  className="dsh-button dsh-button--secondary dsh-button--compact"
                  type="button"
                  onClick={() => store.setDrawer('settings')}
                >
                  {t('runtime.openSettings')}
                </button>
              </div>
            </div>
            <button
              className="dsh-icon-button dsh-app__runtime-update-dismiss"
              type="button"
              aria-label={t('runtime.dismissUpdate')}
              title={t('runtime.dismissUpdate')}
              onClick={() => {
                setDismissedRuntimeUpdateVersion(runtimeUpdateVersion)
                rememberRuntimeUpdateDismissal(runtimeUpdateVersion)
              }}
            >
              <Icon name="close" />
            </button>
          </div>
        ) : null}
        {error === undefined ? null : (
          <div key={error} className="dsh-app__error dsh-toast" role="alert" aria-live="assertive">
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
          <div
            className={`dsh-app__connection-alert${compatibilityWarning === undefined ? '' : ' dsh-app__connection-alert--warning'}`}
            role="alert"
          >
            <div>
              <strong>
                {compatibilityWarning !== undefined
                  ? t('app.compatibilityWarning')
                  : backend.kind === 'port-conflict'
                    ? t('app.portConflict')
                    : t('app.connectionFailed')}
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
          {backend.kind === 'runtime-missing' ? (
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
              onOpenSettings={() => store.setDrawer('settings')}
            />
          ) : (
            <>
              {backend.kind === 'connected' &&
              active === undefined &&
              state.sessions.length === 0 &&
              welcomeVisible ? (
                <div className="dsh-welcome-notice" role="status">
                  <div>
                    <strong>{t('welcome.title')}</strong>
                    <span>{t('welcome.description')}</span>
                  </div>
                  <button
                    className="dsh-icon-button"
                    type="button"
                    aria-label={t('welcome.dismiss')}
                    title={t('welcome.dismiss')}
                    onClick={() => {
                      setWelcomeVisible(false)
                      rememberWelcomeDismissal()
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ) : null}
              {active === undefined ? (
                <div className="dsh-app__empty">
                  <EmptySessionPosture
                    workspaces={state.workspaces}
                    presets={state.presets}
                    empty={state.sessions.length === 0}
                    onCreate={(workspaceId, presetId) => {
                      void store
                        .createSession(workspaceId, presetId)
                        .catch((reason: unknown) =>
                          setError(reason instanceof Error ? reason.message : t('app.error.createSession')),
                        )
                    }}
                  />
                </div>
              ) : (
                <section
                  className="dsh-conversation"
                  aria-label={active.title.trim() === '' ? t('app.conversation') : active.title}
                >
                  <div className="dsh-conversation__topbar">
                    <div
                      className="dsh-conversation__views"
                      role="tablist"
                      aria-label={t('app.conversationView')}
                    >
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
                              setError(
                                reason instanceof Error ? reason.message : t('app.error.openSubagent'),
                              ),
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
                  {state.goals.length > 0 ? (
                    <>
                      <GoalBar
                        goals={state.goals}
                        onUpdate={(goalId, update) => store.updateGoal(goalId, update)}
                        onClear={(goalId) => store.clearGoal(goalId)}
                      />
                      <GoalTodoStrip goals={state.goals} />
                    </>
                  ) : null}
                  {conversationView === 'chat' ? (
                    <Timeline
                      sessionId={active.id}
                      nodes={state.timeline.nodes}
                      streaming={streaming}
                      running={activeRunning}
                      {...(state.timeline.activeTurn === undefined
                        ? {}
                        : { activeTurn: state.timeline.activeTurn })}
                      assistantLabel={assistantLabel}
                      {...(activeSubagent === undefined ? { onBranch: branchSession } : {})}
                      branching={branching}
                      onOpenLink={(href) => store.openLink(href)}
                      onLoadImage={(image) => store.readSessionAttachment(active.id, image)}
                      onShowInFolder={(href) => {
                        void store
                          .showInFolder(href)
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
                      feedback={state.feedback}
                      feedbackUnavailable={state.feedbackUnavailable}
                      hasMoreHistory={state.historyHasMore}
                      loadingOlderHistory={state.historyLoading}
                      onLoadOlderHistory={() =>
                        store.loadOlderHistory().catch((reason: unknown) => {
                          setError(reason instanceof Error ? reason.message : t('app.error.loadOlderHistory'))
                        })
                      }
                      onFeedback={(messageId, rating) => {
                        void store
                          .toggleFeedback(active.id, messageId, rating)
                          .catch((reason: unknown) =>
                            setError(reason instanceof Error ? reason.message : t('app.error.feedback')),
                          )
                      }}
                      onFeedbackNote={async (messageId, note) => {
                        try {
                          await store.setFeedbackNote(active.id, messageId, note)
                        } catch (reason: unknown) {
                          setError(reason instanceof Error ? reason.message : t('app.error.feedback'))
                          throw reason
                        }
                      }}
                    />
                  ) : (
                    <TrajectoryView
                      sessionId={active.id}
                      nodes={state.timeline.nodes}
                      streaming={streaming}
                    />
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
                    <TodoList key={active?.id ?? 'todo-list'} todos={state.todos} />
                    <StatsLine
                      nodes={state.timeline.nodes}
                      usage={projectedTokenUsage ?? state.timeline.tokenUsage}
                      cacheHit={cacheHitRate(projectedTokenUsage ?? state.timeline.tokenUsage)}
                      {...(sessionStats === undefined ? {} : { sessionStats })}
                    />
                    {pendingPermissions.length === 0 && pendingQuestions.length === 0 ? (
                      subagentReadOnlyReason === undefined || activeRunning ? (
                        <Composer
                          disabled={backend.kind !== 'connected'}
                          inputDisabled={
                            subagentReadOnlyReason !== undefined ||
                            (activeSubagent !== undefined && activeSubagentState?.parentAvailable === false)
                          }
                          attachmentsDisabled={activeSubagent !== undefined}
                          running={activeRunning}
                          draft={draft}
                          attachments={attachments}
                          configuration={state.configuration}
                          models={sessionModels}
                          presets={state.presets}
                          permissionPresets={state.permissionPresets}
                          commands={state.commands}
                          popupSelects={popupSelects}
                          references={visibleReferenceCandidates}
                          referenceLoading={visibleReferenceLoading}
                          {...(imageLimits === undefined ? {} : { imageLimits })}
                          busyEnter={state.busyEnter}
                          modelPickerOpenRequest={modelPickerOpenRequest}
                          {...(estimatedContextTokens === undefined ? {} : { estimatedContextTokens })}
                          {...(contextWindowTokens === undefined ? {} : { contextWindowTokens })}
                          {...(contextPressure?.breakdown === undefined
                            ? {}
                            : { contextBreakdown: contextPressure.breakdown })}
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
                          onCommand={async (command, commandAttachments = []) => {
                            if (command.trim() === '/model') {
                              if (commandAttachments.length > 0)
                                throw new Error(t('app.error.commandImagesUnsupported', { command: 'model' }))
                              setModelPickerOpenRequest((current) => current + 1)
                              return
                            }
                            try {
                              await store.executeCommand(active.id, command, commandAttachments)
                              if (commandAttachments.length > 0)
                                removeAttachmentDrafts(
                                  commandAttachments.map((attachment) => attachment.uri),
                                  true,
                                )
                            } catch (reason: unknown) {
                              setError(reason instanceof Error ? reason.message : t('app.error.dshMode'))
                              throw reason
                            }
                          }}
                          onPopupSelect={(command) => popupSelects.get(command)?.onOpen()}
                          onCommandQueryChange={(query) => {
                            if (query === undefined || state.commands.length > 0) return
                            void store.refreshCommands(active.id)
                          }}
                          onReferenceQueryChange={updateReferenceQuery}
                          onDraftChange={setDraft}
                          onPickAttachment={() => {
                            const generation = attachmentGenerationRef.current
                            void store
                              .pickAttachment()
                              .then((attachment) => {
                                if (attachment !== undefined)
                                  appendAttachment(attachment, undefined, generation)
                              })
                              .catch((reason: unknown) =>
                                setError(
                                  reason instanceof Error
                                    ? reason.message
                                    : t('app.error.attachmentSelection'),
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
            </>
          )}
        </section>
      </main>
    </AppErrorBoundary>
  )
}

function EmptySessionPosture(props: {
  readonly workspaces: readonly WorkspaceSummary[]
  readonly presets: readonly AgentPresetDescriptor[]
  readonly empty: boolean
  readonly onCreate: (workspaceId: string, presetId?: string) => void
}): ReactElement {
  const { t } = useI18n()
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(props.workspaces[0]?.id ?? '')
  const defaultPreset = props.presets.find((preset) => preset.isDefault && preset.broken === undefined)?.id
  const [selectedPresetId, setSelectedPresetId] = useState(defaultPreset ?? props.presets[0]?.id ?? '')
  const selected =
    props.workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? props.workspaces[0]
  const availablePresets = props.presets.filter((preset) => preset.broken === undefined)
  const stagedPreset =
    availablePresets.find((preset) => preset.id === selectedPresetId) ?? availablePresets[0]
  const stagedPresetId = stagedPreset?.id ?? ''

  if (props.workspaces.length === 0)
    return (
      <EmptyState
        title={t('app.noActiveSession')}
        description={props.empty ? t('app.createSession') : t('app.chooseSession')}
      />
    )

  return (
    <section className="dsh-empty-session" aria-live="polite">
      <div className="dsh-empty-session__icon" aria-hidden="true">
        <Icon name="session" />
      </div>
      <span className="dsh-app__eyebrow">{t('app.noActiveSession')}</span>
      <h2>{props.empty ? t('app.createSession') : t('app.chooseSession')}</h2>
      <p>{t('app.workspacePickerHint')}</p>
      <label className="dsh-empty-session__picker">
        <span>{t('app.workspacePicker')}</span>
        <select
          value={selected?.id ?? ''}
          onChange={(event) => setSelectedWorkspaceId(event.currentTarget.value)}
          aria-label={t('app.workspacePicker')}
        >
          {props.workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
      </label>
      {availablePresets.length === 0 ? null : (
        <label className="dsh-empty-session__preset">
          <span>{t('app.presetPicker')}</span>
          <span className="dsh-empty-session__preset-chip" data-staged-preset={stagedPresetId}>
            <Icon name="sparkles" />
            <select
              value={stagedPresetId}
              onChange={(event) => setSelectedPresetId(event.currentTarget.value)}
              aria-label={t('app.presetPicker')}
            >
              {availablePresets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name ?? preset.id}
                </option>
              ))}
            </select>
            <span className="dsh-sr-only">{t('app.presetStaged')}</span>
          </span>
        </label>
      )}
      <button
        className="dsh-button dsh-button--primary"
        type="button"
        disabled={selected === undefined}
        onClick={() => {
          if (selected !== undefined)
            props.onCreate(selected.id, stagedPresetId === '' ? undefined : stagedPresetId)
        }}
      >
        {t('app.newSessionInWorkspace')}
      </button>
    </section>
  )
}

function readContextPressure(value: unknown, breakdownValue?: unknown): ContextPressure | undefined {
  const record = object(value)
  const pressureTokens = nonNegativeTokenCount(record?.pressureTokens)
  const projectedTokens = nonNegativeTokenCount(record?.projectedTokens)
  const contextWindow = positiveTokenCount(record?.contextWindow)
  // DSH publishes these as two independent projections. Keep accepting the
  // nested shape used by early fixtures so rc.6/rc.7 deployments remain safe.
  const breakdown = readContextBreakdown(breakdownValue) ?? readContextBreakdown(record?.contextBreakdown)
  if (
    pressureTokens === undefined &&
    projectedTokens === undefined &&
    contextWindow === undefined &&
    breakdown === undefined
  )
    return undefined
  return {
    ...(pressureTokens === undefined ? {} : { pressureTokens }),
    ...(projectedTokens === undefined ? {} : { projectedTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(breakdown === undefined ? {} : { breakdown }),
  }
}

function readContextBreakdown(value: unknown): ContextPressure['breakdown'] | undefined {
  const record = object(value)
  if (record === undefined) return undefined
  const systemTokens = nonNegativeTokenCount(record.systemTokens)
  const toolsTokens = nonNegativeTokenCount(record.toolsTokens)
  const messageTokens = nonNegativeTokenCount(record.messageTokens)
  if (systemTokens === undefined || toolsTokens === undefined || messageTokens === undefined) return undefined
  return { systemTokens, toolsTokens, messageTokens }
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
  imageLimits?: ImageAttachmentLimits,
): Promise<{ name: string; mimeType?: string; dataBase64: string }> {
  if (file.size === 0) return Promise.reject(new Error(t('app.error.fileEmpty', { name: file.name })))
  const imageLimit =
    file.type.startsWith('image/') && imageLimits !== undefined
      ? Math.min(8 * 1024 * 1024, imageLimits.maxImageBytes)
      : 8 * 1024 * 1024
  if (file.size > imageLimit) {
    if (file.type.startsWith('image/') && imageLimits !== undefined) {
      return Promise.reject(
        new Error(
          t('app.error.imageTooLarge', {
            name: file.name,
            size: formatByteSize(imageLimits.maxImageBytes),
          }),
        ),
      )
    }
  }
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

function readImageAttachmentLimits(value: unknown): ImageAttachmentLimits | undefined {
  const record = object(value)
  if (record === undefined) return undefined
  const maxImageBytes = positiveInteger(record.maxImageBytes)
  const maxImagesPerMessage = positiveInteger(record.maxImagesPerMessage)
  const maxMessageImageBytes = positiveInteger(record.maxMessageImageBytes)
  const maxImagePixels = positiveInteger(record.maxImagePixels)
  const maxImageDimension = positiveInteger(record.maxImageDimension)
  const mediaTypes = Array.isArray(record.mediaTypes)
    ? record.mediaTypes.filter(
        (entry): entry is string => typeof entry === 'string' && entry.startsWith('image/'),
      )
    : []
  if (
    maxImageBytes === undefined ||
    maxImagesPerMessage === undefined ||
    maxMessageImageBytes === undefined ||
    maxImagePixels === undefined ||
    mediaTypes.length === 0
  )
    return undefined
  return {
    // Keep future hosts from advertising a limit beyond the opaque attachment
    // store and prompt boundary implemented by this extension.
    maxImageBytes: Math.min(maxImageBytes, 8 * 1024 * 1024),
    maxImagesPerMessage: Math.min(maxImagesPerMessage, 20),
    maxMessageImageBytes: Math.min(maxMessageImageBytes, 100 * 1024 * 1024),
    maxImagePixels,
    ...(maxImageDimension === undefined ? {} : { maxImageDimension }),
    mediaTypes,
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function formatByteSize(value: number): string {
  if (value >= 1024 * 1024)
    return `${(value / (1024 * 1024)).toFixed(value % (1024 * 1024) === 0 ? 0 : 1)} MiB`
  if (value >= 1024) return `${Math.round(value / 1024)} KiB`
  return `${value} B`
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

function welcomeWasDismissed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(WELCOME_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

function rememberWelcomeDismissal(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(WELCOME_DISMISSED_KEY, '1')
  } catch {
    // A restricted Webview storage area should not prevent starting a session.
  }
}

function dismissedRuntimeUpdateVersionFromStorage(): string | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const value = window.localStorage.getItem(RUNTIME_UPDATE_DISMISSED_KEY)?.trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

function rememberRuntimeUpdateDismissal(version: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(RUNTIME_UPDATE_DISMISSED_KEY, version)
  } catch {
    // A restricted Webview storage area should not prevent using the update notice.
  }
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
