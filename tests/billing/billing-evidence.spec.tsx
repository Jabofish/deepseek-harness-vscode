import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { transferableAbortController } from 'node:util'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BillingPrice, DshBackend, TokenUsage } from '../../packages/domain/src/index.js'
import { billingCurrencyDisplay } from '../../packages/domain/src/index.js'
import type { DshTransport } from '../../packages/dsh-adapter/src/contracts.js'
import { Rc213SessionRepository } from '../../packages/dsh-adapter/src/versions/rc213/session-repository.js'
import { Rc6ModelRepository } from '../../packages/dsh-adapter/src/repositories/model-repository.js'
import { Rc6WorkspaceRepository } from '../../packages/dsh-adapter/src/repositories/workspace-repository.js'
import {
  BillingFeatureHost,
  type BillingRequest,
} from '../../apps/extension/src/billing/billing-feature-handler.js'
import {
  ModelsDevPriceSource,
  readModelsDevPrice,
} from '../../apps/extension/src/billing/models-dev-price-source.js'
import { WebviewMessageRouter } from '../../apps/extension/src/view/message-router.js'
import { ProtocolClient } from '../../apps/webview/src/app/protocol-client.js'
import { BillingCost, formatBillingAmount } from '../../apps/webview/src/features/billing/BillingCost.js'
import { BillingSettings } from '../../apps/webview/src/features/billing/BillingSettings.js'
import { StatsLine } from '../../apps/webview/src/features/chat/StatsLine.js'
import { setActiveLocale } from '../../apps/webview/src/i18n.js'
import {
  billingCatalogResponseSchema,
  billingEstimateResponseSchema,
  billingSettingsResponseSchema,
} from '../../packages/webview-protocol/src/index.js'

// Invented canonical records from the pinned rc213 contract. The DSH/provider
// edges are synthetic; all accounting, Host, protocol and UI code is real.
type RecordRow = {
  event: { seq: number; type: string; time: number; data: unknown; surfaceOp?: { op: 'replace' } }
}
type Trace = {
  name: string
  rows: RecordRow[]
  prices: BillingPrice[]
  totals: Record<string, string>
  requests: number
  priced: number
  partial?: number
  complete?: boolean
  pageSize?: number
}
const route = { providerId: 'synthetic', modelId: 'model-a' }
const base: BillingPrice = { ...route, currency: 'USD', input: '1', output: '2' }
const row = (seq: number, type: string, data: unknown): RecordRow => ({
  event: { seq, type, time: seq, data },
})
const header = (seq: number, modelId = route.modelId): RecordRow =>
  row(seq, 'request/header', { header: { config: { provider: route.providerId, model: modelId } } })
const message = (seq: number, usage: TokenUsage, modelId = route.modelId, extra = {}): RecordRow =>
  row(seq, 'assistant/message', {
    turn: 1,
    step: 1,
    message: {
      source: { kind: 'model', provider: route.providerId, model: modelId },
      content: [{ type: 'text', text: 'synthetic output' }],
    },
    usage,
    ...extra,
  })
const sample = (usage: TokenUsage): unknown => ({ type: 'chunk', chunk: { type: 'usage', usage } })
const attempt = (seq: number, samples: TokenUsage[]): RecordRow =>
  row(seq, 'assistant/attempt', { turn: 1, step: 1, stream: samples.map(sample) })
