import { AppError } from '@dsh-vscode/domain'

import type { DshTransport } from '../../contracts.js'
import { callRpc } from '../../versions/rc6/rpc.js'

export type CredentialRpcMethod = 'credentials.describe' | 'credentials.set' | 'credentials.unset'

/**
 * Credential providers can echo values in rejection details. Keep the trusted
 * error classification but discard message, cause and context at the adapter
 * boundary before any Host route can expose them to the Webview or logs.
 */
export async function callCredentialRpc<T>(
  transport: DshTransport,
  method: CredentialRpcMethod,
  payload: unknown,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await callRpc<T>(transport, method, payload, signal)
  } catch (error) {
    throw safeCredentialRpcError(method, error, signal)
  }
}

function safeCredentialRpcError(method: CredentialRpcMethod, error: unknown, signal?: AbortSignal): AppError {
  const message = {
    'credentials.describe': 'The DSH credential status could not be read.',
    'credentials.set': 'The DSH credential could not be stored.',
    'credentials.unset': 'The DSH credential could not be removed.',
  }[method]

  if (error instanceof AppError)
    return new AppError({ code: error.code, message, retryable: error.retryable })
  if (signal?.aborted === true)
    return new AppError({
      code: 'REQUEST_CANCELLED',
      message: 'The DSH credential operation was cancelled.',
      retryable: false,
    })
  return new AppError({ code: 'INTERNAL_ERROR', message, retryable: true })
}
