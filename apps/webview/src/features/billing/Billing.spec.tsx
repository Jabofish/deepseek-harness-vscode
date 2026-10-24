// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FeatureHostEvent, FeatureRequest } from '@dsh-vscode/webview-protocol'
import { estimateBillingEntry, summarizeBillingEntries, type BillingEstimate } from '@dsh-vscode/domain'
import { setActiveLocale } from '../../i18n.js'
import { BillingSettings } from './BillingSettings.js'
import { BillingCost, formatBillingAmount } from './BillingCost.js'
import { StatsLine } from '../chat/StatsLine.js'
import type { BillingClient } from './billing-client.js'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'

beforeEach(() => setActiveLocale('en'))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each([
  ['0.003946662', '0.0039'],
  ['0.00681', '0.0068'],
  ['1.23456', '1.2346'],
  ['0.99999', '1'],
  ['0.000000000000001', '< 0.0001'],
  ['0.00005', '0.0001'],
  ['0', '0'],
  ['9007199254740993.12345', '9007199254740993.1235'],
])('formats %s as %s without changing the accounting precision', (amount, formatted) => {
  expect(formatBillingAmount(amount)).toBe(formatted)
})

it('moves cost inside focused token details when the stats container narrows and restores it on resize', async () => {
  vi.useFakeTimers()
  let resize: ResizeObserverCallback | undefined
  let observed: Element | undefined
  const disconnect = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(element: Element): void {
        if (element.matches('.dsh-stats-line')) {
          observed = element
          resize = this.callback
        }
      }
      disconnect = disconnect
    },
  )
  let estimateReads = 0
  const request: BillingClient = <T,>(input: FeatureRequest): Promise<T> => {
    if (input.type === 'billing.estimate') estimateReads += 1
    return Promise.resolve({
      kind: 'billing.estimate',
      estimate: {
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
        totals: [{ currency: 'USD', amount: '0.003946662' }],
        breakdown: [],
        issueCounts: [],
        entries: [],
        detailsTruncated: false,
      },
    } as T)
  }
  const view = render(
    <ConversationLayoutProvider initialLayout="focused">
      <StatsLine
        nodes={[]}
        cacheHit={0}
        usage={{ inputTokens: 100, outputTokens: 20, totalTokens: 120 }}
        cost={(details, inline = false) => (
          <BillingCost
            details={details}
            labelOnly={inline}
            request={request}
            subscribe={() => () => {}}
            sessionId="s"
            usageKey="one"
          />
        )}
      />
    </ConversationLayoutProvider>,
  )
  await act(() => vi.advanceTimersByTimeAsync(200))
  expect(screen.getByText('Cost ≈ USD 0.0039')).toBeDefined()
  act(() =>
    resize?.(
      [{ target: observed!, contentRect: new DOMRect(0, 0, 486, 24) } as ResizeObserverEntry],
      {} as ResizeObserver,
    ),
  )
  expect(screen.queryByText('Cost ≈ USD 0.0039')).toBeNull()
  const tokens = screen.getByRole('button', { name: /Statistics details:.*120 tokens/ })
  expect(tokens.textContent).toContain('≈ USD 0.0039')
  fireEvent.click(tokens)
  const cost = screen.getByText('Cost ≈ USD 0.0039')
  expect(cost.closest('[role="dialog"]')).toBe(screen.getByRole('dialog'))
  expect(cost.closest('button')).toBeNull()
  expect(view.container.querySelectorAll('.dsh-stats-pill')).toHaveLength(2)
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(screen.queryByText('Cost ≈ USD 0.0039')).toBeNull()
  expect(document.activeElement).toBe(tokens)
  expect(tokens.textContent).toContain('≈ USD 0.0039')
  fireEvent.click(tokens)
  await act(() => vi.advanceTimersByTimeAsync(200))
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  act(() =>
    resize?.(
      [{ target: observed!, contentRect: new DOMRect(0, 0, 900, 24) } as ResizeObserverEntry],
      {} as ResizeObserver,
    ),
  )
  await act(() => vi.advanceTimersByTimeAsync(200))
  expect(screen.getByRole('button', { name: /Statistics details: Cost ≈ USD 0.0039/ })).toBeDefined()
  expect(tokens.textContent).not.toContain('USD')
  expect(estimateReads).toBe(1)
  view.unmount()
  expect(disconnect).toHaveBeenCalled()
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
    ...summarizeBillingEntries([
      entry,
      { sequence: 8, kind: 'attempt', charges: [], issues: ['missing-usage'] },
    ]),
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
      cost={(details) => (
        <BillingCost details={details} request={request} subscribe={subscribe} sessionId="s" usageKey="one" />
      )}
    />,
  )
  expect(calls).toHaveLength(0)
  await screen.findByText('Cost ≈ USD 0.0068 · Partial')
  expect(screen.getByRole('group', { name: 'Session statistics' }).textContent).toContain('USD 0.0068')
  expect(document.body.textContent).not.toContain('×')
  expect(calls).toHaveLength(1)
  expect(document.querySelector('small')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Statistics details: Cost/ }))
  const dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('Uncached inputUSD 0.0024')
  expect(dialog.textContent).toContain('Cache readUSD 0.0002')
  expect(dialog.textContent).not.toContain('tokens ×')
  expect(dialog.textContent).toContain('Token usage was not returned; the cost cannot be estimated')
  expect(dialog.textContent).toContain('Includes 1 failed or interrupted requests')
  expect(dialog.textContent).not.toContain('Priced requests')
  expect(dialog.textContent.indexOf('Pricing details')).toBeLessThan(
    dialog.textContent.indexOf('Unpriced reasons'),
  )
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

