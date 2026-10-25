import type * as vscode from 'vscode'
import type { EditorContextOwner, SessionDetail, SessionSummary } from '@dsh-vscode/domain'
import type {
  AdvancedAgentUseCases,
  BackendService,
  DshConnectionCoordinator,
  EditorContextUseCases,
  ExportUseCases,
  InteractionUseCases,
  ModelSettingsUseCases,
  ProviderSettingsUseCases,
  RuntimeUseCases,
  SessionUseCases,
  SettingsUseCases,
  WorkspaceUseCases,
} from '@dsh-vscode/application'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import type { DshRuntimeLocator } from '../backend/runtime-locator.js'
import type { SessionWatchController } from '../backend/session-watch-coordinator.js'
import type { TemporaryWorkspaceManager } from '../backend/temporary-workspace.js'
import type { VsCodeConfigurationSource } from '../config/configuration-source.js'
import type { RedactedDiagnostics } from '../backend/diagnostics.js'
import type { EditorContextProvider } from '../editor/editor-context-provider.js'
import type { AttachmentStore } from '../attachments/attachment-store.js'
import type { WebviewSurfaceRegistry } from '../view/webview-surface-registry.js'
import type { SessionScope } from './session-scope.js'
import type { PostHostMessage, PostHostMessageTo, PostSurfaceEvent } from './host-event-pipeline.js'
import type { TranscriptWindowRegistry } from '../view/transcript-window-registry.js'

export interface RequestGatewayDependencies {
  readonly acknowledgeHostEvents?: (surfaceId: string, sequence: number) => void
  readonly forgetHostSurface?: (surfaceId: string) => void
  readonly prepareEditorSession?: (sessionId: string, signal: AbortSignal) => Promise<void>
  readonly transcript: TranscriptWindowRegistry
  readonly post: PostHostMessage
  readonly postTo: PostHostMessageTo
  readonly postEvent: (name: string, payload: unknown) => Promise<boolean>
  readonly postEventTo: PostSurfaceEvent
  /** Every live chat Webview: the sidebar view and zero or more editor panels. */
  readonly surfaces: WebviewSurfaceRegistry
  readonly handleFeatureRequest: (request: FeatureRequest, signal: AbortSignal) => Promise<unknown>
  readonly diagnostics: RedactedDiagnostics
  readonly context: vscode.ExtensionContext
  readonly currentWorkspaceFolders: () => readonly vscode.WorkspaceFolder[]
  readonly currentWorkspaceFolder: () => vscode.WorkspaceFolder | undefined
  readonly connect: (signal?: AbortSignal) => Promise<unknown>
  readonly reconnect: (signal?: AbortSignal) => Promise<unknown>
  readonly configureConnection: (
    mode: 'auto' | 'custom',
    endpoint: string | undefined,
    signal?: AbortSignal,
  ) => Promise<unknown>
  readonly runtimeUseCases: RuntimeUseCases
  readonly runtimeLocator: DshRuntimeLocator
  readonly coordinator: DshConnectionCoordinator
  /** Bounds per-session follow streams to displayed, running, or actionable sessions. */
  readonly sessionWatch: SessionWatchController
  readonly extensionVersion: string
  readonly configuration: VsCodeConfigurationSource
  readonly backendService: BackendService
  readonly listCurrentWorkspaces: SessionScope['listCurrentWorkspaces']
  readonly listCurrentArchivedSessionIds: SessionScope['listCurrentArchivedSessionIds']
  readonly ensureCurrentWorkspace: SessionScope['ensureCurrentWorkspace']
  readonly requireCurrentWorkspaceSession: SessionScope['requireCurrentWorkspaceSession']
  readonly requireCurrentWorkspaceId: SessionScope['requireCurrentWorkspaceId']
  readonly requireOwnedQueuedInput: SessionScope['requireOwnedQueuedInput']
  readonly requireOwnedGoal: SessionScope['requireOwnedGoal']
  readonly requireOwnedPermission: SessionScope['requireOwnedPermission']
  readonly requireOwnedQuestion: SessionScope['requireOwnedQuestion']
  readonly workspaceUseCases: WorkspaceUseCases
  readonly sessionUseCases: SessionUseCases
  readonly modelUseCases: ModelSettingsUseCases
  readonly interactionUseCases: InteractionUseCases
  readonly settingsUseCases: SettingsUseCases
  readonly providerSettingsUseCases: ProviderSettingsUseCases
  readonly advancedUseCases: AdvancedAgentUseCases
  readonly exportUseCases: ExportUseCases
  readonly temporaryWorkspaceManager: TemporaryWorkspaceManager
  readonly attachmentTokens: AttachmentStore
  readonly editorContextUseCases: EditorContextUseCases
  readonly contextOwnerForSession: (
    session: SessionDetail,
    requestedWorkspaceFolderId: string | undefined,
    hasContext: boolean,
  ) => EditorContextOwner
  readonly currentFeatureSessionBinding: (sessionId: string) => {
    readonly sessionId: string
    readonly backendInstanceId: string
    readonly connectionGeneration: number
  }
  readonly workspaceFolderIdForSession: (session: Pick<SessionSummary, 'cwd'>) => string | undefined
  readonly startJobFollow: (
    sessionId: string,
    jobId: string,
    followId: string,
    requestedFrom: number | undefined,
    signal: AbortSignal,
  ) => Promise<{ readonly started: boolean }>
  readonly stopJobFollow: (sessionId: string, jobId: string, followId: string) => boolean
  readonly stopAllJobFollows: (this: void) => void
  readonly editorContextProvider: EditorContextProvider
}
