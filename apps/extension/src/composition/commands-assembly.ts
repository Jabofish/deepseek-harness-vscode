import * as vscode from 'vscode'
import {
  AppError,
  type BackendState,
  type EditorContextKind,
  type EditorContextOwner,
} from '@dsh-vscode/domain'
import type { BackendService, DshConnectionCoordinator, EditorContextUseCases } from '@dsh-vscode/application'
import { registerCommands } from '../commands/register-commands.js'
import { runCleanupSequence } from '../backend/cleanup-sequence.js'
import type { RedactedDiagnostics } from '../backend/diagnostics.js'
import type { DshProcessSupervisor } from '../backend/process-supervisor.js'
import type { DshRuntimeLocator } from '../backend/runtime-locator.js'
import type { ChangeSetTracker } from '../changes/change-set-tracker.js'
import type { TaskCenterRegistry } from '../tasks/task-center-registry.js'
import type { EditorContextProvider } from '../editor/editor-context-provider.js'
import type { AttachmentStore } from '../attachments/attachment-store.js'
import type { RuntimeInstaller } from '../vscode/install-runtime.js'
import type { VsCodeConfigurationSource } from '../config/configuration-source.js'
import { moveOrExplainSecondarySidebar } from '../vscode/secondary-sidebar.js'
import { openDshWebUi } from '../vscode/open-web-ui.js'
import { DSH_DOCUMENTATION_URL, EXTENSION_ID, SIDEBAR_SURFACE_ID } from '../constants.js'
import { deliverOrRevealView } from '../view/deliver-or-reveal.js'
import type { WebviewMessageRouter } from '../view/message-router.js'
import { DshWebviewViewProvider } from '../view/dsh-webview-view-provider.js'
import { persistedEditorChatSessionId } from '../view/editor-chat-surface-manager.js'
import type { EditorChatSurfaceManager } from '../view/editor-chat-surface-manager.js'
import { DshWebviewPanelSurface } from '../view/dsh-webview-panel-surface.js'
import type { WebviewSurfaceRegistry } from '../view/webview-surface-registry.js'
import { stateSubscriptionDisposable } from './public-projection.js'
import type { PostFeatureEvent } from './host-event-pipeline.js'
import { SESSION_DROP_EDITOR_VIEW_TYPE } from '@dsh-vscode/webview-protocol'
import { createSessionDropEditorProvider } from '../view/session-drop-editor.js'
import type { RequestGateway } from './request-handler.js'
import {
  promptSessionTitle,
  registerNativeSessionList,
  SESSION_LIST_VIEW_ID,
} from '../view/native-session-list.js'
import { EditorBridgeHost } from '../editor/editor-bridge-host.js'
import { reconnectsAfterConfigurationChange, retriesWithNewRuntime } from './configuration-reconnect.js'
import { openChatInEditorAction } from './open-chat-in-editor.js'

export interface CommandsAssemblyDependencies {
  readonly sessionNavigation: RequestGateway['sessionNavigation']
  readonly openSessionIds?: () => readonly string[]
  /** The conversation a chat surface currently shows, if any. */
  readonly surfaceSessionId?: (surfaceId: string) => string | undefined
  readonly authorizeExternalConnection?: () => Promise<void>
  readonly clearExternalCredentials?: () => Promise<void>
  readonly disposeEndpointAccess?: () => Promise<void>
  readonly context: vscode.ExtensionContext
  readonly configuration: VsCodeConfigurationSource
  readonly diagnostics: RedactedDiagnostics
  readonly coordinator: DshConnectionCoordinator
  readonly router: WebviewMessageRouter
  readonly provider: DshWebviewViewProvider
  /** Editor-area chat surfaces (one per session). */
  readonly editorSurfaces: EditorChatSurfaceManager
  readonly moveChatToSidebar: () => Promise<void>
  readonly openDroppedSession: RequestGateway['openDroppedSession']
  /** Every live chat surface, including the sidebar view. */
  readonly surfaces: WebviewSurfaceRegistry
  readonly runtimeLocator: DshRuntimeLocator
  readonly runtimeInstaller: RuntimeInstaller
  readonly endpointLaunchUrls: Map<string, string>
  readonly reconnect: (signal?: AbortSignal) => Promise<unknown>
  readonly reconnectOnTransportChange: (signal?: AbortSignal) => Promise<unknown>
  readonly publishState: (state: BackendState) => void
  readonly postEvent: (name: string, payload: unknown) => Promise<boolean>
  readonly postEventTo?: (surfaceId: string, name: string, payload: unknown) => Promise<boolean>
  readonly postFeatureEvent: PostFeatureEvent
  readonly postEditorContextAvailabilityEvent: () => Promise<void>
  readonly editorContextUseCases: EditorContextUseCases
  readonly featureContextOwner: (workspaceFolderIdValue?: string) => EditorContextOwner
  readonly editorContextProvider: EditorContextProvider
  readonly invalidateCurrentWorkspaceSessionDetails: (this: void) => void
  readonly disposeAccountLifecycleHost: () => Promise<void>
  readonly stopAllJobFollows: (this: void) => void
  readonly changeTracker: ChangeSetTracker
  readonly taskRegistry: TaskCenterRegistry
  readonly backendService: BackendService
  readonly supervisor: DshProcessSupervisor
  readonly attachmentTokens: AttachmentStore
  readonly channel: vscode.OutputChannel
  /** Exercises the configured completion cue independently of a live turn. */
  readonly testCompletionCue?: () => Promise<void>
}

