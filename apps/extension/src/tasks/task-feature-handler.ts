import {
  AppError,
  type SessionDetail,
  type TaskListScope,
  type TaskListSnapshot,
  type TaskSummary,
} from '@dsh-vscode/domain'
import type { TaskUseCases } from '@dsh-vscode/application'
import type { FeatureHostEvent, FeatureRequest, FeatureResponse } from '@dsh-vscode/webview-protocol'

type TaskFeatureRequest = Extract<
  FeatureRequest,
  { readonly type: 'tasks.list' | 'tasks.open' | 'tasks.stop' | 'tasks.answer' }
>
type FeatureResponsePayload = Extract<FeatureResponse, { readonly ok: true }>['payload']

interface TaskFeatureDependencies {
  readonly taskUseCases: TaskUseCases
  readonly requireCurrentWorkspaceSession: (sessionId: string, signal: AbortSignal) => Promise<SessionDetail>
  readonly featureWorkspaceFolderId: (
    requestedWorkspaceFolderId: string | undefined,
    session: SessionDetail | undefined,
  ) => string
  readonly isOpenWorkspaceFolderId: (workspaceFolderId: string) => boolean
  readonly hasWorkspaceFolders: () => boolean
  readonly getTaskSessionId: () => string | undefined
  readonly setTaskSessionId: (sessionId: string | undefined) => void
  readonly setTaskListScope: (scope: TaskListScope) => void
}

export async function handleTaskFeatureRequest(
  request: TaskFeatureRequest,
  signal: AbortSignal,
  dependencies: TaskFeatureDependencies,
): Promise<unknown> {
  const {
    taskUseCases,
    requireCurrentWorkspaceSession,
    featureWorkspaceFolderId,
    isOpenWorkspaceFolderId,
    hasWorkspaceFolders,
    getTaskSessionId,
    setTaskSessionId,
    setTaskListScope,
  } = dependencies
  if (request.type === 'tasks.list') {
    const scope = request.payload.scope ?? 'current-session'
    if (scope === 'workspace') {
      if (request.payload.sessionId !== undefined)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'A workspace task view cannot target one session.',
          retryable: false,
        })
      const requestedWorkspaceFolderId =
        request.payload.workspaceFolderId === undefined
          ? undefined
          : featureWorkspaceFolderId(request.payload.workspaceFolderId, undefined)
      if (requestedWorkspaceFolderId === undefined && !hasWorkspaceFolders())
        throw new AppError({
          code: 'RESOURCE_NOT_OWNED',
          message: 'Open a workspace folder before viewing workspace tasks.',
          retryable: false,
        })
      setTaskListScope('workspace')
      const snapshot = await taskUseCases.listSnapshot(
        {
          scope,
          ...(requestedWorkspaceFolderId === undefined
            ? {}
            : { workspaceFolderId: requestedWorkspaceFolderId }),
          ...(request.payload.includeCompleted === undefined
            ? {}
            : { includeCompleted: request.payload.includeCompleted }),
          ...(request.payload.cursor === undefined ? {} : { cursor: request.payload.cursor }),
          ...(request.payload.limit === undefined ? {} : { limit: request.payload.limit }),
        },
        signal,
      )
      return featureTaskList(snapshot)
    }
    const sessionId = request.payload.sessionId ?? getTaskSessionId()
    if (sessionId === undefined)
      throw new AppError({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'Open a session before viewing tasks.',
        retryable: false,
      })
    const session = await requireCurrentWorkspaceSession(sessionId, signal)
    const currentWorkspaceId = featureWorkspaceFolderId(request.payload.workspaceFolderId, session)
    setTaskSessionId(sessionId)
    setTaskListScope('current-session')
    const snapshot = await taskUseCases.listSnapshot(
      {
        workspaceFolderId: currentWorkspaceId,
        sessionId,
        scope,
        ...(request.payload.includeCompleted === undefined
          ? {}
          : { includeCompleted: request.payload.includeCompleted }),
        ...(request.payload.cursor === undefined ? {} : { cursor: request.payload.cursor }),
        ...(request.payload.limit === undefined ? {} : { limit: request.payload.limit }),
      },
      signal,
    )
    return featureTaskList(snapshot)
  }
  if (request.type === 'tasks.open') {
    const task = await taskUseCases.get(request.payload.taskId, signal)
    if (!isOpenWorkspaceFolderId(task.workspaceFolderId)) throw taskResourceNotOwned()
    if (task.sessionId !== undefined) {
      const session = await requireCurrentWorkspaceSession(task.sessionId, signal)
      featureWorkspaceFolderId(task.workspaceFolderId, session)
    }
    setTaskSessionId(task.sessionId)
    return featureTaskList({
      scope: 'current-session',
      source: 'current-session',
      items: [task],
      complete: true,
      omittedSessions: 0,
    })
  }
  if (request.type === 'tasks.stop') {
    const current = await taskUseCases.get(request.payload.taskId, signal)
    if (!isOpenWorkspaceFolderId(current.workspaceFolderId)) throw taskResourceNotOwned()
    if (current.sessionId !== undefined) {
      const session = await requireCurrentWorkspaceSession(current.sessionId, signal)
      featureWorkspaceFolderId(current.workspaceFolderId, session)
    }
    setTaskSessionId(current.sessionId)
    const task = await taskUseCases.stop(request.payload.taskId, request.payload.taskRevision, signal)
    return featureTaskList({
      scope: 'current-session',
      source: 'current-session',
      items: [task],
      complete: true,
      omittedSessions: 0,
    })
  }
  if (request.type === 'tasks.answer') {
    const current = await taskUseCases.get(request.payload.taskId, signal)
    if (!isOpenWorkspaceFolderId(current.workspaceFolderId)) throw taskResourceNotOwned()
    if (current.sessionId !== undefined) {
      const session = await requireCurrentWorkspaceSession(current.sessionId, signal)
      featureWorkspaceFolderId(current.workspaceFolderId, session)
    }
    setTaskSessionId(current.sessionId)
    const task = await taskUseCases.answer(
      request.payload.taskId,
      request.payload.interactionId,
      request.payload.answer,
      signal,
    )
    return featureTaskList({
      scope: 'current-session',
      source: 'current-session',
      items: [task],
      complete: true,
      omittedSessions: 0,
    })
  }
  throw new Error('Unhandled task request')
}

