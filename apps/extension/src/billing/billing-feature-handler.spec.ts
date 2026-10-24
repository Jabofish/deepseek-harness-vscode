import { describe, expect, it, vi } from 'vitest'
import type { BillingUsageRepository, DshBackend } from '@dsh-vscode/domain'
import { billingEstimateResponseSchema, billingSettingsResponseSchema } from '@dsh-vscode/webview-protocol'
import { BillingFeatureHost } from './billing-feature-handler.js'

function harness(): {
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
    { read: () => Promise.resolve({ status: 'missing', fetchedAt: '2026-10-24T00:00:00.000Z' }) },
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
  it('validates ownership before and after accounting, and strictly projects its response', async () => {
    const { host, requireSession, changed } = harness()
    const signal = new AbortController().signal
    const snapshot = billingSettingsResponseSchema.parse(
      await host.handle({ type: 'billing.settings.read', requestId: 'read', payload: {} }, signal),
    )
    expect(changed).not.toHaveBeenCalled()
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
    expect(changed).toHaveBeenCalledTimes(1)
    expect(requireSession).toHaveBeenCalledTimes(2)
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
