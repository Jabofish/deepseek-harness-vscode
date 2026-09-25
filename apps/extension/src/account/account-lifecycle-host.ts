import { AppError } from '@dsh-vscode/domain'

import type {
  AccountLifecycleSnapshot,
  AccountBonusBatch,
  AccountPage,
  AccountProfileDetailsSnapshot,
  AccountBonusNoticeDisplay,
  AccountBalanceQuery,
  AccountProfileQuery,
  AccountClientMetadata,
  BackendEndpoint,
  SignOutImpact,
} from '@dsh-vscode/domain'
import type { AccountLifecycleUseCases } from '@dsh-vscode/application'

const MAX_PENDING_AUTHORIZATIONS = 8
const AUTHORIZATION_LIFETIME_MS = 10 * 60 * 1000
const MAX_PENDING_BONUS_ACKNOWLEDGEMENTS = 128

export interface AccountLifecycleHostDependencies {
  readonly useCases: AccountLifecycleUseCases
  readonly endpoint: () => BackendEndpoint | undefined
  readonly client: () => AccountClientMetadata
  readonly openExternal: (url: string) => Promise<boolean>
  readonly initializeDefaultModel?: (signal: AbortSignal) => Promise<void>
  readonly reportDiagnostic?: () => void
  readonly publishSnapshot: (snapshot: AccountLifecycleSnapshot) => void
  readonly publishSessionExpired: () => void
  readonly reportError: (code: 'state-stream-failed' | 'expiry-stream-failed' | 'browser-open-failed') => void
  readonly confirmSignOut: (impact: SignOutImpact) => Promise<boolean>
  readonly now?: () => number
}

/** Extension Host owner of account subscriptions, browser launch effects and sign-out confirmation. */
export class AccountLifecycleHost {
  private readonly lifetime = new AbortController()
  private readonly now: () => number
  private readonly pendingAuthorization = new Map<string, { url: string; expiresAt: number }>()
  private readonly launchableAttempts = new Map<string, number>()
  private readonly launchedAttempts = new Set<string>()
  private readonly initializedDefaultModelAttempts = new Set<string>()
  private readonly bonusAccountByOrderId = new Map<string, string>()
  private readonly acknowledgingBonusKeys = new Set<string>()
  private bonusAccountScopeId: string | undefined
  private unsubscribeAuthorization: (() => void) | undefined
  private previousSnapshot: AccountLifecycleSnapshot | undefined
  private stateTask: Promise<void> | undefined
  private expiryTask: Promise<void> | undefined
  private activeSignInCalls = 0
  private detailsGeneration = 0
  /** Monotonic scope marker; only the Host retains the corresponding account id. */
  private accountScopeRevision = 0
  private started = false
  private disposed = false

