import type { AgentConfiguration, PermissionPreset } from './models.js'
import type { ConnectionMode } from './runtime.js'

export interface ConnectionSettings {
  readonly mode: ConnectionMode
  readonly serverUrl?: string
  /**
   * Optional explicit DSH wire version for an external instance whose runtime
   * version cannot be discovered (for example a containerized DSH). Bypasses
   * the compatibility-fallback probe and selects the exact adapter. Empty when
   * not configured.
   */
  readonly runtimeVersion?: string
  /** Zero means ask DSH to allocate an isolated free port. */
  readonly managedPort: number
  readonly attachPorts: readonly number[]
  /** Host-only precedence: default ports must not override the last successful endpoint. */
  readonly attachPortsConfigured?: boolean
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
  /** The installed VS Code extension version, sourced from its manifest. */
  readonly extensionVersion: string
  readonly connection: Pick<ConnectionSettings, 'mode'> & {
    /** The endpoint is deliberately not returned to the Webview. */
    readonly customEndpointConfigured: boolean
  }
  readonly runtime: {
    readonly customExecutableConfigured: boolean
    readonly autoStart: boolean
  }
  readonly security: Pick<SecuritySettings, 'defaultPermissionPreset'>
  readonly defaultAgent: AgentConfiguration
}
