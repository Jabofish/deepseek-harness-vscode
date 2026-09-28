import type * as vscode from 'vscode'
import {
  AppError,
  type EditorContextOwner,
  type SessionDetail,
  type SessionSummary,
} from '@dsh-vscode/domain'
import type { BackendService } from '@dsh-vscode/application'
import { workspaceFolderId } from '../editor/workspace-path-guard.js'

export interface FeatureContextDependencies {
  readonly backendService: BackendService
  readonly featureOwner: () => EditorContextOwner
  readonly currentWorkspaceFolders: () => readonly vscode.WorkspaceFolder[]
  readonly workspaceFolderIdForSession: (session: Pick<SessionSummary, 'cwd'>) => string | undefined
  readonly currentWorkspaceFolderId: (this: void) => string | undefined
}

export interface FeatureContext {
  readonly featureContextOwner: (workspaceFolderIdValue?: string) => EditorContextOwner
  readonly currentFeatureSessionBinding: (sessionId: string) => {
    readonly sessionId: string
    readonly backendInstanceId: string
    readonly connectionGeneration: number
  }
  readonly contextOwnerForSession: (
    session: SessionDetail,
    requestedWorkspaceFolderId: string | undefined,
    hasContext: boolean,
  ) => EditorContextOwner
  readonly featureWorkspaceFolderId: (
    requestedWorkspaceFolderId: string | undefined,
    session: SessionDetail | undefined,
  ) => string
}

/**
 * Workspace-folder ownership checks for feature routes: every staged feature
 * resolves the folder it may touch from the open VS Code workspace and refuses
 * cross-folder access instead of trusting the Webview's request.
 */
export function createFeatureContext(deps: FeatureContextDependencies): FeatureContext {
  const {
    backendService,
    featureOwner,
    currentWorkspaceFolders,
    workspaceFolderIdForSession,
    currentWorkspaceFolderId,
  } = deps
  const featureContextOwner = (workspaceFolderIdValue?: string): EditorContextOwner => {
    if (
      workspaceFolderIdValue !== undefined &&
      !currentWorkspaceFolders().some((folder) => workspaceFolderId(folder) === workspaceFolderIdValue)
    )
      throw new AppError({
        code: 'RESOURCE_NOT_OWNED',
        message: 'The requested editor context workspace is not open in VS Code.',
        retryable: false,
      })
    return {
      ...featureOwner(),
      ...(workspaceFolderIdValue === undefined ? {} : { workspaceFolderId: workspaceFolderIdValue }),
    }
  }
  const currentFeatureSessionBinding = (
    sessionId: string,
  ): {
    readonly sessionId: string
    readonly backendInstanceId: string
    readonly connectionGeneration: number
  } => {
    const connection = backendService.requireBackend().connection
    if (connection.backendInstanceId === undefined || connection.connectionGeneration === undefined)
      throw new AppError({
        code: 'GENERATION_MISMATCH',
        message: 'The DSH connection identity is not ready for editor context resolution.',
        retryable: true,
      })
    return {
      sessionId,
      backendInstanceId: connection.backendInstanceId,
      connectionGeneration: connection.connectionGeneration,
    }
  }
  const contextOwnerForSession = (
    session: SessionDetail,
    requestedWorkspaceFolderId: string | undefined,
    hasContext: boolean,
  ): EditorContextOwner => {
    if (!hasContext) return featureContextOwner()
    const sessionWorkspaceFolderId = workspaceFolderIdForSession(session)
    if (
      requestedWorkspaceFolderId !== undefined &&
      sessionWorkspaceFolderId !== undefined &&
      requestedWorkspaceFolderId !== sessionWorkspaceFolderId
    )
      throw new AppError({
        code: 'RESOURCE_NOT_OWNED',
        message: 'The editor context belongs to a different workspace folder than this session.',
        retryable: false,
      })
    const resolvedWorkspaceFolderId = requestedWorkspaceFolderId ?? sessionWorkspaceFolderId
    if (resolvedWorkspaceFolderId === undefined)
      throw new AppError({
        code: 'RESOURCE_NOT_OWNED',
        message: 'The session workspace folder could not be resolved safely.',
        retryable: false,
      })
    if (!currentWorkspaceFolders().some((folder) => workspaceFolderId(folder) === resolvedWorkspaceFolderId))
      throw new AppError({
        code: 'RESOURCE_NOT_OWNED',
        message: 'The requested editor context workspace is not open in VS Code.',
        retryable: false,
      })
    return featureContextOwner(resolvedWorkspaceFolderId)
  }
  const featureWorkspaceFolderId = (
    requestedWorkspaceFolderId: string | undefined,
    session: SessionDetail | undefined,
  ): string => {
    const sessionWorkspaceFolderId = session === undefined ? undefined : workspaceFolderIdForSession(session)
    if (
      requestedWorkspaceFolderId !== undefined &&
      sessionWorkspaceFolderId !== undefined &&
      requestedWorkspaceFolderId !== sessionWorkspaceFolderId
    )
      throw new AppError({
        code: 'RESOURCE_NOT_OWNED',
        message: 'The requested feature workspace does not own this session.',
        retryable: false,
      })
    const resolved = requestedWorkspaceFolderId ?? sessionWorkspaceFolderId ?? currentWorkspaceFolderId()
    if (
      resolved === undefined ||
      !currentWorkspaceFolders().some((folder) => workspaceFolderId(folder) === resolved)
    )
      throw new AppError({
        code: 'RESOURCE_NOT_OWNED',
        message: 'The requested feature workspace is not open in VS Code.',
        retryable: false,
      })
    return resolved
  }
  return {
    featureContextOwner,
    currentFeatureSessionBinding,
    contextOwnerForSession,
    featureWorkspaceFolderId,
  }
}
