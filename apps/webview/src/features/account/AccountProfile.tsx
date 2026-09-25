import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import type {
  AccountBonusNoticeDisplay,
  AccountProfileDetailsSnapshot,
  AccountWallet,
  AccountWalletCurrency,
} from '@dsh-vscode/domain'
import './AccountProfile.css'

const DEFAULT_ACK_RETRY_DELAY_MS = 1_000
const DEFAULT_ACK_RETRY_MAX_DELAY_MS = 60_000

interface DismissedBonusNotice {
  readonly orderId: string
  readonly accountScopeRevision: number | undefined
  readonly read: AccountProfileDetailsSnapshot['bonus'] | undefined
}

interface FailedBonusAcknowledgement {
  readonly orderId: string
  readonly accountScopeRevision: number | undefined
}

export interface AccountProfileLabels {
  readonly title: string
  readonly refresh: string
  readonly profile: string
  readonly balance: string
  readonly bonusBalance: string
  readonly bonusNotice: string
  readonly signedOut: string
  readonly unavailable: string
  readonly failed: string
  readonly noBalance: string
  readonly unnamed: string
  readonly dismissBonus: string
  readonly retryBonus: string
  readonly usage: string
  readonly topUp: string
}

export interface AccountProfileProps {
  readonly snapshot: AccountProfileDetailsSnapshot | null
  readonly signedIn: boolean
  readonly busy?: boolean
  readonly requestFailed?: boolean
  readonly labels: AccountProfileLabels
  readonly locale: string
  readonly onRefresh: () => void
  readonly onAcknowledgeBonus: (orderId: string) => Promise<boolean>
  readonly onOpenUsage: () => void
  readonly onOpenTopUp: () => void
  readonly ackRetryDelayMs?: number
  readonly ackRetryMaxDelayMs?: number
}

