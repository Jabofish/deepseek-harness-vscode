import {
  jobFollowFailedPayloadSchema,
  jobFollowUpdatedPayloadSchema,
  type HostMessage,
} from '@dsh-vscode/webview-protocol'
import { type BackendEvent, type SessionProjectionSnapshot } from '@dsh-vscode/domain'
import { object, isRecord } from './unknown-record.js'
import {
  parseToolPresentation,
  parsePresentedFiles,
  parseSubagentCatalogEntryFact,
  parseToolLocations,
  parseToolAutoReviewDenial,
  presentationIdentifier,
  positivePresentationNumber,
} from './tool-presentation.js'
import {
  configurationPatch,
  finiteEventIndex,
  finiteEventSequence,
  finiteEventTimestamp,
  finiteTransientSequence,
  finiteTransientStartSequence,
  isJobView,
  isToolStatus,
  isWorkflowMember,
  isWorkflowSummary,
  messageAttachments,
  messageImages,
  messageSessionReferenceLabels,
  nonEmptyString,
  nonNegativeSafeInteger,
  parseGoalViews,
  parsePermissionRequest,
  parseQueuedInputs,
  parseSessionProjection,
  parseTeamActivity,
  parseTodoViews,
  parseTokenUsage,
  parseUserQuestion,
  positiveSafeInteger,
  projectionAsOfSequence,
  turnEndFailure,
  turnEndReason,
} from './event-values.js'

export function domainEvent(name: string, payload: unknown): BackendEvent | undefined {
  const raw = object(payload)
  if (raw !== undefined && raw.sequence !== undefined && finiteEventSequence(raw.sequence) === undefined)
    return {
      type: 'unknown',
      ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
      name,
      payload,
    }
  const event = parseDomainEvent(name, payload)
  if (event === undefined) return undefined
  const sequence = finiteEventSequence(object(payload)?.sequence)
  return sequence === undefined ? event : { ...event, sequence }
}

