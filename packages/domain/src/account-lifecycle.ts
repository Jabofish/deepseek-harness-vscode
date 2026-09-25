/** Safe account lifecycle projections. No credential or authorization material belongs here. */
export const ACCOUNT_SIGN_IN_PHASES = [
  'initializing',
  'waiting-browser',
  'exchanging',
  'committing',
  'succeeded',
  'cancelled',
  'expired',
  'failed',
] as const

export type AccountSignInPhase = (typeof ACCOUNT_SIGN_IN_PHASES)[number]
export type AccountSignInErrorCode = 'network' | 'protocol' | 'expired' | 'storage'

export interface AccountSignInAttempt {
  readonly id: string
  readonly phase: AccountSignInPhase
  readonly expiresAt?: number
  readonly errorCode?: AccountSignInErrorCode
}

/** The DSH stored-grant presence bit is not a server validation claim. */
export interface AccountLifecycleSnapshot {
  readonly status: 'signed-out' | 'credential-stored'
  readonly attempt: AccountSignInAttempt | null
}

/** Host-derived request metadata accepted by DSH RC2 account operations. */
export interface AccountClientMetadata {
  readonly version: string
  readonly locale: string
  /** Seconds east of UTC. */
  readonly timezoneOffsetSeconds: number
}

/**
 * Internal Host-only effect emitted by the pinned adapter. `url` can contain
 * PKCE and authorization query parameters and must never enter a Webview DTO,
 * log, persisted state, or ordinary account snapshot.
 */
export interface AccountAuthorizationLaunch {
  readonly attemptId: string
  readonly url: string
}

export interface AccountLifecycleRepository {
  getState(signal?: AbortSignal): Promise<AccountLifecycleSnapshot>
  startSignIn(
    client: AccountClientMetadata,
    callbackOrigin: string,
    loginSource: 'web' | 'desktop',
    signal?: AbortSignal,
  ): Promise<AccountLifecycleSnapshot>
  cancelSignIn(attemptId: string, signal?: AbortSignal): Promise<AccountLifecycleSnapshot>
  hasRunningAccountTasks(signal?: AbortSignal): Promise<boolean>
  signOut(client: AccountClientMetadata, signal?: AbortSignal): Promise<AccountLifecycleSnapshot>
  watch(signal: AbortSignal): AsyncIterable<AccountLifecycleSnapshot>
  watchExpiry(signal: AbortSignal): AsyncIterable<'session-expired'>
  subscribeAuthorizationLaunch(listener: (launch: AccountAuthorizationLaunch) => void): () => void
}

export type SignOutImpact = 'none' | 'running' | 'unknown'
