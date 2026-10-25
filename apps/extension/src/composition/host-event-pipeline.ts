import { ControlDelivery } from '../view/control-delivery.js'
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

/**
 * High-volume state frames that may wait behind each other. Every other
 * Host event (interactions, queue/status updates, connection changes) is
 * control traffic and must not queue behind a streaming burst.
 */
const BULK_EVENT_NAMES = new Set([
  'session.transcript',
  'session.transcript.patch',
  'runtime.update.progress',
])
export function isBulkEvent(name: string): boolean {
  return BULK_EVENT_NAMES.has(name)
}

const ACTIVE_SESSION_ONLY_EVENT_NAMES = new Set([
  'session.configuration',
  'session.system',
  'goal.updated',
  'jobs.updated',
  'job.follow.updated',
  'job.follow.failed',
])

// Unknown projection keys stay global: titles, session-list metadata and
// interaction snapshots are consumed outside the currently opened transcript.
const ACTIVE_SESSION_PROJECTION_KEYS = new Set(['todoList', 'plan', 'context', 'checkpoints', 'rollback'])

function coalesceSlotKey(surfaceScope: string, name: string, payload: unknown): string | undefined {
  if (name === 'runtime.update.progress') return JSON.stringify([surfaceScope, name])
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined
  if (sessionId === undefined) return undefined
  switch (name) {
    case 'session.status':
    case 'session.activity':
    case 'session.title':
    case 'session.system':
    case 'jobs.updated':
    case 'goal.updated':
    case 'subagent.catalog.updated':
      return JSON.stringify([surfaceScope, name, sessionId])
    case 'session.projection':
      return typeof record.key === 'string' && record.key !== 'userQuestions'
        ? JSON.stringify([surfaceScope, name, sessionId, record.key])
        : undefined
    default:
      return undefined
  }
}

function payloadSequence(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const seq = (payload as { readonly sequence?: unknown }).sequence
  return typeof seq === 'number' && Number.isSafeInteger(seq) ? seq : undefined
}