const plain: TokenUsage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
const mixed: TokenUsage = {
  inputTokens: 1200,
  outputTokens: 400,
  cacheReadTokens: 800,
  cacheWriteTokens: 100,
}
const mixedPrice: BillingPrice = { ...base, input: '2', output: '10', cacheRead: '0.2', cacheWrite: '2.5' }
const traces: Trace[] = [
  {
    name: 'plain',
    rows: [header(0), message(1, plain)],
    prices: [base],
    totals: { USD: '0.000014' },
    requests: 1,
    priced: 1,
  },
  {
    name: 'cache-buckets',
    rows: [header(0), message(1, mixed)],
    prices: [mixedPrice],
    totals: { USD: '0.00681' },
    requests: 1,
    priced: 1,
  },
  {
    name: 'retries-same-step',
    rows: [
      header(0),
      attempt(1, [{ ...plain, outputTokens: 1, totalTokens: 11 }, plain]),
      attempt(2, [{ inputTokens: 20, outputTokens: 3, totalTokens: 23 }]),
      message(3, { inputTokens: 100, outputTokens: 10, totalTokens: 110 }),
    ],
    prices: [base],
    totals: { USD: '0.00016' },
    requests: 3,
    priced: 3,
    pageSize: 2,
  },
  {
    name: 'actual-model-overrides-selection',
    rows: [
      header(0),
      message(1, plain),
      header(2, 'model-b'),
      attempt(3, [{ inputTokens: 20, outputTokens: 3, totalTokens: 23 }]),
      message(4, { inputTokens: 100, outputTokens: 10, totalTokens: 110 }),
    ],
    prices: [base, { ...base, modelId: 'model-b', input: '3', output: '4' }],
    totals: { USD: '0.000206' },
    requests: 3,
    priced: 3,
    pageSize: 2,
  },
  {
    name: 'reasoning-subset',
    rows: [header(0), message(1, { ...mixed, reasoningTokens: 60 })],
    prices: [{ ...mixedPrice, reasoning: '15' }],
    totals: { USD: '0.00711' },
    requests: 1,
    priced: 1,
  },
  {
    name: 'currencies-separated',
    rows: [
      header(0),
      message(1, plain),
      message(2, { inputTokens: 20, outputTokens: 3, totalTokens: 23 }, 'model-b'),
    ],
    prices: [base, { ...base, modelId: 'model-b', currency: 'CNY', input: '3', output: '4' }],
    totals: { USD: '0.000014', CNY: '0.000072' },
    requests: 2,
    priced: 2,
  },
  {
    name: 'cancel-without-usage',
    rows: [header(0), attempt(1, []), message(2, plain)],
    prices: [base],
    totals: { USD: '0.000014' },
    requests: 2,
    priced: 1,
  },
  {
    name: 'unknown-cache-split',
    rows: [header(0), message(1, { inputTokens: 10, outputTokens: 2, totalTokens: 22 })],
    prices: [base],
    totals: { USD: '0.000014' },
    requests: 1,
    priced: 0,
    partial: 1,
  },
  {
    name: 'invalid-usage-not-zero',
    rows: [header(0), message(1, { inputTokens: 1.5, outputTokens: 2 })],
    prices: [base],
    totals: {},
    requests: 1,
    priced: 0,
  },
  {
    name: 'explicit-free',
    rows: [header(0), message(1, plain)],
    prices: [{ ...base, input: '0', output: '0' }],
    totals: { USD: '0' },
    requests: 1,
    priced: 1,
  },
  {
    name: 'interrupted-settlement',
    rows: [header(0), message(1, plain, route.modelId, { interrupted: true })],
    prices: [base],
    totals: { USD: '0.000014' },
    requests: 1,
    priced: 1,
  },
  {
    name: 'replacement-copy',
    rows: [
      header(0),
      message(1, plain),
      { event: { ...message(2, plain).event, surfaceOp: { op: 'replace' } } },
    ],
    prices: [base],
    totals: { USD: '0.000014' },
    requests: 1,
    priced: 1,
  },
  {
    name: '1000-tiny-requests',
    rows: [
      header(0),
      ...Array.from({ length: 1000 }, (_, index) =>
        message(index + 1, { inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
      ),
    ],
    prices: [{ ...base, input: '0.003' }],
    totals: { USD: '0.000003' },
    requests: 1000,
    priced: 1000,
    pageSize: 101,
  },
  {
    name: 'bounded-history',
    rows: [header(0), ...Array.from({ length: 30 }, (_, index) => message(index + 1, plain))],
    prices: [base],
    totals: { USD: '0.00028' },
    requests: 20,
    priced: 20,
    complete: false,
    pageSize: 1,
  },
]

const sessions = new Map<string, { rows: RecordRow[]; pageSize: number }>()
let modelGroups: { id: string; name: string; models: { id: string; name: string }[] }[] = []
const rpcCalls: { sessionId: string; beforeSeq?: number }[] = []
const server = createServer((request, response) => {
  void (async () => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    const input = JSON.parse(body) as { method: string; params: { sessionId: string; beforeSeq?: number } }
    response.setHeader('content-type', 'application/json')
    if (input.method === 'llm.models') {
      response.end(JSON.stringify({ result: { ok: true, value: { groups: modelGroups, failures: [] } } }))
      return
    }
    const trace = sessions.get(input.params.sessionId)
    if (input.method !== 'session.history' || trace === undefined) throw new Error('Unexpected synthetic RPC')
    rpcCalls.push(input.params)
    const available = trace.rows.filter(
      (entry) => input.params.beforeSeq === undefined || entry.event.seq < input.params.beforeSeq,
    )
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        result: {
          ok: true,
          value: { events: available.slice(-trace.pageSize), hasMore: available.length > trace.pageSize },
        },
      }),
    )
  })().catch(() => {
    response.statusCode = 500
    response.end()
  })
})
let endpoint = ''
const evidence = resolve('artifacts/model-billing-research/e2e')
const reports: unknown[] = []
beforeAll(async () => {
  // The Host is normally a separate Node realm. Preserve that realm's signals
  // while mounting the real Webview components in jsdom for this joined test.
  const controller = transferableAbortController()
  vi.stubGlobal('AbortController', controller.constructor)
  vi.stubGlobal('AbortSignal', controller.signal.constructor)
  setActiveLocale('en')
  await mkdir(evidence, { recursive: true })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing fixture port')
  endpoint = `http://127.0.0.1:${address.port}`
})
afterEach(cleanup)
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())))
  await writeFile(
    resolve(evidence, 'trajectories.json'),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        boundary:
          'Synthetic DSH HTTP RPC -> real Adapter/Host/router/protocol -> real session statistics DOM; not a paid provider invoice.',
        reports,
      },
      null,
      2,
    ),
  )
  vi.unstubAllGlobals()
})

