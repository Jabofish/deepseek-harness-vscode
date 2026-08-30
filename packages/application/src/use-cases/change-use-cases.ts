import type {
  ChangeDetail,
  ChangeListQuery,
  ChangeRepository,
  ChangeReviewState,
  ChangeSetFile,
} from '@dsh-vscode/domain'

export class ChangeUseCases {
  public constructor(private readonly changes: ChangeRepository) {}

  public list(query?: ChangeListQuery, signal?: AbortSignal): Promise<readonly ChangeSetFile[]> {
    return this.changes.list(query, signal)
  }

  public get(changeId: string, signal?: AbortSignal): Promise<ChangeDetail> {
    return this.changes.get(changeId, signal)
  }

  public markReviewed(
    changeId: string,
    reviewState: ChangeReviewState,
    signal?: AbortSignal,
  ): Promise<ChangeSetFile> {
    return this.changes.markReviewed(changeId, reviewState, signal)
  }
}
