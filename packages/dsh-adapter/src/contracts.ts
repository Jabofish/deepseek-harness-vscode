import type {
  BackendCandidate,
  BackendCapabilities,
  BackendEndpoint,
  ConnectedBackend,
  DshBackend,
} from '@dsh-vscode/domain'

export const SUPPORTED_DSH_RANGE = '0.1.0-rc.6' as const

export interface DshVersionAdapter {
  readonly id: string
  readonly supportedVersion: string
  probe(candidate: BackendCandidate, signal?: AbortSignal): Promise<BackendCapabilities | undefined>
  createTransport(endpoint: BackendEndpoint): DshTransport
  createBackend?(backend: ConnectedBackend, signal?: AbortSignal): Promise<DshBackend>
}

export interface DshTransport {
  request<TResponse>(method: string, params: unknown, signal?: AbortSignal): Promise<TResponse>
  openEventStream(signal?: AbortSignal): AsyncIterable<unknown>
  openMuxStream?(signal: AbortSignal): AsyncIterable<unknown>
  openHostStream?(signal: AbortSignal): AsyncIterable<unknown>
  respondEnvelope?(rpcId: string, result: unknown, signal?: AbortSignal): Promise<unknown>
  downloadSessionLog?(sessionId: string, includeDescendants: boolean, signal?: AbortSignal): Promise<Response>
  close(): Promise<void>
}

export interface RetryPolicy {
  readonly maximumAttempts: number
  readonly baseDelayMs: number
  readonly maximumDelayMs: number
}
