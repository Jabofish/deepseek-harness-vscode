import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'
import type {
  AgentConfiguration,
  EditorContextKind,
  EditorContextPreview,
  FeedbackCategory,
  GoalView,
  MessageFeedbackRating,
  MessageImageReference,
  PermissionRequest,
  PromptAttachment,
  PromptMode,
  SessionSummary,
  UserQuestion,
  RunningInputMode,
} from '@dsh-vscode/domain'
import { cacheHitRate } from '@dsh-vscode/timeline'
import { EmptyState } from '@dsh-vscode/ui'
import { Composer } from './features/composer/Composer.js'
import { ExportDialog } from './features/export/ExportDialog.js'
import { AppErrorBoundary } from './features/errors/AppErrorBoundary.js'
import { Timeline } from './features/chat/Timeline.js'
import { StatsLine } from './features/chat/StatsLine.js'
import { ApprovalCard } from './features/interactions/ApprovalCard.js'
import { approvalCommand } from './features/interactions/approval-command.js'
import { UserQuestionCard } from './features/interactions/UserQuestionCard.js'
import { GoalTodoStrip } from './features/goals/GoalTodoStrip.js'
import { GoalBar } from './features/goals/GoalBar.js'
import { TodoList } from './features/goals/TodoList.js'
import { JobsDrawer } from './features/jobs/JobsDrawer.js'
import { ChangesDrawer } from './features/changes/ChangesDrawer.js'
import { CheckpointDrawer } from './features/checkpoints/CheckpointDrawer.js'
import { PromptTemplatesDrawer } from './features/prompt-templates/PromptTemplatesDrawer.js'
import { TasksDrawer } from './features/tasks/TasksDrawer.js'
import { QueuePanel } from './features/input/QueuePanel.js'
import { RuntimeConnectionView } from './features/runtime/RuntimeConnectionView.js'
import { RuntimeMissingView } from './features/runtime/RuntimeMissingView.js'
import { SessionDrawer } from './features/sessions/SessionDrawer.js'
import { EmptySessionPosture } from './features/sessions/EmptySessionPosture.js'
import { SessionLineage } from './features/subagents/SessionLineage.js'
import { SubagentDrawer } from './features/subagents/SubagentDrawer.js'
import { DiagnosticsDrawer } from './features/diagnostics/DiagnosticsDrawer.js'
import { SettingsDrawer } from './features/settings/SettingsDrawer.js'
import { ScheduleDrawer } from './features/schedules/ScheduleDrawer.js'
import { resolveScheduleSessionLink } from './features/schedules/session-link.js'
import { isDefinitePromptRejection } from './features/schedules/prompt-rejection.js'
import { TrajectoryView } from './features/trajectory/TrajectoryView.js'
import { AppHeader } from './features/shell/AppHeader.js'
import { ConversationActionsMenu } from './features/shell/ConversationActionsMenu.js'
import { ConversationEventToggle } from './features/shell/ConversationEventToggle.js'
import { createAppStore, type AppStore, type OpenFileCandidate } from './app/store.js'
import { publicProtocolErrorMessage } from './app/protocol-client.js'
import { useDshSettings } from './app/useDshSettings.js'
import { useComposerAttachments } from './app/useComposerAttachments.js'
import {
  welcomeWasDismissed,
  rememberWelcomeDismissal,
  dismissedRuntimeUpdateVersionFromStorage,
  rememberRuntimeUpdateDismissal,
} from './app/dismissed-notices.js'
import { resolveAssistantModelLabel } from './app/model-label.js'
import { useStableCallback } from './app/useStableCallback.js'
import {
  readContextPressure,
  readTokenUsageProjection,
  readSessionStatsProjection,
} from './app/session-metrics.js'
import { readImageAttachmentLimits } from './app/attachment-reader.js'
import {
  readConversationFontSize,
  rememberConversationFontSize,
  readThemePreference,
  rememberThemePreference,
  type ConversationFontSize,
  type ThemePreference,
} from './app/ui-preferences.js'
import { useI18n } from './i18n.js'
import { Icon } from './ui/Icon.js'
import { useDismissibleLayer } from './components/common/useDismissibleLayer.js'
import { hasVsCodeApi } from './vscode-api.js'
import { PopupSelectRegistry } from './features/commands/popupSelectRegistry.js'

/** A pending approval with the command it asks to authorize, when resolvable. */
interface PendingApproval {
  readonly request: PermissionRequest
  readonly command?: string
}

const EMPTY_OPEN_FILE_CANDIDATES: readonly OpenFileCandidate[] = []
const EMPTY_PERMISSION_REQUESTS: readonly PendingApproval[] = []
const EMPTY_USER_QUESTIONS: readonly UserQuestion[] = []
// VS Code Webviews can restore from a cached document while extension files
// are being replaced during an update. Root-level dynamic imports then point
// at hashed chunks from the previous build and reject inside React.lazy,
// replacing the entire conversation with the error boundary. Keep all
// required application surfaces in the stable `webview.js` entry; Shiki's
// optional language payloads remain lazy inside MarkdownContent.
const DeferredSettingsDrawer = SettingsDrawer
const DeferredTrajectoryView = TrajectoryView
const DeferredTimeline = Timeline
const DeferredPromptTemplatesDrawer = PromptTemplatesDrawer
const DeferredJobsDrawer = JobsDrawer
const DeferredChangesDrawer = ChangesDrawer
const DeferredTasksDrawer = TasksDrawer
const DeferredCheckpointDrawer = CheckpointDrawer
const DeferredSubagentDrawer = SubagentDrawer
const DeferredDiagnosticsDrawer = DiagnosticsDrawer
const DeferredExportDialog = ExportDialog
const ERROR_TOAST_DISMISS_MS = 8_000
const CONVERSATION_VIEW_IDS = {
  chat: { tab: 'dsh-conversation-tab-chat', panel: 'dsh-conversation-panel-chat' },
  trajectory: { tab: 'dsh-conversation-tab-trajectory', panel: 'dsh-conversation-panel-trajectory' },
} as const

