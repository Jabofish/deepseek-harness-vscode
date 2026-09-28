import type { PluginInstallProgressView, SubagentCatalog } from '@dsh-vscode/domain'
import type { ProtocolClient } from '../protocol-client.js'
import type { PluginInstallRecoveryController } from '../plugin-install-recovery.js'
import type { AppState, LiveHistoryAppender, StateSetter } from './types.js'
import { requestId } from './ids.js'
import type { PendingOpenBuffer } from './pending-open.js'
import type { ProjectionSequenceIndex } from './session-projection.js'
import { isCommandDirectoryRefresh, isModelCatalogRefresh } from './command-directory.js'
import type { createCommandDirectoryCache } from './command-directory.js'
import type { createFeatureActions } from './feature-actions.js'
import type { createAccountActions } from './account-actions.js'
import type { createGapHealing } from './gap-heal.js'
import type { createTurnWatchers } from './turn-watchers.js'
import { parseHostDomainEvent, timelineSequenceOptions } from './event-parser.js'
import { backendEventSessionId, applyHostMessage } from './host-message-reducers.js'
import { refreshProvidersAndModels } from './host-settings.js'
import { object } from './unknown-record.js'
import { stringList } from './list-equality.js'

type GapHealingOperations = ReturnType<typeof createGapHealing>
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

export interface HostEventSubscriptionLifecycle {
  readonly advanceSessionModelDirectoryGeneration: () => void
  readonly clearStartupRestorePending: () => void
  readonly getOpenVersion: () => number
  readonly incrementGoalReadGeneration: () => void
  readonly isDisposed: () => boolean
  readonly setGoalActivationAvailable: (available: boolean) => void
}

export interface HostEventSubscriptionDependencies {
  readonly accountActions: AccountEventActions
  readonly appendLiveHistory: LiveHistoryAppender
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
  readonly refreshCommands: (sessionId?: string, force?: boolean) => Promise<void>
  readonly refreshLiveGoals: () => Promise<void>
  readonly refreshSessionModelDirectoryForSession: (sessionId: string) => Promise<void>
  readonly reopenActiveView: () => void
  readonly scheduleGapBackfill: GapHealingOperations['scheduleGapBackfill']
  readonly scheduleLedgerRebuild: GapHealingOperations['scheduleLedgerRebuild']
  readonly rememberHostOnlyNodes: GapHealingOperations['rememberHostOnlyNodes']
  readonly setState: StateSetter
  readonly turnWatchers: TurnWatchers
}

