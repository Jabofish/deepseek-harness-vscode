import type {
  BackendEvent,
  CompactionView,
  GoalView,
  JobView,
  MessageAttachment,
  MessageImageReference,
  ModelDescriptor,
  ModelProvider,
  PermissionRequest,
  PresentedFileView,
  QueuedInput,
  SessionDetail,
  SessionConfigurationPatch,
  SessionHistoryEvent,
  SessionStatus,
  SessionSummary,
  SubagentCatalogEntryFact,
  TeamActivityView,
  TokenUsage,
  ToolCallView,
  TurnEndFailure,
  TurnEndReasonKind,
  UserQuestion,
  UserQuestionItem,
  WorkspaceSummary,
} from '@dsh-vscode/domain'

import { safePayload } from '../../redaction.js'
import {
  recordOrUndefined as objectOrUndefined,
  validProjectionBlock,
} from '../../repositories/shared/guards.js'
import { mapConfiguration, mapModelPatch, mapTodo, permissionPresetIds } from '../../projection/agent.js'
import { projectToolPresentation } from '../../projection/tool-presentation.js'

const CANONICAL_SESSION_EVENT_NAMES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/chunk',
  'assistant/message',
  'tool/call',
  'tool/result',
  'todo/write',
  'request/header',
  'request/context',
])

/**
 * The pinned session-event carrier validates only the common envelope because
 * the event vocabulary is merge-extensible. Validate the fixed event payloads
 * at the adapter boundary before mapping them into timeline state; otherwise a
 * malformed known event can become a synthetic id, empty message, or generic
 * tool and look like durable user activity.
 */
