import { describe, expect, it, vi } from 'vitest'
import type { BillingUsageRepository, DshBackend } from '@dsh-vscode/domain'
import { billingEstimateResponseSchema, billingSettingsResponseSchema } from '@dsh-vscode/webview-protocol'
import { BillingFeatureHost } from './billing-feature-handler.js'
import type { BillingReferenceSource, BillingExchangeSource } from '@dsh-vscode/application'

function harness(
  source: BillingReferenceSource = {
    read: () => Promise.resolve({ status: 'missing', fetchedAt: '2026-10-24T00:00:00.000Z' }),
  },
  exchange?: BillingExchangeSource,
): {
  readonly host: BillingFeatureHost
  readonly readPage: ReturnType<typeof vi.fn<BillingUsageRepository['readBillingPage']>>
  readonly requireSession: ReturnType<typeof vi.fn>
  readonly changed: ReturnType<typeof vi.fn>
  readonly swapBackend: () => void
} {
  const readPage = vi
    .fn<BillingUsageRepository['readBillingPage']>()
    .mockResolvedValue({ facts: [], eventCount: 0, hasMore: false, contiguous: true })
  let backend = {
    connection: { ownership: 'external', endpoint: { baseUrl: 'https://fixture.invalid' } },
    sessions: { readBillingPage: readPage },
  } as unknown as DshBackend
  const values = new Map<string, unknown>()
  const requireSession = vi.fn().mockResolvedValue(undefined)
  const changed = vi.fn(() => Promise.resolve(true))
  const host = new BillingFeatureHost(
    {
      backendService: { requireBackend: () => backend },
      storage: {
        get: (key) => values.get(key),
        update: (key, value) => {
          values.set(key, value)
          return Promise.resolve()
        },
      },
      requireSession,
      changed,
      isTrusted: () => true,
    },
    source,
    exchange,
  )
  return {
    host,
    readPage,
    requireSession,
    changed,
    swapBackend: () => {
      backend = {
        ...backend,
        connection: {
          ...backend.connection,
          endpoint: { ...backend.connection.endpoint, baseUrl: 'https://other.invalid' },
        },
      }
    },
  }
}

