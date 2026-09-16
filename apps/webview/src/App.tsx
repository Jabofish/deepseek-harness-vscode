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
  AgentPresetDescriptor,
  ContextPressure,
  EditorContextKind,
  EditorContextPreview,
  FeedbackCategory,
  GoalView,
  ImageAttachmentLimits,
  MessageFeedbackRating,
  MessageImageReference,
  ModelDescriptor,
  PermissionRequest,
  PromptAttachment,
  PromptMode,
  SessionSummary,
  SessionStatsProjection,
  TokenUsage,
  UserQuestion,
  RunningInputMode,
  WorkspaceSummary,
} from '@dsh-vscode/domain'
import { isImageMediaType } from '@dsh-vscode/domain'
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
import { SessionLineage } from './features/subagents/SessionLineage.js'
import { SubagentDrawer } from './features/subagents/SubagentDrawer.js'
import { DiagnosticsDrawer } from './features/diagnostics/DiagnosticsDrawer.js'
import { SettingsDrawer } from './features/settings/SettingsDrawer.js'
import { TrajectoryView } from './features/trajectory/TrajectoryView.js'
import { AppHeader } from './features/shell/AppHeader.js'
import { ConversationActionsMenu } from './features/shell/ConversationActionsMenu.js'
import { ConversationEventToggle } from './features/shell/ConversationEventToggle.js'
import {
  createAppStore,
  type AppStore,
  type OpenFileCandidate,
  type ReferenceCandidate,
} from './app/store.js'
import {
  readConversationFontSize,
  rememberConversationFontSize,
  readThemePreference,
  rememberThemePreference,
  type ConversationFontSize,
  type ThemePreference,
} from './app/ui-preferences.js'
import { useI18n, type Locale, type Translate } from './i18n.js'
import { Icon } from './ui/Icon.js'
import { SelectMenu } from './components/common/SelectMenu.js'
import { useDismissibleLayer } from './components/common/useDismissibleLayer.js'
import { hasVsCodeApi } from './vscode-api.js'
import { PopupSelectRegistry } from './features/commands/popupSelectRegistry.js'
import {
  attachmentDraftKey,
  browserFileOrigin,
  type AttachmentDraftOrigin,
} from './features/composer/attachmentDrafts.js'

/** A pending approval with the command it asks to authorize, when resolvable. */
interface PendingApproval {
  readonly request: PermissionRequest
  readonly command?: string
}

const WELCOME_DISMISSED_KEY = 'dsh-welcome-dismissed'
const RUNTIME_UPDATE_DISMISSED_KEY = 'dsh-runtime-update-dismissed-version'