export function assertCanonicalSessionEvent(name: string, value: unknown): void {
  if (!CANONICAL_SESSION_EVENT_NAMES.has(name)) return
  const envelope = objectOrUndefined(value)
  const data = objectOrUndefined(envelope?.data)
  if (data === undefined) throw new Error(`Malformed ${name} data`)
  switch (name) {
    case 'turn/start':
      assertCanonicalEventIndex(data.turn, `${name} turn`)
      return
    case 'turn/end':
      assertCanonicalEventIndex(data.turn, `${name} turn`)
      assertCanonicalTurnEndReason(data.reason, name)
      return
    case 'step/start':
    case 'step/end':
      assertCanonicalEventIndex(data.turn, `${name} turn`)
      assertCanonicalEventIndex(data.step, `${name} step`)
      return
    case 'user/message':
      assertCanonicalMessage(data, 'user/message')
      return
    case 'assistant/chunk':
      assertCanonicalEventIndex(data.turn, `${name} turn`)
      assertCanonicalEventIndex(data.step, `${name} step`)
      assertCanonicalStreamChunk(data.chunk)
      return
    case 'assistant/message':
      assertCanonicalEventIndex(data.turn, `${name} turn`)
      assertCanonicalEventIndex(data.step, `${name} step`)
      assertCanonicalMessage(data.message, name)
      if (data.usage !== undefined) assertCanonicalTokenUsage(data.usage, `${name} usage`)
      return
    case 'tool/call':
      assertCanonicalEventIndex(data.turn, `${name} turn`)
      assertCanonicalEventIndex(data.step, `${name} step`)
      assertCanonicalNonEmptyString(data.callId, `${name} callId`)
      assertCanonicalString(data.name, `${name} name`)
      assertCanonicalString(data.arguments, `${name} arguments`)
      return
    case 'tool/result':
      assertCanonicalEventIndex(data.turn, `${name} turn`)
      assertCanonicalEventIndex(data.step, `${name} step`)
      assertCanonicalMessage(data.message, name)
      if (data.error !== undefined) {
        const error = objectOrUndefined(data.error)
        if (error === undefined) throw new Error(`Malformed ${name} error`)
        assertCanonicalString(error.name, `${name} error name`)
        assertCanonicalString(error.code, `${name} error code`)
      }
      return
    case 'todo/write':
      if (!Array.isArray(data.todos)) throw new Error(`Malformed ${name} todos`)
      return
    case 'request/header': {
      const header = object(data.header, `${name} header`)
      const config = object(header.config, `${name} config`)
      assertCanonicalNonEmptyString(config.provider, `${name} provider`)
      assertCanonicalNonEmptyString(config.model, `${name} model`)
      if (data.reason !== 'initial' && data.reason !== 'resume' && data.reason !== 'change')
        throw new Error(`Malformed ${name} reason`)
      return
    }
    case 'request/context':
      assertCanonicalNonEmptyString(data.provider, `${name} provider`)
      assertCanonicalNonEmptyString(data.model, `${name} model`)
      if (data.contextWindow !== undefined && !isFiniteNumber(data.contextWindow))
        throw new Error(`Malformed ${name} contextWindow`)
      return
  }
}

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
      configuration: mapConfiguration(record.configuration),
      ...(permissionPresets === undefined ? {} : { permissionPresets }),
      goalIds: record.goalIds === undefined ? [] : requiredStringArray(record.goalIds, 'session goalIds'),
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
    const events = record.events
      .map((entry, index) => mapHistoryEntry(entry, index, sessionId))
      // The v3 system/message is a model-facing prompt. The event's sequence
      // is still consumed by the live stream watermark, but the prompt itself
      // must never be copied into the Extension/Webview history DTO.
      .filter((entry) => entry.event.type !== 'session.system')
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
    // The pinned provider directory treats settingsPath as an atomic path.
    // Never filter malformed segments: changing the path changes which
    // settings object (and potentially which credential) the caller edits.
    const settingsPath = requiredArray(record.settingsPath, 'provider settingsPath').map((entry) => {
      if (typeof entry !== 'string' || entry.length === 0) throw new Error('Malformed provider settingsPath')
      return entry
    })
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
      // Addressless live routes have an intentional empty settingsNs marker;
      // do not let that marker become an empty UI kind.
      kind: firstString(record.kind, record.settingsNs) ?? 'provider',
      // `declared` means that the route was hand-declared by the deployment;
      // it does not mean that a shipped provider is read-only.  Upstream's
      // provider directory exposes every configured route to the Models page,
      // so only an explicit `configurable: false` can disable editing.
      configurable: boolean(record.configurable, true),
      ...(typeof record.active === 'boolean' ? { active: record.active } : {}),
      ...(typeof record.declared === 'boolean' ? { declared: record.declared } : {}),
      ...(typeof record.settingsNs === 'string' ? { settingsNs: record.settingsNs } : {}),
      settingsPath,
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
        return {
          type: 'session.status',
          sessionId,
          status:
            typeof data.status === 'string' ? data.status : boolean(data.running, false) ? 'running' : 'idle',
        }
      case 'host/session-status':
        if (sessionId === '' || typeof data.running !== 'boolean')
          throw new Error('Malformed host/session-status')
        return {
          type: 'session.status',
          sessionId,
          status: data.running ? 'running' : 'idle',
        }
      case 'session/activity':
      case 'host/session-activity': {
        const updatedAt = eventTimestamp(data.updatedAt)
        return updatedAt === undefined
          ? {
              type: 'unknown',
              ...(sessionId === '' ? {} : { sessionId }),
              name,
              payload: safePayload(value),
            }
          : { type: 'session.activity', sessionId, updatedAt }
      }
      case 'session/title':
        return {
          type: 'session.title',
          sessionId,
          title: stringOr(data.title ?? data.name, ''),
        }
      case 'system/message':
        // Keep only a sequence-bearing internal marker. Never project the
        // system prompt text or its message structure beyond the adapter.
        return { type: 'session.system', sessionId }
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
        const model = mapModelPatch(data)
        return Object.keys(model).length === 0
          ? { type: 'unknown', sessionId, name, payload: safePayload(value) }
          : sessionConfiguration(sessionId, { model })
      }
      case 'request/header': {
        const model = mapModelPatch(data)
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
      case 'deliverables/presented': {
        if (sessionId === '') throw new Error('Malformed deliverables/presented sessionId')
        const turn = positiveSafeNumber(data.turn)
        if (turn === undefined) throw new Error('Malformed deliverables/presented turn')
        const callId = safeStableIdentifier(data.callId, 'deliverables/presented callId')
        return {
          type: 'deliverables.presented',
          sessionId,
          turn,
          callId,
          files: presentedFiles(data.files),
        }
      }
      case 'subagent/catalog': {
        if (sessionId === '') throw new Error('Malformed subagent/catalog sessionId')
        return {
          type: 'subagent.catalog.updated',
          sessionId,
          entry: subagentCatalogEntry(data),
        }
      }
      case 'user/message': {
        const message = objectOrUndefined(data.message) ?? data
        const source = objectOrUndefined(message.source)
        const sourceLabel = stringOr(source?.kind ?? source?.type ?? message.source, '')
        const sourceForm = stringOr(source?.form, '')
        const sourceSummary = stringOr(source?.summary, '')
        const sessionReferenceLabels = structuredSessionReferenceLabels(source)
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
          ...(sessionReferenceLabels.length === 0 ? {} : { sessionReferenceLabels }),
        }
      }
      case 'tool/call':
      case 'tool/result': {
        const time = eventTimestamp(envelope.time ?? data.time)
        const message = objectOrUndefined(data.message)
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
              ...(message === undefined ? {} : { outputSummary: bounded(messageText(message)) }),
            },
            name === 'tool/call' ? 'call' : 'result',
          ),
        }
      }
      case 'approval/requested':
        if (
          sessionId === '' ||
          typeof data.approvalId !== 'string' ||
          data.approvalId.length === 0 ||
          typeof data.toolName !== 'string' ||
          (data.callId !== undefined && typeof data.callId !== 'string') ||
          (data.reason !== undefined && typeof data.reason !== 'string')
        )
          throw new Error('Malformed approval/requested')
        return {
          type: 'permission.requested',
          request: permission({
            ...data,
            sessionId,
            ...(envelope.rpcId === undefined ? {} : { rpcId: envelope.rpcId }),
          }),
        }
      case 'approval/resolved':
        if (
          sessionId === '' ||
          typeof data.approvalId !== 'string' ||
          data.approvalId.length === 0 ||
          !approvalOutcome(data.outcome)
        )
          throw new Error('Malformed approval/resolved')
        return {
          type: 'permission.resolved',
          sessionId,
          requestId: data.approvalId,
          outcome: data.outcome,
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
        if (
          sessionId === '' ||
          typeof data.questionRpcId !== 'string' ||
          data.questionRpcId.length === 0 ||
          (data.outcome !== 'answered' && data.outcome !== 'cancelled')
        )
          throw new Error('Malformed question/resolved')
        return {
          type: 'question.resolved',
          sessionId,
          questionRpcId: data.questionRpcId,
          outcome: data.outcome,
        }
      case 'goal/updated':
      case 'goal':
      case 'goal/change':
        return { type: 'goal.updated', sessionId, goals: goalEventGoals(name, data) }
      case 'todo/write':
        return {
          type: 'todo.updated',
          sessionId,
          todos: requiredArray(data.todos ?? data.items, 'todo/write todos').map((entry, index) =>
            mapTodo(entry, index),
          ),
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
      case 'session/tasks': {
        const entries = name === 'session/tasks' ? data.tasks : data.jobs
        if (!Array.isArray(entries))
          throw new Error(`Malformed ${name} ${name === 'session/tasks' ? 'tasks' : 'jobs'}`)
        return {
          type: 'jobs.updated',
          sessionId,
          jobs: entries.map(job),
        }
      }
      case 'tool/code-dispatch-start':
      case 'tool/ptc-dispatch-start':
        return { type: 'tool.updated', sessionId, tool: tool({ ...data, status: 'running' }, 'call') }
      case 'tool/code-dispatch':
      case 'tool/ptc-dispatch':
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
        // A malformed frame must fail closed like session/jobs: mapping it to
        // an empty queue would make the repository wipe the queue and every
        // queue-owner entry while the host still holds the items.
        if (!Array.isArray(data.items)) throw new Error('Malformed session/queue items')
        return {
          type: 'queue.updated',
          sessionId,
          items: data.items.flatMap((entry) => queuedInput(entry, sessionId)),
        }
      case 'session/subscribed':
        if (sessionId === '' || !safeSubscriptionSequence(data.lastSeq))
          throw new Error('Malformed session/subscribed lastSeq')
        if (data.projections !== undefined && !validProjectionBlock(data.projections))
          throw new Error('Malformed session/subscribed projections')
        if (data.projection !== undefined && !validProjectionBlock(data.projection))
          throw new Error('Malformed session/subscribed projection')
        {
          const projection = objectOrUndefined(data.projections ?? data.projection)
          return {
            type: 'session.subscribed',
            sessionId,
            lastSequence: data.lastSeq,
            ...(projection === undefined
              ? {}
              : {
                  projection: {
                    asOfSequence: projection.asOfSeq as number,
                    values: projection.values as Record<string, unknown>,
                  },
                }),
          }
        }
      case 'session/projection':
        if (
          sessionId === '' ||
          typeof data.key !== 'string' ||
          data.key.length === 0 ||
          !nonNegativeSafeSequence(data.seq) ||
          !Object.hasOwn(data, 'value')
        )
          throw new Error('Malformed session/projection')
        return {
          type: 'session.projection',
          sessionId,
          key: data.key,
          value: data.value,
        }
      case 'host/session-added':
        if (
          sessionId === '' ||
          typeof data.blank !== 'boolean' ||
          (data.parentSessionId !== undefined &&
            (typeof data.parentSessionId !== 'string' || data.parentSessionId.trim() === '')) ||
          (data.origin !== undefined && data.origin !== 'subagent') ||
          (data.cwd !== undefined && typeof data.cwd !== 'string') ||
          (data.agentPreset !== undefined && typeof data.agentPreset !== 'string')
        )
          throw new Error('Malformed host/session-added')
        return {
          type: 'session.added',
          sessionId,
          blank: data.blank,
          ...(data.parentSessionId === undefined ? {} : { parentSessionId: data.parentSessionId }),
          ...(data.origin === undefined ? {} : { origin: data.origin }),
          ...(data.cwd === undefined ? {} : { cwd: data.cwd }),
          ...(data.agentPreset === undefined ? {} : { agentPreset: data.agentPreset }),
        }
      case 'host/session-removed':
        if (sessionId === '') throw new Error('Malformed host/session-removed')
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
        return {
          type: 'workspace.order.changed',
          workspaceIds: requiredStringArray(data.workspaceIds ?? data.order, 'workspace order'),
        }
      case 'host/archived-sessions-changed':
        return {
          type: 'archived.sessions.changed',
          sessionIds: requiredStringArray(data.sessionIds ?? data.archivedSessionIds, 'archived session ids'),
        }
      case 'host/commands-changed':
        return { type: 'remote.event', name: 'commands/change', args: [] }
      case 'host/session-preset-changed':
        if (sessionId === '' || typeof data.agentPreset !== 'string')
          throw new Error('Malformed host/session-preset-changed')
        return {
          type: 'remote.event',
          name: 'agent-preset/selected',
          args: [sessionId, data.agentPreset],
        }
      case 'host/settings-changed':
        if (typeof data.ns !== 'string') throw new Error('Malformed host/settings-changed')
        return { type: 'remote.event', name: 'settings/document-updated', args: [data.ns] }
      case 'host/credentials-changed':
        if (typeof data.ref !== 'string') throw new Error('Malformed host/credentials-changed')
        return { type: 'remote.event', name: 'credentials/updated', args: [data.ref] }
      case 'host/models-changed':
        return { type: 'remote.event', name: 'llm/adapters-updated', args: [] }
      case 'host/remote-event': {
        const eventName = data.event ?? data.name
        if (typeof eventName !== 'string' || eventName.length === 0 || !Array.isArray(data.args))
          throw new Error('Malformed host/remote-event')
        return {
          type: 'remote.event',
          name: eventName,
          args: data.args.map(safePayload),
        }
      }
      case 'host/agent-error':
        if (sessionId === '' || typeof data.message !== 'string')
          throw new Error('Malformed host/agent-error')
        return {
          type: 'notice',
          sessionId,
          level: 'error',
          text: data.message.slice(0, 512),
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

function requiredStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`Malformed ${label}`)
  const entries: readonly unknown[] = value
  if (!entries.every((entry) => typeof entry === 'string' && entry.trim() !== ''))
    throw new Error(`Malformed ${label}`)
  return entries as readonly string[]
}

function approvalOutcome(value: unknown): value is 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' {
  return value === 'allowed-once' || value === 'rejected' || value === 'cancelled' || value === 'unavailable'
}

function safeSubscriptionSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1
}

function nonNegativeSafeSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function mapHistoryEntry(value: unknown, index: number, sessionId: string): SessionHistoryEvent {
  const historyEntry = objectOrUndefined(value)
  // The pinned contract uses { event, view }, while accepting a raw event here
  // keeps history reopening compatible with older rc.6 hosts that returned the
  // event object directly.
  const rawEvent = objectOrUndefined(historyEntry?.event) ?? historyEntry
  const sequenceKey =
    rawEvent === undefined
      ? undefined
      : Object.hasOwn(rawEvent, 'seq')
        ? 'seq'
        : Object.hasOwn(rawEvent, 'sequence')
          ? 'sequence'
          : undefined
  const rawSequence = rawEvent?.[sequenceKey ?? 'seq']
  const sequence =
    sequenceKey === undefined
      ? index
      : nonNegativeSafeSequence(rawSequence)
        ? rawSequence
        : (() => {
            throw new Error('Malformed session history sequence')
          })()
  const timeKey =
    rawEvent === undefined
      ? undefined
      : Object.hasOwn(rawEvent, 'time')
        ? 'time'
        : Object.hasOwn(rawEvent, 'timestamp')
          ? 'timestamp'
          : Object.hasOwn(rawEvent, 'createdAt')
            ? 'createdAt'
            : undefined
  const parsedTime = validHistoryTime(rawEvent?.[timeKey ?? 'time'])
  const time =
    timeKey === undefined
      ? date(undefined)
      : parsedTime === undefined
        ? (() => {
            throw new Error('Malformed session history time')
          })()
        : parsedTime
  const type = stringOr(rawEvent?.type ?? rawEvent?.name, 'unknown')
  try {
    assertCanonicalSessionEvent(type, {
      ...(rawEvent ?? {}),
      sessionId,
    })
    const mapped = rc6Mapper.event(type, {
      ...(rawEvent ?? {}),
      sessionId,
      ...(historyEntry?.event === undefined || historyEntry.view === undefined
        ? {}
        : { view: historyEntry.view }),
    })
    return { sequence, time, event: { ...mapped, sequence } }
  } catch {
    // A malformed event payload must never make the whole session unusable.
    // Structural sequence/time corruption was rejected above; unknown rows
    // here are intentionally redacted by safePayload below.
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

function assertCanonicalEventIndex(value: unknown, label: string): void {
  if (eventIndex(value) === undefined) throw new Error(`Malformed ${label}`)
}

function assertCanonicalString(value: unknown, label: string): void {
  if (typeof value !== 'string') throw new Error(`Malformed ${label}`)
}

function assertCanonicalNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Malformed ${label}`)
}

function assertCanonicalTurnEndReason(value: unknown, name: string): void {
  const reason = objectOrUndefined(value)
  if (reason === undefined || typeof reason.kind !== 'string' || reason.kind.length === 0)
    throw new Error(`Malformed ${name} reason`)
  if (reason.kind === 'aborted') {
    const cancellation = objectOrUndefined(reason.reason)
    if (cancellation === undefined || typeof cancellation.kind !== 'string' || cancellation.kind.length === 0)
      throw new Error(`Malformed ${name} reason`)
  }
  if (reason.kind === 'error') {
    const failure = objectOrUndefined(reason.error)
    if (
      failure === undefined ||
      typeof failure.message !== 'string' ||
      typeof failure.code !== 'string' ||
      failure.code.length === 0
    )
      throw new Error(`Malformed ${name} reason`)
  }
}

function assertCanonicalMessage(value: unknown, name: string): void {
  const message = objectOrUndefined(value)
  if (message === undefined || typeof message.id !== 'string' || message.id.length === 0)
    throw new Error(`Malformed ${name} message`)
  const expectedRole = name === 'assistant/message' ? 'assistant' : 'user'
  if (message.role !== expectedRole) throw new Error(`Malformed ${name} message role`)
  const source = objectOrUndefined(message.source)
  if (source === undefined || typeof source.kind !== 'string' || source.kind.length === 0)
    throw new Error(`Malformed ${name} message source`)
  assertCanonicalContentBlocks(message.content, `${name} message content`)
  if (name === 'assistant/message') {
    if (source.kind !== 'model') throw new Error(`Malformed ${name} message source`)
    assertCanonicalNonEmptyString(source.provider, `${name} message provider`)
    assertCanonicalNonEmptyString(source.model, `${name} message model`)
    return
  }
  if (name !== 'tool/result') return
  if (source.kind !== 'tool') throw new Error(`Malformed ${name} message source`)
  assertCanonicalNonEmptyString(source.callId, `${name} message callId`)
  const block = objectOrUndefined(message.content[0])
  if (
    message.content.length !== 1 ||
    block === undefined ||
    block.type !== 'tool-result' ||
    !Array.isArray(block.content) ||
    block.toolCallId !== source.callId
  )
    throw new Error(`Malformed ${name} message content`)
}

/**
 * Validate the core content blocks without closing the merge-extensible
 * content vocabulary. Unknown block types are left opaque for forward
 * compatibility, while a known image/tool block must not be accepted and
 * then silently disappear in the presentation mapper.
 */
function assertCanonicalContentBlocks(value: unknown, label: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Malformed ${label}`)
  for (const entry of value) {
    const block = objectOrUndefined(entry)
    if (block === undefined || typeof block.type !== 'string' || block.type.length === 0)
      throw new Error(`Malformed ${label}`)
    switch (block.type) {
      case 'text':
      case 'reasoning':
        assertCanonicalString(block.text, `${label} ${block.type} text`)
        break
      case 'image':
        assertCanonicalImageReference(block.attachment, `${label} image attachment`)
        break
      case 'tool-call':
        assertCanonicalNonEmptyString(block.id, `${label} tool-call id`)
        assertCanonicalString(block.name, `${label} tool-call name`)
        assertCanonicalString(block.arguments, `${label} tool-call arguments`)
        break
      case 'tool-result':
        assertCanonicalNonEmptyString(block.toolCallId, `${label} tool-result call id`)
        assertCanonicalContentBlocks(block.content, `${label} tool-result content`)
        if (block.isError !== undefined && typeof block.isError !== 'boolean')
          throw new Error(`Malformed ${label} tool-result isError`)
        break
    }
  }
}

