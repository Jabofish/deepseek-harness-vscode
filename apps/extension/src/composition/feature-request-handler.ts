import * as vscode from 'vscode'
import {
  AppError,
  type CheckpointSummary,
  type EditorContextOwner,
  type SessionDetail,
} from '@dsh-vscode/domain'
import type {
  BackendService,
  ChangeUseCases,
  CheckpointUseCases,
  EditorContextUseCases,
  NavigationUseCases,
  PromptTemplateUseCases,
  TaskUseCases,
} from '@dsh-vscode/application'
import { PluginBundleUseCases, ScheduleUseCases } from '@dsh-vscode/application'
import { redactMultilineText } from '@dsh-vscode/dsh-adapter'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import { handleAccountFeatureRequest } from '../account/account-feature-handler.js'
import type { AccountLifecycleHost } from '../account/account-lifecycle-host.js'
import {
  handlePluginBundleFeatureRequest,
  type PluginInstallRequestCoordinator,
} from '../plugins/plugin-bundle-feature-handler.js'
import {
  createPluginBundleEnableConfirmation,
  createPluginEntryEnableConfirmation,
} from '../plugins/confirm-plugin-bundle-enable.js'
import {
  createPluginBuildApprovalConfirmation,
  createPluginInstallConfirmation,
  createPluginRemoveConfirmation,
} from '../plugins/plugin-manager-confirmations.js'
import { handleScheduleFeatureRequest } from '../schedules/schedule-feature-handler.js'
import { handleCheckpointFeatureRequest } from '../checkpoints/checkpoint-feature-handler.js'
import { handleTaskFeatureRequest } from '../tasks/task-feature-handler.js'
import { handlePromptTemplateFeatureRequest } from '../prompts/prompt-template-feature-handler.js'
import { handleChangeFeatureRequest } from '../changes/change-feature-handler.js'
import type { ChangeSetTracker } from '../changes/change-set-tracker.js'
import type { TaskCenterRegistry } from '../tasks/task-center-registry.js'
import { workspaceFolderId } from '../editor/workspace-path-guard.js'
import { featureContextItem, featureContextKinds } from './editor-files.js'
import type { SessionScope } from './session-scope.js'
import type { PostFeatureEvent } from './host-event-pipeline.js'
import type { TaskFocusState } from './change-checkpoint-task-assembly.js'

export interface FeatureRequestHandlerDependencies {
  readonly getAccountLifecycleHost: () => AccountLifecycleHost | undefined
  readonly backendService: BackendService
  readonly pluginInstallRequests: PluginInstallRequestCoordinator
  readonly listCurrentWorkspaces: SessionScope['listCurrentWorkspaces']
  readonly requireCurrentWorkspaceSession: SessionScope['requireCurrentWorkspaceSession']
  readonly featureContextOwner: (workspaceFolderIdValue?: string) => EditorContextOwner
  readonly editorContextUseCases: EditorContextUseCases
  readonly postFeatureEvent: PostFeatureEvent
  readonly postEditorContextAvailabilityEvent: () => Promise<void>
  readonly navigationUseCases: NavigationUseCases
  readonly changeUseCases: ChangeUseCases
  readonly changeTracker: ChangeSetTracker
  readonly checkpointUseCases: CheckpointUseCases
  readonly featureWorkspaceFolderId: (
    requestedWorkspaceFolderId: string | undefined,
    session: SessionDetail | undefined,
  ) => string
  readonly postCheckpointFeatureEvent: (checkpoint: CheckpointSummary) => Promise<boolean>
  readonly taskUseCases: TaskUseCases
  readonly taskRegistry: TaskCenterRegistry
  readonly taskFocus: TaskFocusState
  readonly promptTemplateUseCases: PromptTemplateUseCases
  readonly currentWorkspaceFolders: () => readonly vscode.WorkspaceFolder[]
}

export interface FeatureRequestHandler {
  readonly handleFeatureRequest: (request: FeatureRequest, signal: AbortSignal) => Promise<unknown>
}

/** Dispatch every staged feature route (account, plugins, schedules, editor
 * context, navigation, checkpoints, tasks, prompt templates, changes). */
