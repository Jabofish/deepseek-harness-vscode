import { AppError, parseSlashCommand, type CommandRepository, type DynamicCommand } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { unwrapRpcResultValue } from '../versions/rc6/rpc.js'

export class Rc6CommandRepository implements CommandRepository {
  public constructor(private readonly transport: DshTransport) {}

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

  public execute(sessionId: string, command: string, signal?: AbortSignal): Promise<void> {
    return executeRc6Command(this.transport, sessionId, command, signal)
  }
}

/** Dispatch through rc.6's official Typert Remote command executor. */
export async function executeRc6Command(
  transport: DshTransport,
  sessionId: string,
  command: string,
  signal?: AbortSignal,
): Promise<void> {
  const wireCommand = normalizeSlashCommand(command)
  if (sessionId.trim() === '')
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'A DSH session is required to execute a slash command.',
      retryable: false,
    })
  const response = await transport.remoteRequest<unknown>(
    'commands/execute',
    { agentId: sessionId, line: wireCommand },
    signal,
  )
  const result = unwrapRpcResultValue(response, 'commands/execute')
  if (result === undefined)
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The DSH slash command is not available in this session.',
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
    typeof (input as Record<string, unknown>).hint !== 'string'
  )
    throw malformedCommandDirectory()
  return {
    name: record.name,
    description: record.description,
    input: { hint: (input as Record<string, unknown>).hint as string },
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