function assertCanonicalImageReference(value: unknown, label: string): void {
  const attachment = objectOrUndefined(value)
  if (
    attachment === undefined ||
    typeof attachment.attachmentId !== 'string' ||
    attachment.attachmentId.trim() === '' ||
    (attachment.mediaType !== 'image/png' &&
      attachment.mediaType !== 'image/jpeg' &&
      attachment.mediaType !== 'image/webp' &&
      attachment.mediaType !== 'image/gif') ||
    positiveSafeNumber(attachment.bytes) === undefined ||
    positiveSafeNumber(attachment.width) === undefined ||
    positiveSafeNumber(attachment.height) === undefined ||
    (attachment.name !== undefined && typeof attachment.name !== 'string')
  )
    throw new Error(`Malformed ${label}`)
}

function assertCanonicalStreamChunk(value: unknown): void {
  const chunk = objectOrUndefined(value)
  if (chunk === undefined || typeof chunk.type !== 'string')
    throw new Error('Malformed assistant/chunk chunk')
  switch (chunk.type) {
    case 'block-start':
      assertCanonicalEventIndex(chunk.index, 'assistant/chunk index')
      assertCanonicalString(chunk.blockType, 'assistant/chunk blockType')
      return
    case 'text-delta':
    case 'reasoning-delta':
      assertCanonicalEventIndex(chunk.index, 'assistant/chunk index')
      assertCanonicalString(chunk.text, `assistant/chunk ${chunk.type} text`)
      return
    case 'tool-call-delta':
      assertCanonicalEventIndex(chunk.index, 'assistant/chunk index')
      assertCanonicalNonEmptyString(chunk.id, 'assistant/chunk tool call id')
      assertCanonicalString(chunk.argumentsDelta, 'assistant/chunk argumentsDelta')
      if (chunk.name !== undefined) assertCanonicalString(chunk.name, 'assistant/chunk tool name')
      return
    case 'block-end': {
      assertCanonicalEventIndex(chunk.index, 'assistant/chunk index')
      const block = objectOrUndefined(chunk.block)
      if (block === undefined || typeof block.type !== 'string')
        throw new Error('Malformed assistant/chunk block')
      return
    }
    case 'usage':
      assertCanonicalTokenUsage(chunk.usage, 'assistant/chunk usage')
      return
    case 'finish': {
      const reason = objectOrUndefined(chunk.reason)
      if (reason === undefined || typeof reason.kind !== 'string' || reason.kind.length === 0)
        throw new Error('Malformed assistant/chunk finish reason')
      return
    }
    default:
      throw new Error('Malformed assistant/chunk chunk')
  }
}

