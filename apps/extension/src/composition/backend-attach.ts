import * as vscode from 'vscode'
import type {
  AccountLifecycleSnapshot,
  BackendEvent,
  DshBackend,
  SignOutImpact,
} from '@dsh-vscode/domain'
import { AccountLifecycleUseCases, type BackendService, type SessionUseCases } from '@dsh-vscode/application'
import { AccountLifecycleHost } from '../account/account-lifecycle-host.js'
import { projectPluginInstallProgress } from '../plugins/plugin-manager-event-projection.js'
import type { ChangeSetTracker } from '../changes/change-set-tracker.js'
import type { TaskCenterRegistry } from '../tasks/task-center-registry.js'
import type { EditorContextProvider } from '../editor/editor-context-provider.js'
import type { RedactedDiagnostics } from '../backend/diagnostics.js'
import type { PostFeatureEvent, PublishAccountError } from './host-event-pipeline.js'
import type { TaskFocusState } from './change-checkpoint-task-assembly.js'

export interface BackendAttachDependencies {
  readonly backendService: BackendService
  readonly sessionUseCases: SessionUseCases
  readonly extensionVersion: string
  readonly diagnostics: RedactedDiagnostics
  readonly stopAllJobFollows: (this: void) => void
  readonly invalidateCurrentWorkspaceSessionDetails: (this: void) => void
  readonly changeTracker: ChangeSetTracker
  readonly taskRegistry: TaskCenterRegistry
  readonly editorContextProvider: EditorContextProvider
  readonly currentWorkspaceFolderId: (this: void) => string | undefined
  readonly taskFocus: TaskFocusState
  readonly postFeatureEvent: PostFeatureEvent
  readonly postBackendEvent: (backend: DshBackend, event: BackendEvent) => Promise<boolean>
  readonly publishAccountSnapshot: (snapshot: AccountLifecycleSnapshot) => void
  readonly publishAccountSessionExpired: () => void
  readonly publishAccountError: PublishAccountError
}

export interface BackendAttachAssembly {
  readonly attach: (backend: DshBackend) => Promise<void>
  readonly disposeAccountLifecycleHost: () => Promise<void>
  readonly getAccountLifecycleHost: () => AccountLifecycleHost | undefined
  readonly detachSessionAdapters: () => void
}

/**
 * Attach a connected backend: forward its events into the Webview pipeline,
 * translate the plugin/schedule remote events, and run the account lifecycle
 * host for the connection. Detaching covers the lost-connection cleanup shared
 * with an explicit reconnect.
 */
export function createBackendAttach(deps: BackendAttachDependencies): BackendAttachAssembly {
  const {
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
  } = deps
  let accountLifecycleHost: AccountLifecycleHost | undefined
  const disposeAccountLifecycleHost = async (): Promise<void> => {
    const previous = accountLifecycleHost
    accountLifecycleHost = undefined
    await previous?.dispose()
  }
  const detachSessionAdapters = (): void => {
    changeTracker.detach()
    taskRegistry.detach()
    editorContextProvider.dispose()
    taskFocus.clearSessionId()
  }
  const getAccountLifecycleHost = (): AccountLifecycleHost | undefined => accountLifecycleHost
  const attach = async (backend: DshBackend): Promise<void> => {
    await disposeAccountLifecycleHost()
    stopAllJobFollows()
    invalidateCurrentWorkspaceSessionDetails()
    changeTracker.attach(backend, currentWorkspaceFolderId)
    taskRegistry.attach(backend, currentWorkspaceFolderId)
    backendService.attach(backend, (event) => {
      if (event.type === 'remote.event' && event.name === 'plugin-manager/changed') {
        void postFeatureEvent('plugin.manager.changed', {})
        return
      }
      if (event.type === 'remote.event' && event.name === 'plugin-manager/install-log') {
        // Package output may contain credentials, local paths, and command arguments.
        return
      }
      if (event.type === 'remote.event' && event.name === 'plugin-manager/install-state') {
        const progress = projectPluginInstallProgress(event.args)
        if (progress !== undefined) void postFeatureEvent('plugin.install.progress', progress)
        return
      }
      if (event.type === 'remote.event' && event.name === 'schedule/changed') {
        // Do not forward the upstream event arguments (which may contain task
        // details) to the generic Webview event channel. Signal a Host reload.
        void postFeatureEvent('schedule.invalidated', {})
        return
      }
      if (
        event.type === 'workspace.changed' ||
        event.type === 'workspace.removed' ||
        event.type === 'workspace.order.changed' ||
        event.type === 'archived.sessions.changed' ||
        event.type === 'session.added' ||
        event.type === 'session.removed'
      )
        invalidateCurrentWorkspaceSessionDetails()
      if (event.type === 'connection.lost') {
        void disposeAccountLifecycleHost()
        invalidateCurrentWorkspaceSessionDetails()
        detachSessionAdapters()
      }
      void postBackendEvent(backend, event)
    })
    if (backend.account !== undefined) {
      const useCases = new AccountLifecycleUseCases(backend.account)
      accountLifecycleHost = new AccountLifecycleHost({
        useCases,
        endpoint: () => backend.connection.endpoint,
        client: () => ({
          version: extensionVersion,
          locale: vscode.env.language || 'en',
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        }),
        openExternal: async (url) => await vscode.env.openExternal(vscode.Uri.parse(url)),
        ...(backend.sessions.initializeDefaultModel === undefined
          ? {}
          : {
              initializeDefaultModel: (signal: AbortSignal) => sessionUseCases.initializeDefaultModel(signal),
              reportDiagnostic: () => diagnostics.log('warn', 'account-default-model-initialization-failed'),
            }),
        publishSnapshot: publishAccountSnapshot,
        publishSessionExpired: publishAccountSessionExpired,
        reportError: publishAccountError,
        confirmSignOut: async (impact: SignOutImpact) => {
          const detail =
            impact === 'running'
              ? vscode.l10n.t('DSH reports running account tasks. Signing out may interrupt them. Continue?')
              : impact === 'unknown'
                ? vscode.l10n.t(
                    'DSH could not confirm whether account tasks are running. Signing out may interrupt them. Continue?',
                  )
                : vscode.l10n.t(
                    'No running account tasks were detected. Remove the stored DSH account grant?',
                  )
          const confirmLabel = vscode.l10n.t('Sign out')
          const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t('Sign out of the DSH account?'),
            { modal: true, detail },
            confirmLabel,
          )
          return choice === confirmLabel
        },
      })
      accountLifecycleHost.start()
    }
  }
  return { attach, disposeAccountLifecycleHost, getAccountLifecycleHost, detachSessionAdapters }
}
