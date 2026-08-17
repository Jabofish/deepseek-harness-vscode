export interface WorkflowSummary {
  readonly id: string
  readonly sessionId: string
  readonly name: string
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  readonly stages: readonly WorkflowStage[]
}

export interface WorkflowStage {
  readonly id: string
  /** Exact upstream phase identity; null means the field was absent and '' is distinct. */
  readonly phase: string | null
  /** Members that actually started in this phase, in start order. */
  readonly members: readonly WorkflowMember[]
}

/** One delegation member of a workflow phase; `childId` names its session. */
export interface WorkflowMember {
  readonly seq: number
  readonly label: string
  readonly childId: string
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
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

/**
 * One loader entry of the host's `pluginInventory/list` direct Remote — a
 * read-only projection of the assembled plugin tree. The phase mirrors the
 * entry's root Cordis fiber; `null` means no live fiber is mounted.
 */
export type PluginFiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

export interface PluginInventoryEntry {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
}

export interface PluginInventorySnapshot {
  readonly entries: readonly PluginInventoryEntry[]
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

/**
 * The full `agentPreset.list` answer exactly as the host composes it: the
 * roster plus the two deployment facts that gate its management surface —
 * `authorable` (whether a writable preset root is configured at all) and
 * `hasDocument` (whether the host can open a preset directory natively).
 */
export interface AgentPresetRoster {
  readonly presets: readonly AgentPresetDescriptor[]
  readonly authorable: boolean
  readonly hasDocument: boolean
}

/** `agentPreset.openDocument` answer: opened natively, or the path revealed. */
export interface AgentPresetLocation {
  readonly opened: boolean
  readonly path?: string
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
  /** Global write capability from the pinned `settings.describe` answer. */
  readonly writable: boolean
  /** Whether the host can open its settings document without revealing a path. */
  readonly hasDocument: boolean
  readonly fields: readonly SettingsFieldSchema[]
  /** Per-namespace facts the flattened field list cannot carry. */
  readonly namespaces: readonly DshSettingsNamespaceMeta[]
}

/**
 * One described settings namespace. `userFields` lists the fields present in
 * the user layer — presence alone marks an override, exactly as upstream
 * treats `SettingsNamespaceView.user`.
 */
export interface DshSettingsNamespaceMeta {
  readonly ns: string
  readonly applies: 'live' | 'restart'
  readonly userFields: readonly string[]
  readonly secrets: readonly { readonly field: string; readonly set: boolean }[]
}

export interface SessionExportOptions {
  readonly sessionId: string
  readonly format: 'markdown' | 'json' | 'zip'
  readonly includeAttachments: boolean
  readonly includeReasoning: boolean
}
