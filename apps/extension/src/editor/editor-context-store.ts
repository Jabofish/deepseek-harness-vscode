import { createHash, randomUUID } from 'node:crypto'

import {
  AppError,
  EDITOR_CONTEXT_LIMITS,
  isCanonicalWorkspaceRelativePath,
  isValidEditorContextRange,
  type EditorContextItem,
  type EditorContextOwner,
  type EditorContextPreview,
  type EditorContextRef,
  type EditorContextResolveInput,
  type EditorContextRange,
  type ResolvedEditorContext,
} from '@dsh-vscode/domain'

export interface CurrentEditorContextContent {
  readonly bytes: Uint8Array
  readonly documentVersion?: number
}

export interface StoredEditorContextInput {
  readonly workspaceFolderId: string
  readonly ownerId: string
  readonly ownerViewId: string
  readonly contextStoreGeneration: number
  readonly kind: EditorContextRef['kind']
  readonly relativePath: string
  readonly range?: EditorContextRange
  readonly label: string
  readonly bytes: Uint8Array
  readonly mimeType: string
  readonly documentVersion?: number
  readonly readCurrent?: () => Promise<CurrentEditorContextContent>
}

interface StoredEditorContext {
  ref: EditorContextRef
  readonly label: string
  readonly mimeType: string
  readonly capturedBytes: Uint8Array
  readonly readCurrent?: () => Promise<CurrentEditorContextContent>
}

interface PendingContextBinding {
  readonly sessionId: string
  readonly backendInstanceId: string
  readonly connectionGeneration: number
}

/**
 * Host-only editor context storage. The Webview receives only the ref and
 * metadata; captured bytes remain in this short-lived in-memory store until a
 * successful prompt admission or explicit release.
 */
export class EditorContextStore {
  private readonly entries = new Map<string, StoredEditorContext>()
  private readonly pendingBindings = new Map<string, PendingContextBinding>()

