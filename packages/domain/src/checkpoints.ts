import { CHANGE_LIMITS, type ChangeSetFile } from './changes.js'

export type CheckpointState =
  'metadata-only' | 'content-ready' | 'stale' | 'corrupt' | 'partial-restore' | 'deleted'

export interface CheckpointFile {
  readonly relativePath: string
  /** Whether the file existed at checkpoint creation; a restore removes it otherwise. */
  readonly presentAtCheckpoint: boolean
  /** Hash of the file exactly as it was at checkpoint creation. */
  readonly expectedCurrentHash?: string
  /** Hash of the bytes stored for restore; verified on its own before any write. */
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
  /**
   * The paths to snapshot. Only the paths are read from a change row: the
   * repository reads each file itself, because the content a restore writes
   * back has to be the file as it is at creation, and no change row states
   * that text.
   */
  readonly files: readonly Pick<ChangeSetFile, 'relativePath'>[]
}

export interface CheckpointListQuery {
  readonly sessionId?: string
  readonly workspaceFolderId: string
  readonly includeDeleted?: boolean
}

/**
 * What a restore does about a listed file that no longer matches the checkpoint.
 *
 * A checkpoint is a content snapshot: the bytes the files held when it was
 * created. A file that changed since then is exactly the file a restore would
 * put back, so it cannot be skipped without making the restore a no-op.
 * `overwrite` is the caller confirming the user saw the changed files;
 * `abort` refuses instead, for a caller that has shown no preview.
 */
export type CheckpointConflictPolicy = 'abort' | 'overwrite'

export interface CheckpointRestoreOutcome {
  readonly summary: CheckpointSummary
  readonly state: 'completed' | 'partial'
  readonly restoredPaths: readonly string[]
}

export interface CheckpointRepository {
  create(input: CheckpointCreateInput, signal?: AbortSignal): Promise<CheckpointSummary>
  list(query: CheckpointListQuery, signal?: AbortSignal): Promise<readonly CheckpointSummary[]>
  get(checkpointId: string, signal?: AbortSignal): Promise<CheckpointSummary>
  preview(checkpointId: string, signal?: AbortSignal): Promise<CheckpointPreview>
  delete(checkpointId: string, signal?: AbortSignal): Promise<void>
  /** Write every listed file back to the snapshot; `abort` refuses when one changed. */
  restore(
    checkpointId: string,
    expectedRevision: number,
    conflictPolicy: CheckpointConflictPolicy,
    signal?: AbortSignal,
  ): Promise<CheckpointRestoreOutcome>
}

export const CHECKPOINT_LIMITS = {
  // `checkpoint.create` snapshots the session's whole change list, so the cap has
  // to cover every row the change tracker can still hold. A lower cap refuses the
  // snapshot — with a quota message, since there is no honest way to report a
  // truncated restore — exactly in the largest sessions.
  maxFiles: CHANGE_LIMITS.maxFiles,
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
