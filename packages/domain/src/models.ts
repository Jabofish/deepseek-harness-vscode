export type AgentPreset = 'standard' | 'code' | 'minimal' | 'cordis'
export type ToolMode = 'native' | 'code' | 'both'
export type PermissionPreset = 'read-only' | 'workspace-write' | 'full-access'

export interface ModelProvider {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly configurable: boolean
  readonly fields: readonly ProviderField[]
}

export interface ProviderField {
  readonly key: string
  readonly label: string
  readonly secret: boolean
  readonly required: boolean
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

export interface ModelSelection {
  readonly providerId: string
  readonly modelId: string
  readonly reasoningLevel?: string
}

export interface AgentConfiguration {
  readonly preset: AgentPreset
  readonly toolMode: ToolMode
  readonly permissionPreset: PermissionPreset
  readonly planMode: boolean
  readonly model: ModelSelection
}