const DEFAULT_ATTACHMENT_BYTES = 8 * 1024 * 1024
const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024
const MAX_PROMPT_IMAGE_BYTES = 200 * 1024 * 1024
const EMPTY_OPEN_FILE_CANDIDATES: readonly OpenFileCandidate[] = []
const EMPTY_REFERENCE_CANDIDATES: readonly ReferenceCandidate[] = []
const EMPTY_PERMISSION_REQUESTS: readonly PendingApproval[] = []
const EMPTY_USER_QUESTIONS: readonly UserQuestion[] = []
const DSH_LOCALE_SETTING_PATH = 'locale.preference'
/** Keep host-backed child actions stable while still reading current App state. */
function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const callbackRef = useRef(callback)
  useLayoutEffect(() => {
    callbackRef.current = callback
  }, [callback])
  return useCallback((...args: Args): Result => callbackRef.current(...args), [])
}

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
  const { locale, setLocale, t } = useI18n()
  const store = useMemo(() => createAppStore(), [])
  const initializedStoreRef = useRef<AppStore | undefined>(undefined)
  const disposeTimerRef = useRef<number | undefined>(undefined)
  const popupSelects = useMemo(() => new PopupSelectRegistry(), [])
  const state = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState(),
    () => store.getState(),
  )
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<PromptAttachment[]>([])
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({})
  const [attachmentPreviewFailures, setAttachmentPreviewFailures] = useState<readonly string[]>([])
  const [openFileCandidates, setOpenFileCandidates] = useState<readonly OpenFileCandidate[]>([])
  const [openFileCandidatesSessionId, setOpenFileCandidatesSessionId] = useState<string | undefined>()
  const [openFilePickerOpen, setOpenFilePickerOpen] = useState(false)
  const [openFilePickerSessionId, setOpenFilePickerSessionId] = useState<string | undefined>()
  const [openFilePickerLoading, setOpenFilePickerLoading] = useState(false)
  const [referenceCandidates, setReferenceCandidates] = useState<readonly ReferenceCandidate[]>([])
  const [referenceLoading, setReferenceLoading] = useState(false)
  const [referenceSessionId, setReferenceSessionId] = useState<string | undefined>()
  const [referenceQuery, setReferenceQuery] = useState('')
  const [referenceQuoted, setReferenceQuoted] = useState(false)
  const [attachingOpenFileId, setAttachingOpenFileId] = useState<string | undefined>()
  const [openFileAttachmentIds, setOpenFileAttachmentIds] = useState<Record<string, string>>({})
  const attachmentDraftKeysRef = useRef<Map<string, string>>(new Map())
  const attachingOpenFileRef = useRef<string | undefined>(undefined)
  const referenceRequestRef = useRef(0)
  const openFileRequestRef = useRef(0)
  const attachmentGenerationRef = useRef(0)
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

  const onConversationTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const current = event.currentTarget.dataset.conversationView
    if (current !== 'chat' && current !== 'trajectory') return
    const views = ['chat', 'trajectory'] as const
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

  const applyLocale = useCallback(
    (next: Locale): void => {
      setLocale(next)
      if (state.backend.kind !== 'connected') return
      void store.updateDshSetting(DSH_LOCALE_SETTING_PATH, next).catch((reason: unknown) => {
        // The extension UI remains usable even when an older/read-only DSH
        // cannot persist its matching response-language preference.
        setError(reason instanceof Error ? reason.message : t('settings.updateFailed'))
      })
    },
    [setError, setLocale, state.backend.kind, store, t],
  )

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

  useEffect(() => {
    const missing = attachments.filter(
      (attachment) =>
        attachment.mimeType?.startsWith('image/') === true &&
        attachmentPreviews[attachment.uri] === undefined &&
        !attachmentPreviewFailures.includes(attachment.uri),
    )
    if (missing.length === 0) return
    let cancelled = false
    const recordFailure = (uri: string): void => {
      setAttachmentPreviewFailures((current) => (current.includes(uri) ? current : [...current, uri]))
    }
    for (const attachment of missing) {
      void store
        .previewAttachment(attachment.uri)
        .then((dataUri) => {
          if (cancelled) return
          // `undefined` is the Host's flattened refusal (an expired or dead
          // draft handle); recording it keeps the lightbox from claiming the
          // image is merely still loading.
          if (dataUri === undefined) recordFailure(attachment.uri)
          else setAttachmentPreviews((current) => ({ ...current, [attachment.uri]: dataUri }))
        })
        .catch(() => {
          if (!cancelled) recordFailure(attachment.uri)
        })
    }
    return () => {
      cancelled = true
    }
  }, [attachments, attachmentPreviewFailures, attachmentPreviews, store])

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
    dshEventVisibility.visible && dshEventVisibility.sessionId !== undefined
      ? dshEventVisibility.sessionId === activeSessionId
      : false
  const visibleOpenFilePickerOpen =
    openFilePickerOpen && openFilePickerSessionId !== undefined && openFilePickerSessionId === activeSessionId
  // The export form names no session of its own, so it belongs to the
  // conversation it was opened from: a switch would silently retarget it.
  const visibleExportSessionId =
    exportOpen && exportSessionId !== undefined && exportSessionId === activeSessionId
      ? exportSessionId
      : undefined
  const visibleOpenFileCandidates = useMemo(
    () => (openFileCandidatesSessionId === activeSessionId ? openFileCandidates : EMPTY_OPEN_FILE_CANDIDATES),
    [activeSessionId, openFileCandidates, openFileCandidatesSessionId],
  )
  const visibleOpenFilePickerLoading =
    openFilePickerLoading &&
    openFilePickerSessionId !== undefined &&
    openFilePickerSessionId === activeSessionId
  const setShowDshEvents = useStableCallback((visible: boolean): void => {
    if (activeSessionId === undefined) return
    setDshEventVisibility({ sessionId: activeSessionId, visible })
  })
  const sessionModels = state.sessionModels.length > 0 ? state.sessionModels : state.models
  // These rows name the providers the session directory could not enumerate.
  // They stay visible while the global catalog stands in, because that
  // fallback is what lets a session whose providers all failed show models at
  // all, and dropping the rows there would hide the only explanation.
  const sessionModelFailures = state.sessionModelFailures
  // The host's verdict on the session's current model, not a guess from the
  // groups: a route can serve a model it stopped advertising, and only the
  // host knows which adapters are live. `undefined` means no directory has
  // answered, which must not read as blocked.
  const sessionModelRoutable = state.sessionModelRoutable
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
  const localSubagentReferences = useMemo<readonly ReferenceCandidate[]>(() => {
    if (referenceQuoted || activeSessionId === undefined) return EMPTY_REFERENCE_CANDIDATES
    const needle = referenceQuery.trim().toLocaleLowerCase()
    const candidates: ReferenceCandidate[] = []
    for (const entry of state.subagents.entries) {
      if (entry.kind !== 'child') continue
      const label = entry.label?.trim() || t('subagents.unnamed')
      if (!label.toLocaleLowerCase().includes(needle)) continue
      candidates.push({
        id: `subagent:${entry.id}`,
        kind: 'session',
        sessionId: entry.id,
        label,
        description: t('composer.referenceSubagent'),
        mention: `@[${label}](dsh-session:${entry.id})`,
      })
    }
    return candidates
  }, [activeSessionId, referenceQuery, referenceQuoted, state.subagents.entries, t])
  const visibleReferenceCandidates = useMemo(() => {
    if (referenceSessionId !== activeSessionId) return EMPTY_REFERENCE_CANDIDATES
    if (referenceCandidates.length === 0) return localSubagentReferences
    if (localSubagentReferences.length === 0) return referenceCandidates
    return [...referenceCandidates, ...localSubagentReferences]
  }, [activeSessionId, localSubagentReferences, referenceCandidates, referenceSessionId])
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
    origin?: AttachmentDraftOrigin,
  ): void => {
    if (generation !== attachmentGenerationRef.current) {
      void store.releaseAttachments([attachment.uri]).catch(() => undefined)
      return
    }
    if (attachmentDraftKeysRef.current.has(attachment.uri)) return
    const draftKey = attachmentDraftKey(attachment, origin)
    const existingUri = [...attachmentDraftKeysRef.current.entries()].find(([, key]) => key === draftKey)?.[0]
    if (existingUri !== undefined) {
      if (existingUri !== attachment.uri)
        void store
          .releaseAttachments([attachment.uri])
          .catch((reason: unknown) =>
            setError(reason instanceof Error ? reason.message : t('app.error.releaseAttachment')),
          )
      return
    }
    attachmentDraftKeysRef.current.set(attachment.uri, draftKey)
    setAttachments((current) =>
      current.some((item) => item.uri === attachment.uri) ? current : [...current, attachment],
    )
    if (openFileId !== undefined)
      setOpenFileAttachmentIds((current) => ({ ...current, [attachment.uri]: openFileId }))
  }
  const removeAttachmentDrafts = (uris: readonly string[], release: boolean): void => {
    if (uris.length === 0) return
    const removed = new Set(uris)
    for (const uri of removed) attachmentDraftKeysRef.current.delete(uri)
    setAttachments((current) => current.filter((attachment) => !removed.has(attachment.uri)))
    setAttachmentPreviews((current) =>
      Object.fromEntries(Object.entries(current).filter(([uri]) => !removed.has(uri))),
    )
    setAttachmentPreviewFailures((current) => current.filter((uri) => !removed.has(uri)))
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
  const discardAttachmentDrafts = useStableCallback((): void => {
    attachmentGenerationRef.current += 1
    removeAttachmentDrafts(
      attachments.map((attachment) => attachment.uri),
      true,
    )
    setOpenFilePickerOpen(false)
  })
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
      const origin = browserFileOrigin(file)
      void readFileAsBase64(file, t, imageLimits)
        .then((payload) => store.ingestAttachment(payload))
        .then((attachment) => {
          if (attachment !== undefined) appendAttachment(attachment, undefined, generation, origin)
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
  /**
   * Loads the open-file snapshot that both the composer menu row and the
   * picker render. The row is only offered when the list names an attachable
   * file, so it has to be requested while that menu is being built.
   */
  const loadOpenFileCandidates = (sessionId: string, awaitingPicker: boolean): void => {
    const request = ++openFileRequestRef.current
    if (awaitingPicker) setOpenFilePickerLoading(true)
    void store
      .listOpenFiles()
      .then((candidates) => {
        if (request !== openFileRequestRef.current) return
        setOpenFileCandidatesSessionId(sessionId)
        setOpenFileCandidates(candidates)
      })
      .catch((reason: unknown) => {
        if (request !== openFileRequestRef.current) return
        setOpenFileCandidatesSessionId(sessionId)
        setOpenFileCandidates([])
        if (awaitingPicker) setError(reason instanceof Error ? reason.message : t('app.error.listOpenFiles'))
      })
      .finally(() => {
        // A newer request may have replaced this one; the flag describes the
        // picker, so whichever request was waiting for it has to clear it.
        if (awaitingPicker) setOpenFilePickerLoading(false)
      })
  }
  const toggleOpenFilePicker = (): void => {
    if (visibleOpenFilePickerOpen) {
      setOpenFilePickerOpen(false)
      return
    }
    if (activeSessionId === undefined) return
    setOpenFilePickerSessionId(activeSessionId)
    setOpenFilePickerOpen(true)
    loadOpenFileCandidates(activeSessionId, true)
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
        appendAttachment(attachment, candidateId, generation, { kind: 'open-file', id: candidateId })
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
  const sessionOnCreate = useStableCallback((workspaceId: string | undefined): void => {
    void store
      .createSession(workspaceId)
      .catch((reason: unknown) =>
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
  const sessionOnRenameWorkspace = useStableCallback((workspaceId: string, name: string): Promise<void> =>
    store.renameWorkspace(workspaceId, name),
  )
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
  const sessionOnSearch = useStableCallback((query: string): Promise<readonly SessionSummary[]> =>
    store.searchSessions(query),
  )
  const composerOnCaptureEditorContext = useStableCallback((kind: EditorContextKind): Promise<void> =>
    store.captureEditorContext(kind),
  )
  const composerOnRemoveEditorContext = useStableCallback((contextRef: string): Promise<void> =>
    store.releaseEditorContext([contextRef]),
  )
  const composerOnPreviewEditorContext = useStableCallback(
    (contextRef: string): Promise<EditorContextPreview | undefined> => store.previewEditorContext(contextRef),
  )
  const composerOnConfigurationChange = useStableCallback((configuration: AgentConfiguration): void => {
    if (active === undefined) return
    void store
      .configureSession(active.id, configuration)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.sessionSettings')),
      )
  })
  const composerOnPromptModeChange = useStableCallback((mode: PromptMode): void => {
    void store
      .setPromptMode(mode)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.promptMode')),
      )
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
  const composerOnReferenceQueryChange = useStableCallback(
    (query: string | undefined, quoted: boolean): void => updateReferenceQuery(query, quoted),
  )
  const composerOnPickAttachment = useStableCallback((): void => {
    const generation = attachmentGenerationRef.current
    void store
      .pickAttachment()
      .then((attachment) => {
        if (attachment !== undefined) appendAttachment(attachment, undefined, generation)
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.attachmentSelection')),
      )
  })
  const composerOnIngestFiles = useStableCallback((files: readonly File[]): void => ingestFiles(files))
  const composerOnToggleOpenFilePicker = useStableCallback((): void => toggleOpenFilePicker())
  const composerOnExtrasOpenChange = useStableCallback((open: boolean): void => {
    if (!open) {
      // The picker is rendered inside that menu; leaving it "open" would make
      // the next menu opening start with a stale popover already expanded.
      setOpenFilePickerOpen(false)
      return
    }
    if (activeSessionId === undefined) return
    loadOpenFileCandidates(activeSessionId, false)
  })
  const composerOnSelectOpenFile = useStableCallback((candidateId: string): void =>
    selectOpenFile(candidateId),
  )
  const composerOnRemoveAttachment = useStableCallback((uri: string): void => {
    removeAttachmentDrafts([uri], true)
  })
  const composerOnSubmit = useStableCallback((mode: RunningInputMode): void => submitPrompt(mode))
  const composerOnCancel = useStableCallback((): void => {
    if (active === undefined) return
    void store
      .cancelSession(active.id)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t('app.error.cancel')))
  })
  const composerOnSteerQueue = useStableCallback((): void => {
    void store
      .steerAllQueued()
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.steerAll')),
      )
  })
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
        {...(sessionStats === undefined ? {} : { sessionStats })}
      />
    ),
    [
      composerUsage,
      sessionStats,
      state.timeline.nodeChangeBase,
      state.timeline.nodeChangeStart,
      state.timeline.nodes,
    ],
  )
  const sessionControl = useMemo(
    () => (
      <SessionDrawer
        sessions={state.sessions}
        workspaces={state.workspaces}
        activeSessionId={state.activeSessionId}
        open={state.drawer === 'sessions'}
        showTrigger={state.activeSessionId !== undefined}
        onOpenChange={sessionOnOpenChange}
        onOpen={sessionOnOpen}
        onCreate={sessionOnCreate}
        onArchive={sessionOnArchive}
        onRename={sessionOnRename}
        onRenameWorkspace={sessionOnRenameWorkspace}
        onRemoveWorkspace={sessionOnRemoveWorkspace}
        onMoveWorkspace={sessionOnMoveWorkspace}
        onMoveSession={sessionOnMoveSession}
        onSearch={sessionOnSearch}
      />
    ),
    [
      sessionOnArchive,
      sessionOnCreate,
      sessionOnMoveSession,
      sessionOnMoveWorkspace,
      sessionOnOpen,
      sessionOnOpenChange,
      sessionOnRemoveWorkspace,
      sessionOnRename,
      sessionOnRenameWorkspace,
      sessionOnSearch,
      state.activeSessionId,
      state.drawer,
      state.sessions,
      state.workspaces,
    ],
  )
  const headerOnNewSession = useStableCallback((): void => {
    void store
      .createSession(active?.workspaceId ?? state.workspaces[0]?.id)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.createSession')),
      )
  })
  const headerOnOpenSettings = useStableCallback((): void => {
    store.setDrawer('settings')
  })
  const attachedOpenFileIds = useMemo(() => Object.values(openFileAttachmentIds), [openFileAttachmentIds])
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
        <DeferredJobsDrawer key={state.jobs.length > 0 ? 'jobs' : 'jobs-empty'} jobs={state.jobs} />
        <DeferredChangesDrawer
          key={`changes-${activeId}`}
          changes={state.changes}
          loading={state.changesLoading}
          onRefresh={() => store.refreshChanges(activeId)}
          onOpen={(changeId) => store.openChange(changeId)}
          onDetail={(changeId) => store.getChangeDetail(changeId)}
          onMarkReviewed={(changeId, reviewState) => store.markChangeReviewed(changeId, reviewState)}
        />
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
            await store.stopTask(task.taskId, 'session-cancel', task.taskRevision)
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
          onRestore={(checkpointId, conflictPolicy) => store.restoreCheckpoint(checkpointId, conflictPolicy)}
        />
        <DeferredPromptTemplatesDrawer
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
        {dshEventCount > 0 ? (
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
    setShowDshEvents,
    toggleExport,
    visibleExportSessionId,
    state.changes,
    state.changesLoading,
    state.checkpoints,
    state.checkpointsLoading,
    state.jobs,
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
    showDshEvents,
  ])
  return (
    <AppErrorBoundary>
      <main className="dsh-app" data-dsh-theme={themePreference}>
        <DeferredSettingsDrawer
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
          onLocaleFromDsh={setLocale}
          conversationFontSize={conversationFontSize}
          onConversationFontSizeChange={setConversationFontSize}
          providers={state.providers}
          models={state.models}
          onLoadSettings={() => store.readSettings()}
          onLoadDshSettings={() => store.readDshSettings()}
          onOpenDshSettingsDocument={() => store.openDshSettingsDocument()}
          onUpdateDshSetting={(path, value) => store.updateDshSetting(path, value)}
          onUnsetDshSetting={(path) => store.unsetDshSetting(path)}
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
            try {
              await store.createSession(undefined, 'cordis')
            } catch (reason: unknown) {
              setError(reason instanceof Error ? reason.message : t('app.error.createSession'))
            }
          }}
          onLoadPluginInventory={() => store.loadPluginInventory()}
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
              {active === undefined ? (
                <>
                  {sessionControl}
                  <div className="dsh-app__empty">
                    {backend.kind === 'connected' && state.workspaces.length > 0 ? (
                      <EmptySessionPosture
                        workspaces={state.workspaces}
                        presets={state.presets}
                        empty={state.sessions.length === 0}
                        onCreate={(workspaceId, presetId) => {
                          void store
                            .createSession(workspaceId, presetId)
                            .catch((reason: unknown) =>
                              setError(
                                reason instanceof Error ? reason.message : t('app.error.createSession'),
                              ),
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
                    </div>
                    <AppHeader
                      runtime={backend}
                      connectedDshVersion={state.connectedDshVersion}
                      compatibilityWarning={compatibilityWarning}
                      sessionControl={sessionControl}
                      onNewSession={headerOnNewSession}
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
                            {...(sessionModelRoutable === undefined
                              ? {}
                              : { modelRoutable: sessionModelRoutable })}
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
                            promptMode={state.promptMode}
                            configurationDisabled={backend.kind !== 'connected' || activeRunning}
                            presetMutable={activeSubagent === undefined && active.status === 'idle'}
                            onConfigurationChange={composerOnConfigurationChange}
                            onPromptModeChange={composerOnPromptModeChange}
                            onCommand={composerOnCommand}
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
    return <EmptyState title={t('app.workspaceLoading')} description={t('app.workspaceLoadingDescription')} />

  return (
    <section className="dsh-empty-session" aria-live="polite">
      <div className="dsh-empty-session__icon" aria-hidden="true">
        <Icon name="session" />
      </div>
      <span className="dsh-app__eyebrow">{t('app.noActiveSession')}</span>
      <h2>{props.empty ? t('app.createSession') : t('app.chooseSession')}</h2>
      <p>{t('app.workspacePickerHint')}</p>
      <div className="dsh-empty-session__picker">
        <span>{t('app.workspacePicker')}</span>
        <SelectMenu
          className="dsh-empty-session__select"
          icon="folder"
          density="regular"
          displayLabel
          menuMode="flow"
          label={selected?.name ?? t('app.workspacePicker')}
          ariaLabel={t('app.workspacePicker')}
          title={t('app.workspacePicker')}
          value={selected?.id ?? ''}
          options={props.workspaces.map((workspace) => ({
            value: workspace.id,
            label: workspace.name,
          }))}
          onChange={setSelectedWorkspaceId}
        />
      </div>
      {availablePresets.length === 0 ? null : (
        <div className="dsh-empty-session__preset">
          <span>{t('app.presetPicker')}</span>
          <SelectMenu
            className="dsh-empty-session__select"
            icon="sparkles"
            density="regular"
            displayLabel
            menuMode="flow"
            label={stagedPreset?.name ?? stagedPreset?.id ?? t('app.presetPicker')}
            ariaLabel={t('app.presetPicker')}
            title={t('app.presetPicker')}
            value={stagedPresetId}
            options={availablePresets.map((preset) => ({
              value: preset.id,
              label: preset.name ?? preset.id,
            }))}
            onChange={setSelectedPresetId}
          />
          <span className="dsh-sr-only">{t('app.presetStaged')}</span>
        </div>
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
  const pressureValid =
    record === undefined ||
    ((!Object.prototype.hasOwnProperty.call(record, 'pressureTokens') ||
      nonNegativeTokenCount(record.pressureTokens) !== undefined) &&
      (!Object.prototype.hasOwnProperty.call(record, 'projectedTokens') ||
        nonNegativeTokenCount(record.projectedTokens) !== undefined) &&
      (!Object.prototype.hasOwnProperty.call(record, 'contextWindow') ||
        positiveTokenCount(record.contextWindow) !== undefined))
  const pressureTokens = pressureValid ? nonNegativeTokenCount(record?.pressureTokens) : undefined
  const projectedTokens = pressureValid ? nonNegativeTokenCount(record?.projectedTokens) : undefined
  const contextWindow = pressureValid ? positiveTokenCount(record?.contextWindow) : undefined
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
    inputTokens === undefined ||
    outputTokens === undefined ||
    (record.cacheReadTokens !== undefined && cacheReadTokens === undefined) ||
    (record.cacheWriteTokens !== undefined && cacheWriteTokens === undefined)
  )
    return undefined
  return {
    inputTokens,
    outputTokens,
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
  const isImage = file.type.startsWith('image/')
  const imageLimit = isImage
    ? Math.min(MAX_IMAGE_ATTACHMENT_BYTES, imageLimits?.maxImageBytes ?? DEFAULT_ATTACHMENT_BYTES)
    : DEFAULT_ATTACHMENT_BYTES
  if (file.size > imageLimit)
    return Promise.reject(
      new Error(
        isImage && imageLimits !== undefined
          ? t('app.error.imageTooLarge', { name: file.name, size: formatByteSize(imageLimit) })
          : t('app.error.fileTooLarge', { name: file.name }),
      ),
    )
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
  const hasMaxImageDimension = Object.prototype.hasOwnProperty.call(record, 'maxImageDimension')
  if (
    maxImageBytes === undefined ||
    maxImagesPerMessage === undefined ||
    maxMessageImageBytes === undefined ||
    maxImagePixels === undefined ||
    (hasMaxImageDimension && maxImageDimension === undefined) ||
    !Array.isArray(record.mediaTypes) ||
    record.mediaTypes.length === 0 ||
    !record.mediaTypes.every(
      (entry) => typeof entry === 'string' && isImageMediaType(entry.trim().toLowerCase()),
    )
  )
    return undefined
  const mediaTypes = record.mediaTypes.filter(
    (entry): entry is ImageAttachmentLimits['mediaTypes'][number] =>
      typeof entry === 'string' && isSupportedImageMediaType(entry.trim().toLowerCase()),
  )
  return {
    // Keep future hosts from advertising a limit beyond the opaque attachment
    // store and prompt boundary implemented by this extension.
    maxImageBytes: Math.min(maxImageBytes, MAX_IMAGE_ATTACHMENT_BYTES),
    maxImagesPerMessage: Math.min(maxImagesPerMessage, 20),
    maxMessageImageBytes: Math.min(maxMessageImageBytes, MAX_PROMPT_IMAGE_BYTES),
    maxImagePixels,
    ...(maxImageDimension === undefined ? {} : { maxImageDimension }),
    mediaTypes,
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function isSupportedImageMediaType(value: unknown): value is ImageAttachmentLimits['mediaTypes'][number] {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
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
