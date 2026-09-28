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
import type { WebviewMessageRouter } from '../view/message-router.js'
import { DshWebviewViewProvider } from '../view/dsh-webview-view-provider.js'
import { stateSubscriptionDisposable } from './public-projection.js'
import type { PostFeatureEvent } from './host-event-pipeline.js'

const TRANSPORT_CONFIGURATION_KEYS = [
  'dsh.connection.mode',
  'dsh.connection.serverUrl',
  'dsh.connection.managedPort',
  'dsh.connection.attachPorts',
  'dsh.connection.discoveryTimeoutMs',
  'dsh.connection.requestTimeoutMs',
] as const

export interface CommandsAssemblyDependencies {
  readonly context: vscode.ExtensionContext
  readonly configuration: VsCodeConfigurationSource
  readonly diagnostics: RedactedDiagnostics
  readonly coordinator: DshConnectionCoordinator
  readonly router: WebviewMessageRouter
  readonly provider: DshWebviewViewProvider
  readonly runtimeLocator: DshRuntimeLocator
  readonly runtimeInstaller: RuntimeInstaller
  readonly endpointLaunchUrls: Map<string, string>
  readonly reconnect: (signal?: AbortSignal) => Promise<unknown>
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
  const subscriptions: vscode.Disposable[] = [
    stateSubscriptionDisposable(stateSubscription),
    provider,
    diagnostics,
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      invalidateCurrentWorkspaceSessionDetails()
      editorContextProvider.dispose()
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
  const start = (): Promise<void> => {
    subscriptions.push(
      vscode.window.registerWebviewViewProvider(DshWebviewViewProvider.viewType, provider, {
        // Keep the React tree and scroll position alive while the user
        // changes VS Code views. The Webview store also persists the last
        // session for a full Webview recreation.
        webviewOptions: { retainContextWhenHidden: true },
      }),
    )
    registerCommands({
      commands: vscode.commands,
      subscriptions: context.subscriptions,
      handlers: {
        'dsh.connect': () => reconnect(),
        'dsh.reconnect': () => reconnect(),
        'dsh.newSession': () => postEvent('ui.sessions.toggle', {}),
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
          stateKind !== 'starting'
        )
          return
        // Disconnect invalidates the coordinator generation and aborts an
        // in-flight attach. The shared reconnect operation coalesces this
        // automatic path with an explicit connection.configure reconnect.
        void reconnect().catch(() => {
          publishState({ kind: 'failed', message: 'DSH configuration reload failed.', retryable: true })
        })
      }),
    )
    return Promise.resolve()
  }
  const dispose = async (): Promise<void> => {
    const errors = await runCleanupSequence([
      () => router.cancelAll(),
      () => disposeAccountLifecycleHost(),
      () => stopAllJobFollows(),
      () => stateSubscription(),
      () => provider.dispose(),
      () => changeTracker.dispose(),
      () => taskRegistry.dispose(),
      () => backendService.detach(),
      () => coordinator.disconnect(),
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
