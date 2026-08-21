import type {
  BackendEvent,
  CompactionView,
  GoalView,
  JobView,
  MessageAttachment,
  MessageImageReference,
  ModelDescriptor,
  ModelSelection,
  ModelProvider,
  PermissionRequest,
  QueuedInput,
  SessionDetail,
  SessionConfigurationPatch,
  SessionHistoryEvent,
  SessionStatus,
  SessionSummary,
  TeamActivityView,
  TokenUsage,
  ToolCallView,
  ToolPresentationDiff,
  ToolPresentationLine,
  ToolPresentationSearchFile,
  ToolPresentationSearchMatch,
  ToolPresentationSource,
  ToolPresentationView,
  TurnEndFailure,
  TurnEndReasonKind,
  TodoView,
  UserQuestion,
  UserQuestionItem,
  WorkspaceSummary,
} from '@dsh-vscode/domain'

export const rc6Mapper = {
  sessionSummary(value: unknown): SessionSummary {
    const record = object(value, 'session summary')
    const id = string(record.sessionId ?? record.id, 'sessionId')
    const projections = objectOrUndefined(record.projections)
    const projectionValues = objectOrUndefined(projections?.values)
    const updatedAt = date(record.updatedAt ?? record.createdAt)
    const running = boolean(record.running, false)
    const blank = boolean(record.blank, false)
    const status: SessionStatus = running ? 'running' : blank ? 'idle' : 'completed'
    const rawTitle = record.title ?? record.name ?? projectionValues?.title
    const modelRecord = objectOrUndefined(record.model)
    const rawModelLabel =
      record.modelLabel ??
      modelRecord?.label ??
      modelRecord?.name ??
      modelRecord?.modelId ??
      (typeof record.model === 'string' ? record.model : undefined)
    const cwd = firstString(record.cwd, record.workingDirectory)
    return {
      id,
      workspaceId: stringOr(record.workspaceId, ''),
      ...(cwd === undefined ? {} : { cwd }),
      // rc.6 keeps command-only sessions blank. Their projection title may be
      // the command's success text, but that is not conversation content and
      // must not turn a reusable New Session into a history row.
      title: blank ? 'New Session' : normalizeSessionTitle(rawTitle),
      blank,
      ...(record.parentSessionId === undefined
        ? {}
        : { parentSessionId: string(record.parentSessionId, 'parentSessionId') }),
      ...(record.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
      status,
      createdAt: date(record.createdAt ?? record.updatedAt),
      updatedAt,
      ...(rawModelLabel === undefined ? {} : { modelLabel: stringOr(rawModelLabel, '') }),
      ...(typeof record.agentPreset === 'string' ? { agentPreset: record.agentPreset } : {}),
      ...(projectionValues === undefined
        ? {}
        : {
            projection: {
              asOfSequence: number(projections?.asOfSeq, -1),
              values: projectionValues,
            },
          }),
    }
  },

  sessionDetail(value: unknown): SessionDetail {
    const summary = rc6Mapper.sessionSummary(value)
    const record = object(value, 'session detail')
    const permissionPresets = permissionPresetIds(summary.projection?.values)
    return {
      ...summary,
      configuration: configuration(record.configuration),
      ...(permissionPresets.length === 0 ? {} : { permissionPresets }),
      goalIds: array(record.goalIds)
        .map((entry) => stringOr(entry, ''))
        .filter(Boolean),
      ...(record.parentSessionId === undefined
        ? {}
        : { parentSessionId: string(record.parentSessionId, 'parentSessionId') }),
    }
  },

  history(
    value: unknown,
    sessionId: string,
  ): {
    events: readonly SessionHistoryEvent[]
    hasMore: boolean
    projection?: SessionDetail['projection']
  } {
    const record = object(value, 'session history')
    if (!Array.isArray(record.events) || typeof record.hasMore !== 'boolean')
      throw new Error('Malformed session history response')
    const projections = record.projections
    if (projections !== undefined && !validProjectionBlock(projections))
      throw new Error('Malformed session history projections')
    const events = record.events.map((entry, index) => mapHistoryEntry(entry, index, sessionId))
    const projection = objectOrUndefined(projections)
    return {
      events,
      hasMore: record.hasMore,
      ...(projection === undefined
        ? {}
        : {
            projection: {
              asOfSequence: projection.asOfSeq as number,
              values: projection.values as Record<string, unknown>,
            },
          }),
    }
  },

  workspace(value: unknown): WorkspaceSummary {
    const record = object(value, 'workspace')
    const id = string(record.workspaceId ?? record.id, 'workspaceId')
    const updatedAt = date(record.updatedAt ?? record.createdAt)
    const sessionIds = array(record.sessionIds).filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    )
    return {
      id,
      name: stringOr(record.title ?? record.name, id),
      path: string(record.path, 'path'),
      createdAt: date(record.createdAt ?? record.updatedAt),
      updatedAt,
      sessionCount: sessionIds.length || number(record.sessionCount, 0),
      ...(sessionIds.length === 0 ? {} : { sessionIds }),
    }
  },

  provider(value: unknown): ModelProvider {
    const record = object(value, 'provider')
    const id = string(record.provider ?? record.id, 'provider')
    const fields = array(record.fields).map((entry) => {
      const field = object(entry, 'provider field')
      const secret = boolean(field.secret, false)
      return {
        key: string(field.key ?? field.name, 'field key'),
        label: stringOr(field.label ?? field.name, 'Setting'),
        secret,
        required: boolean(field.required, false),
        ...(secret || field.value === undefined ? {} : { value: stringOr(field.value, '') }),
      }
    })
    return {
      id,
      name: stringOr(record.displayName ?? record.name, id),
      kind: stringOr(record.kind ?? record.settingsNs, 'provider'),
      // `declared` means that the route was hand-declared by the deployment;
      // it does not mean that a shipped provider is read-only.  Upstream's
      // provider directory exposes every configured route to the Models page,
      // so only an explicit `configurable: false` can disable editing.
      configurable: boolean(record.configurable, true),
      ...(typeof record.active === 'boolean' ? { active: record.active } : {}),
      ...(typeof record.declared === 'boolean' ? { declared: record.declared } : {}),
      ...(typeof record.settingsNs === 'string' ? { settingsNs: record.settingsNs } : {}),
      ...(Array.isArray(record.settingsPath)
        ? { settingsPath: record.settingsPath.filter((entry): entry is string => typeof entry === 'string') }
        : {}),
      fields,
    }
  },

  model(value: unknown): ModelDescriptor {
    const record = object(value, 'model')
    const reasoning = objectOrUndefined(record.reasoning)
    const context = objectOrUndefined(record.context)
    const efforts =
      reasoning === undefined
        ? []
        : array(reasoning.efforts)
            .map((effort) => {
              const item = object(effort, 'reasoning effort')
              return stringOr(item.id, '')
            })
            .filter(Boolean)
    return {
      id: string(record.id, 'model id'),
      providerId: stringOr(record.providerId ?? record.provider, ''),
      label: stringOr(record.name ?? record.label, stringOr(record.id, 'Model')),
      ...(record.contextWindow === undefined && context?.contextWindow === undefined
        ? {}
        : { contextWindow: number(record.contextWindow ?? context?.contextWindow, 0) }),
      supportsReasoning: reasoning !== undefined,
      ...(efforts.length === 0 ? {} : { reasoningLevels: efforts }),
    }
  },

  event(name: string, value: unknown): BackendEvent {
    const envelope = objectOrUndefined(value) ?? {}
    const data = objectOrUndefined(envelope.data) ?? envelope
    const sessionId = stringOr(envelope.sessionId ?? data.sessionId, '')
    switch (name) {
      case 'session/status':
      case 'host/session-status':
        return {
          type: 'session.status',
          sessionId,
          status:
            typeof data.status === 'string' ? data.status : boolean(data.running, false) ? 'running' : 'idle',
        }
      case 'session/title':
        return {
          type: 'session.title',
          sessionId,
          title: stringOr(data.title ?? data.name, ''),
        }
      case 'agent-preset/selected':
        return sessionConfiguration(sessionId, { preset: stringOr(data.agentPreset ?? data.preset, '') })
      case 'permission/preset':
        return sessionConfiguration(sessionId, {
          permissionPreset: stringOr(data.preset ?? data.value ?? data.name, ''),
        })
      case 'plan/mode':
        return sessionConfiguration(sessionId, { planMode: planMode(data) })
      case 'sandbox/mode':
        return sessionConfiguration(sessionId, {
          sandboxMode: stringOr(data.mode ?? data.value ?? data.name, ''),
        })
      case 'approval/policy':
        return sessionConfiguration(sessionId, {
          approvalPolicy: stringOr(data.policy ?? data.value ?? data.name, ''),
        })
      case 'request/context': {
        const model = modelPatch(data)
        return Object.keys(model).length === 0
          ? { type: 'unknown', sessionId, name, payload: safePayload(value) }
          : sessionConfiguration(sessionId, { model })
      }
      case 'request/header': {
        const model = modelPatch(data)
        return Object.keys(model).length === 0
          ? { type: 'unknown', sessionId, name, payload: safePayload(value) }
          : sessionConfiguration(sessionId, { model })
      }
      case 'turn/start':
      case 'turn/end': {
        const turn = eventIndex(data.turn)
        if (turn === undefined)
          return {
            type: 'unknown',
            ...(sessionId === '' ? {} : { sessionId }),
            name,
            payload: safePayload(value),
          }
        if (name === 'turn/start') return { type: 'turn.started', sessionId, turn }
        const failure = turnEndFailure(data.reason)
        return {
          type: 'turn.ended',
          sessionId,
          turn,
          reason: turnEndReason(data.reason),
          ...(failure === undefined ? {} : { failure }),
        }
      }
      case 'step/start':
      case 'step/end': {
        const turn = eventIndex(data.turn)
        const step = eventIndex(data.step)
        if (turn === undefined || step === undefined)
          return {
            type: 'unknown',
            ...(sessionId === '' ? {} : { sessionId }),
            name,
            payload: safePayload(value),
          }
        const time = eventTimestamp(envelope.time ?? data.time)
        return {
          type: name === 'step/start' ? 'step.started' : 'step.ended',
          sessionId,
          turn,
          step,
          ...(time === undefined ? {} : { time }),
        }
      }
      case 'message/delta':
      case 'message/chunk':
      case 'assistant/chunk': {
        const chunk = objectOrUndefined(data.chunk)
        const chunkType = stringOr(chunk?.type, '')
        const messageId = assistantMessageId(data)
        const turn = eventIndex(data.turn)
        const step = eventIndex(data.step)
        const time = eventTimestamp(envelope.time ?? data.time)
        if (chunkType === 'reasoning-delta')
          return {
            type: 'reasoning.delta',
            sessionId,
            messageId,
            delta: stringOr(chunk?.text ?? data.reasoning ?? data.text ?? data.delta, ''),
            ...(turn === undefined ? {} : { turn }),
            ...(step === undefined ? {} : { step }),
            ...(time === undefined ? {} : { time }),
          }
        if (chunkType === '' || chunkType === 'text-delta')
          return {
            type: 'message.delta',
            sessionId,
            messageId,
            delta: stringOr(data.delta ?? data.text ?? chunk?.text ?? chunk?.delta, ''),
            ...(turn === undefined ? {} : { turn }),
            ...(step === undefined ? {} : { step }),
            ...(time === undefined ? {} : { time }),
          }
        // block-start, tool-call-delta, block-end, usage and finish are
        // structured stream bookkeeping. They do not contain visible text;
        // mapping them to message.delta was the source of empty/fused cards.
        return {
          type: 'unknown',
          ...(sessionId === '' ? {} : { sessionId }),
          name: chunkType === '' ? 'assistant/chunk' : `assistant/chunk:${chunkType}`,
          payload: safePayload(data),
        }
      }
      case 'message/completed':
      case 'message/complete':
      case 'assistant/message': {
        const message = objectOrUndefined(data.message) ?? data
        const visible = messageText(message) || stringOr(data.markdown ?? data.text, '')
        const reasoning = reasoningText(message) || stringOr(data.reasoning, '')
        const modelLabel = assistantModelLabel(message, data)
        const images = messageImages(message)
        const usage = tokenUsage(data.usage ?? message.usage ?? envelope.usage)
        const turn = eventIndex(data.turn)
        const step = eventIndex(data.step)
        const time = eventTimestamp(envelope.time ?? data.time)
        return {
          type: 'message.completed',
          sessionId,
          messageId: assistantMessageId(data, message),
          ...(visible === '' ? {} : { markdown: visible }),
          ...(reasoning === '' ? {} : { reasoning }),
          ...(modelLabel === undefined ? {} : { modelLabel }),
          ...(images.length === 0 ? {} : { images }),
          ...(usage === undefined ? {} : { usage }),
          ...(turn === undefined ? {} : { turn }),
          ...(step === undefined ? {} : { step }),
          ...(time === undefined ? {} : { time }),
          ...(data.interrupted === true || message.interrupted === true
            ? { interrupted: true as const }
            : {}),
        }
      }
      case 'user/message': {
        const message = objectOrUndefined(data.message) ?? data
        const source = objectOrUndefined(message.source)
        const sourceLabel = stringOr(source?.kind ?? source?.type ?? message.source, '')
        const sourceForm = stringOr(source?.form, '')
        const sourceSummary = stringOr(source?.summary, '')
        const rpcId = stringOr(envelope.rpcId ?? data.rpcId ?? source?.rpcId, '')
        const userContent = userMessageContent(message)
        return {
          type: 'message.user',
          sessionId,
          messageId: stringOr(message.id, `user:${indexToken(data.turn) ?? 'unknown'}`),
          markdown: userContent.markdown,
          ...(userContent.attachments.length === 0 ? {} : { attachments: userContent.attachments }),
          ...(userContent.images.length === 0 ? {} : { images: userContent.images }),
          ...(rpcId === '' ? {} : { rpcId }),
          ...(sourceLabel !== ''
            ? { source: sourceLabel }
            : userContent.markdown.trimStart().startsWith('/')
              ? { source: 'command' }
              : {}),
          ...(sourceForm === '' ? {} : { sourceForm }),
          ...(sourceSummary === '' ? {} : { sourceSummary }),
        }
      }
      case 'tool/call':
      case 'tool/result': {
        const time = eventTimestamp(envelope.time ?? data.time)
        return {
          type: 'tool.updated',
          sessionId,
          tool: tool(
            {
              ...data,
              ...(name === 'tool/call' && time === undefined
                ? {}
                : name === 'tool/call'
                  ? { startedAt: time }
                  : {}),
              ...(name === 'tool/result' && time === undefined
                ? {}
                : name === 'tool/result'
                  ? { completedAt: time }
                  : {}),
              ...(envelope.view === undefined ? {} : { view: envelope.view }),
              ...(objectOrUndefined(data.message) === undefined
                ? {}
                : { outputSummary: bounded(data.message) }),
            },
            name === 'tool/call' ? 'call' : 'result',
          ),
        }
      }
      case 'approval/requested':
        return {
          type: 'permission.requested',
          request: permission({
            ...data,
            sessionId,
            ...(envelope.rpcId === undefined ? {} : { rpcId: envelope.rpcId }),
          }),
        }
      case 'approval/resolved':
        return {
          type: 'permission.resolved',
          sessionId,
          requestId: stringOr(data.approvalId ?? data.id, ''),
          ...(typeof data.outcome === 'string' ? { outcome: data.outcome } : {}),
        }
      case 'question/requested':
        return {
          type: 'question.requested',
          question: question({
            ...data,
            sessionId,
            ...(envelope.rpcId === undefined ? {} : { questionRpcId: envelope.rpcId }),
          }),
        }
      case 'question/resolved':
        return {
          type: 'question.resolved',
          sessionId,
          ...(typeof data.questionRpcId === 'string' ? { questionRpcId: data.questionRpcId } : {}),
          ...(typeof data.id === 'string' ? { questionId: data.id } : {}),
          ...(typeof data.outcome === 'string' ? { outcome: data.outcome } : {}),
        }
      case 'goal/updated':
      case 'goal':
      case 'goal/change':
        return { type: 'goal.updated', sessionId, goals: array(data.goals).map(goal) }
      case 'todo/write':
        return {
          type: 'todo.updated',
          sessionId,
          todos: array(data.todos ?? data.items).map((entry, index) => todo(entry, index)),
        }
      case 'compaction/start':
      case 'compaction/summary':
      case 'compaction/prune':
      case 'compaction/end': {
        const shadowedSeqs = safeEventSeqs(data.shadowedSeqs)
        const summary =
          name === 'compaction/summary' ? contentText(array(data.summary), false) || undefined : undefined
        const replacedCount = shadowedSeqs?.length
        const estimatedTokens = nonNegativeSafeNumber(data.shadowedTokenCount)
        const compactionId =
          name === 'compaction/prune'
            ? `prune:${shadowedSeqs?.join(',') ?? stringOr(envelope.seq ?? data.seq, 'unknown')}`
            : string(data.compactionId, 'compactionId')
        return {
          type: 'compaction.updated',
          sessionId,
          compaction: {
            id: compactionId,
            phase: compactionPhase(name),
            ...(summary === undefined ? {} : { summary }),
            ...(replacedCount === undefined ? {} : { replacedCount }),
            ...(estimatedTokens === undefined ? {} : { estimatedTokens }),
          },
        }
      }
      case 'llm/retry-started':
      case 'llm/retry': {
        const retryId = string(data.retryId, 'retryId')
        const turn = eventIndex(data.turn)
        const step = eventIndex(data.step)
        const attempt = positiveSafeNumber(data.retry)
        if (turn === undefined) throw new Error('Malformed retry turn')
        if (step === undefined) throw new Error('Malformed retry step')
        if (attempt === undefined) throw new Error('Malformed retry attempt')
        if (name === 'llm/retry') {
          const provider = string(data.provider, 'retry provider')
          const mode = data.mode
          const policyKey = string(data.policyKey, 'retry policyKey')
          const delayMs = nonNegativeSafeNumber(data.delayMs)
          const failure = retryFailure(data.failure)
          if (mode !== 'normal' && mode !== 'always') throw new Error('Malformed retry mode')
          if (delayMs === undefined) throw new Error('Malformed retry delayMs')
          if (mode === 'normal' && positiveSafeNumber(data.maxRetries) === undefined)
            throw new Error('Malformed retry maxRetries')
          // Validate all provider-owned routing fields even though the Domain
          // signal deliberately keeps only presentation facts.
          void provider
          void policyKey
          return {
            type: 'model.retry',
            retry: {
              sessionId,
              id: retryId,
              turn,
              step,
              attempt,
              state: 'scheduled',
              delayMs,
              ...(mode === 'normal' ? { maxRetries: data.maxRetries as number } : {}),
              ...(failure.message === '' ? {} : { message: failure.message }),
            },
          }
        }
        return {
          type: 'model.retry',
          retry: {
            sessionId,
            id: retryId,
            turn,
            step,
            attempt,
            state: 'started',
          },
        }
      }
      case 'command/run':
      case 'command/done':
        return commandNotice(name, data, sessionId)
      case 'session/jobs':
        if (!Array.isArray(data.jobs)) throw new Error('Malformed session/jobs jobs')
        return {
          type: 'jobs.updated',
          sessionId,
          jobs: data.jobs.map(job),
        }
      case 'tool/code-dispatch-start':
        return { type: 'tool.updated', sessionId, tool: tool({ ...data, status: 'running' }, 'call') }
      case 'tool/code-dispatch':
        return { type: 'tool.updated', sessionId, tool: tool({ ...data, status: 'completed' }, 'result') }
      case 'tool-workflow/run-start':
        return {
          type: 'workflow.started',
          sessionId,
          workflow: {
            id: string(data.runId, 'workflow runId'),
            sessionId,
            name: string(data.name, 'workflow name'),
            status: 'running',
            stages: [],
          },
        }
      case 'tool-workflow/agent-start': {
        const phase = data.phase
        if (phase !== undefined && typeof phase !== 'string') throw new Error('Malformed workflow phase')
        const seq = positiveSafeNumber(data.seq)
        if (seq === undefined) throw new Error('Malformed workflow member seq')
        if (typeof data.label !== 'string') throw new Error('Malformed workflow member label')
        return {
          type: 'workflow.member.started',
          sessionId,
          runId: string(data.runId, 'workflow runId'),
          phase: phase ?? null,
          member: {
            seq,
            label: data.label,
            childId: string(data.childId, 'workflow childId'),
            status: 'running',
          },
        }
      }
      case 'tool-workflow/agent-end': {
        const seq = positiveSafeNumber(data.seq)
        if (seq === undefined) throw new Error('Malformed workflow member seq')
        const outcome = workflowMemberOutcome(data.outcome)
        return {
          type: 'workflow.member.ended',
          sessionId,
          runId: string(data.runId, 'workflow runId'),
          seq,
          outcome,
        }
      }
      case 'tool-workflow/run-end':
        return {
          type: 'workflow.ended',
          sessionId,
          runId: string(data.runId, 'workflow runId'),
          stopReason: workflowStopReason(data.stopReason),
        }
      case 'team/member':
      case 'team/task':
      case 'team/message/queued':
      case 'team/message/delivered': {
        const activity = teamActivity(name, data)
        return activity === undefined
          ? {
              type: 'unknown',
              ...(sessionId === '' ? {} : { sessionId }),
              name,
              payload: safePayload(value),
            }
          : { type: 'team.updated', sessionId, activity }
      }
      case 'session/queue':
        return {
          type: 'queue.updated',
          sessionId,
          items: array(data.items).flatMap((entry) => queuedInput(entry, sessionId)),
        }
      case 'session/subscribed':
        return {
          type: 'session.subscribed',
          sessionId,
          lastSequence: number(data.lastSeq, -1),
        }
      case 'session/projection':
        return {
          type: 'session.projection',
          sessionId,
          key: stringOr(data.key, 'unknown'),
          value: data.value,
        }
      case 'host/session-added':
        return {
          type: 'session.added',
          sessionId,
          ...(typeof data.blank === 'boolean' ? { blank: data.blank } : {}),
          ...(typeof data.parentSessionId === 'string' ? { parentSessionId: data.parentSessionId } : {}),
          ...(data.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
          ...(typeof data.cwd === 'string' && data.cwd.trim() !== '' ? { cwd: data.cwd } : {}),
          ...(typeof data.agentPreset === 'string' && data.agentPreset.trim() !== ''
            ? { agentPreset: data.agentPreset }
            : {}),
        }
      case 'host/session-removed':
        return { type: 'session.removed', sessionId }
      case 'host/workspace-changed': {
        const id = workspaceId(data)
        return id === undefined
          ? { type: 'workspace.changed' }
          : { type: 'workspace.changed', workspaceId: id }
      }
      case 'host/workspace-removed': {
        const id = workspaceId(data)
        return id === undefined
          ? { type: 'workspace.removed' }
          : { type: 'workspace.removed', workspaceId: id }
      }
      case 'host/workspace-order-changed':
        return { type: 'workspace.order.changed', workspaceIds: stringArray(data.workspaceIds ?? data.order) }
      case 'host/archived-sessions-changed':
        return {
          type: 'archived.sessions.changed',
          sessionIds: stringArray(data.sessionIds ?? data.archivedSessionIds),
        }
      case 'host/remote-event':
        return {
          type: 'remote.event',
          name: stringOr(data.event ?? data.name, 'unknown'),
          args: array(data.args).map(safePayload),
        }
      case 'host/agent-error':
        return {
          type: 'notice',
          ...(sessionId === '' ? {} : { sessionId }),
          level: 'error',
          text: stringOr(data.message, 'DSH agent error.'),
        }
      case 'stream/error':
        return { type: 'connection.lost', reason: 'DSH event stream reported an error.' }
      default:
        return {
          type: 'unknown',
          ...(sessionId === '' ? {} : { sessionId }),
          name,
          payload: safePayload(value),
        }
    }
  },
}

/** Read only the pinned `values.permissions.options[].value` projection. */
export function permissionPresetIds(value: unknown): readonly string[] {
  const permissions = objectOrUndefined(objectOrUndefined(value)?.permissions)
  const options = array(permissions?.options)
  return [
    ...new Set(
      options.flatMap((entry) => {
        const option = objectOrUndefined(entry)
        return typeof option?.value === 'string' && option.value !== '' && option.value !== 'custom'
          ? [option.value]
          : []
      }),
    ),
  ]
}

function configuration(value: unknown): SessionDetail['configuration'] {
  const record = objectOrUndefined(value) ?? {}
  return {
    preset: stringOr(record.preset, 'standard'),
    toolMode: enumValue(record.toolMode, ['native', 'code', 'both'] as const, 'native'),
    permissionPreset: stringOr(record.permissionPreset, 'workspace-write'),
    planMode: boolean(record.planMode, false),
    ...(typeof record.sandboxMode === 'string' ? { sandboxMode: record.sandboxMode } : {}),
    ...(typeof record.approvalPolicy === 'string' ? { approvalPolicy: record.approvalPolicy } : {}),
    model: {
      providerId: stringOr(objectOrUndefined(record.model)?.providerId, ''),
      modelId: stringOr(objectOrUndefined(record.model)?.modelId, ''),
      ...(objectOrUndefined(record.model)?.reasoningLevel === undefined
        ? {}
        : { reasoningLevel: stringOr(objectOrUndefined(record.model)?.reasoningLevel, '') }),
    },
  }
}

function sessionConfiguration(sessionId: string, patch: SessionConfigurationPatch): BackendEvent {
  return { type: 'session.configuration', sessionId, patch }
}

function planMode(data: Record<string, unknown>): boolean {
  if (typeof data.active === 'boolean') return data.active
  if (typeof data.enabled === 'boolean') return data.enabled
  if (typeof data.on === 'boolean') return data.on
  const mode = stringOr(data.mode ?? data.value, '').toLowerCase()
  return mode === 'plan' || mode === 'on' || mode === 'active'
}

function modelPatch(data: Record<string, unknown>): Partial<ModelSelection> {
  const header = objectOrUndefined(data.header)
  const config = objectOrUndefined(header?.config) ?? objectOrUndefined(data.config)
  const provider = firstString(data.provider, data.providerId, config?.provider, config?.providerId)
  const model = firstString(data.model, data.modelId, config?.model, config?.modelId)
  const reasoningLevel = firstString(
    data.reasoningEffort,
    data.reasoningLevel,
    config?.reasoningEffort,
    config?.reasoningLevel,
  )
  return {
    ...(provider === undefined ? {} : { providerId: provider }),
    ...(model === undefined ? {} : { modelId: model }),
    ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
  }
}

function todo(value: unknown, index: number): TodoView {
  const record = objectOrUndefined(value) ?? {}
  const status = stringOr(record.status, 'pending')
  return {
    id: stringOr(record.id, `todo:${index}`),
    content: firstString(record.content, record.title, record.text) ?? 'Todo',
    status: status === 'completed' ? 'completed' : status === 'in_progress' ? 'in-progress' : 'pending',
  }
}

function compactionPhase(name: string): CompactionView['phase'] {
  if (name === 'compaction/summary') return 'summary'
  if (name === 'compaction/prune') return 'prune'
  if (name === 'compaction/end') return 'end'
  return 'start'
}

function safeEventSeqs(value: unknown): readonly number[] | undefined {
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is number => Number.isSafeInteger(entry) && (entry as number) >= 0)
  )
    return undefined
  return value
}

function nonNegativeSafeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function positiveSafeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function retryFailure(value: unknown): { readonly code: string; readonly message: string } {
  const failure = object(value, 'retry failure')
  return {
    code: string(failure.code, 'retry failure code'),
    message: string(failure.message, 'retry failure message'),
  }
}

function commandNotice(name: string, data: Record<string, unknown>, sessionId: string): BackendEvent {
  const commandName = firstString(data.name, data.commandName)
  const displayCommandName = commandName ?? 'DSH command'
  const commandId = firstString(data.commandId, data.id)
  const status = firstString(data.status, data.state, data.kind)
  const detail = firstString(data.message, data.text, data.summary)
  const commandInput = name === 'command/run' ? commandInputText(displayCommandName, data.args) : undefined
  return {
    type: 'notice',
    ...(sessionId === '' ? {} : { sessionId }),
    level: name === 'command/done' && (status === 'failed' || status === 'error') ? 'error' : 'info',
    text: commandNoticeText(name, displayCommandName, detail),
    ...(commandName === undefined ? {} : { commandName }),
    ...(commandId === undefined ? {} : { commandId }),
    commandPhase: name === 'command/run' ? 'run' : 'done',
    ...(commandInput === undefined ? {} : { commandInput }),
  }
}

/** Preserve the structured command/run input for the UI projection. This is
 * not re-parsed from rendered text and remains bounded before leaving the
 * adapter. */
