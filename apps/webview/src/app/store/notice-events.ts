import { nonEmptyString } from './event-values.js'

import type { BackendEvent } from '@dsh-vscode/domain'

/** Branches are matched by event name; the caller owns the name-mutual-exclusion ordering. */
export function parseNoticeEvents(
  name: string,
  value: Record<string, unknown>,
  payload: unknown,
): BackendEvent | undefined {
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
  return undefined
}
