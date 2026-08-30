import type {
  ChangeDetail,
  ChangeListQuery,
  ChangeRepository,
  ChangeReviewState,
  ChangeSetFile,
  EditorContextCaptureInput,
  EditorContextAvailability,
  EditorContextItem,
  EditorContextOwner,
  EditorContextPreview,
  EditorContextResolveInput,
  EditorContextRange,
  PromptAttachment,
  ResolvedEditorContext,
} from '@dsh-vscode/domain'

export interface EditorContextPort {
  capture(
    input: EditorContextCaptureInput,
    owner: EditorContextOwner,
    signal?: AbortSignal,
  ): Promise<EditorContextItem>
  list(owner: EditorContextOwner, signal?: AbortSignal): Promise<readonly EditorContextItem[]>
  availability(owner: EditorContextOwner, signal?: AbortSignal): Promise<EditorContextAvailability>
  preview(contextRef: string, owner: EditorContextOwner, signal?: AbortSignal): Promise<EditorContextPreview>
  release(contextRefs: readonly string[], owner: EditorContextOwner, signal?: AbortSignal): Promise<void>
  resolveForPrompt(
    input: EditorContextResolveInput,
    signal?: AbortSignal,
  ): Promise<readonly ResolvedEditorContext[]>
}

export interface NavigationPort {
  openFile(
    workspaceFolderId: string,
    relativePath: string,
    range?: EditorContextRange,
    signal?: AbortSignal,
    preserveFocus?: boolean,
  ): Promise<void>
  revealLine(
    workspaceFolderId: string,
    relativePath: string,
    line: number,
    column?: number,
    signal?: AbortSignal,
  ): Promise<void>
  showInExplorer(workspaceFolderId: string, relativePath: string, signal?: AbortSignal): Promise<void>
  openDiff(
    workspaceFolderId: string,
    relativePath: string,
    before: string,
    after?: string,
    signal?: AbortSignal,
  ): Promise<void>
}

export type ChangePort = ChangeRepository

export interface ChangeUseCasePort {
  list(query?: ChangeListQuery, signal?: AbortSignal): Promise<readonly ChangeSetFile[]>
  get(changeId: string, signal?: AbortSignal): Promise<ChangeDetail>
  markReviewed(changeId: string, reviewState: ChangeReviewState, signal?: AbortSignal): Promise<ChangeSetFile>
}

export type FeatureContextAttachment = Pick<PromptAttachment, 'uri' | 'name' | 'mimeType'>
