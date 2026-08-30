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
  readonly diff?: ChangeDiff
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
  maxSources: 16,
} as const

export function changeDiffBytes(diff: Pick<ChangeDiff, 'oldText' | 'newText'>): number {
  return byteLength(diff.oldText ?? '') + byteLength(diff.newText)
}

export function changeLineCount(text: string | null): number {
  if (text === null || text.length === 0) return 0
  return text.split(/\r?\n/u).length
}

export function changeLineDelta(diff: ChangeDiff): {
  readonly additions: number
  readonly deletions: number
} {
  return {
    additions: changeLineCount(diff.newText),
    deletions: changeLineCount(diff.oldText),
  }
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
