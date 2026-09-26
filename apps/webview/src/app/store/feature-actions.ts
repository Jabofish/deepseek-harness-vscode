import type { EditorContextItem, PromptTemplateScope, TaskListScope } from '@dsh-vscode/domain'
import type { FeatureHostEvent } from '@dsh-vscode/webview-protocol'
import { translate } from '../../i18n.js'
import type { ProtocolClient } from '../protocol-client.js'
import {
  mergeEditorContext,
  parseEditorContextAvailableKinds,
  parseEditorContextItems,
  promptTemplateVariables,
} from './editor-context.js'
import {
  mergeTask,
  parseFeatureChangeDetail,
  parseFeatureChangesResult,
  parseFeatureCheckpointPreviewResult,
  parseFeatureCheckpointsResult,
  parseFeatureOperationResult,
  parseFeaturePromptTemplateInsertionResult,
  parseFeaturePromptTemplateResult,
  parseFeaturePromptTemplatesResult,
  parseFeatureTasksResult,
} from './feature-parsers.js'
import { requestId } from './ids.js'
import type { AppActions, AppState, StateSetter } from './types.js'
import { object } from './unknown-record.js'

export interface FeatureActionHost {
  readonly client: ProtocolClient
  readonly getState: () => AppState
  readonly setState: StateSetter
  /** The VS Code folder the Host resolved for a session; path-scoped routes require it. */
  readonly sessionWorkspaceFolderId: (sessionId: string) => string | undefined
}

export type FeatureActionMethods = Pick<
  AppActions,
  | 'captureEditorContext'
  | 'refreshEditorContext'
  | 'previewEditorContext'
  | 'releaseEditorContext'
  | 'refreshChanges'
  | 'getChangeDetail'
  | 'markChangeReviewed'
  | 'openChange'
  | 'refreshTasks'
  | 'getTask'
  | 'stopTask'
  | 'answerTask'
  | 'refreshCheckpoints'
  | 'createCheckpoint'
  | 'previewCheckpoint'
  | 'deleteCheckpoint'
  | 'restoreCheckpoint'
  | 'refreshPromptTemplates'
  | 'readPromptTemplate'
  | 'insertPromptTemplate'
  | 'createPromptTemplate'
  | 'updatePromptTemplate'
  | 'deletePromptTemplate'
>

export interface FeatureActions {
  readonly methods: FeatureActionMethods
  /** Answer one folder/session-scoped feature event; false when it is not this group's traffic. */
  readonly applyFeatureEvent: (message: FeatureHostEvent) => boolean
  /** Re-read every session-scoped surface after a session or subagent becomes visible. */
  readonly refreshSessionScopedStates: (sessionId: string) => void
  /** Re-read the editor-context strip for the folder that guards the opened session. */
  readonly refreshEditorContextForOpen: (workspaceFolderId: string | undefined) => void
  /** Retire the in-flight reads of every surface that is about to be re-based on a new session. */
  readonly retireForSessionSwitch: () => void
  /** Retire the prompt-template read a subagent open supersedes. */
  readonly retirePromptTemplatesForSubagentSwitch: () => void
  readonly discardEditorContextForSessionSwitch: (nextSessionId: string) => Promise<void>
  readonly discardEditorContextForWorkspaceChange: () => Promise<void>
}

