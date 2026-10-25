import * as vscode from 'vscode'
import { BillingFeatureHost } from './billing/billing-feature-handler.js'
import { ModelsDevPriceSource } from './billing/models-dev-price-source.js'
import { FrankfurterExchangeSource } from './billing/frankfurter-exchange-source.js'
import type { DshRuntimeUpdateProgress, EditorContextOwner, SessionSummary } from '@dsh-vscode/domain'
import {
  featureHostEnvelopeSchema,
  featureHostMessageSchema,
  hostEnvelopeSchema,
  hostMessageSchema,
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
    onEvent: (name, payload) => nativeNavigation.current?.acceptEvent(name, payload),
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
