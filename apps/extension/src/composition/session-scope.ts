import * as vscode from 'vscode'
import path from 'node:path'
import { AppError, type SessionDetail, type WorkspaceSummary } from '@dsh-vscode/domain'
import type { BackendService, WorkspaceUseCases } from '@dsh-vscode/application'
import type { TemporaryWorkspaceManager } from '../backend/temporary-workspace.js'
import { registerWorkspaceFolders } from '../backend/register-workspace-folders.js'
import { ownsCurrentWorkspaceSession } from '../view/session-ownership.js'
import { sameWorkspacePath } from './workspace-state.js'
import { sessionBelongsToWorkspaces } from './workspace-guards.js'
import { sessionOpenFailure } from './session-payload.js'

/**
 * Workspace scope and session ownership for every Webview route. The guards are
 * one entry so a route cannot reach a backend resource the current VS Code
 * workspace does not own, and so the validated session detail is shared by the
 * advisory reads an open fans out into.
 */
export interface SessionScopeDependencies {
  readonly backendService: BackendService
  readonly workspaceUseCases: WorkspaceUseCases
  readonly temporaryWorkspaceManager: TemporaryWorkspaceManager
  readonly currentWorkspaceFolders: () => readonly vscode.WorkspaceFolder[]
  readonly currentWorkspaceFolder: () => vscode.WorkspaceFolder | undefined
}

export interface SessionScope {
  listCurrentWorkspaces(this: void, signal?: AbortSignal): Promise<readonly WorkspaceSummary[]>
  listCurrentArchivedSessionIds(
    this: void,
    workspaces: readonly WorkspaceSummary[],
    signal?: AbortSignal,
  ): Promise<readonly string[]>
  ensureCurrentWorkspace(
    this: void,
    requestedWorkspaceId: string | undefined,
    signal?: AbortSignal,
  ): Promise<WorkspaceSummary>
  invalidateCurrentWorkspaceSessionDetails(this: void): void
  requireCurrentWorkspaceSession(
    this: void,
    sessionId: string,
    signal: AbortSignal,
    options?: { readonly fresh?: boolean; readonly allowArchived?: boolean },
  ): Promise<SessionDetail>
  requireCurrentWorkspaceId(this: void, workspaceId: string, signal: AbortSignal): Promise<void>
  requireOwnedQueuedInput(this: void, inputId: string, signal: AbortSignal): Promise<void>
  requireOwnedGoal(this: void, goalId: string, signal: AbortSignal): Promise<void>
  requireOwnedPermission(this: void, requestId: string, signal: AbortSignal): Promise<void>
  requireOwnedQuestion(this: void, questionId: string, signal: AbortSignal): Promise<void>
}

