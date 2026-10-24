// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { FeatureHostEvent, FeatureRequest } from '@dsh-vscode/webview-protocol'
import { estimateBillingEntry, type BillingEstimate } from '@dsh-vscode/domain'
import { setActiveLocale } from '../../i18n.js'
import { BillingSettings } from './BillingSettings.js'
import { BillingCost } from './BillingCost.js'
import { StatsLine } from '../chat/StatsLine.js'
import type { BillingClient } from './billing-client.js'

beforeEach(() => setActiveLocale('en'))
afterEach(cleanup)
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
  expect(document.querySelector('small')).toBeNull()
})

it('shows only the cost in existing session statistics and refreshes when prices change', async () => {
  const route = { providerId: 'p', modelId: 'm' }
  const entry = estimateBillingEntry(
    {
      sequence: 7,
      kind: 'message',
      usage: { inputTokens: 1200, outputTokens: 400, cacheReadTokens: 800, cacheWriteTokens: 100 },
    },
    route,
    { ...route, currency: 'USD', input: '2', output: '10', cacheRead: '0.2', cacheWrite: '2.5' },
  )
  const estimate: BillingEstimate = {
    sessionId: 's',
    enabled: true,
    supported: true,
    historyComplete: false,
    scannedEvents: 4,
    requests: 2,
    pricedRequests: 1,
    partialRequests: 0,
    unpricedRequests: 1,
    priceRevision: 2,
    totals: [{ currency: 'USD', amount: '0.00681' }],
    entries: [entry, { sequence: 8, kind: 'attempt', charges: [], issues: ['missing-usage'] }],
    detailsTruncated: false,
  }
  const calls: FeatureRequest[] = []
  const request: BillingClient = <T,>(input: FeatureRequest): Promise<T> => {
    calls.push(input)
    return Promise.resolve({ kind: 'billing.estimate', estimate } as T)
  }
  let listener: ((event: FeatureHostEvent) => void) | undefined
  const subscribe = (next: (event: FeatureHostEvent) => void): (() => void) => {
    listener = next
    return () => {
      listener = undefined
    }
  }
  render(
    <StatsLine
      nodes={[]}
      cacheHit={0}
      usage={{ inputTokens: 100, outputTokens: 20 }}
      cost={<BillingCost request={request} subscribe={subscribe} sessionId="s" usageKey="one" />}
    />,
  )
  expect(calls).toHaveLength(0)
  await screen.findByText('Cost ≈ USD 0.00681 · Partial')
  expect(screen.getByRole('group', { name: 'Session statistics' }).textContent).toContain('USD 0.00681')
  expect(document.body.textContent).not.toContain('×')
  expect(calls).toHaveLength(1)
  expect(document.querySelector('small')).toBeNull()
  act(() =>
    listener?.({
      type: 'feature.event',
      name: 'billing.settings.changed',
      identity: {
        backendInstanceId: 'fixture',
        connectionGeneration: 1,
        stream: 'local',
        localSeq: 1,
      },
    }),
  )
  await waitFor(() => expect(calls.filter((call) => call.type === 'billing.estimate')).toHaveLength(2))
})

it('cancels its own pending history request when the session leaves', async () => {
  const calls: FeatureRequest[] = []
  const request: BillingClient = <T,>(input: FeatureRequest): Promise<T> => {
    calls.push(input)
    return input.type === 'feature.request.cancel'
      ? Promise.resolve({ kind: 'empty' } as T)
      : new Promise<T>(() => {})
  }
  const view = render(
    <BillingCost request={request} subscribe={() => () => {}} sessionId="s" usageKey="one" />,
  )
  await waitFor(() => expect(calls).toHaveLength(1))
  const target = calls[0]!.requestId
  view.unmount()
  await waitFor(() =>
    expect(
      calls.some((call) => call.type === 'feature.request.cancel' && call.payload.targetRequestId === target),
    ).toBe(true),
  )
})
