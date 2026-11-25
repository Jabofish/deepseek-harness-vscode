import { useEffect, useState } from 'react'
import type { BillingDisplayCurrency } from '@dsh-vscode/domain'
import type { Locale } from '../../i18n.js'

/** `auto` keeps the historical default: CNY for Chinese UI, USD otherwise. */
export type BillingCurrencyPreference = 'auto' | BillingDisplayCurrency
export const BILLING_CURRENCY_OPTIONS: readonly BillingCurrencyPreference[] = ['auto', 'CNY', 'USD']
const STORAGE_KEY = 'dsh-webview-billing-currency'
const CHANGE_EVENT = 'dsh-billing-currency-change'

function isPreference(value: unknown): value is BillingCurrencyPreference {
  return value === 'auto' || value === 'CNY' || value === 'USD'
}

export function readBillingCurrencyPreference(): BillingCurrencyPreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isPreference(stored) ? stored : 'auto'
  } catch {
    return 'auto'
  }
}

export function writeBillingCurrencyPreference(value: BillingCurrencyPreference): void {
  try {
    if (value === 'auto') window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // Storage can be unavailable; the choice still applies to this page.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: value }))
}

export function resolveBillingCurrency(
  preference: BillingCurrencyPreference,
  locale: Locale,
): BillingDisplayCurrency {
  if (preference !== 'auto') return preference
  return locale === 'zh' ? 'CNY' : 'USD'
}

/** The display currency, independent of the UI language once chosen. */
export function useBillingCurrencyPreference(): BillingCurrencyPreference {
  const [preference, setPreference] = useState(readBillingCurrencyPreference)
  useEffect(() => {
    const update = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail
      setPreference(isPreference(detail) ? detail : readBillingCurrencyPreference())
    }
    window.addEventListener(CHANGE_EVENT, update)
    return () => window.removeEventListener(CHANGE_EVENT, update)
  }, [])
  return preference
}
