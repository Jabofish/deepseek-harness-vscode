import type { ReactElement } from 'react'
import type { BillingCondition, BillingPrice } from '@dsh-vscode/domain'
import { useI18n, type Translate } from '../../i18n.js'

export type BillingRules = Pick<BillingPrice, 'multipliers' | 'overrides' | 'validFrom' | 'validUntil'>
export function billingConditionDescription(c: BillingCondition, t: Translate): string {
  const description = billingConditionDescription
  if ('all' in c) return c.all.map((v) => description(v, t)).join(t('billing.and'))
  if ('any' in c) return `(${c.any.map((v) => description(v, t)).join(t('billing.or'))})`
  if ('not' in c) return t('billing.except', { condition: description(c.not, t) })
  if ('holiday' in c) return t('billing.holiday', { region: c.holiday })
  if ('serviceTier' in c) return t('billing.serviceTier', { tier: c.serviceTier.equals })
  if ('utcDays' in c) return c.utcDays.map((day) => t(`billing.day.${day}`)).join(', ')
  if ('utcHours' in c) return `UTC ${c.utcHours.gte ?? '00:00'} – ${c.utcHours.lt ?? '24:00'}`
  if ('date' in c) return `${c.date.gte ?? '…'} – ${c.date.lt ?? '…'} UTC`
  return t('billing.contextCondition', {
    bounds: Object.entries(c.context)
      .map(([op, n]) => `${t(`billing.bound.${op}`)} ${n}`)
      .join(', '),
  })
}

export function BillingRulesEditor({
  rules,
  onChange,
}: {
  readonly rules: BillingRules
  readonly onChange: (rules: BillingRules) => void
}): ReactElement {
  const { t } = useI18n()
  return (
    <div className="dsh-billing__rules">
      {(rules.multipliers?.length ?? 0) + (rules.overrides?.length ?? 0) > 0 ? (
        <details className="dsh-billing__disclosure">
          <summary>
            {t('billing.specialRules', {
              count: (rules.multipliers?.length ?? 0) + (rules.overrides?.length ?? 0),
            })}
          </summary>
          {(rules.multipliers ?? []).map((rule, index) => (
            <fieldset key={index}>
              <legend>{billingConditionDescription(rule.when, t)}</legend>
              <label>
                {t('billing.ruleFactor', { index: index + 1 })}
                <input
                  inputMode="decimal"
                  maxLength={19}
                  value={rule.factor}
                  onChange={(event) =>
                    onChange({
                      ...rules,
                      multipliers:
                        rules.multipliers?.map((r, i) =>
                          i === index ? { ...r, factor: event.target.value } : r,
                        ) ?? [],
                    })
                  }
                />
              </label>
            </fieldset>
          ))}
          {(rules.overrides ?? []).map((rule, index) => (
            <fieldset key={index}>
              <legend>{billingConditionDescription(rule.when, t)}</legend>
              <div className="dsh-billing__rates">
                {Object.entries(rule.rates).map(([category, value]) => (
                  <label key={category}>
                    {t(`billing.rate.${category}`)}
                    <input
                      inputMode="decimal"
                      maxLength={19}
                      value={value}
                      onChange={(event) =>
                        onChange({
                          ...rules,
                          overrides:
                            rules.overrides?.map((r, i) =>
                              i === index
                                ? { ...r, rates: { ...r.rates, [category]: event.target.value } }
                                : r,
                            ) ?? [],
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              {rule.unavailable?.length ? <p>{t('billing.unknownTtl')}</p> : null}
            </fieldset>
          ))}
        </details>
      ) : null}
      <details className="dsh-billing__disclosure">
        <summary>{t('billing.validity')}</summary>
        <div className="dsh-billing__route-fields">
          {(['validFrom', 'validUntil'] as const).map((key) => (
            <label key={key}>
              {t(`billing.${key}`)}
              <input
                type="datetime-local"
                value={rules[key] === undefined ? '' : new Date(rules[key]).toISOString().slice(0, 16)}
                onChange={(event) => {
                  const next = { ...rules }
                  if (event.target.value === '') delete next[key]
                  else next[key] = Date.parse(`${event.target.value}Z`)
                  onChange(next)
                }}
              />
            </label>
          ))}
        </div>
      </details>
    </div>
  )
}
