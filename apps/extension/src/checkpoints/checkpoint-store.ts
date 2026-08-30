import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

import {
  AppError,
  CHECKPOINT_LIMITS,
  checkpointRestoreAllowed,
  checkpointSummary,
  isCanonicalWorkspaceRelativePath,
  type CheckpointConflictPolicy,
  type CheckpointCreateInput,
  type CheckpointFilePreview,
  type CheckpointFile,
  type CheckpointManifest,
  type CheckpointListQuery,
  type CheckpointPreview,
  type CheckpointRepository,
  type CheckpointRestoreOutcome,
  type CheckpointSummary,
} from '@dsh-vscode/domain'

export interface CheckpointWorkspaceAccess {
  /** Return undefined only when the target does not exist. */
  readFile(workspaceFolderId: string, relativePath: string): Promise<Uint8Array | undefined>
  writeFile(workspaceFolderId: string, relativePath: string, data: Uint8Array): Promise<void>
  deleteFile(workspaceFolderId: string, relativePath: string): Promise<void>
  renameFile(
    workspaceFolderId: string,
    sourceRelativePath: string,
    destinationRelativePath: string,
    overwrite: boolean,
  ): Promise<void>
}

export interface CheckpointStorageEntry {
  readonly name: string
  readonly kind: 'file' | 'directory'
}

/** Small storage seam so recovery and fault injection do not need a live VS Code host. */
export interface CheckpointStorage {
  mkdir(directory: string): Promise<void>
  list(directory: string): Promise<readonly CheckpointStorageEntry[]>
  readFile(filePath: string): Promise<Uint8Array>
  writeFile(filePath: string, data: Uint8Array): Promise<void>
  rename(sourcePath: string, destinationPath: string, overwrite: boolean): Promise<void>
  delete(filePath: string, recursive: boolean): Promise<void>
}

export interface CheckpointStoreOptions {
  readonly rootPath: string
  readonly storage: CheckpointStorage
  readonly workspace: CheckpointWorkspaceAccess
  readonly enabled?: () => boolean
  readonly contentEnabled?: () => boolean
  readonly now?: () => number
  readonly makeId?: () => string
}

interface StoredJournalEntry {
  readonly relativePath: string
  readonly backupRef?: string
  readonly tempPath?: string
  readonly originalPresent: boolean
}

interface StoredJournal {
  readonly operationId: string
  readonly checkpointId: string
  readonly state: 'applying' | 'committed' | 'rolled-back' | 'partial-restore'
  readonly entries: readonly StoredJournalEntry[]
  readonly appliedPaths: readonly string[]
  readonly skippedPaths: readonly string[]
}

const MANIFEST_FILE = 'manifest.json'
const JOURNAL_FILE = 'journal.json'

/**
 * Host-only checkpoint repository. It stores opaque manifests and content
 * under ExtensionContext.globalStorageUri and delegates workspace mutation to
 * a separately guarded Host adapter.
 */
export class CheckpointStore implements CheckpointRepository {
  private readonly now: () => number
  private readonly makeId: () => string
  private readonly enabled: () => boolean
  private readonly contentEnabled: () => boolean
  private readonly manifests = new Map<string, CheckpointManifest>()
  private initialized = false
  private initializing: Promise<void> | undefined

  public constructor(private readonly options: CheckpointStoreOptions) {
    this.now = options.now ?? (() => Date.now())
    this.makeId = options.makeId ?? (() => randomUUID())
    this.enabled = options.enabled ?? (() => false)
    this.contentEnabled = options.contentEnabled ?? (() => false)
  }

  public async initialize(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return
    if (this.initializing !== undefined) return this.initializing
    this.initializing = this.loadAndRecover(signal).finally(() => {
      this.initializing = undefined
    })
    return this.initializing
  }