describe('billing feature boundary', () => {
  it('keeps a user-selected reference in control even with automatic matching disabled', async () => {
    const read = vi.fn<BillingReferenceSource['read']>().mockResolvedValue({
      status: 'found',
      fetchedAt: '2026-10-24T00:00:00.000Z',
      price: { providerId: 'reference', modelId: 'chosen', currency: 'USD', input: '1', output: '2' },
    })
    const match = vi.fn<NonNullable<BillingReferenceSource['match']>>()
    const exchange = vi
      .fn<BillingExchangeSource['read']>()
      .mockResolvedValue({ usdCny: '7', date: '2026-10-23' })
    const { host, readPage } = harness({ read, match }, { read: exchange })
    const signal = new AbortController().signal
    const snapshot = billingSettingsResponseSchema.parse(
      await host.handle({ type: 'billing.settings.read', requestId: 'r', payload: {} }, signal),
    )
    await host.handle(
      {
        type: 'billing.settings.save',
        requestId: 's',
        payload: {
          scopeId: snapshot.scopeId,
          expectedRevision: 0,
          settings: {
            enabled: true,
            automatic: false,
            prices: [],
            mappings: [
              {
                providerId: 'work',
                modelId: 'alias',
                referenceProviderId: 'reference',
                referenceModelId: 'chosen',
              },
            ],
          },
        },
      },
      signal,
    )
    readPage.mockResolvedValue({
      eventCount: 1,
      contiguous: true,
      hasMore: false,
      fromSequence: 0,
      toSequence: 0,
      facts: [
        {
          kind: 'message',
          sequence: 0,
          route: { providerId: 'work', modelId: 'alias' },
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        },
      ],
    })
    const result = billingEstimateResponseSchema.parse(
      await host.handle(
        { type: 'billing.estimate', requestId: 'e', payload: { sessionId: 'owned', currency: 'CNY' } },
        signal,
      ),
    )
    expect(result.estimate).toMatchObject({
      pricedRequests: 1,
      totals: [{ currency: 'USD', amount: '0.000014' }],
      display: { currency: 'CNY', status: 'converted', totals: [{ currency: 'CNY', amount: '0.000098' }] },
    })
    expect(read).toHaveBeenCalledWith('reference', 'chosen', signal)
    expect(match).not.toHaveBeenCalled()
    expect(exchange).toHaveBeenCalledWith(signal)
  })

  it('searches the reference catalog and discards results from an obsolete connection', async () => {
    const search = vi.fn<NonNullable<BillingReferenceSource['search']>>().mockResolvedValue({
      entries: [{ providerId: 'reference', modelId: 'model', label: 'Model' }],
      fetchedAt: '2026-10-24T00:00:00.000Z',
      nextOffset: 1,
      hasMore: false,
    })
    const { host, swapBackend } = harness({
      read: () => Promise.resolve({ status: 'missing', fetchedAt: '2026-10-24T00:00:00.000Z' }),
      search,
    })
    const signal = new AbortController().signal
    const request = {
      type: 'billing.reference.search' as const,
      requestId: 'r',
      payload: { query: 'MODEL', offset: 0 },
    }
    await expect(host.handle(request, signal)).resolves.toMatchObject({
      kind: 'billing.references',
      entries: [{ modelId: 'model' }],
    })
    expect(search).toHaveBeenCalledWith('MODEL', 0, signal)
    search.mockImplementation(() => {
      swapBackend()
      return Promise.resolve({
        entries: [],
        fetchedAt: '2026-10-24T00:00:00.000Z',
        nextOffset: 0,
        hasMore: false,
      })
    })
    await expect(host.handle(request, signal)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
  })
  it('validates ownership before and after accounting, and strictly projects its response', async () => {
    const { host, requireSession } = harness()
    const signal = new AbortController().signal
    const snapshot = billingSettingsResponseSchema.parse(
      await host.handle({ type: 'billing.settings.read', requestId: 'read', payload: {} }, signal),
    )
    await host.handle(
      {
        type: 'billing.settings.save',
        requestId: 'save',
        payload: { scopeId: snapshot.scopeId, expectedRevision: 0, settings: { enabled: true, prices: [] } },
      },
      signal,
    )
    const result = billingEstimateResponseSchema.parse(
      await host.handle(
        { type: 'billing.estimate', requestId: 'estimate', payload: { sessionId: 'owned' } },
        signal,
      ),
    )
    expect(result.estimate).toMatchObject({ enabled: true, historyComplete: true, requests: 0 })
    requireSession.mockRejectedValue(new Error('not owned'))
    await expect(
      host.handle(
        { type: 'billing.estimate', requestId: 'foreign', payload: { sessionId: 'foreign' } },
        signal,
      ),
    ).rejects.toThrow('not owned')
  })
  it('rejects stale scopes and results when the backend changes', async () => {
    const { host, swapBackend, readPage } = harness()
    const signal = new AbortController().signal
    const snapshot = billingSettingsResponseSchema.parse(
      await host.handle({ type: 'billing.settings.read', requestId: 'read', payload: {} }, signal),
    )
    await host.handle(
      {
        type: 'billing.settings.save',
        requestId: 'save',
        payload: { scopeId: snapshot.scopeId, expectedRevision: 0, settings: { enabled: true, prices: [] } },
      },
      signal,
    )
    readPage.mockImplementation(() => {
      swapBackend()
      return Promise.resolve({ facts: [], eventCount: 0, hasMore: false, contiguous: true })
    })
    await expect(
      host.handle(
        { type: 'billing.estimate', requestId: 'estimate', payload: { sessionId: 'owned' } },
        signal,
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    await expect(
      host.handle(
        {
          type: 'billing.settings.save',
          requestId: 'stale',
          payload: {
            scopeId: snapshot.scopeId,
            expectedRevision: 0,
            settings: { enabled: true, prices: [] },
          },
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' })
  })
})