it.each([true, false])(
  'retries the first estimate failure and respects enabled=%s after recovery',
  async (enabled) => {
    let attempts = 0
    const request: BillingClient = <T,>(input: FeatureRequest): Promise<T> => {
      if (input.type === 'feature.request.cancel') return Promise.resolve({ kind: 'empty' } as T)
      if (++attempts === 1) return Promise.reject(new Error('PRIVATE_HISTORY_FAILURE'))
      return Promise.resolve({
        kind: 'billing.estimate',
        estimate: {
          sessionId: 's',
          enabled,
          supported: true,
          historyComplete: true,
          scannedEvents: 1,
          requests: 1,
          pricedRequests: 1,
          partialRequests: 0,
          unpricedRequests: 0,
          priceRevision: 1,
          totals: [{ currency: 'USD', amount: '0.000014' }],
          breakdown: [],
          issueCounts: [],
          entries: [],
          detailsTruncated: false,
        },
      } as T)
    }
    render(<BillingCost request={request} subscribe={() => () => {}} sessionId="s" usageKey="one" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry cost estimate' }))
    await waitFor(() => expect(attempts).toBe(2))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry cost estimate' })).toBeNull())
    if (enabled) expect(await screen.findByText('Cost ≈ USD < 0.0001')).toBeDefined()
    else expect(screen.queryByText(/Cost ≈/)).toBeNull()
    expect(document.body.textContent).not.toContain('PRIVATE_HISTORY_FAILURE')
  },
)

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

it('shares pending calculation work and keeps it alive while another reading still needs it', async () => {
  vi.useFakeTimers()
  const calls: FeatureRequest[] = []
  let deliver: (() => void) | undefined
  const request: BillingClient = <T,>(input: FeatureRequest): Promise<T> => {
    calls.push(input)
    if (input.type === 'feature.request.cancel') return Promise.resolve({ kind: 'empty' } as T)
    return new Promise((resolve) => {
      deliver = () => resolve({ kind: 'billing.estimate', estimate: cachedEstimate('1') } as T)
    })
  }
  const subscribe = () => () => {}
  const label = (
    <BillingCost key="label" labelOnly request={request} subscribe={subscribe} sessionId="s" usageKey="one" />
  )
  const view = render(
    <>
      {label}
      <BillingCost
        key="detail"
        details
        request={request}
        subscribe={subscribe}
        sessionId="s"
        usageKey="one"
      />
    </>,
  )
  await act(() => vi.advanceTimersByTimeAsync(200))
  expect(calls.filter((call) => call.type === 'billing.estimate')).toHaveLength(1)
  view.rerender(<>{label}</>)
  await act(async () => {
    await Promise.resolve()
  })
  expect(calls.filter((call) => call.type === 'feature.request.cancel')).toHaveLength(0)
  await act(async () => {
    deliver?.()
    await Promise.resolve()
  })
  expect(screen.getByText('· ≈ USD 1')).toBeDefined()
})

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