export interface CommandsAssembly {
  readonly editorCompanion: EditorBridgeHost
  readonly start: () => Promise<void>
  readonly dispose: () => Promise<void>
}

/**
 * The command registrations, event subscriptions, and the ordered start/
 * dispose sequence of the composition root. The dispose order is load-bearing:
 * it tears the Webview down before the adapters and the process supervisor.
 */
export function createCommandsAssembly(deps: CommandsAssemblyDependencies): CommandsAssembly {
  const editorBridge = new EditorBridgeHost({
    ...deps,
    requestTimeoutMs: () => deps.configuration.read().connection.requestTimeoutMs,
  })
  const {
    context,
    configuration,
    diagnostics,
    coordinator,
    router,
    provider,
    editorSurfaces,
    surfaces,
    runtimeLocator,
    runtimeInstaller,
    endpointLaunchUrls,
    reconnect,
    reconnectOnTransportChange,
    publishState,
    postEvent,
    postEventTo,
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
  } = deps
  const captureEditorContextFromCommand = async (kind: EditorContextKind): Promise<void> => {
    try {
      const item = await editorContextUseCases.capture({ kind }, featureContextOwner())
      await postFeatureEvent('editor.context.changed', {
        contextRef: item.ref.contextRef,
        action: 'added',
      }).catch(() => false)
      await postEditorContextAvailabilityEvent()
      if (!surfaces.list().some((surface) => surface.visible)) await provider.reveal(true)
    } catch (error) {
      const detail =
        error instanceof AppError
          ? error.message
          : 'An unexpected error occurred. Open DSH diagnostics for the redacted failure details.'
      void vscode.window.showErrorMessage(`Unable to add ${kind} editor context: ${detail}`)
    }
  }
  const stateSubscription = coordinator.subscribe(publishState)
  const outputSubscription = diagnostics.subscribeConnectionOutput((output) => {
    void postEvent('connection.output', output)
  })
  const subscriptions: vscode.Disposable[] = [
    stateSubscriptionDisposable(stateSubscription),
    stateSubscriptionDisposable(outputSubscription),
    provider,
    diagnostics,
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      deps.sessionNavigation.invalidate()
      invalidateCurrentWorkspaceSessionDetails()
      taskRegistry.workspaceFoldersChanged()
      // This drops every captured context ref, so the availability keys have
      // to be recomputed in the same turn. They are what gates the "Add …
      // Context" menu entries, and none of the editor listeners below fires
      // for a folder change made from the Explorer while no editor is
      // touched — leaving the menu enabled over an emptied store.
      editorContextProvider.dispose()
      void postEditorContextAvailabilityEvent()
      void postEvent('workspace.changed', {})
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      void postEditorContextAvailabilityEvent()
    }),
    vscode.window.onDidChangeTextEditorSelection(() => {
      void postEditorContextAvailabilityEvent()
    }),
    vscode.languages.onDidChangeDiagnostics(() => {
      void postEditorContextAvailabilityEvent()
    }),
  ]
  const postToSurface = (surfaceId: string, name: string, payload: unknown): Promise<boolean> =>
    postEventTo === undefined ? postEvent(name, payload) : postEventTo(surfaceId, name, payload)
  const revealThenPostToSidebar = (name: string, payload: unknown): Promise<boolean> =>
    deliverOrRevealView(
      {
        post: (eventName, eventPayload) => postToSurface(SIDEBAR_SURFACE_ID, eventName, eventPayload),
        executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
        settle: () => provider.waitUntilReady(),
      },
      name,
      payload,
    )
  let nativeList: vscode.Disposable | undefined
  const start = (): Promise<void> => {
    nativeList = registerNativeSessionList(deps.sessionNavigation)
    subscriptions.push(
      nativeList,
      vscode.window.registerCustomEditorProvider(
        SESSION_DROP_EDITOR_VIEW_TYPE,
        createSessionDropEditorProvider(deps.openDroppedSession, () => {
          void vscode.window.showErrorMessage('Unable to open this chat in the editor area.')
        }),
      ),
      vscode.window.registerWebviewViewProvider(DshWebviewViewProvider.viewType, provider, {
        // Keep the React tree and scroll position alive while the user
        // changes VS Code views. The Webview store also persists the last
        // session for a full Webview recreation.
        webviewOptions: { retainContextWhenHidden: true },
      }),
      // Editor chat tabs survive a window reload. The serializer is only
      // called while the extension is activating, hence the
      // `onWebviewPanel:dsh.chatPanel` activation event in the manifest.
      vscode.window.registerWebviewPanelSerializer(DshWebviewPanelSurface.viewType, {
        deserializeWebviewPanel: (panel, state) => {
          editorSurfaces.adopt(panel, persistedEditorChatSessionId(state))
          return Promise.resolve()
        },
      }),
    )
    registerCommands({
      commands: vscode.commands,
      subscriptions: context.subscriptions,
      handlers: {
        'dsh.authorizeExternalConnection': () => deps.authorizeExternalConnection?.(),
        'dsh.clearExternalCredentials': () => deps.clearExternalCredentials?.(),
        'dsh.connect': () => reconnect(),
        'dsh.reconnect': () => reconnect(),
        'dsh.newSession': async () => {
          const delivered = await revealThenPostToSidebar('ui.sessions.toggle', {})
          if (!delivered)
            await vscode.window.showWarningMessage('The DSH view could not be opened. Try opening it again.')
          return delivered
        },
        'dsh.openSessionList': () => vscode.commands.executeCommand(`${SESSION_LIST_VIEW_ID}.focus`),
        'dsh.openSettings': async () => {
          const targetId = provider.visible
            ? SIDEBAR_SURFACE_ID
            : (surfaces.active?.surfaceId ?? SIDEBAR_SURFACE_ID)
          const delivered = await postToSurface(targetId, 'ui.settings.toggle', {})
          if (!delivered)
            await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`)
        },
        'dsh.openWebUi': () => openDshWebUi(coordinator.getState(), endpointLaunchUrls),
        // Same follow-up as the view's install button: a missing runtime
        // connects as soon as it exists, a live connection keeps running.
        'dsh.installRuntime': async () => {
          await runtimeInstaller.install()
          runtimeLocator.invalidate()
          if (retriesWithNewRuntime(coordinator.getState().kind)) await reconnect()
        },
        'dsh.selectExecutable': () => runtimeInstaller.selectExecutable(),
        'dsh.copyInstallCommand': () => runtimeInstaller.copyInstallCommand(),
        'dsh.openDocumentation': () => vscode.env.openExternal(vscode.Uri.parse(DSH_DOCUMENTATION_URL)),
        'dsh.openInSecondarySidebar': () => moveOrExplainSecondarySidebar(vscode.commands, vscode.window),
        // Ask the sidebar to open its current session in an editor tab first so
        // users can open multiple distinct sessions; fall back to revealing an
        // existing editor tab when the sidebar is hidden.
        'dsh.openChatInEditor': async () => {
          const existing =
            editorSurfaces.surfacesById.find((surface) => surface.panel.active) ?? editorSurfaces.mostRecent
          const action = openChatInEditorAction({
            sidebarVisible: provider.visible,
            sidebarSessionId: deps.surfaceSessionId?.(SIDEBAR_SURFACE_ID),
            hasEditorTab: existing !== undefined,
          })
          if (action === 'move-sidebar-session') {
            const delivered = await postToSurface(SIDEBAR_SURFACE_ID, 'ui.surface.openInEditor', {})
            if (delivered) return true
          }
          if (existing !== undefined) {
            await existing.reveal(false)
            return true
          }
          const delivered = await revealThenPostToSidebar('ui.surface.openInEditor', {})
          if (!delivered)
            await vscode.window.showWarningMessage(
              'Open the DSH chat and select a session before moving it to the editor area.',
            )
          return delivered
        },
        'dsh.moveChatToSidebar': async () => {
          await deps.moveChatToSidebar()
          return true
        },
        'dsh.renameEditorSession': async () => {
          const surface = editorSurfaces.surfacesById.find((candidate) => candidate.panel.active)
          const sessionId = surface?.sessionId
          if (surface === undefined || sessionId === undefined || !deps.sessionNavigation.connected) return
          const operation = new AbortController()
          const panelClosed = surface.panel.onDidDispose(() => operation.abort())
          const unsubscribe = coordinator.subscribe((state) => {
            if (state.kind !== 'connected') operation.abort()
          })
          try {
            const backend = backendService.requireBackend()
            const current = (): boolean =>
              !operation.signal.aborted &&
              editorSurfaces.forSession(sessionId) === surface &&
              backendService.requireBackend() === backend
            const currentTitle = await deps.sessionNavigation.readTitle(sessionId, operation.signal)
            if (!current()) return
            const title = await promptSessionTitle(currentTitle)
            if (title === undefined || title === currentTitle.trim() || !current()) return
            await deps.sessionNavigation.rename(sessionId, title, operation.signal)
          } catch (error) {
            if (!operation.signal.aborted)
              void vscode.window.showErrorMessage(
                error instanceof AppError
                  ? error.message
                  : vscode.env.language.toLowerCase().startsWith('zh')
                    ? '无法重命名此会话。'
                    : 'Unable to rename this session.',
              )
          } finally {
            unsubscribe()
            panelClosed.dispose()
          }
        },
        'dsh.showDiagnostics': () => diagnostics.show(),
        'dsh.completionCue.test': () => deps.testCompletionCue?.(),
        'dsh.addSelectionContext': () => captureEditorContextFromCommand('selection'),
        'dsh.addFileContext': () => captureEditorContextFromCommand('file'),
        'dsh.addSymbolContext': () => captureEditorContextFromCommand('symbol'),
        'dsh.addDiagnosticContext': () => captureEditorContextFromCommand('diagnostic'),
        'dsh.shareEditorState': () => editorBridge.enable(),
        'dsh.stopSharingEditorState': () => editorBridge.stopByUser(),
        'dsh.manageEditorCompanion': () => editorBridge.manage(),
        'dsh.installEditorCompanion': () => editorBridge.install(),
        'dsh.undoEditorEdit': () => editorBridge.undoLastEdit(),
      },
    })
    void postEditorContextAvailabilityEvent()
    context.subscriptions.push(...subscriptions)
    context.subscriptions.push(
      configuration.onDidChange((affectsConfiguration) => {
        // A new executable path only takes effect on the next locate; the
        // memoized result would otherwise keep the previous one alive.
        if (affectsConfiguration('dsh.runtime.executablePath')) runtimeLocator.invalidate()
        if (!reconnectsAfterConfigurationChange(affectsConfiguration, coordinator.getState().kind)) return
        // Disconnect invalidates the coordinator generation and aborts an
        // in-flight attach. The shared reconnect operation coalesces this
        // automatic path with an explicit connection.configure reconnect.
        void reconnectOnTransportChange().catch((error: unknown) => {
          if (
            (error instanceof AppError && error.code === 'REQUEST_CANCELLED') ||
            (error instanceof Error && error.name === 'AbortError')
          )
            return
          const current = coordinator.getState()
          if (current.kind === 'connected' || current.kind === 'failed') return
          publishState({ kind: 'failed', message: 'DSH configuration reload failed.', retryable: true })
        })
      }),
    )
    return Promise.resolve()
  }
  const dispose = async (): Promise<void> => {
    const errors = await runCleanupSequence([
      () => {
        nativeList?.dispose()
      },
      () => router.cancelAll(),
      () => editorBridge.dispose(),
      () => disposeAccountLifecycleHost(),
      () => stopAllJobFollows(),
      () => stateSubscription(),
      () => provider.dispose(),
      () => editorSurfaces.dispose(),
      () => surfaces.dispose(),
      () => changeTracker.dispose(),
      () => taskRegistry.dispose(),
      () => backendService.detach(),
      () => coordinator.disconnect(),
      () => deps.disposeEndpointAccess?.(),
      () => supervisor.dispose(),
      () => endpointLaunchUrls.clear(),
      () => attachmentTokens.clear(),
      () => channel.dispose(),
    ])
    if (errors.length > 0)
      throw new AggregateError(errors, 'The DSH connection and process could not be shut down cleanly.', {
        cause: errors[0],
      })
  }
  return { start, dispose, editorCompanion: editorBridge }
}