function commandInputText(commandName: string, rawArgs: unknown): string | undefined {
  if (!/^[a-z][a-z0-9_-]*$/iu.test(commandName)) return undefined
  const args = typeof rawArgs === 'string' ? rawArgs.trimEnd() : ''
  const text = `/${commandName}${args}`
  return text.length > 4_096 ? text.slice(0, 4_096) : text
}

function commandNoticeText(name: string, commandName: string, detail: string | undefined): string {
  if (detail === undefined) return `${commandName} ${name === 'command/done' ? 'completed.' : 'started.'}`
  const permission = /^preset\s+(.+)$/iu.exec(detail)?.[1]?.trim()
  if (permission !== undefined && permission !== '')
    return `Permission changed to ${permissionPresetLabel(permission)}.`
  return detail
}

function permissionPresetLabel(value: string): string {
  switch (value.toLowerCase()) {
    case 'read-only':
      return 'Read only'
    case 'workspace-write':
      return 'Workspace write'
    case 'full-access':
    case 'danger-full-access':
      return 'Full access'
    default:
      return value.replace(/[-_]+/gu, ' ').replace(/\b\w/gu, (character) => character.toUpperCase())
  }
}

function workspaceId(data: Record<string, unknown>): string | undefined {
  const workspace = objectOrUndefined(data.workspace)
  return firstString(data.workspaceId, data.id, workspace?.workspaceId, workspace?.id)
}

