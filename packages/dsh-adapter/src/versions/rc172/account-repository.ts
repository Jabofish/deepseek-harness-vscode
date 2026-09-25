import { AppError } from '@dsh-vscode/domain'

import type {
  AccountBalanceQuery,
  AccountBonusBatch,
  AccountBonusNotification,
  AccountAuthorizationLaunch,
  AccountClientMetadata,
  AccountLifecycleRepository,
  AccountLifecycleSnapshot,
  AccountPage,
  AccountPlatformProfile,
  AccountProfileQuery,
  AccountSignInAttempt,
  AccountSignInErrorCode,
  AccountSignInPhase,
  AccountWallet,
} from '@dsh-vscode/domain'
import { unwrapRpcResultValue } from '../rc6/rpc.js'

/** The alpha Gateway transport's pinned Typert Remote carrier, including streams. */
export interface AccountRemoteTransport {
  remoteRequest(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown>
  openRemoteStream(
    endpoint: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncIterable<unknown>
}

const ERROR_CODES = new Set<AccountSignInErrorCode>(['network', 'protocol', 'expired', 'storage'])
const PHASES = new Set<AccountSignInPhase>([
  'initializing',
  'waiting-browser',
  'exchanging',
  'committing',
  'succeeded',
  'cancelled',
  'expired',
  'failed',
])
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu
const OFFICIAL_PLATFORM_ORIGIN = 'https://platform.deepseek.com'

/** Exact account-controller Remote adapter for DSH 0.1.7-rc.2. */
export class Rc172AccountLifecycleRepository implements AccountLifecycleRepository {
  private readonly authorizationListeners = new Set<(launch: AccountAuthorizationLaunch) => void>()

  public constructor(private readonly transport: AccountRemoteTransport) {}

  public async getState(signal?: AbortSignal): Promise<AccountLifecycleSnapshot> {
    return this.readState(await this.call('account/getState', {}, signal), 'account/getState')
  }

  public async startSignIn(
    client: AccountClientMetadata,
    callbackOrigin: string,
    loginSource: 'web' | 'desktop',
    signal?: AbortSignal,
  ): Promise<AccountLifecycleSnapshot> {
    const raw = await this.call('account/startSignIn', { client, callbackOrigin, loginSource }, signal)
    return this.readState(raw, 'account/startSignIn')
  }

  public async cancelSignIn(attemptId: string, signal?: AbortSignal): Promise<AccountLifecycleSnapshot> {
    const raw = await this.call('account/cancelSignIn', { attemptId }, signal)
    return this.readState(raw, 'account/cancelSignIn')
  }

  public async hasRunningAccountTasks(signal?: AbortSignal): Promise<boolean> {
    const result = await this.call('account/hasRunningAccountTasks', {}, signal)
    if (typeof result !== 'boolean') throw malformed('account/hasRunningAccountTasks')
    return result
  }

  public async signOut(
    client: AccountClientMetadata,
    signal?: AbortSignal,
  ): Promise<AccountLifecycleSnapshot> {
    const raw = await this.call('account/signOut', { client }, signal)
    return this.readState(raw, 'account/signOut')
  }

  public async *watch(signal: AbortSignal): AsyncIterable<AccountLifecycleSnapshot> {
    for await (const raw of this.transport.openRemoteStream('account/watch', {}, signal)) {
      if (signal.aborted) return
      yield this.readState(raw, 'account/watch')
    }
  }

  public async *watchExpiry(signal: AbortSignal): AsyncIterable<'session-expired'> {
    for await (const raw of this.transport.openRemoteStream('account/watchExpiry', {}, signal)) {
      if (signal.aborted) return
      if (raw !== 'session-expired') throw malformed('account/watchExpiry')
      yield raw
    }
  }

  public subscribeAuthorizationLaunch(listener: (launch: AccountAuthorizationLaunch) => void): () => void {
    this.authorizationListeners.add(listener)
    return () => this.authorizationListeners.delete(listener)
  }

  public async getProfile(
    client: AccountClientMetadata,
    signal?: AbortSignal,
  ): Promise<AccountProfileQuery | null> {
    return readProfile(await this.call('account/getProfile', { client }, signal), 'account/getProfile')
  }

  public async getBalance(
    client: AccountClientMetadata,
    signal?: AbortSignal,
  ): Promise<AccountBalanceQuery | null> {
    return readBalance(await this.call('account/getBalance', { client }, signal), 'account/getBalance')
  }

  public async getUnnotifiedBonuses(
    client: AccountClientMetadata,
    signal?: AbortSignal,
  ): Promise<AccountBonusBatch | null> {
    return readBonusBatch(
      await this.call('account/getUnnotifiedBonuses', { client }, signal),
      'account/getUnnotifiedBonuses',
    )
  }

  public async ackBonusNotified(
    accountId: string,
    orderId: string,
    client: AccountClientMetadata,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const value = await this.call('account/ackBonusNotified', { accountId, orderId, client }, signal)
    if (typeof value !== 'boolean') throw malformed('account/ackBonusNotified')
    return value
  }

  /** Return only the fixed official Platform destinations; callers open them through the Host. */
  public async getAccountPageUrl(page: AccountPage, signal?: AbortSignal): Promise<string> {
    if (page !== 'usage' && page !== 'top-up') throw malformed('account/getState')
    const raw = await this.call('account/getState', {}, signal)
    const record = asRecord(raw)
    if (record === undefined) throw malformed('account/getState')
    if (record.status !== 'credential-stored')
      throw new AppError({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'Sign in to your DSH account before opening this account page.',
        retryable: false,
      })
    const links = asRecord(record.links)
    if (links === undefined || typeof links.usageUrl !== 'string' || typeof links.topUpUrl !== 'string')
      throw malformed('account/getState')
    const usage = safeAccountLink(links.usageUrl, '/usage', 'account/getState')
    const topUp = safeAccountLink(links.topUpUrl, '/top_up', 'account/getState')
    if (
      usage.origin !== OFFICIAL_PLATFORM_ORIGIN ||
      topUp.origin !== OFFICIAL_PLATFORM_ORIGIN ||
      usage.origin !== topUp.origin
    )
      throw malformed('account/getState')
    return page === 'usage' ? usage.href : topUp.href
  }

  private async call(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const result = await this.transport.remoteRequest(endpoint, args, signal)
    return unwrapRpcResultValue<unknown>(result, endpoint)
  }

  private readState(raw: unknown, method: string): AccountLifecycleSnapshot {
    const record = asRecord(raw)
    if (record === undefined || (record.status !== 'signed-out' && record.status !== 'credential-stored'))
      throw malformed(method)
    const origin = accountOrigin(record.links, method)
    if (!Object.hasOwn(record, 'attempt')) throw malformed(method)
    const rawAttempt = record.attempt
    if (rawAttempt === null) return { status: record.status, attempt: null }
    const attempt = asRecord(rawAttempt)
    if (
      attempt === undefined ||
      typeof attempt.id !== 'string' ||
      !ATTEMPT_ID.test(attempt.id) ||
      typeof attempt.phase !== 'string' ||
      !PHASES.has(attempt.phase as AccountSignInPhase)
    )
      throw malformed(method)

    if (attempt.expiresAt !== undefined && !isTimestamp(attempt.expiresAt)) throw malformed(method)
    if (
      attempt.errorCode !== undefined &&
      (typeof attempt.errorCode !== 'string' || !ERROR_CODES.has(attempt.errorCode as AccountSignInErrorCode))
    )
      throw malformed(method)

    if (attempt.authorizeUrl !== undefined) {
      if (typeof attempt.authorizeUrl !== 'string') throw malformed(method)
      const url = authorizationUrl(attempt.authorizeUrl, origin, method)
      const launch: AccountAuthorizationLaunch = { attemptId: attempt.id, url }
      for (const listener of this.authorizationListeners) {
        try {
          listener(launch)
        } catch {
          // A Host listener failure must not change the DSH-owned account state.
        }
      }
    }

    const safeAttempt: AccountSignInAttempt = {
      id: attempt.id,
      phase: attempt.phase as AccountSignInPhase,
      ...(attempt.expiresAt === undefined ? {} : { expiresAt: attempt.expiresAt }),
      ...(attempt.errorCode === undefined ? {} : { errorCode: attempt.errorCode as AccountSignInErrorCode }),
    }
    return { status: record.status, attempt: safeAttempt }
  }
}

function readProfile(value: unknown, method: string): AccountProfileQuery | null {
  if (value === null) return null
  const result = asRecord(value)
  if (result === undefined || (result.status !== 'ready' && result.status !== 'failed'))
    throw malformed(method)
  if (result.status === 'failed') return { status: 'failed' }
  const profile = asRecord(result.value)
  if (
    profile === undefined ||
    !nullableText(profile.id, 256) ||
    !nullableText(profile.name, 512) ||
    !nullableText(profile.contact, 512) ||
    (profile.avatarUrl !== undefined && !nullableText(profile.avatarUrl, 4_096))
  )
    throw malformed(method)
  const profileValue: AccountPlatformProfile = {
    id: profile.id,
    name: profile.name,
    contact: profile.contact,
    ...(profile.avatarUrl === undefined ? {} : { avatarUrl: profile.avatarUrl }),
  }
  return { status: 'ready', value: profileValue }
}

function readBalance(value: unknown, method: string): AccountBalanceQuery | null {
  if (value === null) return null
  const result = asRecord(value)
  if (result === undefined || (result.status !== 'ready' && result.status !== 'failed'))
    throw malformed(method)
  if (result.status === 'failed') return { status: 'failed' }
  const wallets = readWallets(result.value, method)
  const bonusWallets = readWallets(result.bonusWallets, method)
  return { status: 'ready', value: wallets, bonusWallets }
}

function readWallets(value: unknown, method: string): readonly AccountWallet[] {
  if (!Array.isArray(value) || value.length > 32) throw malformed(method)
  return value.map((item) => {
    const wallet = asRecord(item)
    if (
      wallet === undefined ||
      (wallet.currency !== 'CNY' && wallet.currency !== 'USD') ||
      typeof wallet.balance !== 'string' ||
      wallet.balance.length > 128 ||
      !DECIMAL.test(wallet.balance) ||
      !isBoundedExponent(wallet.balance)
    )
      throw malformed(method)
    return { currency: wallet.currency, balance: wallet.balance }
  })
}

function readBonusBatch(value: unknown, method: string): AccountBonusBatch | null {
  if (value === null) return null
  const batch = asRecord(value)
  if (
    batch === undefined ||
    !boundedAccountId(batch.accountId) ||
    !Array.isArray(batch.bonuses) ||
    batch.bonuses.length > 128
  )
    throw malformed(method)
  const bonuses: AccountBonusNotification[] = batch.bonuses.map((item) => {
    const bonus = asRecord(item)
    if (
      bonus === undefined ||
      typeof bonus.orderId !== 'string' ||
      !UUID.test(bonus.orderId) ||
      !boundedText(bonus.campaign, 512) ||
      typeof bonus.amount !== 'string' ||
      bonus.amount.length > 128 ||
      !DECIMAL.test(bonus.amount) ||
      !isBoundedExponent(bonus.amount) ||
      (bonus.currency !== 'CNY' && bonus.currency !== 'USD') ||
      !boundedText(bonus.grantedAt, 128) ||
      !boundedText(bonus.expiresAt, 128) ||
      !boundedText(bonus.message, 4_096)
    )
      throw malformed(method)
    return {
      orderId: bonus.orderId,
      campaign: bonus.campaign,
      amount: bonus.amount,
      currency: bonus.currency,
      grantedAt: bonus.grantedAt,
      expiresAt: bonus.expiresAt,
      message: bonus.message,
    }
  })
  return { accountId: batch.accountId, bonuses }
}

function nullableText(value: unknown, maximumLength: number): value is string | null {
  return value === null || boundedText(value, maximumLength)
}

function boundedText(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length <= maximumLength
}

function boundedAccountId(value: unknown): value is string {
  return boundedText(value, 256)
}

function isBoundedExponent(value: string): boolean {
  const exponent = /e([+-]?\d+)$/iu.exec(value)?.[1]
  return exponent === undefined || Math.abs(Number(exponent)) <= 1_000_000
}

function accountOrigin(value: unknown, method: string): string {
  const links = asRecord(value)
  if (links === undefined || typeof links.usageUrl !== 'string' || typeof links.topUpUrl !== 'string')
    throw malformed(method)
  const usage = safeAccountLink(links.usageUrl, '/usage', method)
  const topUp = safeAccountLink(links.topUpUrl, '/top_up', method)
  if (usage.origin !== topUp.origin) throw malformed(method)
  return usage.origin
}

function safeAccountLink(value: string, path: string, method: string): URL {
  if (value.length > 4_096) throw malformed(method)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw malformed(method)
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== path ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.protocol === 'http:' && (!isLoopback(url.hostname) || !hasExplicitHttpPort(value)))
  )
    throw malformed(method)
  return url
}

function authorizationUrl(value: string, expectedOrigin: string, method: string): string {
  if (value.length > 8_192) throw malformed(method)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw malformed(method)
  }
  if (
    url.origin !== expectedOrigin ||
    url.pathname !== '/dsh/authorize' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    (url.protocol === 'http:' && (!isLoopback(url.hostname) || !hasExplicitHttpPort(value)))
  )
    throw malformed(method)
  return url.href
}

function hasExplicitHttpPort(value: string): boolean {
  const authority = /^http:\/\/([^/?#]+)/iu.exec(value)?.[1]
  if (authority === undefined || authority.includes('@')) return false
  const port = /:(\d{1,5})$/u.exec(authority)?.[1]
  return port !== undefined && Number(port) >= 1 && Number(port) <= 65_535
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function malformed(method: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed account response for ${method}.`,
    retryable: false,
  })
}
