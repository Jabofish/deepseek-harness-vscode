import {
  AppError,
  type WorkspaceCreateInput,
  type WorkspaceRepository,
  type WorkspaceSummary,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc, unavailable } from '../versions/rc6/rpc.js'
import { rc6Mapper } from '../versions/rc6/mapper.js'
import { recordOrUndefined } from './shared/guards.js'

export interface Rc6WorkspaceSnapshot {
  readonly items: readonly WorkspaceSummary[]
  readonly archivedSessionIds: ReadonlySet<string>
}

export interface Rc6WorkspaceRepositoryOptions {
  readonly supportsSessionRestore?: boolean
}

export class Rc6WorkspaceRepository implements WorkspaceRepository {
  private archivedSessionIds = new Set<string>()
  // Mutations fence older reads, but a read begun after their acknowledgement
  // is authoritative, including restores performed by another client.
  private mutationRevision = 0
  private readSequence = 0
  private appliedReadSequence = 0
  private lastSnapshot: Rc6WorkspaceSnapshot | undefined
  private readonly localArchiveChanges = new Map<string, { revision: number; archived: boolean }>()
  private readonly pendingArchives = new Set<string>()
  private readonly supportsSessionRestore: boolean
  public constructor(
    private readonly transport: DshTransport,
    options: Rc6WorkspaceRepositoryOptions = {},
  ) {
    this.supportsSessionRestore = options.supportsSessionRestore === true
  }

  public async list(signal?: AbortSignal): Promise<readonly WorkspaceSummary[]> {
    const snapshot = await this.listWithArchiveState(signal)
    return snapshot.items
  }

  public async listArchivedSessionIds(signal?: AbortSignal): Promise<readonly string[]> {
    const snapshot = await this.listWithArchiveState(signal)
    return [...snapshot.archivedSessionIds]
  }

  public async listWithArchiveState(signal?: AbortSignal): Promise<Rc6WorkspaceSnapshot> {
    const revision = this.mutationRevision
    const readSequence = ++this.readSequence
    const value = recordOrUndefined(await callRpc<unknown>(this.transport, 'workspace.list', {}, signal))
    if (
      value === undefined ||
      !Array.isArray(value.items) ||
      !value.items.every(validWorkspaceView) ||
      !isStringArray(value.archivedSessionIds)
    )
      throw malformedWorkspaceResponse('list')
    if (readSequence < this.appliedReadSequence && this.lastSnapshot !== undefined)
      return {
        ...this.lastSnapshot,
        archivedSessionIds: this.applyLocalArchives([...this.lastSnapshot.archivedSessionIds]),
      }
    for (const [id, change] of this.localArchiveChanges)
      if (change.revision <= revision) this.localArchiveChanges.delete(id)
    const archivedSessionIds = this.applyLocalArchives(value.archivedSessionIds)
    this.archivedSessionIds = archivedSessionIds
    this.appliedReadSequence = readSequence
    this.lastSnapshot = {
      items: value.items.map((item) => rc6Mapper.workspace(item)),
      archivedSessionIds: new Set(archivedSessionIds),
    }
    return this.lastSnapshot
  }

  private applyLocalArchives(ids: readonly string[]): Set<string> {
    const result = new Set(ids)
    for (const [id, change] of this.localArchiveChanges)
      if (change.archived) result.add(id)
      else result.delete(id)
    for (const id of this.pendingArchives) result.add(id)
    return result
  }

  public isArchived(sessionId: string): boolean {
    return this.archivedSessionIds.has(sessionId)
  }