function stringArray(value: unknown): readonly string[] {
  return array(value).filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
}

function mapHistoryEntry(value: unknown, index: number, sessionId: string): SessionHistoryEvent {
  const historyEntry = objectOrUndefined(value)
  // The pinned contract uses { event, view }, while accepting a raw event here
  // keeps history reopening compatible with older rc.6 hosts that returned the
  // event object directly.
  const rawEvent = objectOrUndefined(historyEntry?.event) ?? historyEntry
  const sequence = number(rawEvent?.seq ?? rawEvent?.sequence, index)
  const time = date(rawEvent?.time ?? rawEvent?.timestamp ?? rawEvent?.createdAt)
  const type = stringOr(rawEvent?.type ?? rawEvent?.name, 'unknown')
  try {
    const mapped = rc6Mapper.event(type, {
      ...(rawEvent ?? {}),
      sessionId,
      ...(historyEntry?.event === undefined || historyEntry.view === undefined
        ? {}
        : { view: historyEntry.view }),
    })
    return { sequence, time, event: { ...mapped, sequence } }
  } catch {
    // A single historical event must never make the whole session unusable.
    // Unknown rows are intentionally redacted by safePayload below.
    return {
      sequence,
      time,
      event: {
        type: 'unknown',
        name: type,
        payload: safePayload(value),
        sequence,
      },
    }
  }
}

