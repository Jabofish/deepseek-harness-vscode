export interface WorkflowSummary {
  readonly id: string
  readonly sessionId: string
  readonly name: string
  readonly kind: 'workflow' | 'ralph'
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  readonly stages: readonly WorkflowStage[]
}

export interface WorkflowStage {
  readonly id: string
  readonly label: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
}

export interface SkillDescriptor {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly source: 'project' | 'user' | 'plugin'
  readonly enabled: boolean
}

export interface DynamicCommand {
  readonly name: string
  readonly description: string
  readonly argumentHint?: string
  readonly source: 'builtin' | 'skill' | 'plugin'
}

export interface PluginDescriptor {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly installed: boolean
  readonly capabilities: readonly string[]
  readonly requiresRestart: boolean
}

export interface SettingsFieldSchema {
  readonly path: string
  readonly label: string
  readonly description?: string
  readonly type: 'string' | 'number' | 'boolean' | 'enum' | 'secret' | 'object' | 'array'
  readonly required: boolean
  readonly enumValues?: readonly string[]
  readonly restartRequired: boolean
}

export interface DshSettingsSchema {
  readonly version: string
  readonly fields: readonly SettingsFieldSchema[]
}

export interface SessionExportOptions {
  readonly sessionId: string
  readonly format: 'markdown' | 'json' | 'zip'
  readonly includeAttachments: boolean
  readonly includeReasoning: boolean
}