function connect(
  sessionId: string,
  rows: RecordRow[],
  pageSize = 500,
  source = new ModelsDevPriceSource(),
): {
  client: ProtocolClient
  dispose: () => void
} {
  sessions.set(sessionId, { rows, pageSize })
  const transport: DshTransport = {
    request: async <T,>(method: string, params: unknown, signal?: AbortSignal): Promise<T> => {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ method, params }),
        ...(signal === undefined ? {} : { signal }),
      })
      return (await response.json()) as T
    },
    remoteRequest: (): never => {
      throw new Error('Unexpected Remote call')
    },
    async *openEventStream() {
      /* no transcript stream is used by accounting */
    },
    close: () => Promise.resolve(),
  }
  const repository = new Rc213SessionRepository(
    transport,
    new Rc6WorkspaceRepository(transport),
    undefined,
    {},
  )
  const backend = {
    connection: { ownership: 'external', endpoint: { baseUrl: endpoint } },
    sessions: repository,
    models: new Rc6ModelRepository(transport),
  } as unknown as DshBackend
  const values = new Map<string, unknown>()
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
      isTrusted: () => true,
      requireSession: (id) => (id === sessionId ? Promise.resolve() : Promise.reject(new Error('Not owned'))),
    },
    source,
    { read: () => Promise.resolve({ usdCny: '7', date: '2026-10-23' }) },
  )
  const router = new WebviewMessageRouter({
    postMessage: (message) => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.parse(JSON.stringify({ protocolVersion: 1, message })) as unknown,
        }),
      )
      return Promise.resolve(true)
    },
    handleFeatureRequest: (request, signal) => host.handle(request as BillingRequest, signal),
  })
  const client = new ProtocolClient({
    postMessage: (envelope) => {
      void router.handle(envelope, 'billing-evidence')
    },
    getState: () => undefined,
    setState: () => undefined,
  })
  return {
    client,
    dispose: () => {
      client.dispose()
      router.cancelAll()
      sessions.delete(sessionId)
    },
  }
}