  public async create(input: CheckpointCreateInput, signal?: AbortSignal): Promise<CheckpointSummary> {
    await this.initialize(signal)
    this.assertEnabled()
    validateCreateInput(input)
    throwIfAborted(signal)

    const sourceByPath = new Map(input.files.map((file) => [file.relativePath, file]))
    const uniquePaths = [...sourceByPath.keys()]
    if (uniquePaths.length > CHECKPOINT_LIMITS.maxFiles)
      throw checkpointQuota('A checkpoint may contain at most 100 files.')
    const saveContent = this.contentEnabled()
    const files: Array<{ readonly manifest: CheckpointFile; readonly bytes?: Uint8Array }> = []
    let totalBytes = 0
    for (const relativePath of uniquePaths) {
      throwIfAborted(signal)
      const currentBytes = await this.options.workspace.readFile(input.workspaceFolderId, relativePath)
      const source = sourceByPath.get(relativePath)
      const snapshotBytes =
        source?.diff === undefined
          ? currentBytes
          : source.diff.oldText === null
            ? undefined
            : Buffer.from(source.diff.oldText, 'utf8')
      const expectedCurrentHash = hashFor(currentBytes)
      if (snapshotBytes === undefined) {
        files.push({
          manifest: {
            relativePath,
            presentAtCheckpoint: false,
            ...(expectedCurrentHash === undefined ? {} : { expectedCurrentHash }),
            byteSize: 0,
            hashAlgorithm: 'sha256',
          },
        })
        continue
      }
      if (snapshotBytes.byteLength > CHECKPOINT_LIMITS.maxCheckpointBytes)
        throw checkpointQuota(`The file ${relativePath} is too large for a checkpoint.`)
      totalBytes += snapshotBytes.byteLength
      if (totalBytes > CHECKPOINT_LIMITS.maxCheckpointBytes)
        throw checkpointQuota('The checkpoint content quota has been reached.')
      const contentHash = sha256(snapshotBytes)
      files.push({
        manifest: {
          relativePath,
          presentAtCheckpoint: true,
          ...(expectedCurrentHash === undefined ? {} : { expectedCurrentHash }),
          ...(saveContent
            ? { checkpointContentHash: contentHash, contentRef: `content-${files.length}.bin` }
            : {}),
          byteSize: snapshotBytes.byteLength,
          hashAlgorithm: 'sha256',
        },
        bytes: snapshotBytes,
      })
    }
    if (saveContent) this.assertContentQuota(input.workspaceFolderId, totalBytes)

    const checkpointId = `dsh-checkpoint-${this.makeId()}`
    const manifest: CheckpointManifest = {
      checkpointId,
      sessionId: input.sessionId,
      workspaceFolderId: input.workspaceFolderId,
      createdAt: this.now(),
      ...(input.label === undefined ? {} : { label: input.label }),
      files: files.map((entry) => entry.manifest),
      totalBytes,
      ...(input.sourceChangeSetId === undefined ? {} : { sourceChangeSetId: input.sourceChangeSetId }),
      state: saveContent ? 'content-ready' : 'metadata-only',
      contentEnabled: saveContent,
      expectedRevision: 1,
    }
    const directory = this.directoryFor(checkpointId)
    await this.options.storage.mkdir(directory)
    try {
      if (saveContent)
        for (const entry of files) {
          if (entry.bytes === undefined || entry.manifest.contentRef === undefined) continue
          await this.writeAtomic(path.join(directory, entry.manifest.contentRef), entry.bytes)
        }
      await this.writeAtomic(path.join(directory, MANIFEST_FILE), encodePersisted(manifest))
      this.manifests.set(checkpointId, manifest)
      return checkpointSummary(manifest)
    } catch (error) {
      await this.options.storage.delete(directory, true).catch(() => undefined)
      throw normalizeStorageError(error)
    }
  }

  public async list(query: CheckpointListQuery, signal?: AbortSignal): Promise<readonly CheckpointSummary[]> {
    await this.initialize(signal)
    throwIfAborted(signal)
    if (!this.enabled()) return []
    const values = [...this.manifests.values()]
      .filter(
        (manifest) =>
          manifest.workspaceFolderId === query.workspaceFolderId &&
          (query.sessionId === undefined || manifest.sessionId === query.sessionId) &&
          (query.includeDeleted === true || manifest.state !== 'deleted'),
      )
      .sort(
        (left, right) =>
          right.createdAt - left.createdAt || left.checkpointId.localeCompare(right.checkpointId),
      )
    return values.map(checkpointSummary)
  }

