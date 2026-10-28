// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import { type BillingEstimate } from '@dsh-vscode/domain'
import { setActiveLocale } from '../../i18n.js'
import { BillingSettings } from './BillingSettings.js'
import { BillingCost } from './BillingCost.js'

import type { BillingClient } from './billing-client.js'

beforeEach(() => setActiveLocale('en'))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function open(label: string, value = true): void {
  const details = screen.getByText(label).closest('details')!
  act(() => {
    details.open = value
    fireEvent(details, new Event('toggle'))
  })
}

it('edits independent local prices, preserves drafts on failure, and refuses unsupported reference rules', async () => {
  const calls: FeatureRequest[] = []
  let failInitialRead = true
  const request: BillingClient = <T,>(input: FeatureRequest): Promise<T> => {
    calls.push(input)
    if (input.type === 'billing.settings.read' && failInitialRead) {
      failInitialRead = false
      return Promise.reject(new Error('PRIVATE_READ_DETAILS'))
    }
    if (input.type === 'billing.settings.save') return Promise.reject(new Error('PRIVATE_SAVE_DETAILS'))
    if (input.type === 'billing.reference.read')
      return Promise.resolve({
        kind: 'billing.reference',
        status: 'unsupported',
        fetchedAt: '2026-10-24T00:00:00.000Z',
      } as T)
    return Promise.resolve({
      kind: 'billing.settings',
      scopeId: 'scope',
      settings: { revision: 3, enabled: false, prices: [] },
    } as T)
  }
  render(<BillingSettings request={request} models={[]} />)
  expect(calls).toHaveLength(0)
  open('Model billing')
  await screen.findByText(/Billing could not be read or saved/)
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved prices' }))
  await waitFor(() =>
    expect(
      screen.getByRole('checkbox', { name: 'Enable cost estimates' }).closest('fieldset')?.disabled,
    ).toBe(false),
  )
  expect(screen.queryByLabelText('Provider ID')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Add price' }))
  fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'local-route' } })
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'local-model' } })
  fireEvent.change(screen.getByLabelText('Uncached input'), { target: { value: '1.25' } })
  fireEvent.change(screen.getByLabelText('Output'), { target: { value: '5' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enable cost estimates' }))
  open('models.dev reference prices (USD)')
  fireEvent.change(screen.getByLabelText('Reference provider ID'), { target: { value: 'reference-route' } })
  fireEvent.change(screen.getByLabelText('Reference model ID'), { target: { value: 'reference-model' } })
  fireEvent.click(screen.getByRole('button', { name: 'Read reference prices' }))
  await screen.findByText(/unsupported pricing conditions/)
  expect(screen.getByLabelText<HTMLInputElement>('Uncached input').value).toBe('1.25')
  fireEvent.click(screen.getByRole('button', { name: "Save this model's prices" }))
  await screen.findByText(/Billing could not be read or saved/)
  expect(calls.find((call) => call.type === 'billing.settings.save')).toMatchObject({
    payload: {
      scopeId: 'scope',
      expectedRevision: 3,
      settings: {
        enabled: true,
        prices: [
          { providerId: 'local-route', modelId: 'local-model', input: '1.25', output: '5', currency: 'USD' },
        ],
      },
    },
  })
  expect(screen.getByLabelText<HTMLInputElement>('Uncached input').value).toBe('1.25')
  expect(document.body.textContent).not.toContain('PRIVATE_SAVE_DETAILS')
  expect(document.body.textContent).not.toContain('PRIVATE_READ_DETAILS')
})

it('keeps a confirmed disabled estimate hidden if a later refresh fails', async () => {
  let attempts = 0
  const request: BillingClient = <T,>(input: FeatureRequest): Promise<T> => {
    if (input.type === 'feature.request.cancel') return Promise.resolve({ kind: 'empty' } as T)
    if (++attempts > 1) return Promise.reject(new Error('PRIVATE_HISTORY_FAILURE'))
    return Promise.resolve({
      kind: 'billing.estimate',
      estimate: {
        sessionId: 's',
        enabled: false,
        supported: true,
        historyComplete: false,
        scannedEvents: 0,
        requests: 0,
        pricedRequests: 0,
        partialRequests: 0,
        unpricedRequests: 0,
        priceRevision: 1,
        totals: [],
        breakdown: [],
        issueCounts: [],
        entries: [],
        detailsTruncated: false,
      },
    } as T)
  }
  const subscribe = () => () => {}
  const view = render(<BillingCost request={request} subscribe={subscribe} sessionId="s" usageKey="one" />)
  await waitFor(() => expect(attempts).toBe(1))
  view.rerender(<BillingCost request={request} subscribe={subscribe} sessionId="s" usageKey="two" />)
  await waitFor(() => expect(attempts).toBe(2))
  expect(view.container.textContent).toBe('')
  expect(screen.queryByRole('button', { name: 'Retry cost estimate' })).toBeNull()
})

function cachedEstimate(amount: string): BillingEstimate {
  return {
    sessionId: 's',
    enabled: true,
    supported: true,
    historyComplete: true,
    scannedEvents: 1,
    requests: 1,
    pricedRequests: 1,
    partialRequests: 0,
    unpricedRequests: 0,
    priceRevision: 1,
    totals: [{ currency: 'USD', amount }],
    breakdown: [],
    issueCounts: [],
    entries: [],
    detailsTruncated: false,
  }
}

it('isolates connections and keeps the last amount visible while a failed refresh can be retried', async () => {
  vi.useFakeTimers()
  let reads = 0
  let offline = false
  const request: BillingClient = <T,>(input: FeatureRequest): Promise<T> => {
    if (input.type === 'feature.request.cancel') return Promise.resolve({ kind: 'empty' } as T)
    reads += 1
    return offline
      ? Promise.reject(new Error('PRIVATE_NETWORK'))
      : Promise.resolve({ kind: 'billing.estimate', estimate: cachedEstimate(String(reads)) } as T)
  }
  const subscribe = () => () => {}
  const cost = (scope: string, usageKey = 'one'): React.JSX.Element => (
    <BillingCost
      cacheScope={scope}
      request={request}
      subscribe={subscribe}
      sessionId="s"
      usageKey={usageKey}
    />
  )
  const view = render(cost('first'))
  await act(() => vi.advanceTimersByTimeAsync(200))
  expect(screen.getByText('Cost ≈ USD 1')).toBeDefined()
  view.rerender(cost('second'))
  expect(screen.queryByText('Cost ≈ USD 1')).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(200))
  expect(screen.getByText('Cost ≈ USD 2')).toBeDefined()
  offline = true
  view.rerender(cost('second', 'two'))
  expect(screen.getByText('Cost ≈ USD 2')).toBeDefined()
  await act(() => vi.advanceTimersByTimeAsync(200))
  fireEvent.click(screen.getByRole('button', { name: /Statistics details: Cost/ }))
  expect(screen.getByText('Showing the last calculated cost.')).toBeDefined()
  expect(screen.getByText('Cost ≈ USD 2')).toBeDefined()
  offline = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry cost estimate' }))
  await act(() => vi.advanceTimersByTimeAsync(200))
  expect(screen.getByText('Cost ≈ USD 4')).toBeDefined()
  expect(reads).toBe(4)
  expect(document.body.textContent).not.toContain('PRIVATE_NETWORK')
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  await act(() => vi.advanceTimersByTimeAsync(5 * 60_000 + 1))
  fireEvent.click(screen.getByRole('button', { name: /Statistics details: Cost/ }))
  expect(screen.getByText('Cost ≈ USD 4')).toBeDefined()
  await act(() => vi.advanceTimersByTimeAsync(200))
  expect(screen.getByText('Cost ≈ USD 5')).toBeDefined()
})
