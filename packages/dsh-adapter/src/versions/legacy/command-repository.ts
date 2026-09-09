import {
  AppError,
  parseSlashCommand,
  type CommandExecutionResult,
  type CommandRepository,
  type DynamicCommand,
  type PromptAttachment,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../../contracts.js'
import { callRpc, unavailable } from '../rc6/rpc.js'

/**
 * The 0.0.1 command surface predates Typert Remotes. It exposes the same
 * logical command directory, but over two unary `command.*` methods and
 * without image attachments in either descriptor or execution request.
 */
export class LegacyCommandRepository implements CommandRepository {
  public constructor(private readonly transport: DshTransport) {}

  public async list(sessionId?: string, signal?: AbortSignal): Promise<readonly DynamicCommand[]> {
    if (sessionId === undefined || sessionId.trim() === '') return []
    const value = await callRpc<unknown>(this.transport, 'command.list', { sessionId }, signal)
    const record = asRecord(value)
    if (record === undefined || !Array.isArray(record.commands)) throw malformedCommandDirectory()
    return record.commands.map(toLegacyCommand)
  }

  public execute(
    sessionId: string,
    command: string,
    attachmentsOrSignal?: readonly PromptAttachment[] | AbortSignal,
    signal?: AbortSignal,
  ): Promise<CommandExecutionResult> {
    const attachments = isAbortSignal(attachmentsOrSignal) ? [] : (attachmentsOrSignal ?? [])
    const requestSignal = isAbortSignal(attachmentsOrSignal) ? attachmentsOrSignal : signal
    if (attachments.length > 0) return Promise.reject(unavailable('legacy slash command images'))
    return executeLegacyCommand(this.transport, sessionId, command, requestSignal)
  }
}

/** Used by session configuration rollback/compensation on rc.1/rc.2. */
export async function executeLegacySessionConfigCommand(
  transport: DshTransport,
  sessionId: string,
  command: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await executeLegacyCommand(transport, sessionId, command, signal)
  if (result.kind === 'error')
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: result.text,
      retryable: false,
    })
}

async function executeLegacyCommand(
  transport: DshTransport,
  sessionId: string,
  command: string,
  signal?: AbortSignal,
): Promise<CommandExecutionResult> {
  if (sessionId.trim() === '')
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'A DSH session is required to execute a slash command.',
      retryable: false,
    })
  if (parseSlashCommand(command) === undefined)
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The DSH slash command syntax is invalid.',
      retryable: false,
    })
  const value = await callRpc<unknown>(transport, 'command.execute', { sessionId, line: command }, signal)
  const result = asRecord(value)
  if (result === undefined || typeof result.matched !== 'boolean')
    throw new AppError({
      code: 'PROTOCOL_ERROR',
      message: 'DSH returned a malformed slash command acknowledgment.',
      retryable: false,
    })
  if (
    result.commandId !== undefined &&
    (typeof result.commandId !== 'string' || result.commandId.trim() === '')
  )
    throw new AppError({
      code: 'PROTOCOL_ERROR',
      message: 'DSH returned a malformed slash command identifier.',
      retryable: false,
    })
  return result.matched
    ? { kind: 'success' }
    : { kind: 'error', text: 'The DSH slash command was not found in this session.' }
}

function toLegacyCommand(value: unknown): DynamicCommand {
  const record = asRecord(value)
  if (
    record === undefined ||
    typeof record.name !== 'string' ||
    !/^[a-z][a-z0-9_-]*$/u.test(record.name) ||
    typeof record.description !== 'string'
  )
    throw malformedCommandDirectory()
  const input = record.input
  if (input === undefined) return { name: record.name, description: record.description }
  const inputRecord = asRecord(input)
  if (inputRecord === undefined || typeof inputRecord.hint !== 'string') throw malformedCommandDirectory()
  return {
    name: record.name,
    description: record.description,
    input: { hint: inputRecord.hint },
  }
}

function malformedCommandDirectory(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed legacy command directory.',
    retryable: false,
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function isAbortSignal(value: readonly PromptAttachment[] | AbortSignal | undefined): value is AbortSignal {
  return typeof value === 'object' && value !== null && 'aborted' in value && 'addEventListener' in value
}
