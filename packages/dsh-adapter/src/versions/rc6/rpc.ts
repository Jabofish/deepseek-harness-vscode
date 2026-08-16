import { AppError, type AppErrorCode } from '@dsh-vscode/domain'

import type { DshTransport } from '../../contracts.js'

type RpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false
      readonly error?: { readonly code?: string; readonly message?: string; readonly details?: unknown }
    }

export interface RpcResponseLike<T> {
  readonly rpcId?: string
  readonly result?: RpcResult<T>
}

/** Unwrap either the ordinary Host API or a Typert Remote RpcResult. */
export function unwrapRpcResult<T>(response: RpcResponseLike<T>, method: string): T {
  if (
    typeof response !== 'object' ||
    response === null ||
    response.result === undefined ||
    typeof response.result !== 'object' ||
    response.result === null ||
    typeof response.result.ok !== 'boolean'
  ) {
    throw new AppError({
      code: 'PROTOCOL_ERROR',
      message: `Malformed response from DSH method ${method}.`,
      retryable: false,
    })
  }
  if (response.result.ok) {
    if (!('value' in response.result))
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: `Malformed response from DSH method ${method}.`,
        retryable: false,
      })
    return response.result.value
  }
  const error = response.result.error
  const code = error?.code ?? 'internal'
  throw new AppError({
    code: mapRpcError(code),
    message: safeRpcMessage(method, code, error?.message),
    retryable: code === 'cancelled' || code === 'agent-busy' || code === 'settings-conflict',
    context: { rpcMethod: method, rpcCode: code },
  })
}

/**
 * Unwrap a result returned by a Remote carrier.
 *
 * The ordinary Host API client returns the complete response envelope, while
 * LoopbackApiClient.dispatchRemote validates that envelope and returns its
 * `result` member.  Keep the same strict validation for that already-unwrapped
 * value without pretending it still has another `.result` property.
 */
export function unwrapRpcResultValue<T>(result: unknown, method: string): T {
  return unwrapRpcResult<T>({ result: result as RpcResult<T> }, method)
}

export async function callRpc<T>(
  transport: DshTransport,
  method: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return unwrapRpcResult(await transport.request<RpcResponseLike<T>>(method, payload, signal), method)
}

export function unavailable(capability: string): AppError {
  return new AppError({
    code: 'CAPABILITY_UNAVAILABLE',
    message: `This rc.6 DSH host does not expose ${capability}.`,
    retryable: false,
  })
}

function mapRpcError(code: string): AppErrorCode {
  switch (code) {
    case 'cancelled':
      return 'REQUEST_CANCELLED'
    case 'model-unavailable':
      return 'AUTH_REQUIRED'
    case 'agent-preset-read-only':
      return 'PERMISSION_DENIED'
    case 'agent-preset-not-found':
    case 'agent-preset-invalid':
    case 'agent-preset-locked':
    case 'agent-preset-conflict':
    case 'unknown-command':
    case 'command-error':
    case 'session-conflict':
    case 'title-invalid':
    case 'workspace-invalid-path':
    case 'workspace-name-conflict':
    case 'invalid-time-zone':
    case 'bad-request':
      return 'INVALID_CONFIGURATION'
    case 'workspace-not-found':
      return 'BACKEND_UNREACHABLE'
    case 'workspace-attach-failed':
      return 'BACKEND_UNREACHABLE'
    case 'agent-busy':
      return 'BACKEND_BUSY'
    case 'settings-conflict':
      return 'BACKEND_BUSY'
    case 'credential-rejected':
      return 'PERMISSION_DENIED'
    case 'session-not-found':
      return 'BACKEND_UNREACHABLE'
    case 'attachment-error':
    case 'directory-unreadable':
    case 'directory-exists':
    case 'directory-create-failed':
      return 'INVALID_CONFIGURATION'
    case 'internal':
      return 'INTERNAL_ERROR'
    default:
      return 'PROTOCOL_ERROR'
  }
}

function safeRpcMessage(method: string, code: string, message: string | undefined): string {
  void message
  const known: Record<string, string> = {
    cancelled: 'The DSH request was cancelled.',
    'model-unavailable': 'The selected DSH model is unavailable.',
    'agent-preset-read-only': 'The selected DSH agent preset is read-only.',
    'agent-preset-not-found': 'The selected DSH agent preset is unavailable.',
    'agent-preset-invalid': 'The selected DSH agent preset is invalid.',
    'agent-preset-locked': 'The DSH agent preset is locked for this session.',
    'agent-preset-conflict': 'The DSH agent preset conflicts with this session.',
    'unknown-command': 'The DSH command is not available in this host composition.',
    'command-error': 'The DSH command could not be applied.',
    'agent-busy': 'The DSH agent is busy.',
    'settings-conflict': 'The DSH settings changed; reload and retry.',
    'credential-rejected': 'The DSH credential change was rejected.',
    'bad-request': 'The DSH request was invalid.',
    'session-conflict': 'The DSH session conflicts with the requested workspace.',
    'session-not-found': 'The requested DSH session was not found.',
    'workspace-not-found': 'The requested DSH workspace was not found.',
    'workspace-attach-failed': 'The DSH session could not be attached to the workspace.',
    'workspace-invalid-path': 'The DSH workspace path is invalid.',
    'workspace-name-conflict': 'A DSH workspace with that name already exists.',
    'title-invalid': 'The DSH session title is invalid.',
    'invalid-time-zone': 'The DSH time zone is invalid.',
    'attachment-error': 'The DSH rejected the attachment.',
    internal: 'The DSH returned an internal error.',
  }
  return known[code] ?? `DSH method ${method} failed.`
}
