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
  readonly input?: { readonly hint: string }
  /** Optional client-side origin; the official command directory does not require it. */
  readonly source?: 'builtin' | 'skill' | 'plugin'
}

export interface ParsedSlashCommand {
  readonly name: string
  readonly rawInput: string
}

/**
 * Parse the exact command grammar used by @deepseek-ai/dsh-commands.
 * The command name is lowercase, starts with a letter, and preserves every
 * byte after the name as rawInput so the host-owned command parser remains
 * authoritative for arguments.
 */
export function parseSlashCommand(line: string): ParsedSlashCommand | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
  if (match === null || match[1] === undefined) return undefined
  return { name: match[1], rawInput: line.slice(match[0].length) }
}

export interface PluginDescriptor {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly installed: boolean
  readonly capabilities: readonly string[]
  readonly requiresRestart: boolean
}

export interface AgentPresetDescriptor {
  readonly id: string
  readonly trust: 'system' | 'user'
  readonly isDefault: boolean
  readonly name?: string
  readonly description?: string
  readonly broken?: string
}

export interface AgentPresetDocument {
  readonly id: string
  readonly trust: 'system' | 'user'
  readonly content: string
  readonly name?: string
  readonly description?: string
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
