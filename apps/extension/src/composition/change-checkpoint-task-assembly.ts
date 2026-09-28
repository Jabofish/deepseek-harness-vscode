import * as vscode from 'vscode'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type {
  ChangeSetFile,
  CheckpointSummary,
  DshBackend,
  SessionSummary,
  TaskListScope,
  TaskSummary,
} from '@dsh-vscode/domain'
import type { BackendService } from '@dsh-vscode/application'
import {
  ChangeUseCases,
  CheckpointUseCases,
  PromptTemplateUseCases,
  TaskUseCases,
} from '@dsh-vscode/application'
import { WorkspacePathGuard, workspaceFolderId, type ResolvedWorkspacePath } from '../editor/workspace-path-guard.js'
import { ChangeSetTracker } from '../changes/change-set-tracker.js'
import { featureChangeSummary } from '../changes/change-feature-handler.js'
import { CheckpointStore } from '../checkpoints/checkpoint-store.js'
import { featureCheckpointSummary } from '../checkpoints/checkpoint-feature-handler.js'
import {
  createVscodeCheckpointStorage,
  createVscodeCheckpointWorkspace,
} from '../checkpoints/vscode-checkpoint-adapter.js'
import { TaskCenterRegistry } from '../tasks/task-center-registry.js'
import { featureTaskSummary } from '../tasks/task-feature-handler.js'
import { PromptTemplateStore } from '../prompts/prompt-template-store.js'
import {
  createVscodePromptTemplateStorage,
  createVscodeWorkspacePromptTemplateStorage,
} from '../prompts/vscode-prompt-template-adapter.js'
import { publicWorkspaceRelativePath } from '../view/public-value.js'
import type { RedactedDiagnostics } from '../backend/diagnostics.js'
import { isMissingFileError } from './runtime.js'
import type { PostHostMessage } from './host-event-pipeline.js'

/**
 * Read/write access to the task-center focus (selected session and list scope)
 * shared between the registry callbacks and the feature/backend-attach flows.
 */
export interface TaskFocusState {
  getSessionId(this: void): string | undefined
  setSessionId(this: void, sessionId: string | undefined): void
  clearSessionId(this: void): void
  getScope(this: void): TaskListScope
  setScope(this: void, scope: TaskListScope): void
}

export interface ChangeCheckpointTaskDependencies {
  readonly context: vscode.ExtensionContext
  readonly diagnostics: RedactedDiagnostics
  readonly post: PostHostMessage
  readonly backendService: BackendService
  readonly nextFeatureLocalSequence: (this: void) => number
  readonly workspaceFolderIdForSession: (session: Pick<SessionSummary, 'cwd'>) => string | undefined
  readonly currentWorkspaceFolders: () => readonly vscode.WorkspaceFolder[]
  readonly currentWorkspaceFolderId: (this: void) => string | undefined
}

export interface ChangeCheckpointTaskAssembly {
  readonly changeTracker: ChangeSetTracker
  readonly changeUseCases: ChangeUseCases
  readonly checkpointUseCases: CheckpointUseCases
  readonly promptTemplateUseCases: PromptTemplateUseCases
  readonly taskRegistry: TaskCenterRegistry
  readonly taskUseCases: TaskUseCases
  readonly taskFocus: TaskFocusState
  readonly postCheckpointFeatureEvent: (checkpoint: CheckpointSummary) => Promise<boolean>
}

