import { AppError } from '@dsh-vscode/domain'

import type {
  AccountLifecycleSnapshot,
  AccountClientMetadata,
  BackendEndpoint,
  SignOutImpact,
} from '@dsh-vscode/domain'
import type { AccountLifecycleUseCases } from '@dsh-vscode/application'

const MAX_PENDING_AUTHORIZATIONS = 8
const AUTHORIZATION_LIFETIME_MS = 10 * 60 * 1000

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
  private unsubscribeAuthorization: (() => void) | undefined
  private previousSnapshot: AccountLifecycleSnapshot | undefined
  private stateTask: Promise<void> | undefined
  private expiryTask: Promise<void> | undefined
  private activeSignInCalls = 0
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
    return this.dependencies.useCases.signOut(this.dependencies.client(), operationSignal)
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
        if (event === 'session-expired') this.dependencies.publishSessionExpired()
      }
    } catch {
      if (!signal.aborted) this.report('expiry-stream-failed')
    }
  }

  private observeSnapshot(snapshot: AccountLifecycleSnapshot): void {
    const previous = this.previousSnapshot
    if (
      previous !== undefined &&
      previous.attempt?.phase !== 'succeeded' &&
      isSuccessfulStoredAccount(snapshot)
    )
      this.initializeDefaultModel(snapshot.attempt.id)
    this.previousSnapshot = snapshot
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
