import * as vscode from 'vscode'
import type {
  AgentConfiguration,
  DshRuntimeUpdateProgress,
  EditorContextOwner,
  SessionSummary,
} from '@dsh-vscode/domain'
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
import { VsCodeConfigurationSource } from './config/configuration-source.js'
import { OUTPUT_CHANNEL_NAME } from './constants.js'
import { workspaceFolderId } from './editor/workspace-path-guard.js'
import { DSH_CHAT_VIEW_OWNER_ID } from './editor/editor-context-provider.js'
import { sessionWorkspaceFolderId } from './view/session-workspace-scope.js'
import { readExtensionVersion } from './composition/runtime.js'
import { sameWorkspacePath } from './composition/workspace-state.js'
import { createSessionScope } from './composition/session-scope.js'
import {
  createUseCasesAssembly,
  resolveSessionConfigurationForRoster,
} from './composition/use-cases-assembly.js'
import { createConnectionLifecycle, createRuntimeAssembly } from './composition/connection-assembly.js'
import { createHostEventPipeline } from './composition/host-event-pipeline.js'
import { createChangeCheckpointTaskAssembly } from './composition/change-checkpoint-task-assembly.js'
import { createJobFollowHost } from './composition/job-follow-host.js'
import { createBackendAttach } from './composition/backend-attach.js'
import { createFeatureContext } from './composition/feature-context.js'
import { createFeatureRequestHandler } from './composition/feature-request-handler.js'
import { createRequestGateway } from './composition/request-handler.js'
import { createCommandsAssembly } from './composition/commands-assembly.js'

export interface CompositionRoot extends vscode.Disposable {
  start(): Promise<void>
}

export { resolveSessionConfigurationForRoster }

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
  // The Webview provider is created below, so `post` reads it through this
  // binding; no message can be posted before composition has finished.
  const post = (message: HostMessage | FeatureHostMessage): Thenable<boolean> => {
    const legacy = hostMessageSchema.safeParse(message)
    if (legacy.success)
      return provider.postMessage(hostEnvelopeSchema.parse({ protocolVersion: 1, message: legacy.data }))
    const feature = featureHostMessageSchema.safeParse(message)
    if (feature.success)
      return provider.postMessage(
        featureHostEnvelopeSchema.parse({ protocolVersion: 1, message: feature.data }),
      )
    diagnostics.log('warn', 'host-message-rejected', { code: 'PROTOCOL_ERROR' })
    return Promise.resolve(false)
  }
  const currentWorkspaceFolderId = (): string | undefined => {
    const folder = currentWorkspaceFolder()
    return folder === undefined ? undefined : workspaceFolderId(folder)
  }
  const workspaceFolderIdForSession = (session: Pick<SessionSummary, 'cwd'>): string | undefined =>
    sessionWorkspaceFolderId({
      folders: currentWorkspaceFolders().map((folder) => ({
        id: workspaceFolderId(folder),
        path: folder.uri.fsPath,
      })),
      session,
      samePath: sameWorkspacePath,
    })
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
  const resolveSessionConfiguration = async (
    requested: AgentConfiguration,
    signal?: AbortSignal,
  ): Promise<AgentConfiguration> => {
    const { presets } = await backendService.requireBackend().presets.list(signal)
    return resolveSessionConfigurationForRoster(requested, presets)
  }
  const featureOwner = (): EditorContextOwner => ({
    ownerId: DSH_CHAT_VIEW_OWNER_ID,
    ownerViewId: DSH_CHAT_VIEW_OWNER_ID,
    contextStoreGeneration: 1,
  })
  const {
    postFeatureEvent,
    publishAccountSnapshot,
    publishAccountSessionExpired,
    publishAccountError,
    postEditorContextAvailabilityEvent,
    postEvent,
    postBackendEvent,
    publishState,
    nextFeatureLocalSequence,
  } = createHostEventPipeline({
    post,
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
  const { attach, disposeAccountLifecycleHost, getAccountLifecycleHost, detachSessionAdapters } =
    createBackendAttach({
      backendService,
      sessionUseCases,
      extensionVersion,
      diagnostics,
      stopAllJobFollows,
      invalidateCurrentWorkspaceSessionDetails,
      changeTracker,
      taskRegistry,
      editorContextProvider,
      currentWorkspaceFolderId,
      taskFocus,
      postFeatureEvent,
      postBackendEvent,
      publishAccountSnapshot,
      publishAccountSessionExpired,
      publishAccountError,
    })
  const { connect, reconnect, configureConnection } = createConnectionLifecycle({
    context,
    configuration,
    coordinator,
    currentWorkspaceFolders,
    endpointLaunchUrls,
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
  const { router, provider } = createRequestGateway({
    post,
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
    resolveSessionConfiguration,
    startJobFollow,
    stopJobFollow,
    stopAllJobFollows,
    editorContextProvider,
  })
  const commands = createCommandsAssembly({
    context,
    configuration,
    diagnostics,
    coordinator,
    router,
    provider,
    runtimeLocator,
    runtimeInstaller,
    endpointLaunchUrls,
    reconnect,
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
  })

  const root: CompositionRoot = {
    start: commands.start,
    dispose: commands.dispose,
  }
  return root
}