export function createFeatureActions(host: FeatureActionHost): FeatureActions {
  const client = host.client
  const readState = (): AppState => host.getState()
  const setState = host.setState
  const sessionWorkspaceFolderId = host.sessionWorkspaceFolderId

  let editorContextRefreshGeneration = 0
  let changesRefreshGeneration = 0
  let tasksRefreshGeneration = 0
  let checkpointsRefreshGeneration = 0
  let promptTemplatesRefreshGeneration = 0

  const refreshEditorContextState = async (workspaceFolderId?: string): Promise<void> => {
    if (typeof client.featureRequest !== 'function') return
    const generation = ++editorContextRefreshGeneration
    setState((current) => ({ ...current, editorContextLoading: true }))
    try {
      const result = object(
        await client.featureRequest({
          type: 'editor.context.list',
          requestId: requestId(),
          payload: workspaceFolderId === undefined ? {} : { workspaceFolderId },
        }),
      )
      const items = result?.kind === 'editor.context' ? parseEditorContextItems(result.items) : undefined
      const availableKinds =
        result?.kind === 'editor.context'
          ? parseEditorContextAvailableKinds(result.availableKinds)
          : undefined
      if (
        items !== undefined &&
        availableKinds !== undefined &&
        generation === editorContextRefreshGeneration
      )
        setState((current) => ({
          ...current,
          editorContext: items,
          editorContextAvailableKinds: availableKinds,
        }))
    } finally {
      if (generation === editorContextRefreshGeneration)
        setState((current) => ({ ...current, editorContextLoading: false }))
    }
  }
  const refreshChangesState = async (
    sessionId: string | undefined = readState().activeSessionId,
  ): Promise<void> => {
    if (typeof client.featureRequest !== 'function' || sessionId === undefined) return
    // No folder is open for this session, so there is no workspace scope to
    // read. Report it as nothing to show rather than as a failed refresh.
    const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
    if (workspaceFolderId === undefined) {
      setState((current) =>
        current.activeSessionId === sessionId ? { ...current, changesRefreshFailed: false } : current,
      )
      return
    }
    const generation = ++changesRefreshGeneration
    setState((current) => ({ ...current, changesLoading: true }))
    try {
      const result = await client.featureRequest({
        type: 'changes.list',
        requestId: requestId(),
        payload: { sessionId, workspaceFolderId, limit: 200 },
      })
      const changes = parseFeatureChangesResult(result)
      if (changes !== undefined)
        setState((current) =>
          generation === changesRefreshGeneration && current.activeSessionId === sessionId
            ? {
                ...current,
                changes,
                changesRefreshFailed: (result as { refreshFailed?: boolean }).refreshFailed === true,
              }
            : current,
        )
      else throw new Error('Invalid Changes response')
    } catch {
      setState((current) =>
        generation === changesRefreshGeneration && current.activeSessionId === sessionId
          ? { ...current, changesRefreshFailed: true }
          : current,
      )
    } finally {
      if (generation === changesRefreshGeneration)
        setState((current) => ({ ...current, changesLoading: false }))
    }
  }
  const refreshTasksState = async (
    sessionId: string | undefined = readState().activeSessionId,
    includeCompleted = false,
    scope: TaskListScope = 'current-session',
  ): Promise<void> => {
    const targetSessionId = scope === 'workspace' ? undefined : sessionId
    const expectedActiveSessionId = readState().activeSessionId
    const workspaceFolderId = sessionId === undefined ? undefined : sessionWorkspaceFolderId(sessionId)
    if (
      typeof client.featureRequest !== 'function' ||
      (scope === 'current-session' && targetSessionId === undefined) ||
      // Both task views are rooted in the folder the Host resolved; with no
      // folder open there is no scope to read, so nothing is requested.
      workspaceFolderId === undefined
    )
      return
    const generation = ++tasksRefreshGeneration
    setState((current) => ({ ...current, tasksLoading: true }))
    try {
      const result = await client.featureRequest({
        type: 'tasks.list',
        requestId: requestId(),
        payload: {
          ...(targetSessionId === undefined ? {} : { sessionId: targetSessionId }),
          workspaceFolderId,
          scope,
          includeCompleted,
          limit: 200,
        },
      })
      const snapshot = parseFeatureTasksResult(result)
      if (snapshot !== undefined)
        setState((current) =>
          generation === tasksRefreshGeneration && current.activeSessionId === expectedActiveSessionId
            ? {
                ...current,
                tasks: snapshot.items,
                taskScope: snapshot.scope,
                tasksComplete: snapshot.complete,
                tasksOmittedSessions: snapshot.omittedSessions,
              }
            : current,
        )
    } finally {
      if (generation === tasksRefreshGeneration) setState((current) => ({ ...current, tasksLoading: false }))
    }
  }
  const refreshCheckpointsState = async (
    sessionId: string | undefined = readState().activeSessionId,
  ): Promise<void> => {
    if (typeof client.featureRequest !== 'function' || sessionId === undefined) return
    const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
    if (workspaceFolderId === undefined) return
    const generation = ++checkpointsRefreshGeneration
    setState((current) => ({ ...current, checkpointsLoading: true }))
    try {
      const result = await client.featureRequest({
        type: 'checkpoint.list',
        requestId: requestId(),
        payload: { sessionId, workspaceFolderId },
      })
      const checkpoints = parseFeatureCheckpointsResult(result)
      if (checkpoints === undefined) throw new Error('Invalid checkpoint list')
      if (checkpoints !== undefined)
        setState((current) =>
          generation === checkpointsRefreshGeneration && current.activeSessionId === sessionId
            ? {
                ...current,
                checkpoints,
                unavailableLists: (current.unavailableLists ?? []).filter((key) => key !== 'checkpoints'),
              }
            : current,
        )
    } catch {
      if (generation === checkpointsRefreshGeneration && readState().activeSessionId === sessionId)
        setState((current) => ({
          ...current,
          unavailableLists: [...new Set([...(current.unavailableLists ?? []), 'checkpoints'])],
        }))
    } finally {
      if (generation === checkpointsRefreshGeneration)
        setState((current) => ({ ...current, checkpointsLoading: false }))
    }
  }
  const refreshPromptTemplatesState = async (
    sessionId: string | undefined = readState().activeSessionId,
    scope?: PromptTemplateScope,
  ): Promise<void> => {
    if (typeof client.featureRequest !== 'function' || sessionId === undefined) return
    const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
    if (workspaceFolderId === undefined) return
    const generation = ++promptTemplatesRefreshGeneration
    setState((current) => ({ ...current, promptTemplatesLoading: true }))
    try {
      const result = await client.featureRequest({
        type: 'prompt.template.list',
        requestId: requestId(),
        payload: { sessionId, workspaceFolderId, ...(scope === undefined ? {} : { scope }) },
      })
      const templates = parseFeaturePromptTemplatesResult(result)
      if (templates === undefined) throw new Error('Invalid prompt template list')
      if (templates !== undefined)
        setState((current) =>
          generation === promptTemplatesRefreshGeneration && current.activeSessionId === sessionId
            ? {
                ...current,
                promptTemplates: templates,
                unavailableLists: (current.unavailableLists ?? []).filter((key) => key !== 'templates'),
              }
            : current,
        )
    } catch {
      if (generation === promptTemplatesRefreshGeneration && readState().activeSessionId === sessionId)
        setState((current) => ({
          ...current,
          unavailableLists: [...new Set([...(current.unavailableLists ?? []), 'templates'])],
        }))
    } finally {
      if (generation === promptTemplatesRefreshGeneration)
        setState((current) => ({ ...current, promptTemplatesLoading: false }))
    }
  }
  const releaseEditorContextRefs = async (
    refs: readonly string[],
    items: readonly EditorContextItem[],
  ): Promise<void> => {
    if (typeof client.featureRequest !== 'function') return
    const itemsByRef = new Map(items.map((item) => [item.ref.contextRef, item]))
    const grouped = new Map<string, string[]>()
    for (const contextRef of refs) {
      const item = itemsByRef.get(contextRef)
      if (item === undefined) continue
      const group = grouped.get(item.ref.workspaceFolderId) ?? []
      group.push(contextRef)
      grouped.set(item.ref.workspaceFolderId, group)
    }
    await Promise.all(
      [...grouped].map(([workspaceFolderId, contextRefs]) =>
        client.featureRequest({
          type: 'editor.context.release',
          requestId: requestId(),
          payload: { contextRefs, workspaceFolderId },
        }),
      ),
    )
  }
  const discardEditorContextForSessionSwitch = async (nextSessionId: string): Promise<void> => {
    if (readState().activeSessionId === undefined || readState().activeSessionId === nextSessionId) return
    const refs = readState().editorContext.map((item) => item.ref.contextRef)
    if (refs.length === 0) return
    const items = [...readState().editorContext]
    // Clear the Webview immediately so a slow release cannot leave context
    // chips visually attached to the next session. The Host remains the
    // authority and will reject any stale in-flight resolution by generation
    // or owner/session binding.
    setState((current) => ({
      ...current,
      editorContext: [],
      editorContextAvailableKinds: [],
      editorContextLoading: false,
    }))
    try {
      await releaseEditorContextRefs(refs, items)
    } catch {
      // Expired or already-released handles are harmless during a view switch.
    }
  }
  const discardEditorContextForWorkspaceChange = async (): Promise<void> => {
    editorContextRefreshGeneration += 1
    const refs = readState().editorContext.map((item) => item.ref.contextRef)
    if (refs.length === 0) {
      setState((current) => ({
        ...current,
        editorContext: [],
        editorContextAvailableKinds: [],
        editorContextLoading: false,
      }))
      return
    }
    const items = [...readState().editorContext]
    setState((current) => ({
      ...current,
      editorContext: [],
      editorContextAvailableKinds: [],
      editorContextLoading: false,
    }))
    try {
      await releaseEditorContextRefs(refs, items)
    } catch {
      // Workspace changes dispose the Host handles; stale releases are harmless.
    }
  }
  const methods: FeatureActionMethods = {
    captureEditorContext: async (kind, workspaceFolderId) => {
      if (typeof client.featureRequest !== 'function') throw new Error(translate('app.error.dshMode'))
      const result = object(
        await client.featureRequest<unknown>({
          type: 'editor.context.capture',
          requestId: requestId(),
          payload:
            workspaceFolderId === undefined
              ? { kind: kind === 'file' ? 'open-document' : kind }
              : { kind: kind === 'file' ? 'open-document' : kind, workspaceFolderId },
        }),
      )
      const items = result?.kind === 'editor.context' ? parseEditorContextItems(result.items) : undefined
      if (items === undefined) throw new Error(translate('app.error.dshMode'))
      const availableKinds =
        result?.kind === 'editor.context'
          ? parseEditorContextAvailableKinds(result.availableKinds)
          : undefined
      setState((current) => ({
        ...current,
        editorContext: mergeEditorContext(current.editorContext, items),
        ...(availableKinds === undefined ? {} : { editorContextAvailableKinds: availableKinds }),
      }))
    },
    refreshEditorContext: refreshEditorContextState,
    previewEditorContext: async (contextRef) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const item = readState().editorContext.find((candidate) => candidate.ref.contextRef === contextRef)
      if (item === undefined) return undefined
      const result = object(
        await client.featureRequest<unknown>({
          type: 'editor.context.preview',
          requestId: requestId(),
          payload: { contextRef, workspaceFolderId: item.ref.workspaceFolderId },
        }),
      )
      if (result?.kind !== 'editor.preview' || typeof result.contextRef !== 'string') return undefined
      if (typeof result.redactedPreviewText !== 'string') return undefined
      return {
        contextRef: result.contextRef,
        text: result.redactedPreviewText,
        truncated: result.truncated === true,
        expiresAt: typeof result.expiresAt === 'number' ? result.expiresAt : 0,
      }
    },
    releaseEditorContext: async (contextRefs) => {
      if (contextRefs.length === 0 || typeof client.featureRequest !== 'function') return
      const items = [...readState().editorContext]
      await releaseEditorContextRefs(contextRefs, items)
      const released = new Set(contextRefs)
      setState((current) => ({
        ...current,
        editorContext: current.editorContext.filter((item) => !released.has(item.ref.contextRef)),
      }))
    },
    refreshChanges: refreshChangesState,
    getChangeDetail: async (changeId) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const result = await client.featureRequest<unknown>({
        type: 'changes.detail',
        requestId: requestId(),
        payload: { changeId },
      })
      return parseFeatureChangeDetail(result)
    },
    markChangeReviewed: async (changeId, reviewState) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const result = await client.featureRequest<unknown>({
        type: 'changes.markReviewed',
        requestId: requestId(),
        payload: { changeId, reviewState: reviewState === 'unreviewed' ? 'viewed' : reviewState },
      })
      const changes = parseFeatureChangesResult(result)
      const change = changes?.[0]
      if (change !== undefined)
        setState((current) => ({
          ...current,
          changes: current.changes.map((entry) => (entry.changeId === change.changeId ? change : entry)),
        }))
      return change
    },
    openChange: async (changeId) => {
      if (typeof client.featureRequest !== 'function') return
      const change = readState().changes.find((entry) => entry.changeId === changeId)
      if (change === undefined) return
      const location =
        change.locations.find(
          (candidate) => candidate.path === change.relativePath && candidate.line !== undefined,
        ) ?? change.locations.find((candidate) => candidate.path === change.relativePath)
      await client.featureRequest<unknown>({
        type: 'navigation.open',
        requestId: requestId(),
        payload: {
          workspaceFolderId: change.workspaceFolderId,
          relativePath: change.relativePath,
          reveal: 'focus',
          ...(location?.line === undefined
            ? {}
            : {
                range: {
                  start: { line: location.line, column: 0 },
                  end: { line: location.line, column: 0 },
                },
              }),
        },
      })
    },
    refreshTasks: refreshTasksState,
    getTask: async (taskId) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const result = await client.featureRequest<unknown>({
        type: 'tasks.open',
        requestId: requestId(),
        payload: { taskId },
      })
      return parseFeatureTasksResult(result)?.items[0]
    },
    stopTask: async (taskId, taskRevision) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const result = await client.featureRequest<unknown>({
        type: 'tasks.stop',
        requestId: requestId(),
        payload: { taskId, taskRevision },
      })
      const task = parseFeatureTasksResult(result)?.items[0]
      if (task !== undefined)
        setState((current) => ({
          ...current,
          tasks: mergeTask(current.tasks, task),
        }))
      return task
    },
    answerTask: async (taskId, interactionId, answer) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const result = await client.featureRequest<unknown>({
        type: 'tasks.answer',
        requestId: requestId(),
        payload: { taskId, interactionId, answer },
      })
      const task = parseFeatureTasksResult(result)?.items[0]
      if (task !== undefined)
        setState((current) => ({
          ...current,
          tasks: mergeTask(current.tasks, task),
        }))
      return task
    },
    refreshCheckpoints: refreshCheckpointsState,
    createCheckpoint: async (label) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const sessionId = readState().activeSessionId
      if (sessionId === undefined) return undefined
      const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
      if (workspaceFolderId === undefined) return undefined
      const normalizedLabel = label?.trim()
      const result = await client.featureRequest<unknown>({
        type: 'checkpoint.create',
        requestId: requestId(),
        payload: {
          sessionId,
          workspaceFolderId,
          ...(normalizedLabel === undefined || normalizedLabel === '' ? {} : { label: normalizedLabel }),
        },
      })
      const checkpoint = parseFeatureCheckpointsResult(result)?.[0]
      if (checkpoint === undefined) throw new Error(translate('app.error.checkpoint'))
      setState((current) =>
        current.activeSessionId !== sessionId
          ? current
          : {
              ...current,
              checkpoints: [
                checkpoint,
                ...current.checkpoints.filter((entry) => entry.checkpointId !== checkpoint.checkpointId),
              ],
            },
      )
      return checkpoint
    },
    previewCheckpoint: async (checkpointId) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const sessionId = readState().activeSessionId
      if (sessionId === undefined) return undefined
      const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
      if (workspaceFolderId === undefined) return undefined
      const result = await client.featureRequest<unknown>({
        type: 'checkpoint.preview',
        requestId: requestId(),
        payload: { checkpointId, sessionId, workspaceFolderId },
      })
      return parseFeatureCheckpointPreviewResult(result)
    },
    deleteCheckpoint: async (checkpointId) => {
      if (typeof client.featureRequest !== 'function') return
      const sessionId = readState().activeSessionId
      if (sessionId === undefined) return
      const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
      if (workspaceFolderId === undefined) return
      const result = await client.featureRequest<unknown>({
        type: 'checkpoint.delete',
        requestId: requestId(),
        payload: { checkpointId, sessionId, workspaceFolderId },
      })
      const deleted = parseFeatureCheckpointsResult(result)?.[0]
      if (deleted === undefined) throw new Error(translate('app.error.checkpoint'))
      setState((current) => ({
        ...current,
        checkpoints: current.checkpoints.filter((entry) => entry.checkpointId !== checkpointId),
      }))
    },
    restoreCheckpoint: async (checkpointId, previewId, conflictPolicy) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const sessionId = readState().activeSessionId
      if (sessionId === undefined) return undefined
      const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
      if (workspaceFolderId === undefined) return undefined
      const checkpoint = readState().checkpoints.find((entry) => entry.checkpointId === checkpointId)
      if (checkpoint?.expectedRevision === undefined) throw new Error(translate('app.error.checkpoint'))
      const result = await client.featureRequest<unknown>({
        type: 'checkpoint.restore',
        requestId: requestId(),
        payload: {
          checkpointId,
          sessionId,
          workspaceFolderId,
          expectedCurrentRevision: checkpoint.expectedRevision,
          previewId,
          conflictPolicy,
        },
      })
      const operation = parseFeatureOperationResult(result)
      if (operation === undefined) throw new Error(translate('app.error.checkpoint'))
      await refreshCheckpointsState(sessionId)
      return operation.state === 'completed' || operation.state === 'partial' ? operation.state : undefined
    },
    refreshPromptTemplates: refreshPromptTemplatesState,
    readPromptTemplate: async (templateId) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const sessionId = readState().activeSessionId
      if (sessionId === undefined) return undefined
      const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
      if (workspaceFolderId === undefined) return undefined
      const result = await client.featureRequest<unknown>({
        type: 'prompt.template.read',
        requestId: requestId(),
        payload: { templateId, sessionId, workspaceFolderId },
      })
      return parseFeaturePromptTemplateResult(result)
    },
    insertPromptTemplate: async (templateId, variables) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const sessionId = readState().activeSessionId
      if (sessionId === undefined) return undefined
      const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
      if (workspaceFolderId === undefined) return undefined
      const result = await client.featureRequest<unknown>({
        type: 'prompt.template.insert',
        requestId: requestId(),
        payload: {
          templateId,
          sessionId,
          workspaceFolderId,
          ...(variables === undefined ? {} : { variables }),
        },
      })
      return parseFeaturePromptTemplateInsertionResult(result)
    },
    createPromptTemplate: async (draft) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const sessionId = readState().activeSessionId
      if (sessionId === undefined) return undefined
      const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
      if (workspaceFolderId === undefined) return undefined
      const result = await client.featureRequest<unknown>({
        type: 'prompt.template.create',
        requestId: requestId(),
        payload: {
          ...draft,
          sessionId,
          workspaceFolderId,
          variables: promptTemplateVariables(draft.variables),
        },
      })
      const template = parseFeaturePromptTemplatesResult(result)?.[0]
      if (template === undefined) throw new Error(translate('app.error.promptTemplate'))
      setState((current) => ({
        ...current,
        promptTemplates: [
          template,
          ...current.promptTemplates.filter((entry) => entry.templateId !== template.templateId),
        ],
      }))
      return template
    },
    updatePromptTemplate: async (templateId, patch) => {
      if (typeof client.featureRequest !== 'function') return undefined
      const sessionId = readState().activeSessionId
      if (sessionId === undefined) return undefined
      const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
      if (workspaceFolderId === undefined) return undefined
      const result = await client.featureRequest<unknown>({
        type: 'prompt.template.update',
        requestId: requestId(),
        payload: {
          templateId,
          sessionId,
          workspaceFolderId,
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          ...(patch.templateText === undefined ? {} : { templateText: patch.templateText }),
          ...(patch.variables === undefined ? {} : { variables: promptTemplateVariables(patch.variables) }),
        },
      })
      const template = parseFeaturePromptTemplatesResult(result)?.[0]
      if (template === undefined) throw new Error(translate('app.error.promptTemplate'))
      setState((current) => ({
        ...current,
        promptTemplates: [
          template,
          ...current.promptTemplates.filter((entry) => entry.templateId !== template.templateId),
        ],
      }))
      return template
    },
    deletePromptTemplate: async (templateId) => {
      if (typeof client.featureRequest !== 'function') return
      const sessionId = readState().activeSessionId
      if (sessionId === undefined) return
      const workspaceFolderId = sessionWorkspaceFolderId(sessionId)
      if (workspaceFolderId === undefined) return
      const result = await client.featureRequest<unknown>({
        type: 'prompt.template.delete',
        requestId: requestId(),
        payload: { templateId, sessionId, workspaceFolderId },
      })
      if (parseFeatureOperationResult(result) === undefined)
        throw new Error(translate('app.error.promptTemplate'))
      setState((current) => ({
        ...current,
        promptTemplates: current.promptTemplates.filter((entry) => entry.templateId !== templateId),
      }))
    },
  }

  const applyFeatureEvent = (message: FeatureHostEvent): boolean => {
    if (message.name === 'editor.context.changed') {
      void refreshEditorContextState()
      return true
    }
    if (message.name === 'editor.context.availability.changed') {
      const availableKinds = parseEditorContextAvailableKinds(message.availableKinds)
      if (availableKinds !== undefined)
        setState((current) => ({ ...current, editorContextAvailableKinds: availableKinds }))
      return true
    }
    if (message.name === 'changes.invalidated' && message.sessionId === readState().activeSessionId) {
      void refreshChangesState(message.sessionId)
      return true
    }
    if (message.name === 'changes.updated' && message.change.sessionId === readState().activeSessionId) {
      void refreshChangesState(message.change.sessionId)
      return true
    }
    if (
      message.name === 'tasks.updated' &&
      (readState().taskScope === 'workspace' || message.task.sessionId === readState().activeSessionId)
    ) {
      const taskScope = readState().taskScope
      void refreshTasksState(taskScope === 'workspace' ? undefined : message.task.sessionId, false, taskScope)
      return true
    }
    if (
      message.name === 'checkpoint.updated' &&
      message.checkpoint.sessionId === readState().activeSessionId
    ) {
      void refreshCheckpointsState(message.checkpoint.sessionId)
      return true
    }
    return false
  }

  const refreshSessionScopedStates = (sessionId: string): void => {
    void refreshChangesState(sessionId)
    void refreshTasksState(sessionId)
    void refreshCheckpointsState(sessionId)
    void refreshPromptTemplatesState(sessionId)
  }

  return {
    methods,
    applyFeatureEvent,
    refreshSessionScopedStates,
    refreshEditorContextForOpen: (workspaceFolderId) => {
      void refreshEditorContextState(workspaceFolderId)
    },
    retireForSessionSwitch: () => {
      editorContextRefreshGeneration += 1
      changesRefreshGeneration += 1
      tasksRefreshGeneration += 1
      checkpointsRefreshGeneration += 1
      promptTemplatesRefreshGeneration += 1
    },
    retirePromptTemplatesForSubagentSwitch: () => {
      promptTemplatesRefreshGeneration += 1
    },
    discardEditorContextForSessionSwitch,
    discardEditorContextForWorkspaceChange,
  }
}
