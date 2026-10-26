// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { BillingPrice } from '@dsh-vscode/domain'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import { setActiveLocale } from '../../i18n.js'
import { BillingReferenceDetails } from './BillingPriceDetails.js'
import { BillingSettings } from './BillingSettings.js'
import type { BillingClient } from './billing-client.js'

beforeEach(() => {
  setActiveLocale('en')
  localStorage.clear()
  document.documentElement.lang = 'en'
})
afterEach(() => {
  cleanup()
  localStorage.clear()
  document.documentElement.lang = 'en'
})
function open(label: string): HTMLElement {
  const details = screen.getByText(label).closest('details')!
  act(() => {
    details.open = true
    fireEvent(details, new Event('toggle'))
  })
  return details
}
const price: BillingPrice = {
  providerId: 'vendor',
  modelId: 'reference-b',
  currency: 'USD',
  input: '1.25',
  output: '5',
  cacheRead: '0.1',
  multipliers: [{ when: { serviceTier: { equals: 'priority' } }, factor: '1.5' }],
  overrides: [{ when: { context: { gt: 512000 } }, rates: { input: '2.5' } }],
}

it('expands rates, cache prices and conditions without changing or fetching known prices', () => {
  const request: BillingClient = () => Promise.reject(new Error('Known prices must not be fetched'))
  render(
    <BillingReferenceDetails
      reference={{ providerId: 'vendor', modelId: 'reference-b', label: 'B' }}
      request={request}
      price={price}
    />,
  )
  expect(screen.queryByText('USD 1.25')).toBeNull()
  const details = within(open('Pricing details'))
  expect(details.getByText('USD 1.25')).toBeDefined()
  expect(details.getByText('USD 0.1')).toBeDefined()
  expect(details.getByText(/Service tier: priority/)).toBeDefined()
  expect(details.getByText(/512000/)).toBeDefined()
  expect(details.getAllByText('Not configured')).toHaveLength(2)
})

it('searches beyond automatic suggestions, previews a reference and saves the exact user selection', async () => {
  const calls: FeatureRequest[] = []
  const manual: BillingPrice = {
    providerId: 'work',
    modelId: 'local-alias',
    currency: 'USD',
    input: '9',
    output: '9',
  }
  let settings = {
    revision: 1,
    enabled: true,
    automatic: false,
    prices: [manual],
    mappings: [] as {
      providerId: string
      modelId: string
      referenceProviderId: string
      referenceModelId: string
    }[],
  }
  const chosen = { providerId: 'vendor', modelId: 'reference-b', label: 'Reference B', official: true }
  const request: BillingClient = <T,>(input: FeatureRequest): Promise<T> => {
    calls.push(input)
    let result: unknown
    if (input.type === 'billing.settings.read')
      result = { kind: 'billing.settings', scopeId: 'scope', settings }
    else if (input.type === 'billing.settings.save') {
      settings = {
        ...input.payload.settings,
        automatic: input.payload.settings.automatic !== false,
        mappings: [...(input.payload.settings.mappings ?? [])],
        prices: [...input.payload.settings.prices],
        revision: settings.revision + 1,
      }
      result = { kind: 'billing.settings', scopeId: 'scope', settings }
    } else if (input.type === 'billing.catalog.read')
      result = {
        kind: 'billing.catalog',
        scopeId: 'scope',
        revision: settings.revision,
        hasMore: false,
        nextOffset: 1,
        entries: [
          {
            providerId: 'work',
            modelId: 'local-alias',
            label: 'Local model',
            status: settings.prices.length ? 'manual' : 'automatic',
            price: settings.prices[0] ?? { ...price, providerId: 'work', modelId: 'local-alias' },
            candidates: [],
          },
        ],
      }
    else if (input.type === 'billing.reference.search')
      result = {
        kind: 'billing.references',
        fetchedAt: '2026-10-24T00:00:00.000Z',
        hasMore: false,
        nextOffset: 1,
        entries: input.payload.query ? [chosen] : [],
      }
    else if (input.type === 'billing.reference.read')
      result = { kind: 'billing.reference', status: 'found', fetchedAt: '2026-10-24T00:00:00.000Z', price }
    else result = { kind: 'empty' }
    return Promise.resolve(result as T)
  }
  render(<BillingSettings request={request} models={[]} />)
  open('Model billing')
  await screen.findByText('Local model')
  open('Choose another reference model')
  const search = screen.getByRole('region', { name: 'Reference models' })
  fireEvent.change(
    within(search).getByRole('textbox', { name: 'Search all providers and reference models' }),
    { target: { value: 'reference-b' } },
  )
  await waitFor(() =>
    expect(within(search).getByRole<HTMLButtonElement>('button', { name: 'Search' }).disabled).toBe(false),
  )
  fireEvent.click(within(search).getByRole('button', { name: 'Search' }))
  const item = (await within(search).findByText('Reference B')).closest('li')!
  const details = within(item).getByText('Pricing details').closest('details')!
  act(() => {
    details.open = true
    fireEvent(details, new Event('toggle'))
  })
  expect(await within(item).findByText('USD 1.25')).toBeDefined()
  fireEvent.click(within(item).getByRole('button', { name: 'Use vendor / reference-b prices' }))
  await waitFor(() =>
    expect(settings.mappings).toEqual([
      {
        providerId: 'work',
        modelId: 'local-alias',
        referenceProviderId: 'vendor',
        referenceModelId: 'reference-b',
      },
    ]),
  )
  expect(settings.prices).toEqual([])
  expect(settings.automatic).toBe(false)
  expect(
    calls.some((call) => call.type === 'billing.reference.search' && call.payload.query === 'reference-b'),
  ).toBe(true)
})

it('retries a failed price preview and never displays raw diagnostics', async () => {
  let attempts = 0
  const request: BillingClient = <T,>(input: FeatureRequest): Promise<T> => {
    if (input.type === 'feature.request.cancel') return Promise.resolve({ kind: 'empty' } as T)
    if (++attempts === 1) return Promise.reject(new Error('PRIVATE_REFERENCE_FAILURE'))
    return Promise.resolve({
      kind: 'billing.reference',
      status: 'found',
      fetchedAt: '2026-10-24T00:00:00.000Z',
      price,
    } as T)
  }
  render(
    <BillingReferenceDetails
      reference={{ providerId: 'vendor', modelId: 'reference-b', label: 'B' }}
      request={request}
    />,
  )
  open('Pricing details')
  fireEvent.click(await screen.findByRole('button', { name: 'Retry reference prices' }))
  expect(await screen.findByText('USD 1.25')).toBeDefined()
  expect(document.body.textContent).not.toContain('PRIVATE_REFERENCE_FAILURE')
})
