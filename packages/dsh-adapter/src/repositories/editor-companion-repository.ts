import {
  AppError,
  isEditorBridgeId,
  isEditorCompanionBinding,
  isEditorCompanionCapabilities,
  isEditorCompanionDescription,
  isEditorCompanionPoll,
  isEditorCompanionReply,
  isEditorCompanionResult,
  type AppErrorCode,
  type EditorCompanionBinding,
  type EditorCompanionCapability,
  type EditorCompanionDescription,
  type EditorCompanionPoll,
  type EditorCompanionReply,
  type EditorCompanionRepository,
  isEditorCompanionHostProof,
  type EditorCompanionHostProof,
} from '@dsh-vscode/domain'
import { unwrapRpcResultValue } from '../versions/rc6/rpc.js'

interface Transport {
  remoteRequest(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown>
}
const failure = (code: AppErrorCode): AppError =>
  new AppError({ code, message: 'The editor companion request failed.', retryable: false })
const isTrue = (value: unknown): value is true => value === true

/** Companion protocol 2, exact rc.2 transport; mutation failures are never retried. */
export class NegotiatedEditorCompanionRepository implements EditorCompanionRepository {
  public constructor(private readonly transport: Transport) {}
  public buildIdentity(signal?: AbortSignal): Promise<string> {
    return this.call(
      'buildIdentity',
      {},
      (value): value is string => typeof value === 'string' && /^(?:source|[a-f0-9]{64})$/u.test(value),
      signal,
    )
  }
  public describe(signal?: AbortSignal): Promise<EditorCompanionDescription> {
    return this.call('describe', {}, isEditorCompanionDescription, signal)
  }
  public verifyHost(nonce: string, signal?: AbortSignal): Promise<EditorCompanionHostProof> {
    if (!isEditorBridgeId(nonce)) return Promise.reject(failure('INVALID_CONFIGURATION'))
    return this.call('verifyHost', { nonce }, isEditorCompanionHostProof, signal)
  }
  public attach(
    sessionId: string,
    ownerId: string,
    capabilities: readonly EditorCompanionCapability[],
    signal?: AbortSignal,
  ): Promise<EditorCompanionBinding> {
    if (
      !sessionId ||
      sessionId.length > 256 ||
      !isEditorBridgeId(ownerId) ||
      !isEditorCompanionCapabilities(capabilities)
    )
      return Promise.reject(failure('INVALID_CONFIGURATION'))
    return this.call(
      'attach',
      { sessionId, ownerId, capabilities, protocolVersion: 2 },
      isEditorCompanionBinding,
      signal,
    )
  }
  public poll(bindingId: string, signal?: AbortSignal): Promise<EditorCompanionPoll> {
    return this.call('poll', { bindingId }, isEditorCompanionPoll, signal)
  }
  public async respond(
    bindingId: string,
    requestId: string,
    reply: EditorCompanionReply,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!isEditorBridgeId(requestId) || !isEditorCompanionReply(reply)) throw failure('INVALID_CONFIGURATION')
    await this.call('respond', { bindingId, requestId, reply }, isTrue, signal)
  }
  public async detach(bindingId: string, signal?: AbortSignal): Promise<void> {
    await this.call('detach', { bindingId }, isTrue, signal)
  }
  private async call<T>(
    method: 'buildIdentity' | 'describe' | 'verifyHost' | 'attach' | 'poll' | 'respond' | 'detach',
    request: Record<string, unknown>,
    accepts: (value: unknown) => value is T,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw failure('REQUEST_CANCELLED')
    if ('bindingId' in request && !isEditorBridgeId(request.bindingId)) throw failure('INVALID_CONFIGURATION')
    try {
      const endpoint = `vscodeEditorCompanion/${method}`
      const result = unwrapRpcResultValue<unknown>(
        await this.transport.remoteRequest(endpoint, { request }, signal),
        endpoint,
      )
      if (signal?.aborted) throw failure('REQUEST_CANCELLED')
      if (!isEditorCompanionResult(result, accepts)) throw failure('PROTOCOL_ERROR')
      if (result.status === 'error')
        throw failure(
          result.reason === 'stale-request'
            ? 'STALE_INTERACTION'
            : result.reason === 'busy'
              ? 'BACKEND_BUSY'
              : 'CAPABILITY_UNAVAILABLE',
        )
      return result.value
    } catch (error) {
      if (signal?.aborted) throw failure('REQUEST_CANCELLED')
      if (error instanceof AppError)
        throw failure(error.context?.rpcCode === 'unknown-command' ? 'CAPABILITY_UNAVAILABLE' : error.code)
      throw failure('BACKEND_UNREACHABLE')
    }
  }
}
