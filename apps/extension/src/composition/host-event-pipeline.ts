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
import { sanitizePublicValue } from '../view/public-value.js'
import { updateContextKeys, updateEditorContextAvailabilityKeys } from '../vscode/context-keys.js'
import { publicState } from './public-projection.js'
import { featureContextKinds, type FeatureContextKind } from './editor-files.js'
import type { TranscriptWindowService } from '../view/transcript-window.js'
import { BoundedEventQueue, eventPayloadCharacters } from '../view/bounded-event-queue.js'

export type PostHostMessage = (message: HostMessage | FeatureHostMessage) => Thenable<boolean>
/** Deliver an event to exactly one surface (surface-owned state, not broadcasts). */
export type PostHostMessageTo = (
  surfaceId: string,
  message: HostMessage | FeatureHostMessage,
) => Thenable<boolean>
/** Surface-directed event poster: same sequence/queue as `postEvent`, one target. */
export type PostSurfaceEvent = (
  surfaceId: string,
  name: string,
  payload: unknown,
  isCurrent?: () => boolean,
) => Promise<boolean>

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
  readonly transcript: Pick<TranscriptWindowService, 'accept' | 'dispose'>
  readonly post: PostHostMessage
  readonly postTo: PostHostMessageTo
  /** Host consumers must not wait for delivery to a hidden or busy renderer. */
  readonly onEvent?: (name: string, payload: unknown) => void
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
  readonly dispose: () => void
  readonly postFeatureEvent: PostFeatureEvent
  readonly publishAccountSnapshot: (snapshot: AccountLifecycleSnapshot) => void
  readonly publishAccountSessionExpired: () => void
  readonly publishAccountError: PublishAccountError
  readonly postEditorContextAvailabilityEvent: () => Promise<void>
  readonly postEvent: (name: string, payload: unknown) => Promise<boolean>
  /** Surface-directed variant: the payload is state of that surface, not a broadcast. */
  readonly postEventTo: PostSurfaceEvent
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
    postTo,
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
  const eventPostQueue = new BoundedEventQueue(async () => {
    const nextSequence = sequence + 1
    if (await post({ type: 'event', name: 'ui.resync', sequence: nextSequence, payload: {} }))
      sequence = nextSequence
  })
  const enqueueEvent = (
    resolve: () => Promise<{ readonly name: string; readonly payload: unknown } | undefined>,
    chars: number,
    surfaceId?: string,
  ): Promise<boolean> => {
    return eventPostQueue.enqueue(async () => {
      const nextEvent = await resolve()
      if (nextEvent === undefined) return true
      const nextSequence = sequence + 1
      const message = {
        type: 'event' as const,
        name: nextEvent.name,
        sequence: nextSequence,
        payload: nextEvent.payload,
      }
      // A surface-directed event is that surface's own state; it must not leak
      // another surface's kind, session or count.
      const delivered = surfaceId === undefined ? await post(message) : await postTo(surfaceId, message)
      if (delivered) sequence = nextSequence
      return delivered
    }, chars)
  }
  const postEvent = (name: string, payload: unknown): Promise<boolean> => {
    deps.onEvent?.(name, payload)
    return enqueueEvent(() => Promise.resolve({ name, payload }), eventPayloadCharacters(payload))
  }
  const postEventTo: PostSurfaceEvent = (surfaceId, name, payload, isCurrent) =>
    enqueueEvent(
      () => Promise.resolve(isCurrent?.() === false ? undefined : { name, payload }),
      eventPayloadCharacters(payload),
      surfaceId,
    )
  const publicControlEvent = (event: BackendEvent): unknown =>
    sanitizePublicValue(event, undefined, [
      ...currentWorkspaceFolders().map((folder) => folder.uri.fsPath),
      ...(temporaryWorkspaceManager.current?.path === undefined
        ? []
        : [temporaryWorkspaceManager.current.path]),
      ...(temporaryWorkspaceManager.reference?.path === undefined
        ? []
        : [temporaryWorkspaceManager.reference.path]),
    ])
  const postBackendEvent = (backend: DshBackend, event: BackendEvent): Promise<boolean> => {
    // Reject the previous backend before it can mutate the current view.
    try {
      if (backendService.requireBackend() !== backend) return Promise.resolve(false)
    } catch {
      return Promise.resolve(false)
    }
    deps.onEvent?.(event.type, event)
    if (deps.transcript.accept(event)) return Promise.resolve(true)
    return enqueueEvent(() => {
      try {
        if (backendService.requireBackend() !== backend) return Promise.resolve(undefined)
      } catch {
        return Promise.resolve(undefined)
      }
      const payload = publicControlEvent(event)
      return Promise.resolve(payload === undefined ? undefined : { name: event.type, payload })
    }, eventPayloadCharacters(event))
  }
  runtimeUpdateProgress.current = (progress) => {
    void postEvent('runtime.update.progress', progress)
  }
  const publishState = (state: BackendState): void => {
    if (state.kind !== 'connected') deps.transcript?.dispose()
    void updateContextKeys(vscode.commands, state)
    diagnostics.log('info', 'connection-state', { state: state.kind })
    const payload = publicState(state, diagnostics.connectionOutput?.())
    void postEvent('connection.snapshot', payload)
  }
  const nextFeatureLocalSequence = (): number => {
    featureLocalSequence += 1
    return featureLocalSequence
  }
  return {
    dispose: () => eventPostQueue.dispose(),
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
  }
}
