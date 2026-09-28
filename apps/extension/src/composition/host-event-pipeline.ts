import * as vscode from 'vscode'
import type {
  AccountLifecycleSnapshot,
  BackendEvent,
  BackendState,
  DshBackend,
  DshRuntimeUpdateProgress,
  EditorContextOwner,
  PluginInstallProgressView,
} from '@dsh-vscode/domain'
import type { BackendService, EditorContextUseCases } from '@dsh-vscode/application'
import type { FeatureHostEvent, FeatureHostMessage, HostMessage } from '@dsh-vscode/webview-protocol'
import type { RedactedDiagnostics } from '../backend/diagnostics.js'
import type { TemporaryWorkspaceManager } from '../backend/temporary-workspace.js'
import { publicWorkspaceRelativePath, sanitizePublicValue } from '../view/public-value.js'
import { updateContextKeys, updateEditorContextAvailabilityKeys } from '../vscode/context-keys.js'
import { publicState } from './public-projection.js'
import { featureContextKinds, type FeatureContextKind } from './editor-files.js'

export type PostHostMessage = (message: HostMessage | FeatureHostMessage) => Thenable<boolean>

type AccountFeatureHostEvent =
  | Extract<FeatureHostEvent, { readonly name: 'account.lifecycle.updated' }>
  | Extract<FeatureHostEvent, { readonly name: 'account.session-expired' }>
  | Extract<FeatureHostEvent, { readonly name: 'account.lifecycle.error' }>

export type PostFeatureEvent = (
  name:
    | 'editor.context.changed'
    | 'editor.context.availability.changed'
    | 'schedule.invalidated'
    | 'plugin.manager.changed'
    | 'plugin.install.progress',
  payload:
    | { readonly contextRef: string; readonly action: 'added' | 'updated' | 'released' }
    | { readonly availableKinds: FeatureContextKind[] }
    | PluginInstallProgressView
    | Record<string, never>,
) => Promise<boolean>

export type PublishAccountError = (
  code: 'state-stream-failed' | 'expiry-stream-failed' | 'browser-open-failed',
) => void

export interface HostEventPipelineDependencies {
  readonly post: PostHostMessage
  readonly backendService: BackendService
  readonly diagnostics: RedactedDiagnostics
  readonly editorContextUseCases: EditorContextUseCases
  readonly featureOwner: () => EditorContextOwner
  readonly currentWorkspaceFolders: () => readonly vscode.WorkspaceFolder[]
  readonly temporaryWorkspaceManager: TemporaryWorkspaceManager
  /** Shared cell so a publisher can be installed after the runtime assembly. */
  readonly runtimeUpdateProgress: { current: (progress: DshRuntimeUpdateProgress) => void }
}

export interface HostEventPipeline {
  readonly postFeatureEvent: PostFeatureEvent
  readonly publishAccountSnapshot: (snapshot: AccountLifecycleSnapshot) => void
  readonly publishAccountSessionExpired: () => void
  readonly publishAccountError: PublishAccountError
  readonly postEditorContextAvailabilityEvent: () => Promise<void>
  readonly postEvent: (name: string, payload: unknown) => Promise<boolean>
  readonly postBackendEvent: (backend: DshBackend, event: BackendEvent) => Promise<boolean>
  readonly publishState: (state: BackendState) => void
  readonly nextFeatureLocalSequence: (this: void) => number
}

/**
 * Every Host→Webview event channel: the schema-checked envelope post, the
 * feature-event posters sharing one local sequence, the serialized backend
 * event queue, and the authoritative connection-state publisher.
 */
