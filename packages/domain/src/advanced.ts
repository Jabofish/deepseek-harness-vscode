import type { PluginMetadata } from './plugin-metadata.js'
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
  /** Host-only filesystem location supplied by the skill provider; never sent to the Webview. */
  readonly documentPath?: string
  /** Public capability hint after the Host removes documentPath. */
  readonly hasDocument?: boolean
  readonly id: string
  readonly name: string
  readonly description: string
  /** Optional host-provided routing guidance for when the skill applies. */
  readonly whenToUse?: string
  /**
   * Where the skill came from, when the host reports it.
   *
   * The DSH catalog carries no origin: `skill.list` answers name, description,
   * optional routing guidance/document path and `modelInvocable`. A client-side origin
   * would be a guess about the host's own directories, so an absent value means
   * exactly that the host did not say.
   */
  readonly source?: 'project' | 'user' | 'plugin'
  /**
   * Whether the model may also invoke the skill, not whether it is usable.
   *
   * Every catalog row is already user-invocable — the host filters user-only
   * skills in and only marks `modelInvocable: false` on the ones the model must
   * not pick itself. A user-only skill is the one only a human can run, so no
   * surface may disable it.
   */
  readonly enabled: boolean
}

export interface DynamicCommand {
  /** A skill-backed row whose documentation can be opened by the Host. */
  readonly hasDocument?: boolean
  readonly name: string
  readonly description: string
  /** Optional routing guidance preserved when a skill becomes a command. */
  readonly whenToUse?: string
  readonly input?: { readonly hint: string; readonly images?: boolean }
  /** Optional client-side origin; the official command directory does not require it. */
  readonly source?: 'builtin' | 'skill' | 'plugin'
}

/**
 * Outcome of one slash line handed to the command surface.
 *
 * `unknown` is what a DSH host answers for a line outside its command
 * directory. Such a line is not a command failure: a user-invocable skill is
 * addressed exactly like that (`/<skill> [args]`), and the host injects it when
 * the same text arrives as an ordinary turn. The caller decides between that
 * prompt gesture and plain text — the adapter never sends one itself.
 */
export type CommandExecutionResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }
  | { readonly kind: 'unknown' }

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
  readonly meta?: PluginMetadata
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
}

/** Effective enablement of one agent-preset composition row. */
export type PresetPluginEnablement = boolean | 'conditional'

/** One plugin row named by an agent-preset composition. */
export interface AgentPresetPluginRow {
  readonly entryId: string | null
  readonly moduleName: string
  readonly meta?: PluginMetadata
  readonly enabled: PresetPluginEnablement
  readonly condition?: string
  readonly fiberPhase: PluginFiberPhase
}

/** One agent-preset identity and its flattened plugin composition. */
export interface AgentPresetPluginGroup {
  readonly id: string
  readonly trust: 'system' | 'user'
  readonly name?: string
  readonly isDefault: boolean
  readonly broken?: string
  readonly rows: readonly AgentPresetPluginRow[]
}

export interface PluginInventorySnapshot {
  readonly managementAvailable?: boolean
  readonly entries: readonly PluginInventoryEntry[]
  readonly agentPresets?: readonly AgentPresetPluginGroup[]
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
 * Newer registry-only hosts may also state whether the mode chooser is
 * enabled; older hosts omit this optional fact.
 *
 * `hasDocument` stays absent when the host did not state the capability: a
 * probe that never answered is not a `false` answer, so the surface must keep
 * the location action and word it without claiming either behavior.
 */
export interface AgentPresetRoster {
  readonly presets: readonly AgentPresetDescriptor[]
  readonly authorable: boolean
  readonly hasDocument?: boolean
  readonly modeSelectionEnabled?: boolean
  readonly compositionReadable?: boolean
  readonly defaultSettingPath?: string
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
  /** Compare-and-swap token returned by the pinned settings descriptor. */
  readonly revision: number
  readonly userFields: readonly string[]
  readonly secrets: readonly { readonly field: string; readonly set: boolean }[]
}

export interface SessionExportOptions {
  readonly sessionId: string
  readonly format: 'markdown' | 'json' | 'zip'
  readonly includeAttachments: boolean
  readonly includeReasoning: boolean
}