let nextId = 0
async function configure(client: ProtocolClient, prices: BillingPrice[]): Promise<void> {
  const snapshot = billingSettingsResponseSchema.parse(
    await client.featureRequest({
      type: 'billing.settings.read',
      requestId: `settings-${++nextId}`,
      payload: {},
    }),
  )
  await client.featureRequest({
    type: 'billing.settings.save',
    requestId: `save-${++nextId}`,
    payload: {
      scopeId: snapshot.scopeId,
      expectedRevision: snapshot.settings.revision,
      settings: { enabled: true, prices },
    },
  })
}

async function verify(
  trace: Trace,
  source?: ModelsDevPriceSource,
  setup?: (client: ProtocolClient) => Promise<void>,
): Promise<void> {
  const started = performance.now()
  const connection = connect(trace.name, trace.rows, trace.pageSize, source)
  try {
    if (setup === undefined) await configure(connection.client, trace.prices)
    else await setup(connection.client)
    const result = billingEstimateResponseSchema.parse(
      await connection.client.featureRequest({
        type: 'billing.estimate',
        requestId: `estimate-${++nextId}`,
        payload: { sessionId: trace.name },
      }),
    ).estimate
    const actual = Object.fromEntries(result.totals.map((total) => [total.currency, total.amount]))
    expect(actual).toEqual(trace.totals)
    expect([result.requests, result.pricedRequests, result.partialRequests, result.historyComplete]).toEqual([
      trace.requests,
      trace.priced,
      trace.partial ?? 0,
      trace.complete ?? true,
    ])
    const client = connection.client
    render(
      <StatsLine
        nodes={[]}
        cacheHit={0}
        usage={plain}
        cost={(details) => (
          <BillingCost
            details={details}
            request={(request) => client.featureRequest(request)}
            subscribe={(listener) => client.subscribeFeature(listener)}
            sessionId={trace.name}
            usageKey="settled"
          />
        )}
      />,
    )
    const display = billingCurrencyDisplay(result, 'USD', { usdCny: '7', date: '2026-10-23' })
    const label =
      display.totals.length === 0
        ? 'Cost unpriced'
        : `Cost ≈ ${display.totals.map((total) => `${total.currency} ${formatBillingAmount(total.amount)}`).join(' / ')}${result.pricedRequests !== result.requests || !result.historyComplete ? ' · Partial' : ''}`
    await screen.findByText(label)
    expect(document.body.textContent).not.toContain('×')
    fireEvent.click(screen.getByText(label).closest('button')!)
    const costDetails = within(screen.getByRole('dialog'))
    expect(costDetails.getByText('Pricing details')).toBeDefined()
    expect(costDetails.queryByText('Priced requests')).toBeNull()
    if (result.issueCounts.some((issue) => issue.issue === 'missing-usage'))
      expect(costDetails.getByText(/Token usage was not returned/)).toBeDefined()
    for (const group of display.breakdown)
      expect(
        costDetails.getAllByText(`${group.currency} ${formatBillingAmount(group.amount)}`, { selector: 'dd' })
          .length,
      ).toBeGreaterThan(0)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    reports.push({
      name: trace.name,
      rawRecords: trace.rows.length,
      expected: trace.totals,
      actual,
      historyComplete: result.historyComplete,
      requests: result.requests,
      priced: result.pricedRequests,
      partial: result.partialRequests,
      unpriced: result.unpricedRequests,
      displayed: label,
      rpcReads: rpcCalls.filter((call) => call.sessionId === trace.name).length,
      elapsedMs: Math.round(performance.now() - started),
      passed: true,
    })
  } finally {
    cleanup()
    connection.dispose()
  }
}

