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
    invalidateFeedback,
    markStartupRestoreArmed,
    refresh,
  } = deps

  return {
    initialize: async () => {
      // The update check is independent of DSH connectivity. Start it before
      // app.ready so a missing runtime does not suppress the startup notice;
      // the result is intentionally not on the critical connection path.
      void checkDshUpdates(false).catch(() => undefined)
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
      await attemptStartupRestore()
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
