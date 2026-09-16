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
import { unwrapOptionalRpcResultValue, unwrapRpcResultValue } from '../versions/rc6/rpc.js'

/**
 * The attachment parameter of `commands/execute` for one host version.
 *
 * Audited from the upstream tags: 0.1.0-rc.7 and older declare no attachment
 * parameter at all, 0.1.0-rc.8 through 0.1.2-rc.1 require `images` as plain
 * `EncodedImageAttachment` entries, and 0.1.3-alpha.1 renamed the parameter to
 * `submittedAttachments`, whose image entries carry a `type: 'image'` tag next
 * to the staged-file receipts. The parameter is required whenever it exists:
 * an omitted field fails the strict Remote descriptor.
 */
export type CommandAttachmentWire = 'none' | 'images' | 'submittedAttachments'

export class Rc6CommandRepository implements CommandRepository {
  public constructor(
    private readonly transport: DshTransport,
    private readonly attachmentWire: CommandAttachmentWire = 'none',
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
    return executeCommand(this.transport, sessionId, command, attachments, requestSignal, this.attachmentWire)
  }
}

/** rc.8's Remote signature added a required images array to commands/execute. */
export class Rc8CommandRepository extends Rc6CommandRepository {
  public constructor(transport: DshTransport) {
    super(transport, 'images')
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
  return executeCommand(transport, sessionId, command, attachmentsOrSignal, signal, 'none')
}

/**
 * Session-configuration commands (`/permission`, `/plan`) travel without
 * attachments; every host that declares the parameter still requires it, so the
 * wire decides between an omitted array and an empty one.
 *
 * The line is applied by the caller, so an unresolved answer cannot be
 * forwarded: a configuration that silently skipped its command would report a
 * mode the host never entered.
 */
export async function executeSessionConfigCommand(
  transport: DshTransport,
  sessionId: string,
  command: string,
  attachmentWire: CommandAttachmentWire,
  signal?: AbortSignal,
): Promise<void> {
  const result = await executeCommand(transport, sessionId, command, [], signal, attachmentWire)
  if (result.kind === 'unknown')
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The DSH slash command is not available in this session.',
      retryable: false,
    })
}

async function executeCommand(
  transport: DshTransport,
  sessionId: string,
  command: string,
  attachmentsOrSignal: readonly PromptAttachment[] | AbortSignal = [],
  signal?: AbortSignal,
  attachmentWire: CommandAttachmentWire = 'none',
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
  const encoded = attachments.length === 0 ? [] : encodeImageAttachments(attachments)
  if (encoded === undefined)
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
      ...commandAttachmentField(attachmentWire, encoded),
    },
    requestSignal,
  )
  // The Remote signature resolves to `CommandExecution | undefined`, so the
  // host answers an ok envelope without a value for every line outside its
  // command directory — including the `/skill-name args` lines that address a
  // user-invocable skill. That absence is the answer, not a malformed reply.
  const result = unwrapOptionalRpcResultValue<unknown>(response, 'commands/execute')
  if (result === undefined) return { kind: 'unknown' }
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

/**
 * The attachment arguments for one `commands/execute` call. A host without the
 * parameter rejects the request outright, so an attachment that cannot travel
 * to that version must fail before the request leaves the Host.
 */
function commandAttachmentField(
  wire: CommandAttachmentWire,
  encoded: readonly Record<string, string>[],
): Record<string, unknown> {
  if (wire === 'none') {
    if (encoded.length > 0)
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'This DSH version cannot carry attachments on a slash command.',
        retryable: false,
      })
    return {}
  }
  if (wire === 'images') return { images: encoded }
  return { submittedAttachments: encoded.map((image) => ({ type: 'image', ...image })) }
}

function toDynamicCommand(value: unknown): DynamicCommand {
  if (typeof value !== 'object' || value === null) throw malformedCommandDirectory()
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || !/^[a-z][a-z0-9_-]*$/u.test(record.name))
    throw malformedCommandDirectory()
  if (typeof record.description !== 'string') throw malformedCommandDirectory()
  const input = record.input
  if (input === undefined) return { name: record.name, description: record.description }
  if (typeof input !== 'object' || input === null) throw malformedCommandDirectory()
  const hint = (input as Record<string, unknown>).hint
  const images = (input as Record<string, unknown>).images
  // 0.1.3-alpha.1 renamed the capability flag from `images` to `attachments`;
  // both name the same composer permission, so the directory keeps one shape.
  const attachments = (input as Record<string, unknown>).attachments
  if (typeof hint !== 'string') throw malformedCommandDirectory()
  if (images !== undefined && typeof images !== 'boolean') throw malformedCommandDirectory()
  if (attachments !== undefined && typeof attachments !== 'boolean') throw malformedCommandDirectory()
  return {
    name: record.name,
    description: record.description,
    input: {
      hint,
      ...(images === true || attachments === true ? { images: true } : {}),
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