function assertCanonicalTokenUsage(value: unknown, label: string): void {
  const usage = objectOrUndefined(value)
  if (
    usage === undefined ||
    tokenCount(usage.inputTokens) === undefined ||
    tokenCount(usage.outputTokens) === undefined
  )
    throw new Error(`Malformed ${label}`)
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    if (usage[key] !== undefined && tokenCount(usage[key]) === undefined)
      throw new Error(`Malformed ${label}`)
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function tool(value: Record<string, unknown>, phase: 'call' | 'result' = 'result'): ToolCallView {
  const message = objectOrUndefined(value.message)
  const source = objectOrUndefined(message?.source)
  const isPtcDispatch = typeof value.subCallId === 'string' || typeof value.parentCallId === 'string'
  const messageIsError = value.isError === true || messageHasToolError(message)
  const viewEnvelope = objectOrUndefined(value.view)
  const view = objectOrUndefined(viewEnvelope?.view) ?? viewEnvelope
  const presentation = projectToolPresentation(viewEnvelope, phase, contentText)
  const error = objectOrUndefined(value.error)
  const input =
    value.inputSummary ??
    value.arguments ??
    view?.inputSummary ??
    view?.rawInput ??
    view?.description ??
    view?.content
  const messageOutput =
    message === undefined
      ? isPtcDispatch && Array.isArray(value.content)
        ? contentText(value.content, false)
        : undefined
      : messageText(message)
  const messageError = message === undefined ? '' : messageToolErrorText(message)
  const output =
    value.outputSummary ??
    messageOutput ??
    view?.outputSummary ??
    view?.rawOutput ??
    view?.output ??
    view?.content
  const errorText = toolErrorText(value.error, error, messageIsError, messageError, messageOutput)
  const mappedStatus = enumValue(
    value.status,
    ['queued', 'running', 'completed', 'failed', 'cancelled'] as const,
    message === undefined ? 'running' : errorText !== undefined || messageIsError ? 'failed' : 'completed',
  )
  const name = firstString(value.toolName, value.name, view?.name, view?.toolName)
  const title = firstString(value.title, view?.title, name)
  const category = firstString(value.category, view?.category, view?.kind, view?.card)
  const locations = toolLocations(value.locations ?? view?.locations)
  const status =
    (errorText !== undefined || messageIsError) && mappedStatus !== 'cancelled' ? 'failed' : mappedStatus
  const turn = eventIndex(value.turn)
  const step = eventIndex(value.step)
  const parentCallId = firstString(value.parentCallId)
  return {
    id: stringOr(
      value.callId ?? source?.callId ?? value.subCallId ?? value.id ?? view?.callId ?? view?.id,
      'tool-call',
    ),
    ...(parentCallId === undefined ? {} : { parentCallId }),
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
    ...(errorText === undefined || errorText === '' ? {} : { error: errorText }),
    ...(locations === undefined ? {} : { locations }),
    ...(presentation === undefined ? {} : { presentation }),
    metadata: objectOrUndefined(safePayload(view)) ?? {},
  }
}

/**
 * DSH persists a tool failure as a small identity object and keeps the
 * human-readable text in the error-marked tool-result message. Prefer that
 * replay-authoritative text; only fall back to a single identity field so
 * `{name, code}` never becomes a misleading JSON sentence in the timeline.
 */
function toolErrorText(
  value: unknown,
  identity: Record<string, unknown> | undefined,
  messageIsError: boolean,
  messageError: string,
  messageOutput: string | undefined,
): string | undefined {
  if (value !== undefined) {
    const explicit = typeof value === 'string' ? value : identity?.message
    const explicitText = optionalText(explicit)
    if (explicitText !== undefined) return explicitText
    if (messageIsError) {
      const messageTextValue = optionalText(messageError) ?? optionalText(messageOutput)
      if (messageTextValue !== undefined) return messageTextValue
    }
    const identityText = optionalText(identity?.code) ?? optionalText(identity?.name)
    if (identityText !== undefined) return identityText
    if (typeof value === 'number' || typeof value === 'boolean') return bounded(value)
    return undefined
  }
  if (!messageIsError) return undefined
  return optionalText(messageError) ?? optionalText(messageOutput)
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

/** Map the explicit DSH file-delivery payload without exposing arbitrary JSON. */
function presentedFiles(value: unknown): readonly PresentedFileView[] {
  const entries = requiredArray(value, 'deliverables/presented files')
  if (entries.length === 0 || entries.length > 128)
    throw new Error('Malformed deliverables/presented files count')
  return entries.map((entry) => {
    const file = object(entry, 'deliverables/presented file')
    const path = safePresentedPath(file.path)
    const description = safePresentedDescription(file.description)
    return { path, ...(description === undefined ? {} : { description }) }
  })
}

function safePresentedPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > 4_096 ||
    hasUnsafePathCharacters(value)
  )
    throw new Error('Malformed deliverables/presented path')
  return value
}