export function featureTaskSummary(
  task: TaskSummary,
): Extract<FeatureHostEvent, { readonly name: 'tasks.updated' }>['task'] {
  return {
    taskId: task.taskId,
    sourceId: task.sourceId,
    ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
    ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
    workspaceFolderId: task.workspaceFolderId,
    kind: task.kind === 'goal' || task.kind === 'interaction' ? task.kind : task.kind,
    title: task.title,
    ...(task.sessionTitle === undefined ? {} : { sessionTitle: task.sessionTitle }),
    status: task.status,
    needsUserAction: task.needsUserAction,
    ...(task.actionKind === undefined ? {} : { actionKind: task.actionKind }),
    ...(task.interactionId === undefined ? {} : { interactionId: task.interactionId }),
    ...(task.modelLabel === undefined ? {} : { modelLabel: task.modelLabel }),
    ...(task.providerLabel === undefined ? {} : { providerLabel: task.providerLabel }),
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    ...(task.progress === undefined ? {} : { progress: task.progress }),
    childCount: task.childCount,
    canOpen: task.canOpen,
    canAnswer: task.canAnswer,
    canSessionCancel: task.canSessionCancel,
    ownerKind: task.ownerKind,
    ...(task.backendInstanceId === undefined ? {} : { backendInstanceId: task.backendInstanceId }),
    ...(task.connectionGeneration === undefined ? {} : { connectionGeneration: task.connectionGeneration }),
    taskRevision: task.taskRevision,
  }
}

function featureTaskList(
  snapshot: TaskListSnapshot,
): Extract<FeatureResponsePayload, { readonly kind: 'tasks' }> {
  return {
    kind: 'tasks',
    items: snapshot.items.map(featureTaskSummary),
    scope: snapshot.scope,
    source: snapshot.source,
    complete: snapshot.complete,
    omittedSessions: snapshot.omittedSessions,
  }
}

function taskResourceNotOwned(): AppError {
  return new AppError({
    code: 'TASK_NOT_OWNED',
    message: 'The requested task does not belong to the current workspace.',
    retryable: false,
  })
}
