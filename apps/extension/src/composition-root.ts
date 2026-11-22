import * as vscode from 'vscode'
import {
  COMPLETION_CUE_INPUT_NOTIFICATION,
  COMPLETION_CUE_NOTIFICATION,
  CompletionCue,
} from './view/completion-cue.js'
import { showNativeNotification } from './view/native-notification.js'
import { BillingFeatureHost } from './billing/billing-feature-handler.js'
import { ModelsDevPriceSource } from './billing/models-dev-price-source.js'
import { FrankfurterExchangeSource } from './billing/frankfurter-exchange-source.js'
import type { DshRuntimeUpdateProgress, EditorContextOwner, SessionSummary } from '@dsh-vscode/domain'
import {
  featureHostEnvelopeSchema,
  featureHostMessageSchema,
  hostEnvelopeSchema,
  hostMessageSchema,
  PLAY_COMPLETION_CUE_EVENT,
  type FeatureHostMessage,
  type HostMessage,
} from '@dsh-vscode/webview-protocol'

export {
  JobFollowRegistry,
  relayJobFollowFrames,
  resolveJobFollowOffset,
} from './backend/job-follow-registry.js'
export { createManagedEndpointLoginHandler } from './composition/connection-assembly.js'
import { PluginInstallRequestCoordinator } from './plugins/plugin-bundle-feature-handler.js'
import { diagnosticLevel, RedactedDiagnostics } from './backend/diagnostics.js'
import { EventLoopLagMonitor } from './backend/event-loop-lag.js'
import { VsCodeConfigurationSource } from './config/configuration-source.js'
import { OUTPUT_CHANNEL_NAME } from './constants.js'
import { workspaceFolderId } from './editor/workspace-path-guard.js'
import { DSH_CHAT_VIEW_OWNER_ID } from './editor/editor-context-provider.js'
import { sessionWorkspaceFolderId, hasLocalWorkspaceAuthority } from './view/session-workspace-scope.js'
import { readExtensionVersion, endpointFromServerUrl } from './composition/runtime.js'
import { AppError, type BackendEndpoint, type ConnectedBackend } from '@dsh-vscode/domain'
import { sameWorkspacePath } from './composition/workspace-state.js'
import { createSessionScope } from './composition/session-scope.js'
import { createUseCasesAssembly } from './composition/use-cases-assembly.js'
import { createConnectionLifecycle, createRuntimeAssembly } from './composition/connection-assembly.js'
import { createHostEventPipeline, isBulkEvent } from './composition/host-event-pipeline.js'
import { createChangeCheckpointTaskAssembly } from './composition/change-checkpoint-task-assembly.js'
import { createJobFollowHost } from './composition/job-follow-host.js'
import { createBackendAttach } from './composition/backend-attach.js'
import { createSessionWatchController } from './backend/session-watch-coordinator.js'
import { createFeatureContext } from './composition/feature-context.js'
import { createFeatureRequestHandler } from './composition/feature-request-handler.js'
import { createRequestGateway } from './composition/request-handler.js'
import { WebviewSurfaceRegistry } from './view/webview-surface-registry.js'
import { createCommandsAssembly } from './composition/commands-assembly.js'
import { TranscriptWindowService } from './view/transcript-window.js'
import { TranscriptWindowRegistry } from './view/transcript-window-registry.js'
import { publicValue } from './composition/public-projection.js'
import type { SessionNavigation } from './composition/session-navigation.js'

export interface CompositionRoot extends vscode.Disposable {
  start(): Promise<void>
}

/**
 * Orchestration shell: builds the shared base services and closures, then
 * assembles the subsystems from `composition/` in dependency order. Every
 * moved body lives in a dedicated assembly module; the start/dispose sequence
 * in `commands-assembly.ts` preserves the original teardown order exactly.
 */