function parseDomainEvent(name: string, payload: unknown): BackendEvent | undefined {
  const value = object(payload)
  if (value === undefined) return { type: 'unknown', name, payload }
  if (name === 'session.system' && nonEmptyString(value.sessionId))
    return { type: 'session.system', sessionId: value.sessionId }
  if (
    name === 'message.user' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.messageId) &&
    typeof value.markdown === 'string'
  ) {
    const hasAttachments = Object.hasOwn(value, 'attachments')
    const hasImages = Object.hasOwn(value, 'images')
    const hasSessionReferenceLabels = Object.hasOwn(value, 'sessionReferenceLabels')
    const attachments = hasAttachments ? messageAttachments(value.attachments) : undefined
    const images = hasImages ? messageImages(value.images) : undefined
    const sessionReferenceLabels = hasSessionReferenceLabels
      ? messageSessionReferenceLabels(value.sessionReferenceLabels)
      : undefined
    if (
      (hasAttachments && attachments === undefined) ||
      (hasImages && images === undefined) ||
      (hasSessionReferenceLabels && sessionReferenceLabels === undefined) ||
      (value.rpcId !== undefined && typeof value.rpcId !== 'string') ||
      (value.source !== undefined && typeof value.source !== 'string') ||
      (value.sourceForm !== undefined && typeof value.sourceForm !== 'string') ||
      (value.sourceSummary !== undefined && typeof value.sourceSummary !== 'string')
    )
      return { type: 'unknown', name, payload }
    return {
      type: 'message.user',
      sessionId: value.sessionId,
      messageId: value.messageId,
      markdown: value.markdown,
      ...(attachments === undefined ? {} : { attachments }),
      ...(images === undefined ? {} : { images }),
      ...(typeof value.rpcId === 'string' ? { rpcId: value.rpcId } : {}),
      ...(typeof value.source === 'string' ? { source: value.source } : {}),
      ...(typeof value.sourceForm === 'string' ? { sourceForm: value.sourceForm } : {}),
      ...(typeof value.sourceSummary === 'string' ? { sourceSummary: value.sourceSummary } : {}),
      ...(sessionReferenceLabels === undefined ? {} : { sessionReferenceLabels }),
    }
  }
  if ((name === 'turn.started' || name === 'turn.ended') && nonEmptyString(value.sessionId)) {
    const turn = finiteEventIndex(value.turn)
    if (turn === undefined) return { type: 'unknown', name, payload }
    if (name === 'turn.started') return { type: 'turn.started', sessionId: value.sessionId, turn }
    const hasFailure = Object.hasOwn(value, 'failure')
    const failure = turnEndFailure(value.failure ?? value.reason)
    if (hasFailure && failure === undefined) return { type: 'unknown', name, payload }
    return {
      type: 'turn.ended',
      sessionId: value.sessionId,
      turn,
      reason: turnEndReason(value.reason),
      ...(failure === undefined ? {} : { failure }),
    }
  }
  if ((name === 'step.started' || name === 'step.ended') && nonEmptyString(value.sessionId)) {
    const turn = finiteEventIndex(value.turn)
    const step = finiteEventIndex(value.step)
    if (turn === undefined || step === undefined) return { type: 'unknown', name, payload }
    const time = finiteEventTimestamp(value.time)
    if (value.time !== undefined && time === undefined) return { type: 'unknown', name, payload }
    return name === 'step.started'
      ? {
          type: 'step.started',
          sessionId: value.sessionId,
          turn,
          step,
          ...(time === undefined ? {} : { time }),
        }
      : {
          type: 'step.ended',
          sessionId: value.sessionId,
          turn,
          step,
          ...(time === undefined ? {} : { time }),
        }
  }
  if (
    name === 'message.delta' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.messageId) &&
    typeof value.delta === 'string'
  ) {
    const turn = finiteEventIndex(value.turn)
    const step = finiteEventIndex(value.step)
    const time = finiteEventTimestamp(value.time)
    const transientSequence = finiteTransientSequence(value.transientSequence)
    const transientIndex = finiteEventIndex(value.transientIndex)
    const transientStartedAfterSequence = finiteTransientStartSequence(value.transientStartedAfterSequence)
    const hasTransientMetadata =
      value.transientSequence !== undefined ||
      value.transientAttemptId !== undefined ||
      value.transientIndex !== undefined ||
      value.transientStartedAfterSequence !== undefined
    if (
      (value.turn !== undefined && turn === undefined) ||
      (value.step !== undefined && step === undefined) ||
      (value.time !== undefined && time === undefined) ||
      (hasTransientMetadata &&
        (transientSequence === undefined ||
          !nonEmptyString(value.transientAttemptId) ||
          transientIndex === undefined)) ||
      (value.transientStartedAfterSequence !== undefined && transientStartedAfterSequence === undefined) ||
      (Object.hasOwn(value, 'interrupted') && value.interrupted !== true)
    )
      return { type: 'unknown', name, payload }
    return {
      type: 'message.delta',
      sessionId: value.sessionId,
      messageId: value.messageId,
      delta: value.delta,
      ...(turn === undefined ? {} : { turn }),
      ...(step === undefined ? {} : { step }),
      ...(time === undefined ? {} : { time }),
      ...(transientSequence === undefined ? {} : { transientSequence }),
      ...(typeof value.transientAttemptId === 'string'
        ? { transientAttemptId: value.transientAttemptId }
        : {}),
      ...(transientIndex === undefined ? {} : { transientIndex }),
      ...(transientStartedAfterSequence === undefined ? {} : { transientStartedAfterSequence }),
      ...(value.interrupted === true ? { interrupted: true as const } : {}),
    }
  }
  if (
    name === 'reasoning.delta' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.messageId) &&
    typeof value.delta === 'string'
  ) {
    const turn = finiteEventIndex(value.turn)
    const step = finiteEventIndex(value.step)
    const time = finiteEventTimestamp(value.time)
    const transientSequence = finiteTransientSequence(value.transientSequence)
    const transientIndex = finiteEventIndex(value.transientIndex)
    const transientStartedAfterSequence = finiteTransientStartSequence(value.transientStartedAfterSequence)
    const hasTransientMetadata =
      value.transientSequence !== undefined ||
      value.transientAttemptId !== undefined ||
      value.transientIndex !== undefined ||
      value.transientStartedAfterSequence !== undefined
    if (
      (value.turn !== undefined && turn === undefined) ||
      (value.step !== undefined && step === undefined) ||
      (value.time !== undefined && time === undefined) ||
      (hasTransientMetadata &&
        (transientSequence === undefined ||
          !nonEmptyString(value.transientAttemptId) ||
          transientIndex === undefined)) ||
      (value.transientStartedAfterSequence !== undefined && transientStartedAfterSequence === undefined) ||
      (Object.hasOwn(value, 'interrupted') && value.interrupted !== true)
    )
      return { type: 'unknown', name, payload }
    return {
      type: 'reasoning.delta',
      sessionId: value.sessionId,
      messageId: value.messageId,
      delta: value.delta,
      ...(turn === undefined ? {} : { turn }),
      ...(step === undefined ? {} : { step }),
      ...(time === undefined ? {} : { time }),
      ...(transientSequence === undefined ? {} : { transientSequence }),
      ...(typeof value.transientAttemptId === 'string'
        ? { transientAttemptId: value.transientAttemptId }
        : {}),
      ...(transientIndex === undefined ? {} : { transientIndex }),
      ...(transientStartedAfterSequence === undefined ? {} : { transientStartedAfterSequence }),
    }
  }
  if (name === 'message.completed' && nonEmptyString(value.sessionId) && nonEmptyString(value.messageId)) {
    const usage = parseTokenUsage(value.usage)
    const hasImages = Object.hasOwn(value, 'images')
    const images = hasImages ? messageImages(value.images) : undefined
    const turn = finiteEventIndex(value.turn)
    const step = finiteEventIndex(value.step)
    const time = finiteEventTimestamp(value.time)
    if (
      (hasImages && images === undefined) ||
      (Object.hasOwn(value, 'interrupted') && value.interrupted !== true) ||
      (value.markdown !== undefined && typeof value.markdown !== 'string') ||
      (value.reasoning !== undefined && typeof value.reasoning !== 'string') ||
      (value.modelLabel !== undefined && typeof value.modelLabel !== 'string') ||
      (Object.hasOwn(value, 'usage') && usage === undefined) ||
      (value.turn !== undefined && turn === undefined) ||
      (value.step !== undefined && step === undefined) ||
      (value.time !== undefined && time === undefined)
    )
      return { type: 'unknown', name, payload }
    return {
      type: 'message.completed',
      sessionId: value.sessionId,
      messageId: value.messageId,
      ...(typeof value.markdown === 'string' ? { markdown: value.markdown } : {}),
      ...(typeof value.reasoning === 'string' ? { reasoning: value.reasoning } : {}),
      ...(typeof value.modelLabel === 'string' ? { modelLabel: value.modelLabel } : {}),
      ...(images === undefined ? {} : { images }),
      ...(usage === undefined ? {} : { usage }),
      ...(turn === undefined ? {} : { turn }),
      ...(step === undefined ? {} : { step }),
      ...(time === undefined ? {} : { time }),
      ...(value.interrupted === true ? { interrupted: true as const } : {}),
    }
  }
  if (name === 'assistant.attempt' && nonEmptyString(value.sessionId)) {
    const turn = finiteEventIndex(value.turn)
    const step = finiteEventIndex(value.step)
    const time = finiteEventTimestamp(value.time)
    const usage = parseTokenUsage(value.usage)
    if (
      turn === undefined ||
      step === undefined ||
      (value.time !== undefined && time === undefined) ||
      (Object.hasOwn(value, 'usage') && usage === undefined)
    )
      return { type: 'unknown', name, payload }
    return {
      type: 'assistant.attempt',
      sessionId: value.sessionId,
      turn,
      step,
      ...(usage === undefined ? {} : { usage }),
      ...(time === undefined ? {} : { time }),
    }
  }
  if (name === 'deliverables.presented' && nonEmptyString(value.sessionId)) {
    const turn = positivePresentationNumber(value.turn)
    const callId = presentationIdentifier(value.callId)
    const files = parsePresentedFiles(value.files)
    if (turn !== undefined && callId !== undefined && files !== undefined)
      return {
        type: 'deliverables.presented',
        sessionId: value.sessionId,
        turn,
        callId,
        files,
      }
  }
  if (name === 'subagent.catalog.updated' && nonEmptyString(value.sessionId)) {
    const entry = parseSubagentCatalogEntryFact(value.entry)
    if (entry !== undefined) return { type: 'subagent.catalog.updated', sessionId: value.sessionId, entry }
  }
  if (name === 'session.status' && nonEmptyString(value.sessionId) && typeof value.status === 'string')
    return { type: 'session.status', sessionId: value.sessionId, status: value.status }
  if (
    name === 'session.activity' &&
    nonEmptyString(value.sessionId) &&
    typeof value.updatedAt === 'number' &&
    Number.isSafeInteger(value.updatedAt) &&
    value.updatedAt >= 0
  )
    return { type: 'session.activity', sessionId: value.sessionId, updatedAt: value.updatedAt }
  if (
    name === 'session.subscribed' &&
    nonEmptyString(value.sessionId) &&
    typeof value.lastSequence === 'number' &&
    Number.isSafeInteger(value.lastSequence) &&
    value.lastSequence >= -1
  ) {
    const hasProjection = Object.hasOwn(value, 'projection')
    let projection: SessionProjectionSnapshot | undefined
    if (hasProjection) {
      try {
        projection = parseSessionProjection(value.projection)
      } catch {
        return { type: 'unknown', name, payload }
      }
    }
    if (hasProjection && projection === undefined) return { type: 'unknown', name, payload }
    if (value.controlBaseline !== undefined && typeof value.controlBaseline !== 'boolean')
      return { type: 'unknown', name, payload }
    return {
      type: 'session.subscribed',
      sessionId: value.sessionId,
      lastSequence: value.lastSequence,
      ...(value.controlBaseline === undefined ? {} : { controlBaseline: value.controlBaseline }),
      ...(projection === undefined ? {} : { projection }),
    }
  }
  if (name === 'session.title' && nonEmptyString(value.sessionId) && typeof value.title === 'string')
    return { type: 'session.title', sessionId: value.sessionId, title: value.title }
  if (name === 'session.configuration' && nonEmptyString(value.sessionId) && isRecord(value.patch)) {
    const patch = configurationPatch(value.patch)
    if (patch !== undefined) return { type: 'session.configuration', sessionId: value.sessionId, patch }
  }
  if (name === 'session.added' && nonEmptyString(value.sessionId)) {
    const hasParentSessionId = Object.hasOwn(value, 'parentSessionId')
    const hasOrigin = Object.hasOwn(value, 'origin')
    const hasCwd = Object.hasOwn(value, 'cwd')
    const hasAgentPreset = Object.hasOwn(value, 'agentPreset')
    if (
      typeof value.blank !== 'boolean' ||
      (Object.hasOwn(value, 'agentAvailable') && typeof value.agentAvailable !== 'boolean') ||
      (hasParentSessionId &&
        (typeof value.parentSessionId !== 'string' || value.parentSessionId.trim() === '')) ||
      (hasOrigin && value.origin !== 'subagent') ||
      (hasCwd && typeof value.cwd !== 'string') ||
      (hasAgentPreset && typeof value.agentPreset !== 'string')
    )
      return { type: 'unknown', name, payload }
    return {
      type: 'session.added',
      sessionId: value.sessionId,
      blank: value.blank,
      ...(typeof value.agentAvailable === 'boolean' ? { agentAvailable: value.agentAvailable } : {}),
      ...(typeof value.parentSessionId === 'string' ? { parentSessionId: value.parentSessionId } : {}),
      ...(value.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
      ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
      ...(typeof value.agentPreset === 'string' ? { agentPreset: value.agentPreset } : {}),
    }
  }
  if (name === 'session.removed' && nonEmptyString(value.sessionId))
    return { type: 'session.removed', sessionId: value.sessionId }
  if (name === 'session.projection.baseline') {
    const rawProjections = object(value.projections)
    if (rawProjections === undefined) return { type: 'unknown', name, payload }
    const projections: Record<string, SessionProjectionSnapshot> = Object.create(null) as Record<
      string,
      SessionProjectionSnapshot
    >
    for (const [sessionId, rawProjection] of Object.entries(rawProjections)) {
      if (!nonEmptyString(sessionId)) return { type: 'unknown', name, payload }
      try {
        const projection = parseSessionProjection(rawProjection)
        if (projection === undefined) return { type: 'unknown', name, payload }
        projections[sessionId] = projection
      } catch {
        return { type: 'unknown', name, payload }
      }
    }
    return { type: 'session.projection.baseline', projections }
  }
  if (
    name === 'session.projection' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.key) &&
    Object.hasOwn(value, 'value')
  )
    return { type: 'session.projection', sessionId: value.sessionId, key: value.key, value: value.value }
  if (
    name === 'tool.updated' &&
    nonEmptyString(value.sessionId) &&
    isRecord(value.tool) &&
    typeof value.tool.id === 'string' &&
    value.tool.id.trim() !== '' &&
    typeof value.tool.name === 'string' &&
    value.tool.name.trim() !== '' &&
    isToolStatus(value.tool.status)
  ) {
    const turn = finiteEventIndex(value.tool.turn)
    const step = finiteEventIndex(value.tool.step)
    const parentCallId = value.tool.parentCallId
    const locations = parseToolLocations(value.tool.locations)
    const presentation = parseToolPresentation(value.tool.presentation)
    const autoReviewDenial = parseToolAutoReviewDenial(value.tool.autoReviewDenial)
    const images = value.tool.images === undefined ? undefined : messageImages(value.tool.images)
    if (
      (value.tool.images !== undefined && images === undefined) ||
      (value.tool.turn !== undefined && turn === undefined) ||
      (value.tool.step !== undefined && step === undefined) ||
      (parentCallId !== undefined && !nonEmptyString(parentCallId)) ||
      (value.tool.category !== undefined && typeof value.tool.category !== 'string') ||
      (value.tool.title !== undefined && typeof value.tool.title !== 'string') ||
      (value.tool.startedAt !== undefined && typeof value.tool.startedAt !== 'string') ||
      (value.tool.completedAt !== undefined && typeof value.tool.completedAt !== 'string') ||
      (value.tool.inputSummary !== undefined && typeof value.tool.inputSummary !== 'string') ||
      (value.tool.outputSummary !== undefined && typeof value.tool.outputSummary !== 'string') ||
      (value.tool.error !== undefined && typeof value.tool.error !== 'string') ||
      (value.tool.autoReviewDenial !== undefined && autoReviewDenial === undefined) ||
      (autoReviewDenial !== undefined && value.tool.status !== 'failed') ||
      (value.tool.metadata !== undefined && !isRecord(value.tool.metadata))
    )
      return { type: 'unknown', name, payload }
    return {
      type: 'tool.updated',
      sessionId: value.sessionId,
      tool: {
        id: value.tool.id,
        ...(typeof parentCallId === 'string' ? { parentCallId } : {}),
        ...(turn === undefined ? {} : { turn }),
        ...(step === undefined ? {} : { step }),
        name: value.tool.name,
        category: typeof value.tool.category === 'string' ? value.tool.category : 'tool',
        title: typeof value.tool.title === 'string' ? value.tool.title : value.tool.name,
        status: value.tool.status,
        ...(typeof value.tool.startedAt === 'string' ? { startedAt: value.tool.startedAt } : {}),
        ...(typeof value.tool.completedAt === 'string' ? { completedAt: value.tool.completedAt } : {}),
        ...(isRecord(value.tool.submittedPlan) &&
        typeof value.tool.submittedPlan.title === 'string' &&
        typeof value.tool.submittedPlan.markdown === 'string'
          ? {
              submittedPlan: {
                title: value.tool.submittedPlan.title,
                markdown: value.tool.submittedPlan.markdown,
              },
            }
          : {}),
        ...(typeof value.tool.inputSummary === 'string' ? { inputSummary: value.tool.inputSummary } : {}),
        ...(typeof value.tool.outputSummary === 'string' ? { outputSummary: value.tool.outputSummary } : {}),
        ...(typeof value.tool.error === 'string' ? { error: value.tool.error } : {}),
        ...(autoReviewDenial === undefined ? {} : { autoReviewDenial }),
        ...(locations === undefined ? {} : { locations }),
        ...(presentation === undefined ? {} : { presentation }),
        ...(images === undefined ? {} : { images }),
        metadata: isRecord(value.tool.metadata) ? value.tool.metadata : {},
      },
    }
  }
  if (name === 'team.updated' && nonEmptyString(value.sessionId)) {
    const activity = parseTeamActivity(value.activity)
    return activity === undefined
      ? { type: 'unknown', sessionId: value.sessionId, name, payload }
      : { type: 'team.updated', sessionId: value.sessionId, activity }
  }
  if (name === 'goal.updated' && nonEmptyString(value.sessionId)) {
    const goals = parseGoalViews(value.goals)
    if (goals !== undefined) return { type: 'goal.updated', sessionId: value.sessionId, goals }
  }
  if (name === 'todo.updated' && nonEmptyString(value.sessionId)) {
    const todos = parseTodoViews(value.todos)
    if (todos !== undefined) return { type: 'todo.updated', sessionId: value.sessionId, todos }
  }
  if (
    name === 'compaction.updated' &&
    nonEmptyString(value.sessionId) &&
    isRecord(value.compaction) &&
    nonEmptyString(value.compaction.id)
  ) {
    const phase = value.compaction.phase
    const summary = value.compaction.summary
    const replacedCount = value.compaction.replacedCount
    const estimatedTokens = value.compaction.estimatedTokens
    const parsedReplacedCount = nonNegativeSafeInteger(replacedCount)
    const parsedEstimatedTokens = nonNegativeSafeInteger(estimatedTokens)
    if (
      (phase !== 'start' && phase !== 'summary' && phase !== 'prune' && phase !== 'end') ||
      (summary !== undefined && typeof summary !== 'string') ||
      (replacedCount !== undefined && parsedReplacedCount === undefined) ||
      (estimatedTokens !== undefined && parsedEstimatedTokens === undefined)
    )
      return { type: 'unknown', sessionId: value.sessionId, name, payload }
    return {
      type: 'compaction.updated',
      sessionId: value.sessionId,
      compaction: {
        id: value.compaction.id,
        phase,
        ...(summary === undefined ? {} : { summary }),
        ...(parsedReplacedCount === undefined ? {} : { replacedCount: parsedReplacedCount }),
        ...(parsedEstimatedTokens === undefined ? {} : { estimatedTokens: parsedEstimatedTokens }),
      },
    }
  }
  if (name === 'model.retry' && isRecord(value.retry)) {
    const retry = value.retry
    const turn = finiteEventIndex(retry.turn)
    const step = finiteEventIndex(retry.step)
    const attempt = positiveSafeInteger(retry.attempt)
    const delayMs = retry.delayMs === undefined ? undefined : nonNegativeSafeInteger(retry.delayMs)
    const maxRetries = retry.maxRetries === undefined ? undefined : positiveSafeInteger(retry.maxRetries)
    if (
      nonEmptyString(retry.sessionId) &&
      nonEmptyString(retry.id) &&
      turn !== undefined &&
      step !== undefined &&
      attempt !== undefined &&
      (retry.delayMs === undefined || delayMs !== undefined) &&
      (retry.maxRetries === undefined || maxRetries !== undefined) &&
      (retry.message === undefined || typeof retry.message === 'string') &&
      (retry.state === 'scheduled' || retry.state === 'started')
    )
      return {
        type: 'model.retry',
        retry: {
          sessionId: retry.sessionId,
          id: retry.id,
          turn,
          step,
          attempt,
          state: retry.state,
          ...(delayMs === undefined ? {} : { delayMs }),
          ...(maxRetries === undefined ? {} : { maxRetries }),
          ...(typeof retry.message === 'string' ? { message: retry.message } : {}),
        },
      }
  }
  if (
    name === 'jobs.updated' &&
    nonEmptyString(value.sessionId) &&
    Array.isArray(value.jobs) &&
    value.jobs.every(isJobView)
  ) {
    return {
      type: 'jobs.updated',
      sessionId: value.sessionId,
      jobs: value.jobs,
    }
  }
  if (name === 'job.follow.updated') {
    const result = jobFollowUpdatedPayloadSchema.safeParse(value)
    if (result.success)
      return {
        type: 'job.follow.updated',
        sessionId: result.data.sessionId,
        jobId: result.data.jobId,
        followId: result.data.followId,
        frame: result.data.frame,
      }
  }
  if (name === 'job.follow.failed') {
    const result = jobFollowFailedPayloadSchema.safeParse(value)
    if (result.success)
      return {
        type: 'job.follow.failed',
        sessionId: result.data.sessionId,
        jobId: result.data.jobId,
        followId: result.data.followId,
        reason: 'stream-failed',
      }
  }
  if (name === 'queue.updated' && nonEmptyString(value.sessionId)) {
    const hasAsOfSequence = Object.hasOwn(value, 'asOfSequence')
    const asOfSequence = hasAsOfSequence ? projectionAsOfSequence(value.asOfSequence) : undefined
    if (hasAsOfSequence && (asOfSequence === undefined || asOfSequence < 0 || Object.is(asOfSequence, -0)))
      return undefined
    const items = parseQueuedInputs(value.items, value.sessionId)
    if (items !== undefined)
      return {
        type: 'queue.updated',
        sessionId: value.sessionId,
        items,
        ...(asOfSequence === undefined ? {} : { asOfSequence }),
      }
  }
  if (name === 'workflow.started' && nonEmptyString(value.sessionId) && isWorkflowSummary(value.workflow))
    return {
      type: 'workflow.started',
      sessionId: value.sessionId,
      workflow: value.workflow,
    }
  if (
    name === 'workflow.member.started' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.runId) &&
    (typeof value.phase === 'string' || value.phase === null) &&
    isWorkflowMember(value.member) &&
    value.member.status === 'running'
  )
    return {
      type: 'workflow.member.started',
      sessionId: value.sessionId,
      runId: value.runId,
      phase: value.phase,
      member: value.member,
    }
  if (
    name === 'workflow.member.ended' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.runId) &&
    Number.isSafeInteger(value.seq) &&
    (value.seq as number) > 0 &&
    (value.outcome === 'completed' || value.outcome === 'failed' || value.outcome === 'cancelled')
  )
    return {
      type: 'workflow.member.ended',
      sessionId: value.sessionId,
      runId: value.runId,
      seq: value.seq as number,
      outcome: value.outcome,
    }
  if (
    name === 'workflow.ended' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.runId) &&
    (value.stopReason === 'completed' || value.stopReason === 'cancelled' || value.stopReason === 'error')
  )
    return {
      type: 'workflow.ended',
      sessionId: value.sessionId,
      runId: value.runId,
      stopReason: value.stopReason,
    }
  if (name === 'permission.requested' && isRecord(value.request)) {
    const request = parsePermissionRequest(value.request)
    if (request !== undefined) return { type: 'permission.requested', request }
  }
  if (name === 'question.requested' && isRecord(value.question)) {
    const question = parseUserQuestion(value.question)
    if (question !== undefined) return { type: 'question.requested', question }
  }
  if (name === 'permission.resolved') {
    const hasOutcome = Object.hasOwn(value, 'outcome')
    if (
      nonEmptyString(value.sessionId) &&
      nonEmptyString(value.requestId) &&
      (!hasOutcome || typeof value.outcome === 'string')
    )
      return {
        type: 'permission.resolved',
        sessionId: value.sessionId,
        requestId: value.requestId,
        ...(typeof value.outcome === 'string' ? { outcome: value.outcome } : {}),
      }
  }
  if (name === 'question.resolved') {
    const hasQuestionRpcId = Object.hasOwn(value, 'questionRpcId')
    const hasQuestionId = Object.hasOwn(value, 'questionId')
    const questionRpcId =
      hasQuestionRpcId && nonEmptyString(value.questionRpcId) ? value.questionRpcId : undefined
    const questionId = hasQuestionId && nonEmptyString(value.questionId) ? value.questionId : undefined
    const hasOutcome = Object.hasOwn(value, 'outcome')
    if (
      nonEmptyString(value.sessionId) &&
      (!hasQuestionRpcId || questionRpcId !== undefined) &&
      (!hasQuestionId || questionId !== undefined) &&
      (questionRpcId !== undefined || questionId !== undefined) &&
      (!hasOutcome || typeof value.outcome === 'string')
    )
      return {
        type: 'question.resolved',
        sessionId: value.sessionId,
        ...(questionRpcId === undefined ? {} : { questionRpcId }),
        ...(questionId === undefined ? {} : { questionId }),
        ...(typeof value.outcome === 'string' ? { outcome: value.outcome } : {}),
      }
  }
  if (name === 'workspace.changed') {
    const hasWorkspaceId = Object.hasOwn(value, 'workspaceId')
    const workspaceId = hasWorkspaceId && nonEmptyString(value.workspaceId) ? value.workspaceId : undefined
    if (hasWorkspaceId && workspaceId === undefined) return { type: 'unknown', name, payload }
    return {
      type: 'workspace.changed',
      ...(workspaceId === undefined ? {} : { workspaceId }),
    }
  }
  if (name === 'workspace.removed') {
    const hasWorkspaceId = Object.hasOwn(value, 'workspaceId')
    const workspaceId = hasWorkspaceId && nonEmptyString(value.workspaceId) ? value.workspaceId : undefined
    if (hasWorkspaceId && workspaceId === undefined) return { type: 'unknown', name, payload }
    return {
      type: 'workspace.removed',
      ...(workspaceId === undefined ? {} : { workspaceId }),
    }
  }
  if (
    name === 'workspace.order.changed' &&
    Array.isArray(value.workspaceIds) &&
    value.workspaceIds.every((entry) => nonEmptyString(entry))
  )
    return {
      type: 'workspace.order.changed',
      workspaceIds: value.workspaceIds,
    }
  if (
    name === 'archived.sessions.changed' &&
    Array.isArray(value.sessionIds) &&
    value.sessionIds.every((entry) => nonEmptyString(entry))
  )
    return {
      type: 'archived.sessions.changed',
      sessionIds: value.sessionIds,
    }
  if (
    name === 'session.gap' &&
    nonEmptyString(value.sessionId) &&
    typeof value.fromSequence === 'number' &&
    Number.isSafeInteger(value.fromSequence) &&
    value.fromSequence >= 0 &&
    typeof value.toSequence === 'number' &&
    Number.isSafeInteger(value.toSequence) &&
    value.toSequence >= value.fromSequence
  )
    return {
      type: 'session.gap',
      sessionId: value.sessionId,
      fromSequence: value.fromSequence,
      toSequence: value.toSequence,
    }
  if (name === 'remote.event' && nonEmptyString(value.name) && Array.isArray(value.args))
    return { type: 'remote.event', name: value.name, args: value.args }
  if (name === 'unknown')
    return {
      type: 'unknown',
      ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
      name: typeof value.name === 'string' ? value.name : 'unknown',
      payload: value.payload,
    }
  if (
    name === 'notice' &&
    typeof value.text === 'string' &&
    (value.level === 'info' || value.level === 'warning' || value.level === 'error')
  ) {
    const hasSessionId = Object.hasOwn(value, 'sessionId')
    const hasCommandName = Object.hasOwn(value, 'commandName')
    const hasCommandId = Object.hasOwn(value, 'commandId')
    const hasCommandPhase = Object.hasOwn(value, 'commandPhase')
    const hasCommandInput = Object.hasOwn(value, 'commandInput')
    if (
      (hasSessionId && !nonEmptyString(value.sessionId)) ||
      (hasCommandName && !nonEmptyString(value.commandName)) ||
      (hasCommandId && !nonEmptyString(value.commandId)) ||
      (hasCommandPhase && value.commandPhase !== 'run' && value.commandPhase !== 'done') ||
      (hasCommandInput && !nonEmptyString(value.commandInput))
    )
      return { type: 'unknown', name, payload }
    return {
      type: 'notice',
      ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
      level: value.level,
      text: value.text,
      ...(typeof value.commandName === 'string' && value.commandName.trim() !== ''
        ? { commandName: value.commandName.slice(0, 128) }
        : {}),
      ...(typeof value.commandId === 'string' && value.commandId.trim() !== ''
        ? { commandId: value.commandId.slice(0, 256) }
        : {}),
      ...(value.commandPhase === 'run' || value.commandPhase === 'done'
        ? { commandPhase: value.commandPhase }
        : {}),
      // The host logs `command/run.args` verbatim with no length bound, and this
      // becomes the transcript's command-input row — the only record of the line
      // that ran, so it must not be clipped here either.
      ...(typeof value.commandInput === 'string' && value.commandInput.trim() !== ''
        ? { commandInput: value.commandInput }
        : {}),
    }
  }
  if (name === 'connection.lost' && typeof value.reason === 'string')
    return { type: 'connection.lost', reason: value.reason }
  return {
    type: 'unknown',
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
    name,
    payload,
  }
}

