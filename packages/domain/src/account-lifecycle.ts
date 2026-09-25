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

export type AccountWalletCurrency = 'CNY' | 'USD'

/** Display identity returned by the authenticated RC2 account controller. */
export interface AccountPlatformProfile {
  /** Host-only identity used to bind bonus acknowledgements to the same account. */
  readonly id: string | null
  readonly name: string | null
  readonly contact: string | null
  /** Never projected into the Webview: it would trigger a remote image request. */
  readonly avatarUrl?: string | null
}

export interface AccountWallet {
  readonly currency: AccountWalletCurrency
  /** Decimal string, preserving DSH's source precision. */
  readonly balance: string
}

export type AccountProfileQuery =
  { readonly status: 'ready'; readonly value: AccountPlatformProfile } | { readonly status: 'failed' }

export type AccountBalanceQuery =
  | {
      readonly status: 'ready'
      readonly value: readonly AccountWallet[]
      readonly bonusWallets: readonly AccountWallet[]
    }
  | { readonly status: 'failed' }

export interface AccountBonusNotification {
  readonly orderId: string
  readonly campaign: string
  readonly amount: string
  readonly currency: AccountWalletCurrency
  readonly grantedAt: string
  readonly expiresAt: string
  /** Localized plain text authored by DSH Platform. */
  readonly message: string
}

/** The account id stays in the Extension Host and is never copied to the Webview. */
export interface AccountBonusBatch {
  readonly accountId: string
  readonly bonuses: readonly AccountBonusNotification[]
}

export type AccountReadView<T> =
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'unavailable' }
  | { readonly status: 'failed' }

export interface AccountProfileDisplay {
  readonly name: string | null
  readonly contact: string | null
}

export interface AccountBonusNoticeDisplay {
  readonly orderId: string
  readonly message: string
  readonly amount: string
  readonly currency: AccountWalletCurrency
  readonly expiresAt: string
}

/** Safe account panel projection; it contains no account ids, avatar URLs, or credentials. */
export interface AccountProfileDetailsSnapshot {
  readonly profile: AccountReadView<AccountProfileDisplay>
  readonly balance: AccountReadView<{
    readonly wallets: readonly AccountWallet[]
    readonly bonusWallets: readonly AccountWallet[]
  }>
  readonly bonus: AccountReadView<AccountBonusNoticeDisplay | null>
}

export type AccountPage = 'usage' | 'top-up'

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
  getProfile(client: AccountClientMetadata, signal?: AbortSignal): Promise<AccountProfileQuery | null>
  getBalance(client: AccountClientMetadata, signal?: AbortSignal): Promise<AccountBalanceQuery | null>
  getUnnotifiedBonuses(client: AccountClientMetadata, signal?: AbortSignal): Promise<AccountBonusBatch | null>
  ackBonusNotified(
    accountId: string,
    orderId: string,
    client: AccountClientMetadata,
    signal?: AbortSignal,
  ): Promise<boolean>
  getAccountPageUrl(page: AccountPage, signal?: AbortSignal): Promise<string>
}

export type SignOutImpact = 'none' | 'running' | 'unknown'