function safePresentedDescription(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 4_096 || hasUnsafePathCharacters(value))
    throw new Error('Malformed deliverables/presented description')
  return value
}

function safeStableIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > 512 ||
    hasUnsafePathCharacters(value)
  )
    throw new Error(`Malformed ${label}`)
  return value
}

function subagentCatalogEntry(data: Record<string, unknown>): SubagentCatalogEntryFact {
  if (data.version !== 0) throw new Error('Malformed subagent/catalog version')
  const id = safeStableIdentifier(data.childId, 'subagent/catalog childId')
  const createdAt = nonNegativeSafeNumber(data.childCreatedAt)
  if (createdAt === undefined) throw new Error('Malformed subagent/catalog childCreatedAt')
  if (data.mode !== 'one-shot' && data.mode !== 'continuable')
    throw new Error('Malformed subagent/catalog mode')
  const hasLabel = Object.hasOwn(data, 'label')
  const label = hasLabel ? safeCatalogLabel(data.label, data.mode === 'continuable') : undefined
  if (data.mode === 'continuable' && label === undefined)
    throw new Error('Malformed subagent/catalog continuable label')
  return {
    id,
    createdAt,
    mode: data.mode,
    ...(label === undefined ? {} : { label }),
  }
}

function safeCatalogLabel(value: unknown, required: boolean): string | undefined {
  if (
    typeof value !== 'string' ||
    (required && value.trim() === '') ||
    value.length > 4_096 ||
    hasUnsafePathCharacters(value)
  )
    throw new Error('Malformed subagent/catalog label')
  return value
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
  const maxGoalRounds =
    record.maxGoalRounds === undefined ? undefined : positiveSafeNumber(record.maxGoalRounds)
  if (record.maxGoalRounds !== undefined && maxGoalRounds === undefined)
    throw new Error('Malformed goal maxGoalRounds')
  const status =
    record.status === undefined
      ? goalPhaseStatus(record.phase)
      : enumValue(record.status, ['pending', 'in-progress', 'completed', 'blocked'] as const, 'pending')
  return {
    id: stringOr(record.id, 'goal'),
    title: stringOr(record.title ?? record.objective, 'Goal'),
    status,
    ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
  }
}

/**
 * Project both the legacy whole-list goal event and the pinned goal/change
 * full-snapshot event into the small GoalView used by the UI. The rc.6 host
 * emits one post-mutation snapshot (or a clear tombstone), never `goals[]`.
 */
function goalEventGoals(name: string, data: Record<string, unknown>): readonly GoalView[] {
  if (name === 'goal/change') {
    validateCanonicalGoalChange(data)
    if (data.operation === 'clear') {
      return []
    }
    return [goal(data.goal)]
  }
  if (data.cleared === true) return []
  if (Array.isArray(data.goals)) return data.goals.map(goal)
  if (data.goal !== undefined) return [goal(data.goal)]
  return []
}