describe('synthetic billing RPC-to-session evidence', () => {
  it.each(traces)('$name', async (trace) => verify(trace))
})

it('discovers DSH models over HTTP, prices automatically, preserves an override and restores the updated reference', async () => {
  let inputRate = 1
  const fetcher = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          synthetic: {
            name: 'Synthetic',
            models: {
              'model-a': {
                name: 'Model A',
                cost: { text: { input: { price: inputRate }, output: { price: 2 } } },
              },
            },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    ),
  )
  const source = new ModelsDevPriceSource(fetcher)
  modelGroups = [{ id: 'synthetic', name: 'Synthetic', models: [{ id: 'model-a', name: 'Model A' }] }]
  const connection = connect('automatic-lifecycle', [header(0), message(1, plain)], 500, source)
  const estimate = async (): Promise<string | undefined> =>
    billingEstimateResponseSchema.parse(
      await connection.client.featureRequest({
        type: 'billing.estimate',
        requestId: `auto-${++nextId}`,
        payload: { sessionId: 'automatic-lifecycle' },
      }),
    ).estimate.totals[0]?.amount
  try {
    await configure(connection.client, [])
    render(<BillingSettings request={(request) => connection.client.featureRequest(request)} models={[]} />)
    const details = screen.getByText('Model billing').closest('details')!
    act(() => {
      details.open = true
      fireEvent(details, new Event('toggle'))
    })
    await screen.findByText('Automatic reference')
    expect(await estimate()).toBe('0.000014')
    const list = screen.getByRole('region', { name: 'Detected models' })
    fireEvent.click(within(list).getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Uncached input'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: "Save this model's prices" }))
    await screen.findByText('Custom prices')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Find a provider or model' }))
    expect(await estimate()).toBe('0.000034')
    inputRate = 9
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 25 * 60 * 60 * 1000)
    expect(await estimate()).toBe('0.000034')
    fireEvent.click(screen.getByRole('button', { name: 'Restore automatic matching' }))
    await screen.findByText('Automatic reference')
    expect(await estimate()).toBe('0.000094')
    expect(fetcher).toHaveBeenCalledTimes(2)
    reports.push({
      name: 'automatic-override-restore',
      expected: ['0.000014', '0.000034', '0.000034', '0.000094'],
      passed: true,
      boundary: 'Synthetic DSH model/history HTTP; actual Settings form, Host store and matching.',
    })
  } finally {
    vi.restoreAllMocks()
    cleanup()
    connection.dispose()
    modelGroups = []
  }
})