  public async get(checkpointId: string, signal?: AbortSignal): Promise<CheckpointSummary> {
    await this.initialize(signal)
    throwIfAborted(signal)
    const manifest = this.requireManifest(checkpointId)
    return checkpointSummary(manifest)
  }

  public async preview(checkpointId: string, signal?: AbortSignal): Promise<CheckpointPreview> {
    await this.initialize(signal)
    this.assertEnabled()
    throwIfAborted(signal)
    const manifest = this.requireManifest(checkpointId)
    const files: CheckpointFilePreview[] = []
    for (const file of manifest.files) {
      throwIfAborted(signal)
      const current = await this.options.workspace.readFile(manifest.workspaceFolderId, file.relativePath)
      const currentHash = hashFor(current)
      files.push({
        relativePath: file.relativePath,
        presentAtCheckpoint: file.presentAtCheckpoint,
        ...(file.expectedCurrentHash === undefined ? {} : { expectedCurrentHash: file.expectedCurrentHash }),
        ...(currentHash === undefined ? {} : { currentHash }),
        conflict: currentHash !== file.expectedCurrentHash,
        byteSize: file.byteSize,
      })
    }
    return {
      summary: checkpointSummary(manifest),
      files,
      conflictCount: files.filter((file) => file.conflict).length,
    }
  }

  public async delete(checkpointId: string, signal?: AbortSignal): Promise<void> {
    await this.initialize(signal)
    throwIfAborted(signal)
    const manifest = this.requireManifest(checkpointId)
    if (manifest.state === 'deleted') return
    await this.options.storage.delete(this.directoryFor(manifest.checkpointId), true)
    this.manifests.set(manifest.checkpointId, { ...manifest, state: 'deleted' })
    this.manifests.delete(manifest.checkpointId)
  }