export function App(): ReactElement {
  const { locale, setLocale, adoptLocaleFromHost, t } = useI18n()
  const store = useMemo(() => createAppStore(), [])
  const mountedRef = useRef(true)
  const initializedStoreRef = useRef<AppStore | undefined>(undefined)
  const disposeTimerRef = useRef<number | undefined>(undefined)
  const popupSelects = useMemo(() => new PopupSelectRegistry(), [])
  const state = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState(),
    () => store.getState(),
  )
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useEffect(() => {
    if (state.accountLifecycleAvailable && state.drawer === 'settings' && state.accountLifecycle === null)
      void store.loadAccountLifecycle()
  }, [state.accountLifecycleAvailable, state.accountLifecycle, state.drawer, store])
  const [busyAction, setBusyAction] = useState<'install' | 'select' | undefined>()
  const [respondingInteractionId, setRespondingInteractionId] = useState<string | undefined>()
  const [branching, setBranching] = useState(false)
  const [error, setErrorState] = useState<string | undefined>()
  /**
   * Every message owns its own dismissal window. Keyed on the message alone, a
   * repeat of the identical failure while the first toast is up would change no
   * state, leaving the original deadline in place and the second report visible
   * only for the remainder of it.
   */
  const [errorRevision, setErrorRevision] = useState(0)
  const setError = useCallback((message: string | undefined): void => {
    setErrorState(message)
    setErrorRevision((current) => current + 1)
  }, [])
  const [welcomeVisible, setWelcomeVisible] = useState(() => !welcomeWasDismissed())
  const [dismissedRuntimeUpdateVersion, setDismissedRuntimeUpdateVersion] = useState(() =>
    dismissedRuntimeUpdateVersionFromStorage(),
  )
  const [dismissedConnection, setDismissedConnection] = useState<string | undefined>()
  const [modelPickerOpenRequest, setModelPickerOpenRequest] = useState(0)
  const [conversationView, setConversationView] = useState<'chat' | 'trajectory'>('chat')
  const [dshEventVisibility, setDshEventVisibility] = useState<{
    readonly sessionId: string | undefined
    readonly visible: boolean
  }>({ sessionId: undefined, visible: false })
  const [exportOpen, setExportOpen] = useState(false)
  const [exportSessionId, setExportSessionId] = useState<string | undefined>()
  const [localeOpen, setLocaleOpen] = useState(false)
  const [conversationFontSize, setConversationFontSizeState] = useState<ConversationFontSize>(() =>
    readConversationFontSize(),
  )
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(() => readThemePreference())
  const localeControlRef = useRef<HTMLSpanElement>(null)
  const {
    adoptExplicitLocaleFromDsh,
    readDshSettingsForUi,
    updateDshSettingFromDrawer,
    unsetDshSettingFromDrawer,
    mutateDshSettingsFromDrawer,
    applyLocale,
    readyDshUiPreferences,
    settingsDrawerVersionKey,
    codingToolsEnabled,
    newSessionPresetSelectionEnabled,
    transcriptView,
    performanceUsage,
    hostConversationFontSizePx,
    conversationFontStyle,
  } = useDshSettings({
    store,
    state,
    adoptLocaleFromHost,
    setLocale,
    setThemePreferenceState,
    setConversationView,
    setError,
    t,
  })
  const onConversationTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      const current = event.currentTarget.dataset.conversationView
      if (current !== 'chat' && current !== 'trajectory') return
      const views: readonly ('chat' | 'trajectory')[] = codingToolsEnabled ? ['chat', 'trajectory'] : ['chat']
      const currentIndex = views.indexOf(current)
      let nextIndex: number | undefined
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
        nextIndex = (currentIndex + 1) % views.length
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
        nextIndex = (currentIndex - 1 + views.length) % views.length
      else if (event.key === 'Home') nextIndex = 0
      else if (event.key === 'End') nextIndex = views.length - 1
      if (nextIndex === undefined) return
      event.preventDefault()
      const next = views[nextIndex]
      if (next === undefined) return
      setConversationView(next)
      document.getElementById(CONVERSATION_VIEW_IDS[next].tab)?.focus()
    },
    [codingToolsEnabled],
  )

  const setConversationFontSize = useCallback((next: ConversationFontSize): void => {
    setConversationFontSizeState(next)
    rememberConversationFontSize(next)
  }, [])

  const setThemePreference = useCallback((next: ThemePreference): void => {
    setThemePreferenceState(next)
    rememberThemePreference(next)
  }, [])

  useLayoutEffect(() => {
    document.documentElement.dataset.dshTheme = themePreference
  }, [themePreference])

  useEffect(() => {
    if (!hasVsCodeApi()) return
    if (disposeTimerRef.current !== undefined) {
      window.clearTimeout(disposeTimerRef.current)
      disposeTimerRef.current = undefined
    }
    if (initializedStoreRef.current === store)
      return () => {
        disposeTimerRef.current = window.setTimeout(() => {
          disposeTimerRef.current = undefined
          store.dispose()
        }, 0)
      }
    initializedStoreRef.current = store
    void store
      .initialize()
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.initialize')),
      )
    return () => {
      disposeTimerRef.current = window.setTimeout(() => {
        disposeTimerRef.current = undefined
        store.dispose()
      }, 0)
    }
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
    const timer = window.setTimeout(() => setErrorState(undefined), ERROR_TOAST_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [error, errorRevision])

  // Escape belongs to the layer hook alone. The language listbox is nested in
  // the conversation-tools panel, whose own layer consumes the key for the
  // whole surface; a raw window listener here would run after that layer
  // already closed both surfaces with a single press.
  useDismissibleLayer({
    open: localeOpen,
    refs: [localeControlRef],
    onDismiss: () => setLocaleOpen(false),
  })

  const backend = state.backend
  const compatibilityWarning = state.dshCompatibilityWarning
  const runtimeUpdateVersion = state.dshUpdate?.latestVersion ?? 'unknown'
  const runtimeUpdateVisible =
    state.dshUpdate?.updateAvailable === true &&
    state.dshUpdate.globalVersion !== runtimeUpdateVersion &&
    dismissedRuntimeUpdateVersion !== runtimeUpdateVersion
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
  const retryConnection = useStableCallback((): void => {
    void store
      .reconnect()
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.reconnect')),
      )
  })
  const activeSession = useMemo(
    () => state.sessions.find((session) => session.id === state.activeSessionId),
    [state.activeSessionId, state.sessions],
  )
  const activeSubagentState = useMemo(() => {
    const candidate = state.activeSubagent
    return candidate?.entry.id === state.activeSessionId ? candidate : undefined
  }, [state.activeSessionId, state.activeSubagent])
  const activeSubagent = activeSubagentState?.entry
  const active = useMemo<SessionSummary | undefined>(
    () =>
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
          }),
    [activeSession, activeSubagent, activeSubagentState?.workspaceId, t],
  )
  const activeSubagentId = activeSubagent?.id
  const activeSubagentLabel = activeSubagent?.label
  const activeSubagentParentId = activeSubagent?.parentSessionId
  const lineageActiveSubagent = useMemo(
    () =>
      activeSubagentId === undefined || activeSubagentParentId === undefined
        ? undefined
        : {
            id: activeSubagentId,
            parentSessionId: activeSubagentParentId,
            ...(activeSubagentLabel === undefined ? {} : { label: activeSubagentLabel }),
          },
    [activeSubagentId, activeSubagentLabel, activeSubagentParentId],
  )
  const eventCountNodes = state.timeline.eventCount === undefined ? state.timeline.nodes : undefined
  const dshEventCount = useMemo(
    () =>
      state.timeline.eventCount ??
      eventCountNodes?.reduce((count, node) => (node.kind === 'event' ? count + 1 : count), 0) ??
      0,
    [eventCountNodes, state.timeline.eventCount],
  )
  const activeSessionId = active?.id
  const showDshEvents =
    codingToolsEnabled && dshEventVisibility.visible && dshEventVisibility.sessionId !== undefined
      ? dshEventVisibility.sessionId === activeSessionId
      : false
  // The export form names no session of its own, so it belongs to the
  // conversation it was opened from: a switch would silently retarget it.
  const visibleExportSessionId =
    exportOpen && exportSessionId !== undefined && exportSessionId === activeSessionId
      ? exportSessionId
      : undefined
  const setShowDshEvents = useStableCallback((visible: boolean): void => {
    if (!codingToolsEnabled || activeSessionId === undefined) return
    setDshEventVisibility({ sessionId: activeSessionId, visible })
  })
  const sessionModels = state.sessionModels.length > 0 ? state.sessionModels : state.models
  // These rows name the providers the session directory could not enumerate.
  // They stay visible while the global catalog stands in, because that
  // fallback is what lets a session whose providers all failed show models at
  // all, and dropping the rows there would hide the only explanation.
  const sessionModelFailures = state.sessionModelFailures
  // The route the host says the session's next request will take. The
  // configuration names a model only once someone chose one, so this is the
  // only statement of what an unstated configuration actually runs.
  const sessionModelCurrent = state.sessionModelCurrent
  // The host's verdict on the session's current model, not a guess from the
  // groups: a route can serve a model it stopped advertising, and only the
  // host knows which adapters are live. `undefined` means no directory has
  // answered, which must not read as blocked.
  const sessionModelRoutable = state.sessionModelRoutable
  // The read's own state travels with the rows: the fallback above is what the
  // composer can offer when the session directory has not answered, and the
  // picker has to say so instead of presenting the global catalog as the
  // session's own.
  const sessionModelDirectoryLoading = state.sessionModelDirectoryLoading
  const sessionModelDirectoryError = state.sessionModelDirectoryError
  const pendingPermissions = useMemo(
    () =>
      activeSessionId === undefined || state.permissions.length === 0
        ? EMPTY_PERMISSION_REQUESTS
        : state.permissions
            .filter((request) => request.sessionId === activeSessionId)
            .map((request) => ({ request, command: approvalCommand(request, state.timeline.nodes) })),
    [activeSessionId, state.permissions, state.timeline.nodes],
  )
  const pendingQuestions = useMemo(
    () =>
      activeSessionId === undefined || state.questions.length === 0
        ? EMPTY_USER_QUESTIONS
        : state.questions.filter((question) => question.sessionId === activeSessionId),
    [activeSessionId, state.questions],
  )
  const assistantLabel = useMemo(
    () => resolveAssistantModelLabel(active, state.configuration, sessionModels, t),
    [active, sessionModels, state.configuration, t],
  )
  const activeProjection = useMemo(
    () => (activeSessionId === undefined ? undefined : state.projections[activeSessionId]),
    [activeSessionId, state.projections],
  )
  const imageLimits = useMemo(
    () => readImageAttachmentLimits(activeProjection?.imageLimits),
    [activeProjection?.imageLimits],
  )
  const contextPressure = useMemo(
    () => readContextPressure(activeProjection?.contextPressure, activeProjection?.contextBreakdown),
    [activeProjection?.contextBreakdown, activeProjection?.contextPressure],
  )
  const estimatedContextTokens = contextPressure?.projectedTokens ?? contextPressure?.pressureTokens
  const contextWindowTokens = contextPressure?.contextWindow
  const projectedTokenUsage = useMemo(
    () => readTokenUsageProjection(activeProjection?.tokenUsage),
    [activeProjection?.tokenUsage],
  )
  const sessionStats = useMemo(
    () => readSessionStatsProjection(activeProjection?.sessionStats),
    [activeProjection?.sessionStats],
  )
  const activeRunning =
    activeSubagent === undefined ? active?.status === 'running' : activeSubagent.activity === 'running'
  const {
    draft,
    setDraft,
    attachments,
    attachmentPreviews,
    attachmentPreviewFailures,
    visibleOpenFileCandidates,
    visibleOpenFilePickerOpen,
    visibleOpenFilePickerLoading,
    attachedOpenFileIds,
    attachingOpenFileId,
    visibleReferenceCandidates,
    visibleReferenceLoading,
    discardAttachmentDrafts,
    removeAttachmentDrafts,
    composerOnReferenceQueryChange,
    composerOnPickAttachment,
    composerOnIngestFiles,
    composerOnToggleOpenFilePicker,
    composerOnExtrasOpenChange,
    composerOnSelectOpenFile,
    composerOnRemoveAttachment,
    composerOnSubmit,
  } = useComposerAttachments({
    store,
    t,
    setError,
    active,
    activeSessionId,
    imageLimits,
    hasPendingSession: state.pendingSession !== undefined,
    subagentEntries: state.subagents.entries,
    mountedRef,
  })
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
  const timelineOnOpenLink = useStableCallback((href: string): Promise<void> => store.openLink(href))
  const timelineOnLoadImage = useStableCallback(
    (image: MessageImageReference): Promise<string | undefined> =>
      activeSessionId === undefined
        ? Promise.resolve(undefined)
        : store.readSessionAttachment(activeSessionId, image),
  )
  const timelineOnShowInFolder = useStableCallback((href: string): void => {
    void store
      .showInFolder(href)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.openLink')),
      )
  })
  const timelineOnOpenSession = useStableCallback((sessionId: string): void => {
    discardAttachmentDrafts()
    void store
      .openSession(sessionId)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.openSession')),
      )
  })
  const timelineOnLoadOlderHistory = useStableCallback((): Promise<void> =>
    store.loadOlderHistory().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : t('app.error.loadOlderHistory'))
    }),
  )
  const timelineOnFeedback = useStableCallback((messageId: string, rating: MessageFeedbackRating): void => {
    if (activeSessionId === undefined) return
    void store
      .toggleFeedback(activeSessionId, messageId, rating)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.feedback')),
      )
  })
  const timelineOnFeedbackPrepare = useStableCallback((messageId: string) => {
    if (activeSessionId === undefined) return Promise.resolve(undefined)
    return store.ensureFeedback(activeSessionId, messageId)
  })
  const timelineOnFeedbackSubmit = useStableCallback(
    async (
      messageId: string,
      rating: MessageFeedbackRating,
      note: string | undefined,
      category: FeedbackCategory | undefined,
    ): Promise<void> => {
      if (activeSessionId === undefined) return
      try {
        await store.submitFeedback(activeSessionId, messageId, rating, note, category)
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : t('app.error.feedback'))
        throw reason
      }
    },
  )
  const timelineOnBranch = useStableCallback((atSeq: number): void => branchSession(atSeq))
  const lineageOnOpenSession = useStableCallback((sessionId: string): void => {
    discardAttachmentDrafts()
    void store
      .openSession(sessionId)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.openSession')),
      )
  })
  const goalOnUpdate = useStableCallback(
    (goalId: string, update: Partial<Pick<GoalView, 'title' | 'status' | 'maxGoalRounds'>>) =>
      store.updateGoal(goalId, update),
  )
  const goalOnClear = useStableCallback((goalId: string) => store.clearGoal(goalId))
  const queueOnEdit = useStableCallback((inputId: string, text: string): void => {
    void store
      .updateQueue(inputId, text)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.editQueue')),
      )
  })
  const queueOnRemove = useStableCallback((inputId: string): void => {
    void store
      .removeQueue(inputId)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.removeQueue')),
      )
  })
  const queueOnModeChange = useStableCallback((inputId: string, mode: RunningInputMode): void => {
    if (mode !== 'steer') return
    void store
      .steerQueue(inputId)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.steerQueue')),
      )
  })
  const sessionOnOpenChange = useStableCallback((open: boolean): void => {
    store.setDrawer(open ? 'sessions' : undefined)
  })
  const sessionOnOpen = useStableCallback((sessionId: string): void => {
    discardAttachmentDrafts()
    void store
      .openSession(sessionId)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.openSession')),
      )
  })
  const beginNewDraft = useStableCallback((workspaceId?: string, presetId?: string): Promise<void> => {
    discardAttachmentDrafts()
    setDraft('')
    return store.stageSession(workspaceId, presetId)
  })
  const sessionOnCreate = useStableCallback((workspaceId: string | undefined): void => {
    void beginNewDraft(workspaceId).catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : t('app.error.createSession')),
    )
  })
  const sessionOnArchive = useStableCallback((sessionId: string): Promise<void> =>
    store.removeSession(sessionId).catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : t('app.error.archiveSession')
      setError(message)
      throw reason
    }),
  )
  const sessionOnRename = useStableCallback((sessionId: string, title: string): Promise<void> =>
    store.renameSession(sessionId, title),
  )
  const sessionOnLoadArchived = useStableCallback((): Promise<void> => store.loadArchivedSessions())
  const sessionOnRestore = useStableCallback((sessionId: string): Promise<void> =>
    store.restoreSession(sessionId),
  )
  const sessionOnDelete = useStableCallback((sessionId: string): Promise<void> =>
    store.deleteSession(sessionId),
  )
  const sessionOnRenameWorkspace = useStableCallback((workspaceId: string, name: string): Promise<void> =>
    store.renameWorkspace(workspaceId, name),
  )
  const sessionOnAddWorkspace = useStableCallback((): Promise<void> => store.addWorkspaceFolder())
  const sessionOnRemoveWorkspace = useStableCallback((workspaceId: string): Promise<void> =>
    store.removeWorkspace(workspaceId),
  )
  const sessionOnMoveWorkspace = useStableCallback(
    (workspaceId: string, beforeWorkspaceId?: string): Promise<void> =>
      store.moveWorkspace(workspaceId, beforeWorkspaceId),
  )
  const sessionOnMoveSession = useStableCallback(
    (workspaceId: string, sessionId: string, beforeSessionId?: string): Promise<void> =>
      store.moveSession(workspaceId, sessionId, beforeSessionId),
  )
  const sessionOnSearch = useStableCallback((query: string) => store.searchSessions(query))
  const composerOnCaptureEditorContext = useStableCallback((kind: EditorContextKind): Promise<void> =>
    store.captureEditorContext(kind),
  )
  const composerOnRemoveEditorContext = useStableCallback((contextRef: string): Promise<void> =>
    store.releaseEditorContext([contextRef]),
  )
  const composerOnPreviewEditorContext = useStableCallback(
    (contextRef: string): Promise<EditorContextPreview | undefined> => store.previewEditorContext(contextRef),
  )
  const composerOnConfigurationChange = useStableCallback(
    async (configuration: AgentConfiguration): Promise<void> => {
      if (active === undefined) return
      try {
        await store.configureSession(active.id, configuration)
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : t('app.error.sessionSettings'))
        throw reason
      }
    },
  )
  const composerOnPromptModeChange = useStableCallback((mode: PromptMode): void => {
    void store
      .setPromptMode(mode)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.promptMode')),
      )
  })
  // The read's failure is stated inside the picker, so this only has to run it
  // again: a rejection here would repeat what the menu already shows.
  const composerOnModelRetry = useStableCallback((): void => {
    void store.refreshSessionModels().catch(() => undefined)
  })
  const composerOnCommand = useStableCallback(
    async (command: string, commandAttachments: readonly PromptAttachment[] = []): Promise<void> => {
      if (active === undefined) return
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
    },
  )
  const composerOnPopupSelect = useStableCallback((command: string): void => {
    popupSelects.get(command)?.onOpen()
  })
  const composerOnCommandQueryChange = useStableCallback((query: string | undefined): void => {
    if (query === undefined || state.commands.length > 0 || active === undefined) return
    void store.refreshCommands(active.id)
  })
  const composerOnCancel = useStableCallback((): void => {
    if (active === undefined) return
    void store
      .cancelSession(active.id)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t('app.error.cancel')))
  })
  const composerOnSteerQueue = useStableCallback((): Promise<void> =>
    store.steerAllQueued().catch((reason: unknown) => {
      if (mountedRef.current) setError(publicProtocolErrorMessage(reason) ?? t('app.error.steerAll'))
    }),
  )
  const composerUsage = projectedTokenUsage ?? state.timeline.tokenUsage
  const composerStatus = useMemo(
    () => (
      <StatsLine
        nodes={state.timeline.nodes}
        {...(state.timeline.nodeChangeStart === undefined
          ? {}
          : { nodeChangeStart: state.timeline.nodeChangeStart })}
        {...(state.timeline.nodeChangeBase === undefined
          ? {}
          : { nodeChangeBase: state.timeline.nodeChangeBase })}
        usage={composerUsage}
        cacheHit={cacheHitRate(composerUsage)}
        performanceUsage={performanceUsage}
        {...(sessionStats === undefined ? {} : { sessionStats })}
      />
    ),
    [
      composerUsage,
      performanceUsage,
      sessionStats,
      state.timeline.nodeChangeBase,
      state.timeline.nodeChangeStart,
      state.timeline.nodes,
    ],
  )
  const sessionControl = useMemo(
    () => (
      <SessionDrawer
        permissions={state.permissions}
        questions={state.questions}
        sessions={state.sessions}
        workspaces={state.workspaces}
        activeSessionId={state.activeSessionId}
        open={state.drawer === 'sessions'}
        showTrigger={state.activeSessionId !== undefined || state.pendingSession !== undefined}
        preferredWorkspaceId={state.pendingSession?.workspaceId}
        onOpenChange={sessionOnOpenChange}
        onOpen={sessionOnOpen}
        onCreate={sessionOnCreate}
        onArchive={sessionOnArchive}
        archivedSessions={state.archivedSessions}
        onLoadArchived={sessionOnLoadArchived}
        canRestoreSessions={state.sessionRestore === true}
        onRestore={sessionOnRestore}
        onDelete={sessionOnDelete}
        onRename={sessionOnRename}
        onRenameWorkspace={sessionOnRenameWorkspace}
        onAddWorkspace={sessionOnAddWorkspace}
        onRemoveWorkspace={sessionOnRemoveWorkspace}
        onMoveWorkspace={sessionOnMoveWorkspace}
        onMoveSession={sessionOnMoveSession}
        onSearch={sessionOnSearch}
      />
    ),
    [
      sessionOnArchive,
      sessionOnAddWorkspace,
      sessionOnCreate,
      sessionOnDelete,
      sessionOnLoadArchived,
      sessionOnMoveSession,
      sessionOnMoveWorkspace,
      sessionOnOpen,
      sessionOnOpenChange,
      sessionOnRemoveWorkspace,
      sessionOnRename,
      sessionOnRenameWorkspace,
      sessionOnRestore,
      sessionOnSearch,
      state.activeSessionId,
      state.pendingSession,
      state.archivedSessions,
      state.sessionRestore,
      state.permissions,
      state.questions,
      state.drawer,
      state.sessions,
      state.workspaces,
    ],
  )
  const headerOnNewSession = useStableCallback((): void => {
    void beginNewDraft(
      active?.workspaceId ?? state.pendingSession?.workspaceId ?? state.workspaces[0]?.id,
    ).catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : t('app.error.createSession')),
    )
  })
  const headerOnOpenSettings = useStableCallback((): void => {
    store.setDrawer('settings')
  })
  const headerOnOpenSchedules = useStableCallback((): void => {
    store.setDrawer('schedules')
  })
  const getScheduleLinkedSession = useStableCallback((sessionId: string) => {
    const current = store.getState()
    return resolveScheduleSessionLink(
      sessionId,
      current.backend.kind === 'connected' ? (current.sessionDirectoryStatus ?? 'loading') : 'loading',
      current.sessions,
      current.workspaces,
      current.archivedSessionIds,
    )
  })
  const scheduleOnOpenLinkedSession = useStableCallback((sessionId: string): void => {
    const current = store.getState()
    if (current.backend.kind !== 'connected') return
    if (
      resolveScheduleSessionLink(
        sessionId,
        current.sessionDirectoryStatus ?? 'loading',
        current.sessions,
        current.workspaces,
        current.archivedSessionIds,
      ).status !== 'available'
    )
      return
    discardAttachmentDrafts()
    void store
      .openSession(sessionId)
      .then(() => {
        if (store.getState().drawer === 'schedules') store.setDrawer(undefined)
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.openSession')),
      )
  })
  const scheduleOnStartSession = useStableCallback(async (prompt: string): Promise<string> => {
    await store.createSession(active?.workspaceId ?? state.workspaces[0]?.id)
    const sessionId = store.getState().activeSessionId
    if (sessionId === undefined) throw new Error(t('schedules.createSessionFailed'))
    const turn = store.watchSessionTurnEnd(sessionId)
    try {
      try {
        await store.sendPrompt(sessionId, prompt, [], 'queue')
      } catch (reason) {
        if (isDefinitePromptRejection(reason)) throw reason
        // A transport failure can arrive after the Host admitted the prompt.
        // Keep this creation locked until the Session proves the turn ended.
      }
      await turn.completion
      return sessionId
    } catch (reason) {
      if (reason instanceof Error && reason.name === 'SessionTurnWatchDisposedError') {
        const uncertain = new Error('The schedule creation turn ended without a terminal Session event.')
        const indeterminate = uncertain as Error & { scheduleCreateIndeterminate?: boolean }
        indeterminate.scheduleCreateIndeterminate = true
        throw uncertain
      }
      throw reason
    } finally {
      turn.dispose()
    }
  })
  const openAccountPageFromSettings = useStableCallback((page: 'usage' | 'top-up'): void => {
    void store.openAccountPage(page).catch(() => setError(t('account.profile.failed')))
  })
  const loadAccountDetailsFromSettings = useStableCallback((): Promise<void> => store.loadAccountDetails())
  const acknowledgeAccountBonusFromSettings = useStableCallback((orderId: string): Promise<boolean> =>
    store.acknowledgeAccountBonus(orderId),
  )
  const closeConversationActions = useCallback((): void => {
    setLocaleOpen(false)
  }, [])
  const toggleExport = useCallback((): void => {
    if (visibleExportSessionId !== undefined) {
      setExportOpen(false)
      return
    }
    if (activeSessionId === undefined) return
    setExportSessionId(activeSessionId)
    setExportOpen(true)
  }, [activeSessionId, visibleExportSessionId])
  const activeId = active?.id
  const conversationActionItems = useMemo<ReactElement | null>(() => {
    if (activeId === undefined) return null
    return (
      <>
        {/* The keys reset popover state when the last entry disappears,
        so a refilled catalog never reopens stale. */}
        {(state.unavailableLists?.length ?? 0) > 0 ? (
          <div role="alert">
            {t('app.listsUnavailable', {
              lists: state
                .unavailableLists!.map(
                  (key) =>
                    ({
                      queue: t('lists.queue'),
                      goals: t('lists.goals'),
                      jobs: t('lists.jobs'),
                      checkpoints: t('lists.checkpoints'),
                      templates: t('lists.templates'),
                    })[key] ?? key,
                )
                .join(', '),
            })}
          </div>
        ) : null}
        <DeferredJobsDrawer
          key={state.jobs.length > 0 ? 'jobs' : 'jobs-empty'}
          jobs={state.jobs}
          jobControllerAvailable={state.jobControllerAvailable}
          following={state.jobFollow}
          onFollow={(jobId) => store.followJob(jobId)}
          onStopFollowing={() => store.stopFollowingJob()}
          onKill={(jobId) => store.killJob(jobId)}
        />
        {codingToolsEnabled ? (
          <DeferredChangesDrawer
            key={`changes-${activeId}`}
            changes={state.changes}
            loading={state.changesLoading}
            refreshFailed={state.changesRefreshFailed}
            onRefresh={() => store.refreshChanges(activeId)}
            onOpen={(changeId) => store.openChange(changeId)}
            onDetail={(changeId) => store.getChangeDetail(changeId)}
            onMarkReviewed={(changeId, reviewState) => store.markChangeReviewed(changeId, reviewState)}
          />
        ) : null}
        <DeferredTasksDrawer
          key={`tasks-${activeId}`}
          tasks={state.tasks}
          loading={state.tasksLoading}
          scope={state.taskScope}
          complete={state.tasksComplete}
          omittedSessions={state.tasksOmittedSessions}
          alwaysVisible
          onRefresh={() => store.refreshTasks(activeId, false, state.taskScope)}
          onScopeChange={(scope) => store.refreshTasks(activeId, false, scope)}
          onOpen={async (task) => {
            if (task.sessionId === undefined) return
            // A subagent row names the child in `sourceId`; `sessionId` is its
            // parent. The store resolves the child through whichever catalog
            // actually lists it, so a workspace-scoped row stays openable while
            // a different conversation is on screen.
            await store.openSession(task.kind === 'subagent' ? task.sourceId : task.sessionId)
          }}
          onStop={async (task) => {
            await store.stopTask(task.taskId, task.taskRevision)
            await store.refreshTasks(activeId, false, state.taskScope)
          }}
          onAnswer={async (task, answer) => {
            if (task.interactionId === undefined) return
            await store.answerTask(task.taskId, task.interactionId, answer)
            await store.refreshTasks(activeId, false, state.taskScope)
          }}
        />
        <DeferredCheckpointDrawer
          key={`checkpoints-${activeId}`}
          checkpoints={state.checkpoints}
          loading={state.checkpointsLoading}
          onRefresh={() => store.refreshCheckpoints(activeId)}
          onCreate={(label) => store.createCheckpoint(label)}
          onPreview={(checkpointId) => store.previewCheckpoint(checkpointId)}
          onDelete={(checkpointId) => store.deleteCheckpoint(checkpointId)}
          onRestore={(checkpointId, previewId, conflictPolicy) =>
            store.restoreCheckpoint(checkpointId, previewId, conflictPolicy)
          }
        />
        <DeferredPromptTemplatesDrawer
          onOpenLink={timelineOnOpenLink}
          key={`prompt-templates-${activeId}`}
          templates={state.promptTemplates}
          loading={state.promptTemplatesLoading}
          onRefresh={() => store.refreshPromptTemplates(activeId)}
          onRead={(templateId) => store.readPromptTemplate(templateId)}
          onInsert={(templateId, variables) => store.insertPromptTemplate(templateId, variables)}
          onCreate={(draft) => store.createPromptTemplate(draft)}
          onUpdate={(templateId, patch) => store.updatePromptTemplate(templateId, patch)}
          onDelete={(templateId) => store.deletePromptTemplate(templateId)}
          onApply={(text) => {
            setDraft((current) => (current.trim() === '' ? text : `${current}\n\n${text}`))
            setError(undefined)
          }}
        />
        <DeferredSubagentDrawer
          key={`subagents-${activeId}`}
          parentSessionId={activeId}
          catalog={state.subagents}
          summaries={state.sessions}
          onLoadChildren={(sessionId) => store.loadSubagentChildren(sessionId)}
          onOpenChild={(entry, parentAvailable) => {
            // rc.6 requires already-durable image blocks and therefore does
            // not advertise inline subagent image prompts. Alpha hosts do;
            // preserve those opaque drafts across child navigation.
            if (!state.subagentImagePrompts) discardAttachmentDrafts()
            void store
              .openSubagent(entry, parentAvailable)
              .catch((reason: unknown) =>
                setError(reason instanceof Error ? reason.message : t('app.error.openSubagent')),
              )
          }}
        />
        <DeferredDiagnosticsDrawer
          key={`diagnostics-${activeId}`}
          onRead={() => store.readDiagnostics()}
          onReconnect={() => store.reconnect()}
          onShowOutput={() => store.showDiagnostics()}
        />
        {codingToolsEnabled && dshEventCount > 0 ? (
          <ConversationEventToggle
            count={dshEventCount}
            pressed={showDshEvents}
            onPressedChange={setShowDshEvents}
          />
        ) : null}
        {activeSubagent === undefined ? (
          <button
            type="button"
            className="dsh-conversation__export-trigger"
            aria-expanded={visibleExportSessionId !== undefined}
            onClick={toggleExport}
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
            <div className="dsh-conversation__locale-menu" role="listbox" aria-label={t('locale.label')}>
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
                    applyLocale(option)
                    setLocaleOpen(false)
                  }}
                >
                  {option === 'zh' ? t('locale.chinese') : t('locale.english')}
                </button>
              ))}
            </div>
          ) : null}
        </span>
      </>
    )
  }, [
    activeId,
    activeSubagent,
    discardAttachmentDrafts,
    dshEventCount,
    locale,
    localeOpen,
    applyLocale,
    setError,
    setDraft,
    setShowDshEvents,
    toggleExport,
    visibleExportSessionId,
    state.changes,
    state.changesLoading,
    state.changesRefreshFailed,
    state.checkpoints,
    state.checkpointsLoading,
    state.unavailableLists,
    state.jobs,
    state.jobControllerAvailable,
    state.jobFollow,
    timelineOnOpenLink,
    state.promptTemplates,
    state.promptTemplatesLoading,
    state.sessions,
    state.subagentImagePrompts,
    state.subagents,
    state.tasks,
    state.tasksLoading,
    state.taskScope,
    state.tasksComplete,
    state.tasksOmittedSessions,
    store,
    t,
    codingToolsEnabled,
    showDshEvents,
  ])
  return (
    <AppErrorBoundary>
      <main className="dsh-app" data-dsh-theme={themePreference}>
        <DeferredSettingsDrawer
          key={settingsDrawerVersionKey}
          open={state.drawer === 'settings'}
          onOpenChange={(open) => store.setDrawer(open ? 'settings' : undefined)}
          connected={backend.kind === 'connected'}
          connectedDshVersion={state.connectedDshVersion}
          onConfigureConnection={(mode, endpoint) => store.configureConnection(mode, endpoint)}
          dshUpdate={state.dshUpdate}
          dshUpdateProgress={state.dshUpdateProgress}
          onCheckDshUpdates={(force) => store.checkDshUpdates(force)}
          onInstallDshVersion={(version) => store.installDshVersion(version)}
          theme={themePreference}
          onThemeChange={setThemePreference}
          locale={locale}
          onLocaleChange={applyLocale}
          onLocaleFromDsh={adoptExplicitLocaleFromDsh}
          conversationFontSize={conversationFontSize}
          onConversationFontSizeChange={setConversationFontSize}
          providers={state.providers}
          models={state.models}
          onLoadSettings={() => store.readSettings()}
          onLoadDshSettings={readDshSettingsForUi}
          onOpenDshSettingsDocument={() => store.openDshSettingsDocument()}
          onOpenKeyboardShortcuts={() => store.openKeyboardShortcuts()}
          onUpdateDshSetting={updateDshSettingFromDrawer}
          onUnsetDshSetting={unsetDshSettingFromDrawer}
          onMutateDshSettings={mutateDshSettingsFromDrawer}
          onCreateCustomProvider={(draft) => store.createCustomProvider(draft)}
          onDiscoverModels={(input) => store.discoverModels(input)}
          onDiscoverCustomModels={(input) => store.discoverCustomProviderModels(input)}
          onConfigureSecret={(providerId, field) => store.configureProviderSecret(providerId, field)}
          onRemoveSecret={(providerId, field) => store.removeProviderSecret(providerId, field)}
          onConfigurePluginCredential={(ref) => store.configurePluginCredential(ref)}
          onRemovePluginCredential={(ref) => store.removePluginCredential(ref)}
          onRefreshCatalog={() => store.refreshModelCatalog()}
          onLoadPresetRoster={() => store.loadPresetRoster()}
          onReadPresetDocument={(presetId) => store.readPresetDocument(presetId)}
          onCopyPreset={(from, presetId, name) => store.copyPreset(from, presetId, name)}
          onRemovePreset={(presetId) => store.removePreset(presetId)}
          onOpenPresetDocument={(presetId) => store.openPresetDocument(presetId)}
          onStartCreatorDraft={async () => {
            store.setDrawer(undefined)
            discardAttachmentDrafts()
            setDraft('')
            try {
              // DSH only lets a preset be chosen while the session is still blank, and
              // `agentPreset` is a host projection: staging it locally would show a mode
              // the host never confirmed, so create the session with the preset instead.
              await store.createSession(undefined, 'cordis')
            } catch (reason: unknown) {
              setError(reason instanceof Error ? reason.message : t('app.error.createSession'))
            }
          }}
          pluginInventoryRevision={store.pluginInventoryRevision}
          pluginInstallProgress={store.pluginInstallProgress}
          pluginInstallOperation={state.pluginInstallOperation}
          onStartPluginInstall={(input) => store.startPluginInstall(input)}
          onCancelPluginInstall={() => store.cancelPluginInstall()}
          onRecoverPluginInstall={() => store.recoverPluginInstall()}
          onLoadPluginInventory={() => store.loadPluginInventory()}
          featureRequest={store.featureRequest}
          accountLifecycleAvailable={state.accountLifecycleAvailable}
          accountLifecycle={state.accountLifecycle}
          accountLifecycleLoading={state.accountLifecycleLoading}
          accountLifecycleBusy={state.accountLifecycleBusy}
          {...(state.accountLifecycleImpact === undefined
            ? {}
            : { accountLifecycleImpact: state.accountLifecycleImpact })}
          accountSessionExpired={state.accountSessionExpired}
          {...(state.accountLifecycleError === undefined
            ? {}
            : { accountLifecycleError: state.accountLifecycleError })}
          accountLifecycleRequestFailed={state.accountLifecycleRequestFailed}
          accountProfileDetails={state.accountProfileDetails}
          accountProfileLoading={state.accountProfileLoading}
          accountProfileRequestFailed={state.accountProfileRequestFailed}
          onLoadAccountLifecycle={() => store.loadAccountLifecycle()}
          onStartAccountSignIn={() => store.startAccountSignIn()}
          onCancelAccountSignIn={(attemptId) => store.cancelAccountSignIn(attemptId)}
          onCheckAccountSignOutImpact={() => store.checkAccountSignOutImpact()}
          onSignOutAccount={() => store.signOutAccount()}
          onLoadAccountDetails={loadAccountDetailsFromSettings}
          onAcknowledgeAccountBonus={acknowledgeAccountBonusFromSettings}
          onOpenAccountPage={openAccountPageFromSettings}
        />
        <ScheduleDrawer
          open={state.drawer === 'schedules'}
          onClose={() => store.setDrawer(undefined)}
          featureRequest={store.featureRequest}
          subscribeFeature={store.subscribeFeature}
          onStartScheduleSession={scheduleOnStartSession}
          getLinkedSession={getScheduleLinkedSession}
          onOpenLinkedSession={scheduleOnOpenLinkedSession}
          connectionEpoch={state.connectionEpoch ?? 0}
        />
        {runtimeUpdateVisible ? (
          <div className="dsh-app__runtime-update dsh-toast" role="status">
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
            className={`dsh-app__connection-alert dsh-toast${compatibilityWarning === undefined ? '' : ' dsh-app__connection-alert--warning'}`}
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
              onRetry={retryConnection}
              onOpenSettings={() => store.setDrawer('settings')}
              onReadDiagnostics={() => store.readDiagnostics()}
              onReconnectDiagnostics={() => store.reconnect()}
              onShowDiagnosticsOutput={() => store.showDiagnostics()}
            />
          ) : (
            <>
              {backend.kind === 'connected' &&
              active === undefined &&
              state.sessions.length === 0 &&
              state.workspaces.length > 0 &&
              welcomeVisible ? (
                <div className="dsh-welcome-notice dsh-toast" role="status">
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
              {active === undefined && state.pendingSession !== undefined ? (
                <section
                  className="dsh-conversation"
                  data-conversation-font-size={conversationFontSize}
                  aria-label={t('app.createSession')}
                >
                  <div className="dsh-conversation__topbar">
                    <AppHeader
                      runtime={backend}
                      connectedDshVersion={state.connectedDshVersion}
                      compatibilityWarning={compatibilityWarning}
                      sessionControl={sessionControl}
                      onNewSession={headerOnNewSession}
                      onOpenSchedules={headerOnOpenSchedules}
                      onOpenSettings={headerOnOpenSettings}
                      onRetryConnection={retryConnection}
                    />
                  </div>
                  <div className="dsh-app__empty">
                    <EmptyState title={t('app.createSession')} description={t('app.workspacePickerHint')} />
                  </div>
                  <div className="dsh-compose-area">
                    <Composer
                      key={state.pendingSession.revision}
                      disabled={backend.kind !== 'connected'}
                      running={false}
                      draft={draft}
                      attachments={attachments}
                      configuration={state.pendingSession.configuration}
                      models={state.models}
                      presets={state.presets}
                      presetMutable
                      {...(newSessionPresetSelectionEnabled === undefined
                        ? {}
                        : { presetSelectionEnabled: newSessionPresetSelectionEnabled })}
                      onConfigurationChange={(configuration) => store.configurePendingSession(configuration)}
                      onDraftChange={setDraft}
                      onPickAttachment={composerOnPickAttachment}
                      onIngestFiles={composerOnIngestFiles}
                      openFileCandidates={EMPTY_OPEN_FILE_CANDIDATES}
                      openFilePickerOpen={false}
                      openFilePickerLoading={false}
                      attachedOpenFileIds={[]}
                      onToggleOpenFilePicker={() => undefined}
                      onSelectOpenFile={() => undefined}
                      onRemoveAttachment={composerOnRemoveAttachment}
                      onSubmit={composerOnSubmit}
                      onCancel={() => undefined}
                      onSteerQueue={() => undefined}
                      queue={[]}
                    />
                  </div>
                </section>
              ) : active === undefined ? (
                <>
                  {sessionControl}
                  <div className="dsh-app__empty">
                    {backend.kind === 'connected' && state.workspaces.length > 0 ? (
                      <EmptySessionPosture
                        workspaces={state.workspaces}
                        presets={state.presets}
                        {...(newSessionPresetSelectionEnabled === undefined
                          ? {}
                          : { presetSelectionEnabled: newSessionPresetSelectionEnabled })}
                        empty={state.sessions.length === 0}
                        onCreate={(workspaceId, presetId) => {
                          void beginNewDraft(workspaceId, presetId).catch((reason: unknown) =>
                            setError(reason instanceof Error ? reason.message : t('app.error.createSession')),
                          )
                        }}
                      />
                    ) : (
                      <RuntimeConnectionView
                        state={backend}
                        loadingSessionCatalog={backend.kind === 'connected'}
                        onRetry={retryConnection}
                        onOpenSettings={() => store.setDrawer('settings')}
                        onReadDiagnostics={() => store.readDiagnostics()}
                        onReconnectDiagnostics={() => store.reconnect()}
                        onShowDiagnosticsOutput={() => store.showDiagnostics()}
                      />
                    )}
                  </div>
                </>
              ) : (
                <section
                  className="dsh-conversation"
                  data-conversation-font-size={conversationFontSize}
                  {...(hostConversationFontSizePx === undefined
                    ? {}
                    : { 'data-conversation-font-size-px': hostConversationFontSizePx })}
                  {...(conversationFontStyle === undefined ? {} : { style: conversationFontStyle })}
                  aria-label={active.title.trim() === '' ? t('app.conversation') : active.title}
                >
                  <div className="dsh-conversation__topbar">
                    <div
                      className="dsh-conversation__views"
                      role="tablist"
                      aria-label={t('app.conversationView')}
                    >
                      <button
                        id={CONVERSATION_VIEW_IDS.chat.tab}
                        data-conversation-view="chat"
                        className={`dsh-conversation__view-tab${
                          conversationView === 'chat' ? ' dsh-conversation__view-tab--active' : ''
                        }`}
                        type="button"
                        role="tab"
                        aria-selected={conversationView === 'chat'}
                        aria-controls={CONVERSATION_VIEW_IDS.chat.panel}
                        tabIndex={conversationView === 'chat' ? 0 : -1}
                        onKeyDown={onConversationTabKeyDown}
                        onClick={() => setConversationView('chat')}
                      >
                        {t('app.chat')}
                      </button>
                      {codingToolsEnabled ? (
                        <button
                          id={CONVERSATION_VIEW_IDS.trajectory.tab}
                          data-conversation-view="trajectory"
                          className={`dsh-conversation__view-tab${
                            conversationView === 'trajectory' ? ' dsh-conversation__view-tab--active' : ''
                          }`}
                          type="button"
                          role="tab"
                          aria-selected={conversationView === 'trajectory'}
                          aria-controls={CONVERSATION_VIEW_IDS.trajectory.panel}
                          tabIndex={conversationView === 'trajectory' ? 0 : -1}
                          onKeyDown={onConversationTabKeyDown}
                          onClick={() => setConversationView('trajectory')}
                        >
                          {t('app.trajectory')}
                        </button>
                      ) : null}
                    </div>
                    <AppHeader
                      runtime={backend}
                      connectedDshVersion={state.connectedDshVersion}
                      compatibilityWarning={compatibilityWarning}
                      sessionControl={sessionControl}
                      onNewSession={headerOnNewSession}
                      onOpenSchedules={headerOnOpenSchedules}
                      onOpenSettings={headerOnOpenSettings}
                      onRetryConnection={retryConnection}
                    />
                    {activeSubagent !== undefined || active.parentSessionId !== undefined ? (
                      <SessionLineage
                        active={active}
                        {...(lineageActiveSubagent === undefined
                          ? {}
                          : { activeSubagent: lineageActiveSubagent })}
                        sessions={state.sessions}
                        onOpenSession={lineageOnOpenSession}
                      />
                    ) : null}
                    <ConversationActionsMenu onClose={closeConversationActions}>
                      {conversationActionItems}
                    </ConversationActionsMenu>
                  </div>
                  {visibleExportSessionId === undefined ? null : (
                    <DeferredExportDialog
                      sessionId={visibleExportSessionId}
                      onExport={(options) => {
                        setExportOpen(false)
                        void store
                          .exportSession(options)
                          .catch((reason: unknown) =>
                            setError(reason instanceof Error ? reason.message : t('export.failed')),
                          )
                      }}
                    />
                  )}
                  {state.goals.length > 0 ? (
                    <>
                      <GoalBar goals={state.goals} onUpdate={goalOnUpdate} onClear={goalOnClear} />
                      <GoalTodoStrip goals={state.goals} />
                    </>
                  ) : null}
                  {conversationView === 'chat' ? (
                    <DeferredTimeline
                      sessionId={active.id}
                      panelId={CONVERSATION_VIEW_IDS.chat.panel}
                      panelLabelledBy={CONVERSATION_VIEW_IDS.chat.tab}
                      nodes={state.timeline.nodes}
                      {...(state.timeline.nodeChangeStart === undefined
                        ? {}
                        : { nodeChangeStart: state.timeline.nodeChangeStart })}
                      {...(state.timeline.nodeChangeBase === undefined
                        ? {}
                        : { nodeChangeBase: state.timeline.nodeChangeBase })}
                      streaming={streaming}
                      showDshEvents={showDshEvents}
                      transcriptView={transcriptView}
                      performanceUsage={performanceUsage}
                      codingToolsEnabled={codingToolsEnabled}
                      running={activeRunning}
                      {...(state.timeline.activeTurn === undefined
                        ? {}
                        : { activeTurn: state.timeline.activeTurn })}
                      assistantLabel={assistantLabel}
                      {...(activeSubagent === undefined ? { onBranch: timelineOnBranch } : {})}
                      branching={branching}
                      onOpenLink={timelineOnOpenLink}
                      onLoadImage={timelineOnLoadImage}
                      onShowInFolder={timelineOnShowInFolder}
                      onOpenSession={timelineOnOpenSession}
                      feedback={state.feedback}
                      feedbackUnavailable={state.feedbackUnavailable}
                      hasMoreHistory={state.historyHasMore}
                      loadingOlderHistory={state.historyLoading}
                      onLoadOlderHistory={timelineOnLoadOlderHistory}
                      onFeedback={timelineOnFeedback}
                      onFeedbackPrepare={timelineOnFeedbackPrepare}
                      onFeedbackSubmit={timelineOnFeedbackSubmit}
                    />
                  ) : (
                    <DeferredTrajectoryView
                      sessionId={active.id}
                      panelId={CONVERSATION_VIEW_IDS.trajectory.panel}
                      panelLabelledBy={CONVERSATION_VIEW_IDS.trajectory.tab}
                      nodes={state.timeline.nodes}
                      {...(state.timeline.nodeChangeStart === undefined
                        ? {}
                        : { nodeChangeStart: state.timeline.nodeChangeStart })}
                      {...(state.timeline.nodeChangeBase === undefined
                        ? {}
                        : { nodeChangeBase: state.timeline.nodeChangeBase })}
                      streaming={streaming}
                    />
                  )}
                  <QueuePanel
                    items={state.queue}
                    running={activeRunning}
                    onEdit={queueOnEdit}
                    onRemove={queueOnRemove}
                    onModeChange={queueOnModeChange}
                    onLoadImage={timelineOnLoadImage}
                  />
                  {pendingPermissions.length > 0 || pendingQuestions.length > 0 ? (
                    <div className="dsh-conversation__interactions" aria-live="polite">
                      {pendingPermissions.map(({ request, command }) => (
                        <ApprovalCard
                          key={request.id}
                          request={request}
                          disabled={respondingInteractionId !== undefined}
                          {...(command === undefined ? {} : { command })}
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
                  ) : null}
                  <div className="dsh-compose-area">
                    <TodoList key={active?.id ?? 'todo-list'} todos={state.todos} />
                    {pendingPermissions.length === 0 && pendingQuestions.length === 0 ? (
                      subagentReadOnlyReason === undefined || activeRunning ? (
                        <>
                          <Composer
                            disabled={backend.kind !== 'connected'}
                            inputDisabled={
                              subagentReadOnlyReason !== undefined ||
                              (activeSubagent !== undefined && activeSubagentState?.parentAvailable === false)
                            }
                            attachmentsDisabled={activeSubagent !== undefined && !state.subagentImagePrompts}
                            running={activeRunning}
                            draft={draft}
                            attachments={attachments}
                            {...(activeSubagent === undefined
                              ? {
                                  editorContext: state.editorContext,
                                  editorContextAvailableKinds: state.editorContextAvailableKinds,
                                  editorContextLoading: state.editorContextLoading,
                                  onCaptureEditorContext: composerOnCaptureEditorContext,
                                  onRemoveEditorContext: composerOnRemoveEditorContext,
                                  onPreviewEditorContext: composerOnPreviewEditorContext,
                                }
                              : {})}
                            configuration={state.configuration}
                            models={sessionModels}
                            modelFailures={sessionModelFailures}
                            modelLoading={sessionModelDirectoryLoading}
                            {...(sessionModelCurrent === undefined
                              ? {}
                              : { modelCurrent: sessionModelCurrent })}
                            {...(sessionModelDirectoryError === undefined
                              ? {}
                              : { modelError: sessionModelDirectoryError })}
                            onModelRetry={composerOnModelRetry}
                            {...(sessionModelRoutable === undefined
                              ? {}
                              : { modelRoutable: sessionModelRoutable })}
                            presets={state.presets}
                            {...(newSessionPresetSelectionEnabled === undefined
                              ? {}
                              : { presetSelectionEnabled: newSessionPresetSelectionEnabled })}
                            permissionPresets={state.permissionPresets}
                            commands={state.commands}
                            popupSelects={popupSelects}
                            references={visibleReferenceCandidates}
                            referenceLoading={visibleReferenceLoading}
                            {...(imageLimits === undefined ? {} : { imageLimits })}
                            busyEnter={readyDshUiPreferences?.busyEnter ?? state.busyEnter}
                            modelPickerOpenRequest={modelPickerOpenRequest}
                            {...(estimatedContextTokens === undefined ? {} : { estimatedContextTokens })}
                            {...(contextWindowTokens === undefined ? {} : { contextWindowTokens })}
                            {...(contextPressure?.breakdown === undefined
                              ? {}
                              : { contextBreakdown: contextPressure.breakdown })}
                            promptMode={state.promptMode}
                            configurationDisabled={backend.kind !== 'connected' || activeRunning}
                            presetMutable={
                              activeSubagent === undefined && active.blank && active.status === 'idle'
                            }
                            onConfigurationChange={composerOnConfigurationChange}
                            onPromptModeChange={composerOnPromptModeChange}
                            onCommand={composerOnCommand}
                            onOpenSkillDocument={(skillId) => {
                              void store
                                .openSkillDocument(active.id, skillId)
                                .catch((reason: unknown) =>
                                  setError(
                                    reason instanceof Error
                                      ? reason.message
                                      : t('commands.openSkillDocumentFailed'),
                                  ),
                                )
                            }}
                            onPopupSelect={composerOnPopupSelect}
                            onCommandQueryChange={composerOnCommandQueryChange}
                            onReferenceQueryChange={composerOnReferenceQueryChange}
                            onDraftChange={setDraft}
                            onPickAttachment={composerOnPickAttachment}
                            onIngestFiles={composerOnIngestFiles}
                            attachmentPreviews={attachmentPreviews}
                            attachmentPreviewFailures={attachmentPreviewFailures}
                            openFileCandidates={visibleOpenFileCandidates}
                            openFilePickerOpen={visibleOpenFilePickerOpen}
                            openFilePickerLoading={visibleOpenFilePickerLoading}
                            {...(state.preferredOpenFileId === undefined
                              ? {}
                              : { preferredOpenFileId: state.preferredOpenFileId })}
                            attachedOpenFileIds={attachedOpenFileIds}
                            {...(attachingOpenFileId === undefined ? {} : { attachingOpenFileId })}
                            onToggleOpenFilePicker={composerOnToggleOpenFilePicker}
                            onExtrasOpenChange={composerOnExtrasOpenChange}
                            onSelectOpenFile={composerOnSelectOpenFile}
                            onRemoveAttachment={composerOnRemoveAttachment}
                            onSubmit={composerOnSubmit}
                            onCancel={composerOnCancel}
                            onSteerQueue={composerOnSteerQueue}
                            queue={state.queue}
                          />
                          <div className="dsh-composer__status">{composerStatus}</div>
                        </>
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
                    ) : null}
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