  public constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly makeId: () => string = () => randomUUID(),
    private readonly limits = EDITOR_CONTEXT_LIMITS,
  ) {}

  public capture(input: StoredEditorContextInput): EditorContextItem {
    const now = this.now()
    this.prune(now)
    if (!Number.isSafeInteger(input.contextStoreGeneration) || input.contextStoreGeneration < 0)
      throw invalidContext('The editor context store generation is invalid.')
    if (!isCanonicalWorkspaceRelativePath(input.relativePath))
      throw new AppError({
        code: 'PATH_NOT_ALLOWED',
        message: 'Only a canonical workspace-relative path can be stored.',
        retryable: false,
      })
    if (input.range !== undefined && !isValidEditorContextRange(input.range))
      throw invalidContext('The editor context range is invalid.')
    if (input.bytes.byteLength > this.limits.maxItemBytes)
      throw contextLimit('The selected editor context is too large.')
    if (this.entries.size >= this.limits.maxItems)
      throw contextLimit('Too many editor context items are already attached.')
    const existing = [...this.entries.values()].map((entry) => entry.ref)
    const nextSize = existing.reduce((total, entry) => total + entry.sizeBytes, 0) + input.bytes.byteLength
    if (nextSize > this.limits.maxTotalBytes) throw contextLimit('The combined editor context is too large.')

    const contextRef = `dsh-context:${this.makeId()}`
    const contentHash = hashBytes(input.bytes)
    const ref: EditorContextRef = {
      contextRef,
      workspaceFolderId: input.workspaceFolderId,
      ownerId: input.ownerId,
      ownerViewId: input.ownerViewId,
      contextStoreGeneration: input.contextStoreGeneration,
      kind: input.kind,
      relativePath: input.relativePath,
      ...(input.range === undefined ? {} : { range: input.range }),
      sizeBytes: input.bytes.byteLength,
      capturedAt: now,
      ...(input.documentVersion === undefined ? {} : { documentVersion: input.documentVersion }),
      contentHash,
      expiresAt: now + this.limits.ttlMs,
    }
    const entry: StoredEditorContext = {
      ref,
      label: input.label,
      mimeType: input.mimeType,
      capturedBytes: new Uint8Array(input.bytes),
      ...(input.readCurrent === undefined ? {} : { readCurrent: input.readCurrent }),
    }
    this.entries.set(contextRef, entry)
    return this.toItem(entry, false)
  }

  public async list(owner: EditorContextOwner): Promise<readonly EditorContextItem[]> {
    this.assertOwner(owner)
    this.prune(this.now())
    const items: EditorContextItem[] = []
    for (const entry of this.entries.values()) {
      if (!this.matchesOwner(entry.ref, owner)) continue
      if (!this.matchesWorkspace(entry.ref, owner.workspaceFolderId)) continue
      items.push(this.toItem(entry, await this.isStale(entry)))
    }
    return items.sort((left, right) => right.ref.capturedAt - left.ref.capturedAt)
  }

  public async preview(contextRef: string, owner: EditorContextOwner): Promise<EditorContextPreview> {
    const entry = this.requireEntry(contextRef, owner)
    const current = await this.readFresh(entry)
    const previewBytes =
      current.bytes.byteLength > this.limits.maxPreviewBytes
        ? current.bytes.slice(0, this.limits.maxPreviewBytes)
        : current.bytes
    return {
      contextRef,
      text: Buffer.from(previewBytes).toString('utf8'),
      truncated: current.bytes.byteLength > this.limits.maxPreviewBytes,
      expiresAt: entry.ref.expiresAt,
    }
  }

  public release(contextRefs: readonly string[], owner: EditorContextOwner): void {
    this.assertOwner(owner)
    for (const contextRef of new Set(contextRefs)) {
      const entry = this.entries.get(contextRef)
      if (entry === undefined) continue
      this.assertEntryOwner(entry.ref, owner)
      this.entries.delete(contextRef)
    }
  }

  /**
   * Resolve all refs before the caller invokes DSH. No partial result is
   * returned: one expired, stale, or mismatched ref rejects the whole batch.
   * The first successful resolution binds a ref to the exact session and
   * connection generation, preventing cross-session replay.
   */
  public async resolveForPrompt(input: EditorContextResolveInput): Promise<readonly ResolvedEditorContext[]> {
    this.assertOwner(input)
    if (input.contextRefs.length === 0) return []
    if (input.contextRefs.length > this.limits.maxItems)
      throw contextLimit('The editor context reference count is too large.')

    const uniqueRefs = [...new Set(input.contextRefs)]
    if (uniqueRefs.length !== input.contextRefs.length)
      throw invalidContext('The editor context contains duplicate references.')
    const resolved: Array<{
      readonly entry: StoredEditorContext
      readonly content: CurrentEditorContextContent
    }> = []
    const reservations: string[] = []
    let totalBytes = 0
    try {
      for (const contextRef of input.contextRefs) {
        const entry = this.requireEntry(contextRef, input)
        this.assertSessionBinding(entry.ref, input)
        this.reserveBinding(entry.ref.contextRef, input, reservations)
        const content = await this.readFresh(entry)
        totalBytes += content.bytes.byteLength
        if (content.bytes.byteLength > this.limits.maxItemBytes || totalBytes > this.limits.maxTotalBytes)
          throw contextLimit('The resolved editor context is too large.')
        resolved.push({ entry, content })
      }

      const result: ResolvedEditorContext[] = []
      for (const { entry, content } of resolved) {
        if (this.entries.get(entry.ref.contextRef) !== entry)
          throw contextExpired('The editor context is no longer available.')
        entry.ref = {
          ...entry.ref,
          sessionId: input.sessionId,
          backendInstanceId: input.backendInstanceId,
          connectionGeneration: input.connectionGeneration,
        }
        result.push({
          contextRef: entry.ref.contextRef,
          contentHash: hashBytes(content.bytes),
          sizeBytes: content.bytes.byteLength,
          attachment: {
            uri: `data:${entry.mimeType};base64,${Buffer.from(content.bytes).toString('base64')}`,
            name: entry.ref.relativePath,
            mimeType: entry.mimeType,
          },
        })
      }
      return result
    } finally {
      for (const contextRef of reservations) this.pendingBindings.delete(contextRef)
    }
  }

  public clear(): void {
    this.entries.clear()
    this.pendingBindings.clear()
  }

  public get size(): number {
    this.prune(this.now())
    return this.entries.size
  }

  private requireEntry(contextRef: string, owner: EditorContextOwner): StoredEditorContext {
    this.prune(this.now())
    const entry = this.entries.get(contextRef)
    if (entry === undefined) throw contextExpired('The editor context is no longer available.')
    this.assertEntryOwner(entry.ref, owner)
    return entry
  }

  private assertOwner(owner: EditorContextOwner): void {
    if (owner.ownerId === '' || owner.ownerViewId === '') throw resourceNotOwned()
    if (!Number.isSafeInteger(owner.contextStoreGeneration) || owner.contextStoreGeneration < 0)
      throw generationMismatch()
  }

  private assertEntryOwner(ref: EditorContextRef, owner: EditorContextOwner): void {
    if (ref.ownerId !== owner.ownerId || ref.ownerViewId !== owner.ownerViewId) throw resourceNotOwned()
    if (ref.contextStoreGeneration !== owner.contextStoreGeneration) throw generationMismatch()
    if (!this.matchesWorkspace(ref, owner.workspaceFolderId)) throw resourceNotOwned()
  }

  private assertSessionBinding(ref: EditorContextRef, input: EditorContextResolveInput): void {
    if (
      (ref.sessionId !== undefined && ref.sessionId !== input.sessionId) ||
      (ref.backendInstanceId !== undefined && ref.backendInstanceId !== input.backendInstanceId) ||
      (ref.connectionGeneration !== undefined && ref.connectionGeneration !== input.connectionGeneration)
    )
      throw generationMismatch()
  }

  private reserveBinding(contextRef: string, input: EditorContextResolveInput, reservations: string[]): void {
    const current = this.pendingBindings.get(contextRef)
    if (
      current !== undefined &&
      (current.sessionId !== input.sessionId ||
        current.backendInstanceId !== input.backendInstanceId ||
        current.connectionGeneration !== input.connectionGeneration)
    )
      throw generationMismatch()
    if (current === undefined) {
      this.pendingBindings.set(contextRef, {
        sessionId: input.sessionId,
        backendInstanceId: input.backendInstanceId,
        connectionGeneration: input.connectionGeneration,
      })
      reservations.push(contextRef)
    }
  }

  private matchesWorkspace(ref: EditorContextRef, workspaceFolderId: string | undefined): boolean {
    return workspaceFolderId === undefined || ref.workspaceFolderId === workspaceFolderId
  }

  private matchesOwner(ref: EditorContextRef, owner: EditorContextOwner): boolean {
    return (
      ref.ownerId === owner.ownerId &&
      ref.ownerViewId === owner.ownerViewId &&
      ref.contextStoreGeneration === owner.contextStoreGeneration
    )
  }

  private async isStale(entry: StoredEditorContext): Promise<boolean> {
    try {
      await this.readFresh(entry)
      return false
    } catch (error) {
      return error instanceof AppError && (error.code === 'CONTEXT_STALE' || error.code === 'CONTEXT_LIMIT')
    }
  }

  private async readFresh(entry: StoredEditorContext): Promise<CurrentEditorContextContent> {
    const now = this.now()
    if (entry.ref.expiresAt <= now) {
      this.entries.delete(entry.ref.contextRef)
      throw contextExpired('The editor context has expired.')
    }
    let current: CurrentEditorContextContent
    try {
      current =
        entry.readCurrent === undefined
          ? {
              bytes: entry.capturedBytes,
              ...(entry.ref.documentVersion === undefined
                ? {}
                : { documentVersion: entry.ref.documentVersion }),
            }
          : await entry.readCurrent()
    } catch {
      throw contextStale()
    }
    if (
      entry.ref.documentVersion !== undefined &&
      (current.documentVersion === undefined || current.documentVersion !== entry.ref.documentVersion)
    )
      throw contextStale()
    if (current.bytes.byteLength > this.limits.maxItemBytes)
      throw contextLimit('The editor context is too large.')
    if (hashBytes(current.bytes) !== entry.ref.contentHash) throw contextStale()
    return current
  }

  private toItem(entry: StoredEditorContext, stale: boolean): EditorContextItem {
    return {
      ref: entry.ref,
      label: entry.label,
      stale,
      previewAvailable: !stale,
    }
  }

  private prune(now: number): void {
    for (const [contextRef, entry] of this.entries)
      if (entry.ref.expiresAt <= now) {
        this.entries.delete(contextRef)
        this.pendingBindings.delete(contextRef)
      }
  }
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function contextLimit(message: string): AppError {
  return new AppError({ code: 'CONTEXT_LIMIT', message, retryable: false })
}

function contextExpired(message: string): AppError {
  return new AppError({ code: 'CONTEXT_EXPIRED', message, retryable: false })
}

function contextStale(): AppError {
  return new AppError({
    code: 'CONTEXT_STALE',
    message: 'The editor document changed after this context was captured.',
    retryable: false,
  })
}

function invalidContext(message: string): AppError {
  return new AppError({ code: 'INVALID_CONFIGURATION', message, retryable: false })
}

function resourceNotOwned(): AppError {
  return new AppError({
    code: 'RESOURCE_NOT_OWNED',
    message: 'The editor context is not owned by this view.',
    retryable: false,
  })
}

function generationMismatch(): AppError {
  return new AppError({
    code: 'GENERATION_MISMATCH',
    message: 'The editor context belongs to an older view or connection generation.',
    retryable: false,
  })
}
