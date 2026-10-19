import {
  AppError,
  EDITOR_BRIDGE_PROTOCOL,
  isEditorBridgeBinding,
  isEditorBridgeId,
  isEditorBridgePoll,
  isEditorBridgeReply,
  isEditorBridgeResult,
  type AppErrorCode,
  type EditorBridgeBinding,
  type EditorBridgePoll,
  type EditorBridgeReply,
  type EditorBridgeRepository,
} from '@dsh-vscode/domain'
import { unwrapRpcResultValue } from '../rc6/rpc.js'

interface Transport {
  remoteRequest(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown>
}
const failure = (code: AppErrorCode): AppError =>
  new AppError({
    code,
    message: 'The editor companion request failed.',
    retryable: false,
  })

/** Our protocol v1, verified on dsh-v0.2.1-rc.2; fixed endpoints, no mutation retries. */
export class Rc212EditorBridgeRepository implements EditorBridgeRepository {
  public constructor(private readonly transport: Transport) {}

  public attach(sessionId: string, ownerId: string, signal?: AbortSignal): Promise<EditorBridgeBinding> {
    if (!sessionId || sessionId.length > 256 || !isEditorBridgeId(ownerId))
      return Promise.reject(failure('INVALID_CONFIGURATION'))
    return this.call(
      'attach',
      { sessionId, ownerId, protocolVersion: EDITOR_BRIDGE_PROTOCOL },
      isEditorBridgeBinding,
      signal,
    )
  }
  public poll(bindingId: string, signal?: AbortSignal): Promise<EditorBridgePoll> {
    return this.call('poll', { bindingId }, isEditorBridgePoll, signal)
  }
  public async respond(
    bindingId: string,
    requestId: string,
    reply: EditorBridgeReply,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!isEditorBridgeReply(reply) || !isEditorBridgeId(requestId)) throw failure('INVALID_CONFIGURATION')
    await this.call('respond', { bindingId, requestId, reply }, isTrue, signal)
  }
  public async detach(bindingId: string, signal?: AbortSignal): Promise<void> {
    await this.call('detach', { bindingId }, isTrue, signal)
  }

  private async call<T>(
    method: 'attach' | 'poll' | 'respond' | 'detach',
    request: Record<string, unknown>,
    accepts: (value: unknown) => value is T,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw failure('REQUEST_CANCELLED')
    if ('bindingId' in request && !isEditorBridgeId(request.bindingId)) throw failure('INVALID_CONFIGURATION')
    try {
      const endpoint = `vscodeEditorBridge/${method}`
      const wire = await this.transport.remoteRequest(endpoint, { request }, signal)
      if (signal?.aborted) throw failure('REQUEST_CANCELLED')
      const result = unwrapRpcResultValue<unknown>(wire, endpoint)
      if (!isEditorBridgeResult(result, accepts)) throw failure('PROTOCOL_ERROR')
      if (result.status === 'error')
        throw failure(
          result.reason === 'busy'
            ? 'BACKEND_BUSY'
            : result.reason === 'stale-request'
              ? 'STALE_INTERACTION'
              : 'CAPABILITY_UNAVAILABLE',
        )
      return result.value
    } catch (error) {
      if (signal?.aborted) throw failure('REQUEST_CANCELLED')
      if (error instanceof AppError) {
        if (error.context?.rpcCode === 'unknown-command') throw failure('CAPABILITY_UNAVAILABLE')
        throw failure(error.code)
      }
      throw failure('BACKEND_UNREACHABLE')
    }
  }
}
function isTrue(value: unknown): value is true {
  return value === true
}
