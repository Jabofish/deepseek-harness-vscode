// Preset ids are supplied by the connected DSH deployment. The shipped ids
// remain common values, while user presets must not be rejected by a static
// Webview enum.
export type AgentPreset = string
/**
 * Process-level tool presentation. `code` is retained as a legacy alias for
 * published rc runtimes; the 0.1.2 alpha names that mode `ptc`.
 */
export type ToolMode = 'native' | 'ptc' | 'code' | 'both'
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
  /** Values advertised by the provider schema for enum-like fields. */
  readonly enumValues?: readonly string[]
  /** Credential-reference fields carry the host's write capability. */
  readonly writable?: boolean
  readonly value?: string
}

/** Non-secret draft sent to the Host for a new provider route. */
export interface CustomProviderDraft {
  readonly settingsNamespace: string
  readonly collectionPath: readonly string[]
  readonly providerId: string
  readonly displayName?: string
  readonly api: string
  readonly baseUrl: string
  readonly models: readonly Readonly<Record<string, unknown>>[]
  readonly expectedRevision: number
}

/** Result of the Host-owned two-stage provider create flow. */
export interface CustomProviderCreateResult {
  readonly profileCommitted: boolean
  readonly credentialConfigured: boolean
  /** Present only when the profile landed but credential storage failed. */
  readonly credentialError?: string
}

/** DSH route grammar shared by the Webview gate and Host-side validation. */
export function isValidCustomProviderId(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value)
}

/** Conventional credential reference used when a custom route supplies a key. */
export function deriveProviderCredentialReference(providerId: string): string {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}_API_KEY`
}

/**
 * One reasoning effort the model's adapter advertises. `label` is the
 * host-supplied display name; the id is the value that travels back in a
 * selection, so the two are never interchangeable.
 */
export interface ModelReasoningLevel {
  readonly id: string
  readonly label: string
}

export interface ModelDescriptor {
  readonly id: string
  readonly providerId: string
  readonly label: string
  readonly contextWindow?: number
  readonly supportsReasoning: boolean
  readonly reasoningLevels?: readonly ModelReasoningLevel[]
  /**
   * The effort the adapter applies when a selection names none. Absent means
   * the adapter states no default, which is not the same as the first
   * advertised level.
   */
  readonly defaultReasoningLevel?: string
}

/**
 * One provider whose catalog enumeration failed while the rest of the
 * directory loaded. It explains why a provider contributes no models; the
 * message is host-stated and carries no client-side length budget.
 */
export interface ModelCatalogFailure {
  readonly providerId: string
  readonly providerName: string
  readonly message: string
}

export interface SessionModelCatalog {
  readonly current: ModelSelection
  readonly routable: boolean
  readonly models: readonly ModelDescriptor[]
  readonly failures: readonly ModelCatalogFailure[]
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
export interface ContextBreakdown {
  readonly systemTokens: number
  readonly toolsTokens: number
  readonly messageTokens: number
}

export interface ContextPressure {
  readonly pressureTokens?: number
  readonly projectedTokens?: number
  readonly contextWindow?: number
  /** rc.8 token-meter categories used by the context details view. */
  readonly breakdown?: ContextBreakdown
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
