import { AppError, type BackendEvent } from '@dsh-vscode/domain'

import { redactText, safePayload } from './redaction.js'
import { assertCanonicalSessionEvent, isReplacementSurfaceEvent, rc6Mapper } from './versions/rc6/mapper.js'

export function normalizeEnvelope(value: unknown): BackendEvent | undefined {
  const envelope = record(value)
  const frame = record(envelope?.payload ?? value)
  if (frame === undefined)
    return withSequence({ type: 'unknown', name: 'protocol/frame', payload: safePayload(value) }, undefined)
  if (typeof frame.type !== 'string')
    return withSequence({ type: 'unknown', name: 'protocol/frame', payload: safePayload(frame) }, frame.seq)
  const withRpcId = typeof envelope?.rpcId === 'string' ? { ...frame, rpcId: envelope.rpcId } : frame
  switch (frame.type) {
    case 'session/assistant-stream':
      return normalizeAssistantStreamFrame(frame)
    case 'session/assistant-interrupted':
      return normalizeAssistantInterruptionFrame(frame)
    case 'session/event': {
      const event = record(frame.event)
      if (!isDurableSequence(event?.seq)) throw new Error('Malformed DSH session event sequence.')
      return typeof event?.type !== 'string'
        ? withSequence(
            {
              type: 'unknown',
              ...(typeof frame.sessionId === 'string' ? { sessionId: frame.sessionId } : {}),
              name: 'session/event',
              payload: safePayload(frame.event),
            },
            event?.seq,
          )
        : withSequence(
            mapStreamEvent(event.type, {
              ...event,
              sessionId: frame.sessionId,
              ...(frame.view === undefined ? {} : { view: frame.view }),
              ...(typeof envelope?.rpcId === 'string' ? { rpcId: envelope.rpcId } : {}),
            }),
            event.seq,
          )
    }
    case 'host/session-status':
    case 'host/session-activity':
    case 'host/session-added':
    case 'host/session-removed':
    case 'host/workspace-changed':
    case 'host/workspace-removed':
    case 'host/workspace-order-changed':
    case 'host/archived-sessions-changed':
    case 'host/commands-changed':
    case 'host/session-preset-changed':
    case 'host/settings-changed':
    case 'host/credentials-changed':
    case 'host/models-changed':
    case 'host/remote-event':
    case 'host/cordis-client-required':
    case 'host/agent-error':
    case 'approval/requested':
    case 'approval/resolved':
    case 'question/requested':
    case 'question/resolved':
    case 'session/subscribed':
    case 'session/queue':
    case 'session/jobs':
    case 'session/tasks':
    case 'session/projection':
      return withSequence(mapStreamEvent(frame.type, withRpcId), frame.seq)
    case 'session/projection-baseline':
      return normalizeProjectionBaselineFrame(frame)
    case 'stream/error':
      return { type: 'connection.lost', reason: streamErrorReason(frame.error) }
    default:
      return withSequence(
        {
          type: 'unknown',
          ...(typeof frame.sessionId === 'string' ? { sessionId: frame.sessionId } : {}),
          name: frame.type,
          payload: safePayload(frame),
        },
        frame.seq,
      )
  }
}

function normalizeProjectionBaselineFrame(frame: Record<string, unknown>): BackendEvent | undefined {
  const projections = record(frame.projections)
  if (projections === undefined) return undefined
  const normalized: Record<
    string,
    { readonly asOfSequence: number; readonly values: Readonly<Record<string, unknown>> }
  > = Object.create(null) as Record<
    string,
    { readonly asOfSequence: number; readonly values: Readonly<Record<string, unknown>> }
  >
  for (const [sessionId, value] of Object.entries(projections)) {
    const projection = record(value)
    const values = record(projection?.values)
    if (
      sessionId.trim() === '' ||
      projection === undefined ||
      values === undefined ||
      typeof projection.asOfSequence !== 'number' ||
      !Number.isSafeInteger(projection.asOfSequence) ||
      projection.asOfSequence < -1 ||
      Object.is(projection.asOfSequence, -0)
    )
      return undefined
    normalized[sessionId] = { asOfSequence: projection.asOfSequence, values }
  }
  return { type: 'session.projection.baseline', projections: normalized }
}

