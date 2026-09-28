import { createHash } from 'node:crypto'
import path from 'node:path'

import {
  isCanonicalWorkspaceRelativePath,
  type CheckpointFile,
  type CheckpointManifest,
} from '@dsh-vscode/domain'

export interface StoredJournalEntry {
  readonly relativePath: string
  readonly backupRef?: string
  readonly tempPath?: string
  readonly originalPresent: boolean
}

export interface StoredJournal {
  readonly operationId: string
  readonly checkpointId: string
  readonly state: 'preparing' | 'applying' | 'committed' | 'rolled-back' | 'partial-restore'
  readonly entries: readonly StoredJournalEntry[]
  readonly appliedPaths: readonly string[]
  /** The paths already drifted from the checkpoint when the restore ran. */
  readonly conflictPaths: readonly string[]
}

export interface StoredPreviewSnapshot {
  readonly checkpointId: string
  readonly workspaceFolderId: string
  readonly expectedRevision: number
  readonly fileHashes: ReadonlyMap<string, string | undefined>
  readonly expiresAt: number
}

export const MANIFEST_FILE = 'manifest.json'
export const JOURNAL_FILE = 'journal.json'
export const PREVIEW_SNAPSHOT_TTL_MS = 5 * 60_000
export const MAX_PREVIEW_SNAPSHOTS = 64
/** Persisted journal states that prove the apply finished; nothing reads them again. */
export const TERMINAL_JOURNAL_STATES: ReadonlySet<string> = new Set([
  'committed',
  'rolled-back',
  'partial-restore',
])

export function encodePersisted<T>(payload: T): Uint8Array {
  const checksum = sha256(Buffer.from(JSON.stringify(payload), 'utf8'))
  return Buffer.from(JSON.stringify({ version: 1, payload, checksum }), 'utf8')
}

export function isManifest(value: unknown): value is CheckpointManifest {
  if (!isRecord(value)) return false
  const createdAt = value.createdAt
  const files = value.files
  const totalBytes = value.totalBytes
  const contentEnabled = value.contentEnabled
  const expectedRevision = value.expectedRevision
  return (
    typeof value.checkpointId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.workspaceFolderId === 'string' &&
    typeof createdAt === 'number' &&
    Number.isSafeInteger(createdAt) &&
    Array.isArray(files) &&
    files.every(isCheckpointFile) &&
    typeof totalBytes === 'number' &&
    Number.isSafeInteger(totalBytes) &&
    totalBytes >= 0 &&
    typeof contentEnabled === 'boolean' &&
    typeof expectedRevision === 'number' &&
    Number.isSafeInteger(expectedRevision) &&
    expectedRevision >= 0 &&
    (value.state === 'metadata-only' ||
      value.state === 'content-ready' ||
      value.state === 'stale' ||
      value.state === 'corrupt' ||
      value.state === 'partial-restore' ||
      value.state === 'deleted')
  )
}

