import type { BackendState } from '@dsh-vscode/domain'

const TRANSPORT_CONFIGURATION_KEYS = [
  'dsh.connection.mode',
  'dsh.connection.serverUrl',
  'dsh.connection.runtimeVersion',
  'dsh.connection.managedPort',
  'dsh.connection.attachPorts',
  'dsh.connection.requestTimeoutMs',
] as const

/** Runtime choices only a waiting connection retries with; a live one keeps its process. */
const RUNTIME_CONFIGURATION_KEYS = ['dsh.runtime.executablePath', 'dsh.runtime.autoStart'] as const

/** States that are still looking for, or gave up looking for, a runtime. */
const RUNTIME_RETRY_STATES: ReadonlySet<BackendState['kind']> = new Set([
  'runtime-missing',
  'failed',
  'port-conflict',
])

/** States a transport change reconnects; idle and disconnected wait for the user. */
const TRANSPORT_RECONNECT_STATES: ReadonlySet<BackendState['kind']> = new Set([
  'connected',
  'connecting',
  'discovering',
  'locating-runtime',
  'starting',
  ...RUNTIME_RETRY_STATES,
])

/** Whether a newly installed or selected runtime should be tried right away. */
export function retriesWithNewRuntime(state: BackendState['kind']): boolean {
  return RUNTIME_RETRY_STATES.has(state)
}

/**
 * Transport settings reconnect any active connection. A new executable or
 * auto-start choice retries a connection that could not find or start DSH,
 * so picking the executable in Settings or the command palette recovers
 * without a separate Connect.
 */
export function reconnectsAfterConfigurationChange(
  affectsConfiguration: (section: string) => boolean,
  state: BackendState['kind'],
): boolean {
  if (TRANSPORT_CONFIGURATION_KEYS.some((key) => affectsConfiguration(key)))
    return TRANSPORT_RECONNECT_STATES.has(state)
  return retriesWithNewRuntime(state) && RUNTIME_CONFIGURATION_KEYS.some((key) => affectsConfiguration(key))
}
