import {
  AppError,
  type WorkspaceCreateInput,
  type WorkspaceRepository,
  type WorkspaceSummary,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc } from '../versions/rc6/rpc.js'
import { rc6Mapper } from '../versions/rc6/mapper.js'

export interface Rc6WorkspaceSnapshot {
  readonly items: readonly WorkspaceSummary[]
  readonly archivedSessionIds: ReadonlySet<string>
}

export class Rc6WorkspaceRepository implements WorkspaceRepository {
  private archivedSessionIds = new Set<string>()
  // A workspace.list request can be in flight while archiveSession commits.
  // Keep local monotonic knowledge until the host's archive-set echo arrives,
  // so an older list response cannot put the row back into the switcher.
  private readonly confirmedLocalArchives = new Set<string>()
  private readonly pendingArchives = new Set<string>()
  public constructor(private readonly transport: DshTransport) {}

  public async list(signal?: AbortSignal): Promise<readonly WorkspaceSummary[]> {
    const snapshot = await this.listWithArchiveState(signal)
    return snapshot.items
  }

  public async listArchivedSessionIds(signal?: AbortSignal): Promise<readonly string[]> {
    const snapshot = await this.listWithArchiveState(signal)
    return [...snapshot.archivedSessionIds]
  }

  public async listWithArchiveState(signal?: AbortSignal): Promise<Rc6WorkspaceSnapshot> {
    const value = asRecord(await callRpc<unknown>(this.transport, 'workspace.list', {}, signal))
    if (!Array.isArray(value.items) || !isStringArray(value.archivedSessionIds))
      throw malformedWorkspaceResponse()
    const archivedSessionIds = new Set([
      ...value.archivedSessionIds,
      ...this.confirmedLocalArchives,
      ...this.pendingArchives,
    ])
    this.archivedSessionIds = new Set(archivedSessionIds)
    return {
      items: value.items.map((item) => rc6Mapper.workspace(item)),
      // Keep archive state attached to this response. Session and workspace
      // lists can be requested concurrently, so reading the mutable cache
      // after the await can pair rows with a different snapshot.
      archivedSessionIds: new Set(archivedSessionIds),
    }
  }

  public isArchived(sessionId: string): boolean {
    return this.archivedSessionIds.has(sessionId)
  }

  public async archiveSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    this.pendingArchives.add(sessionId)
    this.archivedSessionIds.add(sessionId)
    try {
      const value = asRecord(
        await callRpc<unknown>(this.transport, 'workspace.archiveSession', { sessionId }, signal),
      )
      if (!isStringArray(value.archivedSessionIds)) throw malformedArchiveResponse()
      this.pendingArchives.delete(sessionId)
      for (const archivedSessionId of value.archivedSessionIds)
        this.confirmedLocalArchives.add(archivedSessionId)
      this.confirmedLocalArchives.add(sessionId)
      this.archivedSessionIds = new Set([
        ...value.archivedSessionIds,
        ...this.confirmedLocalArchives,
        ...this.pendingArchives,
      ])
    } catch (error) {
      this.pendingArchives.delete(sessionId)
      this.archivedSessionIds.delete(sessionId)
      throw error
    }
  }

  public async create(input: WorkspaceCreateInput, signal?: AbortSignal): Promise<WorkspaceSummary> {
    const value = await callRpc<{ workspace: unknown; created?: unknown }>(
      this.transport,
      'workspace.create',
      { path: input.path },
      signal,
    )
    const workspace = rc6Mapper.workspace({
      ...asRecord(value.workspace),
    })
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
      const refreshed = (await this.list(signal)).find((item) => item.id === workspace.id)
      if (refreshed !== undefined) return refreshed
    }
    return workspace
  }

  public async rename(workspaceId: string, name: string, signal?: AbortSignal): Promise<void> {
    await callRpc(this.transport, 'workspace.rename', { workspaceId, title: name }, signal)
  }

  public async remove(workspaceId: string, signal?: AbortSignal): Promise<void> {
    await callRpc(this.transport, 'workspace.delete', { workspaceId }, signal)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')
}

function malformedWorkspaceResponse(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed workspace list.',
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
