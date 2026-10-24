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

/** An optional reading in the existing session stats row, with no independent panel. */
export function BillingCost(props: {
  readonly request: BillingClient
  readonly subscribe: (listener: (event: FeatureHostEvent) => void) => () => void
  readonly sessionId: string
  readonly usageKey: string
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
      : `${t('billing.cost')} ≈ ${estimate.totals.map((total) => `${total.currency} ${total.amount}`).join(' / ')}${incomplete ? ` · ${t('billing.partial')}` : ''}`
  const rows = [
    { label: t('billing.pricedRequests'), value: `${estimate.pricedRequests} / ${estimate.requests}` },
    { label: t('billing.unpriced'), value: String(estimate.unpricedRequests + estimate.partialRequests) },
    ...(estimate.historyComplete ? [] : [{ label: t('billing.history'), value: t('billing.partial') }]),
  ]
  return <StatsPopover label={label} icon="wallet" rows={rows} open={open} onOpenChange={setOpen} />
}