  public async restore(
    checkpointId: string,
    expectedRevision: number,
    conflictPolicy: CheckpointConflictPolicy,
    signal?: AbortSignal,
  ): Promise<CheckpointRestoreOutcome> {
    await this.initialize(signal)
    this.assertEnabled()
    throwIfAborted(signal)
    const manifest = this.requireManifest(checkpointId)
    if (manifest.expectedRevision !== expectedRevision)
      throw checkpointConflict('The checkpoint revision is stale.')
    if (!checkpointRestoreAllowed(manifest))
      throw new AppError({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This checkpoint does not contain opt-in content that can be restored.',
        retryable: false,
      })

    const directory = this.directoryFor(manifest.checkpointId)
    const current = new Map<string, Uint8Array | undefined>()
    const conflicts: string[] = []
    const content = new Map<string, Uint8Array>()
    try {
      for (const file of manifest.files) {
        throwIfAborted(signal)
        const bytes = await this.options.workspace.readFile(manifest.workspaceFolderId, file.relativePath)
        current.set(file.relativePath, bytes)
        if (hashFor(bytes) !== file.expectedCurrentHash) conflicts.push(file.relativePath)
        if (
          file.presentAtCheckpoint &&
          file.contentRef !== undefined &&
          file.checkpointContentHash !== undefined
        ) {
          const stored = await this.options.storage
            .readFile(path.join(directory, file.contentRef))
            .catch((error) => {
              throw storageCorrupt(error)
            })
          if (sha256(stored) !== file.checkpointContentHash) throw storageCorrupt()
          content.set(file.relativePath, stored)
        }
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'STORAGE_CORRUPT')
        await this.markState(manifest, 'corrupt').catch(() => undefined)
      throw error
    }
    if (conflicts.length > 0 && conflictPolicy === 'abort') {
      await this.markState(manifest, 'stale')
      throw checkpointConflict(`The workspace changed at ${conflicts[0] ?? 'a checkpoint file'}.`)
    }

    const skippedPaths = conflicts
    const targets = manifest.files.filter((file) => !skippedPaths.includes(file.relativePath))
    const operationId = `dsh-restore-${this.makeId()}`
    const entries: StoredJournalEntry[] = []
    for (const [index, file] of targets.entries()) {
      throwIfAborted(signal)
      const bytes = current.get(file.relativePath)
      const backupRef = bytes === undefined ? undefined : `backup-${index}.bin`
      if (backupRef !== undefined && bytes !== undefined)
        await this.writeAtomic(path.join(directory, backupRef), bytes)
      entries.push({
        relativePath: file.relativePath,
        ...(backupRef === undefined ? {} : { backupRef }),
        ...(file.presentAtCheckpoint
          ? { tempPath: `${file.relativePath}.dsh-vscode-tmp-${operationId}` }
          : {}),
        originalPresent: bytes !== undefined,
      })
    }
    let journal: StoredJournal = {
      operationId,
      checkpointId: manifest.checkpointId,
      state: 'applying',
      entries,
      appliedPaths: [],
      skippedPaths,
    }
    await this.writeAtomic(path.join(directory, JOURNAL_FILE), encodePersisted(journal))
    try {
      for (const file of targets) {
        throwIfAborted(signal)
        const entry = entries.find((candidate) => candidate.relativePath === file.relativePath)
        if (entry === undefined) throw storageCorrupt()
        const latest = await this.options.workspace.readFile(manifest.workspaceFolderId, file.relativePath)
        if (hashFor(latest) !== file.expectedCurrentHash)
          throw checkpointConflict('A file changed during restore.')
        // Persist ownership of the target before changing it. If the next
        // write/rename is interrupted, startup recovery knows to restore the
        // backed-up original even though the apply did not finish.
        journal = { ...journal, appliedPaths: [...journal.appliedPaths, file.relativePath] }
        await this.writeAtomic(path.join(directory, JOURNAL_FILE), encodePersisted(journal))
        if (file.presentAtCheckpoint) {
          const bytes = content.get(file.relativePath)
          if (bytes === undefined || entry.tempPath === undefined) throw storageCorrupt()
          await this.options.workspace.writeFile(manifest.workspaceFolderId, entry.tempPath, bytes)
          await this.options.workspace.renameFile(
            manifest.workspaceFolderId,
            entry.tempPath,
            file.relativePath,
            true,
          )
        } else {
          await this.options.workspace.deleteFile(manifest.workspaceFolderId, file.relativePath)
        }
      }
      if (skippedPaths.length > 0) {
        journal = { ...journal, state: 'partial-restore' }
        await this.writeAtomic(path.join(directory, JOURNAL_FILE), encodePersisted(journal))
        const partial = { ...manifest, state: 'partial-restore' as const }
        await this.writeAtomic(path.join(directory, MANIFEST_FILE), encodePersisted(partial))
        this.manifests.set(partial.checkpointId, partial)
        return {
          summary: checkpointSummary(partial),
          state: 'partial',
          restoredPaths: journal.appliedPaths,
          skippedPaths,
        }
      }
      journal = { ...journal, state: 'committed' }
      await this.cleanupJournal(directory, journal, manifest)
      return {
        summary: checkpointSummary(manifest),
        state: 'completed',
        restoredPaths: journal.appliedPaths,
        skippedPaths: [],
      }
    } catch (error) {
      const rollback = await this.rollback(directory, manifest, journal)
      if (!rollback.complete) {
        const partial = { ...manifest, state: 'partial-restore' as const }
        await this.writeAtomic(path.join(directory, MANIFEST_FILE), encodePersisted(partial)).catch(
          () => undefined,
        )
        this.manifests.set(partial.checkpointId, partial)
        throw checkpointPartial()
      }
      await this.cleanupJournal(directory, { ...journal, state: 'rolled-back' }, manifest).catch(
        () => undefined,
      )
      throw normalizeStorageError(error)
    }
  }

