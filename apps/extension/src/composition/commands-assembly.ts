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
import { DSH_DOCUMENTATION_URL } from '../constants.js'
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
import { registerNativeSessionList, SESSION_LIST_VIEW_ID } from '../view/native-session-list.js'

const TRANSPORT_CONFIGURATION_KEYS = [
  'dsh.connection.mode',
  'dsh.connection.serverUrl',
  'dsh.connection.runtimeVersion',
  'dsh.connection.managedPort',
  'dsh.connection.attachPorts',
  'dsh.connection.discoveryTimeoutMs',
  'dsh.connection.requestTimeoutMs',
] as const

export interface CommandsAssemblyDependencies {
  readonly sessionNavigation: RequestGateway['sessionNavigation']
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
}

export interface CommandsAssembly {
  readonly start: () => Promise<void>
  readonly dispose: () => Promise<void>
}

/**
 * The command registrations, event subscriptions, and the ordered start/
 * dispose sequence of the composition root. The dispose order is load-bearing:
 * it tears the Webview down before the adapters and the process supervisor.
 */
export function createCommandsAssembly(deps: CommandsAssemblyDependencies): CommandsAssembly {
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
      await provider.reveal(true)
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
  const revealThenPost = (name: string, payload: unknown): Promise<boolean> =>
    deliverOrRevealView(
      {
        post: postEvent,
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
          const delivered = await revealThenPost('ui.sessions.toggle', {})
          if (!delivered)
            await vscode.window.showWarningMessage('The DSH view could not be opened. Try opening it again.')
          return delivered
        },
        'dsh.openSessionList': () => vscode.commands.executeCommand(`${SESSION_LIST_VIEW_ID}.focus`),
        'dsh.openSettings': async () => {
          const delivered = await postEvent('ui.settings.toggle', {})
          if (!delivered)
            await vscode.commands.executeCommand(
              'workbench.action.openSettings',
              '@ext:Direwolf.deepseek-harness-client',
            )
        },
        'dsh.openWebUi': async () => {
          const state = coordinator.getState()
          if (state.kind !== 'connected') {
            void vscode.window.showInformationMessage(
              'Connect to a local DSH instance before opening its Web UI.',
            )
            return
          }
          const target =
            endpointLaunchUrls.get(state.backend.endpoint.baseUrl) ?? state.backend.endpoint.baseUrl
          const opened = await vscode.env.openExternal(vscode.Uri.parse(target))
          if (!opened) void vscode.window.showWarningMessage('Unable to open the DSH Web UI in your browser.')
        },
        'dsh.installRuntime': () => runtimeInstaller.install(),
        'dsh.selectExecutable': () => runtimeInstaller.selectExecutable(),
        'dsh.copyInstallCommand': () => runtimeInstaller.copyInstallCommand(),
        'dsh.openDocumentation': () => vscode.env.openExternal(vscode.Uri.parse(DSH_DOCUMENTATION_URL)),
        'dsh.openInSecondarySidebar': () => moveOrExplainSecondarySidebar(vscode.commands, vscode.window),
        // The Host has no active session of its own: an already-open editor tab
        // is revealed directly, otherwise the live chat is asked to move the
        // session it is showing.
        'dsh.openChatInEditor': async () => {
          const existing =
            editorSurfaces.surfacesById.find((surface) => surface.panel.active) ?? editorSurfaces.mostRecent
          if (existing !== undefined) {
            await existing.reveal(false)
            return true
          }
          const delivered = await revealThenPost('ui.surface.openInEditor', {})
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
        'dsh.showDiagnostics': () => diagnostics.show(),
        'dsh.addSelectionContext': () => captureEditorContextFromCommand('selection'),
        'dsh.addFileContext': () => captureEditorContextFromCommand('file'),
        'dsh.addSymbolContext': () => captureEditorContextFromCommand('symbol'),
        'dsh.addDiagnosticContext': () => captureEditorContextFromCommand('diagnostic'),
      },
    })
    void postEditorContextAvailabilityEvent()
    context.subscriptions.push(...subscriptions)
    context.subscriptions.push(
      configuration.onDidChange((affectsConfiguration) => {
        // A new executable path only takes effect on the next locate; the
        // memoized result would otherwise keep the previous one alive.
        if (affectsConfiguration('dsh.runtime.executablePath')) runtimeLocator.invalidate()
        if (!TRANSPORT_CONFIGURATION_KEYS.some((key) => affectsConfiguration(key))) return
        const stateKind = coordinator.getState().kind
        if (
          stateKind !== 'connected' &&
          stateKind !== 'connecting' &&
          stateKind !== 'discovering' &&
          stateKind !== 'locating-runtime' &&
          stateKind !== 'starting' &&
          stateKind !== 'failed' &&
          stateKind !== 'runtime-missing' &&
          stateKind !== 'port-conflict'
        )
          return
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
  return { start, dispose }
}
