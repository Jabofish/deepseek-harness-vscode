import { useEffect, useState, type ReactElement } from 'react'
import type { BillingCandidate, BillingCondition, BillingPrice } from '@dsh-vscode/domain'
import { billingReferenceResponseSchema, type BillingReferenceResponse } from '@dsh-vscode/webview-protocol'
import { useI18n } from '../../i18n.js'
import { requestId } from '../../app/store/ids.js'
import { useBillingClient, type BillingClient } from './billing-client.js'
import { billingConditionDescription, billingDateLabel } from './billing-time.js'

const categories = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const
function hasServiceTier(condition: BillingCondition): boolean {
  if ('serviceTier' in condition) return true
  if ('all' in condition) return condition.all.some(hasServiceTier)
  if ('any' in condition) return condition.any.some(hasServiceTier)
  return 'not' in condition && hasServiceTier(condition.not)
}

/** Read-only prices and predicates; opening this never modifies the chosen route. */
export function BillingPriceDetails({ price }: { readonly price: BillingPrice }): ReactElement {
  const { t, locale } = useI18n()
  return (
    <div className="dsh-billing__price-details">
      <p>
        {t('billing.configuration')} · {price.currency}
      </p>
      <dl className="dsh-billing__price-facts">
        {categories.map((category) => (
          <div key={category}>
            <dt>{t(`billing.rate.${category}`)}</dt>
            <dd>
              {price[category] === undefined
                ? t('billing.notConfigured')
                : `${price.currency} ${price[category]}`}
            </dd>
          </div>
        ))}
      </dl>
      {(price.multipliers?.length ?? 0) + (price.overrides?.length ?? 0) === 0 ? null : (
        <ul className="dsh-billing__price-rules">
          {price.multipliers?.map((rule, index) => (
            <li key={`multiplier-${index}`}>
              {billingConditionDescription(rule.when, t, locale)} · × {rule.factor}
            </li>
          ))}
          {price.overrides?.map((rule, index) => (
            <li key={`override-${index}`}>
              <p>{billingConditionDescription(rule.when, t, locale)}</p>
              <dl className="dsh-billing__price-facts">
                {Object.entries(rule.rates).map(([category, rate]) => (
                  <div key={category}>
                    <dt>{t(`billing.rate.${category}`)}</dt>
                    <dd>
                      {price.currency} {rate}
                    </dd>
                  </div>
                ))}
              </dl>
              {rule.unavailable?.length ? <p>{t('billing.unknownTtl')}</p> : null}
            </li>
          ))}
        </ul>
      )}
      {price.multipliers?.some((rule) => hasServiceTier(rule.when)) ||
      price.overrides?.some((rule) => hasServiceTier(rule.when)) ? (
        <p>{t('billing.serviceTierUnknown')}</p>
      ) : null}
      {price.validFrom === undefined && price.validUntil === undefined ? null : (
        <p>
          {t('billing.validity')}: {t('billing.timeZone')} {billingDateLabel(price.validFrom, locale)} –{' '}
          {billingDateLabel(price.validUntil, locale)}
        </p>
      )}
    </div>
  )
}

export function BillingReferenceDetails(props: {
  readonly reference: BillingCandidate
  readonly request: BillingClient
  readonly price?: BillingPrice
}): ReactElement {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return (
    <details className="dsh-billing__disclosure" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t('billing.priceDetails')}</summary>
      {open ? (
        props.price === undefined ? (
          <ReferencePrices
            key={JSON.stringify(props.reference)}
            reference={props.reference}
            request={props.request}
          />
        ) : (
          <BillingPriceDetails price={props.price} />
        )
      ) : null}
    </details>
  )
}

function ReferencePrices({
  reference,
  request,
}: {
  readonly reference: BillingCandidate
  readonly request: BillingClient
}): ReactElement {
  const { t, locale } = useI18n()
  const { send, isAlive } = useBillingClient(request)
  const [result, setResult] = useState<BillingReferenceResponse>()
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let current = true
    void send({
      type: 'billing.reference.read',
      requestId: requestId(),
      payload: { providerId: reference.providerId, modelId: reference.modelId },
    })
      .then((value) => {
        const result = billingReferenceResponseSchema.parse(value)
        if (current && isAlive()) setResult(result)
      })
      .catch(() => {
        if (current && isAlive()) setFailed(true)
      })
    return () => {
      current = false
    }
  }, [send, isAlive, reference.providerId, reference.modelId, revision])
  if (failed)
    return (
      <div role="alert">
        <p>{t('billing.referenceFailed')}</p>
        <button
          type="button"
          onClick={() => {
            setFailed(false)
            setResult(undefined)
            setRevision((value) => value + 1)
          }}
        >
          {t('billing.retryReference')}
        </button>
      </div>
    )
  if (result === undefined) return <p role="status">{t('billing.loading')}</p>
  return (
    <>
      {result.price === undefined ? (
        <p>
          {t(result.status === 'unsupported' ? 'billing.referenceUnsupported' : 'billing.referenceMissing')}
        </p>
      ) : (
        <BillingPriceDetails price={result.price} />
      )}
      <p>
        {t('billing.retrievedAt', {
          time: `${t('billing.timeZone')} ${billingDateLabel(Date.parse(result.fetchedAt), locale)}`,
        })}
      </p>
    </>
  )
}
