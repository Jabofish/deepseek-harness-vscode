import type {
  BackendCandidate,
  BackendCapabilities,
  BackendEndpoint,
  ConnectedBackend,
  DshBackend,
} from '@dsh-vscode/domain'

export const SUPPORTED_DSH_VERSIONS = [
  // Published 0.0.1 history. rc.1/rc.2 use the pre-Remote command API;
  // rc.5 returns to the rc.6 Host API family.
  '0.0.1-rc.1',
  '0.0.1-rc.2',
  '0.0.1-rc.5',
  // 0.1.0-rc.2/rc.3 are exact aliases of the rc.6 Host API wire contract.
  '0.1.0-rc.2',
  '0.1.0-rc.3',
  '0.1.0-rc.6',
  '0.1.0-rc.7',
  '0.1.0-rc.8',
  '0.1.1-rc.1',
  '0.1.1-rc.2',
  '0.1.2-rc.1',
  // Keep every verified upstream snapshot in the exact set. Unknown releases
  // are handled only by an adapter's explicit compatibility probe.
  '0.1.2-alpha.1',
  '0.1.2-alpha.2',
  '0.1.2-alpha.3',
  '0.1.2-alpha.4',
  '0.1.2-alpha.5',
  // Upstream alpha snapshots. Each Session wire change is isolated behind
  // its own exact version adapter.
  '0.1.3-alpha.1',
  '0.1.3-alpha.2',
  // 0.1.5-alpha.1 introduces the strict Session wire v3 contract. alpha.2
  // and rc.1/rc.2 retain that wire while adding durable deliverable/catalog
  // events, so they still get distinct exact identities below.
  '0.1.5-alpha.1',
  '0.1.5-alpha.2',
  '0.1.5-rc.1',
  '0.1.5-rc.2',
  // 0.1.6-alpha.1 retains the audited Session v3 wire and adds only
  // additive projection/optional API surfaces; it remains exact-only.
  '0.1.6-alpha.1',
  // 0.1.6-alpha.2 keeps Session v3 but replaces the control queue snapshot
  // with the durable Inbox projection; it has its own exact adapter.
  '0.1.6-alpha.2',
] as const

export const SUPPORTED_DSH_RANGE =
  '0.0.1-rc.1/.2/.5; 0.1.0-rc.2/.3/.6/.7/.8; 0.1.1-rc.1/.2; 0.1.2-rc.1; 0.1.2-alpha.1-.5; 0.1.3-alpha.1/.2; 0.1.5-alpha.1/.2/rc.1/.2; 0.1.6-alpha.1/.2' as const

export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh' as const

/** Latest published package used by the extension's installer. */
export const LATEST_PUBLISHED_DSH_VERSION = '0.1.5-rc.2' as const

/** Keep the installer default aligned with the latest package in the exact supported set. */
export const LATEST_SUPPORTED_DSH_VERSION = LATEST_PUBLISHED_DSH_VERSION

/**
 * Newest adapter whose wire contract is safe to reuse for an unverified
 * runtime. This is intentionally separate from the newest exact source
 * snapshot: alpha13/alpha132 use Session v2 fields and alpha151/alpha152/rc151/rc152/
 * alpha161 use Session v3 fields that cannot be inferred from session/list alone.
 */
export const LATEST_COMPATIBILITY_FALLBACK_DSH_VERSION = '0.1.2-alpha.5' as const

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
  /** Whether this adapter is eligible for unknown-runtime probing and factory fallback. */
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
