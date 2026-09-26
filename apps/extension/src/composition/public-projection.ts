import type * as vscode from 'vscode'
import path from 'node:path'
import type {
  BackendState,
  DiagnosticsSnapshot,
  ExtensionSettings,
  ExtensionSettingsSummary,
} from '@dsh-vscode/domain'
import { redactText } from '@dsh-vscode/dsh-adapter'
import { sanitizePublicValue } from '../view/public-value.js'

export function stateSubscriptionDisposable(unsubscribe: () => void): vscode.Disposable {
  return { dispose: unsubscribe }
}

export function publicState(state: BackendState): unknown {
  return {
    kind: state.kind,
    ...(state.kind === 'connected'
      ? {
          dshVersion: state.backend.capabilities.dshVersion,
          sessionRestore: state.backend.capabilities.sessionRestore === true,
          jobController: state.backend.capabilities.jobController === true,
          accountLifecycleAvailable: state.backend.capabilities.features.has('account-lifecycle'),
          ...(state.backend.capabilities.subagentImagePrompts === true ? { subagentImagePrompts: true } : {}),
          ...(state.backend.backendInstanceId === undefined
            ? {}
            : { backendInstanceId: state.backend.backendInstanceId }),
          ...(state.backend.connectionGeneration === undefined
            ? {}
            : { connectionGeneration: state.backend.connectionGeneration }),
          ...(state.backend.capabilities.compatibilityWarning === undefined
            ? {}
            : { compatibilityWarning: state.backend.capabilities.compatibilityWarning }),
        }
      : {}),
    ...(state.kind === 'failed'
      ? { message: safeStateMessage(state.message), retryable: state.retryable }
      : {}),
    ...(state.kind === 'port-conflict'
      ? { message: 'The configured DSH port is unavailable.', retryable: state.retryable, port: state.port }
      : {}),
    ...(state.kind === 'runtime-missing'
      ? { searchedLocations: publicRuntimeLocations(state.searchedLocations) }
      : {}),
  }
}

export function publicDiagnosticsSnapshot(
  state: BackendState,
  extensionVersion: string,
  recentEvents: readonly string[],
  connectionMode: ExtensionSettings['connection']['mode'],
): DiagnosticsSnapshot {
  const dshVersion = state.kind === 'connected' ? state.backend.capabilities.dshVersion : undefined
  const endpointKind =
    state.kind === 'connected'
      ? state.backend.ownership
      : connectionMode === 'custom'
        ? 'configured'
        : undefined
  const canReconnect =
    state.kind === 'connected' ||
    state.kind === 'runtime-missing' ||
    state.kind === 'port-conflict' ||
    (state.kind === 'failed' && state.retryable)
  return {
    extensionVersion,
    ...(dshVersion === undefined ? {} : { dshVersion }),
    state: state.kind,
    ...(endpointKind === undefined ? {} : { endpointKind }),
    canReconnect,
    recentEvents: recentEvents.slice(-32),
  }
}

function publicRuntimeLocations(locations: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const location of locations) {
    const normalized = path.normalize(location)
    const name = path.basename(normalized)
    const parent = path.basename(path.dirname(normalized))
    const label = parent === '' || parent === '.' ? name : `${parent}/${name}`
    if (label === '' || seen.has(label)) continue
    seen.add(label)
    result.push(label)
  }
  return result
}
export function safeStateMessage(message: string): string {
  const redacted = redactText(message, 320)
  return redacted === '' ? 'The DSH connection operation failed.' : redacted
}

export function publicList(value: readonly unknown[]): readonly unknown[] {
  return value.map(publicValue)
}
export function publicValue(value: unknown): unknown {
  return sanitizePublicValue(value)
}

export function publicExtensionSettings(
  settings: ExtensionSettings,
  extensionVersion: string,
): ExtensionSettingsSummary {
  return {
    extensionVersion,
    connection: {
      mode: settings.connection.mode,
      customEndpointConfigured: settings.connection.serverUrl !== undefined,
    },
    runtime: {
      customExecutableConfigured: settings.runtime.executablePath !== undefined,
      autoStart: settings.runtime.autoStart,
    },
    security: { defaultPermissionPreset: settings.security.defaultPermissionPreset },
    defaultAgent: settings.defaultAgent,
  }
}
