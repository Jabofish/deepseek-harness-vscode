import type {
  CheckpointConflictPolicy,
  CheckpointCreateInput,
  CheckpointPreview,
  CheckpointRepository,
  CheckpointRestoreOutcome,
  CheckpointSummary,
} from '@dsh-vscode/domain'

export class CheckpointUseCases {
  public constructor(private readonly repository: CheckpointRepository) {}

  public create(input: CheckpointCreateInput, signal?: AbortSignal): Promise<CheckpointSummary> {
    return this.repository.create(input, signal)
  }

  public list(
    query: {
      readonly workspaceFolderId: string
      readonly sessionId?: string
      readonly includeDeleted?: boolean
    },
    signal?: AbortSignal,
  ): Promise<readonly CheckpointSummary[]> {
    return this.repository.list(query, signal)
  }

  public get(checkpointId: string, signal?: AbortSignal): Promise<CheckpointSummary> {
    return this.repository.get(checkpointId, signal)
  }

  public preview(checkpointId: string, signal?: AbortSignal): Promise<CheckpointPreview> {
    return this.repository.preview(checkpointId, signal)
  }

  public delete(checkpointId: string, signal?: AbortSignal): Promise<void> {
    return this.repository.delete(checkpointId, signal)
  }

  public restore(
    checkpointId: string,
    expectedRevision: number,
    previewId: string,
    conflictPolicy: CheckpointConflictPolicy,
    signal?: AbortSignal,
  ): Promise<CheckpointRestoreOutcome> {
    return this.repository.restore(checkpointId, expectedRevision, previewId, conflictPolicy, signal)
  }
}