  public constructor(private readonly dependencies: AccountLifecycleHostDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  /** Start one state subscription and one non-replaying expiry subscription for this backend lifetime. */
  public start(): void {
    if (this.disposed)
      throw new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'The DSH connection is closed.',
        retryable: false,
      })
    if (this.started) return
    this.started = true
    this.unsubscribeAuthorization = this.dependencies.useCases.subscribeAuthorizationLaunch((launch) => {
      this.receiveAuthorization(launch.attemptId, launch.url)
    })
    this.stateTask = this.consumeState(this.lifetime.signal)
    this.expiryTask = this.consumeExpiry(this.lifetime.signal)
  }

  public getState(signal?: AbortSignal): Promise<AccountLifecycleSnapshot> {
    this.assertActive()
    return this.dependencies.useCases.getState(this.operationSignal(signal))
  }

  public async startSignIn(signal?: AbortSignal): Promise<AccountLifecycleSnapshot> {
    this.assertActive()
    this.activeSignInCalls += 1
    try {
      const endpoint = this.dependencies.endpoint()
      if (endpoint === undefined) throw invalidEndpoint()
      const callbackOrigin = callbackOriginForDsh(endpoint)
      const snapshot = await this.dependencies.useCases.startSignIn(
        this.dependencies.client(),
        callbackOrigin,
        'desktop',
        this.operationSignal(signal),
      )
      this.observeSnapshot(snapshot)
      if (isSuccessfulStoredAccount(snapshot)) this.initializeDefaultModel(snapshot.attempt.id)
      const attempt = snapshot.attempt
      if (attempt !== null && (attempt.phase === 'initializing' || attempt.phase === 'waiting-browser')) {
        this.launchableAttempts.set(attempt.id, this.now() + AUTHORIZATION_LIFETIME_MS)
        this.pruneAuthorizationState()
        const pending = this.pendingAuthorization.get(attempt.id)
        if (pending !== undefined) {
          this.pendingAuthorization.delete(attempt.id)
          this.launchAuthorization(attempt.id, pending.url)
        }
      }
      return snapshot
    } finally {
      this.activeSignInCalls -= 1
      if (this.activeSignInCalls === 0) this.pendingAuthorization.clear()
    }
  }

  public cancelSignIn(attemptId: string, signal?: AbortSignal): Promise<AccountLifecycleSnapshot> {
    this.assertActive()
    return this.dependencies.useCases.cancelSignIn(attemptId, this.operationSignal(signal))
  }

  public async getSignOutImpact(signal?: AbortSignal): Promise<SignOutImpact> {
    this.assertActive()
    return this.dependencies.useCases.getSignOutImpact(this.operationSignal(signal))
  }

  /** Re-check impact and require a VS Code Host confirmation before deleting the local grant. */
  public async signOut(signal?: AbortSignal): Promise<AccountLifecycleSnapshot | undefined> {
    this.assertActive()
    const operationSignal = this.operationSignal(signal)
    const impact = await this.dependencies.useCases.getSignOutImpact(operationSignal)
    operationSignal.throwIfAborted()
    if (!(await this.dependencies.confirmSignOut(impact))) return undefined
    operationSignal.throwIfAborted()
    const snapshot = await this.dependencies.useCases.signOut(this.dependencies.client(), operationSignal)
    this.observeSnapshot(snapshot)
    return snapshot
  }

  /** Read profile, wallet, and unnotified-bonus data independently through the local DSH controller. */
  public async readDetails(signal?: AbortSignal): Promise<AccountProfileDetailsSnapshot> {
    this.assertActive()
    const operationSignal = this.operationSignal(signal)
    const generation = ++this.detailsGeneration
    const state = await this.dependencies.useCases.getState(operationSignal)
    operationSignal.throwIfAborted()
    if (generation !== this.detailsGeneration) return unavailableAccountDetails(this.accountScopeRevision)
    if (state.status !== 'credential-stored') {
      this.clearBonusScope()
      return unavailableAccountDetails(this.accountScopeRevision)
    }

    const client = this.dependencies.client()
    const [profileResult, balanceResult, bonusResult] = await Promise.allSettled([
      this.dependencies.useCases.readProfile(client, operationSignal),
      this.dependencies.useCases.readBalance(client, operationSignal),
      this.dependencies.useCases.readUnnotifiedBonuses(client, operationSignal),
    ])
    operationSignal.throwIfAborted()
    // A sign-out/expiry or a newer read can supersede these responses while they are in flight.
    if (generation !== this.detailsGeneration) return unavailableAccountDetails(this.accountScopeRevision)

    const profile = profileView(profileResult)
    const balance = balanceView(balanceResult)
    const profileId =
      fulfilled(profileResult) && profileResult.value?.status === 'ready'
        ? profileResult.value.value.id
        : undefined
    let bonus: AccountProfileDetailsSnapshot['bonus']
    if (!fulfilled(bonusResult)) {
      // A successful profile can still prove that this is a different account while
      // the independent bonus request is failing; do not retain that account's card.
      if (profileId !== undefined && profileId !== null) this.useBonusAccountScope(profileId)
      // When identity is the same or unknown, keep prior order mappings so a displayed
      // notice can retry its acknowledgement after a transient read failure.
      bonus = { status: 'failed' }
    } else if (bonusResult.value === null) {
      this.clearBonusScope()
      bonus = { status: 'unavailable' }
    } else {
      const batch = bonusResult.value
      // Separate Remote reads may straddle a grant replacement. Never show a notice for a different identity.
      if (profileId !== undefined && profileId !== null && profileId !== batch.accountId) {
        this.clearBonusScope()
        bonus = { status: 'unavailable' }
      } else {
        this.useBonusAccountScope(batch.accountId)
        const notice = firstVisibleBonus(batch, this.now())
        bonus = { status: 'ready', value: notice }
        if (notice !== null) {
          this.bonusAccountByOrderId.set(notice.orderId, batch.accountId)
          while (this.bonusAccountByOrderId.size > MAX_PENDING_BONUS_ACKNOWLEDGEMENTS) {
            const oldest = this.bonusAccountByOrderId.keys().next().value
            if (oldest === undefined) break
            this.bonusAccountByOrderId.delete(oldest)
          }
        }
      }
    }

    return { profile, balance, bonus, accountScopeRevision: this.accountScopeRevision }
  }

  /** Acknowledge only a bonus notice returned by this Host's latest account read. */
  public async acknowledgeBonus(orderId: string, signal?: AbortSignal): Promise<boolean> {
    this.assertActive()
    const accountId = this.bonusAccountByOrderId.get(orderId)
    if (accountId === undefined) return false
    const acknowledgementKey = JSON.stringify([accountId, orderId])
    if (this.acknowledgingBonusKeys.has(acknowledgementKey)) return false
    const scopeGeneration = this.accountScopeRevision
    const operationSignal = this.operationSignal(signal)
    this.acknowledgingBonusKeys.add(acknowledgementKey)
    try {
      const accepted = await this.dependencies.useCases.ackBonusNotified(
        accountId,
        orderId,
        this.dependencies.client(),
        operationSignal,
      )
      operationSignal.throwIfAborted()
      if (scopeGeneration !== this.accountScopeRevision || this.bonusAccountScopeId !== accountId)
        return false
      this.bonusAccountByOrderId.delete(orderId)
      return accepted
    } catch (error) {
      operationSignal.throwIfAborted()
      if (scopeGeneration !== this.accountScopeRevision || this.bonusAccountScopeId !== accountId)
        return false
      throw error
    } finally {
      this.acknowledgingBonusKeys.delete(acknowledgementKey)
    }
  }

  /** Open only DSH's validated official Usage or Top Up page after a user action. */
  public async openAccountPage(page: AccountPage, signal?: AbortSignal): Promise<void> {
    this.assertActive()
    const operationSignal = this.operationSignal(signal)
    const url = await this.dependencies.useCases.getAccountPageUrl(page, operationSignal)
    operationSignal.throwIfAborted()
    assertOfficialAccountPageUrl(url, page)
    if (!(await this.dependencies.openExternal(url)))
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'The account page could not be opened.',
        retryable: true,
      })
  }

  /** Abort streams and release every listener/effect before the backend transport is closed. */
  public async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeAuthorization?.()
    this.unsubscribeAuthorization = undefined
    this.lifetime.abort()
    this.pendingAuthorization.clear()
    this.launchableAttempts.clear()
    this.launchedAttempts.clear()
    this.initializedDefaultModelAttempts.clear()
    this.bonusAccountByOrderId.clear()
    this.acknowledgingBonusKeys.clear()
    if (this.bonusAccountScopeId !== undefined) this.accountScopeRevision += 1
    this.bonusAccountScopeId = undefined
    this.detailsGeneration += 1
    this.previousSnapshot = undefined
    await Promise.allSettled([this.stateTask, this.expiryTask].filter(isPromise))
  }

  private async consumeState(signal: AbortSignal): Promise<void> {
    try {
      for await (const snapshot of this.dependencies.useCases.watch(signal)) {
        if (signal.aborted) return
        this.observeSnapshot(snapshot)
        this.pruneAuthorizationState()
        if (snapshot.attempt === null || isTerminal(snapshot.attempt.phase)) {
          if (snapshot.attempt !== null) this.clearAuthorization(snapshot.attempt.id)
        }
        this.dependencies.publishSnapshot(snapshot)
      }
    } catch {
      if (!signal.aborted) this.report('state-stream-failed')
    }
  }

  private async consumeExpiry(signal: AbortSignal): Promise<void> {
    try {
      for await (const event of this.dependencies.useCases.watchExpiry(signal)) {
        if (signal.aborted) return
        if (event === 'session-expired') {
          this.clearBonusScope()
          this.dependencies.publishSessionExpired()
        }
      }
    } catch {
      if (!signal.aborted) this.report('expiry-stream-failed')
    }
  }

  private observeSnapshot(snapshot: AccountLifecycleSnapshot): void {
    if (snapshot.status !== 'credential-stored') this.clearBonusScope()
    const previous = this.previousSnapshot
    if (
      previous !== undefined &&
      previous.attempt?.phase !== 'succeeded' &&
      isSuccessfulStoredAccount(snapshot)
    )
      this.initializeDefaultModel(snapshot.attempt.id)
    this.previousSnapshot = snapshot
  }

  private clearBonusScope(): void {
    this.bonusAccountByOrderId.clear()
    if (this.bonusAccountScopeId !== undefined) this.accountScopeRevision += 1
    this.bonusAccountScopeId = undefined
    this.detailsGeneration += 1
  }

  private useBonusAccountScope(accountId: string): void {
    if (this.bonusAccountScopeId === accountId) return
    this.bonusAccountByOrderId.clear()
    this.bonusAccountScopeId = accountId
    this.accountScopeRevision += 1
  }

  private initializeDefaultModel(attemptId: string): void {
    const initialize = this.dependencies.initializeDefaultModel
    if (initialize === undefined || this.disposed || this.initializedDefaultModelAttempts.has(attemptId))
      return
    this.initializedDefaultModelAttempts.add(attemptId)
    void Promise.resolve()
      .then(() => initialize(this.lifetime.signal))
      .catch(() => {
        if (this.disposed || this.lifetime.signal.aborted) return
        try {
          this.dependencies.reportDiagnostic?.()
        } catch {
          // Diagnostic sinks must not disrupt the account state stream.
        }
      })
  }

  private receiveAuthorization(attemptId: string, url: string): void {
    if (this.disposed || this.lifetime.signal.aborted) return
    this.pruneAuthorizationState()
    const expiresAt = this.launchableAttempts.get(attemptId)
    if (expiresAt !== undefined) {
      if (!this.launchedAttempts.has(attemptId)) this.launchAuthorization(attemptId, url)
      return
    }
    // `startSignIn` emits the initial view before it resolves its Remote call.
    // Keep a short Host-only handoff only while that user action is in flight.
    if (this.activeSignInCalls === 0) return
    this.pendingAuthorization.set(attemptId, { url, expiresAt: this.now() + 5_000 })
    while (this.pendingAuthorization.size > MAX_PENDING_AUTHORIZATIONS) {
      const oldest = this.pendingAuthorization.keys().next().value
      if (oldest === undefined) break
      this.pendingAuthorization.delete(oldest)
    }
  }

  private launchAuthorization(attemptId: string, url: string): void {
    if (this.disposed || this.launchedAttempts.has(attemptId)) return
    this.pruneAuthorizationState()
    if (!this.launchableAttempts.has(attemptId)) return
    this.launchedAttempts.add(attemptId)
    void this.openAuthorization(attemptId, url)
  }

  private async openAuthorization(attemptId: string, url: string): Promise<void> {
    try {
      if (!(await this.dependencies.openExternal(url))) throw new Error('external browser did not open')
    } catch {
      if (!this.disposed && !this.lifetime.signal.aborted) {
        try {
          await this.dependencies.useCases.cancelSignIn(attemptId, this.lifetime.signal)
        } catch {
          // Local browser launch failure stays a Host error; DSH remains authoritative.
        }
        this.report('browser-open-failed')
      }
    }
  }

  private clearAuthorization(attemptId: string): void {
    this.pendingAuthorization.delete(attemptId)
    this.launchableAttempts.delete(attemptId)
    this.launchedAttempts.delete(attemptId)
  }

  private pruneAuthorizationState(): void {
    const now = this.now()
    for (const [id, entry] of this.pendingAuthorization)
      if (entry.expiresAt <= now) this.pendingAuthorization.delete(id)
    for (const [id, expiresAt] of this.launchableAttempts) if (expiresAt <= now) this.clearAuthorization(id)
  }

  private operationSignal(signal?: AbortSignal): AbortSignal {
    return signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
  }

  private assertActive(): void {
    if (!this.started || this.disposed || this.lifetime.signal.aborted)
      throw new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'The DSH connection is not available.',
        retryable: false,
      })
  }

  private report(code: 'state-stream-failed' | 'expiry-stream-failed' | 'browser-open-failed'): void {
    try {
      this.dependencies.reportError(code)
    } catch {
      // Diagnostics consumers must not disrupt account lifecycle cleanup.
    }
  }
}

