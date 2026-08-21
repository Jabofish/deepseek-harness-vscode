import type { AgentConfiguration } from './models.js'
import type { BackendEvent } from './events.js'

export type SessionStatus = 'idle' | 'running' | 'awaiting-input' | 'failed' | 'completed'

export interface SessionProjectionSnapshot {
  readonly asOfSequence: number
  readonly values: Readonly<Record<string, unknown>>
}

/**
 * Host-advertised image admission limits carried by DSH's `imageLimits`
 * session projection. Older hosts may omit the projection or the rc.8-only
 * dimension field, so the latter stays optional at this product boundary.
 */
export interface ImageAttachmentLimits {
  readonly maxImageBytes: number
  readonly maxImagesPerMessage: number
  readonly maxMessageImageBytes: number
  readonly maxImagePixels: number
  readonly maxImageDimension?: number
  readonly mediaTypes: readonly string[]
}

export interface SessionSummary {
  readonly id: string
  readonly workspaceId: string
  /** DSH's durable session working directory; useful when workspace membership is stale. */
  readonly cwd?: string
  readonly title: string
  /** True until the first model turn starts; command-only sessions stay blank. */
  readonly blank: boolean
  /** Fork/spawn lineage; present when the session is a child. */
  readonly parentSessionId?: string
  /** Durable origin; 'subagent' marks a child managed via the subagent surface. */
  readonly origin?: 'subagent'
  readonly status: SessionStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly modelLabel?: string
  readonly agentPreset?: string
  readonly projection?: SessionProjectionSnapshot
}

export interface SessionDetail extends SessionSummary {
  readonly configuration: AgentConfiguration
  /** Permission ids exposed by the connected permission plugin, when projected. */
  readonly permissionPresets?: readonly string[]
  readonly goalIds: readonly string[]
  readonly parentSessionId?: string
  readonly history?: readonly SessionHistoryEvent[]
  readonly historyHasMore?: boolean
  /** Durable sequence immediately before the currently loaded history window. */
  readonly historyBeforeSequence?: number
  readonly projection?: SessionProjectionSnapshot
}

export interface SessionHistoryEvent {
  readonly sequence: number
  readonly time: string
  readonly event: BackendEvent
}

/** One bounded DSH history window, ordered oldest-to-newest by durable sequence. */
export interface SessionHistoryPage {
  readonly events: readonly SessionHistoryEvent[]
  readonly hasMore: boolean
  /** Raw oldest sequence in the page; needed because delta compaction changes display rows. */
  readonly beforeSequence?: number
  readonly projection?: SessionProjectionSnapshot
}

export interface SubagentHistoryPage {
  readonly events: readonly SessionHistoryEvent[]
  readonly hasMore: boolean
  /** Host-computed projection baseline aligned with this history tail. */
  readonly projection?: SessionProjectionSnapshot
}

export interface SessionCreateInput {
  readonly workspaceId: string
  /** Existing blank session selected by the official workspace runtime. */
  readonly sessionId?: string
  /** Ask a capable Host to adopt the selected blank workspace session. */
  readonly reuseWorkspaceBlank?: true
  readonly title?: string
  readonly configuration: AgentConfiguration
}

export interface SessionListQuery {
  readonly workspaceId?: string
  readonly search?: string
  readonly archived?: boolean
  readonly cursor?: string
  readonly limit?: number
}

export interface SessionPage {
  readonly items: readonly SessionSummary[]
  readonly nextCursor?: string
}

export interface PromptInput {
  readonly sessionId: string
  readonly text: string
  readonly attachments: readonly PromptAttachment[]
}

export interface PromptAttachment {
  readonly uri: string
  readonly name: string
  readonly mimeType?: string
}

export type RunningInputMode = 'queue' | 'steer'

export interface QueuedInput {
  readonly id: string
  readonly sessionId: string
  readonly text: string
  readonly attachments: readonly PromptAttachment[]
  readonly mode: RunningInputMode
  readonly createdAt: string
  /** Opaque host request correlation used to reconcile an accepted prompt. */
  readonly rpcId?: string
}