/** Executed tool context shares the reserved control capacity, in source order. */
function hasActiveToolContext(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const value = payload as { readonly nodes?: unknown; readonly changedNodes?: unknown }
  const nodes = value.changedNodes ?? value.nodes
  return (
    Array.isArray(nodes) &&
    nodes.some(
      (node: unknown) =>
        typeof node === 'object' &&
        node !== null &&
        'kind' in node &&
        node.kind === 'tool' &&
        'tool' in node &&
        typeof node.tool === 'object' &&
        node.tool !== null &&
        'status' in node.tool &&
        node.tool.status === 'running',
    )
  )
}

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
    | 'billing.settings.changed'
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
  readonly surfaceIds?: () => readonly string[]
  readonly transcript: Pick<TranscriptWindowService, 'accept' | 'dispose'> & {
    readonly surfacesForSession?: (sessionId: string) => readonly string[] | undefined
  }
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
  readonly acknowledgeEvents: (surfaceId: string, sequence: number) => void
  readonly forgetSurface: (surfaceId: string) => void
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
      | 'billing.settings.changed'
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
  let availabilityRun: Promise<void> | undefined
  let availabilityRerun = false
  let availabilityEpoch = 0
  let publishedAvailabilityKinds: readonly string[] | undefined
  const publishAvailabilityOnce = async (): Promise<void> => {
    try {
      for (;;) {
        availabilityRerun = false
        const epoch = availabilityEpoch
        try {
          const availability = await editorContextUseCases.availability(featureOwner())
          const kinds = featureContextKinds(availability)
          // Editor listeners funnel every keystroke into availability recomputes
          // that usually answer the same kinds. Only a real gate change needs
          // new context keys and a renderer event; identical results would just
          // hand the Webview a fresh array and a full re-render.
          if (
            publishedAvailabilityKinds === undefined ||
            kinds.length !== publishedAvailabilityKinds.length ||
            kinds.some((kind, index) => kind !== publishedAvailabilityKinds![index])
          ) {
            await updateEditorContextAvailabilityKeys(vscode.commands, availability.availableKinds)
            const delivered = await postFeatureEvent('editor.context.availability.changed', {
              availableKinds: kinds,
            })
            // A failed receipt is not a published baseline. The next trigger
            // must retry even when the editor still offers the same kinds.
            publishedAvailabilityKinds = delivered && epoch === availabilityEpoch ? kinds : undefined
          }
        } catch {
          publishedAvailabilityKinds = undefined
          await updateEditorContextAvailabilityKeys(vscode.commands, []).catch(() => undefined)
          // Capability refresh is best effort; the next feature list remains the
          // authoritative recovery path when the view or backend is reconnecting.
        }
        if (!availabilityRerun) break
      }
    } finally {
      availabilityRun = undefined
    }
  }
  const postEditorContextAvailabilityEvent = (): Promise<void> => {
    // Selection, diagnostics, and activation listeners call this per keystroke
    // and per lint round. Runs are single-flight with latest-wins: a call
    // arriving during a run only marks a rerun, so a burst costs one
    // computation plus at most one trailing pass instead of one per keystroke,
    // and results are published strictly in order — the previous unbounded
    // concurrent runs could interleave and publish out of order.
    if (availabilityRun === undefined) availabilityRun = publishAvailabilityOnce()
    else availabilityRerun = true
    return availabilityRun
  }
  let sequence = 0
  let eventOrder = 0
  type ResolvedEvent = { readonly name: string; readonly payload: unknown } | undefined
  let eventEpoch = 0
  const surfaceEpochs = new Map<string, object>()
  let eventBackend: DshBackend | undefined
  const broadcastReceipts = new Map<
    string,
    {
      readonly receipts: readonly Promise<boolean>[]
      readonly result: Promise<boolean>
    }
  >()
  const combineReceipts = (
    key: string | undefined,
    receipts: readonly Promise<boolean>[],
  ): Promise<boolean> => {
    const previous = key === undefined ? undefined : broadcastReceipts.get(key)
    if (
      previous !== undefined &&
      previous.receipts.length === receipts.length &&
      receipts.every((receipt, index) => receipt === previous.receipts[index])
    )
      return previous.result
    const result = Promise.all(receipts)
      .then((results) => results.some(Boolean))
      .finally(() => {
        if (key !== undefined && broadcastReceipts.get(key)?.result === result) broadcastReceipts.delete(key)
      })
    if (key !== undefined) broadcastReceipts.set(key, { receipts, result })
    return result
  }
  const controlDelivery =
    deps.surfaceIds === undefined
      ? undefined
      : new ControlDelivery(
          postTo,
          () => ++sequence,
          (surfaceId) => deps.surfaceIds?.().includes(surfaceId) === true,
        )
  const eventPostQueue = new BoundedEventQueue(async (info) => {
    if (info?.priority === false || controlDelivery !== undefined) return
    await post({ type: 'event', name: 'ui.resync', sequence: ++sequence, payload: {} })
  })
  const enqueueEvent = (
    resolve: () => ResolvedEvent,
    chars: number,
    surfaceId?: string,
    priority = false,
    coalesceKey?: string,
    coalesceSequence?: number,
  ): Promise<boolean> => {
    if (surfaceId === undefined && deps.surfaceIds !== undefined) {
      return combineReceipts(
        coalesceKey === undefined ? undefined : JSON.stringify([eventEpoch, coalesceKey]),
        deps
          .surfaceIds()
          .map((id) =>
            enqueueEvent(
              resolve,
              chars,
              id,
              priority,
              coalesceKey === undefined ? undefined : JSON.stringify([id, coalesceKey]),
              coalesceSequence,
            ),
          ),
      )
    }
    const epoch = eventEpoch
    let surfaceEpoch = surfaceId === undefined ? undefined : surfaceEpochs.get(surfaceId)
    if (surfaceId !== undefined && surfaceEpoch === undefined) {
      surfaceEpoch = {}
      surfaceEpochs.set(surfaceId, surfaceEpoch)
    }
    const assignedSequence = ++eventOrder
    const resolveMessage = (): Extract<HostMessage, { type: 'event' }> | undefined => {
      if (epoch !== eventEpoch || (surfaceId !== undefined && surfaceEpochs.get(surfaceId) !== surfaceEpoch))
        return undefined
      const nextEvent = resolve()
      return nextEvent === undefined
        ? undefined
        : {
            type: 'event',
            name: nextEvent.name,
            sequence: assignedSequence,
            payload: nextEvent.payload,
          }
    }
    if (controlDelivery !== undefined && surfaceId !== undefined && priority) {
      const message = resolveMessage()
      return message === undefined
        ? Promise.resolve(true)
        : controlDelivery.enqueue(surfaceId, message, coalesceKey, () => resolveMessage() !== undefined)
    }
    const run = async (): Promise<boolean> => {
      if (epoch !== eventEpoch) return true
      const pending = resolveMessage()
      const message = pending === undefined ? undefined : { ...pending, sequence: ++sequence }
      if (message === undefined) return true
      const delivered = surfaceId === undefined ? await post(message) : await postTo(surfaceId, message)
      if (!delivered && priority) {
        // A control frame the Webview never received must not be followed by
        // a contiguously numbered stream: consume its sequence and ask for
        // the reread a rejected frame already triggers.
        if (surfaceId === undefined) eventPostQueue.invalidate()
        else if (message.name !== 'ui.resync') {
          // Recovery belongs to the failed surface. Never repeatedly retry
          // the recovery frame itself when that surface has gone away.
          const recoverySequence = ++sequence
          await postTo(surfaceId, {
            type: 'event',
            name: 'ui.resync',
            sequence: recoverySequence,
            payload: {},
          })
        }
      }
      return delivered
    }
    return coalesceKey === undefined
      ? eventPostQueue.enqueue(run, chars, priority)
      : eventPostQueue.enqueueLatest(
          JSON.stringify([epoch, surfaceId, coalesceKey]),
          run,
          chars,
          priority,
          coalesceSequence,
        )
  }

  const postEvent = (name: string, payload: unknown): Promise<boolean> => {
    deps.onEvent?.(name, payload)
    const priority = !isBulkEvent(name) || hasActiveToolContext(payload)
    return enqueueEvent(
      () => ({ name, payload }),
      eventPayloadCharacters(payload),
      undefined,
      priority,
      coalesceSlotKey('*', name, payload),
      payloadSequence(payload),
    )
  }
  const postEventTo: PostSurfaceEvent = (surfaceId, name, payload, isCurrent) => {
    const priority = !isBulkEvent(name) || hasActiveToolContext(payload)
    return enqueueEvent(
      () => (isCurrent?.() === false ? undefined : { name, payload }),
      eventPayloadCharacters(payload),
      surfaceId,
      priority,
      coalesceSlotKey(surfaceId, name, payload),
      payloadSequence(payload),
    )
  }
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
    if (eventBackend !== backend) {
      eventBackend = backend
      eventEpoch++
      controlDelivery?.reset()
    }
    deps.onEvent?.(event.type, event)
    if (deps.transcript.accept(event)) return Promise.resolve(true)
    const targetSurfaces =
      (ACTIVE_SESSION_ONLY_EVENT_NAMES.has(event.type) ||
        (event.type === 'session.projection' && ACTIVE_SESSION_PROJECTION_KEYS.has(event.key))) &&
      'sessionId' in event &&
      typeof event.sessionId === 'string'
        ? deps.transcript.surfacesForSession?.(event.sessionId)
        : undefined
    if (targetSurfaces !== undefined && targetSurfaces.length === 0) {
      return Promise.resolve(true)
    }
    const targetSurfaceId = targetSurfaces?.length === 1 ? targetSurfaces[0] : undefined
    const priority = !isBulkEvent(event.type)
    const resolvePayload = (): ResolvedEvent => {
      try {
        if (backendService.requireBackend() !== backend) return undefined
      } catch {
        return undefined
      }
      const payload = publicControlEvent(event)
      return payload === undefined ? undefined : { name: event.type, payload }
    }
    if (targetSurfaces !== undefined && targetSurfaces.length > 1) {
      const chars = eventPayloadCharacters(event)
      const seq = payloadSequence(event)
      return combineReceipts(
        coalesceSlotKey(`targets:${eventEpoch}:${targetSurfaces.join(',')}`, event.type, event),
        targetSurfaces.map((surfaceId) =>
          enqueueEvent(
            resolvePayload,
            chars,
            surfaceId,
            priority,
            coalesceSlotKey(surfaceId, event.type, event),
            seq,
          ),
        ),
      )
    }
    return enqueueEvent(
      resolvePayload,
      eventPayloadCharacters(event),
      targetSurfaceId,
      priority,
      coalesceSlotKey(targetSurfaceId ?? '*', event.type, event),
      payloadSequence(event),
    )
  }
  runtimeUpdateProgress.current = (progress) => {
    void postEvent('runtime.update.progress', progress)
  }
  const publishState = (state: BackendState): void => {
    // A new connection/view baseline must receive its own availability event.
    availabilityEpoch++
    publishedAvailabilityKinds = undefined
    if (state.kind !== 'connected') {
      eventEpoch++
      eventBackend = undefined
      controlDelivery?.reset()
      deps.transcript?.dispose()
    }
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
    acknowledgeEvents: (surfaceId, sequence) => controlDelivery?.acknowledge(surfaceId, sequence),
    forgetSurface: (surfaceId) => {
      surfaceEpochs.delete(surfaceId)
      controlDelivery?.forget(surfaceId)
    },
    dispose: () => {
      eventEpoch++
      controlDelivery?.dispose()
      broadcastReceipts.clear()
      eventPostQueue.dispose()
    },
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
