import type { AgentConfiguration } from './models.js'
import type { BackendEvent } from './events.js'
import type { MessageImageReference } from './events.js'

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

/**
 * True for any `image/*` token, including image types this client cannot
 * encode. An unknown type narrows what may be sent; it does not invalidate the
 * byte and count limits advertised next to it.
 */
export function isImageMediaType(value: string): boolean {
  return /^image\/[a-z0-9][a-z0-9.+-]*$/.test(value)
}

export interface SessionSummary {
  readonly id: string
  /** DSH workspace registry identity; it is not a VS Code folder id. */
  readonly workspaceId: string
  /**
   * VS Code workspace folder that guards this session's paths. Only the Host
   * can resolve it, so it is projected from cwd rather than read from DSH. An
   * absent value means no folder is open: path-scoped surfaces are unavailable
   * instead of failing.
   */
  readonly workspaceFolderId?: string
  /** Host-only DSH working directory; the public Webview projection removes it. */
  readonly cwd?: string
  readonly title: string
  /** True until the first model turn starts; command-only sessions stay blank. */
  readonly blank: boolean
  /** Fork/spawn lineage; present when the session is a child. */
  readonly parentSessionId?: string
  /** Durable origin; 'subagent' marks a child managed via the subagent surface. */
  readonly origin?: 'subagent'
  /** Whether the runtime currently has an Agent attached to this Session. */
  readonly agentAvailable?: boolean
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
  /** Raw DSH sequence positions represented by one compacted presentation row. */
  readonly coveredSequences?: readonly number[]
}

export interface SessionSequenceRange {
  readonly from: number
  readonly to: number
}

/** One bounded DSH history window, ordered oldest-to-newest by durable sequence. */
export interface SessionHistoryPage {
  readonly events: readonly SessionHistoryEvent[]
  readonly hasMore: boolean
  /** Raw oldest sequence in the page; needed because delta compaction changes display rows. */
  readonly beforeSequence?: number
  /** Exact raw sequence runs represented before presentation filtering/compaction. */
  readonly coveredSequenceRanges?: readonly SessionSequenceRange[]
  readonly projection?: SessionProjectionSnapshot
}

/** Host-selected behavior for a session history page read. */
export interface SessionHistoryQueryOptions {
  /** Minimum transcript messages desired in a page when the runtime supports it. */
  readonly pageSize?: number
  /** Conversation pages can align to turns; gap recovery needs exact cursor coverage. */
  readonly pagePurpose?: 'transcript' | 'gap-recovery'
}

export interface SubagentHistoryPage {
  readonly events: readonly SessionHistoryEvent[]
  readonly hasMore: boolean
  /** Raw oldest sequence in the page; the cursor for loading older records. */
  readonly beforeSequence?: number
  /** Host-computed projection baseline aligned with this history tail. */
  readonly projection?: SessionProjectionSnapshot
}

/** Cursor for loading an older page from a subagent transcript. */
export interface SubagentHistoryQuery {
  readonly beforeSequence?: number
  /** Minimum transcript messages desired in a page when the runtime supports it. */
  readonly pageSize?: number
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
  /** Durable image references in the pending upstream message. */
  readonly images?: readonly MessageImageReference[]
  /**
   * Sanitized display names of the durable files attached to the pending
   * message, in block order.
   *
   * A prompt part may be a file rather than text or an image. The client can
   * neither render nor read those bytes back, so the name is the whole
   * projection; the file itself stays behind the host boundary.
   */
  readonly files?: readonly string[]
  /**
   * Whether the pending message content is exactly text.
   *
   * The only queue edit the wire accepts is a text-only replacement, and the
   * host swaps the whole content for it, so a row carrying an image or a file
   * would silently lose that content. No surface may offer the edit unless
   * this is true.
   */
  readonly textOnly: boolean
  readonly mode: RunningInputMode
  readonly createdAt: string
  /** Opaque host request correlation used to reconcile an accepted prompt. */
  readonly rpcId?: string
}