  public async archiveSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    const wasArchived = this.archivedSessionIds.has(sessionId)
    this.pendingArchives.add(sessionId)
    this.archivedSessionIds.add(sessionId)
    try {
      const value = recordOrUndefined(
        await callRpc<unknown>(this.transport, 'workspace.archiveSession', { sessionId }, signal),
      )
      if (value === undefined || !isStringArray(value.archivedSessionIds)) throw malformedArchiveResponse()
      this.pendingArchives.delete(sessionId)
      this.localArchiveChanges.set(sessionId, { revision: ++this.mutationRevision, archived: true })
      this.archivedSessionIds = this.applyLocalArchives(value.archivedSessionIds)
    } catch (error) {
      this.pendingArchives.delete(sessionId)
      if (!wasArchived) this.archivedSessionIds.delete(sessionId)
      throw error
    }
  }

  /** Restore one session and fence reads begun before the acknowledgement. */
  public async unarchiveSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    if (!this.supportsSessionRestore) throw unavailable('session restoration')
    const wasArchived = this.archivedSessionIds.has(sessionId)
    this.archivedSessionIds.delete(sessionId)
    try {
      const value = recordOrUndefined(
        await callRpc<unknown>(this.transport, 'workspace.unarchiveSession', { sessionId }, signal),
      )
      if (value === undefined || !isStringArray(value.archivedSessionIds)) throw malformedArchiveResponse()
      this.pendingArchives.delete(sessionId)
      this.localArchiveChanges.set(sessionId, { revision: ++this.mutationRevision, archived: false })
      this.archivedSessionIds = this.applyLocalArchives(value.archivedSessionIds)
    } catch (error) {
      if (wasArchived) this.archivedSessionIds.add(sessionId)
      throw error
    }
  }

  public async create(input: WorkspaceCreateInput, signal?: AbortSignal): Promise<WorkspaceSummary> {
    const value = recordOrUndefined(
      await callRpc<unknown>(this.transport, 'workspace.create', { path: input.path }, signal),
    )
    if (value === undefined || !validWorkspaceView(value.workspace) || typeof value.created !== 'boolean')
      throw malformedWorkspaceResponse('create')
    const workspace = rc6Mapper.workspace(value.workspace)
    // workspace.create owns the canonical basename. Rename only a genuinely
    // new registration; an idempotent create over an existing path must not
    // silently rename another workspace as a side effect.
    if (value.created === true && input.name.trim() !== '' && input.name.trim() !== workspace.name.trim()) {
      try {
        await this.rename(workspace.id, input.name, signal)
      } catch (error) {
        // The path registration already succeeded.  A duplicate display name
        // must not make the new session unusable; keep DSH's canonical title.
        if (!(error instanceof AppError) || error.context?.rpcCode !== 'workspace-name-conflict') throw error
      }
      try {
        const refreshed = (await this.list(signal)).find((item) => item.id === workspace.id)
        if (refreshed !== undefined) return refreshed
      } catch (error) {
        // Creation and rename already committed. A follow-up list is only a
        // display-name refresh; do not report a successful mutation as failed
        // because that best-effort read raced a transient transport error.
        if (signal?.aborted === true || (error instanceof AppError && error.code === 'REQUEST_CANCELLED'))
          throw error
      }
    }
    return workspace
  }

  public async rename(workspaceId: string, name: string, signal?: AbortSignal): Promise<void> {
    const value = recordOrUndefined(
      await callRpc<unknown>(this.transport, 'workspace.rename', { workspaceId, title: name }, signal),
    )
    if (value === undefined || !validWorkspaceView(value.workspace))
      throw malformedWorkspaceResponse('rename')
  }

  public async remove(workspaceId: string, signal?: AbortSignal): Promise<void> {
    const value = recordOrUndefined(
      await callRpc<unknown>(this.transport, 'workspace.delete', { workspaceId }, signal),
    )
    if (value === undefined || value.deleted !== true) throw malformedWorkspaceResponse('delete')
  }

  public async insertBefore(
    workspaceId: string,
    beforeWorkspaceId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const value = recordOrUndefined(
      await callRpc<unknown>(
        this.transport,
        'workspace.insertBefore',
        {
          workspaceId,
          ...(beforeWorkspaceId === undefined ? {} : { beforeWorkspaceId }),
        },
        signal,
      ),
    )
    if (value === undefined || !isStringArray(value.workspaceIds))
      throw malformedWorkspaceResponse('insertBefore')
  }

  public async insertSessionBefore(
    workspaceId: string,
    sessionId: string,
    beforeSessionId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const value = recordOrUndefined(
      await callRpc<unknown>(
        this.transport,
        'workspace.insertSessionBefore',
        {
          workspaceId,
          sessionId,
          ...(beforeSessionId === undefined ? {} : { beforeSessionId }),
        },
        signal,
      ),
    )
    if (value === undefined || !validWorkspaceView(value.workspace))
      throw malformedWorkspaceResponse('insertSessionBefore')
  }
}

function validWorkspaceView(value: unknown): boolean {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    typeof record.workspaceId === 'string' &&
    record.workspaceId.trim() !== '' &&
    typeof record.path === 'string' &&
    typeof record.title === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string' &&
    Array.isArray(record.sessionIds) &&
    record.sessionIds.every(
      (sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.trim() !== '',
    )
  )
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
  )
}

function malformedWorkspaceResponse(operation: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed workspace ${operation} response.`,
    retryable: false,
  })
}

function malformedArchiveResponse(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed archive response.',
    retryable: false,
  })
}