export function createHostEventPipeline(deps: HostEventPipelineDependencies): HostEventPipeline {
  const {
    post,
    backendService,
    diagnostics,
    editorContextUseCases,
    featureOwner,
    currentWorkspaceFolders,
    temporaryWorkspaceManager,
    runtimeUpdateProgress,
  } = deps
  let featureLocalSequence = 0
  const postFeatureEvent = (
    name:
      | 'editor.context.changed'
      | 'editor.context.availability.changed'
      | 'schedule.invalidated'
      | 'plugin.manager.changed'
      | 'plugin.install.progress',
    payload:
      | { readonly contextRef: string; readonly action: 'added' | 'updated' | 'released' }
      | { readonly availableKinds: FeatureContextKind[] }
      | PluginInstallProgressView
      | Record<string, never>,
  ): Promise<boolean> => {
    let connection: DshBackend['connection']
    try {
      connection = backendService.requireBackend().connection
    } catch {
      return Promise.resolve(false)
    }
    const backendInstanceId = connection.backendInstanceId
    const connectionGeneration = connection.connectionGeneration
    if (backendInstanceId === undefined || connectionGeneration === undefined) return Promise.resolve(false)
    featureLocalSequence += 1
    const identity = {
      backendInstanceId,
      connectionGeneration,
      stream: 'local' as const,
      localSeq: featureLocalSequence,
    }
    const event: FeatureHostEvent =
      name === 'editor.context.changed'
        ? {
            type: 'feature.event',
            name,
            identity,
            contextRef: (payload as { readonly contextRef: string }).contextRef,
            action: (payload as { readonly action: 'added' | 'updated' | 'released' }).action,
          }
        : name === 'editor.context.availability.changed'
          ? {
              type: 'feature.event',
              name,
              identity,
              availableKinds: (payload as { readonly availableKinds: FeatureContextKind[] }).availableKinds,
            }
          : name === 'plugin.install.progress'
            ? { type: 'feature.event', name, identity, ...(payload as PluginInstallProgressView) }
            : { type: 'feature.event', name, identity }
    return Promise.resolve(post(event))
  }
  const postAccountFeatureEvent = (
    build: (
      identity: Extract<FeatureHostEvent, { readonly name: 'account.lifecycle.updated' }>['identity'],
    ) => AccountFeatureHostEvent,
  ): Promise<boolean> => {
    let connection: DshBackend['connection']
    try {
      connection = backendService.requireBackend().connection
    } catch {
      return Promise.resolve(false)
    }
    const backendInstanceId = connection.backendInstanceId
    const connectionGeneration = connection.connectionGeneration
    if (backendInstanceId === undefined || connectionGeneration === undefined) return Promise.resolve(false)
    featureLocalSequence += 1
    return Promise.resolve(
      post(
        build({
          backendInstanceId,
          connectionGeneration,
          stream: 'host',
          localSeq: featureLocalSequence,
        }),
      ),
    )
  }
  const publishAccountSnapshot = (snapshot: AccountLifecycleSnapshot): void => {
    void postAccountFeatureEvent((identity) => ({
      type: 'feature.event',
      name: 'account.lifecycle.updated',
      identity,
      snapshot,
    }))
  }
  const publishAccountSessionExpired = (): void => {
    void postAccountFeatureEvent((identity) => ({
      type: 'feature.event',
      name: 'account.session-expired',
      identity,
    }))
  }
  const publishAccountError: PublishAccountError = (code) => {
    void postAccountFeatureEvent((identity) => ({
      type: 'feature.event',
      name: 'account.lifecycle.error',
      identity,
      code,
    }))
  }
  const postEditorContextAvailabilityEvent = async (): Promise<void> => {
    try {
      const availability = await editorContextUseCases.availability(featureOwner())
      await updateEditorContextAvailabilityKeys(vscode.commands, availability.availableKinds)
      await postFeatureEvent('editor.context.availability.changed', {
        availableKinds: featureContextKinds(availability),
      })
    } catch {
      await updateEditorContextAvailabilityKeys(vscode.commands, []).catch(() => undefined)
      // Capability refresh is best effort; the next feature list remains the
      // authoritative recovery path when the view or backend is reconnecting.
    }
  }
  let sequence = 0
  let eventPostQueue = Promise.resolve()
  const enqueueEvent = (
    resolve: () => Promise<{ readonly name: string; readonly payload: unknown } | undefined>,
  ): Promise<boolean> => {
    const task = eventPostQueue.then(async () => {
      const nextEvent = await resolve()
      if (nextEvent === undefined) return true
      const nextSequence = sequence + 1
      const delivered = await post({
        type: 'event',
        name: nextEvent.name,
        sequence: nextSequence,
        payload: nextEvent.payload,
      })
      if (delivered) sequence = nextSequence
      return delivered
    })
    eventPostQueue = task.then(
      () => undefined,
      () => undefined,
    )
    return task.catch(() => false)
  }
  const postEvent = (name: string, payload: unknown): Promise<boolean> => {
    return enqueueEvent(() => Promise.resolve({ name, payload }))
  }
  const publicBackendEvent = async (backend: DshBackend, event: BackendEvent): Promise<unknown> => {
    if (event.type !== 'deliverables.presented') return sanitizePublicValue(event)
    const session = await backend.sessions.get(event.sessionId).catch(() => undefined)
    const roots = [
      ...currentWorkspaceFolders().map((folder) => folder.uri.fsPath),
      ...(temporaryWorkspaceManager.current?.path === undefined
        ? []
        : [temporaryWorkspaceManager.current.path]),
      ...(temporaryWorkspaceManager.reference?.path === undefined
        ? []
        : [temporaryWorkspaceManager.reference.path]),
    ]
    const uniqueRoots = [...new Set(roots)]
    const files = event.files.flatMap((file) => {
      const relativePath = publicWorkspaceRelativePath(file.path, session?.cwd, uniqueRoots)
      return relativePath === undefined ? [] : [{ ...file, path: relativePath }]
    })
    // Do not publish a card whose paths cannot be mapped into a workspace
    // owned by this Extension Host. The raw source path stays Host-local.
    if (files.length === 0) return undefined
    return sanitizePublicValue({ ...event, files })
  }
  const postBackendEvent = (backend: DshBackend, event: BackendEvent): Promise<boolean> =>
    enqueueEvent(async () => {
      const payload = await publicBackendEvent(backend, event)
      return payload === undefined ? undefined : { name: event.type, payload }
    })
  runtimeUpdateProgress.current = (progress) => {
    void postEvent('runtime.update.progress', progress)
  }
  const publishState = (state: BackendState): void => {
    void updateContextKeys(vscode.commands, state)
    diagnostics.log('info', 'connection-state', { state: state.kind })
    const payload = publicState(state)
    void postEvent('connection.snapshot', payload)
  }
  const nextFeatureLocalSequence = (): number => {
    featureLocalSequence += 1
    return featureLocalSequence
  }
  return {
    postFeatureEvent,
    publishAccountSnapshot,
    publishAccountSessionExpired,
    publishAccountError,
    postEditorContextAvailabilityEvent,
    postEvent,
    postBackendEvent,
    publishState,
    nextFeatureLocalSequence,
  }
}