export function createCompositionRoot(context: vscode.ExtensionContext): CompositionRoot {
  const pluginInstallRequests = new PluginInstallRequestCoordinator()
  const configuration = new VsCodeConfigurationSource(vscode.workspace)
  const extensionVersion = readExtensionVersion(context)
  const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME)
  const diagnostics = new RedactedDiagnostics(channel, () =>
    diagnosticLevel(vscode.workspace.getConfiguration('dsh.developer').get<string>('logLevel')),
  )
  const eventLoopLag = new EventLoopLagMonitor()
  eventLoopLag.start()
  const currentWorkspaceFolders = (): readonly vscode.WorkspaceFolder[] => {
    const folders = vscode.workspace.workspaceFolders
    if (folders !== undefined && folders.length > 0) return folders
    const activeEditor = vscode.window.activeTextEditor
    const activeFolder =
      activeEditor === undefined ? undefined : vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)
    return activeFolder === undefined ? [] : [activeFolder]
  }
  const currentWorkspaceFolder = (): vscode.WorkspaceFolder | undefined => {
    const activeEditor = vscode.window.activeTextEditor
    const activeFolder =
      activeEditor === undefined ? undefined : vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)
    return activeFolder ?? currentWorkspaceFolders()[0]
  }
  // Every live chat Webview. Surfaces are registered below, so `post` and
  // `postTo` read them through this binding; no message can be posted before
  // composition has finished.
  const surfaces = new WebviewSurfaceRegistry()
  const nativeNavigation: { current?: SessionNavigation } = {}
  const hostEnvelope = (message: HostMessage | FeatureHostMessage): object | undefined => {
    const legacy = hostMessageSchema.safeParse(message)
    if (legacy.success) return hostEnvelopeSchema.parse({ protocolVersion: 1, message: legacy.data })
    const feature = featureHostMessageSchema.safeParse(message)
    if (feature.success) return featureHostEnvelopeSchema.parse({ protocolVersion: 1, message: feature.data })
    diagnostics.log('warn', 'host-message-rejected', { code: 'PROTOCOL_ERROR' })
    return undefined
  }
  const post = (message: HostMessage | FeatureHostMessage): Thenable<boolean> => {
    const envelope = hostEnvelope(message)
    if (envelope === undefined) return Promise.resolve(false)
    return surfaces.post(envelope, (surfaceId) => {
      if (message.type === 'event' && message.name !== 'ui.resync' && !isBulkEvent(message.name))
        void postEventTo(surfaceId, 'ui.resync', {})
    })
  }
  const postTo = (surfaceId: string, message: HostMessage | FeatureHostMessage): Thenable<boolean> => {
    const envelope = hostEnvelope(message)
    return envelope === undefined ? Promise.resolve(false) : surfaces.postTo(surfaceId, envelope)
  }
  const currentWorkspaceFolderId = (): string | undefined => {
    const folder = currentWorkspaceFolder()
    return folder === undefined ? undefined : workspaceFolderId(folder)
  }
  const workspaceFolderIdForSession = (session: Pick<SessionSummary, 'cwd'>): string | undefined => {
    const state = coordinator.getState()
    return hasLocalWorkspaceAuthority(state.kind === 'connected' ? state.backend : undefined)
      ? sessionWorkspaceFolderId({
          folders: currentWorkspaceFolders().map((folder) => ({
            id: workspaceFolderId(folder),
            path: folder.uri.fsPath,
          })),
          session,
          samePath: sameWorkspacePath,
        })
      : undefined
  }
  // The runtime update progress publisher is late-bound: the updater exists
  // before the event pipeline that owns the real implementation.
  const runtimeUpdateProgress = {
    current: (_progress: DshRuntimeUpdateProgress): void => undefined,
  }

  const {
    runtimeLocator,
    coordinator,
    backendService,
    supervisor,
    runtimeInstaller,
    runtimeUseCases,
    endpointLaunchUrls,
    externalConnection,
  } = createRuntimeAssembly({
    context,
    configuration,
    diagnostics,
    currentWorkspaceFolder,
    onRuntimeUpdateProgress: (progress) => runtimeUpdateProgress.current(progress),
    onRuntimeUpdateRestart: () => reconnect(),
  })
  const {
    workspaceUseCases,
    sessionUseCases,
    modelUseCases,
    interactionUseCases,
    settingsUseCases,
    providerSettingsUseCases,
    advancedUseCases,
    exportUseCases,
    temporaryWorkspaceManager,
    attachmentTokens,
    editorContextProvider,
    editorContextUseCases,
    navigationUseCases,
  } = createUseCasesAssembly({ backendService, context })
  const {
    listCurrentWorkspaces,
    listCurrentArchivedSessionIds,
    ensureCurrentWorkspace,
    invalidateCurrentWorkspaceSessionDetails,
    requireCurrentWorkspaceSession,
    requireCurrentWorkspaceId,
    requireOwnedQueuedInput,
    requireOwnedGoal,
    requireOwnedPermission,
    requireOwnedQuestion,
  } = createSessionScope({
    backendService,
    workspaceUseCases,
    temporaryWorkspaceManager,
    currentWorkspaceFolders,
    currentWorkspaceFolder,
  })
  const featureOwner = (): EditorContextOwner => ({
    ownerId: DSH_CHAT_VIEW_OWNER_ID,
    ownerViewId: DSH_CHAT_VIEW_OWNER_ID,
    contextStoreGeneration: 1,
  })
  const currentConnectedBackend = (): ConnectedBackend | undefined => {
    const state = coordinator.getState()
    return state.kind === 'connected' ? state.backend : undefined
  }
  const transcript = new TranscriptWindowRegistry(
    (surfaceId, isCurrent) =>
      new TranscriptWindowService({
        consumerDriven: true,
        refresh: (sessionId) =>
          backendService.requireBackend().events.refreshSession?.(sessionId) ?? Promise.resolve(),
        onCapacity: (ready) => sessionWatch.surfaceCapacityChanged(surfaceId, ready),
        read: (sessionId, before, signal, child) =>
          child
            ? advancedUseCases.listSubagentHistory(
                sessionId,
                { ...(before === undefined ? {} : { beforeSequence: before }), pageSize: 50 },
                signal,
              )
            : backendService
                .requireBackend()
                .sessions.history(sessionId, before, signal, { pageSize: 50, pagePurpose: 'transcript' }),
        publicValue: (value, cwd) =>
          publicValue(
            value,
            [
              ...currentWorkspaceFolders().map((folder) => folder.uri.fsPath),
              ...(temporaryWorkspaceManager.current?.path === undefined
                ? []
                : [temporaryWorkspaceManager.current.path]),
              ...(temporaryWorkspaceManager.reference?.path === undefined
                ? []
                : [temporaryWorkspaceManager.reference.path]),
            ],
            hasLocalWorkspaceAuthority(currentConnectedBackend()) ? cwd : undefined,
          ),
        post: (window) => postEventTo(surfaceId, 'session.transcript', window, isCurrent),
        postPatch: (patch) => postEventTo(surfaceId, 'session.transcript.patch', patch, isCurrent),
        invalidate: (sessionId) => {
          void postEventTo(surfaceId, 'session.transcript.invalidated', { sessionId }, isCurrent)
        },
        report: ({ attempt, retrying }) =>
          diagnostics.log('warn', 'transcript-delivery-failed', {
            attempt,
            retrying,
          }),
      }),
    (surfaceId) => {
      const surface = surfaces.get(surfaceId)
      return surface?.isReady === true && surface.visible
    },
    (hasSurface) => surfaces.list().some((surface) => surface.isReady && !hasSurface(surface.surfaceId)),
  )
  const notifyCompletionCue = async (body: string): Promise<boolean> => {
    const shown =
      vscode.env.remoteName === undefined &&
      (await showNativeNotification('JaboDSH', body).catch(() => false))
    diagnostics.log('debug', 'completion-cue', { decision: 'notified', native: shown })
    if (!shown) await Promise.resolve(vscode.window.showInformationMessage(body)).catch(() => undefined)
    return shown
  }
  const needsInputContext: {
    current: ((sessionId: string) => { focused: boolean; bell: () => void }) | undefined
  } = { current: undefined }
  const completionCue = new CompletionCue({
    mode: () => vscode.workspace.getConfiguration('dsh').get('completionCue', 'off'),
    focused: () => vscode.window.state.focused,
    includeFocused: () =>
      vscode.workspace.getConfiguration('dsh').get<boolean>('completionCueWhenFocused', false),
    notify: (reason) => {
      void notifyCompletionCue(
        reason === 'turn' ? COMPLETION_CUE_NOTIFICATION : COMPLETION_CUE_INPUT_NOTIFICATION,
      )
    },
    needsInput: (sessionId) => needsInputContext.current?.(sessionId),
    log: (event) => diagnostics.log('debug', 'completion-cue', event),
  })
  const {
    postFeatureEvent,
    publishAccountSnapshot,
    publishAccountSessionExpired,
    publishAccountError,
    postEditorContextAvailabilityEvent,
    postEvent,
    postEventTo,
    postBackendEvent,
    publishState,
    nextFeatureLocalSequence,
    acknowledgeEvents,
    forgetSurface,
    dispose: disposeHostEventPipeline,
  } = createHostEventPipeline({
    surfaceIds: () =>
      surfaces
        .list()
        .filter((surface) => surface.isReady)
        .map((surface) => surface.surfaceId),
    transcript,
    post,
    postTo,
    onEvent: (name, payload) => {
      completionCue.accept(name, payload)
      nativeNavigation.current?.acceptEvent(name, payload)
    },
    backendService,
    diagnostics,
    editorContextUseCases,
    featureOwner,
    currentWorkspaceFolders,
    temporaryWorkspaceManager,
    runtimeUpdateProgress,
  })
  const {
    changeTracker,
    changeUseCases,
    checkpointUseCases,
    promptTemplateUseCases,
    taskRegistry,
    taskUseCases,
    taskFocus,
    postCheckpointFeatureEvent,
  } = createChangeCheckpointTaskAssembly({
    context,
    diagnostics,
    post,
    backendService,
    nextFeatureLocalSequence,
    workspaceFolderIdForSession,
    currentWorkspaceFolders,
    currentWorkspaceFolderId,
  })
  const { startJobFollow, stopJobFollow, stopAllJobFollows } = createJobFollowHost({
    advancedUseCases,
    backendService,
    diagnostics,
    requireCurrentWorkspaceSession,
  })
  const sessionWatch = createSessionWatchController()
  const { attach, disposeAccountLifecycleHost, getAccountLifecycleHost, detachSessionAdapters } =
    createBackendAttach({
      backendService,
      sessionUseCases,
      extensionVersion,
      diagnostics,
      eventLoopLag,
      stopAllJobFollows,
      invalidateCurrentWorkspaceSessionDetails,
      changeTracker,
      taskRegistry,
      sessionWatch,
      editorContextProvider,
      currentWorkspaceFolderId,
      taskFocus,
      postFeatureEvent,
      postBackendEvent,
      publishAccountSnapshot,
      publishAccountSessionExpired,
      publishAccountError,
      publishRecoveredState: (backend) => {
        const state = coordinator.getState()
        if (state.kind === 'connected' && state.backend === backend.connection) publishState(state)
      },
    })
  const { connect, reconnect, reconnectOnTransportChange, configureConnection } = createConnectionLifecycle({
    context,
    configuration,
    coordinator,
    currentWorkspaceFolders,
    endpointLaunchUrls,
    externalConnection,
    attach,
    publishState,
    disposeAccountLifecycleHost,
    detachSessionAdapters,
  })
  const {
    featureContextOwner,
    currentFeatureSessionBinding,
    contextOwnerForSession,
    featureWorkspaceFolderId,
  } = createFeatureContext({
    backendService,
    featureOwner,
    currentWorkspaceFolders,
    workspaceFolderIdForSession,
    currentWorkspaceFolderId,
  })
  const { handleFeatureRequest } = createFeatureRequestHandler({
    billing: new BillingFeatureHost(
      {
        storage: context.globalState,
        backendService,
        requireSession: requireCurrentWorkspaceSession,
        isTrusted: () => vscode.workspace.isTrusted,
        changed: () => postFeatureEvent('billing.settings.changed', {}),
      },
      new ModelsDevPriceSource(),
      new FrankfurterExchangeSource(globalThis.fetch, Date.now, context.globalState),
    ),
    editorCompanion: () => commands.editorCompanion,
    getAccountLifecycleHost,
    backendService,
    pluginInstallRequests,
    listCurrentWorkspaces,
    requireCurrentWorkspaceSession,
    featureContextOwner,
    editorContextUseCases,
    postFeatureEvent,
    postEditorContextAvailabilityEvent,
    navigationUseCases,
    changeUseCases,
    changeTracker,
    checkpointUseCases,
    featureWorkspaceFolderId,
    postCheckpointFeatureEvent,
    taskUseCases,
    taskRegistry,
    taskFocus,
    promptTemplateUseCases,
    currentWorkspaceFolders,
  })
  const gateway = createRequestGateway({
    responseRendered: (sessionId, turn, chatFocused) => completionCue.rendered(sessionId, turn, chatFocused),
    acknowledgeHostEvents: acknowledgeEvents,
    forgetHostSurface: forgetSurface,
    prepareEditorSession: (sessionId, signal) => commands.editorCompanion.prepareSession(sessionId, signal),
    transcript,
    post,
    postTo,
    postEvent,
    postEventTo,
    surfaces,
    handleFeatureRequest,
    diagnostics,
    context,
    currentWorkspaceFolders,
    currentWorkspaceFolder,
    connect,
    reconnect,
    configureConnection,
    runtimeUseCases,
    runtimeLocator,
    coordinator,
    sessionWatch,
    extensionVersion,
    configuration,
    backendService,
    listCurrentWorkspaces,
    listCurrentArchivedSessionIds,
    ensureCurrentWorkspace,
    requireCurrentWorkspaceSession,
    requireCurrentWorkspaceId,
    requireOwnedQueuedInput,
    requireOwnedGoal,
    requireOwnedPermission,
    requireOwnedQuestion,
    workspaceUseCases,
    sessionUseCases,
    modelUseCases,
    interactionUseCases,
    settingsUseCases,
    providerSettingsUseCases,
    advancedUseCases,
    exportUseCases,
    temporaryWorkspaceManager,
    attachmentTokens,
    editorContextUseCases,
    contextOwnerForSession,
    currentFeatureSessionBinding,
    workspaceFolderIdForSession,
    startJobFollow,
    stopJobFollow,
    stopAllJobFollows,
    editorContextProvider,
  })
  const { router, provider, editorSurfaces, moveChatToSidebar, openDroppedSession, sessionNavigation } =
    gateway
  nativeNavigation.current = sessionNavigation
  needsInputContext.current = (sessionId) => {
    const context = gateway.cueContext(sessionId)
    return {
      focused: context.focused,
      bell: () => {
        if (context.surfaceId !== undefined)
          void postEventTo(context.surfaceId, PLAY_COMPLETION_CUE_EVENT, {})
      },
    }
  }
  // The cue only runs for live, unfocused turns, so expose the configured
  // mode on demand instead of asking the user to wait for one.
  const openCompletionCueSettings = async (): Promise<void> => {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'dsh.completionCue')
  }
  const testCompletionCue = async (): Promise<void> => {
    const mode = completionCue.mode()
    diagnostics.log('info', 'completion-cue', { decision: 'test', mode })
    const settingsAction = 'Open Settings'
    if (mode === 'off') {
      const answer = await vscode.window.showInformationMessage(
        'Completion cues are off. Set "dsh.completionCue" to "notification" or "bell" in your User settings.',
        settingsAction,
      )
      if (answer === settingsAction) await openCompletionCueSettings()
      return
    }
    if (mode === 'notification') {
      const native = await notifyCompletionCue(COMPLETION_CUE_NOTIFICATION)
      if (!native) {
        const answer = await vscode.window.showWarningMessage(
          'Desktop notifications are unavailable; VS Code can only show this cue inside its window. Choose "bell" for an audible cue.',
          settingsAction,
        )
        if (answer === settingsAction) await openCompletionCueSettings()
      }
      return
    }
    // One chord, not one per open editor chat: target the surface a real cue
    // would come from.
    const surface = surfaces.active
    if (surface === undefined || !(await postEventTo(surface.surfaceId, PLAY_COMPLETION_CUE_EVENT, {}))) {
      await vscode.window.showWarningMessage(
        'The JaboDSH chat is not ready. Open it, then run the completion cue test again.',
      )
      return
    }
    // Delivery only proves the frame reached the Webview; playback policy can
    // still keep the first chime silent until the chat has been clicked.
    void vscode.window.showInformationMessage(
      'Completion cue test sent. If you heard nothing, click inside the chat once and run the test again.',
    )
  }
  const commands = createCommandsAssembly({
    context,
    configuration,
    diagnostics,
    coordinator,
    router,
    provider,
    editorSurfaces,
    moveChatToSidebar,
    openDroppedSession,
    sessionNavigation,
    surfaces,
    runtimeLocator,
    runtimeInstaller,
    endpointLaunchUrls,
    reconnect,
    reconnectOnTransportChange,
    publishState,
    postEvent,
    postFeatureEvent,
    postEditorContextAvailabilityEvent,
    editorContextUseCases,
    featureContextOwner,
    editorContextProvider,
    invalidateCurrentWorkspaceSessionDetails,
    disposeAccountLifecycleHost,
    stopAllJobFollows,
    changeTracker,
    taskRegistry,
    backendService,
    supervisor,
    attachmentTokens,
    channel,
    authorizeExternalConnection: async () => {
      const endpoint = selectedCustomEndpoint(configuration)
      await externalConnection.authorize(endpoint)
      await reconnect()
    },
    clearExternalCredentials: async () => {
      await externalConnection.clear(selectedCustomEndpoint(configuration))
      await reconnect().catch((error: unknown) => {
        if (!(error instanceof AppError && ['AUTH_REQUIRED', 'PERMISSION_DENIED'].includes(error.code)))
          throw error
      })
    },
    disposeEndpointAccess: () => externalConnection.dispose(),
    testCompletionCue,
  })

  const root: CompositionRoot = {
    start: commands.start,
    dispose: () => {
      eventLoopLag.dispose()
      transcript.dispose()
      sessionWatch.dispose()
      disposeHostEventPipeline()
      return commands.dispose()
    },
  }
  return root
}

function selectedCustomEndpoint(configuration: VsCodeConfigurationSource): BackendEndpoint {
  const connection = configuration.read().connection
  const endpoint = connection.mode === 'custom' ? endpointFromServerUrl(connection.serverUrl) : undefined
  if (endpoint === undefined)
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'Select a custom DSH endpoint before configuring connection credentials.',
      retryable: false,
    })
  return endpoint
}
