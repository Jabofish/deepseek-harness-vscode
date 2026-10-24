// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  billingCurrencyDisplay,
  estimateBillingEntry,
  summarizeBillingEntries,
  type BillingEstimate,
} from '@dsh-vscode/domain'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import { I18nProvider, useI18n } from '../../i18n.js'
import { BillingCost } from './BillingCost.js'
import type { BillingClient } from './billing-client.js'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.lang = 'en'
})
afterEach(() => {
  cleanup()
  localStorage.clear()
  document.documentElement.lang = 'en'
})
const route = { providerId: 'fixture', modelId: 'model' }
const entry = estimateBillingEntry(
  {
    kind: 'message',
    sequence: 1,
    usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
  },
  route,
  { ...route, currency: 'USD', input: '1', output: '2' },
)
const estimate: BillingEstimate = {
  sessionId: 's',
  enabled: true,
  supported: true,
  historyComplete: true,
  scannedEvents: 2,
  requests: 1,
  pricedRequests: 1,
  partialRequests: 0,
  unpricedRequests: 0,
  priceRevision: 1,
  totals: [{ currency: 'USD', amount: '1' }],
  entries: [entry],
  detailsTruncated: false,
  ...summarizeBillingEntries([entry]),
}
function Languages(): React.JSX.Element {
  const { setLocale } = useI18n()
  return (
    <>
      <button onClick={() => setLocale('zh')}>Chinese</button>
      <button onClick={() => setLocale('en')}>English</button>
    </>
  )
}
it('switches totals and charge rates with the UI language and ignores delayed responses for the previous language', async () => {
  const pending: (() => void)[] = []
  const calls: FeatureRequest[] = []
  const request: BillingClient = <T,>(input: FeatureRequest): Promise<T> => {
    calls.push(input)
    if (input.type !== 'billing.estimate') return Promise.resolve({ kind: 'empty' } as T)
    const target = input.payload.currency ?? 'USD'
    const result = {
      kind: 'billing.estimate',
      estimate: {
        ...estimate,
        display: billingCurrencyDisplay(estimate, target, { usdCny: '7', date: '2026-10-23' }),
      },
    }
    return target === 'USD'
      ? Promise.resolve(result as T)
      : new Promise((resolve) => pending.push(() => resolve(result as T)))
  }
  render(
    <I18nProvider>
      <Languages />
      <BillingCost request={request} subscribe={() => () => {}} sessionId="s" usageKey="one" />
    </I18nProvider>,
  )
  await screen.findByText('Cost ≈ USD 1')
  fireEvent.click(screen.getByText('Chinese'))
  expect(screen.queryByText('费用 ≈ USD 1')).toBeNull()
  await waitFor(() => expect(pending).toHaveLength(1))
  fireEvent.click(screen.getByText('English'))
  await screen.findByText('Cost ≈ USD 1')
  await act(async () => {
    pending[0]!()
    await Promise.resolve()
  })
  expect(screen.queryByText('费用 ≈ CNY 7')).toBeNull()
  expect(screen.getByText('Cost ≈ USD 1')).toBeDefined()
  fireEvent.click(screen.getByText('Chinese'))
  await waitFor(() => expect(pending).toHaveLength(2))
  await act(async () => {
    pending[1]!()
    await Promise.resolve()
  })
  fireEvent.click(await screen.findByRole('button', { name: '统计详情: 费用 ≈ CNY 7' }))
  expect(screen.getByRole('dialog').textContent).toContain('未缓存输入')
  expect(screen.getByRole('dialog').textContent).toContain('CNY 7')
  expect(screen.getByRole('dialog').textContent).not.toContain('tokens ×')
  expect(screen.getByText('参考汇率：1 USD = 7 CNY（ECB，2026-10-23）')).toBeDefined()
  expect(calls.some((call) => call.type === 'billing.estimate' && call.payload.currency === 'CNY')).toBe(true)
  expect(estimate.totals).toEqual([{ currency: 'USD', amount: '1' }])
})

it('uses the default 6.8 rate when a live quote is unavailable', async () => {
  document.documentElement.lang = 'zh-CN'
  const request: BillingClient = <T,>(): Promise<T> =>
    Promise.resolve({
      kind: 'billing.estimate',
      estimate: { ...estimate, display: billingCurrencyDisplay(estimate, 'CNY') },
    } as T)
  render(
    <I18nProvider>
      <BillingCost request={request} subscribe={() => () => {}} sessionId="s" usageKey="one" />
    </I18nProvider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: '统计详情: 费用 ≈ CNY 6.8' }))
  expect(screen.getByText('默认汇率：1 USD = 6.8 CNY')).toBeDefined()
  expect(screen.queryByText('费用 ≈ CNY 1')).toBeNull()
})