export function callbackOriginForDsh(endpoint: BackendEndpoint): string {
  const host = endpoint.host
  if (
    (host !== '127.0.0.1' && host !== 'localhost') ||
    !Number.isSafeInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65_535
  )
    throw invalidEndpoint()
  const origin = `http://${host}:${endpoint.port}`
  if (endpoint.baseUrl !== origin) throw invalidEndpoint()
  return origin
}

function isTerminal(phase: string): boolean {
  return phase === 'succeeded' || phase === 'cancelled' || phase === 'expired' || phase === 'failed'
}

function profileView(
  result: PromiseSettledResult<AccountProfileQuery | null>,
): AccountProfileDetailsSnapshot['profile'] {
  if (!fulfilled(result)) return { status: 'failed' }
  if (result.value === null) return { status: 'unavailable' }
  if (result.value.status === 'failed') return { status: 'failed' }
  return {
    status: 'ready',
    value: {
      name: displayText(result.value.value.name),
      contact: displayText(result.value.value.contact),
    },
  }
}

function balanceView(
  result: PromiseSettledResult<AccountBalanceQuery | null>,
): AccountProfileDetailsSnapshot['balance'] {
  if (!fulfilled(result)) return { status: 'failed' }
  if (result.value === null) return { status: 'unavailable' }
  if (result.value.status === 'failed') return { status: 'failed' }
  return {
    status: 'ready',
    value: { wallets: result.value.value, bonusWallets: result.value.bonusWallets },
  }
}