  private async loadAndRecover(signal?: AbortSignal): Promise<void> {
    await this.options.storage.mkdir(this.options.rootPath)
    const entries = await this.options.storage.list(this.options.rootPath)
    for (const entry of entries) {
      throwIfAborted(signal)
      if (entry.kind !== 'directory' || !/^checkpoint-[a-f0-9]{32}$/u.test(entry.name)) continue
      const directory = path.join(this.options.rootPath, entry.name)
      const journal = await this.readPersisted<StoredJournal>(path.join(directory, JOURNAL_FILE)).catch(
        () => undefined,
      )
      if (journal?.state === 'applying') {
        const manifest = await this.readPersisted<CheckpointManifest>(
          path.join(directory, MANIFEST_FILE),
        ).catch(() => undefined)
        if (manifest !== undefined) {
          const rollback = await this.rollback(directory, manifest, journal)
          if (rollback.complete)
            await this.cleanupJournal(directory, { ...journal, state: 'rolled-back' }, manifest)
          else {
            const partial = { ...manifest, state: 'partial-restore' as const }
            await this.writeAtomic(path.join(directory, MANIFEST_FILE), encodePersisted(partial)).catch(
              () => undefined,
            )
            this.manifests.set(partial.checkpointId, partial)
          }
        }
      }
      const manifest = await this.readPersisted<CheckpointManifest>(
        path.join(directory, MANIFEST_FILE),
      ).catch(() => undefined)
      if (manifest !== undefined && isManifest(manifest)) this.manifests.set(manifest.checkpointId, manifest)
    }
    this.initialized = true
  }

  private async rollback(
    directory: string,
    manifest: CheckpointManifest,
    journal: StoredJournal,
  ): Promise<{ readonly complete: boolean }> {
    let complete = true
    for (const relativePath of [...journal.appliedPaths].reverse()) {
      const entry = journal.entries.find((candidate) => candidate.relativePath === relativePath)
      if (entry === undefined) {
        complete = false
        continue
      }
      try {
        if (entry.backupRef === undefined)
          await this.options.workspace.deleteFile(manifest.workspaceFolderId, relativePath)
        else {
          const bytes = await this.options.storage.readFile(path.join(directory, entry.backupRef))
          const rollbackPath = `${relativePath}.dsh-vscode-rollback-${journal.operationId}`
          await this.options.workspace.writeFile(manifest.workspaceFolderId, rollbackPath, bytes)
          await this.options.workspace.renameFile(
            manifest.workspaceFolderId,
            rollbackPath,
            relativePath,
            true,
          )
        }
      } catch {
        complete = false
      }
    }
    return { complete }
  }

  private async cleanupJournal(
    directory: string,
    journal: StoredJournal,
    manifest: CheckpointManifest,
  ): Promise<void> {
    for (const entry of journal.entries) {
      if (entry.backupRef !== undefined)
        await this.options.storage.delete(path.join(directory, entry.backupRef), false).catch(() => undefined)
      if (entry.tempPath !== undefined)
        await this.options.workspace
          .deleteFile(manifest.workspaceFolderId, entry.tempPath)
          .catch(() => undefined)
    }
    await this.options.storage.delete(path.join(directory, JOURNAL_FILE), false).catch(() => undefined)
  }

  private async markState(manifest: CheckpointManifest, state: CheckpointManifest['state']): Promise<void> {
    const next = { ...manifest, state }
    await this.writeAtomic(
      path.join(this.directoryFor(manifest.checkpointId), MANIFEST_FILE),
      encodePersisted(next),
    )
    this.manifests.set(manifest.checkpointId, next)
  }

  private async writeAtomic(filePath: string, data: Uint8Array): Promise<void> {
    const temporary = `${filePath}.tmp-${this.makeId()}`
    try {
      await this.options.storage.writeFile(temporary, data)
      await this.options.storage.rename(temporary, filePath, true)
    } catch (error) {
      await this.options.storage.delete(temporary, false).catch(() => undefined)
      throw error
    }
  }

