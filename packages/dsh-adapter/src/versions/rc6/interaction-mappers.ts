import type {
  BackendEvent,
  PermissionRequest,
  QueuedInput,
  UserQuestion,
  UserQuestionItem,
} from '@dsh-vscode/domain'

import { attachedFileEnvelope } from '../../attachment-codec.js'
import { assertCanonicalContentBlocks } from './canonical-events.js'
import { contentText, messageImages } from './message-mappers.js'
import { array, date, firstString, object, requiredArray, stringOr } from './value-guards.js'
import { recordOrUndefined as objectOrUndefined } from '../../repositories/shared/guards.js'

export function commandNotice(name: string, data: Record<string, unknown>, sessionId: string): BackendEvent {
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

/**
 * Preserve the structured command/run input for the UI projection. This is not
 * re-parsed from rendered text, and it is the transcript's only record of the
 * line that ran: upstream logs `args` verbatim (`parseCommand` keeps the rest
 * of the submitted line) with no length bound, so clipping it would drop the
 * tail of the user's own command row silently.
 */
function commandInputText(commandName: string, rawArgs: unknown): string | undefined {
  if (!/^[a-z][a-z0-9_-]*$/iu.test(commandName)) return undefined
  const args = typeof rawArgs === 'string' ? rawArgs.trimEnd() : ''
  return `/${commandName}${args}`
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

export function approvalOutcome(
  value: unknown,
): value is 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' {
  return value === 'allowed-once' || value === 'rejected' || value === 'cancelled' || value === 'unavailable'
}

export function queuedInput(value: unknown, sessionId: string): QueuedInput[] {
  const record = objectOrUndefined(value)
  if (
    record === undefined ||
    (record.placement !== 'queued' && record.placement !== 'steering' && record.placement !== 'context')
  )
    throw new Error('Malformed session/queue item')
  const message = objectOrUndefined(record.message)
  // The rc.6-family mux publishes the pending message with its role and source.
  // The alpha Session Controller strips it down to the id and its content
  // blocks and carries the prompt correlation on the item instead, so a
  // missing role or source is the lean shape rather than corruption. A value
  // that is present must still be valid: this frame fails closed on garbage
  // instead of letting the repository wipe a live queue.
  if (
    message === undefined ||
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    typeof message.id !== 'string' ||
    message.id.length === 0 ||
    (Object.hasOwn(message, 'role') &&
      message.role !== 'system' &&
      message.role !== 'user' &&
      message.role !== 'assistant') ||
    (Object.hasOwn(message, 'source') && !isMessageSource(message.source)) ||
    !Array.isArray(message.content) ||
    !message.content.every((entry) => {
      const block = objectOrUndefined(entry)
      return block !== undefined && typeof block.type === 'string'
    })
  )
    throw new Error('Malformed session/queue item')
  try {
    assertCanonicalContentBlocks(message.content, 'session/queue message content')
  } catch {
    throw new Error('Malformed session/queue item')
  }
  if (record.placement === 'context') return []
  const source = objectOrUndefined(message.source)
  const rpcId = firstString(message.rpcId, source?.rpcId, record.rpcId)
  const images = messageImages(message)
  const projection = queuedMessageProjection(message)
  return [
    {
      id: record.id,
      sessionId,
      text: projection.text,
      attachments: [],
      ...(images.length === 0 ? {} : { images }),
      ...(projection.files.length === 0 ? {} : { files: projection.files }),
      textOnly: projection.textOnly,
      mode: record.placement === 'steering' ? 'steer' : 'queue',
      createdAt: date(record.createdAt),
      ...(rpcId === undefined ? {} : { rpcId }),
    },
  ]
}

interface QueuedMessageProjection {
  readonly text: string
  readonly files: readonly string[]
  readonly textOnly: boolean
}

/**
 * Project a pending message the way its durable form is projected.
 *
 * A text file the adapter inlined arrives as an "Attached file: …" text block.
 * Adopting its body as the row's text would paste the whole file into the dock
 * and — because every block is text — mark the row editable, so one edit would
 * replace the file with its own bytes. The envelope becomes a file name chip
 * instead. `files` then lists every name the message carries in block order,
 * which is also the order the durable message reports its attachments in.
 */
function queuedMessageProjection(value: Record<string, unknown>): QueuedMessageProjection {
  const textParts: string[] = []
  const files: string[] = []
  let textOnly = true
  for (const entry of array(value.content)) {
    const block = objectOrUndefined(entry)
    if (block?.type === 'text' && typeof block.text === 'string') {
      const attached = attachedFileEnvelope(block.text)
      if (attached !== undefined) {
        files.push(attached.name)
        textOnly = false
        continue
      }
      if (block.text !== '') textParts.push(block.text)
      continue
    }
    if (block?.type === 'file') {
      const attachment = objectOrUndefined(block.attachment)
      const name = typeof attachment?.name === 'string' ? attachment.name.trim() : ''
      if (name !== '') files.push(name)
      textOnly = false
      continue
    }
    textOnly = false
    const text = contentText([entry], false)
    if (text !== '') textParts.push(text)
  }
  return { text: textParts.join('\n'), files: uniqueStrings(files), textOnly }
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const unique: string[] = []
  for (const value of values) if (!unique.includes(value)) unique.push(value)
  return unique
}

function isMessageSource(value: unknown): value is Record<string, unknown> {
  const source = objectOrUndefined(value)
  return source !== undefined && typeof source.kind === 'string'
}

export function permission(value: Record<string, unknown>): PermissionRequest {
  const displayReason = localizedText(value.displayReason)
  return {
    id: stringOr(value.approvalId ?? value.id, 'approval'),
    ...(typeof value.rpcId === 'string' ? { rpcId: value.rpcId } : {}),
    sessionId: stringOr(value.sessionId, ''),
    title: stringOr(value.toolName, 'Permission required'),
    description: stringOr(value.reason, 'DSH requested permission to continue.'),
    ...(displayReason === undefined ? {} : { displayReason }),
    // The request carries no command: only the pairing id. The renderer reads
    // the command from that call, so the id travels unchanged (a value the host
    // does not use is no pairing and must not claim to be one).
    ...(typeof value.callId === 'string' && value.callId !== '' ? { callId: value.callId } : {}),
    ...(typeof value.commandLine === 'string' && value.commandLine.trim() !== ''
      ? { commandLine: value.commandLine.trim().slice(0, 4_096) }
      : {}),
    risk: 'unknown',
    options: [
      { id: 'allowed-once', label: 'Allow once', kind: 'allow-once' },
      { id: 'rejected', label: 'Reject', kind: 'deny' },
    ],
  }
}

function localizedText(value: unknown): PermissionRequest['displayReason'] | undefined {
  if (!isLocalizedText(value)) return undefined
  return { ...value }
}

export function isLocalizedText(value: unknown): value is NonNullable<PermissionRequest['displayReason']> {
  const record = objectOrUndefined(value)
  return (
    record !== undefined &&
    Object.hasOwn(record, 'en') &&
    typeof record.en === 'string' &&
    Object.values(record).every((entry) => typeof entry === 'string')
  )
}

export function question(value: Record<string, unknown>): UserQuestion {
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
