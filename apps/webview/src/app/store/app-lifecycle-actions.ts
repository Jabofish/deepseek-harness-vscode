import { diagnosticsSnapshotSchema } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import type { createDshUpdateActions } from './dsh-update.js'
import type { AppActions } from './types.js'

type DshUpdateActions = ReturnType<typeof createDshUpdateActions>

export interface AppLifecycleActionDependencies {
  readonly applyBusyEnterPreference: () => Promise<void>
  readonly attemptStartupRestore: () => Promise<void>
  readonly checkDshUpdates: DshUpdateActions['checkDshUpdates']
  readonly client: ProtocolClient
  /** True when the Host assigned this Webview the editor surface. */
  readonly isEditorSurface: () => boolean
  readonly invalidateFeedback: () => void
  readonly markStartupRestoreArmed: () => void
  readonly refresh: () => Promise<void>
}

export function createAppLifecycleActions(
  deps: AppLifecycleActionDependencies,
): Pick<AppActions, 'initialize' | 'reconnect' | 'readDiagnostics' | 'showDiagnostics'> {
  const {
    applyBusyEnterPreference,
    attemptStartupRestore,
    checkDshUpdates,
    client,
    isEditorSurface,
    invalidateFeedback,
    markStartupRestoreArmed,
    refresh,
  } = deps

  return {
    initialize: async () => {
      try {
        await client.request<unknown>({ type: 'app.ready', requestId: requestId() })
        // Official ui-conversation row: the host-side busy-Enter preference is
        // the composer's plain-Enter policy while a turn is running. It is
        // independent of the session/catalog snapshot. Start it alongside the
        // critical refresh, but keep the official default ('queue') on the
        // first-paint path when the settings read is slow or unavailable.
        markStartupRestoreArmed()
        const refreshPromise = refresh()
        void applyBusyEnterPreference()
        await refreshPromise
        // An editor surface is bound to its own session, which the surface
        // assignment opens; the side bar's remembered/last-session restore would
        // otherwise load a different conversation into the tab. The Host posts
        // `ui.surface.assigned` before it answers `app.ready`, so the assignment
        // is already in state here; the reverse order is covered by the same
        // guard inside `attemptStartupRestore`.
        if (!isEditorSurface()) await attemptStartupRestore()
      } finally {
        // Runtime/npm inspection competes with connection and session reads.
        // Start it after startup settles, including when connection failed.
        void checkDshUpdates(false).catch(() => undefined)
      }
    },
    reconnect: async () => {
      invalidateFeedback()
      await client.request<unknown>({ type: 'connection.retry', requestId: requestId() })
      await refresh()
    },
    readDiagnostics: async () => {
      const parsed = diagnosticsSnapshotSchema.safeParse(
        await client.request<unknown>({ type: 'diagnostics.snapshot', requestId: requestId() }),
      )
      if (!parsed.success) return undefined
      return {
        extensionVersion: parsed.data.extensionVersion,
        ...(parsed.data.dshVersion === undefined ? {} : { dshVersion: parsed.data.dshVersion }),
        state: parsed.data.state,
        ...(parsed.data.endpointKind === undefined ? {} : { endpointKind: parsed.data.endpointKind }),
        canReconnect: parsed.data.canReconnect,
        recentEvents: parsed.data.recentEvents,
      }
    },
    showDiagnostics: async () => {
      await client.request<unknown>({ type: 'diagnostics.show', requestId: requestId() })
    },
  }
}