export function isStoredJournal(value: unknown): value is StoredJournal {
  if (!isRecord(value)) return false
  const entries = value.entries
  const appliedPaths = value.appliedPaths
  const conflictPaths = value.conflictPaths
  if (
    typeof value.operationId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(value.operationId) ||
    typeof value.checkpointId !== 'string' ||
    value.checkpointId.trim() === '' ||
    (value.state !== 'preparing' &&
      value.state !== 'applying' &&
      value.state !== 'committed' &&
      value.state !== 'rolled-back' &&
      value.state !== 'partial-restore') ||
    !Array.isArray(entries) ||
    !Array.isArray(appliedPaths) ||
    !Array.isArray(conflictPaths)
  )
    return false

  const relativePaths = new Set<string>()
  const orderedRelativePaths: string[] = []
  const backupRefs = new Set<string>()
  for (const entry of entries) {
    if (!isRecord(entry)) return false
    const hasBackupRef = Object.hasOwn(entry, 'backupRef')
    const hasTempPath = Object.hasOwn(entry, 'tempPath')
    if (
      typeof entry.relativePath !== 'string' ||
      !isCanonicalWorkspaceRelativePath(entry.relativePath) ||
      typeof entry.originalPresent !== 'boolean' ||
      entry.originalPresent !== hasBackupRef ||
      (hasBackupRef &&
        (typeof entry.backupRef !== 'string' ||
          !/^backup-\d+\.bin$/u.test(entry.backupRef) ||
          backupRefs.has(entry.backupRef))) ||
      (hasTempPath && typeof entry.tempPath !== 'string') ||
      relativePaths.has(entry.relativePath)
    )
      return false
    if (typeof entry.backupRef === 'string') backupRefs.add(entry.backupRef)
    relativePaths.add(entry.relativePath)
    orderedRelativePaths.push(entry.relativePath)
  }

  const validJournalPaths = (paths: unknown): paths is string[] =>
    Array.isArray(paths) &&
    paths.every(
      (relativePath) =>
        typeof relativePath === 'string' &&
        isCanonicalWorkspaceRelativePath(relativePath) &&
        relativePaths.has(relativePath),
    ) &&
    new Set(paths).size === paths.length

  const appliedPathPrefix =
    Array.isArray(appliedPaths) &&
    appliedPaths.every((relativePath, index) => orderedRelativePaths[index] === relativePath)
  const hasAppliedPaths = Array.isArray(appliedPaths) && appliedPaths.length > 0
  const appliedEveryEntry = Array.isArray(appliedPaths) && appliedPaths.length === entries.length

  return (
    validJournalPaths(appliedPaths) &&
    validJournalPaths(conflictPaths) &&
    appliedPathPrefix &&
    ((value.state === 'preparing' && appliedPaths.length === 0) ||
      (value.state === 'applying' && hasAppliedPaths) ||
      (value.state === 'committed' && appliedEveryEntry) ||
      ((value.state === 'rolled-back' || value.state === 'partial-restore') && hasAppliedPaths))
  )
}

export function isJournalForManifest(
  journal: StoredJournal,
  manifest: CheckpointManifest,
  directory: string,
  rootPath: string,
): boolean {
  if (
    journal.checkpointId !== manifest.checkpointId ||
    path.join(rootPath, `checkpoint-${sha256(Buffer.from(journal.checkpointId)).slice(0, 32)}`) !==
      directory ||
    journal.entries.length !== manifest.files.length
  )
    return false
  return manifest.files.every((file, index) => {
    const entry = journal.entries[index]
    return (
      entry !== undefined &&
      entry.relativePath === file.relativePath &&
      entry.backupRef === (entry.originalPresent ? `backup-${index}.bin` : undefined) &&
      entry.tempPath ===
        (file.presentAtCheckpoint ? `${file.relativePath}.dsh-vscode-tmp-${journal.operationId}` : undefined)
    )
  })
}

export function isPreparingJournal(value: unknown): value is StoredJournal {
  return isStoredJournal(value) && value.state === 'preparing'
}

function isCheckpointFile(value: unknown): value is CheckpointFile {
  if (!isRecord(value)) return false
  const relativePath = value.relativePath
  const presentAtCheckpoint = value.presentAtCheckpoint
  const byteSize = value.byteSize
  const hashAlgorithm = value.hashAlgorithm
  const expectedCurrentHash = value.expectedCurrentHash
  const checkpointContentHash = value.checkpointContentHash
  const contentRef = value.contentRef
  return (
    typeof relativePath === 'string' &&
    isCanonicalWorkspaceRelativePath(relativePath) &&
    typeof presentAtCheckpoint === 'boolean' &&
    typeof byteSize === 'number' &&
    Number.isSafeInteger(byteSize) &&
    byteSize >= 0 &&
    hashAlgorithm === 'sha256' &&
    (expectedCurrentHash === undefined || typeof expectedCurrentHash === 'string') &&
    (checkpointContentHash === undefined || typeof checkpointContentHash === 'string') &&
    (contentRef === undefined || (typeof contentRef === 'string' && /^content-\d+\.bin$/u.test(contentRef)))
  )
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function hashFor(value: Uint8Array | undefined): string | undefined {
  return value === undefined ? undefined : sha256(value)
}
