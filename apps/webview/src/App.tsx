import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import type {
  AgentConfiguration,
  ContextPressure,
  ModelDescriptor,
  PromptAttachment,
  SessionSummary,
  TokenUsage,
} from '@dsh-vscode/domain'
import { cacheHitRate, type TimelineNode } from '@dsh-vscode/timeline'
import { EmptyState } from '@dsh-vscode/ui'
import { Composer } from './features/composer/Composer.js'
import { AppErrorBoundary } from './features/errors/AppErrorBoundary.js'
import { Timeline } from './features/chat/Timeline.js'
import { ApprovalCard } from './features/interactions/ApprovalCard.js'
import { UserQuestionCard } from './features/interactions/UserQuestionCard.js'
import { GoalTodoStrip } from './features/goals/GoalTodoStrip.js'
import { QueuePanel } from './features/input/QueuePanel.js'
import { RuntimeMissingView } from './features/runtime/RuntimeMissingView.js'
import { SessionDrawer } from './features/sessions/SessionDrawer.js'
import { createAppStore, type OpenFileCandidate } from './app/store.js'
import { Icon } from './ui/Icon.js'
import { hasVsCodeApi } from './vscode-api.js'

export function App(): ReactElement {
  const store = useMemo(() => createAppStore(), [])
  const state = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState(),
    () => store.getState(),
  )
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<PromptAttachment[]>([])
  const [openFileCandidates, setOpenFileCandidates] = useState<readonly OpenFileCandidate[]>([])
  const [openFilePickerOpen, setOpenFilePickerOpen] = useState(false)
  const [openFilePickerLoading, setOpenFilePickerLoading] = useState(false)
  const [attachingOpenFileId, setAttachingOpenFileId] = useState<string | undefined>()
  const [openFileAttachmentIds, setOpenFileAttachmentIds] = useState<Record<string, string>>({})
  const attachingOpenFileRef = useRef<string | undefined>(undefined)
  const [busyAction, setBusyAction] = useState<'install' | 'select' | undefined>()
  const [respondingInteractionId, setRespondingInteractionId] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [dismissedConnection, setDismissedConnection] = useState<string | undefined>()
  const [modelPickerOpenRequest, setModelPickerOpenRequest] = useState(0)

  useEffect(() => {
    if (!hasVsCodeApi()) return
    void store
      .initialize()
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : 'Unable to initialize DSH.'),
      )
    return () => store.dispose()
  }, [store])

  useEffect(() => {
    if (error === undefined) return
    const timer = window.setTimeout(() => setError(undefined), 8_000)
    return () => window.clearTimeout(timer)
  }, [error])

  const backend = state.backend
  const connectionMessage =
    backend.kind === 'failed' || backend.kind === 'port-conflict' ? backend.message : undefined
  const connectionKey = connectionMessage === undefined ? undefined : `${backend.kind}:${connectionMessage}`

  useEffect(() => {
    if (connectionKey === undefined) return
    const timer = window.setTimeout(() => setDismissedConnection(connectionKey), 10_000)
    return () => window.clearTimeout(timer)
  }, [connectionKey])

  const runRuntimeAction = (action: 'install' | 'select' | 'copy-command' | 'open-docs'): void => {
    if (action === 'install' || action === 'select') setBusyAction(action)
    void store
      .runtimeAction(action)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : 'Runtime action failed.'),
      )
      .finally(() => setBusyAction(undefined))
  }
  if (backend.kind === 'runtime-missing')
    return (
      <AppErrorBoundary>
        <RuntimeMissingView
          searchedLocations={backend.searchedLocations}
          busyAction={busyAction}
          onAction={runRuntimeAction}
          onRetry={() => {
            void store
              .reconnect()
              .catch((reason: unknown) =>
                setError(reason instanceof Error ? reason.message : 'Unable to reconnect to DSH.'),
              )
          }}
        />
      </AppErrorBoundary>
    )

  const active = state.sessions.find((session) => session.id === state.activeSessionId)
  const pendingPermissions =
    active === undefined ? [] : state.permissions.filter((request) => request.sessionId === active.id)
  const pendingQuestions =
    active === undefined ? [] : state.questions.filter((question) => question.sessionId === active.id)
  const assistantLabel = resolveAssistantModelLabel(active, state.configuration, state.models)
  const activeProjection = active === undefined ? undefined : state.projections[active.id]
  const contextPressure = readContextPressure(activeProjection?.contextPressure)
  const selectedModel = resolveSelectedModel(state.configuration, state.models)
  const estimatedContextTokens =
    contextPressure?.projectedTokens ??
    contextPressure?.pressureTokens ??
    estimateContextTokens(state.timeline.nodes)
  const contextWindowTokens = contextPressure?.contextWindow ?? selectedModel?.contextWindow
  const projectedTokenUsage = readTokenUsageProjection(activeProjection?.tokenUsage)
  const streaming = state.timeline.nodes.some(
    (node) =>
      (node.kind === 'assistant-message' && (node.streaming || node.reasoning?.streaming === true)) ||
      (node.kind === 'reasoning' && node.streaming),
  )
  const appendAttachment = (attachment: PromptAttachment, openFileId?: string): void => {
    setAttachments((current) =>
      current.some((item) => item.uri === attachment.uri) ? current : [...current, attachment],
    )
    if (openFileId !== undefined)
      setOpenFileAttachmentIds((current) => ({ ...current, [attachment.uri]: openFileId }))
  }
  const submitPrompt = (): void => {
    if (active === undefined) return
    const text = draft
    const attachmentSnapshot = attachments
    void store
      .sendPrompt(active.id, text, attachmentSnapshot)
      .then(() => {
        setDraft('')
        setAttachments([])
        setOpenFileAttachmentIds({})
        setOpenFilePickerOpen(false)
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Prompt failed.'))
  }
  const toggleOpenFilePicker = (): void => {
    if (openFilePickerOpen) {
      setOpenFilePickerOpen(false)
      return
    }
    setOpenFilePickerOpen(true)
    setOpenFilePickerLoading(true)
    void store
      .listOpenFiles()
      .then(setOpenFileCandidates)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : 'Unable to list open files.'),
      )
      .finally(() => setOpenFilePickerLoading(false))
  }
  const selectOpenFile = (candidateId: string): void => {
    if (
      attachingOpenFileRef.current !== undefined ||
      attachingOpenFileId !== undefined ||
      Object.values(openFileAttachmentIds).some((id) => id === candidateId)
    )
      return
    attachingOpenFileRef.current = candidateId
    setAttachingOpenFileId(candidateId)
    void store
      .attachOpenFile(candidateId)
      .then((attachment) => {
        if (attachment === undefined) {
          setError('The selected open file is no longer available.')
          return
        }
        store.rememberOpenFile(candidateId)
        appendAttachment(attachment, candidateId)
        setOpenFilePickerOpen(false)
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : 'Unable to attach the selected file.'),
      )
      .finally(() => {
        attachingOpenFileRef.current = undefined
        setAttachingOpenFileId(undefined)
      })
  }
  return (
    <AppErrorBoundary>
      <main className="dsh-app">
        <div className="dsh-app__session-drawer-anchor">
          <SessionDrawer
            sessions={state.sessions}
            workspaces={state.workspaces}
            activeSessionId={state.activeSessionId}
            open={state.drawer === 'sessions'}
            showTrigger={false}
            onOpenChange={(open) => store.setDrawer(open ? 'sessions' : undefined)}
            onOpen={(sessionId) => {
              void store
                .openSession(sessionId)
                .catch((reason: unknown) =>
                  setError(reason instanceof Error ? reason.message : 'Unable to open session.'),
                )
            }}
            onCreate={(workspaceId) => {
              void store
                .createSession(workspaceId)
                .catch((reason: unknown) =>
                  setError(reason instanceof Error ? reason.message : 'Unable to create session.'),
                )
            }}
            onArchive={(sessionId) =>
              store.removeSession(sessionId).catch((reason: unknown) => {
                const message = reason instanceof Error ? reason.message : 'Unable to archive session.'
                setError(message)
                throw reason
              })
            }
          />
        </div>
        {error === undefined ? null : (
          <div className="dsh-app__error" role="alert">
            <span>{error}</span>
            <button
              className="dsh-icon-button"
              type="button"
              aria-label="Dismiss error"
              title="Dismiss error"
              onClick={() => setError(undefined)}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        {connectionMessage === undefined || connectionKey === dismissedConnection ? null : (
          <div className="dsh-app__connection-alert" role="alert">
            <div>
              <strong>{backend.kind === 'port-conflict' ? 'Port conflict' : 'Connection failed'}</strong>
              <span>{connectionMessage}</span>
            </div>
            <button
              className="dsh-icon-button"
              type="button"
              aria-label="Dismiss connection error"
              title="Dismiss connection error"
              onClick={() => setDismissedConnection(connectionKey)}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        <section className="dsh-app__body">
          {active === undefined ? (
            <div className="dsh-app__empty">
              <EmptyState
                title="No active session"
                description={
                  state.sessions.length === 0
                    ? 'Create a session to begin.'
                    : 'Choose a session from the session menu.'
                }
              />
            </div>
          ) : (
            <section
              className="dsh-conversation"
              aria-label={active.title.trim() === '' ? 'Conversation' : active.title}
            >
              {state.goals.length > 0 ? <GoalTodoStrip goals={state.goals} /> : null}
              {state.todos.length > 0 ? (
                <GoalTodoStrip
                  label="To-do"
                  goals={state.todos.map((todo) => ({
                    id: todo.id,
                    title: todo.content,
                    status: todo.status,
                  }))}
                />
              ) : null}
              <Timeline
                sessionId={active.id}
                nodes={state.timeline.nodes}
                streaming={streaming}
                assistantLabel={assistantLabel}
                onOpenLink={(href) => {
                  void store
                    .openLink(href)
                    .catch((reason: unknown) =>
                      setError(
                        reason instanceof Error ? reason.message : 'The linked file could not be opened.',
                      ),
                    )
                }}
              />
              {state.queue.length === 0 ? null : (
                <QueuePanel
                  items={state.queue}
                  onEdit={(inputId, text) => {
                    void store
                      .updateQueue(inputId, text)
                      .catch((reason: unknown) =>
                        setError(reason instanceof Error ? reason.message : 'Unable to edit queued prompt.'),
                      )
                  }}
                  onRemove={(inputId) => {
                    void store
                      .removeQueue(inputId)
                      .catch((reason: unknown) =>
                        setError(
                          reason instanceof Error ? reason.message : 'Unable to remove queued prompt.',
                        ),
                      )
                  }}
                  onModeChange={(inputId, mode) => {
                    if (mode !== 'steer') return
                    void store
                      .steerQueue(inputId)
                      .catch((reason: unknown) =>
                        setError(reason instanceof Error ? reason.message : 'Unable to steer queued prompt.'),
                      )
                  }}
                />
              )}
              <div className="dsh-compose-area">
                {pendingPermissions.length === 0 && pendingQuestions.length === 0 ? (
                  <Composer
                    disabled={backend.kind !== 'connected'}
                    running={active.status === 'running'}
                    draft={draft}
                    attachments={attachments}
                    configuration={state.configuration}
                    models={state.models}
                    presets={state.presets}
                    permissionPresets={state.permissionPresets}
                    commands={state.commands}
                    modelPickerOpenRequest={modelPickerOpenRequest}
                    estimatedContextTokens={estimatedContextTokens}
                    {...(contextWindowTokens === undefined ? {} : { contextWindowTokens })}
                    cacheHitRate={cacheHitRate(projectedTokenUsage ?? state.timeline.tokenUsage)}
                    configurationDisabled={backend.kind !== 'connected' || active.status === 'running'}
                    presetMutable={active.status === 'idle'}
                    onConfigurationChange={(configuration) => {
                      void store
                        .configureSession(active.id, configuration)
                        .catch((reason: unknown) =>
                          setError(
                            reason instanceof Error ? reason.message : 'Unable to update session settings.',
                          ),
                        )
                    }}
                    onCommand={(command) => {
                      if (command.trim() === '/model') {
                        setModelPickerOpenRequest((current) => current + 1)
                        return
                      }
                      void store
                        .executeCommand(active.id, command)
                        .catch((reason: unknown) =>
                          setError(reason instanceof Error ? reason.message : 'Unable to update DSH mode.'),
                        )
                    }}
                    onCommandQueryChange={(query) => {
                      if (query === undefined || state.commands.length > 0) return
                      void store.refreshCommands(active.id)
                    }}
                    onDraftChange={setDraft}
                    onPickAttachment={() => {
                      void store
                        .pickAttachment()
                        .then((attachment) => {
                          if (attachment !== undefined) appendAttachment(attachment)
                        })
                        .catch((reason: unknown) =>
                          setError(reason instanceof Error ? reason.message : 'Attachment selection failed.'),
                        )
                    }}
                    openFileCandidates={openFileCandidates}
                    openFilePickerOpen={openFilePickerOpen}
                    openFilePickerLoading={openFilePickerLoading}
                    {...(state.preferredOpenFileId === undefined
                      ? {}
                      : { preferredOpenFileId: state.preferredOpenFileId })}
                    attachedOpenFileIds={Object.values(openFileAttachmentIds)}
                    {...(attachingOpenFileId === undefined ? {} : { attachingOpenFileId })}
                    onToggleOpenFilePicker={toggleOpenFilePicker}
                    onSelectOpenFile={selectOpenFile}
                    onRemoveAttachment={(uri) => {
                      setAttachments((current) => current.filter((attachment) => attachment.uri !== uri))
                      setOpenFileAttachmentIds((current) => {
                        const next = { ...current }
                        delete next[uri]
                        return next
                      })
                    }}
                    onSubmit={submitPrompt}
                    onCancel={() => {
                      void store
                        .cancelSession(active.id)
                        .catch((reason: unknown) =>
                          setError(reason instanceof Error ? reason.message : 'Cancellation failed.'),
                        )
                    }}
                  />
                ) : (
                  <div className="dsh-compose-area__interactions" aria-live="polite">
                    {pendingPermissions.map((request) => (
                      <ApprovalCard
                        key={request.id}
                        request={request}
                        disabled={respondingInteractionId !== undefined}
                        onRespond={(optionId) => {
                          setRespondingInteractionId(request.id)
                          void store
                            .respondToPermission(request.id, optionId)
                            .catch((reason: unknown) =>
                              setError(
                                reason instanceof Error ? reason.message : 'Unable to answer approval.',
                              ),
                            )
                            .finally(() => setRespondingInteractionId(undefined))
                        }}
                      />
                    ))}
                    {pendingQuestions.map((question) => (
                      <UserQuestionCard
                        key={question.id}
                        question={question}
                        disabled={respondingInteractionId !== undefined}
                        onRespond={(response) => {
                          setRespondingInteractionId(question.id)
                          void store
                            .respondToQuestion(question.id, response)
                            .catch((reason: unknown) =>
                              setError(
                                reason instanceof Error ? reason.message : 'Unable to answer question.',
                              ),
                            )
                            .finally(() => setRespondingInteractionId(undefined))
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}
        </section>
      </main>
    </AppErrorBoundary>
  )
}

function estimateContextTokens(nodes: readonly TimelineNode[]): number {
  const characters = nodes.reduce((total, node) => {
    if (node.kind === 'assistant-message')
      return total + node.markdown.length + (node.reasoning?.markdown.length ?? 0)
    if (node.kind === 'user-message' || node.kind === 'reasoning') return total + node.markdown.length
    if (node.kind === 'tool')
      return (
        total +
        node.tool.name.length +
        node.tool.title.length +
        (node.tool.inputSummary?.length ?? 0) +
        (node.tool.outputSummary?.length ?? 0) +
        (node.tool.error?.length ?? 0)
      )
    if (node.kind === 'notice') return total + node.text.length
    return total
  }, 0)
  return Math.max(0, Math.ceil(characters / 4))
}

function resolveSelectedModel(
  configuration: AgentConfiguration | undefined,
  models: readonly ModelDescriptor[],
): ModelDescriptor | undefined {
  if (configuration === undefined) return undefined
  return models.find(
    (model) =>
      model.providerId === configuration.model.providerId && model.id === configuration.model.modelId,
  )
}

function readContextPressure(value: unknown): ContextPressure | undefined {
  const record = object(value)
  if (record === undefined) return undefined
  const pressureTokens = nonNegativeTokenCount(record.pressureTokens)
  const projectedTokens = nonNegativeTokenCount(record.projectedTokens)
  const contextWindow = positiveTokenCount(record.contextWindow)
  if (pressureTokens === undefined && projectedTokens === undefined && contextWindow === undefined)
    return undefined
  return {
    ...(pressureTokens === undefined ? {} : { pressureTokens }),
    ...(projectedTokens === undefined ? {} : { projectedTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  }
}

function readTokenUsageProjection(value: unknown): TokenUsage | undefined {
  const record = object(value)
  if (record === undefined) return undefined
  const inputTokens = nonNegativeTokenCount(record.uncachedInputTokens ?? record.inputTokens)
  const outputTokens = nonNegativeTokenCount(record.outputTokens)
  const cacheReadTokens = nonNegativeTokenCount(record.cacheReadTokens)
  const cacheWriteTokens = nonNegativeTokenCount(record.cacheWriteTokens)
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined
  )
    return undefined
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function nonNegativeTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function positiveTokenCount(value: unknown): number | undefined {
  const count = nonNegativeTokenCount(value)
  return count === undefined || count === 0 ? undefined : count
}

function resolveAssistantModelLabel(
  session: SessionSummary | undefined,
  configuration: AgentConfiguration | undefined,
  models: readonly ModelDescriptor[],
): string {
  const selected =
    configuration === undefined
      ? undefined
      : models.find(
          (model) =>
            model.providerId === configuration.model.providerId && model.id === configuration.model.modelId,
        )
  return (
    selected?.label.trim() || session?.modelLabel?.trim() || configuration?.model.modelId.trim() || 'Model'
  )
}
