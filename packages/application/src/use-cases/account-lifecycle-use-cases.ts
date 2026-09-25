import { AppError } from '@dsh-vscode/domain'

import type {
  AccountAuthorizationLaunch,
  AccountBalanceQuery,
  AccountBonusBatch,
  AccountClientMetadata,
  AccountLifecycleRepository,
  AccountLifecycleSnapshot,
  AccountPage,
  AccountProfileQuery,
  SignOutImpact,
} from '@dsh-vscode/domain'

const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const ACCOUNT_ID = /^[\s\S]{0,256}$/u
const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/** Application boundary for the exact RC2 account lifecycle; no upstream DTO escapes. */
export class AccountLifecycleUseCases {
  public constructor(private readonly repository: AccountLifecycleRepository) {}

  public getState(signal?: AbortSignal): Promise<AccountLifecycleSnapshot> {
    return this.repository.getState(signal)
  }

  public startSignIn(
    client: AccountClientMetadata,
    callbackOrigin: string,
    loginSource: 'web' | 'desktop',
    signal?: AbortSignal,
  ): Promise<AccountLifecycleSnapshot> {
    validateClient(client)
    return this.repository.startSignIn(client, normalizeCallbackOrigin(callbackOrigin), loginSource, signal)
  }

  public cancelSignIn(attemptId: string, signal?: AbortSignal): Promise<AccountLifecycleSnapshot> {
    if (!ATTEMPT_ID.test(attemptId)) throw invalidAccountInput('attempt id')
    return this.repository.cancelSignIn(attemptId, signal)
  }

  public hasRunningAccountTasks(signal?: AbortSignal): Promise<boolean> {
    return this.repository.hasRunningAccountTasks(signal)
  }

  public async getSignOutImpact(signal?: AbortSignal): Promise<SignOutImpact> {
    try {
      return (await this.repository.hasRunningAccountTasks(signal)) ? 'running' : 'none'
    } catch (error) {
      if (signal?.aborted === true) throw error
      return 'unknown'
    }
  }

  public signOut(client: AccountClientMetadata, signal?: AbortSignal): Promise<AccountLifecycleSnapshot> {
    validateClient(client)
    return this.repository.signOut(client, signal)
  }

  public watch(signal: AbortSignal): AsyncIterable<AccountLifecycleSnapshot> {
    return this.repository.watch(signal)
  }

  public watchExpiry(signal: AbortSignal): AsyncIterable<'session-expired'> {
    return this.repository.watchExpiry(signal)
  }

  public subscribeAuthorizationLaunch(listener: (launch: AccountAuthorizationLaunch) => void): () => void {
    return this.repository.subscribeAuthorizationLaunch(listener)
  }

  /** Read DSH's display-safe profile outcome; Platform failures stay independent of wallet reads. */
  public readProfile(
    client: AccountClientMetadata,
    signal?: AbortSignal,
  ): Promise<AccountProfileQuery | null> {
    validateClient(client)
    return this.repository.getProfile(client, signal)
  }

  /** Read the normal and bonus wallet outcomes from the exact RC2 Remote. */
  public readBalance(
    client: AccountClientMetadata,
    signal?: AbortSignal,
  ): Promise<AccountBalanceQuery | null> {
    validateClient(client)
    return this.repository.getBalance(client, signal)
  }

  /** Read server-authored bonus notices for the active account. */
  public readUnnotifiedBonuses(
    client: AccountClientMetadata,
    signal?: AbortSignal,
  ): Promise<AccountBonusBatch | null> {
    validateClient(client)
    return this.repository.getUnnotifiedBonuses(client, signal)
  }

  public ackBonusNotified(
    accountId: string,
    orderId: string,
    client: AccountClientMetadata,
    signal?: AbortSignal,
  ): Promise<boolean> {
    validateClient(client)
    if (!ACCOUNT_ID.test(accountId) || !ORDER_ID.test(orderId))
      throw invalidAccountInput('bonus acknowledgement')
    return this.repository.ackBonusNotified(accountId, orderId, client, signal)
  }

  /** Resolve a user-facing Platform page using only the pinned account/getState Remote. */
  public getAccountPageUrl(page: AccountPage, signal?: AbortSignal): Promise<string> {
    if (page !== 'usage' && page !== 'top-up') throw invalidAccountInput('account page')
    return this.repository.getAccountPageUrl(page, signal)
  }
}

export function normalizeCallbackOrigin(value: string): string {
  const match = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})$/iu.exec(value)
  if (match === null) throw invalidAccountInput('callback origin')
  const host = match[1]?.toLowerCase()
  const port = Number(match[2])
  if ((host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') || port < 1 || port > 65_535)
    throw invalidAccountInput('callback origin')
  return `http://${host}:${port}`
}

function validateClient(client: AccountClientMetadata): void {
  if (
    client.version.trim() === '' ||
    client.version.length > 64 ||
    client.locale.trim() === '' ||
    client.locale.length > 64 ||
    !Number.isSafeInteger(client.timezoneOffsetSeconds) ||
    Math.abs(client.timezoneOffsetSeconds) > 86_400
  )
    throw invalidAccountInput('client metadata')
}

function invalidAccountInput(field: string): AppError {
  return new AppError({
    code: 'INVALID_CONFIGURATION',
    message: `The account ${field} is invalid.`,
    retryable: false,
  })
}