export function createSessionScope(deps: SessionScopeDependencies): SessionScope {
  const { backendService, workspaceUseCases, temporaryWorkspaceManager } = deps
  const currentWorkspaceFolders = deps.currentWorkspaceFolders
  const currentWorkspaceFolder = deps.currentWorkspaceFolder

  const listCurrentWorkspaces = async (signal?: AbortSignal): Promise<readonly WorkspaceSummary[]> => {
    const folders = currentWorkspaceFolders()
    const workspaces = await workspaceUseCases.list(signal)
    if (folders.length === 0) {
      return [await temporaryWorkspaceManager.resolve(workspaces, signal)]
    }
    return registerWorkspaceFolders(
      folders.map((folder) => folder.uri.fsPath),
      workspaces,
      (input, requestSignal) => workspaceUseCases.create(input, requestSignal),
      sameWorkspacePath,
      vscode.workspace.isTrusted,
      signal,
    )
  }
  // Opening one session fans out into several advisory reads (queue, goals,
  // jobs, feedback, subagents, commands, and model settings). They all need
  // the same workspace ownership check, but each request used to repeat the
  // full workspace/archive/session-history chain. Keep one validated detail
  // per current backend generation and share in-flight reads across those
  // requests. `session.open` can opt into a fresh read below.
  const currentWorkspaceSessionDetails = new Map<
    string,
    { readonly generation: number; readonly detail: SessionDetail }
  >()
  const currentWorkspaceSessionLoads = new Map<string, Promise<SessionDetail>>()
  let currentWorkspaceSessionGeneration = 0
  const invalidateCurrentWorkspaceSessionDetails = (): void => {
    currentWorkspaceSessionGeneration += 1
    currentWorkspaceSessionDetails.clear()
    currentWorkspaceSessionLoads.clear()
  }
  const listCurrentArchivedSessionIds = async (
    workspaces: readonly WorkspaceSummary[],
    signal?: AbortSignal,
  ): Promise<readonly string[]> => {
    if (workspaces.length === 0 && currentWorkspaceFolders().length === 0) return []
    const backend = backendService.requireBackend()
    // rc.6 defines this as a registry-global snapshot. Returning it directly
    // avoids a second session.list race while a workspace attach/archive is
    // being committed; the session list itself is still scoped below.
    return backend.workspaces.listArchivedSessionIds(signal)
  }
  const ensureCurrentWorkspace = async (
    requestedWorkspaceId: string | undefined,
    signal?: AbortSignal,
  ): Promise<WorkspaceSummary> => {
    const current = await listCurrentWorkspaces(signal)
    const requested = current.find((workspace) => workspace.id === requestedWorkspaceId)
    if (requested !== undefined) return requested
    const existing = current[0]
    if (existing !== undefined) return existing

    const folder = currentWorkspaceFolder()
    if (folder !== undefined) {
      return workspaceUseCases.create(
        {
          name: path.basename(path.normalize(folder.uri.fsPath)) || 'Workspace',
          path: folder.uri.fsPath,
        },
        signal,
      )
    }

    return temporaryWorkspaceManager.ensure(signal)
  }
  /**
   * A catalog-resolved child session has no workspace membership of its own —
   * `session/list` drops a child without a cwd — so its ownership comes from
   * the durable parent the subagent catalog published. Without this walk every
   * child-scoped route the Webview legitimately opened from that catalog
   * (subagent history/send/interrupt, goal/job/queue/feedback) would be
   * refused as a foreign session.
   */
  const ownsSession = async (
    sessionId: string,
    detail: SessionDetail,
    workspaces: readonly WorkspaceSummary[],
    signal: AbortSignal,
  ): Promise<boolean> => {
    const subagents = backendService.requireBackend().subagents
    try {
      return await ownsCurrentWorkspaceSession({
        sessionId,
        detail,
        belongs: (session) => sessionBelongsToWorkspaces(session, workspaces, currentWorkspaceFolders()),
        parentOf: (childSessionId) => subagents.parentOf?.(childSessionId),
        readSession: (parentId) => backendService.requireBackend().sessions.get(parentId, signal),
      })
    } catch (error) {
      throw sessionOpenFailure('parent session ownership check', error)
    }
  }
  /**
   * `allowArchived` serves only the two recovery routes that must reach a
   * session the active surface refuses — restoring one, or deleting one for
   * good. Such a read stays out of the active-session cache so a recovered row
   * can never be handed to an ordinary route from there.
   */
  const requireCurrentWorkspaceSession = async (
    sessionId: string,
    signal: AbortSignal,
    options: { readonly fresh?: boolean; readonly allowArchived?: boolean } = {},
  ): Promise<SessionDetail> => {
    if (options.fresh !== true && options.allowArchived !== true) {
      const cached = currentWorkspaceSessionDetails.get(sessionId)
      if (cached?.generation === currentWorkspaceSessionGeneration) return cached.detail
    }
    const pending = currentWorkspaceSessionLoads.get(sessionId)
    // An explicit session.open owns a fresh stream baseline. Do not let an
    // older advisory ownership read bypass that re-baselining hook.
    if (pending !== undefined && options.fresh !== true) return pending

    const generation = currentWorkspaceSessionGeneration
    const load = (async (): Promise<SessionDetail> => {
      let workspaces: readonly WorkspaceSummary[]
      try {
        workspaces = await listCurrentWorkspaces(signal)
      } catch (error) {
        throw sessionOpenFailure('workspace discovery', error)
      }

      let archivedSessionIds: readonly string[]
      try {
        archivedSessionIds = await backendService.requireBackend().workspaces.listArchivedSessionIds(signal)
      } catch (error) {
        throw sessionOpenFailure('archive state lookup', error)
      }
      if (archivedSessionIds.includes(sessionId) && options.allowArchived !== true)
        throw sessionOpenFailure(
          'archive state lookup',
          new AppError({
            code: 'PERMISSION_DENIED',
            message: 'The requested session is archived.',
            retryable: false,
          }),
        )

      let detail: SessionDetail
      try {
        const sessions = backendService.requireBackend().sessions
        detail =
          options.fresh === true && sessions.open !== undefined
            ? await sessions.open(sessionId, signal)
            : await sessions.get(sessionId, signal)
      } catch (error) {
        throw sessionOpenFailure('session summary and history read', error)
      }
      if (!(await ownsSession(sessionId, detail, workspaces, signal)))
        throw sessionOpenFailure(
          'current workspace ownership check',
          new AppError({
            code: 'PERMISSION_DENIED',
            message: 'The requested session is not part of the current VS Code workspace.',
            retryable: false,
          }),
        )
      if (generation === currentWorkspaceSessionGeneration && options.allowArchived !== true)
        currentWorkspaceSessionDetails.set(sessionId, { generation, detail })
      return detail
    })()
    currentWorkspaceSessionLoads.set(sessionId, load)
    void load.then(
      () => {
        if (currentWorkspaceSessionLoads.get(sessionId) === load)
          currentWorkspaceSessionLoads.delete(sessionId)
      },
      () => {
        if (currentWorkspaceSessionLoads.get(sessionId) === load)
          currentWorkspaceSessionLoads.delete(sessionId)
      },
    )
    return load
  }
  const requireCurrentWorkspaceId = async (workspaceId: string, signal: AbortSignal): Promise<void> => {
    const workspaces = await listCurrentWorkspaces(signal)
    if (workspaces.some((workspace) => workspace.id === workspaceId)) return
    throw new AppError({
      code: 'PERMISSION_DENIED',
      message: 'The requested workspace is not part of the current VS Code workspace.',
      retryable: false,
    })
  }
  const requireOwnedQueuedInput = async (inputId: string, signal: AbortSignal): Promise<void> => {
    const owner = backendService.requireBackend().sessions.sessionForQueuedInput?.(inputId)
    if (owner === undefined) {
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'The queued DSH input is not owned by the current workspace.',
        retryable: false,
      })
    }
    await requireCurrentWorkspaceSession(owner, signal)
  }
  const requireOwnedGoal = async (goalId: string, signal: AbortSignal): Promise<void> => {
    const owner = backendService.requireBackend().goals.sessionForGoal?.(goalId)
    if (owner === undefined) {
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'The requested goal is not owned by the current workspace.',
        retryable: false,
      })
    }
    await requireCurrentWorkspaceSession(owner, signal)
  }
  const requireOwnedPermission = async (requestId: string, signal: AbortSignal): Promise<void> => {
    const owner = backendService.requireBackend().interactions.sessionForPermission?.(requestId)
    if (owner === undefined) {
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'The requested permission is not owned by the current workspace.',
        retryable: false,
      })
    }
    await requireCurrentWorkspaceSession(owner, signal)
  }
  const requireOwnedQuestion = async (questionId: string, signal: AbortSignal): Promise<void> => {
    const owner = backendService.requireBackend().interactions.sessionForQuestion?.(questionId)
    if (owner === undefined) {
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'The requested question is not owned by the current workspace.',
        retryable: false,
      })
    }
    await requireCurrentWorkspaceSession(owner, signal)
  }

  return {
    listCurrentWorkspaces,
    listCurrentArchivedSessionIds,
    ensureCurrentWorkspace,
    invalidateCurrentWorkspaceSessionDetails,
    requireCurrentWorkspaceSession,
    requireCurrentWorkspaceId,
    requireOwnedQueuedInput,
    requireOwnedGoal,
    requireOwnedPermission,
    requireOwnedQuestion,
  }
}
