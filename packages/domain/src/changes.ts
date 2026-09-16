import type { FeatureEventIdentity } from './feature-contracts.js'
import type { ToolCallView, ToolPresentationDiff, ToolLocationView } from './tools.js'

export type ChangeFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown'

export type ChangeEvidence =
  | 'structuredProposal'
  | 'structuredToolSuccess'
  | 'filesystemObserved'
  | 'structuredLocationOnly'
  | 'failed'
  | 'incomplete'

export type ChangeApplicationState = 'proposed' | 'appliedObserved' | 'failed' | 'unknown'

export type ChangeReviewState = 'unreviewed' | 'viewed' | 'accepted' | 'rejected' | 'needs-attention'

export interface ChangeListQuery {
  readonly workspaceFolderId?: string
  readonly sessionId?: string
  readonly status?: ChangeFileStatus
  readonly cursor?: string
  readonly limit?: number
}

export interface ChangeDiff {
  readonly oldText: string | null
  readonly newText: string
}

export interface ChangeSetFile {
  readonly changeId: string
  readonly sessionId: string
  readonly workspaceFolderId: string
  readonly relativePath: string
  readonly previousRelativePath?: string
  readonly status: ChangeFileStatus
  readonly additions?: number
  readonly deletions?: number
  readonly proposalOldHash?: string
  readonly proposalNewHash?: string
  readonly observedHash?: string
  /**
   * One entry per applied hunk, in file order. The host computes one diff per
   * hunk with three context lines on each side, so a single `edit` touches
   * several entries and a scattered `replace_all` dozens; a pure insertion hunk
   * states `oldText: null` (which, on a `write` call phase, also stands for an
   * overwrite the presenter could not see). Keeping the whole list is what lets
   * the review show the change instead of one hunk of it.
   */
  readonly diffs?: readonly ChangeDiff[]
  readonly locations: readonly ToolLocationView[]
  readonly evidence: ChangeEvidence
  readonly applicationState: ChangeApplicationState
  readonly reviewState: ChangeReviewState
  readonly sourceIds: readonly string[]
  readonly sourceInteractionIds: readonly string[]
  readonly sourceToolCallIds: readonly string[]
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  readonly identity: FeatureEventIdentity
  readonly diffAvailable: boolean
}

export interface ChangeDetail extends ChangeSetFile {
  readonly redactedDiff?: string
  readonly diffTruncated: boolean
}

export interface ChangeObservation {
  readonly sessionId: string
  readonly workspaceFolderId: string
  readonly identity: FeatureEventIdentity
  readonly tool: ToolCallView
  readonly observedAt: number
}

export interface ChangeRepository {
  list(query?: ChangeListQuery, signal?: AbortSignal): Promise<readonly ChangeSetFile[]>
  get(changeId: string, signal?: AbortSignal): Promise<ChangeDetail>
  markReviewed(changeId: string, reviewState: ChangeReviewState, signal?: AbortSignal): Promise<ChangeSetFile>
}

export interface ChangeObserver {
  observe(observation: ChangeObservation): void
  detach(): void
  dispose(): void
}

export const CHANGE_LIMITS = {
  maxFiles: 200,
  maxDiffBytes: 256 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
} as const

export function changeDiffsBytes(diffs: readonly ChangeDiff[]): number {
  let total = 0
  for (const diff of diffs) total += byteLength(diff.oldText ?? '') + byteLength(diff.newText)
  return total
}

/**
 * The content lines of one side of a hunk. The reference diff card (and the TUI
 * footer it mirrors) treats a single trailing newline as a line terminator
 * rather than an extra empty line, and an empty side as no lines at all, so a
 * full deletion's `newText` and a create's absent `oldText` contribute nothing.
 */
export function changeLineCount(text: string | null): number {
  if (text === null || text.length === 0) return 0
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n').length
}

/**
 * Line totals over every hunk of one file, counted the way the reference diff
 * card counts the rows it draws: each hunk's old side toward `deletions` and
 * its new side toward `additions`. Context lines sit on both sides, so the
 * totals describe the rendered block rather than a net line delta.
 */
export function changeDiffsDelta(diffs: readonly ChangeDiff[]): {
  readonly additions: number
  readonly deletions: number
} {
  let additions = 0
  let deletions = 0
  for (const diff of diffs) {
    additions += changeLineCount(diff.newText)
    deletions += changeLineCount(diff.oldText)
  }
  return { additions, deletions }
}

/** The status a file's whole hunk list states, not the status of its last hunk. */
export function changeDiffsStatus(diffs: readonly ChangeDiff[]): ChangeFileStatus {
  if (diffs.length === 0) return 'unknown'
  if (diffs.every((diff) => diff.oldText === null)) return 'added'
  if (diffs.every((diff) => diff.newText.length === 0)) return 'deleted'
  return 'modified'
}

export function changeEvidenceRank(evidence: ChangeEvidence): number {
  switch (evidence) {
    case 'incomplete':
      return 0
    case 'structuredLocationOnly':
      return 1
    case 'structuredProposal':
      return 2
    case 'structuredToolSuccess':
      return 3
    case 'filesystemObserved':
      return 4
    case 'failed':
      return 5
  }
}

export function isChangeDiff(value: unknown): value is ToolPresentationDiff {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.path === 'string' &&
    (candidate.oldText === null || typeof candidate.oldText === 'string') &&
    typeof candidate.newText === 'string'
  )
}

function byteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index)
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00)
        index += 1
      }
    }
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return bytes
}