function tool(value: Record<string, unknown>, phase: 'call' | 'result' = 'result'): ToolCallView {
  const message = objectOrUndefined(value.message)
  const source = objectOrUndefined(message?.source)
  const viewEnvelope = objectOrUndefined(value.view)
  const view = objectOrUndefined(viewEnvelope?.view) ?? viewEnvelope
  const presentation = toolPresentationView(viewEnvelope, phase)
  const error = objectOrUndefined(value.error)
  const input =
    value.inputSummary ??
    value.arguments ??
    view?.inputSummary ??
    view?.rawInput ??
    view?.description ??
    view?.content
  const messageOutput = message === undefined ? undefined : messageText(message)
  const output =
    value.outputSummary ??
    messageOutput ??
    view?.outputSummary ??
    view?.rawOutput ??
    view?.output ??
    view?.content
  const name = firstString(value.toolName, value.name, view?.name, view?.toolName)
  const title = firstString(value.title, view?.title, name)
  const category = firstString(value.category, view?.category, view?.kind, view?.card)
  const locations = toolLocations(value.locations ?? view?.locations)
  const status = enumValue(
    value.status,
    ['queued', 'running', 'completed', 'failed', 'cancelled'] as const,
    message === undefined ? 'running' : error !== undefined ? 'failed' : 'completed',
  )
  const turn = eventIndex(value.turn)
  const step = eventIndex(value.step)
  return {
    id: stringOr(value.callId ?? source?.callId ?? value.id ?? view?.callId ?? view?.id, 'tool-call'),
    ...(turn === undefined ? {} : { turn }),
    ...(step === undefined ? {} : { step }),
    name: name ?? 'unknown-tool',
    category: category ?? 'tool',
    title: title ?? 'Tool',
    status,
    ...(value.startedAt === undefined ? {} : { startedAt: date(value.startedAt) }),
    ...(value.completedAt === undefined ? {} : { completedAt: date(value.completedAt) }),
    ...(input === undefined ? {} : { inputSummary: bounded(input) }),
    ...(output === undefined ? {} : { outputSummary: bounded(output) }),
    ...(value.error === undefined ? {} : { error: bounded(error?.message ?? value.error) }),
    ...(locations === undefined ? {} : { locations }),
    ...(presentation === undefined ? {} : { presentation }),
    metadata: objectOrUndefined(safePayload(view)) ?? {},
  }
}

/**
 * Project the official DSH presentation union without importing upstream
 * types into the domain. The adapter accepts both the rc.8 durable wrapper
 * `{ for, view }` and the older/direct shape, then drops an invalid or future
 * card so the generic tool card remains usable on every supported version.
 */
function toolPresentationView(
  envelope: Record<string, unknown> | undefined,
  fallbackPhase: 'call' | 'result',
): ToolPresentationView | undefined {
  if (envelope === undefined) return undefined
  const candidate = objectOrUndefined(envelope.view) ?? envelope
  if (candidate === undefined || typeof candidate.card !== 'string') return undefined
  const phase = envelope.for === 'call' || envelope.for === 'result' ? envelope.for : fallbackPhase
  const card = candidate.card
  if (card === 'generic') return genericPresentation(candidate, phase)
  if (card === 'terminal') return terminalPresentation(candidate, phase)
  if (card === 'diff') return diffPresentation(candidate, phase)
  if (card === 'search' && phase === 'result') return searchPresentation(candidate)
  if (card === 'read' && phase === 'result') return readPresentation(candidate)
  if (card === 'web' && phase === 'result') return webPresentation(candidate)
  return undefined
}

function genericPresentation(value: Record<string, unknown>, phase: 'call' | 'result'): ToolPresentationView {
  const title = optionalText(value.title)
  const kind = optionalText(value.kind)
  const content = presentationContent(value.content)
  const locations = toolLocations(value.locations)
  if (phase === 'call') {
    const rawInput = presentationValue(value.rawInput)
    return {
      phase,
      card: 'generic',
      ...(title === undefined ? {} : { title }),
      ...(kind === undefined ? {} : { kind }),
      ...(rawInput === undefined ? {} : { rawInput }),
      ...(content === undefined ? {} : { content }),
      ...(locations === undefined ? {} : { locations }),
    }
  }
  return {
    phase,
    card: 'generic',
    ...(title === undefined ? {} : { title }),
    ...(kind === undefined ? {} : { kind }),
    ...(content === undefined ? {} : { content }),
  }
}

function terminalPresentation(
  value: Record<string, unknown>,
  phase: 'call' | 'result',
): ToolPresentationView | undefined {
  if (phase === 'call') {
    const title = requiredText(value.title)
    if (title === undefined) return undefined
    const description = optionalText(value.description)
    const cwd = safePath(value.cwd)
    return {
      phase,
      card: 'terminal',
      title,
      ...(description === undefined ? {} : { description }),
      ...(cwd === undefined ? {} : { cwd }),
    }
  }
  const title = optionalText(value.title)
  const output = optionalText(value.output)
  const exitCode = presentationExitCode(value.exitCode)
  const signal = optionalText(value.signal)
  if (title === undefined && output === undefined && exitCode === undefined && signal === undefined)
    return undefined
  return {
    phase,
    card: 'terminal',
    ...(title === undefined ? {} : { title }),
    ...(output === undefined ? {} : { output }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
  }
}

function diffPresentation(
  value: Record<string, unknown>,
  phase: 'call' | 'result',
): ToolPresentationView | undefined {
  const title = requiredText(value.title)
  if (phase === 'call' && title === undefined) return undefined
  const diffs = array(value.diffs).flatMap((entry) => {
    const diff = objectOrUndefined(entry)
    if (diff === undefined) return []
    const path = safePath(diff.path)
    const newText = requiredText(diff.newText)
    const oldText = diff.oldText === null ? null : requiredText(diff.oldText)
    if (path === undefined || newText === undefined || (diff.oldText !== null && oldText === undefined))
      return []
    const normalizedOldText: string | null = oldText === undefined ? null : oldText
    return [{ path, oldText: normalizedOldText, newText } satisfies ToolPresentationDiff]
  })
  if (diffs.length === 0) return undefined
  if (phase === 'call') {
    if (title === undefined) return undefined
    const locations = toolLocations(value.locations)
    return {
      phase,
      card: 'diff',
      title,
      diffs,
      ...(locations === undefined ? {} : { locations }),
    }
  }
  return {
    phase,
    card: 'diff',
    ...(title === undefined ? {} : { title }),
    diffs,
  }
}

function searchPresentation(value: Record<string, unknown>): ToolPresentationView | undefined {
  const shape = value.shape
  const title = optionalText(value.title)
  const truncated = value.truncated
  const total = nonNegativeCount(value.total)
  if (typeof truncated !== 'boolean' || total === undefined) return undefined
  if (shape === 'paths') {
    const paths = array(value.paths).flatMap((entry) => {
      const path = safePath(entry)
      return path === undefined ? [] : [path]
    })
    return {
      phase: 'result',
      card: 'search',
      shape: 'paths',
      ...(title === undefined ? {} : { title }),
      paths,
      truncated,
      total,
    }
  }
  if (shape !== 'matches') return undefined
  const files = array(value.files).flatMap((entry) => {
    const file = objectOrUndefined(entry)
    const path = safePath(file?.path)
    if (file === undefined || path === undefined) return []
    const matches = array(file.matches).flatMap((matchValue) => {
      const match = objectOrUndefined(matchValue)
      const lineNumber = positiveCount(match?.lineNumber)
      const line = lineText(match?.line)
      return lineNumber === undefined || line === undefined
        ? []
        : [{ lineNumber, line } satisfies ToolPresentationSearchMatch]
    })
    return [{ path, matches } satisfies ToolPresentationSearchFile]
  })
  return {
    phase: 'result',
    card: 'search',
    shape: 'matches',
    ...(title === undefined ? {} : { title }),
    files,
    truncated,
    total,
  }
}

function readPresentation(value: Record<string, unknown>): ToolPresentationView | undefined {
  const path = safePath(value.path)
  const offset = nonNegativeCount(value.offset)
  const totalLines = nonNegativeCount(value.totalLines)
  if (path === undefined || offset === undefined || totalLines === undefined) return undefined
  const lines = array(value.lines).flatMap((entry) => {
    const line = objectOrUndefined(entry)
    const number = positiveCount(line?.number)
    const text = lineText(line?.text)
    return number === undefined || text === undefined ? [] : [{ number, text } satisfies ToolPresentationLine]
  })
  const title = optionalText(value.title)
  const lang = optionalText(value.lang)
  const content = presentationContent(value.content)
  return {
    phase: 'result',
    card: 'read',
    ...(title === undefined ? {} : { title }),
    path,
    offset,
    lines,
    totalLines,
    ...(lang === undefined ? {} : { lang }),
    ...(content === undefined ? {} : { content }),
  }
}

function webPresentation(value: Record<string, unknown>): ToolPresentationView | undefined {
  const kind = value.kind
  const title = optionalText(value.title)
  const truncated = value.truncated
  if (typeof truncated !== 'boolean') return undefined
  if (kind === 'fetch') {
    const url = safeUrl(value.url)
    const statusCode = httpStatus(value.statusCode)
    if (url === undefined || statusCode === undefined) return undefined
    return {
      phase: 'result',
      card: 'web',
      kind: 'fetch',
      ...(title === undefined ? {} : { title }),
      url,
      statusCode,
      truncated,
    }
  }
  if (kind !== 'search') return undefined
  const sources = array(value.sources).flatMap((entry) => {
    const source = objectOrUndefined(entry)
    const url = safeUrl(source?.url)
    if (source === undefined || url === undefined) return []
    const sourceTitle = optionalText(source.title)
    const snippet = optionalText(source.snippet)
    const publishedAt = optionalText(source.publishedAt)
    return [
      {
        url,
        ...(sourceTitle === undefined ? {} : { title: sourceTitle }),
        ...(snippet === undefined ? {} : { snippet }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
      } satisfies ToolPresentationSource,
    ]
  })
  const answer = optionalText(value.answer)
  return {
    phase: 'result',
    card: 'web',
    kind: 'search',
    ...(title === undefined ? {} : { title }),
    sources,
    ...(answer === undefined ? {} : { answer }),
    truncated,
  }
}

function presentationContent(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const text = contentText(value, false)
  return text === '' ? undefined : [bounded(text)]
}

function presentationValue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return bounded(value)
  const sanitized = safePresentationValue(value)
  if (sanitized === undefined) return undefined
  const text = JSON.stringify(sanitized)
  return text === undefined ? undefined : text.slice(0, 4_096)
}

function safePresentationValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => safePresentationValue(entry, depth + 1))
  const record = objectOrUndefined(value)
  if (record === undefined) return undefined
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (isSensitivePresentationField(key)) continue
    const safe = safePresentationValue(entry, depth + 1)
    if (safe !== undefined) output[key] = safe
  }
  return output
}