it('requires confirmation for a custom reseller and enumerates large catalogs with search and paging', async () => {
  const source = new ModelsDevPriceSource(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          synthetic: {
            name: 'Synthetic',
            models: {
              'model-a': { name: 'Model A', cost: { text: { input: { price: 1 }, output: { price: 2 } } } },
            },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    ),
  )
  modelGroups = [
    {
      id: 'my-proxy',
      name: 'My Proxy',
      models: [
        { id: 'model-a', name: 'Model A' },
        ...Array.from({ length: 60 }, (_, i) => ({
          id: `unlisted-${String(i).padStart(2, '0')}`,
          name: `Unlisted ${i}`,
        })),
      ],
    },
  ]
  const rows = [
    row(0, 'request/header', { header: { config: { provider: 'my-proxy', model: 'model-a' } } }),
    row(1, 'assistant/message', {
      message: { source: { provider: 'my-proxy', model: 'model-a' } },
      usage: plain,
    }),
  ]
  const connection = connect('reseller', rows, 500, source)
  const catalog = async (
    offset = 0,
    query = '',
  ): Promise<ReturnType<typeof billingCatalogResponseSchema.parse>> =>
    billingCatalogResponseSchema.parse(
      await connection.client.featureRequest({
        type: 'billing.catalog.read',
        requestId: `catalog-${++nextId}`,
        payload: { offset, query },
      }),
    )
  try {
    await configure(connection.client, [])
    const first = await catalog()
    expect(first.entries).toHaveLength(50)
    expect(first.hasMore).toBe(true)
    expect((await catalog(first.nextOffset)).entries).toHaveLength(11)
    expect((await catalog(0, 'model-a')).entries).toMatchObject([
      { status: 'ambiguous', candidates: [{ providerId: 'synthetic', modelId: 'model-a' }] },
    ])
    render(<BillingSettings request={(request) => connection.client.featureRequest(request)} models={[]} />)
    const details = screen.getByText('Model billing').closest('details')!
    act(() => {
      details.open = true
      fireEvent(details, new Event('toggle'))
    })
    const modelRow = (await screen.findByRole('button', { name: 'Use synthetic / model-a prices' })).closest(
      'li',
    )!
    const picker = within(modelRow).getByText('Choose another reference model').closest('details')!
    act(() => {
      picker.open = true
      fireEvent(picker, new Event('toggle'))
    })
    const search = within(modelRow).getByRole('region', { name: 'Reference models' })
    fireEvent.change(within(search).getByRole('textbox'), { target: { value: 'SYNTHETIC MODEL_A' } })
    await waitFor(() =>
      expect(within(search).getByRole<HTMLButtonElement>('button', { name: 'Search' }).disabled).toBe(false),
    )
    fireEvent.click(within(search).getByRole('button', { name: 'Search' }))
    const choice = (
      await within(search).findByRole('button', { name: 'Use synthetic / model-a prices' })
    ).closest('li')!
    const pricing = within(choice).getByText('Pricing details').closest('details')!
    act(() => {
      pricing.open = true
      fireEvent(pricing, new Event('toggle'))
    })
    expect(await within(choice).findByText('USD 1')).toBeDefined()
    fireEvent.click(within(choice).getByRole('button', { name: 'Use synthetic / model-a prices' }))
    await screen.findByText('Automatic reference')
    const result = billingEstimateResponseSchema.parse(
      await connection.client.featureRequest({
        type: 'billing.estimate',
        requestId: `mapped-${++nextId}`,
        payload: { sessionId: 'reseller' },
      }),
    )
    expect(result.estimate.totals).toEqual([{ currency: 'USD', amount: '0.000014' }])
    reports.push({
      name: 'confirmed-reseller-mapping',
      expected: { USD: '0.000014' },
      actual: result.estimate.totals,
      passed: true,
      catalogRows: 61,
    })
  } finally {
    cleanup()
    connection.dispose()
    modelGroups = []
  }
})