  private async readPersisted<T>(filePath: string): Promise<T> {
    const bytes = await this.options.storage.readFile(filePath)
    let value: unknown
    try {
      value = JSON.parse(Buffer.from(bytes).toString('utf8'))
    } catch {
      throw storageCorrupt()
    }
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !isRecord(value.payload) ||
      typeof value.checksum !== 'string'
    )
      throw storageCorrupt()
    const payload = value.payload as T
    if (sha256(Buffer.from(JSON.stringify(payload), 'utf8')) !== value.checksum) throw storageCorrupt()
    return payload
  }

  private assertContentQuota(workspaceFolderId: string, bytes: number): void {
    const workspaceBytes = [...this.manifests.values()]
      .filter((manifest) => manifest.workspaceFolderId === workspaceFolderId && manifest.contentEnabled)
      .reduce((total, manifest) => total + manifest.totalBytes, 0)
    const globalBytes = [...this.manifests.values()]
      .filter((manifest) => manifest.contentEnabled)
      .reduce((total, manifest) => total + manifest.totalBytes, 0)
    if (workspaceBytes + bytes > CHECKPOINT_LIMITS.maxWorkspaceBytes)
      throw checkpointQuota('The workspace checkpoint quota has been reached.')
    if (globalBytes + bytes > CHECKPOINT_LIMITS.maxGlobalBytes)
      throw checkpointQuota('The global checkpoint quota has been reached.')
  }

  private directoryFor(checkpointId: string): string {
    return path.join(this.options.rootPath, `checkpoint-${sha256(Buffer.from(checkpointId)).slice(0, 32)}`)
  }

  private requireManifest(checkpointId: string): CheckpointManifest {
    const manifest = this.manifests.get(checkpointId)
    if (manifest === undefined)
      throw new AppError({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'The requested checkpoint is no longer available.',
        retryable: false,
      })
    return manifest
  }

  private assertEnabled(): void {
    if (this.enabled()) return
    throw new AppError({
      code: 'FEATURE_DISABLED',
      message: 'Checkpoint support is disabled in extension settings.',
      retryable: false,
    })
  }
}

function validateCreateInput(input: CheckpointCreateInput): void {
  if (
    input.sessionId.trim() === '' ||
    input.workspaceFolderId.trim() === '' ||
    (input.label !== undefined && Buffer.byteLength(input.label, 'utf8') > CHECKPOINT_LIMITS.maxLabelBytes)
  )
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The checkpoint metadata is invalid.',
      retryable: false,
    })
  for (const file of input.files)
    if (!isCanonicalWorkspaceRelativePath(file.relativePath))
      throw new AppError({
        code: 'PATH_NOT_ALLOWED',
        message: 'Only canonical workspace-relative paths can be checkpointed.',
        retryable: false,
      })
}

function encodePersisted<T>(payload: T): Uint8Array {
  const checksum = sha256(Buffer.from(JSON.stringify(payload), 'utf8'))
  return Buffer.from(JSON.stringify({ version: 1, payload, checksum }), 'utf8')
}

function isManifest(value: unknown): value is CheckpointManifest {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function hashFor(value: Uint8Array | undefined): string | undefined {
  return value === undefined ? undefined : sha256(value)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true)
    throw new AppError({
      code: 'REQUEST_CANCELLED',
      message: 'The checkpoint operation was cancelled.',
      retryable: true,
    })
}

function checkpointQuota(message: string): AppError {
  return new AppError({ code: 'CHECKPOINT_QUOTA', message, retryable: false })
}

function checkpointConflict(message: string): AppError {
  return new AppError({ code: 'CHECKPOINT_CONFLICT', message, retryable: true })
}

function checkpointPartial(): AppError {
  return new AppError({
    code: 'CHECKPOINT_PARTIAL',
    message: 'Checkpoint restore could not roll back every changed file.',
    retryable: false,
  })
}

function storageCorrupt(cause?: unknown): AppError {
  return new AppError({
    code: 'STORAGE_CORRUPT',
    message: 'Checkpoint metadata or content failed its integrity check.',
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  })
}

function normalizeStorageError(error: unknown): unknown {
  return error instanceof AppError
    ? error
    : new AppError({
        code: 'STORAGE_CORRUPT',
        message: 'Checkpoint storage could not complete the requested operation.',
        retryable: true,
        cause: error,
      })
}
