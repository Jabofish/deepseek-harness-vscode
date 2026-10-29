import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
  PromptAttachment,
  PromptMode,
  SessionSummary,
  RunningInputMode,
} from '@dsh-vscode/domain'
import { cacheHitRate } from '@dsh-vscode/timeline'
import { StatsLine } from './features/chat/StatsLine.js'
import { BillingCost } from './features/billing/BillingCost.js'
import { SessionDrawer } from './features/sessions/SessionDrawer.js'
import { useScheduleSessionActions } from './app/useScheduleSessionActions.js'
import { usePendingInteractions } from './app/usePendingInteractions.js'
import { CONVERSATION_VIEW_IDS } from './app/conversation-view-ids.js'
import { ConversationActionItems } from './features/shell/ConversationActionItems.js'
import { createAppStore, type AppState, type AppStore } from './app/store.js'
import { sameShallowSelection, useAppStoreSelector } from './app/useAppStoreSelector.js'
import { selectAppViewState, APP_VIEW_SUBSCRIPTION } from './app/store/view-state.js'
import { selectSessionModels } from './app/store/model-directory-state.js'
import { activateDraftOwner, clearDraftIf, readDraft, resetDraft } from './app/draft-store.js'
import { publicProtocolErrorMessage } from './app/protocol-client.js'
import { useDshSettings } from './app/useDshSettings.js'
import { useComposerAttachments } from './app/useComposerAttachments.js'
import { welcomeWasDismissed, dismissedRuntimeUpdateVersionFromStorage } from './app/dismissed-notices.js'
import { resolveAssistantModelLabel } from './app/model-label.js'
import { useStableCallback } from './app/useStableCallback.js'
import { MOVETO_COMMAND_NAME, isMovetoCommandLine } from './app/client-commands.js'
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
import { hasVsCodeApi } from './vscode-api.js'
import { PopupSelectRegistry } from './features/commands/popupSelectRegistry.js'

const ERROR_TOAST_DISMISS_MS = 8_000