function normalizeAssistantStreamFrame(value: Record<string, unknown>): BackendEvent | undefined {
  const sessionId =
    typeof value.sessionId === 'string' && value.sessionId.trim() !== '' ? value.sessionId : undefined
  const frame = record(value.frame)
  const chunk = record(frame?.chunk)
  if (
    sessionId === undefined ||
    frame === undefined ||
    frame.type !== 'chunk' ||
    chunk === undefined ||
    typeof frame.attemptId !== 'string' ||
    frame.attemptId.trim() === '' ||
    !safeNonNegativeInteger(frame.revision) ||
    !safeNonNegativeInteger(frame.index) ||
    !safeNonNegativeInteger(frame.turn) ||
    !safeNonNegativeInteger(frame.step) ||
    !safeInteger(frame.time) ||
    !safeNonNegativeInteger(value.transientSequence)
  )
    return undefined
  let startedAfterSeq: number | undefined
  if (frame.startedAfterSeq !== undefined) {
    if (!safeCursor(frame.startedAfterSeq)) return undefined
    startedAfterSeq = frame.startedAfterSeq
  }
  const chunkType = chunk.type
  if (chunkType !== 'text-delta' && chunkType !== 'reasoning-delta') return undefined
  if (typeof chunk.text !== 'string') return undefined
  const common = {
    sessionId,
    messageId: `assistant:${String(frame.turn)}:${String(frame.step)}`,
    delta: chunk.text,
    turn: frame.turn,
    step: frame.step,
    time: frame.time,
    transientSequence: value.transientSequence,
    transientAttemptId: frame.attemptId,
    transientIndex: frame.index,
    ...(startedAfterSeq === undefined ? {} : { transientStartedAfterSequence: startedAfterSeq }),
  }
  return chunkType === 'text-delta'
    ? { type: 'message.delta', ...common }
    : { type: 'reasoning.delta', ...common }
}

function normalizeAssistantInterruptionFrame(value: Record<string, unknown>): BackendEvent | undefined {
  const sessionId =
    typeof value.sessionId === 'string' && value.sessionId.trim() !== '' ? value.sessionId : undefined
  if (
    sessionId === undefined ||
    typeof value.attemptId !== 'string' ||
    value.attemptId.trim() === '' ||
    !safeNonNegativeInteger(value.turn) ||
    !safeNonNegativeInteger(value.step)
  )
    return undefined
  return {
    type: 'message.completed',
    sessionId,
    messageId: `assistant:${String(value.turn)}:${String(value.step)}`,
    turn: value.turn,
    step: value.step,
    interrupted: true,
  }
}

function mapStreamEvent(name: string, value: unknown): BackendEvent {
  // A model-only surface replacement is asked of the mapper before the
  // canonical assert below: the assert is about the payload a transcript row
  // needs, and letting it reject a replacement copy would degrade the copy into
  // a payload-carrying unknown row or drop its durable sequence.
  if (isReplacementSurfaceEvent(name, value)) return rc6Mapper.event(name, value)
  try {
    assertCanonicalSessionEvent(name, value)
    return rc6Mapper.event(name, value)
  } catch {
    const data = record(value)
    return {
      type: 'unknown',
      ...(typeof data?.sessionId === 'string' ? { sessionId: data.sessionId } : {}),
      name,
      payload: safePayload(value),
    }
  }
}

function withSequence(event: BackendEvent, value: unknown): BackendEvent {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { ...event, sequence: value }
    : event
}

function isDurableSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

export function eventSessionId(event: BackendEvent): string | undefined {
  if ('sessionId' in event && typeof event.sessionId === 'string') return event.sessionId
  if ('request' in event) return event.request.sessionId
  if ('question' in event) return event.question.sessionId
  if ('retry' in event) return event.retry.sessionId
  return undefined
}

export function eventTransientSequence(event: BackendEvent): number | undefined {
  if (event.type !== 'message.delta' && event.type !== 'reasoning.delta') return undefined
  return event.transientSequence
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function safeCursor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1 && !Object.is(value, -0)
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)
}

export function safeReason(error: unknown): string {
  if (error instanceof AppError) {
    const method = error.context?.method
    const status = error.context?.status
    if (typeof method === 'string' && typeof status === 'number')
      return `DSH event stream request ${method} failed (HTTP ${status}).`
    if (error.context?.timedOut === true && typeof method === 'string')
      return `DSH event stream request ${method} timed out.`
    return `DSH event stream disconnected (${error.code}).`
  }
  const detail = safeErrorDetail(error)
  return detail === undefined ? 'DSH event stream disconnected.' : `DSH event stream disconnected: ${detail}`
}

function streamErrorReason(value: unknown): string {
  const error = record(value)
  const code = typeof error?.code === 'string' ? error.code : undefined
  const message = safeErrorDetail(typeof error?.message === 'string' ? new Error(error.message) : undefined)
  if (code === undefined) return 'DSH event stream reported an unspecified error.'
  return message === undefined
    ? `DSH event stream reported ${code}.`
    : `DSH event stream reported ${code}: ${message}`
}

function safeErrorDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const detail = redactText(error.message, 240)
  return detail === '' ? undefined : detail
}
