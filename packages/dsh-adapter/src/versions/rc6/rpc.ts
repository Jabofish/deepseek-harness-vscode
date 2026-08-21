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
  const attachmentReason = code === 'attachment-error' ? safeAttachmentReason(error?.details) : undefined
  throw new AppError({
    code: mapRpcError(code),
    message: safeRpcMessage(method, code, error?.message, attachmentReason),
    retryable: code === 'cancelled' || code === 'agent-busy' || code === 'settings-conflict',
    context: {
      rpcMethod: method,
      rpcCode: code,
      ...(attachmentReason === undefined ? {} : { attachmentReason }),
    },
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
    message: `This DSH host does not expose ${capability}.`,
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
    case 'workspace-move-invalid':
    case 'invalid-time-zone':
    case 'settings-rejected':
    case 'settings-not-exposed':
    case 'model-discovery-failed':
    case 'fork-unavailable':
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
    case 'subagent-parent-unavailable':
    case 'subagent-not-found':
    case 'subagent-catalog-diagnostic':
    case 'subagent-not-resumable':
    case 'subagent-unauthorized':
    case 'subagent-delivery-unavailable':
      return 'CAPABILITY_UNAVAILABLE'
    case 'queue-item-not-found':
      return 'STALE_INTERACTION'
    case 'steer-unavailable':
    case 'directory-picker-unavailable':
      return 'CAPABILITY_UNAVAILABLE'
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

function safeRpcMessage(
  method: string,
  code: string,
  message: string | undefined,
  attachmentReason?: string,
): string {
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
    'workspace-move-invalid': 'The DSH workspace session order could not be changed.',
    'title-invalid': 'The DSH session title is invalid.',
    'invalid-time-zone': 'The DSH time zone is invalid.',
    'settings-rejected': 'The DSH settings change was rejected.',
    'settings-not-exposed': 'This DSH settings namespace is not exposed by the host.',
    'model-discovery-failed': 'The DSH model catalog could not be loaded.',
    'fork-unavailable': 'The DSH session cannot be forked in this host.',
    'directory-picker-unavailable': 'The DSH host cannot open a directory picker.',
    'queue-item-not-found': 'The queued DSH prompt is no longer available.',
    'steer-unavailable': 'The queued DSH prompt cannot be steered.',
    'subagent-parent-unavailable': 'The parent DSH session is no longer available.',
    'subagent-not-found': 'The requested DSH subagent is no longer available.',
    'subagent-catalog-diagnostic': 'The DSH subagent catalog is temporarily unavailable.',
    'subagent-not-resumable': 'The DSH subagent cannot be resumed.',
    'subagent-unauthorized': 'The DSH subagent is not authorized for this session.',
    'subagent-delivery-unavailable': 'The DSH subagent could not receive the message.',
    'directory-unreadable': 'The DSH directory could not be read.',
    'directory-exists': 'The DSH directory already exists.',
    'directory-create-failed': 'The DSH directory could not be created.',
    'attachment-error': 'The DSH rejected the attachment.',
    internal: 'The DSH returned an internal error.',
  }
  if (code === 'attachment-error') {
    switch (attachmentReason) {
      case 'MODEL_DOES_NOT_SUPPORT_IMAGES':
        return 'The selected DSH model does not support image input.'
      case 'IMAGE_DIMENSION_TOO_LARGE':
        return 'The DSH rejected the image because one side exceeds its configured dimension limit.'
      case 'IMAGE_TOO_MANY_PIXELS':
        return 'The DSH rejected the image because its decoded pixel count is too large.'
      case 'IMAGE_TOO_LARGE':
      case 'IMAGES_TOO_LARGE':
        return 'The DSH rejected the image because it exceeds the configured byte limit.'
      case 'TOO_MANY_IMAGES':
        return 'The DSH rejected the prompt because it contains too many images.'
      case 'UNSUPPORTED_IMAGE_TYPE':
        return 'The DSH host does not accept this image type.'
      case 'INVALID_IMAGE_BASE64':
      case 'INVALID_IMAGE':
      case 'IMAGE_TYPE_MISMATCH':
        return 'The DSH rejected the image data. Select the file again or convert it to a supported image.'
      default:
        return known[code] ?? `DSH method ${method} failed.`
    }
  }
  const fallback = known[code] ?? `DSH method ${method} failed.`
  const detail = safeRpcDiagnostic(message)
  if (detail === undefined || detail === fallback) return fallback
  return `${fallback} Details: ${detail}`
}

/** Keep useful DSH failure text without allowing credentials or huge payloads across the boundary. */
function safeRpcDiagnostic(message: string | undefined): string | undefined {
  if (typeof message !== 'string') return undefined
  const compact = message.replace(/\s+/gu, ' ').trim()
  if (compact === '') return undefined
  const redacted = compact.replace(
    /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret|private[_ -]?key|token|prompt|body|response)\b\s*[:=]\s*[^\s,;]+/giu,
    (match) => match.replace(/[:=].*$/u, ': [redacted]'),
  )
  return redacted.slice(0, 320)
}

function safeAttachmentReason(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return undefined
  const reason = (details as Record<string, unknown>).reason
  return typeof reason === 'string' && /^[A-Z0-9_]{1,96}$/u.test(reason) ? reason : undefined
}
