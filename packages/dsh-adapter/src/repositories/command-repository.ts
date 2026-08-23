import {
  AppError,
  parseSlashCommand,
  type CommandExecutionResult,
  type CommandRepository,
  type DynamicCommand,
  type PromptAttachment,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { encodeImageAttachments } from '../attachment-codec.js'
import { unwrapRpcResultValue } from '../versions/rc6/rpc.js'

export class Rc6CommandRepository implements CommandRepository {
  public constructor(
    private readonly transport: DshTransport,
    private readonly includeEmptyImages = false,
  ) {}

  public async list(sessionId?: string, signal?: AbortSignal): Promise<readonly DynamicCommand[]> {
    if (sessionId === undefined || sessionId.trim() === '') return []
    const result = await this.transport.remoteRequest<unknown>(
      'commands/list',
      { agentId: sessionId },
      signal,
    )
    const value = unwrapRpcResultValue(result, 'commands/list')
    if (!Array.isArray(value))
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: 'DSH returned an invalid command directory.',
        retryable: false,
      })
    return value.map(toDynamicCommand)
  }

  public execute(
    sessionId: string,
    command: string,
    attachmentsOrSignal?: readonly PromptAttachment[] | AbortSignal,
    signal?: AbortSignal,
  ): Promise<CommandExecutionResult> {
    const attachments = isAbortSignal(attachmentsOrSignal) ? [] : (attachmentsOrSignal ?? [])
    const requestSignal = isAbortSignal(attachmentsOrSignal) ? attachmentsOrSignal : signal
    return executeCommand(
      this.transport,
      sessionId,
      command,
      attachments,
      requestSignal,
      this.includeEmptyImages,
    )
  }
}

/** rc.8's Remote signature added a required images array to commands/execute. */
export class Rc8CommandRepository extends Rc6CommandRepository {
  public constructor(transport: DshTransport) {
    super(transport, true)
  }
}

/** Dispatch through rc.6's official Typert Remote command executor. */
export async function executeRc6Command(
  transport: DshTransport,
  sessionId: string,
  command: string,
  attachmentsOrSignal: readonly PromptAttachment[] | AbortSignal = [],
  signal?: AbortSignal,
): Promise<CommandExecutionResult> {
  return executeCommand(transport, sessionId, command, attachmentsOrSignal, signal, false)
}

/**
 * Session-configuration commands (`/permission`, `/plan`) travel without
 * attachments; rc.8+ hosts still require the `images` array in that case.
 */
export async function executeSessionConfigCommand(
  transport: DshTransport,
  sessionId: string,
  command: string,
  includeEmptyImages: boolean,
  signal?: AbortSignal,
): Promise<CommandExecutionResult> {
  return executeCommand(transport, sessionId, command, [], signal, includeEmptyImages)
}

async function executeCommand(
  transport: DshTransport,
  sessionId: string,
  command: string,
  attachmentsOrSignal: readonly PromptAttachment[] | AbortSignal = [],
  signal?: AbortSignal,
  includeEmptyImages = false,
): Promise<CommandExecutionResult> {
  const attachments = isAbortSignal(attachmentsOrSignal) ? [] : attachmentsOrSignal
  const requestSignal = isAbortSignal(attachmentsOrSignal) ? attachmentsOrSignal : signal
  const wireCommand = normalizeSlashCommand(command)
  if (sessionId.trim() === '')
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'A DSH session is required to execute a slash command.',
      retryable: false,
    })
  const images =
    includeEmptyImages || attachments.length > 0 ? encodeImageAttachments(attachments) : undefined
  if (images === undefined && attachments.length > 0)
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'Only validated image attachments can accompany a DSH slash command.',
      retryable: false,
    })
  const response = await transport.remoteRequest<unknown>(
    'commands/execute',
    {
      agentId: sessionId,
      line: wireCommand,
      ...(images === undefined ? {} : { images }),
    },
    requestSignal,
  )
  const result = unwrapRpcResultValue(response, 'commands/execute')
  if (result === undefined)
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The DSH slash command is not available in this session.',
      retryable: false,
    })
  const execution = asRecord(result)
  const outcome = asRecord(execution?.result) ?? execution
  if (outcome?.kind === 'success')
    return {
      kind: 'success',
      ...(typeof outcome.text === 'string' && outcome.text.length <= 16_384 ? { text: outcome.text } : {}),
    }
  if (outcome?.kind === 'error')
    return {
      kind: 'error',
      text:
        typeof outcome.text === 'string' && outcome.text.length <= 16_384
          ? outcome.text
          : 'The DSH slash command was rejected.',
    }
  throw new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed slash command result.',
    retryable: false,
  })
}

function toDynamicCommand(value: unknown): DynamicCommand {
  if (typeof value !== 'object' || value === null) throw malformedCommandDirectory()
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || !/^[a-z][a-z0-9_-]*$/u.test(record.name))
    throw malformedCommandDirectory()
  if (typeof record.description !== 'string') throw malformedCommandDirectory()
  const input = record.input
  if (input === undefined) return { name: record.name, description: record.description }
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof (input as Record<string, unknown>).hint !== 'string' ||
    ((input as Record<string, unknown>).images !== undefined &&
      typeof (input as Record<string, unknown>).images !== 'boolean')
  )
    throw malformedCommandDirectory()
  return {
    name: record.name,
    description: record.description,
    input: {
      hint: (input as Record<string, unknown>).hint as string,
      ...((input as Record<string, unknown>).images === true ? { images: true } : {}),
    },
  }
}

function malformedCommandDirectory(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed command descriptor.',
    retryable: false,
  })
}

function normalizeSlashCommand(command: string): string {
  if (parseSlashCommand(command) !== undefined) return command
  throw new AppError({
    code: 'INVALID_CONFIGURATION',
    message: 'The DSH slash command syntax is invalid.',
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