function validateCanonicalGoalChange(data: Record<string, unknown>): void {
  if (data.kind !== 'goal/change' || data.version !== 1) throw new Error('Malformed goal/change envelope')
  if (data.operation === 'clear') {
    if (!hasOnlyKeys(data, ['cleared', 'clearedAt', 'kind', 'operation', 'version']))
      throw new Error('Malformed goal/change clear tombstone')
    const cleared = objectOrUndefined(data.cleared)
    const clearedAt = nonNegativeSafeNumber(data.clearedAt)
    if (
      cleared === undefined ||
      !hasOnlyKeys(cleared, ['id', 'revision']) ||
      typeof cleared.id !== 'string' ||
      cleared.id.length === 0 ||
      positiveSafeNumber(cleared.revision) === undefined ||
      clearedAt === undefined
    )
      throw new Error('Malformed goal/change clear tombstone')
    return
  }
  if (
    data.operation !== 'create' &&
    data.operation !== 'edit' &&
    data.operation !== 'pause' &&
    data.operation !== 'resume' &&
    data.operation !== 'complete' &&
    data.operation !== 'block'
  )
    throw new Error('Malformed goal/change operation')
  if (!hasOnlyKeys(data, ['createdAt', 'goal', 'kind', 'operation', 'roundsStarted', 'updatedAt', 'version']))
    throw new Error('Malformed goal/change envelope')
  const createdAt = nonNegativeSafeNumber(data.createdAt)
  const updatedAt = nonNegativeSafeNumber(data.updatedAt)
  const roundsStarted = nonNegativeSafeNumber(data.roundsStarted)
  if (
    createdAt === undefined ||
    updatedAt === undefined ||
    roundsStarted === undefined ||
    updatedAt < createdAt
  )
    throw new Error('Malformed goal/change timestamps')
  validateCanonicalGoalSnapshot(data.goal)
}

function validateCanonicalGoalSnapshot(value: unknown): void {
  const record = objectOrUndefined(value)
  if (
    record === undefined ||
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    typeof record.objective !== 'string' ||
    record.objective.trim() === '' ||
    record.objective !== record.objective.trim() ||
    (record.phase !== 'active' &&
      record.phase !== 'paused' &&
      record.phase !== 'blocked' &&
      record.phase !== 'complete') ||
    positiveSafeNumber(record.revision) === undefined ||
    positiveSafeNumber(record.maxGoalRounds) === undefined
  )
    throw new Error('Malformed goal/change goal')
  const expectedKeys =
    record.phase === 'blocked'
      ? ['blockedReason', 'id', 'maxGoalRounds', 'objective', 'phase', 'revision']
      : ['id', 'maxGoalRounds', 'objective', 'phase', 'revision']
  if (!hasOnlyKeys(record, expectedKeys)) throw new Error('Malformed goal/change goal')
  if (record.phase !== 'blocked') return
  const reason = objectOrUndefined(record.blockedReason)
  if (
    reason === undefined ||
    !hasOnlyKeys(reason, ['code', 'message']) ||
    typeof reason.code !== 'string' ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(reason.code) ||
    typeof reason.message !== 'string' ||
    reason.message.trim() === '' ||
    reason.message !== reason.message.trim()
  )
    throw new Error('Malformed goal/change goal')
}

function hasOnlyKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actualKeys = Object.keys(record).sort()
  const expectedKeys = [...expected].sort()
  return (
    actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index])
  )
}

function goalPhaseStatus(value: unknown): GoalView['status'] {
  switch (value) {
    case 'active':
      return 'in-progress'
    case 'paused':
      return 'pending'
    case 'complete':
      return 'completed'
    case 'blocked':
      return 'blocked'
    default:
      return 'pending'
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
  if (
    record === undefined ||
    (record.placement !== 'queued' && record.placement !== 'steering' && record.placement !== 'context')
  )
    throw new Error('Malformed session/queue item')
  const message = objectOrUndefined(record.message)
  if (
    message === undefined ||
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    typeof message.id !== 'string' ||
    message.id.length === 0 ||
    (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') ||
    !Array.isArray(message.content) ||
    !message.content.every((entry) => {
      const block = objectOrUndefined(entry)
      return block !== undefined && typeof block.type === 'string'
    }) ||
    !isMessageSource(message.source)
  )
    throw new Error('Malformed session/queue item')
  try {
    assertCanonicalContentBlocks(message.content, 'session/queue message content')
  } catch {
    throw new Error('Malformed session/queue item')
  }
  if (record.placement === 'context') return []
  const source = objectOrUndefined(message.source)
  const rpcId = firstString(message.rpcId, source?.rpcId)
  const images = messageImages(message)
  return [
    {
      id: record.id,
      sessionId,
      text: messageText(message),
      attachments: [],
      ...(images.length === 0 ? {} : { images }),
      mode: record.placement === 'steering' ? 'steer' : 'queue',
      createdAt: date(record.createdAt),
      ...(rpcId === undefined ? {} : { rpcId }),
    },
  ]
}

function isMessageSource(value: unknown): value is Record<string, unknown> {
  const source = objectOrUndefined(value)
  return source !== undefined && typeof source.kind === 'string'
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
  const rawQuestions = requiredArray(value.questions, 'question/requested questions')
  if (rawQuestions.length === 0) throw new Error('Malformed question/requested questions')
  const items = rawQuestions.map((entry) => questionItem(object(entry, 'question item')))
  const firstItem = items[0]
  if (firstItem === undefined) throw new Error('Malformed question/requested questions')
  const choices = firstItem.choices ?? []
  return {
    id: firstItem.id,
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
  const rawOptions = Object.hasOwn(value, 'options') ? value.options : value.choices
  const choices =
    rawOptions === undefined
      ? []
      : requiredArray(rawOptions, 'question options').map((entry) => {
          const option = object(entry, 'question option')
          const label = requiredQuestionString(option.label ?? option.title, 'question option label')
          return {
            // rc.6 validates selected answers against option labels.
            id: label,
            label,
            ...(option.description === undefined
              ? {}
              : { description: requiredQuestionString(option.description, 'question option description') }),
          }
        })
  const intent = planReviewIntent(value.intent)
  return {
    id: requiredQuestionString(value.id, 'question id'),
    prompt: requiredQuestionString(
      Object.hasOwn(value, 'question') ? value.question : value.prompt,
      'question id or question',
    ),
    ...(value.detail === undefined
      ? {}
      : { detail: requiredQuestionString(value.detail, 'question detail') }),
    ...(value.header === undefined
      ? {}
      : { header: requiredQuestionString(value.header, 'question header') }),
    ...(choices.length === 0 ? {} : { choices }),
    ...(value.multiSelect === undefined
      ? {}
      : { multiSelect: requiredQuestionBoolean(value.multiSelect, 'question multiSelect') }),
    // rc.6 has no allowFreeText wire flag. The official generic question UI
    // always offers custom input; plan-review narrowing is presentation-only.
    allowFreeText: true,
    ...(intent === undefined ? {} : { intent }),
  }
}

/** Upstream intents are a strict tagged union; unknown tags must not be
 * silently rendered as a generic question. */
function planReviewIntent(value: unknown): UserQuestionItem['intent'] | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed question intent')
  const intent = value as Record<string, unknown>
  if (intent.kind !== 'plan-review' || typeof intent.approve !== 'string')
    throw new Error('Malformed question intent')
  return { kind: 'plan-review', approve: intent.approve }
}

function requiredQuestionString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Malformed ${label}`)
  return value
}

function requiredQuestionBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Malformed ${label}`)
  return value
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
  const content = contentEntries(value.content)
  if (content.length === 0) return stringOr(value.text ?? value.markdown ?? value.content, '')
  return contentText(content, false)
}

