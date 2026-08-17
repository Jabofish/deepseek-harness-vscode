// Preset ids are supplied by the connected DSH deployment. The shipped ids
// remain common values, while user presets must not be rejected by a static
// Webview enum.
export type AgentPreset = string
export type ToolMode = 'native' | 'code' | 'both'
// Permission presets are supplied by the connected permission plugin. Keep
// this open so deployments can add ids such as danger-full-access without
// making the Webview or extension reject a valid host value.
export type PermissionPreset = string

export interface ModelProvider {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly configurable: boolean
  readonly active?: boolean
  readonly declared?: boolean
  readonly settingsNs?: string
  readonly settingsPath?: readonly string[]
  readonly fields: readonly ProviderField[]
}

export interface ProviderField {
  readonly key: string
  readonly label: string
  readonly secret: boolean
  readonly required: boolean
  /** Credential-reference fields carry the host's write capability. */
  readonly writable?: boolean
  readonly value?: string
}

export interface ModelDescriptor {
  readonly id: string
  readonly providerId: string
  readonly label: string
  readonly contextWindow?: number
  readonly supportsReasoning: boolean
  readonly reasoningLevels?: readonly string[]
}

export interface SessionModelCatalog {
  readonly current: ModelSelection
  readonly routable: boolean
  readonly models: readonly ModelDescriptor[]
  readonly failures: readonly { readonly providerId: string; readonly message: string }[]
}

export interface ModelDiscoveryInput {
  readonly settingsNamespace: string
  readonly providerId?: string
  readonly baseUrl?: string
  readonly api?: string
  readonly apiKey?: string
}

export interface DiscoveredModel {
  readonly id: string
  readonly label: string
  readonly contextWindow?: number
  readonly maxTokens?: number
}

export interface ModelSelection {
  readonly providerId: string
  readonly modelId: string
  readonly reasoningLevel?: string
}

/** Token accounting reported by DSH for one completed model step. */
export interface TokenUsage {
  /** Input tokens not served from the provider cache. */
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/** DSH token-meter projection for the next request's context occupancy. */
export interface ContextPressure {
  readonly pressureTokens?: number
  readonly projectedTokens?: number
  readonly contextWindow?: number
}

export interface AgentConfiguration {
  readonly preset: AgentPreset
  readonly toolMode: ToolMode
  readonly permissionPreset: PermissionPreset
  readonly planMode: boolean
  /** The host's sandbox policy, when the composed DSH exposes it separately. */
  readonly sandboxMode?: string
  /** The host's approval policy, when the composed DSH exposes it separately. */
  readonly approvalPolicy?: string
  readonly model: ModelSelection
}
