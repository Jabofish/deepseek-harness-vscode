import { useEffect, useState, type ReactElement } from 'react'
import {
  billingEstimateResponseSchema,
  type BillingEstimateResponse,
  type FeatureHostEvent,
} from '@dsh-vscode/webview-protocol'
import { useI18n } from '../../i18n.js'
import { requestId } from '../../app/store/ids.js'
import { StatsPopover } from '../chat/StatsPopover.js'
import { useBillingClient, type BillingClient } from './billing-client.js'

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
}): ReactElement | null {
  const { t } = useI18n()
  const { request, subscribe, sessionId, usageKey } = props
  const { send } = useBillingClient(request)
  const [estimate, setEstimate] = useState<BillingEstimateResponse['estimate']>()
  const [revision, setRevision] = useState(0)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(
    () =>
      subscribe((event) => {
        if (event.name === 'billing.settings.changed') setRevision((value) => value + 1)
      }),
    [subscribe],
  )
  useEffect(() => {
    let current = true
    let pending: string | undefined
    const timer = window.setTimeout(() => {
      const id = requestId()
      pending = id
      void send({ type: 'billing.estimate', requestId: id, payload: { sessionId } })
        .then((value) => {
          const result = billingEstimateResponseSchema.parse(value)
          if (!current || result.estimate.sessionId !== sessionId) return
          setEstimate(result.estimate)
          setFailed(false)
        })
        .catch(() => {
          if (current) setFailed(true)
        })
        .finally(() => {
          pending = undefined
        })
    }, 200)
    return () => {
      current = false
      window.clearTimeout(timer)
      if (pending !== undefined)
        void request({
          type: 'feature.request.cancel',
          requestId: requestId(),
          payload: { targetRequestId: pending },
        }).catch(() => undefined)
    }
  }, [request, sessionId, usageKey, revision, send])
  const disabled = estimate?.sessionId === sessionId && !estimate.enabled
  if (failed && !disabled)
    return (
      <button type="button" className="dsh-stats-pill" onClick={() => setRevision((value) => value + 1)}>
        {t('billing.retry')}
      </button>
    )
  if (estimate?.enabled !== true || estimate.sessionId !== sessionId) return null
  const incomplete = !estimate.historyComplete || estimate.pricedRequests !== estimate.requests
  const label = !estimate.supported
    ? t('billing.unavailable')
    : estimate.totals.length === 0
      ? t('billing.unpricedCost')
      : `${t('billing.cost')} ≈ ${estimate.totals.map((total) => `${total.currency} ${formatBillingAmount(total.amount)}`).join(' / ')}${incomplete ? ` · ${t('billing.partial')}` : ''}`
  const rows = [
    { label: t('billing.pricedRequests'), value: `${estimate.pricedRequests} / ${estimate.requests}` },
    { label: t('billing.unpriced'), value: String(estimate.unpricedRequests + estimate.partialRequests) },
    ...(estimate.historyComplete ? [] : [{ label: t('billing.history'), value: t('billing.partial') }]),
  ]
  return props.details ? (
    <section className="dsh-stats-billing" aria-label={t('billing.cost')}>
      <strong>{label}</strong>
      <dl>
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  ) : (
    <StatsPopover label={label} icon="wallet" rows={rows} open={open} onOpenChange={setOpen} />
  )
}
