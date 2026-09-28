import type { BackendEvent, CompactionView, SessionDetail, SessionHistoryEvent } from '@dsh-vscode/domain'

import { safePayload } from '../../redaction.js'
import {
  recordOrUndefined as objectOrUndefined,
  validProjectionBlock,
} from '../../repositories/shared/guards.js'
import { mapConfiguration, mapModelPatch, mapTodo, permissionPresetIds } from '../../projection/agent.js'
import {
  array,
  boolean,
  date,
  eventIndex,
  eventSequenceLabel,
  eventTimestamp,
  firstString,
  indexToken,
  nonNegativeSafeNumber,
  nonNegativeSafeSequence,
  object,
  positiveSafeNumber,
  requiredArray,
  requiredStringArray,
  safeSubscriptionSequence,
  string,
  stringOr,
  validHistoryTime,
} from './value-guards.js'
import { assertCanonicalSessionEvent, isReplacementSurfaceEvent } from './canonical-events.js'
import { model, provider, sessionSummary, workspace } from './session-mappers.js'
import { presentedFiles, safeStableIdentifier, subagentCatalogEntry, tool } from './tool-mappers.js'
import { goalEventGoals, job } from './goal-mappers.js'
import {
  approvalOutcome,
  commandNotice,
  isLocalizedText,
  permission,
  question,
  queuedInput,
} from './interaction-mappers.js'
import {
  assistantMessageId,
  assistantModelLabel,
  contentText,
  messageImages,
  messageText,
  reasoningText,
  structuredSessionReferenceLabels,
  tokenUsage,
  assistantStreamUsage,
  turnEndFailure,
  turnEndReason,
  userMessageContent,
} from './message-mappers.js'
import {
  planMode,
  sessionConfiguration,
  teamActivity,
  workflowMemberOutcome,
  workflowStopReason,
  workspaceId,
} from './team-mappers.js'

export { assertCanonicalSessionEvent, isReplacementSurfaceEvent } from './canonical-events.js'

