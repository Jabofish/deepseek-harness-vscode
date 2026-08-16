import type { BackendCandidate, BackendCapabilities, BackendEndpoint } from '@dsh-vscode/domain'

export const SUPPORTED_DSH_RANGE = '0.1.0-rc.6' as const

export interface DshVersionAdapter {
  readonly id: string
  readonly supportedVersion: string
  probe(candidate: BackendCandidate, signal?: AbortSignal): Promise<BackendCapabilities | undefined>
  createTransport(endpoint: BackendEndpoint): DshTransport
}

export interface DshTransport {
  request<TResponse>(method: string, params: unknown, signal?: AbortSignal): Promise<TResponse>
  openEventStream(signal?: AbortSignal): AsyncIterable<unknown>
  close(): Promise<void>
}

export interface RetryPolicy {
  readonly maximumAttempts: number
  readonly baseDelayMs: number
  readonly maximumDelayMs: number
}