export function createFeatureRequestHandler(deps: FeatureRequestHandlerDependencies): FeatureRequestHandler {
  const {
    getAccountLifecycleHost,
    backendService,
    pluginInstallRequests,
    listCurrentWorkspaces,
    requireCurrentWorkspaceSession,
    featureContextOwner,
    editorContextUseCases,
    postFeatureEvent,
    postEditorContextAvailabilityEvent,
    navigationUseCases,
    changeUseCases,
    changeTracker,
    checkpointUseCases,
    featureWorkspaceFolderId,
    postCheckpointFeatureEvent,
    taskUseCases,
    taskRegistry,
    taskFocus,
    promptTemplateUseCases,
    currentWorkspaceFolders,
  } = deps
  const handleFeatureRequest = async (request: FeatureRequest, signal: AbortSignal): Promise<unknown> => {
    if (
      request.type === 'account.state' ||
      request.type === 'account.signIn' ||
      request.type === 'account.cancelSignIn' ||
      request.type === 'account.signOutImpact' ||
      request.type === 'account.signOut' ||
      request.type === 'account.details.read' ||
      request.type === 'account.bonus.ack' ||
      request.type === 'account.page.open'
    ) {
      return handleAccountFeatureRequest(request, getAccountLifecycleHost(), signal)
    }
    if (
      request.type === 'plugin.bundles.list' ||
      request.type === 'plugin.registries.list' ||
      request.type === 'plugin.spec.inspect' ||
      request.type === 'plugin.bundle.install' ||
      request.type === 'plugin.bundle.cancelInstall' ||
      request.type === 'plugin.bundle.waitForInstall' ||
      request.type === 'plugin.bundle.setEnabled' ||
      request.type === 'plugin.bundle.remove' ||
      request.type === 'plugin.entry.setEnabled'
    ) {
      const backend = backendService.requireBackend()
      const bundles = new PluginBundleUseCases(backend)
      const present = (
        message: string,
        options: { readonly modal: true; readonly detail: string },
        confirmLabel: string,
      ): Thenable<string | undefined> => vscode.window.showWarningMessage(message, options, confirmLabel)
      const translate = (message: string, detail?: string): string =>
        detail === undefined ? vscode.l10n.t(message) : vscode.l10n.t(message, detail)
      const confirmEnable = createPluginBundleEnableConfirmation(present, translate, vscode.env.language)
      const confirmPluginEntryEnable = createPluginEntryEnableConfirmation(
        present,
        translate,
        vscode.env.language,
      )
      return handlePluginBundleFeatureRequest(
        request,
        bundles,
        signal,
        {
          enable: confirmEnable,
          pluginEntryEnable: confirmPluginEntryEnable,
          install: createPluginInstallConfirmation(present, translate),
          remove: createPluginRemoveConfirmation(present, translate),
          builds: createPluginBuildApprovalConfirmation(present, translate),
        },
        pluginInstallRequests,
      )
    }
    if (
      request.type === 'schedule.catalog' ||
      request.type === 'schedule.list' ||
      request.type === 'schedule.history' ||
      request.type === 'schedule.update' ||
      request.type === 'schedule.delete'
    ) {
      const backend = backendService.requireBackend()
      if (backend.schedules === undefined)
        throw new AppError({
          code: 'CAPABILITY_UNAVAILABLE',
          message: 'The connected DSH version does not expose scheduled tasks.',
          retryable: false,
        })
      const schedules = new ScheduleUseCases(backend.schedules)
      if (request.type === 'schedule.catalog') {
        const [items, workspaces] = await Promise.all([
          schedules.catalog(signal),
          listCurrentWorkspaces(signal),
        ])
        const currentWorkspaceSessionIds = new Set(
          workspaces.flatMap((workspace) => workspace.sessionIds ?? []),
        )
        return {
          kind: 'schedule.catalog',
          items: items.filter((item) => currentWorkspaceSessionIds.has(item.sessionId)),
        }
      }
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal, { allowArchived: true })
      return handleScheduleFeatureRequest(request, schedules, signal)
    }
    if (request.type === 'editor.context.capture') {
      const owner = featureContextOwner(request.payload.workspaceFolderId)
      const item = await editorContextUseCases.capture(
        {
          kind: request.payload.kind === 'open-document' ? 'file' : request.payload.kind,
          ...(request.payload.workspaceFolderId === undefined
            ? {}
            : { workspaceFolderId: request.payload.workspaceFolderId }),
        },
        owner,
        signal,
      )
      void postFeatureEvent('editor.context.changed', { contextRef: item.ref.contextRef, action: 'added' })
      return {
        kind: 'editor.context',
        items: [featureContextItem(item)],
        availableKinds: featureContextKinds(await editorContextUseCases.availability(owner, signal)),
      }
    }
    if (request.type === 'editor.context.list') {
      const owner = featureContextOwner(request.payload.workspaceFolderId)
      const [items, availability] = await Promise.all([
        editorContextUseCases.list(owner, signal),
        editorContextUseCases.availability(owner, signal),
      ])
      return {
        kind: 'editor.context',
        items: items.map(featureContextItem),
        availableKinds: featureContextKinds(availability),
      }
    }
    if (request.type === 'editor.context.preview') {
      const preview = await editorContextUseCases.preview(
        request.payload.contextRef,
        featureContextOwner(request.payload.workspaceFolderId),
        signal,
      )
      return {
        kind: 'editor.preview',
        contextRef: preview.contextRef,
        // The preview renders inside a `<pre>`: its line breaks and indentation
        // are the content, so only credentials are replaced.
        redactedPreviewText: redactMultilineText(preview.text, 32_768),
        language: 'plaintext',
        truncated: preview.truncated,
        expiresAt: preview.expiresAt,
      }
    }
    if (request.type === 'editor.context.release') {
      const owner = featureContextOwner(request.payload.workspaceFolderId)
      await editorContextUseCases.release(request.payload.contextRefs, owner, signal)
      for (const contextRef of request.payload.contextRefs)
        void postFeatureEvent('editor.context.changed', { contextRef, action: 'released' })
      void postEditorContextAvailabilityEvent()
      return { kind: 'empty' }
    }
    if (request.type === 'navigation.open') {
      await navigationUseCases.openFile(
        request.payload.workspaceFolderId,
        request.payload.relativePath,
        request.payload.range,
        signal,
        request.payload.reveal === 'preserve-focus',
      )
      return { kind: 'operation', operationId: request.requestId, state: 'completed' }
    }
    if (
      request.type === 'checkpoint.create' ||
      request.type === 'checkpoint.list' ||
      request.type === 'checkpoint.preview' ||
      request.type === 'checkpoint.delete' ||
      request.type === 'checkpoint.restore'
    )
      return handleCheckpointFeatureRequest(request, signal, {
        changeUseCases,
        checkpointUseCases,
        requireCurrentWorkspaceSession,
        featureWorkspaceFolderId,
        postCheckpointFeatureEvent,
      })
    if (
      request.type === 'tasks.list' ||
      request.type === 'tasks.open' ||
      request.type === 'tasks.stop' ||
      request.type === 'tasks.answer'
    )
      return handleTaskFeatureRequest(request, signal, {
        taskUseCases,
        requireCurrentWorkspaceSession,
        featureWorkspaceFolderId,
        isOpenWorkspaceFolderId: (id) =>
          currentWorkspaceFolders().some((folder) => workspaceFolderId(folder) === id),
        hasWorkspaceFolders: () => currentWorkspaceFolders().length > 0,
        getTaskSessionId: () => taskFocus.getSessionId(),
        setTaskSessionId: (id) => {
          taskFocus.setSessionId(id)
          taskRegistry.setCurrentSession(id)
        },
        setTaskListScope: (scope) => {
          taskFocus.setScope(scope)
        },
      })
    if (
      request.type === 'prompt.template.list' ||
      request.type === 'prompt.template.read' ||
      request.type === 'prompt.template.insert' ||
      request.type === 'prompt.template.create' ||
      request.type === 'prompt.template.update' ||
      request.type === 'prompt.template.delete'
    )
      return handlePromptTemplateFeatureRequest(request, signal, {
        promptTemplateUseCases,
        requireCurrentWorkspaceSession,
        featureWorkspaceFolderId,
      })
    if (
      request.type === 'changes.list' ||
      request.type === 'changes.detail' ||
      request.type === 'changes.markReviewed'
    )
      return handleChangeFeatureRequest(request, signal, {
        changeUseCases,
        changeTracker,
        requireBackend: () => backendService.requireBackend(),
        requireCurrentWorkspaceSession,
        featureWorkspaceFolderId,
        isOpenWorkspaceFolderId: (id) =>
          currentWorkspaceFolders().some((folder) => workspaceFolderId(folder) === id),
      })
    throw new AppError({
      code: 'FEATURE_DISABLED',
      message: `The staged feature route ${request.type} is not enabled yet.`,
      retryable: false,
    })
  }
  return { handleFeatureRequest }
}
