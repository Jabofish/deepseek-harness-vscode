import type { AgentConfiguration, PermissionPreset } from './models.js'
import type { ConnectionMode } from './runtime.js'

export interface ConnectionSettings {
  readonly mode: ConnectionMode
  readonly host: '127.0.0.1' | 'localhost'
  readonly serverUrl?: string
  /** Zero means ask DSH to allocate an isolated free port. */
  readonly managedPort: number
  readonly attachPorts: readonly number[]
  readonly discoveryTimeoutMs: number
  readonly requestTimeoutMs: number
}

export interface RuntimeSettings {
  readonly executablePath: string | undefined
  readonly autoStart: boolean
  readonly installPackage: '@deepseek-ai/dsh'
}

export interface SecuritySettings {
  readonly defaultPermissionPreset: PermissionPreset
  readonly allowRemoteHost: false
  readonly redactDiagnostics: true
}

export interface ExtensionSettings {
  readonly connection: ConnectionSettings
  readonly runtime: RuntimeSettings
  readonly security: SecuritySettings
  readonly defaultAgent: AgentConfiguration
}

/** Browser-safe allowlist of extension configuration facts. Host addresses,
 * ports, executable paths, and every credential stay in the Extension Host. */
export interface ExtensionSettingsSummary {
  readonly connection: Pick<ConnectionSettings, 'mode'>
  readonly runtime: {
    readonly customExecutableConfigured: boolean
    readonly autoStart: boolean
  }
  readonly security: Pick<SecuritySettings, 'defaultPermissionPreset'>
  readonly defaultAgent: AgentConfiguration
}