/** The change-set, checkpoint, prompt-template and task-center subsystems. */
export function createChangeCheckpointTaskAssembly(
  deps: ChangeCheckpointTaskDependencies,
): ChangeCheckpointTaskAssembly {
  const {
    context,
    diagnostics,
    post,
    backendService,
    nextFeatureLocalSequence,
    workspaceFolderIdForSession,
    currentWorkspaceFolders,
    currentWorkspaceFolderId,
  } = deps
  const changePathGuard = new WorkspacePathGuard(vscode.workspace)
  const postChangeFeatureEvent = (
    change: ChangeSetFile | { readonly sessionId: string },
  ): Promise<boolean> => {
    let connection: DshBackend['connection']
    try {
      connection = backendService.requireBackend().connection
    } catch {
      return Promise.resolve(false)
    }
    if (connection.backendInstanceId === undefined || connection.connectionGeneration === undefined)
      return Promise.resolve(false)
    const localSeq = nextFeatureLocalSequence()
    return Promise.resolve(
      post({
        type: 'feature.event',
        identity: {
          backendInstanceId: connection.backendInstanceId,
          connectionGeneration: connection.connectionGeneration,
          stream: 'local',
          sessionId: change.sessionId,
          localSeq,
        },
        ...('changeId' in change
          ? { name: 'changes.updated' as const, change: featureChangeSummary(change) }
          : { name: 'changes.invalidated' as const, sessionId: change.sessionId }),
      }),
    )
  }
  const changeTracker = new ChangeSetTracker({
    onInvalidate: (sessionId) => {
      void postChangeFeatureEvent({ sessionId })
    },
    resolveSessionWorkspaceFolderId: async (backend, sessionId) =>
      workspaceFolderIdForSession(await backend.sessions.get(sessionId)),
    // The host states every change path as an absolute host path, while the
    // review keys a change by its workspace-relative path. Fit it here, where
    // the folder that owns the workspace id is still known.
    toWorkspaceRelativePath: (workspaceId, hostPath) => {
      const folder = currentWorkspaceFolders().find(
        (candidate) => workspaceFolderId(candidate) === workspaceId,
      )
      if (folder === undefined) return undefined
      return publicWorkspaceRelativePath(hostPath, folder.uri.fsPath, [folder.uri.fsPath])
    },
    observeChangePath: async (workspaceId, relativePath) => {
      let resolved: ResolvedWorkspacePath
      try {
        resolved = changePathGuard.resolve(workspaceId, relativePath)
      } catch {
        return undefined
      }
      // A missing path is the verified post-state of a deletion. Every other
      // stat failure (permissions, unreachable share, symlink) stays unknown.
      let fileStat: vscode.FileStat | undefined
      try {
        fileStat = await vscode.workspace.fs.stat(resolved.uri)
      } catch (error) {
        if (!isMissingFileError(error)) return undefined
      }
      if (fileStat === undefined) return { kind: 'absent' }
      if (
        (fileStat.type & vscode.FileType.File) === 0 ||
        (fileStat.type & vscode.FileType.SymbolicLink) !== 0
      )
        return undefined
      if (fileStat.size > 16 * 1024 * 1024) return undefined
      const bytes = await vscode.workspace.fs.readFile(resolved.uri)
      return { kind: 'hash', hash: createHash('sha256').update(bytes).digest('hex') }
    },
    onChange: (change) => {
      void postChangeFeatureEvent(change)
    },
  })
  const changeUseCases = new ChangeUseCases(changeTracker)
  const checkpointStore = new CheckpointStore({
    rootPath: path.join(context.globalStorageUri.fsPath, 'dsh-checkpoints'),
    storage: createVscodeCheckpointStorage(vscode.workspace),
    workspace: createVscodeCheckpointWorkspace(vscode.workspace),
    enabled: () => vscode.workspace.getConfiguration('dsh.checkpoints').get<boolean>('enabled', false),
    contentEnabled: () =>
      vscode.workspace.getConfiguration('dsh.checkpoints').get<boolean>('storeContent', false),
    workspaceTrusted: () => vscode.workspace.isTrusted,
    // An unusable checkpoint directory is skipped, so the only evidence a user
    // can get is this line; the directory path itself stays out of the log.
    onStorageIssue: (issue) =>
      diagnostics.log('warn', 'checkpoint-storage-unreadable', {
        code: 'STORAGE_CORRUPT',
        phase: issue.phase,
      }),
  })
  const checkpointUseCases = new CheckpointUseCases(checkpointStore)
  const promptTemplateStore = new PromptTemplateStore({
    global: createVscodePromptTemplateStorage(
      path.join(context.globalStorageUri.fsPath, 'dsh-prompt-templates'),
      vscode.workspace,
    ),
    workspace: (workspaceId) => createVscodeWorkspacePromptTemplateStorage(workspaceId, vscode.workspace),
    enabled: () => vscode.workspace.getConfiguration('dsh.promptTemplates').get<boolean>('enabled', true),
    workspaceTrusted: () => vscode.workspace.isTrusted,
  })
  const promptTemplateUseCases = new PromptTemplateUseCases(promptTemplateStore)
  let taskSessionId: string | undefined
  let taskListScope: TaskListScope = 'current-session'
  const taskFocus: TaskFocusState = {
    getSessionId: () => taskSessionId,
    setSessionId: (sessionId) => {
      taskSessionId = sessionId
    },
    clearSessionId: () => {
      taskSessionId = undefined
    },
    getScope: () => taskListScope,
    setScope: (scope) => {
      taskListScope = scope
    },
  }
  const postTaskFeatureEvent = (task: TaskSummary): Promise<boolean> => {
    let connection: DshBackend['connection']
    try {
      connection = backendService.requireBackend().connection
    } catch {
      return Promise.resolve(false)
    }
    if (connection.backendInstanceId === undefined || connection.connectionGeneration === undefined)
      return Promise.resolve(false)
    const localSeq = nextFeatureLocalSequence()
    return Promise.resolve(
      post({
        type: 'feature.event',
        name: 'tasks.updated',
        identity: {
          backendInstanceId: connection.backendInstanceId,
          connectionGeneration: connection.connectionGeneration,
          stream: 'local',
          ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
          localSeq,
        },
        task: featureTaskSummary(task),
      }),
    )
  }
  const postCheckpointFeatureEvent = (checkpoint: CheckpointSummary): Promise<boolean> => {
    let connection: DshBackend['connection']
    try {
      connection = backendService.requireBackend().connection
    } catch {
      return Promise.resolve(false)
    }
    if (connection.backendInstanceId === undefined || connection.connectionGeneration === undefined)
      return Promise.resolve(false)
    const localSeq = nextFeatureLocalSequence()
    return Promise.resolve(
      post({
        type: 'feature.event',
        name: 'checkpoint.updated',
        identity: {
          backendInstanceId: connection.backendInstanceId,
          connectionGeneration: connection.connectionGeneration,
          stream: 'local',
          sessionId: checkpoint.sessionId,
          localSeq,
        },
        checkpoint: featureCheckpointSummary(checkpoint),
      }),
    )
  }
  const taskRegistry = new TaskCenterRegistry({
    resolveSessionWorkspaceFolderId: (session) =>
      session.cwd === undefined ? undefined : workspaceFolderIdForSession(session),
    workspaceFolderIds: () => currentWorkspaceFolders().map((folder) => workspaceFolderId(folder)),
    isWorkspaceFolderOpen: (workspaceId) =>
      currentWorkspaceFolders().some((folder) => workspaceFolderId(folder) === workspaceId),
    onChange: (sessionId) => {
      if (taskListScope === 'workspace') {
        void taskRegistry
          .listSnapshot({ scope: 'workspace', includeCompleted: true, limit: 200 })
          .then((snapshot) => Promise.all(snapshot.items.map((task) => postTaskFeatureEvent(task))))
          .catch(() => undefined)
        return
      }
      if (taskSessionId !== sessionId) return
      const workspaceId = currentWorkspaceFolderId()
      if (workspaceId === undefined) return
      void taskRegistry
        .listSnapshot({ sessionId, workspaceFolderId: workspaceId, includeCompleted: true, limit: 200 })
        .then((snapshot) => Promise.all(snapshot.items.map((task) => postTaskFeatureEvent(task))))
        .catch(() => undefined)
    },
  })
  const taskUseCases = new TaskUseCases(taskRegistry)
  return {
    changeTracker,
    changeUseCases,
    checkpointUseCases,
    promptTemplateUseCases,
    taskRegistry,
    taskUseCases,
    taskFocus,
    postCheckpointFeatureEvent,
  }
}
