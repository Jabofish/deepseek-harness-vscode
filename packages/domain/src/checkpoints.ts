import type { ChangeSetFile } from './changes.js'

export type CheckpointState =
  'metadata-only' | 'content-ready' | 'stale' | 'corrupt' | 'partial-restore' | 'deleted'

export interface CheckpointFile {
  readonly relativePath: string
  readonly presentAtCheckpoint: boolean
  /** Hash of the file immediately before/at checkpoint creation. */
  readonly expectedCurrentHash?: string
  /** Hash of bytes stored for restore; deliberately separate from expectedCurrentHash. */
  readonly checkpointContentHash?: string
  readonly contentRef?: string
  readonly byteSize: number
  readonly hashAlgorithm: 'sha256'
}

export interface CheckpointManifest {
  readonly checkpointId: string
  readonly sessionId: string
  readonly workspaceFolderId: string
  readonly createdAt: number
  readonly label?: string
  readonly files: readonly CheckpointFile[]
  readonly totalBytes: number
  readonly sourceChangeSetId?: string
  readonly state: CheckpointState
  readonly contentEnabled: boolean
  readonly expectedRevision: number
}

export interface CheckpointSummary {
  readonly checkpointId: string
  readonly sessionId: string
  readonly workspaceFolderId: string
  readonly createdAt: number
  readonly label?: string
  readonly fileCount: number
  readonly totalBytes: number
  readonly state: CheckpointState
  readonly restoreAllowed: boolean
  readonly contentEnabled: boolean
  readonly expectedRevision?: number
}

export interface CheckpointFilePreview {
  readonly relativePath: string
  readonly presentAtCheckpoint: boolean
  readonly expectedCurrentHash?: string
  readonly currentHash?: string
  readonly conflict: boolean
  readonly byteSize: number
}

export interface CheckpointPreview {
  readonly summary: CheckpointSummary
  readonly files: readonly CheckpointFilePreview[]
  readonly conflictCount: number
}

export interface CheckpointCreateInput {
  readonly sessionId: string
  readonly workspaceFolderId: string
  readonly label?: string
  readonly sourceChangeSetId?: string
  readonly files: readonly Pick<ChangeSetFile, 'relativePath' | 'diff'>[]
}

export interface CheckpointListQuery {
  readonly sessionId?: string
  readonly workspaceFolderId: string
  readonly includeDeleted?: boolean
}

export type CheckpointConflictPolicy = 'abort' | 'allow-partial'

export interface CheckpointRestoreOutcome {
  readonly summary: CheckpointSummary
  readonly state: 'completed' | 'partial'
  readonly restoredPaths: readonly string[]
  readonly skippedPaths: readonly string[]
}

export interface CheckpointRepository {
  create(input: CheckpointCreateInput, signal?: AbortSignal): Promise<CheckpointSummary>
  list(query: CheckpointListQuery, signal?: AbortSignal): Promise<readonly CheckpointSummary[]>
  get(checkpointId: string, signal?: AbortSignal): Promise<CheckpointSummary>
  preview(checkpointId: string, signal?: AbortSignal): Promise<CheckpointPreview>
  delete(checkpointId: string, signal?: AbortSignal): Promise<void>
  restore(
    checkpointId: string,
    expectedRevision: number,
    conflictPolicy: CheckpointConflictPolicy,
    signal?: AbortSignal,
  ): Promise<CheckpointRestoreOutcome>
}

export const CHECKPOINT_LIMITS = {
  maxFiles: 100,
  maxCheckpointBytes: 50 * 1024 * 1024,
  maxWorkspaceBytes: 200 * 1024 * 1024,
  maxGlobalBytes: 500 * 1024 * 1024,
  maxLabelBytes: 256,
} as const

export function checkpointRestoreAllowed(
  manifest: Pick<CheckpointManifest, 'state' | 'contentEnabled'>,
): boolean {
  return manifest.state === 'content-ready' && manifest.contentEnabled
}

export function checkpointSummary(manifest: CheckpointManifest): CheckpointSummary {
  return {
    checkpointId: manifest.checkpointId,
    sessionId: manifest.sessionId,
    workspaceFolderId: manifest.workspaceFolderId,
    createdAt: manifest.createdAt,
    ...(manifest.label === undefined ? {} : { label: manifest.label }),
    fileCount: manifest.files.length,
    totalBytes: manifest.totalBytes,
    state: manifest.state,
    restoreAllowed: checkpointRestoreAllowed(manifest),
    contentEnabled: manifest.contentEnabled,
    ...(manifest.expectedRevision === undefined ? {} : { expectedRevision: manifest.expectedRevision }),
  }
}
