import {
  AppError,
  type CheckpointPreview,
  type CheckpointSummary,
  type SessionDetail,
} from '@dsh-vscode/domain'
import type { ChangeUseCases, CheckpointUseCases } from '@dsh-vscode/application'
import type { FeatureHostEvent, FeatureRequest, FeatureResponse } from '@dsh-vscode/webview-protocol'

type CheckpointFeatureRequest = Extract<
  FeatureRequest,
  {
    readonly type:
      | 'checkpoint.create'
      | 'checkpoint.list'
      | 'checkpoint.preview'
      | 'checkpoint.delete'
      | 'checkpoint.restore'
  }
>
type FeatureResponsePayload = Extract<FeatureResponse, { readonly ok: true }>['payload']

interface CheckpointFeatureDependencies {
  readonly changeUseCases: ChangeUseCases
  readonly checkpointUseCases: CheckpointUseCases
  readonly requireCurrentWorkspaceSession: (sessionId: string, signal: AbortSignal) => Promise<SessionDetail>
  readonly featureWorkspaceFolderId: (
    requestedWorkspaceFolderId: string | undefined,
    session: SessionDetail | undefined,
  ) => string
  readonly postCheckpointFeatureEvent: (checkpoint: CheckpointSummary) => Promise<boolean>
}

export async function handleCheckpointFeatureRequest(
  request: CheckpointFeatureRequest,
  signal: AbortSignal,
  dependencies: CheckpointFeatureDependencies,
): Promise<unknown> {
  const {
    changeUseCases,
    checkpointUseCases,
    requireCurrentWorkspaceSession,
    featureWorkspaceFolderId,
    postCheckpointFeatureEvent,
  } = dependencies
  if (request.type === 'checkpoint.create') {
    const session = await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
    const workspaceId = featureWorkspaceFolderId(request.payload.workspaceFolderId, session)
    const changes = await changeUseCases.list(
      { workspaceFolderId: workspaceId, sessionId: session.id, limit: 200 },
      signal,
    )
    const checkpoint = await checkpointUseCases.create(
      {
        sessionId: session.id,
        workspaceFolderId: workspaceId,
        ...(request.payload.label === undefined ? {} : { label: request.payload.label }),
        files: changes,
      },
      signal,
    )
    void postCheckpointFeatureEvent(checkpoint)
    return { kind: 'checkpoints', items: [featureCheckpointSummary(checkpoint)] }
  }
  if (request.type === 'checkpoint.list') {
    const session =
      request.payload.sessionId === undefined
        ? undefined
        : await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
    const workspaceId = featureWorkspaceFolderId(request.payload.workspaceFolderId, session)
    const checkpoints = await checkpointUseCases.list(
      { workspaceFolderId: workspaceId, ...(session === undefined ? {} : { sessionId: session.id }) },
      signal,
    )
    return { kind: 'checkpoints', items: checkpoints.map(featureCheckpointSummary) }
  }
  if (request.type === 'checkpoint.preview') {
    const session = await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
    const workspaceId = featureWorkspaceFolderId(request.payload.workspaceFolderId, session)
    const checkpoint = await checkpointUseCases.get(request.payload.checkpointId, signal)
    assertCheckpointOwnership(checkpoint, session.id, workspaceId)
    const preview = await checkpointUseCases.preview(request.payload.checkpointId, signal)
    return { kind: 'checkpoint.preview', preview: featureCheckpointPreview(preview) }
  }
  if (request.type === 'checkpoint.delete') {
    const session = await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
    const checkpoint = await checkpointUseCases.get(request.payload.checkpointId, signal)
    assertCheckpointOwnership(
      checkpoint,
      session.id,
      featureWorkspaceFolderId(request.payload.workspaceFolderId, session),
    )
    await checkpointUseCases.delete(request.payload.checkpointId, signal)
    void postCheckpointFeatureEvent({ ...checkpoint, state: 'deleted', restoreAllowed: false })
    return {
      kind: 'checkpoints',
      items: [{ ...featureCheckpointSummary(checkpoint), state: 'deleted', restoreAllowed: false }],
    }
  }
  if (request.type === 'checkpoint.restore') {
    const session = await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
    const checkpoint = await checkpointUseCases.get(request.payload.checkpointId, signal)
    assertCheckpointOwnership(
      checkpoint,
      session.id,
      featureWorkspaceFolderId(request.payload.workspaceFolderId, session),
    )
    const restored = await checkpointUseCases.restore(
      request.payload.checkpointId,
      request.payload.expectedCurrentRevision,
      request.payload.previewId,
      request.payload.conflictPolicy,
      signal,
    )
    void postCheckpointFeatureEvent(restored.summary)
    return {
      kind: 'operation',
      operationId: request.requestId,
      state: restored.state,
      message: 'Checkpoint restore completed.',
    }
  }
  throw new Error('Unhandled checkpoint request')
}

export function featureCheckpointSummary(
  checkpoint: CheckpointSummary,
): Extract<FeatureHostEvent, { readonly name: 'checkpoint.updated' }>['checkpoint'] {
  return {
    checkpointId: checkpoint.checkpointId,
    sessionId: checkpoint.sessionId,
    workspaceFolderId: checkpoint.workspaceFolderId,
    createdAt: checkpoint.createdAt,
    ...(checkpoint.label === undefined ? {} : { label: checkpoint.label }),
    fileCount: checkpoint.fileCount,
    totalBytes: checkpoint.totalBytes,
    state: checkpoint.state,
    restoreAllowed: checkpoint.restoreAllowed,
    contentEnabled: checkpoint.contentEnabled,
    ...(checkpoint.expectedRevision === undefined ? {} : { expectedRevision: checkpoint.expectedRevision }),
  }
}

function featureCheckpointPreview(
  preview: CheckpointPreview,
): Extract<FeatureResponsePayload, { readonly kind: 'checkpoint.preview' }>['preview'] {
  return {
    previewId: preview.previewId,
    summary: featureCheckpointSummary(preview.summary),
    files: preview.files.map((file) => ({
      relativePath: file.relativePath,
      presentAtCheckpoint: file.presentAtCheckpoint,
      ...(file.expectedCurrentHash === undefined ? {} : { expectedCurrentHash: file.expectedCurrentHash }),
      ...(file.currentHash === undefined ? {} : { currentHash: file.currentHash }),
      conflict: file.conflict,
      byteSize: file.byteSize,
    })),
    conflictCount: preview.conflictCount,
  }
}

function assertCheckpointOwnership(
  checkpoint: Pick<CheckpointSummary, 'sessionId' | 'workspaceFolderId'>,
  sessionId: string,
  workspaceFolderId: string,
): void {
  if (checkpoint.sessionId === sessionId && checkpoint.workspaceFolderId === workspaceFolderId) return
  throw new AppError({
    code: 'RESOURCE_NOT_OWNED',
    message: 'The requested checkpoint is not owned by the current session and workspace.',
    retryable: false,
  })
}