/** DSH account identity and wallet surface projected through the Extension Host. */
export function AccountProfile({
  snapshot,
  signedIn,
  busy = false,
  requestFailed = false,
  labels,
  locale,
  onRefresh,
  onAcknowledgeBonus,
  onOpenUsage,
  onOpenTopUp,
  ackRetryDelayMs = DEFAULT_ACK_RETRY_DELAY_MS,
  ackRetryMaxDelayMs = DEFAULT_ACK_RETRY_MAX_DELAY_MS,
}: AccountProfileProps): ReactElement {
  const bonusRead = snapshot?.bonus
  const accountScopeRevision = snapshot?.accountScopeRevision
  const accountScopeKey = accountScopeRevision === undefined ? 'unresolved' : String(accountScopeRevision)
  const accountAvailable = signedIn && bonusRead?.status !== 'unavailable'
  const automaticallyPresented = useRef(new Set<string>())
  const inFlightAcknowledgements = useRef(new Set<string>())
  const settledAcknowledgements = useRef(new Set<string>())
  const accountGeneration = useRef(0)
  const previousAccountScopeRevision = useRef(accountScopeRevision)
  const retryDelay = useRef(Math.max(1, ackRetryDelayMs))
  const initialRefreshRequested = useRef(false)
  const wasSignedIn = useRef(signedIn)
  const bonusCard = useRef<HTMLDivElement>(null)
  const retryTimer = useRef<number | undefined>(undefined)
  const [retryDelayMs, setRetryDelayMs] = useState(Math.max(1, ackRetryDelayMs))
  const [presentedNotice, setPresentedNotice] = useState<AccountBonusNoticeDisplay | null>(null)
  const [dismissedNotice, setDismissedNotice] = useState<DismissedBonusNotice>()
  const [failedAcknowledgement, setFailedAcknowledgement] = useState<FailedBonusAcknowledgement>()
  const [stateScopeAvailable, setStateScopeAvailable] = useState(accountAvailable)
  const [accountScopeStateRevision, setAccountScopeStateRevision] = useState(accountScopeRevision)
  const accountScopeIsCurrent = accountScopeStateRevision === accountScopeRevision
  const visiblePresentedNotice = accountScopeIsCurrent ? presentedNotice : null
  const visibleDismissedNotice =
    dismissedNotice?.accountScopeRevision === accountScopeRevision ? dismissedNotice : undefined
  const visibleFailedAcknowledgement =
    failedAcknowledgement?.accountScopeRevision === accountScopeRevision ? failedAcknowledgement : undefined

  if (stateScopeAvailable !== accountAvailable) {
    setStateScopeAvailable(accountAvailable)
    if (!accountAvailable) {
      setPresentedNotice(null)
      setDismissedNotice(undefined)
      setFailedAcknowledgement(undefined)
    }
  }
  if (accountScopeStateRevision !== accountScopeRevision) {
    setAccountScopeStateRevision(accountScopeRevision)
    setPresentedNotice(null)
    setDismissedNotice(undefined)
    setFailedAcknowledgement(undefined)
    setRetryDelayMs(Math.max(1, ackRetryDelayMs))
  }

  useEffect(() => {
    if (!initialRefreshRequested.current) {
      initialRefreshRequested.current = true
      onRefresh()
    }
  }, [onRefresh])

  useEffect(() => {
    if (signedIn && !wasSignedIn.current) onRefresh()
    wasSignedIn.current = signedIn
  }, [onRefresh, signedIn])

  const acknowledge = useCallback(
    async (orderId: string): Promise<void> => {
      const acknowledgementKey = `${accountScopeKey}:${orderId}`
      if (
        inFlightAcknowledgements.current.has(acknowledgementKey) ||
        settledAcknowledgements.current.has(acknowledgementKey)
      )
        return
      const generation = accountGeneration.current
      automaticallyPresented.current.add(acknowledgementKey)
      inFlightAcknowledgements.current.add(acknowledgementKey)
      try {
        const accepted = await onAcknowledgeBonus(orderId)
        if (generation !== accountGeneration.current) return
        settledAcknowledgements.current.add(acknowledgementKey)
        setFailedAcknowledgement((current) =>
          current?.orderId === orderId && current.accountScopeRevision === accountScopeRevision
            ? undefined
            : current,
        )
        retryDelay.current = Math.max(1, ackRetryDelayMs)
        setRetryDelayMs(retryDelay.current)
        if (!accepted) onRefresh()
      } catch {
        if (generation === accountGeneration.current) {
          setFailedAcknowledgement({ orderId, accountScopeRevision })
          const delay = retryDelay.current
          retryDelay.current = Math.min(delay * 2, Math.max(delay, ackRetryMaxDelayMs))
          setRetryDelayMs(delay)
        }
      } finally {
        inFlightAcknowledgements.current.delete(acknowledgementKey)
      }
    },
    [
      accountScopeKey,
      accountScopeRevision,
      ackRetryDelayMs,
      ackRetryMaxDelayMs,
      onAcknowledgeBonus,
      onRefresh,
    ],
  )

  useLayoutEffect(() => {
    if (previousAccountScopeRevision.current !== accountScopeRevision) {
      previousAccountScopeRevision.current = accountScopeRevision
      accountGeneration.current += 1
      automaticallyPresented.current.clear()
      settledAcknowledgements.current.clear()
      inFlightAcknowledgements.current.clear()
      setPresentedNotice(null)
      setDismissedNotice(undefined)
      setFailedAcknowledgement(undefined)
      retryDelay.current = Math.max(1, ackRetryDelayMs)
      setRetryDelayMs(retryDelay.current)
      if (retryTimer.current !== undefined) {
        window.clearTimeout(retryTimer.current)
        retryTimer.current = undefined
      }
    }
    if (!signedIn || bonusRead?.status === 'unavailable') {
      accountGeneration.current += 1
      automaticallyPresented.current.clear()
      settledAcknowledgements.current.clear()
      retryDelay.current = Math.max(1, ackRetryDelayMs)
      if (retryTimer.current !== undefined) {
        window.clearTimeout(retryTimer.current)
        retryTimer.current = undefined
      }
      return
    }
    if (bonusRead?.status !== 'ready') return

    if (bonusRead.value === null) return

    const reofferedAfterDismissal =
      visibleDismissedNotice?.orderId === bonusRead.value.orderId && visibleDismissedNotice.read !== bonusRead
    if (reofferedAfterDismissal) {
      const acknowledgementKey = `${accountScopeKey}:${bonusRead.value.orderId}`
      automaticallyPresented.current.delete(acknowledgementKey)
      settledAcknowledgements.current.delete(acknowledgementKey)
      retryDelay.current = Math.max(1, ackRetryDelayMs)
    }
  }, [
    accountScopeKey,
    accountScopeRevision,
    accountScopeStateRevision,
    ackRetryDelayMs,
    bonusRead,
    signedIn,
    visibleDismissedNotice,
  ])

  const notice =
    !signedIn || bonusRead?.status === 'unavailable'
      ? null
      : bonusRead?.status === 'ready' && bonusRead.value !== null
        ? bonusRead.value
        : visiblePresentedNotice
  const dismissedForThisRead =
    notice !== null &&
    visibleDismissedNotice?.orderId === notice.orderId &&
    (bonusRead?.status !== 'ready' || bonusRead.value === null || visibleDismissedNotice.read === bonusRead)
  const failedForThisNotice = notice !== null && visibleFailedAcknowledgement?.orderId === notice.orderId
  useEffect(() => {
    if (visibleFailedAcknowledgement === undefined || !accountAvailable) return
    const orderId = visibleFailedAcknowledgement.orderId
    retryTimer.current = window.setTimeout(() => {
      retryTimer.current = undefined
      setFailedAcknowledgement((current) => (current === visibleFailedAcknowledgement ? undefined : current))
      void acknowledge(orderId)
    }, retryDelayMs)
    return () => {
      if (retryTimer.current !== undefined) {
        window.clearTimeout(retryTimer.current)
        retryTimer.current = undefined
      }
    }
  }, [accountAvailable, acknowledge, retryDelayMs, visibleFailedAcknowledgement])

  const dismiss = useCallback(
    (orderId: string): void => {
      const acknowledgementKey = `${accountScopeKey}:${orderId}`
      automaticallyPresented.current.add(acknowledgementKey)
      setDismissedNotice({ orderId, accountScopeRevision, read: bonusRead })
      setFailedAcknowledgement(undefined)
      if (retryTimer.current !== undefined) {
        window.clearTimeout(retryTimer.current)
        retryTimer.current = undefined
      }
      if (
        !inFlightAcknowledgements.current.has(acknowledgementKey) &&
        !settledAcknowledgements.current.has(acknowledgementKey)
      )
        void acknowledge(orderId)
    },
    [accountScopeKey, accountScopeRevision, acknowledge, bonusRead],
  )

  useEffect(() => {
    if (
      notice === null ||
      !signedIn ||
      dismissedForThisRead ||
      settledAcknowledgements.current.has(`${accountScopeKey}:${notice.orderId}`) ||
      automaticallyPresented.current.has(`${accountScopeKey}:${notice.orderId}`) ||
      !isNoticeLive(notice)
    )
      return
    const element = bonusCard.current
    if (element === null) return
    let intersects = typeof IntersectionObserver === 'undefined'
    let cancelAfterPaint: (() => void) | undefined
    const present = (): void => {
      if (document.visibilityState === 'hidden' || !intersects || cancelAfterPaint !== undefined) return
      cancelAfterPaint = afterPaint(() => {
        cancelAfterPaint = undefined
        if (
          document.visibilityState === 'hidden' ||
          !intersects ||
          !isNoticeLive(notice) ||
          !element.isConnected ||
          automaticallyPresented.current.has(`${accountScopeKey}:${notice.orderId}`)
        )
          return
        setPresentedNotice(notice)
        void acknowledge(notice.orderId)
      })
    }
    let observer: IntersectionObserver | undefined
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver((entries) => {
        intersects = entries.some(
          (entry) => entry.target === element && entry.isIntersecting && entry.intersectionRatio > 0,
        )
        present()
      })
      observer.observe(element)
    } else {
      present()
    }
    document.addEventListener('visibilitychange', present)
    return () => {
      document.removeEventListener('visibilitychange', present)
      cancelAfterPaint?.()
      observer?.disconnect()
    }
  }, [accountScopeKey, acknowledge, dismissedForThisRead, notice, signedIn])

  const profile = snapshot?.profile.status === 'ready' ? snapshot.profile.value : undefined
  const balance = snapshot?.balance.status === 'ready' ? snapshot.balance.value : undefined
  const bonusWallets = balance?.bonusWallets.filter(isPositiveWallet) ?? []
  const visibleNotice = notice !== null && !dismissedForThisRead && isNoticeLive(notice) ? notice : null

  return (
    <section className="account-profile" aria-labelledby="account-profile-title" aria-busy={busy}>
      <header className="account-profile__header">
        <h3 id="account-profile-title">{labels.title}</h3>
        <button type="button" disabled={busy || !signedIn} onClick={onRefresh}>
          {labels.refresh}
        </button>
      </header>

      <div className="account-profile__section" aria-label={labels.profile}>
        <strong>{labels.profile}</strong>
        {!signedIn ? (
          <p>{labels.signedOut}</p>
        ) : profile !== undefined ? (
          <div className="account-profile__identity">
            <span className="account-profile__name">{profile.name?.trim() || labels.unnamed}</span>
            {profile.contact === null || profile.contact.trim() === '' ? null : (
              <span className="account-profile__contact">{profile.contact}</span>
            )}
          </div>
        ) : (
          <p role={snapshot?.profile.status === 'failed' || requestFailed ? 'alert' : 'status'}>
            {snapshot?.profile.status === 'failed' || requestFailed ? labels.failed : labels.unavailable}
          </p>
        )}
      </div>

      <div className="account-profile__section" aria-label={labels.balance}>
        <strong>{labels.balance}</strong>
        {!signedIn ? (
          <p>{labels.signedOut}</p>
        ) : balance !== undefined ? (
          balance.wallets.length === 0 ? (
            <p>{labels.noBalance}</p>
          ) : (
            <WalletList wallets={balance.wallets} locale={locale} />
          )
        ) : (
          <p role={snapshot?.balance.status === 'failed' || requestFailed ? 'alert' : 'status'}>
            {snapshot?.balance.status === 'failed' || requestFailed ? labels.failed : labels.unavailable}
          </p>
        )}
      </div>

      {signedIn ? (
        <div className="account-profile__section" aria-label={labels.bonusBalance}>
          <strong>{labels.bonusBalance}</strong>
          {balance !== undefined ? (
            bonusWallets.length === 0 ? (
              <p>{labels.noBalance}</p>
            ) : (
              <WalletList wallets={bonusWallets} locale={locale} />
            )
          ) : (
            <p role={snapshot?.balance.status === 'failed' || requestFailed ? 'alert' : 'status'}>
              {snapshot?.balance.status === 'failed' || requestFailed ? labels.failed : labels.unavailable}
            </p>
          )}
        </div>
      ) : null}

      {visibleNotice === null ? null : (
        <div ref={bonusCard} className="account-profile__bonus" role="status" aria-live="polite">
          <strong>{labels.bonusNotice}</strong>
          <p>{visibleNotice.message}</p>
          {failedForThisNotice ? (
            <div role="alert">
              <span>{labels.failed}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (retryTimer.current !== undefined) {
                    window.clearTimeout(retryTimer.current)
                    retryTimer.current = undefined
                  }
                  setFailedAcknowledgement(undefined)
                  retryDelay.current = Math.max(1, ackRetryDelayMs)
                  setRetryDelayMs(retryDelay.current)
                  void acknowledge(visibleNotice.orderId)
                }}
              >
                {labels.retryBonus}
              </button>
              <button type="button" disabled={busy} onClick={() => dismiss(visibleNotice.orderId)}>
                {labels.dismissBonus}
              </button>
            </div>
          ) : (
            <button type="button" disabled={busy} onClick={() => dismiss(visibleNotice.orderId)}>
              {labels.dismissBonus}
            </button>
          )}
        </div>
      )}

      <footer className="account-profile__actions">
        <button type="button" disabled={busy || !signedIn} onClick={onOpenUsage}>
          {labels.usage}
        </button>
        <button type="button" disabled={busy || !signedIn} onClick={onOpenTopUp}>
          {labels.topUp}
        </button>
      </footer>
    </section>
  )
}

