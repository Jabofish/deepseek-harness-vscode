import { useMemo, useState, type ReactElement } from 'react'
import {
  billingCurrencyDisplay,
  type BillingDisplayCurrency,
  type BillingCurrencyDisplay,
} from '@dsh-vscode/domain'
import { type BillingEstimateResponse, type FeatureHostEvent } from '@dsh-vscode/webview-protocol'
import { useI18n } from '../../i18n.js'
import { StatsPopover } from '../chat/StatsPopover.js'
import type { BillingClient } from './billing-client.js'
import { useBillingEstimate } from './billing-estimate-cache.js'

/** Round display values without losing precision in the stored decimal amount. */
export function formatBillingAmount(amount: string): string {
  const [whole = '0', fraction = ''] = amount.split('.')
  const rounded =
    BigInt(whole) * 10_000n +
    BigInt(fraction.slice(0, 4).padEnd(4, '0')) +
    ((fraction[4] ?? '0') >= '5' ? 1n : 0n)
  if (rounded === 0n) return /[1-9]/u.test(amount) ? '< 0.0001' : '0'
  const decimal = (rounded % 10_000n).toString().padStart(4, '0').replace(/0+$/u, '')
  return `${rounded / 10_000n}${decimal === '' ? '' : `.${decimal}`}`
}

/** An optional reading in the existing session stats row, with no independent panel. */
export function BillingCost(props: {
  readonly request: BillingClient
  readonly subscribe: (listener: (event: FeatureHostEvent) => void) => () => void
  readonly sessionId: string
  readonly usageKey: string
  readonly details?: boolean
  readonly labelOnly?: boolean
  readonly cacheScope?: string
}): ReactElement | null {
  const { t, locale } = useI18n()
  const currency: BillingDisplayCurrency = locale === 'zh' ? 'CNY' : 'USD'
  const { request, subscribe, sessionId, usageKey } = props
  const { estimate, failed, refreshing, refresh, refreshIfStale } = useBillingEstimate(
    request,
    subscribe,
    props.cacheScope ?? '',
    sessionId,
    usageKey,
    currency,
  )
  const [open, setOpen] = useState(false)
  const display = useMemo(
    () =>
      estimate === undefined
        ? undefined
        : estimate.display?.currency === currency
          ? estimate.display
          : billingCurrencyDisplay(estimate, currency),
    [estimate, currency],
  )
  const disabled = estimate?.sessionId === sessionId && !estimate.enabled
  if (failed && !disabled && estimate === undefined)
    return props.labelOnly ? (
      <span>{t('billing.retry')}</span>
    ) : (
      <button type="button" className="dsh-stats-pill" onClick={refresh}>
        {t('billing.retry')}
      </button>
    )
  if (estimate?.enabled !== true || estimate.sessionId !== sessionId || display === undefined) return null
  const incomplete = !estimate.historyComplete || estimate.pricedRequests !== estimate.requests
  const label = !estimate.supported
    ? t('billing.unavailable')
    : display.totals.length === 0
      ? t('billing.unpricedCost')
      : `${t('billing.cost')} ≈ ${display.totals.map((total) => `${total.currency} ${formatBillingAmount(total.amount)}`).join(' / ')}${incomplete ? ` · ${t('billing.partial')}` : ''}${display.status === 'unavailable' ? ` · ${t('billing.originalCurrency')}` : ''}`
  if (props.labelOnly)
    return (
      <span title={failed || refreshing ? t('billing.cachedEstimate') : label}>
        {' · '}
        {!estimate.supported || display.totals.length === 0
          ? label
          : `≈ ${display.totals.map((total) => `${total.currency} ${formatBillingAmount(total.amount)}`).join(' / ')}`}
      </span>
    )
  const details = (
    <>
      {failed ? (
        <button type="button" onClick={refresh}>
          {t('billing.retry')}
        </button>
      ) : null}
      {failed || refreshing ? <p>{t('billing.cachedEstimate')}</p> : null}
      <BillingCostDetails estimate={estimate} display={display} />
    </>
  )
  return props.details ? (
    <section className="dsh-stats-billing" aria-label={t('billing.cost')}>
      <strong>{label}</strong>
      {details}
    </section>
  ) : (
    <StatsPopover
      label={label}
      icon="wallet"
      rows={[]}
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (value) refreshIfStale()
      }}
    >
      {details}
    </StatsPopover>
  )
}

function BillingCostDetails({
  estimate,
  display,
}: {
  readonly estimate: BillingEstimateResponse['estimate']
  readonly display: BillingCurrencyDisplay
}): ReactElement {
  const { t, locale } = useI18n()
  const count = (value: string | number): string => new Intl.NumberFormat(locale).format(BigInt(value))
  const categories = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const
  const affected = estimate.unpricedRequests + estimate.partialRequests
  return (
    <div className="dsh-billing-cost-details">
      <strong>{t('billing.priceDetails')}</strong>
      <dl className="dsh-billing-cost-breakdown">
        {[...display.breakdown]
          .sort(
            (a, b) =>
              a.currency.localeCompare(b.currency) ||
              categories.indexOf(a.category) - categories.indexOf(b.category),
          )
          .map((group) => (
            <div key={JSON.stringify([group.currency, group.category])}>
              <dt>{t(`billing.rate.${group.category}`)}</dt>
              <dd>
                {group.currency} {formatBillingAmount(group.amount)}
              </dd>
            </div>
          ))}
      </dl>
      {display.breakdown.length === 0 ? <p>{t('billing.noPricedUsage')}</p> : null}
      {display.status === 'converted' && display.exchange !== undefined ? (
        <p>
          {display.exchange.fallback === true
            ? t('billing.defaultExchangeRate', { rate: display.exchange.usdCny })
            : t('billing.exchangeRate', { rate: display.exchange.usdCny, date: display.exchange.date })}
        </p>
      ) : null}
      {display.status === 'unavailable' ? <p>{t('billing.exchangeUnavailable')}</p> : null}
      {affected > 0 ? (
        <section
          className="dsh-billing-cost-issues"
          aria-label={t('billing.unpricedReasons', { count: affected })}
        >
          <strong>{t('billing.unpricedReasons', { count: affected })}</strong>
          <ul>
            {estimate.issueCounts.map((issue) => (
              <li key={issue.issue}>
                {t(`billing.issue.${issue.issue}`)} · {count(issue.count)}
                {issue.issue === 'missing-usage' && issue.attempts > 0 ? (
                  <p>{t('billing.incompleteAttempts', { count: issue.attempts })}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {estimate.historyComplete ? null : <p>{t('billing.historyPartial')}</p>}
    </div>
  )
}
