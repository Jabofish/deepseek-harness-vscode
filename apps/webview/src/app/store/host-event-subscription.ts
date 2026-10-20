import type { PluginInstallProgressView, SubagentCatalog } from '@dsh-vscode/domain'
import type { ProtocolClient } from '../protocol-client.js'
import type { PluginInstallRecoveryController } from '../plugin-install-recovery.js'
import type { AppState, StateSetter } from './types.js'
import { requestId } from './ids.js'
import type { PendingOpenBuffer } from './opening-state.js'
import type { ProjectionSequenceIndex } from './session-projection.js'
import { isCommandDirectoryRefresh, isModelCatalogRefresh } from './command-directory.js'
import type { createCommandDirectoryCache } from './command-directory.js'
import type { createFeatureActions } from './feature-actions.js'
import type { createAccountActions } from './account-actions.js'
import type { createTurnWatchers } from './turn-watchers.js'
import type { createSurfaceActions } from './surface-actions.js'
import { parseHostDomainEvent } from './event-parser.js'
import { backendEventSessionId, applyHostMessage } from './host-message-reducers.js'
import { object } from './unknown-record.js'
import { parsePermissionCatalog } from './permission-catalog.js'
import { connectionIdentity } from './session-projection.js'

type AccountEventActions = Pick<
  ReturnType<typeof createAccountActions>,
  'applyConnectionIdentity' | 'applyFeatureEvent'
>
type FeatureEventActions = Pick<
  ReturnType<typeof createFeatureActions>,
  'applyFeatureEvent' | 'discardEditorContextForWorkspaceChange'
>
type CommandDirectory = Pick<ReturnType<typeof createCommandDirectoryCache>, 'invalidate'>
type TurnWatchers = ReturnType<typeof createTurnWatchers>
type SurfaceActions = ReturnType<typeof createSurfaceActions>

export interface HostEventSubscriptionLifecycle {
  readonly invalidateGlobalCatalogs: () => void
  readonly retireSessionReads: () => void
  readonly clearStartupRestorePending: () => void
  readonly getOpenVersion: () => number
  readonly incrementGoalReadGeneration: () => void
  readonly isDisposed: () => boolean
  readonly setGoalActivationAvailable: (available: boolean) => void
}

export interface HostEventSubscriptionDependencies {
  readonly accountActions: AccountEventActions
  readonly callbacks: { openCreatedSession?: (sessionId: string) => Promise<void> }
  readonly client: ProtocolClient
  readonly commandDirectory: CommandDirectory
  readonly featureActions: FeatureEventActions
  readonly getState: () => AppState
  readonly invalidateFeedback: () => void
  readonly lifecycle: HostEventSubscriptionLifecycle
  readonly loadSubagentCatalog: (sessionId: string) => Promise<SubagentCatalog | undefined>
  readonly pendingOpenBuffer: PendingOpenBuffer
  readonly pluginInstallRecovery: Pick<PluginInstallRecoveryController, 'progress'>
  readonly projectionSequences: ProjectionSequenceIndex
  readonly refresh: () => Promise<void>
  readonly refreshSessionDirectory: () => Promise<void>
  readonly refreshModelCatalog: () => Promise<void>
  readonly refreshCommands: (sessionId?: string, force?: boolean) => Promise<void>
  readonly refreshLiveGoals: () => Promise<void>
  readonly refreshSessionModelDirectoryForSession: (sessionId: string) => Promise<void>
  readonly reopenActiveView: () => void
  readonly setState: StateSetter
  readonly surfaceActions: SurfaceActions
  readonly turnWatchers: TurnWatchers
}