function messageHasToolError(value: Record<string, unknown> | undefined): boolean {
  if (value?.isError === true) return true
  return contentEntries(value?.content).some((entry) => {
    const block = objectOrUndefined(entry)
    return block?.type === 'tool-result' && block.isError === true
  })
}

function messageToolErrorText(value: Record<string, unknown>): string {
  const errorBlock = contentEntries(value.content)
    .map((entry) => objectOrUndefined(entry))
    .find((block) => block?.type === 'tool-result' && block.isError === true)
  if (errorBlock !== undefined) {
    const content = contentText(contentEntries(errorBlock.content), false)
    if (content !== '') return content
    const direct = stringOr(errorBlock.text ?? errorBlock.message, '')
    if (direct !== '') return direct
  }
  return messageText(value)
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

/**
 * Keep only the labels needed to render the upstream session-reference chip.
 * The durable source also carries capture statistics and session ids; those
 * stay on the Host side and never cross into the Webview projection.
 */
function structuredSessionReferenceLabels(source: Record<string, unknown> | undefined): readonly string[] {
  if (source?.kind !== 'session-reference') return []
  if (!Array.isArray(source.references) || source.references.length > 32)
    throw new Error('Malformed session-reference references')
  const labels: string[] = []
  for (const entry of source.references) {
    const reference = objectOrUndefined(entry)
    if (
      reference === undefined ||
      typeof reference.sessionId !== 'string' ||
      reference.sessionId.trim() === '' ||
      reference.sessionId.length > 512 ||
      typeof reference.label !== 'string' ||
      reference.label.trim() === '' ||
      reference.label.length > 512
    )
      throw new Error('Malformed session-reference entry')
    if (!labels.includes(reference.label)) labels.push(reference.label)
  }
  return labels
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
    contentText(contentEntries(value.content), true) ||
    stringOr(value.reasoning ?? value.reasoningContent ?? value.reasoning_content, '')
  )
}

function contentText(content: readonly unknown[], reasoningOnly: boolean): string {
  return content
    .map((entry) => {
      if (typeof entry === 'string') return reasoningOnly ? '' : entry
      const block = objectOrUndefined(entry)
      if (block === undefined) return ''
      if (block.type === 'reasoning') return reasoningOnly ? stringOr(block.text, '') : ''
      if (reasoningOnly) return ''
      if (block.type === 'text') return stringOr(block.text, '')
      if (block.type === 'image') return imageReference(block.attachment) === undefined ? '[image]' : ''
      if (block.type === 'tool-result') {
        const nested = contentText(contentEntries(block.content), false)
        return nested || stringOr(block.text ?? block.message, '[tool result]')
      }
      if (block.type === 'tool-call') return ''
      return stringOr(block.text ?? block.value, '') || contentText(contentEntries(block.content), false)
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

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function requiredArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Malformed ${label}`)
  return value
}

function contentEntries(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value
  return typeof value === 'string' ? [value] : []
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Malformed ${label}`)
  return value
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? bounded(value) : undefined
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

function validHistoryTime(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    const dateValue = new Date(value)
    return Number.isFinite(dateValue.getTime()) ? dateValue.toISOString() : undefined
  }
  return undefined
}

function date(value: unknown): string {
  if (typeof value === 'string') return value
  const timestamp = number(value, Date.now())
  return new Date(timestamp).toISOString()
}

/** Preserve an event's real wall-clock boundary without manufacturing one. */
function eventTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
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