const SENSITIVE_PRESENTATION_FIELDS = new Set([
  'authorization',
  'token',
  'secret',
  'password',
  'apikey',
  'accessToken',
  'refreshToken',
  'privateKey',
  'body',
  'response',
])

function isSensitivePresentationField(key: string): boolean {
  const normalized = key.replace(/[_-]/gu, '').toLocaleLowerCase()
  return [...SENSITIVE_PRESENTATION_FIELDS].some(
    (field) => field.replace(/[_-]/gu, '').toLocaleLowerCase() === normalized,
  )
}

function requiredText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? bounded(value) : undefined
}

function lineText(value: unknown): string | undefined {
  return typeof value === 'string' ? bounded(value) : undefined
}

function optionalText(value: unknown): string | undefined {
  return requiredText(value)
}

function safePath(value: unknown): string | undefined {
  const path = requiredText(value)
  return path === undefined || hasUnsafePathCharacters(path) ? undefined : path
}

function safeUrl(value: unknown): string | undefined {
  const url = requiredText(value)
  return url === undefined || hasUnsafePathCharacters(url) ? undefined : url
}

function nonNegativeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function positiveCount(value: unknown): number | undefined {
  const count = nonNegativeCount(value)
  return count === undefined || count === 0 ? undefined : count
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined
}

function presentationExitCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function toolLocations(
  value: unknown,
): readonly { readonly path: string; readonly line?: number }[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const locations: { path: string; line?: number }[] = []
  for (const entry of value) {
    const record = objectOrUndefined(entry)
    const path = record?.path
    if (
      typeof path !== 'string' ||
      path.trim() === '' ||
      path.length > 4_096 ||
      hasUnsafePathCharacters(path) ||
      seen.has(path)
    )
      continue
    seen.add(path)
    const line = eventIndex(record?.line)
    locations.push({ path, ...(line === undefined ? {} : { line }) })
    if (locations.length >= 32) break
  }
  return locations.length === 0 ? undefined : locations
}

function hasUnsafePathCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
  })
}

function turnEndReason(value: unknown): TurnEndReasonKind {
  const kind = objectOrUndefined(value)?.kind ?? value
  return kind === 'completed' ||
    kind === 'aborted' ||
    kind === 'blocked' ||
    kind === 'error' ||
    kind === 'max-tokens' ||
    kind === 'interrupted'
    ? kind
    : 'unknown'
}

/**
 * Preserve the rc.1 structured turn failure without forwarding provider-owned
 * metadata. Older hosts simply omit this field and keep the generic terminal
 * reason projection.
 */
function turnEndFailure(value: unknown): TurnEndFailure | undefined {
  const reason = objectOrUndefined(value)
  if (reason?.kind !== 'error') return undefined
  const failure = objectOrUndefined(reason.error)
  if (failure === undefined) return undefined
  const message = safeFailureText(failure.message)
  if (message === undefined) return undefined
  const code = safeFailureCode(failure.code)
  return { message, ...(code === undefined ? {} : { code }) }
}

function safeFailureText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const compact = value.replace(/\s+/gu, ' ').trim()
  if (compact === '') return undefined
  const redacted = compact.replace(
    /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret|private[_ -]?key|token|prompt|body|response)\b\s*[:=]\s*[^\s,;]+/giu,
    (match) => match.replace(/[:=].*$/u, ': [redacted]'),
  )
  return redacted.slice(0, 320)
}

function safeFailureCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(value) ? value : undefined
}

function goal(value: unknown): GoalView {
  const record = object(value, 'goal')
  return {
    id: stringOr(record.id, 'goal'),
    title: stringOr(record.title ?? record.objective, 'Goal'),
    status: enumValue(record.status, ['pending', 'in-progress', 'completed', 'blocked'] as const, 'pending'),
  }
}

function job(value: unknown): JobView {
  const record = object(value, 'job')
  const status = record.status
  if (
    status !== 'running' &&
    status !== 'stopping' &&
    status !== 'completed' &&
    status !== 'killed' &&
    status !== 'failed'
  )
    throw new Error('Malformed job status')
  const startedAt = nonNegativeSafeNumber(record.startedAt)
  if (startedAt === undefined) throw new Error('Malformed job startedAt')
  const finishedAt = record.finishedAt === undefined ? undefined : nonNegativeSafeNumber(record.finishedAt)
  if (record.finishedAt !== undefined && finishedAt === undefined) throw new Error('Malformed job finishedAt')
  if (record.detail !== undefined && typeof record.detail !== 'string')
    throw new Error('Malformed job detail')
  return {
    id: string(record.id, 'job id'),
    kind: string(record.kind, 'job kind'),
    label: string(record.label, 'job label'),
    status,
    ...(record.detail === undefined ? {} : { detail: record.detail }),
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
  }
}

function workflowMemberOutcome(value: unknown): 'completed' | 'failed' | 'cancelled' {
  if (value === 'completed' || value === 'failed' || value === 'cancelled') return value
  throw new Error('Malformed workflow member outcome')
}

function workflowStopReason(value: unknown): 'completed' | 'cancelled' | 'error' {
  if (value === 'completed' || value === 'cancelled' || value === 'error') return value
  throw new Error('Malformed workflow stop reason')
}