/** Owns both protocol subscriptions and translates events into store actions. */
export function subscribeHostEvents(deps: HostEventSubscriptionDependencies): () => void {
  const {
    accountActions,
    appendLiveHistory,
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
    refreshCommands,
    refreshLiveGoals,
    refreshSessionModelDirectoryForSession,
    reopenActiveView,
    scheduleGapBackfill,
    scheduleLedgerRebuild,
    rememberHostOnlyNodes,
    setState,
    turnWatchers,
  } = deps
  let permissionCatalogGeneration = 0
  const unsubscribe = client.subscribe((message) => {
    if (
      message.type === 'event' &&
      (message.name === 'connection.lost' ||
        (message.name === 'connection.snapshot' && object(message.payload)?.kind !== 'connected'))
    )
      // Retire reads from the connection that is going away. The replacement
      // session open starts a fresh generation when it can read its own catalog.
      lifecycle.advanceSessionModelDirectoryGeneration()
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
    if (parsedEvent?.type === 'turn.started' || parsedEvent?.type === 'turn.ended')
      turnWatchers.notify(parsedEvent)
    const messageSessionId =
      parsedEvent === undefined || parsedEvent === null ? undefined : backendEventSessionId(parsedEvent)
    const previousLastSequence = getState().timeline.lastSequence
    let deferredToOpen = false
    let pendingOpenReady = false
    if (messageSessionId !== undefined) {
      const pending = pendingOpenBuffer.capture(messageSessionId, message)
      if (pending !== undefined) {
        deferredToOpen = true
        pendingOpenReady = pending.ready
        // History/configuration is the open barrier; advisory reads must not
        // keep live model/tool events hidden after the first conversation
        // paint. Retain the message in the queue so the final advisory
        // snapshot can replay it after its potentially stale list response.
        if (
          pending.ready &&
          pending.version === lifecycle.getOpenVersion() &&
          getState().activeSessionId === pending.sessionId
        )
          applyHostMessage(
            message,
            getState(),
            setState,
            appendLiveHistory,
            parsedEvent,
            scheduleGapBackfill,
            projectionSequences,
            rememberHostOnlyNodes,
          )
      }
    }
    // A session can be reopened while it is still active. Applying its live
    // event immediately and replaying it over the freshly hydrated history
    // would duplicate deltas, queue rows, and interaction requests. Defer
    // only events addressed to an in-flight open; global connection/workspace
    // events continue to update the shell while the read is in progress.
    if (!deferredToOpen)
      applyHostMessage(
        message,
        getState(),
        setState,
        appendLiveHistory,
        parsedEvent,
        scheduleGapBackfill,
        projectionSequences,
        rememberHostOnlyNodes,
        reopenActiveView,
      )
    // Content frames that history recovery redelivers below the timeline
    // cursor are absorbed into the ledger but ignored by the reduce gate.
    // Republish the ledger once so the healed range becomes visible.
    const currentState = getState()
    if (
      parsedEvent !== undefined &&
      parsedEvent !== null &&
      (!deferredToOpen || pendingOpenReady) &&
      currentState.activeSessionId !== undefined &&
      messageSessionId === currentState.activeSessionId &&
      parsedEvent.sequence !== undefined &&
      timelineSequenceOptions(parsedEvent).advanceSequence !== false &&
      parsedEvent.sequence <= previousLastSequence
    )
      scheduleLedgerRebuild(currentState.activeSessionId)
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
      void refresh()
    if (
      message.type === 'event' &&
      message.name === 'connection.snapshot' &&
      object(message.payload)?.kind === 'connected'
    )
      setState((current) => ({
        ...current,
        pluginInventoryRevision: current.pluginInventoryRevision + 1,
        pluginInstallProgress: undefined,
      }))
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
        message.name === 'goal.updated' ||
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
      setState((current) => ({ ...current, permissionPresets: [] }))
      if (sessionId !== undefined)
        void client
          .request<unknown>({
            type: 'session.open',
            requestId: requestId(),
            payload: { sessionId },
          })
          .then((value) => {
            if (
              lifecycle.isDisposed() ||
              version !== lifecycle.getOpenVersion() ||
              generation !== permissionCatalogGeneration ||
              getState().activeSessionId !== sessionId
            )
              return
            const permissionPresets = stringList(object(value)?.permissionPresets)
            if (permissionPresets !== undefined) setState((current) => ({ ...current, permissionPresets }))
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
      void refreshProvidersAndModels(client, setState)
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
      void refresh()
    if (message.type === 'event' && message.name === 'session.created') {
      const created = object(message.payload)
      const createdId = typeof created?.id === 'string' ? created.id : undefined
      if (createdId !== undefined) {
        // This is an explicit creation path. It owns the startup choice and
        // must not race the fallback selected from a concurrent refresh.
        lifecycle.clearStartupRestorePending()
        void refresh()
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
      if (parentSessionId !== undefined && parentSessionId === getState().activeSessionId)
        void loadSubagentCatalog(parentSessionId).then((catalog) => {
          if (catalog !== undefined)
            setState((current) =>
              current.activeSessionId === parentSessionId ? { ...current, subagents: catalog } : current,
            )
        })
    }
    if (
      message.type === 'event' &&
      (message.name === 'session.subscribed' || message.name === 'subagent.catalog.updated')
    ) {
      const subscribed = object(message.payload)
      const sessionId = typeof subscribed?.sessionId === 'string' ? subscribed.sessionId : undefined
      if (sessionId !== undefined && sessionId === getState().activeSessionId)
        void loadSubagentCatalog(sessionId).then((catalog) => {
          if (catalog !== undefined)
            setState((current) =>
              current.activeSessionId === sessionId ? { ...current, subagents: catalog } : current,
            )
        })
    }
  })
  const unsubscribeFeature =
    typeof client.subscribeFeature === 'function'
      ? client.subscribeFeature((message) => {
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