function WalletList({
  wallets,
  locale,
}: {
  readonly wallets: readonly AccountWallet[]
  readonly locale: string
}): ReactElement {
  return (
    <ul className="account-profile__wallets">
      {wallets.map((wallet, index) => (
        <li key={`${wallet.currency}-${index}`}>
          <strong>{formatWallet(wallet.balance, wallet.currency, locale)}</strong>
        </li>
      ))}
    </ul>
  )
}

function isPositiveWallet(wallet: AccountWallet): boolean {
  const value = parseDecimal(wallet.balance)
  return value !== undefined && !value.negative && value.coefficient > 0n
}

function isNoticeLive(notice: AccountBonusNoticeDisplay): boolean {
  const expiration = Date.parse(notice.expiresAt)
  return Number.isNaN(expiration) || expiration > Date.now()
}

function afterPaint(run: () => void): () => void {
  if (typeof window.requestAnimationFrame !== 'function') {
    const timer = window.setTimeout(run, 0)
    return () => window.clearTimeout(timer)
  }
  let cancelled = false
  let timer: number | undefined
  const frame = window.requestAnimationFrame(() => {
    timer = window.setTimeout(() => {
      if (!cancelled) run()
    }, 0)
  })
  return () => {
    cancelled = true
    window.cancelAnimationFrame(frame)
    if (timer !== undefined) window.clearTimeout(timer)
  }
}