/** Project rc.8 experimental Team events into a bounded read-only activity row. */
function teamActivity(name: string, data: Record<string, unknown>): TeamActivityView | undefined {
  if (data.version !== 1 || typeof data.teamId !== 'string' || data.teamId.trim() === '') return undefined
  if (name === 'team/member') {
    const member = objectOrUndefined(data.member)
    if (
      member === undefined ||
      typeof member.id !== 'string' ||
      typeof member.name !== 'string' ||
      (member.phase !== 'provisioning' && member.phase !== 'active' && member.phase !== 'failed')
    )
      return undefined
    return {
      kind: 'member',
      id: `team:member:${data.teamId}:${member.id}`,
      teamId: data.teamId,
      memberId: member.id,
      name: bounded(member.name),
      phase: member.phase,
      ...(typeof member.error === 'string' ? { error: bounded(member.error) } : {}),
    }
  }
  if (name === 'team/task') {
    const task = objectOrUndefined(data.task)
    const blockedBy = task === undefined ? undefined : task.blockedBy
    const writeScopes = task === undefined ? undefined : task.writeScopes
    if (
      task === undefined ||
      typeof task.id !== 'string' ||
      typeof task.subject !== 'string' ||
      !teamTaskStatus(task.status) ||
      !stringArrayValue(blockedBy) ||
      !stringArrayValue(writeScopes)
    )
      return undefined
    return {
      kind: 'task',
      id: `team:task:${data.teamId}:${task.id}`,
      teamId: data.teamId,
      taskId: task.id,
      subject: bounded(task.subject),
      status: task.status,
      ...(typeof task.ownerId === 'string' ? { ownerId: task.ownerId } : {}),
      blockedByCount: blockedBy.length,
      writeScopeCount: writeScopes.length,
    }
  }
  if (name === 'team/message/queued') {
    const message = objectOrUndefined(data.message)
    const content = message === undefined ? undefined : message.content
    if (
      message === undefined ||
      typeof message.id !== 'string' ||
      typeof message.senderName !== 'string' ||
      typeof message.targetId !== 'string' ||
      (message.delivery !== 'quiet' && message.delivery !== 'wakeup') ||
      !Array.isArray(content)
    )
      return undefined
    return {
      kind: 'message.queued',
      id: `team:message:queued:${data.teamId}:${message.id}`,
      teamId: data.teamId,
      messageId: message.id,
      senderName: bounded(message.senderName),
      targetId: message.targetId,
      delivery: message.delivery,
      content: bounded(contentText(content, false)),
    }
  }
  if (name === 'team/message/delivered') {
    if (typeof data.messageId !== 'string' || typeof data.targetId !== 'string') return undefined
    return {
      kind: 'message.delivered',
      id: `team:message:delivered:${data.teamId}:${data.messageId}`,
      teamId: data.teamId,
      messageId: data.messageId,
      targetId: data.targetId,
    }
  }
  return undefined
}

function teamTaskStatus(value: unknown): value is 'pending' | 'in_progress' | 'completed' | 'deleted' {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'deleted'
}

