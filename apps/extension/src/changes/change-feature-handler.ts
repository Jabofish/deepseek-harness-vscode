import { AppError, type ChangeSetFile, type DshBackend, type SessionDetail } from '@dsh-vscode/domain'
import type { ChangeUseCases } from '@dsh-vscode/application'
import { redactMultilineText } from '@dsh-vscode/dsh-adapter'
import type { FeatureHostEvent, FeatureRequest } from '@dsh-vscode/webview-protocol'
import type { ChangeSetTracker } from './change-set-tracker.js'

type ChangeFeatureRequest = Extract<
  FeatureRequest,
  { readonly type: 'changes.list' | 'changes.detail' | 'changes.markReviewed' }
>

interface ChangeFeatureDependencies {
  readonly changeUseCases: ChangeUseCases
  readonly changeTracker: ChangeSetTracker
  readonly requireBackend: () => DshBackend
  readonly requireCurrentWorkspaceSession: (sessionId: string, signal: AbortSignal) => Promise<SessionDetail>
  readonly featureWorkspaceFolderId: (
    requestedWorkspaceFolderId: string | undefined,
    session: SessionDetail | undefined,
  ) => string
  readonly isOpenWorkspaceFolderId: (workspaceFolderId: string) => boolean
}

export async function handleChangeFeatureRequest(
  request: ChangeFeatureRequest,
  signal: AbortSignal,
  dependencies: ChangeFeatureDependencies,
): Promise<unknown> {
  const {
    changeUseCases,
    changeTracker,
    requireBackend,
    requireCurrentWorkspaceSession,
    featureWorkspaceFolderId,
    isOpenWorkspaceFolderId,
  } = dependencies
  if (request.type === 'changes.list') {
    const session =
      request.payload.sessionId === undefined
        ? undefined
        : await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
    const currentWorkspaceId = featureWorkspaceFolderId(request.payload.workspaceFolderId, session)
    const refreshed =
      session === undefined ||
      (await changeTracker.refreshAuthoritative(requireBackend(), session.id, currentWorkspaceId, signal))
    const changes = await changeUseCases.list(
      {
        workspaceFolderId: currentWorkspaceId,
        ...(request.payload.sessionId === undefined ? {} : { sessionId: request.payload.sessionId }),
        ...(request.payload.status === undefined
          ? {}
          : { status: fromFeatureChangeStatus(request.payload.status) }),
        ...(request.payload.cursor === undefined ? {} : { cursor: request.payload.cursor }),
        ...(request.payload.limit === undefined ? {} : { limit: request.payload.limit }),
      },
      signal,
    )
    return { kind: 'changes', items: changes.map(featureChangeSummary), refreshFailed: !refreshed }
  }
  if (request.type === 'changes.detail') {
    const detail = await changeUseCases.get(request.payload.changeId, signal)
    if (!isOpenWorkspaceFolderId(detail.workspaceFolderId))
      throw new AppError({
        code: 'RESOURCE_NOT_OWNED',
        message: 'The requested change is not owned by this workspace.',
        retryable: false,
      })
    const session = await requireCurrentWorkspaceSession(detail.sessionId, signal)
    featureWorkspaceFolderId(detail.workspaceFolderId, session)
    return {
      kind: 'change.detail',
      change: featureChangeSummary(detail),
      // The diff renders inside a `<pre>`; folding its whitespace would join
      // every hunk into one line.
      ...(detail.redactedDiff === undefined
        ? {}
        : { redactedDiff: redactMultilineText(detail.redactedDiff, 262_144) }),
      truncated: detail.diffTruncated,
    }
  }
  if (request.type === 'changes.markReviewed') {
    const current = await changeUseCases.get(request.payload.changeId, signal)
    if (!isOpenWorkspaceFolderId(current.workspaceFolderId))
      throw new AppError({
        code: 'RESOURCE_NOT_OWNED',
        message: 'The requested change is not owned by this workspace.',
        retryable: false,
      })
    const session = await requireCurrentWorkspaceSession(current.sessionId, signal)
    featureWorkspaceFolderId(current.workspaceFolderId, session)
    const change = await changeUseCases.markReviewed(
      request.payload.changeId,
      fromFeatureReviewState(request.payload.reviewState),
      signal,
    )
    return { kind: 'changes', items: [featureChangeSummary(change)] }
  }
  throw new Error('Unhandled change request')
}

export function featureChangeSummary(
  change: ChangeSetFile,
): Extract<FeatureHostEvent, { readonly name: 'changes.updated' }>['change'] {
  return {
    changeId: change.changeId,
    sessionId: change.sessionId,
    workspaceFolderId: change.workspaceFolderId,
    relativePath: change.relativePath,
    ...(change.previousRelativePath === undefined
      ? {}
      : { previousRelativePath: change.previousRelativePath }),
    status: change.status,
    ...(change.additions === undefined ? {} : { additions: change.additions }),
    ...(change.deletions === undefined ? {} : { deletions: change.deletions }),
    evidence: featureChangeEvidence(change.evidence),
    applicationState: featureChangeApplicationState(change.applicationState),
    reviewState: change.reviewState,
    sourceIds: [...change.sourceIds],
    locations: change.locations.map((location) => ({
      relativePath: location.path,
      ...(location.line === undefined ? {} : { line: location.line }),
    })),
    firstSeenAt: change.firstSeenAt,
    lastSeenAt: change.lastSeenAt,
    identity: change.identity,
    diffAvailable: change.diffAvailable,
  }
}

function featureChangeEvidence(
  evidence: ChangeSetFile['evidence'],
): Extract<FeatureHostEvent, { readonly name: 'changes.updated' }>['change']['evidence'] {
  switch (evidence) {
    case 'structuredProposal':
      return 'structured-proposal'
    case 'structuredToolSuccess':
      return 'structured-tool-success'
    case 'filesystemObserved':
      return 'filesystem-observed'
    case 'structuredLocationOnly':
      return 'structured-location-only'
    case 'failed':
      return 'failed'
    case 'incomplete':
      return 'incomplete'
  }
}

function featureChangeApplicationState(
  state: ChangeSetFile['applicationState'],
): Extract<FeatureHostEvent, { readonly name: 'changes.updated' }>['change']['applicationState'] {
  switch (state) {
    case 'proposed':
      return 'proposed'
    case 'appliedObserved':
      return 'applied-observed'
    case 'failed':
      return 'failed'
    case 'unknown':
      return 'unknown'
  }
}

function fromFeatureChangeStatus(
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown',
): ChangeSetFile['status'] {
  return status
}

function fromFeatureReviewState(
  state: 'viewed' | 'accepted' | 'rejected' | 'needs-attention',
): ChangeSetFile['reviewState'] {
  return state
}
