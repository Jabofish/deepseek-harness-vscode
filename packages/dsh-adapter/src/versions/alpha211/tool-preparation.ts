import type { BackendEvent } from '@dsh-vscode/domain'
import { normalizeEnvelope } from '../../stream-envelopes.js'
import { redactText } from '../../redaction.js'
import { recordOrUndefined as record } from '../../repositories/shared/guards.js'
import { ArgumentPreview } from './argument-preview.js'

/** dsh-v0.2.1-alpha.1 / 5badb150: typed assistant chunks, never model prose. */
export function createAlpha211SessionNormalizer(): (value: unknown) => BackendEvent | undefined {
  let attemptId: string | undefined
  let lastIndex = -1
  let sessionId: string | undefined
  const calls = new Map<
    string,
    { blockIndex: number; name?: string; sealed?: boolean; arguments: ArgumentPreview }
  >()
  return (value) => {
    const envelope = record(record(value)?.payload ?? value)
    if (envelope?.type === 'session/subscribed') {
      calls.clear()
      attemptId = undefined
      lastIndex = -1
    }
    if (envelope?.type !== 'session/assistant-stream') {
      const event = normalizeEnvelope(value)
      if (
        event?.type === 'step.ended' ||
        event?.type === 'turn.ended' ||
        event?.type === 'assistant.attempt' ||
        (event?.type === 'message.completed' && event.interrupted === true)
      ) {
        for (const call of calls.values()) call.sealed = true
      }
      return event
    }
    const frame = record(envelope.frame)
    const chunk = record(frame?.chunk)
    const block = record(chunk?.block)
    if (
      chunk?.type === 'block-end' &&
      block?.type === 'tool-call' &&
      typeof block.id === 'string' &&
      frame?.attemptId === attemptId
    ) {
      const call = calls.get(block.id)
      if (call !== undefined && call.blockIndex === chunk.index) call.sealed = true
    }
    if (chunk?.type !== 'tool-call-delta') return normalizeEnvelope(value)
    if (
      !identifier(envelope.sessionId) ||
      !identifier(frame?.attemptId) ||
      frame.type !== 'chunk' ||
      !index(chunk.index) ||
      !index(frame?.index) ||
      !index(frame?.turn) ||
      !index(frame?.step) ||
      !identifier(chunk.id) ||
      typeof chunk.argumentsDelta !== 'string' ||
      (chunk.name !== undefined && !identifier(chunk.name))
    )
      return undefined
    if (sessionId !== undefined && sessionId !== envelope.sessionId) return undefined
    sessionId = envelope.sessionId
    if (attemptId !== frame.attemptId) {
      attemptId = frame.attemptId
      lastIndex = -1
      calls.clear()
    }
    if (frame.index <= lastIndex) return undefined
    lastIndex = frame.index
    let call = calls.get(chunk.id)
    if (call === undefined) {
      if (calls.size >= 128) return undefined
      call = { blockIndex: chunk.index, arguments: new ArgumentPreview() }
      calls.set(chunk.id, call)
    }
    if (call.sealed === true || call.blockIndex !== chunk.index) return undefined
    if (typeof chunk.name === 'string') {
      if (call.name !== undefined && call.name !== chunk.name) return undefined
      call.name = chunk.name
    }
    call.arguments.append(chunk.argumentsDelta)
    if (call.name === undefined) return undefined
    const preview = call.arguments.snapshot()
    const fileTool = call.name === 'write' || call.name === 'edit' || call.name === 'read'
    return {
      type: 'tool.preparing',
      sessionId: envelope.sessionId,
      callId: chunk.id,
      toolName: call.name,
      attemptId: frame.attemptId,
      turn: frame.turn,
      step: frame.step,
      updateIndex: frame.index,
      ...(preview.description === undefined ? {} : { description: redactText(preview.description, 512) }),
      ...(fileTool && preview.filePath !== undefined ? { filePath: preview.filePath } : {}),
      ...(fileTool && preview.contentCharacters !== undefined
        ? { contentCharacters: preview.contentCharacters }
        : {}),
    }
  }
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= 256 &&
    [...value].every((character) => character.charCodeAt(0) > 0x1f && character.charCodeAt(0) !== 0x7f)
  )
}
function index(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}