export const rc6Mapper = {
  sessionSummary,

  sessionDetail(value: unknown): SessionDetail {
    const summary = rc6Mapper.sessionSummary(value)
    const record = object(value, 'session detail')
    const permissionPresets = permissionPresetIds(summary.projection?.values)
    return {
      ...summary,
      configuration: mapConfiguration(record.configuration),
      ...(permissionPresets === undefined ? {} : { permissionPresets }),
      ...(record.parentSessionId === undefined
        ? {}
        : { parentSessionId: string(record.parentSessionId, 'parentSessionId') }),
    }
  },

  history(
    value: unknown,
    sessionId: string,
    options: { readonly includeSystemMarkers?: boolean } = {},
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
      .filter((entry) => options.includeSystemMarkers === true || entry.event.type !== 'session.system')
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

  workspace,

  provider,

  model,

  event(name: string, value: unknown): BackendEvent {
    const envelope = objectOrUndefined(value) ?? {}
    const data = objectOrUndefined(envelope.data) ?? envelope
    const sessionId = stringOr(envelope.sessionId ?? data.sessionId, '')
    const autoReviewDenialContract = envelope.autoReviewDenialContract === true
    // A model-only replacement copy has no human-readable form here: the
    // transcript keeps the append-origin rows it shadowed, and the copy's own
    // sequence stays visible to the live watermark through this marker.
    if (isReplacementSurfaceEvent(name, value)) return { type: 'session.system', sessionId }
    if (
      [
        'tool/call',
        'tool/result',
        'tool/code-dispatch-start',
        'tool/ptc-dispatch-start',
        'tool/code-dispatch',
        'tool/ptc-dispatch',
      ].includes(name)
    ) {
      const viewEnvelope = objectOrUndefined(data.view)
      const view = objectOrUndefined(viewEnvelope?.view) ?? viewEnvelope
      const source = objectOrUndefined(objectOrUndefined(data.message)?.source)
      if (
        firstString(data.callId, source?.callId, data.subCallId, data.id, view?.callId, view?.id) ===
        undefined
      )
        return { type: 'unknown', sessionId, name, payload: safePayload(value) }
    }
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
      case 'developer/message':
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
      case 'model/selection': {
        // rc.1 appends the pending next-request selection
        // ({ provider, model, reasoningEffort? }) before the request header
        // that confirms it. Keeping the frame opaque would leave the visible
        // model stale until the next prompt starts.
        const model = mapModelPatch(data)
        return model.providerId === undefined || model.modelId === undefined
          ? { type: 'unknown', ...(sessionId === '' ? {} : { sessionId }), name, payload: safePayload(value) }
          : sessionConfiguration(sessionId, { model })
      }
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
        // A final message-level sample supersedes earlier stream samples. Fall
        // back to the embedded stream only when the settlement omitted it.
        const hasDeclaredUsage =
          data.usage !== undefined || message.usage !== undefined || envelope.usage !== undefined
        const usage = hasDeclaredUsage
          ? tokenUsage(data.usage ?? message.usage ?? envelope.usage)
          : assistantStreamUsage(data.stream)
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
      case 'assistant/attempt': {
        // The upstream Client treats an attempt settlement as a non-visible
        // terminal boundary. Preserve its final structured usage sample
        // without projecting the compact stream or fabricating assistant text.
        const turn = eventIndex(data.turn)
        const step = eventIndex(data.step)
        const time = eventTimestamp(envelope.time ?? data.time)
        const usage = assistantStreamUsage(data.stream)
        if (turn === undefined || step === undefined)
          return {
            type: 'unknown',
            ...(sessionId === '' ? {} : { sessionId }),
            name,
            payload: safePayload(value),
          }
        return {
          type: 'assistant.attempt',
          sessionId,
          turn,
          step,
          ...(usage === undefined ? {} : { usage }),
          ...(time === undefined ? {} : { time }),
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
            },
            name === 'tool/call' ? 'call' : 'result',
            name === 'tool/result' && autoReviewDenialContract,
          ),
        }
      }
      case 'host/cordis-client-required':
        if (
          sessionId === '' ||
          typeof data.approvalId !== 'string' ||
          data.approvalId === '' ||
          typeof envelope.rpcId !== 'string' ||
          envelope.rpcId === ''
        )
          throw new Error('Malformed Cordis client interaction')
        return {
          type: 'permission.requested',
          request: {
            id: data.approvalId,
            rpcId: envelope.rpcId,
            sessionId,
            title: 'Cordis browser activation requires DSH Web',
            description:
              'This plugin needs the DSH browser runtime. Handle it in DSH Web, or reject this activation here. VS Code cannot run its browser code.',
            risk: 'unknown',
            options: [{ id: 'rejected', label: 'Reject', kind: 'deny' }],
          },
        }
      case 'approval/requested':
        if (
          sessionId === '' ||
          typeof data.approvalId !== 'string' ||
          data.approvalId.length === 0 ||
          typeof data.toolName !== 'string' ||
          (data.callId !== undefined && typeof data.callId !== 'string') ||
          (data.reason !== undefined && typeof data.reason !== 'string') ||
          (data.displayReason !== undefined && !isLocalizedText(data.displayReason))
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
        // A prune identifies itself by the range it shadowed. Without one, every
        // pruned range would share a single timeline node, so the event's own
        // durable sequence is the identity that keeps them apart.
        const prunedRange =
          shadowedSeqs === undefined || shadowedSeqs.length === 0 ? undefined : shadowedSeqs.join(',')
        const compactionId =
          name === 'compaction/prune'
            ? `prune:${prunedRange ?? eventSequenceLabel(envelope.seq ?? data.seq)}`
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
        if (Object.hasOwn(data, 'asOfSequence') && !nonNegativeSafeSequence(data.asOfSequence))
          throw new Error('Malformed session/queue projection sequence')
        return {
          type: 'queue.updated',
          sessionId,
          items: data.items.flatMap((entry) => queuedInput(entry, sessionId)),
          ...(typeof data.asOfSequence === 'number' ? { asOfSequence: data.asOfSequence } : {}),
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
            // The rc.6-family mux couples this subscription with the
            // process-local queue/jobs/interaction baseline. Alpha's
            // Session-follow adapter overrides this with false on its
            // internal frame because those streams are independent there.
            controlBaseline: data.controlBaseline !== false,
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
          (data.agentAvailable !== undefined && typeof data.agentAvailable !== 'boolean') ||
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
          ...(data.agentAvailable === undefined ? {} : { agentAvailable: data.agentAvailable }),
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
          // The host sends its whole `errorChain` here, and this frame is the
          // only outlet for a live failure with no turn position. The notice
          // row renders the text in full, so the message is kept as sent.
          text: data.message,
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

function retryFailure(value: unknown): { readonly code: string; readonly message: string } {
  const failure = object(value, 'retry failure')
  return {
    code: string(failure.code, 'retry failure code'),
    message: string(failure.message, 'retry failure message'),
  }
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
  // Checked before the canonical assert: a replacement copy is recognized by
  // its marker, and rejecting or degrading its payload would either leak the
  // model-only restatement as an unknown row or lose the durable sequence.
  if (isReplacementSurfaceEvent(type, rawEvent))
    return { sequence, time, event: { type: 'session.system', sessionId, sequence } }
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