it.skipIf(process.env.DSH_BILLING_LIVE_PRICES !== '1')(
  'matches official screenshot routes against the live catalog and expands their pricing in the UI',
  async () => {
    const source = new ModelsDevPriceSource()
    const signal = new AbortController().signal
    for (const providerId of ['deepseek', 'deepseek-official', 'deepseek-account']) {
      for (const modelId of [
        'deepseek-flash',
        'deepseek/deepseek-v4.1-flash-1017',
        'DEEPSEEK/DEEPSEEK-V4.1-FLASH-1017',
      ]) {
        const result = await source.match({ providerId, modelId }, signal)
        expect(result).toMatchObject({
          status: 'found',
          reference: { providerId: 'deepseek', official: true },
        })
        expect(result.price?.input).toBeDefined()
      }
    }
    const minimax = await source.match({ providerId: 'minimax-cn', modelId: 'minimax-m3' }, signal)
    expect(minimax.status).toBe('found')
    expect(minimax.price?.multipliers).toContainEqual({
      when: { serviceTier: { equals: 'priority' } },
      factor: '1.5',
    })
    const references = await source.search('DeepSeek V4.1', 0, signal)
    expect(references.entries[0]).toMatchObject({ providerId: 'deepseek', official: true })
    modelGroups = [
      {
        id: 'deepseek-account',
        name: 'DeepSeek Account',
        models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }],
      },
      { id: 'minimax-cn', name: 'MiniMax CN', models: [{ id: 'minimax-m3', name: 'MiniMax-M3' }] },
    ]
    const connection = connect('official-pricing-ui', [], 500, source)
    try {
      await configure(connection.client, [])
      render(<BillingSettings request={(request) => connection.client.featureRequest(request)} models={[]} />)
      const panel = screen.getByText('Model billing').closest('details')!
      act(() => {
        panel.open = true
        fireEvent(panel, new Event('toggle'))
      })
      const row = (await screen.findByText('MiniMax-M3')).closest('li')!
      const details = within(row).getByText('Pricing details').closest('details')!
      act(() => {
        details.open = true
        fireEvent(details, new Event('toggle'))
      })
      expect(await within(details).findByText(/Service tier: priority/)).toBeDefined()
      expect(screen.queryByText('Unsupported pricing conditions')).toBeNull()
      expect(screen.getAllByText('Official reference')).toHaveLength(2)
      reports.push({
        name: 'live-official-aliases-and-price-details',
        passed: true,
        boundary:
          'Live public models.dev catalog; synthetic DSH model directory and actual Host/protocol/UI. No provider invoice.',
      })
    } finally {
      cleanup()
      connection.dispose()
      modelGroups = []
    }
  },
)