function firstVisibleBonus(batch: AccountBonusBatch, now: number): AccountBonusNoticeDisplay | null {
  const candidate = batch.bonuses[0]
  if (candidate === undefined) return null
  const expiresAt = Date.parse(candidate.expiresAt)
  if (!Number.isNaN(expiresAt) && expiresAt <= now) return null
  return {
    orderId: candidate.orderId,
    message: displayText(candidate.message) ?? '',
    amount: candidate.amount,
    currency: candidate.currency,
    expiresAt: candidate.expiresAt,
  }
}

function unavailableAccountDetails(accountScopeRevision: number): AccountProfileDetailsSnapshot {
  return {
    profile: { status: 'unavailable' },
    balance: { status: 'unavailable' },
    bonus: { status: 'unavailable' },
    accountScopeRevision,
  }
}

function displayText(value: string | null): string | null {
  if (value === null) return null
  return value.replace(/\p{Cc}/gu, ' ').slice(0, 4_096)
}

function fulfilled<T>(result: PromiseSettledResult<T>): result is PromiseFulfilledResult<T> {
  return result.status === 'fulfilled'
}

function assertOfficialAccountPageUrl(value: string, page: AccountPage): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalidAccountPage()
  }
  const expectedPath = page === 'usage' ? '/usage' : '/top_up'
  if (
    url.origin !== 'https://platform.deepseek.com' ||
    url.pathname !== expectedPath ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw invalidAccountPage()
}

function isSuccessfulStoredAccount(
  snapshot: AccountLifecycleSnapshot,
): snapshot is AccountLifecycleSnapshot & {
  readonly status: 'credential-stored'
  readonly attempt: NonNullable<AccountLifecycleSnapshot['attempt']> & { readonly phase: 'succeeded' }
} {
  return snapshot.status === 'credential-stored' && snapshot.attempt?.phase === 'succeeded'
}

function isPromise(value: Promise<void> | undefined): value is Promise<void> {
  return value !== undefined
}

function invalidEndpoint(): AppError {
  return new AppError({
    code: 'INVALID_ENDPOINT',
    message: 'The connected DSH callback origin is invalid.',
    retryable: false,
  })
}

function invalidAccountPage(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned an unsupported account page destination.',
    retryable: false,
  })
}