/** Owns both protocol subscriptions and translates events into store actions. */
export function subscribeHostEvents(deps: HostEventSubscriptionDependencies): () => void {
  const {
    accountActions,
    callbacks,
    client,
    commandDirectory,
    featureActions,
    getState,
    invalidateFeedback,
    lifecycle,
    loadSubagentCatalog,
    pendingOpenBuffer,
    pluginInstallRecovery,
    projectionSequences,
    refresh,
    refreshSessionDirectory,
    refreshCommands,
    refreshLiveGoals,
    refreshSessionModelDirectoryForSession,
    reopenActiveView,
    setState,
    surfaceActions,
    turnWatchers,
  } = deps
  let permissionCatalogGeneration = 0
  let resyncing = false
  const unsubscribe = client.subscribe((message) => {
    if (lifecycle.isDisposed()) return
    const previousBackendKind = getState().backend.kind
    const previousConnectionEpoch = getState().connectionEpoch
    const snapshot =
      message.type === 'event' && message.name === 'connection.snapshot' ? object(message.payload) : undefined
    const nextIdentity = connectionIdentity(snapshot)
    const sameConnection =
      previousBackendKind === 'connected' &&
      snapshot?.kind === 'connected' &&
      nextIdentity !== undefined &&
      nextIdentity === projectionSequences.connectionIdentity
    // Surface frames are Host-owned UI control messages whose handling includes
    // store side effects (opening the bound session, asking the Host to open the
    // active session in the editor area). They own their own reduction and never
    // reach the conversation pipeline.
    if (surfaceActions.applySurfaceEvent(message)) return
    if (message.type === 'event' && message.name === 'ui.resync') {
      turnWatchers.disposeAll()
      if (resyncing) return
      resyncing = true
      // The missing control frame may itself have been the connection snapshot.
      // Recover it and replay process-local interactions before reopening a view.
      void client
        .request({ type: 'app.ready', requestId: requestId(), payload: { snapshotOnly: true } })
        .then(() => {
          if (lifecycle.isDisposed()) return
          const state = getState()
          if (state.backend.kind !== 'connected') return
          if (state.activeSessionId !== undefined) {
            void client
              .request({
                type: 'session.transcript.resync',
                requestId: requestId(),
                payload: { sessionId: state.activeSessionId },
              })
              .catch(() => undefined)
            reopenActiveView()
          }
          void refresh().catch(() => undefined)
        })
        .catch(() => undefined)
        .finally(() => {
          resyncing = false
        })
      return
    }
    if (message.type === 'event' && message.name === 'session.transcript.invalidated') {
      if (
        object(message.payload)?.sessionId === getState().activeSessionId &&
        getState().transcript !== undefined &&
        getState().transcript?.historical !== true
      )
        reopenActiveView()
      return
    }
    if (
      message.type === 'event' &&
      (message.name === 'connection.lost' || (message.name === 'connection.snapshot' && !sameConnection))
    ) {
      permissionCatalogGeneration += 1
      lifecycle.invalidateGlobalCatalogs()
    }
    if (
      message.type === 'event' &&
      (message.name === 'connection.lost' ||
        (message.name === 'connection.snapshot' && object(message.payload)?.kind !== 'connected'))
    )
      // Retire every pending session read before clearing connection state;
      // late open/advisory results must not repopulate the departed host's data.
      lifecycle.retireSessionReads()
    if (
      message.type === 'event' &&
      (message.name === 'connection.snapshot' || message.name === 'connection.lost')
    ) {
      const snapshot = message.name === 'connection.snapshot' ? object(message.payload) : undefined
      const identity =
        snapshot?.kind === 'connected' &&
        typeof snapshot.backendInstanceId === 'string' &&
        typeof snapshot.connectionGeneration === 'number'
          ? `${snapshot.backendInstanceId}:${snapshot.connectionGeneration}`
          : undefined
      accountActions.applyConnectionIdentity(identity)
    }
    const parsedEvent = parseHostDomainEvent(message)
    if (parsedEvent?.type === 'goal.updated' && parsedEvent.sessionId === getState().activeSessionId)
      lifecycle.incrementGoalReadGeneration()
    if (parsedEvent?.type === 'turn.started' || parsedEvent?.type === 'turn.ended')
      turnWatchers.notify(parsedEvent)
    const messageSessionId =
      message.type === 'event' &&
      (message.name === 'session.transcript' || message.name === 'session.transcript.patch') &&
      typeof object(message.payload)?.sessionId === 'string'
        ? (object(message.payload)!.sessionId as string)
        : parsedEvent === undefined || parsedEvent === null
          ? undefined
          : backendEventSessionId(parsedEvent)
    let deferredToOpen = false
    if (messageSessionId !== undefined) {
      const pending = pendingOpenBuffer.capture(messageSessionId, message)
      if (pending !== undefined) {
        deferredToOpen = true
        // The Host window is the opening barrier. Keep only bounded windows
        // and idempotent control facts while advisory list reads settle.
        if (
          pending.ready &&
          pending.version === lifecycle.getOpenVersion() &&
          getState().activeSessionId === pending.sessionId
        )
          applyHostMessage(message, getState(), setState, parsedEvent, projectionSequences, reopenActiveView)
      }
    }
    // Buffer session-scoped view/control updates during the opening barrier.
    // Global shell facts and pending interactions remain immediately available.
    if (!deferredToOpen)
      applyHostMessage(message, getState(), setState, parsedEvent, projectionSequences, reopenActiveView)
    const currentState = getState()
    // The switcher only caches its rows, so a session whose title changed
    // while the drawer was closed (a missed live frame, a reconnect gap, or a
    // title generated before this client attached) would keep showing the
    // stale value. Re-fetch the authoritative list whenever the drawer opens,
    // mirroring the subagent drawer's open-reads-fresh behavior.
    if (
      !deferredToOpen &&
      message.type === 'event' &&
      message.name === 'ui.sessions.toggle' &&
      currentState.drawer === 'sessions'
    )
      void refreshSessionDirectory()
    if (
      message.type === 'event' &&
      message.name === 'connection.snapshot' &&
      object(message.payload)?.kind === 'connected'
    ) {
      // An app.ready snapshot of the same connection must not retire the
      // startup catalog without replacing it. A new identity always refreshes.
      // applyHostMessage already reopens/refreshes a changed connection epoch.
      // Legacy snapshots without an identity still need the fallback refresh.
      if (!sameConnection && currentState.connectionEpoch === previousConnectionEpoch)
        void refresh().catch(() => undefined)
      setState((current) => ({
        ...current,
        pluginInventoryRevision: current.pluginInventoryRevision + 1,
        pluginInstallProgress: undefined,
      }))
    }
    if (
      message.type === 'event' &&
      message.name === 'remote.event' &&
      object(message.payload)?.name === 'goal/activation-changed'
    )
      lifecycle.setGoalActivationAvailable(true)
    if (
      message.type === 'event' &&
      (message.name === 'connection.lost' ||
        (message.name === 'connection.snapshot' && object(message.payload)?.kind !== 'connected'))
    ) {
      lifecycle.setGoalActivationAvailable(false)
      lifecycle.incrementGoalReadGeneration()
      setState((current) => ({ ...current, pluginInstallProgress: undefined }))
    }
    if (
      message.type === 'event' &&
      ((message.name === 'remote.event' && object(message.payload)?.name === 'goal/activation-changed') ||
        message.name === 'session.status' ||
        message.name === 'session.subscribed' ||
        (message.name === 'connection.snapshot' && object(message.payload)?.kind === 'connected'))
    )
      void refreshLiveGoals()
    if (
      message.type === 'event' &&
      message.name === 'remote.event' &&
      object(message.payload)?.name === 'permission-presets/catalog-changed'
    ) {
      const sessionId = currentState.activeSessionId
      const version = lifecycle.getOpenVersion()
      const generation = ++permissionCatalogGeneration
      // Clear the stale allowlist immediately; a failed read must not keep Auto
      // selectable after its live integration has been removed.
      setState((current) => ({
        ...current,
        permissionPresets: [],
        newSessionPermissionPresets: [],
        newSessionPermissionDefault: undefined,
      }))
      void client
        .request<unknown>({
          type: 'permissions.presets.list',
          requestId: requestId(),
        })
        .then((value) => {
          if (lifecycle.isDisposed() || generation !== permissionCatalogGeneration) return
          const catalog = parsePermissionCatalog(value)
          if (catalog !== undefined)
            setState((current) => ({
              ...current,
              newSessionPermissionPresets: catalog.items,
              newSessionPermissionDefault: catalog.defaultPreset,
              ...(version === lifecycle.getOpenVersion() && current.activeSessionId === sessionId
                ? { permissionPresets: catalog.items }
                : {}),
            }))
        })
        .catch(() => {
          /* Preserve the fail-closed roster; reopening retries the read. */
        })
    }
    if (
      message.type === 'event' &&
      message.name === 'remote.event' &&
      isCommandDirectoryRefresh(message.payload)
    )
      void refreshCommands(undefined, true)
    if (
      message.type === 'event' &&
      message.name === 'remote.event' &&
      isModelCatalogRefresh(message.payload)
    ) {
      void deps.refreshModelCatalog()
      // The same host events invalidate the session-scoped directory. Without
      // this re-read a failure row the picker is showing would outlive its
      // cause, for example after the user repairs the credential it names.
      const refreshSessionId = getState().activeSessionId
      if (refreshSessionId !== undefined) void refreshSessionModelDirectoryForSession(refreshSessionId)
    }
    if (
      message.type === 'event' &&
      message.name === 'connection.snapshot' &&
      object(message.payload)?.kind === 'connected'
    ) {
      commandDirectory.invalidate()
      void refreshCommands(undefined, true)
    }
    if (message.type === 'event' && message.name === 'connection.lost') {
      commandDirectory.invalidate()
      invalidateFeedback()
    }
    if (
      message.type === 'event' &&
      (message.name === 'workspace.changed' || message.name === 'workspace.removed')
    )
      void featureActions.discardEditorContextForWorkspaceChange()
    if (
      message.type === 'event' &&
      (message.name === 'workspace.changed' ||
        message.name === 'workspace.removed' ||
        message.name === 'workspace.order.changed' ||
        message.name === 'archived.sessions.changed' ||
        message.name === 'session.added' ||
        message.name === 'session.removed')
    )
      // Workspace/session membership does not change the global model,
      // credential or preset catalogs. Their own events refresh those owners.
      void refreshSessionDirectory()
    if (message.type === 'event' && message.name === 'session.created') {
      const created = object(message.payload)
      const createdId = typeof created?.id === 'string' ? created.id : undefined
      if (createdId !== undefined) {
        // This is an explicit creation path. It owns the startup choice and
        // must not race the fallback selected from a concurrent refresh.
        lifecycle.clearStartupRestorePending()
        void refreshSessionDirectory()
          .then(() => callbacks.openCreatedSession?.(createdId))
          .catch(() => undefined)
      }
    }
    if (message.type === 'event' && message.name === 'session.added') {
      const added = object(message.payload)
      const parentSessionId =
        added?.origin === 'subagent' && typeof added.parentSessionId === 'string'
          ? added.parentSessionId
          : undefined
      const activeSessionId = getState().activeSessionId
      if (
        activeSessionId !== undefined &&
        parentSessionId !== undefined &&
        (parentSessionId === activeSessionId ||
          getState().subagents.entries.some((entry) => entry.id === parentSessionId))
      )
        void loadSubagentCatalog(activeSessionId).then((catalog) => {
          if (catalog !== undefined)
            setState((current) =>
              current.activeSessionId === activeSessionId ? { ...current, subagents: catalog } : current,
            )
        })
    }
    if (
      message.type === 'event' &&
      (message.name === 'session.subscribed' || message.name === 'subagent.catalog.updated')
    ) {
      const subscribed = object(message.payload)
      const sessionId = typeof subscribed?.sessionId === 'string' ? subscribed.sessionId : undefined
      const activeSessionId = getState().activeSessionId
      if (
        activeSessionId !== undefined &&
        sessionId !== undefined &&
        (sessionId === activeSessionId ||
          getState().subagents.entries.some((entry) => entry.id === sessionId))
      )
        void loadSubagentCatalog(activeSessionId).then((catalog) => {
          if (catalog !== undefined)
            setState((current) =>
              current.activeSessionId === activeSessionId ? { ...current, subagents: catalog } : current,
            )
        })
    }
  })
  const unsubscribeFeature =
    typeof client.subscribeFeature === 'function'
      ? client.subscribeFeature((message) => {
          if (lifecycle.isDisposed()) return
          if (accountActions.applyFeatureEvent(message)) return
          if (message.name === 'plugin.manager.changed')
            setState((current) => ({
              ...current,
              pluginInventoryRevision: current.pluginInventoryRevision + 1,
              pluginInstallProgress: undefined,
            }))
          if (message.name === 'plugin.install.progress') {
            const progress: PluginInstallProgressView = {
              requestId: message.requestId,
              phase: message.phase,
              ...(message.attemptIndex === undefined ? {} : { attemptIndex: message.attemptIndex }),
              ...(message.attemptTotal === undefined ? {} : { attemptTotal: message.attemptTotal }),
            }
            pluginInstallRecovery.progress(progress)
            setState((current) => ({ ...current, pluginInstallProgress: progress }))
          }
          if (featureActions.applyFeatureEvent(message)) return
        })
      : () => undefined
  return () => {
    unsubscribe()
    unsubscribeFeature()
  }
}