// The view contract is inferred from this hook so the component props stay
// synchronized with the controller's strongly typed values.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const useAppControllerImpl = () => {
  const { locale, setLocale, adoptLocaleFromHost, t } = useI18n()
  const store = useMemo(() => createAppStore(), [])
  const mountedRef = useRef(true)
  const initializedStoreRef = useRef<AppStore | undefined>(undefined)
  const disposeTimerRef = useRef<number | undefined>(undefined)
  const popupSelects = useMemo(() => new PopupSelectRegistry(), [])
  const state = useAppStoreSelector(store, selectAppViewState, sameShallowSelection, APP_VIEW_SUBSCRIPTION)
  useEffect(() => {
    mountedRef.current = true
    // A remount (error-boundary recovery, test render) must not inherit the
    // previous mount's composer text.
    resetDraft()
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
  useEffect(() => {
    let previous: { readonly message: string } | undefined
    const publishFailure = (): void => {
      const next = store.getState().surfaceError
      if (next !== undefined && next !== previous) setError(next.message)
      previous = next
    }
    const unsubscribe = store.subscribe(publishFailure, ['surfaceError'])
    let retired = false
    queueMicrotask(() => {
      if (!retired) publishFailure()
    })
    return () => {
      retired = true
      unsubscribe()
    }
  }, [store, setError])
  const [welcomeVisible, setWelcomeVisible] = useState(() => !welcomeWasDismissed())
  const [dismissedRuntimeUpdateVersion, setDismissedRuntimeUpdateVersion] = useState(() =>
    dismissedRuntimeUpdateVersionFromStorage(),
  )
  const [dismissedConnection, setDismissedConnection] = useState<string | undefined>()
  const [modelPickerOpenRequest, setModelPickerOpenRequest] = useState(0)
  const conversationActionsTriggerRef = useRef<HTMLButtonElement>(null)
  const [conversationView, setConversationView] = useState<'chat' | 'trajectory'>('chat')
  const [dshEventVisibility, setDshEventVisibility] = useState<{
    readonly sessionId: string | undefined
    readonly visible: boolean
  }>({ sessionId: undefined, visible: false })
  const [exportOpen, setExportOpen] = useState(false)
  const [exportSessionId, setExportSessionId] = useState<string | undefined>()
  const [conversationFontSize, setConversationFontSizeState] = useState<ConversationFontSize>(() =>
    readConversationFontSize(),
  )
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(() => readThemePreference())
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
    setError,
    t,
  })
  const onConversationTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const current = event.currentTarget.dataset.conversationView
    if (current !== 'chat' && current !== 'trajectory') return
    const views: readonly ('chat' | 'trajectory')[] = ['chat', 'trajectory']
    const currentIndex = views.indexOf(current)
    let nextIndex: number | undefined
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % views.length
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
  }, [])

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
  const composerOwner =
    state.pendingSession === undefined ? activeSessionId : `pending:${state.pendingSession.revision}`
  // Switch drafts before the new conversation paints, so a frame of the other
  // conversation's text can never appear in (or be submitted from) this one.
  useLayoutEffect(() => activateDraftOwner(composerOwner), [composerOwner])
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
  const {
    pendingPermissions,
    pendingQuestions,
    approvalRespondFor,
    questionRespondFor,
    questionCancelFor,
    questionWaitFor,
  } = usePendingInteractions({
    store,
    state,
    activeSessionId,
    setRespondingInteractionId,
    setError,
    t,
  })
  const assistantLabel = useAppStoreSelector(
    store,
    useCallback(
      (current: AppState) =>
        resolveAssistantModelLabel(active, current.configuration, selectSessionModels(current), t),
      [active, t],
    ),
    Object.is,
    ASSISTANT_LABEL_FIELDS,
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
    backend.kind === 'connected' &&
    (activeSubagent === undefined ? active?.status === 'running' : activeSubagent.activity === 'running')
  // The draft lives in the module-level draft store, not in App state: the
  // module functions are stable, so typing re-renders only the composer
  // binding, never App.
  const {
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
    editorContext: state.editorContext,
    mountedRef,
    draftOwner: composerOwner,
    clearDraftIf,
    readDraft,
  })
  const previousComposerOwner = useRef(composerOwner)
  useLayoutEffect(() => {
    // Superseded navigation resolves without switching the store. Clear the
    // handles only when the displayed conversation actually changes, so a
    // delayed completion cannot discard the new conversation's attachments.
    // A layout effect (not a passive one) guarantees a submit handler cannot
    // observe the previous conversation's handles after the switch paints.
    if (composerOwner === undefined || previousComposerOwner.current === composerOwner) return
    previousComposerOwner.current = composerOwner
    discardAttachmentDrafts()
  }, [composerOwner, discardAttachmentDrafts])
  // Runtime status and explicit Turn boundaries come from DSH. A settled
  // assistant step alone never closes a Turn while tools/later steps are active.
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
  /**
   * Leaving the current session must not cost the user the prompt they were
   * writing. The composer's draft and its attachment chips belong to the
   * session on screen, so they are only dropped once the Host has confirmed
   * the navigation: an open that fails (a disconnected or restarted DSH after
   * the store's bounded retries) leaves the user exactly where they were, and
   * the draft has to survive with them. Releasing the attachment handles first
   * would also be irreversible — they are host-side resources.
   *
   * Declared here, ahead of `timelineOnOpenSession`, because both echo it.
   */
  const sessionOnOpen = useStableCallback((sessionId: string): void => {
    void store
      .openSession(sessionId)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.openSession')),
      )
  })
  const sessionOnOpenInEditor = useStableCallback((sessionId: string): void => {
    // The Host owns the tab: it either creates one for the session or reveals
    // the existing tab, so this stays a request rather than local navigation.
    void store
      .openSessionInEditor(sessionId)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.openSession')),
      )
  })
  const timelineOnOpenSession = useStableCallback((sessionId: string): void => {
    sessionOnOpen(sessionId)
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
    sessionOnOpen(sessionId)
  })
  const goalOnUpdate = useStableCallback(
    (goalId: string, update: Partial<Pick<GoalView, 'title' | 'status' | 'maxGoalRounds'>>) =>
      store.updateGoal(goalId, update),
  )
  const goalOnClear = useStableCallback((goalId: string) => store.clearGoal(goalId))
  const queueOnEdit = useStableCallback((inputId: string, text: string): Promise<void> =>
    // The queue editor waits for this acceptance before treating its draft as
    // committed, so the rejection must propagate after the banner is set.
    store.updateQueue(inputId, text).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : t('app.error.editQueue'))
      throw reason
    }),
  )
  const queueOnRemove = useStableCallback((inputId: string): Promise<void> =>
    store.removeQueue(inputId).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : t('app.error.removeQueue'))
      throw reason
    }),
  )
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
  const beginNewDraft = useStableCallback((workspaceId?: string, presetId?: string): Promise<void> => {
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
  const composerOnCommand = useStableCallback(
    async (
      command: string,
      commandAttachments: readonly PromptAttachment[] = [],
      signal?: AbortSignal,
    ): Promise<void> => {
      // Client-owned commands run before the session guard: moving the chat back
      // to the side bar must work even when no session is selected.
      if (isMovetoCommandLine(command)) {
        if (commandAttachments.length > 0)
          throw new Error(t('app.error.commandImagesUnsupported', { command: MOVETO_COMMAND_NAME }))
        const outcome = await store.runMovetoCommand(command)
        if (outcome === 'unknown-target' || outcome === 'no-session') {
          // `onCommand`'s rejection is swallowed by the composer's in-flight
          // latch, so the reason is raised on the error surface as well; the
          // rejection keeps the draft so the target can be corrected.
          setError(
            t(outcome === 'unknown-target' ? 'commands.movetoUnknownTarget' : 'commands.movetoNoSession'),
          )
          throw new Error(`The /${MOVETO_COMMAND_NAME} command could not run: ${outcome}.`)
        }
        return
      }
      if (active === undefined) return
      if (command.trim() === '/model') {
        if (commandAttachments.length > 0)
          throw new Error(t('app.error.commandImagesUnsupported', { command: 'model' }))
        setModelPickerOpenRequest((current) => current + 1)
        return
      }
      try {
        await store.executeCommand(active.id, command, commandAttachments, signal)
        if (commandAttachments.length > 0)
          removeAttachmentDrafts(
            commandAttachments.map((attachment) => attachment.uri),
            true,
          )
      } catch (reason: unknown) {
        if (signal?.aborted !== true)
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
  // Compact performance usage hides the line entirely (rather than upstream's
  // "speed + cache only" line): on this surface the setting is a visibility
  // switch, and the composer must not reserve a row when detail is off.
  const composerStatus = useMemo(
    () =>
      performanceUsage === 'compact' ? undefined : (
        <StatsLine
          sessionId={activeSessionId}
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
          {...(activeSessionId === undefined
            ? {}
            : {
                cost: (details: boolean, inline = false) => (
                  <BillingCost
                    details={details}
                    labelOnly={inline}
                    cacheScope={String(state.connectionEpoch)}
                    key={`${state.connectionEpoch}:${activeSessionId}`}
                    request={store.featureRequest}
                    subscribe={store.subscribeFeature}
                    sessionId={activeSessionId}
                    usageKey={JSON.stringify(composerUsage ?? null)}
                  />
                ),
              })}
        />
      ),
    [
      activeSessionId,
      composerUsage,
      performanceUsage,
      sessionStats,
      state.timeline.nodeChangeBase,
      state.timeline.nodeChangeStart,
      state.timeline.nodes,
      state.connectionEpoch,
      store.featureRequest,
      store.subscribeFeature,
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
        fallbackFocusRef={conversationActionsTriggerRef}
        preferredWorkspaceId={state.pendingSession?.workspaceId}
        onOpenChange={sessionOnOpenChange}
        onOpen={sessionOnOpen}
        onOpenInEditor={sessionOnOpenInEditor}
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
      sessionOnOpenInEditor,
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
  const {
    getLinkedSession: getScheduleLinkedSession,
    onOpenLinkedSession: scheduleOnOpenLinkedSession,
    onStartSession: scheduleOnStartSession,
  } = useScheduleSessionActions({
    store,
    workspaceId: active?.workspaceId ?? state.workspaces[0]?.id,
    setError,
    t,
  })
  const openAccountPageFromSettings = useStableCallback((page: 'usage' | 'top-up'): void => {
    void store.openAccountPage(page).catch(() => setError(t('account.profile.failed')))
  })
  const loadAccountDetailsFromSettings = useStableCallback((): Promise<void> => store.loadAccountDetails())
  const acknowledgeAccountBonusFromSettings = useStableCallback((orderId: string): Promise<boolean> =>
    store.acknowledgeAccountBonus(orderId),
  )
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
  const conversationActionItems = useCallback(
    (closeMenu: () => void): ReactElement | null =>
      activeId === undefined ? null : (
        <ConversationActionItems
          activeId={activeId}
          isSubagent={activeSubagent !== undefined}
          state={state}
          store={store}
          codingToolsEnabled={codingToolsEnabled}
          dshEventCount={dshEventCount}
          showDshEvents={showDshEvents}
          setShowDshEvents={setShowDshEvents}
          visibleExportSessionId={visibleExportSessionId}
          toggleExport={toggleExport}
          closeMenu={closeMenu}
          locale={locale}
          applyLocale={applyLocale}
          timelineOnOpenLink={timelineOnOpenLink}
          discardAttachmentDrafts={discardAttachmentDrafts}
          setError={setError}
          t={t}
        />
      ),
    [
      activeId,
      activeSubagent,
      discardAttachmentDrafts,
      dshEventCount,
      locale,
      applyLocale,
      setError,
      setShowDshEvents,
      toggleExport,
      visibleExportSessionId,
      timelineOnOpenLink,
      state,
      store,
      t,
      codingToolsEnabled,
      showDshEvents,
    ],
  )
  return {
    acknowledgeAccountBonusFromSettings,
    active,
    activeRunning,
    activeSubagent,
    activeSubagentState,
    adoptExplicitLocaleFromDsh,
    applyLocale,
    approvalRespondFor,
    assistantLabel,
    attachedOpenFileIds,
    attachingOpenFileId,
    attachmentPreviewFailures,
    attachmentPreviews,
    attachments,
    backend,
    beginNewDraft,
    branching,
    busyAction,
    codingToolsEnabled,
    compatibilityWarning,
    composerOnCancel,
    composerOnCaptureEditorContext,
    composerOnCommand,
    composerOnCommandQueryChange,
    composerOnConfigurationChange,
    composerOnExtrasOpenChange,
    composerOnIngestFiles,
    composerOnPickAttachment,
    composerOnPopupSelect,
    composerOnPreviewEditorContext,
    composerOnPromptModeChange,
    composerOnReferenceQueryChange,
    composerOnRemoveAttachment,
    composerOnRemoveEditorContext,
    composerOnSelectOpenFile,
    composerOnSteerQueue,
    composerOnSubmit,
    composerOnToggleOpenFilePicker,
    composerStatus,
    connectionKey,
    connectionMessage,
    contextPressure,
    contextWindowTokens,
    conversationActionItems,
    conversationActionsTriggerRef,
    conversationFontSize,
    conversationFontStyle,
    conversationView,
    discardAttachmentDrafts,
    dismissedConnection,
    error,
    estimatedContextTokens,
    getScheduleLinkedSession,
    goalOnClear,
    goalOnUpdate,
    headerOnNewSession,
    headerOnOpenSchedules,
    headerOnOpenSettings,
    hostConversationFontSizePx,
    imageLimits,
    lineageActiveSubagent,
    lineageOnOpenSession,
    loadAccountDetailsFromSettings,
    locale,
    modelPickerOpenRequest,
    mutateDshSettingsFromDrawer,
    newSessionPresetSelectionEnabled,
    onConversationTabKeyDown,
    openAccountPageFromSettings,
    pendingPermissions,
    pendingQuestions,
    questionWaitFor,
    performanceUsage,
    popupSelects,
    questionCancelFor,
    questionRespondFor,
    queueOnEdit,
    queueOnModeChange,
    queueOnRemove,
    readDshSettingsForUi,
    readyDshUiPreferences,
    respondingInteractionId,
    retryConnection,
    runRuntimeAction,
    runtimeUpdateVersion,
    runtimeUpdateVisible,
    scheduleOnOpenLinkedSession,
    scheduleOnStartSession,
    sessionControl,
    sessionOnOpen,
    sessionOnOpenChange,
    setConversationFontSize,
    setConversationView,
    setDismissedConnection,
    setDismissedRuntimeUpdateVersion,
    setError,
    setExportOpen,
    setThemePreference,
    setWelcomeVisible,
    settingsDrawerVersionKey,
    showDshEvents,
    state,
    store,
    streaming,
    subagentReadOnlyReason,
    t,
    themePreference,
    timelineOnBranch,
    timelineOnFeedback,
    timelineOnFeedbackPrepare,
    timelineOnFeedbackSubmit,
    timelineOnLoadImage,
    timelineOnLoadOlderHistory,
    timelineOnOpenLink,
    timelineOnOpenSession,
    timelineOnShowInFolder,
    transcriptView,
    unsetDshSettingFromDrawer,
    updateDshSettingFromDrawer,
    visibleExportSessionId,
    visibleOpenFileCandidates,
    visibleOpenFilePickerLoading,
    visibleOpenFilePickerOpen,
    visibleReferenceCandidates,
    visibleReferenceLoading,
    welcomeVisible,
  }
}

export function useAppController(): ReturnType<typeof useAppControllerImpl> {
  return useAppControllerImpl()
}

const ASSISTANT_LABEL_FIELDS = ['configuration', 'sessionModels', 'models'] as const