function stringArrayValue(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function queuedInput(value: unknown, sessionId: string): QueuedInput[] {
  const record = objectOrUndefined(value)
  if (record === undefined || (record.placement !== 'queued' && record.placement !== 'steering')) return []
  const message = objectOrUndefined(record.message)
  if (message === undefined || typeof record.id !== 'string') return []
  const source = objectOrUndefined(message.source)
  const rpcId = firstString(message.rpcId, source?.rpcId)
  return [
    {
      id: record.id,
      sessionId,
      text: messageText(message),
      attachments: [],
      mode: record.placement === 'steering' ? 'steer' : 'queue',
      createdAt: date(record.createdAt),
      ...(rpcId === undefined ? {} : { rpcId }),
    },
  ]
}

function permission(value: Record<string, unknown>): PermissionRequest {
  return {
    id: stringOr(value.approvalId ?? value.id, 'approval'),
    ...(typeof value.rpcId === 'string' ? { rpcId: value.rpcId } : {}),
    sessionId: stringOr(value.sessionId, ''),
    title: stringOr(value.toolName, 'Permission required'),
    description: stringOr(value.reason, 'DSH requested permission to continue.'),
    ...(typeof value.commandLine === 'string' && value.commandLine.trim() !== ''
      ? { commandLine: value.commandLine.trim().slice(0, 4_096) }
      : {}),
    risk: 'medium',
    options: [
      { id: 'allowed-once', label: 'Allow once', kind: 'allow-once' },
      { id: 'rejected', label: 'Reject', kind: 'deny' },
    ],
  }
}

function question(value: Record<string, unknown>): UserQuestion {
  const questionRecords = array(value.questions)
    .map((entry) => objectOrUndefined(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
  const first = questionRecords[0] ?? value
  const items = questionRecords.map(questionItem)
  const firstItem = questionItem(first)
  const choices = firstItem.choices ?? []
  return {
    id: stringOr(first.id ?? value.id, 'question'),
    ...(typeof value.questionRpcId === 'string' || typeof value.rpcId === 'string'
      ? { rpcId: stringOr(value.questionRpcId ?? value.rpcId, '') }
      : {}),
    sessionId: stringOr(value.sessionId, ''),
    prompt: firstItem.prompt,
    ...(firstItem.detail === undefined ? {} : { detail: firstItem.detail }),
    ...(firstItem.header === undefined ? {} : { header: firstItem.header }),
    ...(choices.length === 0 ? {} : { choices }),
    ...(firstItem.multiSelect === undefined ? {} : { multiSelect: firstItem.multiSelect }),
    allowFreeText: firstItem.allowFreeText,
    ...(firstItem.intent === undefined ? {} : { intent: firstItem.intent }),
    ...(items.length === 0 ? {} : { items }),
  }
}

function questionItem(value: Record<string, unknown>): UserQuestionItem {
  const choices = array(value.options ?? value.choices)
    .map((entry) => objectOrUndefined(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => ({
      // rc.6 validates selected answers against option labels.
      id: stringOr(entry.label ?? entry.title, 'Choice'),
      label: stringOr(entry.label ?? entry.title, 'Choice'),
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
    }))
  const intent = planReviewIntent(value.intent)
  return {
    id: stringOr(value.id, 'question'),
    prompt: stringOr(value.question ?? value.prompt, 'DSH needs an answer.'),
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
    ...(typeof value.header === 'string' ? { header: value.header } : {}),
    ...(choices.length === 0 ? {} : { choices }),
    ...(value.multiSelect === undefined ? {} : { multiSelect: boolean(value.multiSelect, false) }),
    // rc.6 has no allowFreeText wire flag. The official generic question UI
    // always offers custom input; plan-review narrowing is presentation-only.
    allowFreeText: true,
    ...(intent === undefined ? {} : { intent }),
  }
}

/** Upstream intents are tagged; only known tags may reach the UI — an
 * unknown tag renders the generic option flow (answer encoding is
 * identical either way, so dropping it is presentation-only). */
function planReviewIntent(value: unknown): UserQuestionItem['intent'] | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const intent = value as Record<string, unknown>
  if (intent.kind !== 'plan-review' || typeof intent.approve !== 'string') return undefined
  return { kind: 'plan-review', approve: intent.approve }
}

function assistantMessageId(data: Record<string, unknown>, message?: Record<string, unknown>): string {
  const explicitId = [data.messageId, message?.id, data.id].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  )
  if (explicitId !== undefined) return explicitId
  const turn = indexToken(data.turn)
  const step = indexToken(data.step)
  if (turn !== undefined && step !== undefined) return `assistant:${turn}:${step}`
  return 'assistant:unknown'
}

function eventIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function indexToken(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value === 'string' && value.trim() !== '') return value
  return undefined
}

function messageText(value: Record<string, unknown> | undefined): string {
  if (value === undefined) return ''
  const content = array(value.content)
  if (content.length === 0) return stringOr(value.text ?? value.markdown ?? value.content, '')
  return contentText(content, false)
}

interface UserMessageContent {
  readonly markdown: string
  readonly attachments: readonly MessageAttachment[]
  readonly images: readonly MessageImageReference[]
}

/**
 * Project the user-facing part of a durable message without changing what
 * DSH received. rc.6 has no text-file attachment block: promptContent sends
 * text files as a deliberately marked text block so the model can read them.
 * Recognize only that exact adapter-owned envelope and keep its filename as
 * metadata; ordinary user text is left untouched.
 */
function userMessageContent(value: Record<string, unknown> | undefined): UserMessageContent {
  if (value === undefined) return { markdown: '', attachments: [], images: [] }
  const content = array(value.content)
  if (content.length === 0) {
    const text = stringOr(value.text ?? value.markdown ?? value.content, '')
    const parsed = attachedFileBlock(text)
    return parsed === undefined
      ? { markdown: text, attachments: [], images: [] }
      : { markdown: '', attachments: [{ name: parsed.name }], images: [] }
  }

  const textParts: string[] = []
  const attachments: MessageAttachment[] = []
  const images: MessageImageReference[] = []
  for (const entry of content) {
    const block = objectOrUndefined(entry)
    if (block?.type === 'text' && typeof block.text === 'string') {
      const parsed = attachedFileBlock(block.text)
      if (parsed !== undefined) {
        attachments.push({ name: parsed.name })
        continue
      }
      textParts.push(block.text)
      continue
    }
    if (block?.type === 'image') {
      const image = imageReference(block.attachment)
      if (image !== undefined) {
        images.push(image)
        continue
      }
    }
    const text = contentText([entry], false)
    if (text !== '') textParts.push(text)
  }
  return { markdown: textParts.join('\n'), attachments, images: uniqueImages(images) }
}

function messageImages(value: Record<string, unknown> | undefined): readonly MessageImageReference[] {
  if (value === undefined) return []
  const images: MessageImageReference[] = []
  for (const entry of array(value.content)) {
    const block = objectOrUndefined(entry)
    if (block?.type !== 'image') continue
    const image = imageReference(block.attachment)
    if (image !== undefined) images.push(image)
  }
  return uniqueImages(images)
}

function imageReference(value: unknown): MessageImageReference | undefined {
  const record = objectOrUndefined(value)
  if (record === undefined) return undefined
  const attachmentId = stringOr(record.attachmentId ?? record.id, '').trim()
  const mediaType = record.mediaType
  const bytes = positiveSafeInteger(record.bytes)
  const width = positiveSafeInteger(record.width)
  const height = positiveSafeInteger(record.height)
  if (
    attachmentId === '' ||
    (mediaType !== 'image/png' &&
      mediaType !== 'image/jpeg' &&
      mediaType !== 'image/webp' &&
      mediaType !== 'image/gif') ||
    bytes === undefined ||
    width === undefined ||
    height === undefined
  )
    return undefined
  const name = optionalText(record.name)
  return {
    attachmentId,
    mediaType,
    bytes,
    width,
    height,
    ...(name === undefined ? {} : { name }),
  }
}

function uniqueImages(images: readonly MessageImageReference[]): readonly MessageImageReference[] {
  const seen = new Set<string>()
  const result: MessageImageReference[] = []
  for (const image of images) {
    if (seen.has(image.attachmentId)) continue
    seen.add(image.attachmentId)
    result.push(image)
    if (result.length >= 32) break
  }
  return result
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

interface AttachedFileBlock {
  readonly name: string
}

const ATTACHED_FILE_BLOCK =
  /^\s*Attached file: ([^\r\n]+)\r?\n\r?\n[\s\S]*\r?\n\r?\nEnd of attached file: \1\s*$/u

function attachedFileBlock(value: string): AttachedFileBlock | undefined {
  const match = ATTACHED_FILE_BLOCK.exec(value)
  const name = match?.[1]?.trim()
  return name === undefined || name === '' ? undefined : { name }
}

function reasoningText(value: Record<string, unknown> | undefined): string {
  if (value === undefined) return ''
  return (
    contentText(array(value.content), true) ||
    stringOr(value.reasoning ?? value.reasoningContent ?? value.reasoning_content, '')
  )
}

function contentText(content: readonly unknown[], reasoningOnly: boolean): string {
  return content
    .map((entry) => {
      const block = objectOrUndefined(entry)
      if (block === undefined) return ''
      if (block.type === 'reasoning') return reasoningOnly ? stringOr(block.text, '') : ''
      if (reasoningOnly) return ''
      if (block.type === 'text') return stringOr(block.text, '')
      if (block.type === 'image') return imageReference(block.attachment) === undefined ? '[image]' : ''
      if (block.type === 'tool-result') {
        const nested = contentText(array(block.content), false)
        return nested || stringOr(block.text, '[tool result]')
      }
      if (block.type === 'tool-call') return ''
      return stringOr(block.text ?? block.value, '') || contentText(array(block.content), false)
    })
    .filter(Boolean)
    .join('\n')
}

function assistantModelLabel(
  message: Record<string, unknown>,
  envelope: Record<string, unknown>,
): string | undefined {
  const source = objectOrUndefined(message.source)
  const model = objectOrUndefined(message.model) ?? objectOrUndefined(envelope.model)
  return firstString(
    message.modelLabel,
    model?.label,
    model?.name,
    message.modelId,
    model?.modelId,
    typeof message.model === 'string' ? message.model : undefined,
    source?.model,
    source?.modelId,
    envelope.modelId,
    typeof envelope.model === 'string' ? envelope.model : undefined,
  )
}

function tokenUsage(value: unknown): TokenUsage | undefined {
  const record = objectOrUndefined(value)
  if (record === undefined) return undefined
  const inputTokens = tokenCount(record.inputTokens ?? record.uncachedInputTokens)
  const outputTokens = tokenCount(record.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const cacheReadTokens = tokenCount(record.cacheReadTokens)
  const cacheWriteTokens = tokenCount(record.cacheWriteTokens)
  const reasoningTokens = tokenCount(record.reasoningTokens)
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function object(value: unknown, label: string): Record<string, unknown> {
  const record = objectOrUndefined(value)
  if (record === undefined) throw new Error(`Malformed ${label}`)
  return record
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function validProjectionBlock(
  value: unknown,
): value is { readonly asOfSeq: number; readonly values: Record<string, unknown> } {
  const record = objectOrUndefined(value)
  return (
    record !== undefined &&
    Number.isSafeInteger(record.asOfSeq) &&
    (record.asOfSeq as number) >= -1 &&
    objectOrUndefined(record.values) !== undefined
  )
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Malformed ${label}`)
  return value
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim() !== '')
}

function normalizeSessionTitle(value: unknown): string {
  const title = stringOr(value, '').trim()
  if (title === '' || /^session\s+session-/i.test(title)) return 'New Session'
  return title
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function date(value: unknown): string {
  if (typeof value === 'string') return value
  const timestamp = number(value, Date.now())
  return new Date(timestamp).toISOString()
}

/** Preserve an event's real wall-clock boundary without manufacturing one. */
function eventTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : undefined
  }
  return undefined
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  fallback: T[number],
): T[number] {
  return typeof value === 'string' && values.includes(value) ? value : fallback
}

function bounded(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(safePayload(value))
  return (text ?? '').slice(0, 4_096)
}

function safePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 32).map(safePayload)
  if (typeof value !== 'object' || value === null)
    return typeof value === 'string' ? value.slice(0, 512) : value
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitivePayloadField(key)) continue
    output[key] = safePayload(entry)
  }
  return output
}

const SENSITIVE_PAYLOAD_FIELDS = new Set([
  'key',
  'apikey',
  'api_key',
  'authorization',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'token',
  'secret',
  'secretkey',
  'privatekey',
  'password',
  'prompt',
  'body',
  'response',
  'input',
  'output',
  'command',
  'commandline',
  'endpoint',
  'baseurl',
  'path',
  'cwd',
  'directory',
  'executable',
  'pid',
  'stack',
])

function isSensitivePayloadField(key: string): boolean {
  return SENSITIVE_PAYLOAD_FIELDS.has(key.toLocaleLowerCase())
}
