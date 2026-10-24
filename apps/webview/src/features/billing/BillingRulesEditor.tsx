import type { ReactElement } from 'react'
import type { BillingPrice } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { billingConditionDescription, billingDateInput, parseBillingDateInput } from './billing-time.js'

export type BillingRules = Pick<BillingPrice, 'multipliers' | 'overrides' | 'validFrom' | 'validUntil'>
export function BillingRulesEditor({
  rules,
  onChange,
}: {
  readonly rules: BillingRules
  readonly onChange: (rules: BillingRules) => void
}): ReactElement {
  const { t, locale } = useI18n()
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
              <legend>{billingConditionDescription(rule.when, t, locale)}</legend>
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
              <legend>{billingConditionDescription(rule.when, t, locale)}</legend>
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
                value={billingDateInput(rules[key], locale)}
                onChange={(event) => {
                  const next = { ...rules }
                  if (event.target.value === '') delete next[key]
                  else next[key] = parseBillingDateInput(event.target.value, locale)
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
