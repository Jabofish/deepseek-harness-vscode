import { AppError, parseSlashCommand, type CommandRepository, type DynamicCommand } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc } from '../versions/rc6/rpc.js'

export class Rc6CommandRepository implements CommandRepository {
  public constructor(private readonly transport: DshTransport) {}

  public list(_sessionId?: string, _signal?: AbortSignal): Promise<readonly DynamicCommand[]> {
    // rc.6 intentionally exposes no command-directory RPC. The official
    // session.prompt contract accepts every registered slash command, so the
    // composer must remain free-form instead of maintaining a local allowlist.
    return Promise.resolve([])
  }

  public execute(sessionId: string, command: string, signal?: AbortSignal): Promise<void> {
    return executeRc6Command(this.transport, sessionId, command, signal)
  }
}

/**
 * Dispatch through the pinned rc.6 session.prompt contract. The host owns the
 * command registry, arguments, permissions, lifecycle events, and execution;
 * the extension must not invent a parallel command endpoint.
 */
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
  const result = await callRpc<{
    readonly accepted: true
    readonly command?: { readonly kind: 'success'; readonly text?: string }
  }>(
    transport,
    'session.prompt',
    { sessionId, mode: 'queue', content: [{ type: 'text', text: wireCommand }] },
    signal,
  )
  if (result === undefined || result.accepted !== true)
    throw new AppError({
      code: 'PROTOCOL_ERROR',
      message: 'DSH returned an invalid slash-command response.',
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
