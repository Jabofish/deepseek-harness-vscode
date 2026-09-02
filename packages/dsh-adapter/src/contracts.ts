import type {
  BackendCandidate,
  BackendCapabilities,
  BackendEndpoint,
  ConnectedBackend,
  DshBackend,
} from '@dsh-vscode/domain'

export const SUPPORTED_DSH_VERSIONS = [
  '0.1.0-rc.6',
  '0.1.0-rc.7',
  '0.1.0-rc.8',
  '0.1.1-rc.1',
  '0.1.1-rc.2',
  // Keep every verified upstream snapshot in the exact set. Unknown releases
  // are handled only by an adapter's explicit compatibility probe.
  '0.1.2-alpha.1',
  '0.1.2-alpha.2',
  '0.1.2-alpha.3',
  '0.1.2-alpha.4',
  '0.1.2-alpha.5',
] as const

export const SUPPORTED_DSH_RANGE =
  '0.1.0-rc.6 through 0.1.1-rc.2; upstream 0.1.2-alpha.1 through 0.1.2-alpha.5' as const

export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh' as const

/** Latest published package used by the extension's installer. */
export const LATEST_PUBLISHED_DSH_VERSION = '0.1.1-rc.2' as const

/** Do not make a prerelease upstream snapshot the install default. */
export const LATEST_SUPPORTED_DSH_VERSION = LATEST_PUBLISHED_DSH_VERSION

/** Newest upstream snapshot for which this checkout has a verified adapter. */
export const LATEST_VERIFIED_DSH_VERSION = SUPPORTED_DSH_VERSIONS[SUPPORTED_DSH_VERSIONS.length - 1]

export function isKnownDshVersion(version: string): boolean {
  return (SUPPORTED_DSH_VERSIONS as readonly string[]).includes(version)
}

export function isKnownDshAlphaVersion(version: string): boolean {
  const normalized = normalizeDshVersion(version)
  return normalized !== undefined && isKnownDshVersion(normalized) && normalized.includes('-alpha.')
}

export function normalizeDshVersion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const match = value.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/u)
  return match?.[0] ?? (value.trim() === '' ? undefined : value.trim())
}

export interface DshVersionAdapter {
  readonly id: string
  readonly supportedVersion: string
  /** Local contract identity selected during probing; it is not an upstream release branch. */
  readonly protocolVersion?: string
  /** Explicit newest-to-oldest priority used only for unknown runtime probes. */
  readonly compatibilityPriority?: number
  /** An adapter may service an unknown runtime after its own compatibility probe succeeds. */
  readonly fallback?: boolean
  probe(candidate: BackendCandidate, signal?: AbortSignal): Promise<BackendCapabilities | undefined>
  /**
   * Probe an unknown, non-empty runtime label without assuming that its release
   * suffix is compatible. The probe must be read-only and return only the
   * contract capabilities it can safely serve.
   */
  probeCompatibility?(
    candidate: BackendCandidate,
    signal?: AbortSignal,
  ): Promise<BackendCapabilities | undefined>
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