export function parseHostDomainEvent(message: HostMessage): BackendEvent | null | undefined {
  if (message.type !== 'event') return undefined
  if (
    message.name === 'runtime.update.progress' ||
    message.name === 'ui.sessions.toggle' ||
    message.name === 'ui.settings.toggle' ||
    message.name === 'connection.snapshot'
  )
    return undefined
  return domainEvent(message.name, message.payload) ?? null
}

function isHostOnlyInterruptedCompletion(event: BackendEvent): boolean {
  return event.type === 'message.completed' && event.interrupted === true && event.sequence === undefined
}

/** Only durable conversation records advance the DSH timeline cursor. */
function advancesTimelineSequence(event: BackendEvent): boolean {
  switch (event.type) {
    case 'archived.sessions.changed':
    case 'connection.lost':
    case 'jobs.updated':
    case 'job.follow.updated':
    case 'job.follow.failed':
    case 'permission.requested':
    case 'permission.resolved':
    case 'question.requested':
    case 'question.resolved':
    case 'queue.updated':
    case 'session.added':
    case 'session.activity':
    case 'session.configuration':
    case 'session.projection.baseline':
    case 'session.projection':
    case 'session.removed':
    case 'session.status':
    case 'session.subscribed':
    case 'session.system':
    case 'session.title':
    case 'workspace.changed':
    case 'workspace.order.changed':
    case 'workspace.removed':
    case 'remote.event':
      return false
    case 'unknown':
      // An uninterpreted frame is preserved as a raw event row, but it must
      // never spend a durable cursor slot. DSH legitimately carries several
      // rows in one sequence (projections, replay races), so a row this build
      // cannot read must not make a renderable neighbour look stale.
      return false
    default:
      return true
  }
}

/**
 * Keep the live and history-replay cursor rules identical.
 *
 * A streamed delta can carry the durable frame sequence as transport
 * metadata, but it is still only a transient projection of the assistant
 * message. If replay lets that delta consume the cursor, the durable
 * `message.completed` frame at the same sequence is rejected as stale and
 * the completed answer disappears after a ledger rebuild.
 */
export function timelineSequenceOptions(event: BackendEvent): { readonly advanceSequence?: false } {
  const transientSequence =
    event.type === 'message.delta' || event.type === 'reasoning.delta' ? event.transientSequence : undefined
  return !advancesTimelineSequence(event) ||
    transientSequence !== undefined ||
    isHostOnlyInterruptedCompletion(event)
    ? { advanceSequence: false }
    : {}
}
