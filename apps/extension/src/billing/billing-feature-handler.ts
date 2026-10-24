import { createHash } from 'node:crypto'
import { AppError } from '@dsh-vscode/domain'
import {
  BillingUseCases,
  type BackendService,
  type BillingReferenceSource,
  type BillingExchangeSource,
} from '@dsh-vscode/application'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import { BillingSettingsStore, type BillingStateStorage } from './billing-settings-store.js'
import { BillingCatalog } from './billing-catalog.js'

export type BillingRequest = Extract<FeatureRequest, { readonly type: `billing.${string}` }>
export interface BillingHostDependencies {
  readonly changed?: () => Promise<unknown>
  readonly storage: BillingStateStorage
  readonly backendService: Pick<BackendService, 'requireBackend'>
  readonly requireSession: (sessionId: string, signal: AbortSignal) => Promise<unknown>
  readonly isTrusted: () => boolean
}

/** One optional feature boundary. Chat/control services do not depend on billing. */
export class BillingFeatureHost {
  private readonly store: BillingSettingsStore
  public constructor(
    private readonly deps: BillingHostDependencies,
    private readonly source: BillingReferenceSource,
    private readonly exchange?: BillingExchangeSource,
  ) {
    this.store = new BillingSettingsStore(deps.storage)
  }

  public async handle(request: BillingRequest, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const backend = this.deps.backendService.requireBackend()
    const scopeId = createHash('sha256')
      .update(
        backend.connection.ownership === 'managed'
          ? 'managed'
          : new URL(backend.connection.endpoint.baseUrl).origin,
      )
      .digest('hex')
    const assertCurrent = (): void => {
      signal.throwIfAborted()
      if (this.deps.backendService.requireBackend() !== backend)
        throw new AppError({
          code: 'REQUEST_CANCELLED',
          message: 'The billing connection changed.',
          retryable: false,
        })
    }
    const store = this.store.scope(scopeId, signal)
    if (request.type === 'billing.settings.read') {
      const settings = await store.read()
      assertCurrent()
      return { kind: 'billing.settings', scopeId, settings }
    }
    if (!this.deps.isTrusted())
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'Trust the workspace before configuring or reading model accounting.',
        retryable: false,
      })
    if (request.type === 'billing.settings.save') {
      if (request.payload.scopeId !== scopeId)
        throw new AppError({
          code: 'SETTINGS_CONFLICT',
          message: 'The billing configuration belongs to another connection. Reload it first.',
          retryable: true,
        })
      const settings = await store.save(request.payload.settings, request.payload.expectedRevision)
      assertCurrent()
      await this.deps.changed?.().catch(() => undefined)
      return { kind: 'billing.settings', scopeId, settings }
    }
    if (request.type === 'billing.reference.read') {
      const result = await this.source.read(request.payload.providerId, request.payload.modelId, signal)
      assertCurrent()
      return { kind: 'billing.reference', ...result }
    }
    if (request.type === 'billing.reference.search') {
      if (this.source.search === undefined)
        throw new AppError({
          code: 'FEATURE_DISABLED',
          message: 'Reference model search is unavailable.',
          retryable: false,
        })
      const result = await this.source.search(request.payload.query, request.payload.offset ?? 0, signal)
      assertCurrent()
      return { kind: 'billing.references', ...result }
    }
    const settings = await store.read()
    assertCurrent()
    const catalog = new BillingCatalog(this.source, settings, assertCurrent)
    if (request.type === 'billing.catalog.read') {
      const models = await backend.models.listModels(undefined, signal)
      assertCurrent()
      const query = request.payload.query?.trim().toLowerCase() ?? ''
      const routes = catalog
        .routes(models)
        .filter((route) =>
          `${route.providerId} ${route.modelId} ${route.label}`.toLowerCase().includes(query),
        )
      const offset = request.payload.offset ?? 0
      const entries = []
      for (const route of routes.slice(offset, offset + 50))
        entries.push(await catalog.entry(route, signal, route.label))
      assertCurrent()
      return {
        kind: 'billing.catalog',
        scopeId,
        revision: settings.revision,
        entries,
        hasMore: routes.length > offset + 50,
        nextOffset: Math.min(offset + 50, routes.length),
      }
    }
    await this.deps.requireSession(request.payload.sessionId, signal)
    assertCurrent()
    const read = backend.sessions.readBillingPage
    const result = await new BillingUseCases(
      { ...store, read: () => Promise.resolve(settings) },
      {
        resolve: async (routes, signal) => {
          const prices = []
          for (const route of routes.slice(0, 256)) {
            const entry = await catalog.entry(route, signal)
            if (entry.price !== undefined) prices.push(entry.price)
          }
          return prices
        },
      },
      this.exchange,
    ).estimate(
      request.payload.sessionId,
      read === undefined
        ? undefined
        : {
            readBillingPage: async (sessionId, before, readSignal) => {
              assertCurrent()
              const page = await read.call(backend.sessions, sessionId, before, readSignal)
              assertCurrent()
              return page
            },
          },
      signal,
      request.payload.currency,
    )
    await this.deps.requireSession(request.payload.sessionId, signal)
    assertCurrent()
    return { kind: 'billing.estimate', estimate: result }
  }
}