function formatWallet(value: string, currency: AccountWalletCurrency, locale: string): string {
  const symbol = currency === 'CNY' ? '¥' : '$'
  const amount = parseDecimal(value)
  if (amount === undefined) return `${symbol}${value}`
  if (amount.coefficient === 0n) return `${symbol}0.00`
  if (isLessThanOneCent(amount)) return amount.negative ? `-${symbol}0.01` : `<${symbol}0.01`
  const cents = centsValue(amount, amount.negative)
  const integer = cents / 100n
  const fraction = (cents % 100n).toString().padStart(2, '0')
  try {
    const grouped = new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 }).format(
      integer,
    )
    return `${amount.negative ? '-' : ''}${symbol}${grouped}.${fraction}`
  } catch {
    const grouped = integer.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
    return `${amount.negative ? '-' : ''}${symbol}${grouped}.${fraction}`
  }
}

interface ParsedDecimal {
  readonly negative: boolean
  readonly coefficient: bigint
  readonly scale: number
}

function parseDecimal(value: string): ParsedDecimal | undefined {
  const match = /^(-?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/iu.exec(value)
  if (match === null) return undefined
  const exponent = Number(match[4] ?? '0')
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 256) return undefined
  const integer = match[2] || '0'
  const fraction = match[3] ?? ''
  let digits = `${integer}${fraction}`.replace(/^0+(?=\d)/u, '')
  if (/^0+$/u.test(digits)) return { negative: false, coefficient: 0n, scale: 0 }
  let scale = fraction.length - exponent
  if (scale < 0) {
    digits += '0'.repeat(-scale)
    scale = 0
  }
  while (scale > 0 && digits.endsWith('0')) {
    digits = digits.slice(0, -1)
    scale -= 1
  }
  return { negative: match[1] === '-', coefficient: BigInt(digits), scale }
}

function isLessThanOneCent(value: ParsedDecimal): boolean {
  if (value.scale <= 2) return false
  return value.coefficient < 10n ** BigInt(value.scale - 2)
}

function centsValue(value: ParsedDecimal, roundHalfUp: boolean): bigint {
  if (value.scale <= 2) return value.coefficient * 10n ** BigInt(2 - value.scale)
  const divisor = 10n ** BigInt(value.scale - 2)
  const quotient = value.coefficient / divisor
  const remainder = value.coefficient % divisor
  return roundHalfUp && remainder * 2n >= divisor ? quotient + 1n : quotient
}
