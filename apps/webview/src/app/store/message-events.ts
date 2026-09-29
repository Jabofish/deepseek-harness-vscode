import {
  finiteEventIndex,
  finiteEventTimestamp,
  finiteTransientSequence,
  finiteTransientStartSequence,
  messageAttachments,
  messageImages,
  messageSessionReferenceLabels,
  nonEmptyString,
  parseTokenUsage,
  parseUserQuestionReply,
  turnEndFailure,
  turnEndReason,
} from './event-values.js'

import type { BackendEvent } from '@dsh-vscode/domain'

/** Branches are matched by event name; the caller owns the name-mutual-exclusion ordering. */
export function parseMessageEvents(
  name: string,
  value: Record<string, unknown>,
  payload: unknown,
): BackendEvent | undefined {
  if (
    name === 'message.user' &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.messageId) &&
    typeof value.markdown === 'string'
  ) {
    const hasAttachments = Object.hasOwn(value, 'attachments')
    const hasImages = Object.hasOwn(value, 'images')
    const hasSessionReferenceLabels = Object.hasOwn(value, 'sessionReferenceLabels')
    const hasQuestionReply = Object.hasOwn(value, 'questionReply')
    const attachments = hasAttachments ? messageAttachments(value.attachments) : undefined
    const images = hasImages ? messageImages(value.images) : undefined
    const sessionReferenceLabels = hasSessionReferenceLabels
      ? messageSessionReferenceLabels(value.sessionReferenceLabels)
      : undefined
    const questionReply = hasQuestionReply ? parseUserQuestionReply(value.questionReply) : undefined
    if (
      (hasAttachments && attachments === undefined) ||
      (hasImages && images === undefined) ||
      (hasSessionReferenceLabels && sessionReferenceLabels === undefined) ||
      (hasQuestionReply && questionReply === undefined) ||
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
      ...(questionReply === undefined ? {} : { questionReply }),
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
  return undefined
}