it.skipIf(process.env.DSH_BILLING_LIVE_PRICES !== '1')(
  'reads the real models.dev catalog, saves a reference price and prices a synthetic session in the DOM',
  async () => {
    const started = performance.now()
    let raw: Promise<string> | undefined
    let status = 0
    let url = ''
    let calls = 0
    const source = new ModelsDevPriceSource(async (input, init) => {
      calls += 1
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const response = await fetch(input, init)
      status = response.status
      raw = response.clone().text()
      return response
    })
    await source.read('__billing_probe__', '__missing__', new AbortController().signal)
    expect(status).toBe(200)
    const text = await raw!
    const catalog = JSON.parse(text) as Record<string, { models: Record<string, { cost?: unknown }> }>
    let selected: BillingPrice | undefined
    let conditional: { providerId: string; modelId: string } | undefined
    for (const [providerId, provider] of Object.entries(catalog))
      for (const modelId of Object.keys(provider.models)) {
        const value = readModelsDevPrice(catalog, providerId, modelId, new Date().toISOString())
        if (
          selected === undefined &&
          value.price !== undefined &&
          !value.price.multipliers?.length &&
          !value.price.overrides?.length &&
          (Number(value.price.input) > 0 || Number(value.price.output) > 0)
        )
          selected = value.price
        if (conditional === undefined && value.status === 'unsupported') conditional = { providerId, modelId }
        if (selected !== undefined && conditional !== undefined) break
      }
    expect(selected).toBeDefined()
    const price = selected!
    // At one million tokens in each category, the independent oracle is just
    // input price + output price, with integer decimal alignment (no billing code).
    const scale = 1_000_000_000n
    const integerRate = (value: string): bigint => {
      const [whole = '0', fraction = ''] = value.split('.')
      return BigInt(whole) * scale + BigInt(fraction.padEnd(9, '0'))
    }
    const sum = integerRate(price.input) + integerRate(price.output)
    const fraction = (sum % scale).toString().padStart(9, '0').replace(/0+$/, '')
    const expected = `${sum / scale}${fraction === '' ? '' : `.${fraction}`}`
    const sessionId = 'live-reference'
    const rawRoute = { provider: price.providerId, model: price.modelId }
    const rows = [
      row(0, 'request/header', { header: { config: rawRoute } }),
      row(1, 'assistant/message', {
        message: { source: { kind: 'model', ...rawRoute } },
        usage: {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          totalTokens: 2_000_000,
          reasoningTokens: 0,
        },
      }),
    ]
    if (conditional !== undefined)
      expect(
        (await source.read(conditional.providerId, conditional.modelId, new AbortController().signal)).status,
      ).toBe('unsupported')
    await verify(
      { name: sessionId, rows, prices: [price], totals: { USD: expected }, requests: 1, priced: 1 },
      source,
      async (client) => {
        render(<BillingSettings request={(request) => client.featureRequest(request)} models={[]} />)
        const open = (label: string): void => {
          const details = screen.getByText(label).closest('details')!
          act(() => {
            details.open = true
            fireEvent(details, new Event('toggle'))
          })
        }
        open('Model billing')
        await waitFor(() =>
          expect(
            screen.getByRole('checkbox', { name: 'Enable cost estimates' }).closest('fieldset')?.disabled,
          ).toBe(false),
        )
        fireEvent.click(screen.getByRole('button', { name: 'Add price' }))
        fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: price.providerId } })
        fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: price.modelId } })
        fireEvent.click(screen.getByRole('checkbox', { name: 'Enable cost estimates' }))
        open('models.dev reference prices (USD)')
        fireEvent.change(screen.getByLabelText('Reference provider ID'), {
          target: { value: price.providerId },
        })
        fireEvent.change(screen.getByLabelText('Reference model ID'), { target: { value: price.modelId } })
        fireEvent.click(screen.getByRole('button', { name: 'Read reference prices' }))
        await screen.findByText(/Prices filled into the form/)
        expect(screen.getByLabelText<HTMLInputElement>('Uncached input').value).toBe(price.input)
        expect(screen.getByLabelText<HTMLInputElement>('Output').value).toBe(price.output)
        fireEvent.click(screen.getByRole('button', { name: "Save this model's prices" }))
        await screen.findByText('Custom prices')
        const saved = billingSettingsResponseSchema.parse(
          await client.featureRequest({
            type: 'billing.settings.read',
            requestId: `verify-saved-${++nextId}`,
            payload: {},
          }),
        )
        expect(saved.settings).toMatchObject({ enabled: true, prices: [price] })
        cleanup()
      },
    )
    const flatReport = reports.at(-1)
    const scheduledStart = reports.length
    for (const [name, date, amount] of [
      ['weekday-peak', '2026-10-22T02:00:00Z', '5.28'],
      ['weekend-offpeak', '2026-10-24T02:00:00Z', '2.64'],
      ['holiday-offpeak', '2026-10-01T02:00:00Z', '2.64'],
    ] as const) {
      const time = Date.parse(date)
      const usage = {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
        reasoningTokens: 0,
      }
      const sourceRoute = { provider: 'deepseek', model: 'deepseek-v4-pro' }
      await verify(
        {
          name: `live-deepseek-${name}`,
          rows: [
            row(0, 'request/header', { header: { config: sourceRoute } }),
            {
              event: {
                seq: 1,
                type: 'assistant/message',
                time: time + 1000,
                data: {
                  message: { source: sourceRoute },
                  usage,
                  stream: [{ type: 'chunk', time, chunk: { type: 'usage', usage } }],
                },
              },
            },
          ],
          prices: [],
          totals: { USD: amount },
          requests: 1,
          priced: 1,
        },
        source,
      )
    }
    expect(calls).toBe(1)
    await writeFile(
      resolve(evidence, 'models-dev-live.json'),
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          url,
          status,
          bytes: Buffer.byteLength(text),
          sha256: createHash('sha256').update(text).digest('hex'),
          providerCount: Object.keys(catalog).length,
          selected: price,
          rawSelected: catalog[price.providerId]?.models[price.modelId],
          expected,
          actual: flatReport,
          scheduledReports: reports.slice(scheduledStart),
          conditionalRejected: conditional,
          formFilledAndSaved: true,
          networkRequests: calls,
          elapsedMs: Math.round(performance.now() - started),
          boundary: 'Live public catalog; synthetic DSH session. No paid inference or provider invoice.',
        },
        null,
        2,
      ),
    )
  },
  30_000,
)
