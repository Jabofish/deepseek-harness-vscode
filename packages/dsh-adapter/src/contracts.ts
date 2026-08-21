import type {
  BackendCandidate,
  BackendCapabilities,
  BackendEndpoint,
  ConnectedBackend,
  DshBackend,
} from '@dsh-vscode/domain'

export const SUPPORTED_DSH_VERSIONS = ['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.1'] as const

export const SUPPORTED_DSH_RANGE = '0.1.0-rc.6 through 0.1.1-rc.1' as const

export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh' as const

export const LATEST_SUPPORTED_DSH_VERSION =
  SUPPORTED_DSH_VERSIONS[SUPPORTED_DSH_VERSIONS.length - 1] ?? 'unknown'

export function isKnownDshVersion(version: string): boolean {
  return (SUPPORTED_DSH_VERSIONS as readonly string[]).includes(version)
}

export function normalizeDshVersion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const match = value.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/u)
  return match?.[0] ?? (value.trim() === '' ? undefined : value.trim())
}

export interface DshVersionAdapter {
  readonly id: string
  readonly supportedVersion: string
  /** Wire family selected during probing; preserves the shape for unknown versions. */
  readonly protocolVersion?: string
  /** A legacy adapter may service an unknown future version after probing succeeds. */
  readonly fallback?: boolean
  probe(candidate: BackendCandidate, signal?: AbortSignal): Promise<BackendCapabilities | undefined>
  createTransport(endpoint: BackendEndpoint): DshTransport
  createBackend?(backend: ConnectedBackend, signal?: AbortSignal): Promise<DshBackend>
}

export interface DshTransport {
  request<TResponse>(method: string, params: unknown, signal?: AbortSignal): Promise<TResponse>
  /**
   * Call a pinned Typert Remote endpoint. The Loopback implementation
   * validates the complete server-response envelope and returns its `result`
   * member, so callers receive the RemoteResult union rather than another
   * response envelope.
   */
  remoteRequest<TResponse>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<TResponse>
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
