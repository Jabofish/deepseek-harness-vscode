import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import type { BillingMapping, BillingPrice, ModelDescriptor } from '@dsh-vscode/domain'
import {
  billingPriceSchema,
  billingCatalogResponseSchema,
  billingReferenceResponseSchema,
  billingSettingsResponseSchema,
  type BillingSettingsResponse,
  type BillingCatalogResponse,
} from '@dsh-vscode/webview-protocol'
import { useI18n } from '../../i18n.js'
import { requestId } from '../../app/store/ids.js'
import { useStableCallback } from '../../app/useStableCallback.js'
import { useBillingClient, type BillingClient } from './billing-client.js'
import './billing.css'
import { BillingRulesEditor, type BillingRules } from './BillingRulesEditor.js'
import { BillingModelList } from './BillingModelList.js'
import { Icon } from '../../ui/Icon.js'
import { billingDateLabel } from './billing-time.js'

type Draft = {
  [
    K in 'providerId' | 'modelId' | 'currency' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning'
  ]: string
}
const empty: Draft = {
  providerId: '',
  modelId: '',
  currency: 'USD',
  input: '',
  output: '',
  cacheRead: '',
  cacheWrite: '',
  reasoning: '',
}
const priceKey = (price: BillingPrice): string =>
  JSON.stringify([price.providerId, price.modelId, price.validFrom, price.validUntil])
function toDraft(price: BillingPrice): Draft {
  return {
    providerId: price.providerId,
    modelId: price.modelId,
    currency: price.currency,
    input: price.input,
    output: price.output,
    cacheRead: price.cacheRead ?? '',
    cacheWrite: price.cacheWrite ?? '',
    reasoning: price.reasoning ?? '',
  }
}
function draftPrice(draft: Draft, rules: BillingRules): BillingPrice | undefined {
  const value = billingPriceSchema.safeParse({
    ...draft,
    ...rules,
    cacheRead: draft.cacheRead === '' ? undefined : draft.cacheRead,
    cacheWrite: draft.cacheWrite === '' ? undefined : draft.cacheWrite,
    reasoning: draft.reasoning === '' ? undefined : draft.reasoning,
  })
  return value.success ? value.data : undefined
}

export function BillingSettings(props: {
  readonly request: BillingClient
  readonly models: readonly ModelDescriptor[]
}): ReactElement {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return (
    <details className="dsh-billing" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="dsh-billing__summary">
        <Icon name="wallet" />
        <span>{t('billing.settings')}</span>
        <Icon name="chevron-down" />
      </summary>
      {open ? <BillingPriceEditor {...props} /> : null}
    </details>
  )
}

function BillingPriceEditor(props: {
  readonly request: BillingClient
  readonly models: readonly ModelDescriptor[]
}): ReactElement {
  const { t, locale } = useI18n()
  const { send, isAlive } = useBillingClient(props.request)
  const [snapshot, setSnapshot] = useState<BillingSettingsResponse>()
  const [enabled, setEnabled] = useState(false)
  const [automatic, setAutomatic] = useState(true)
  const [catalog, setCatalog] = useState<BillingCatalogResponse>()
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [catalogFailed, setCatalogFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [rules, setRules] = useState<BillingRules>({})
  const [draft, setDraft] = useState<Draft>(empty)
  const [editingKey, setEditingKey] = useState<string>()
  const [editorOpen, setEditorOpen] = useState(false)
  const editorRef = useRef<HTMLFormElement>(null)
  const catalogRef = useRef<HTMLElement>(null)
  const editorWasOpen = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [reference, setReference] = useState<'found' | 'missing' | 'unsupported'>()
  const [referenceProvider, setReferenceProvider] = useState('')
  const [referenceModel, setReferenceModel] = useState('')
  const [referenceTime, setReferenceTime] = useState<string>()
  const providersId = useId()
  const modelsId = useId()
  const operation = useRef(0)
  const catalogOperation = useRef(0)
  const appliedQuery = useRef('')
  const loadCatalog = useStableCallback(
    async (
      snapshot: BillingSettingsResponse,
      offset: number = 0,
      query: string = appliedQuery.current,
    ): Promise<void> => {
      const epoch = ++catalogOperation.current
      setCatalogBusy(true)
      setCatalogFailed(false)
      appliedQuery.current = query
      try {
        const result = billingCatalogResponseSchema.parse(
          await send({ type: 'billing.catalog.read', requestId: requestId(), payload: { offset, query } }),
        )
        if (!isAlive() || epoch !== catalogOperation.current) return
        if (result.scopeId !== snapshot.scopeId || result.revision !== snapshot.settings.revision)
          throw new Error('Stale catalog')
        setCatalog((current) =>
          offset === 0 || current?.scopeId !== result.scopeId || current.revision !== result.revision
            ? result
            : { ...result, entries: [...current.entries, ...result.entries] },
        )
      } catch {
        if (isAlive() && epoch === catalogOperation.current) setCatalogFailed(true)
      } finally {
        if (isAlive() && epoch === catalogOperation.current) setCatalogBusy(false)
      }
    },
  )
  const load = useStableCallback(async (): Promise<void> => {
    const epoch = ++operation.current
    setBusy(true)
    setError(false)
    try {
      const result = billingSettingsResponseSchema.parse(
        await send({ type: 'billing.settings.read', requestId: requestId(), payload: {} }),
      )
      if (!isAlive() || epoch !== operation.current) return
      setSnapshot(result)
      setEnabled(result.settings.enabled)
      setAutomatic(result.settings.automatic !== false)
    } catch {
      if (isAlive() && epoch === operation.current) setError(true)
    } finally {
      if (isAlive() && epoch === operation.current) setBusy(false)
    }
  })
  useEffect(() => {
    void load()
  }, [load])
  const modelsKey = JSON.stringify(props.models.map((m) => [m.providerId, m.id, m.label]))
  useEffect(() => {
    if (snapshot !== undefined) void loadCatalog(snapshot)
  }, [snapshot, modelsKey, loadCatalog])
  const edit = (price: BillingPrice): void => {
    setEditorOpen(true)
    setReference(undefined)
    setDraft(toDraft(price))
    setEditingKey(priceKey(price))
    setRules({
      ...(price.multipliers === undefined ? {} : { multipliers: price.multipliers }),
      ...(price.overrides === undefined ? {} : { overrides: price.overrides }),
      ...(price.validFrom === undefined ? {} : { validFrom: price.validFrom }),
      ...(price.validUntil === undefined ? {} : { validUntil: price.validUntil }),
    })
  }
  const save = async (
    prices: readonly BillingPrice[],
    mappings: readonly BillingMapping[] = snapshot?.settings.mappings ?? [],
    closeEditor = false,
  ): Promise<void> => {
    if (snapshot === undefined || busy) return
    setBusy(true)
    setError(false)
    try {
      const result = billingSettingsResponseSchema.parse(
        await send({
          type: 'billing.settings.save',
          requestId: requestId(),
          payload: {
            scopeId: snapshot.scopeId,
            expectedRevision: snapshot.settings.revision,
            settings: { enabled, prices: [...prices], automatic, mappings: [...mappings] },
          },
        }),
      )
      if (isAlive()) {
        setSnapshot(result)
        if (closeEditor) setEditorOpen(false)
      }
    } catch {
      if (isAlive()) setError(true)
    } finally {
      if (isAlive()) setBusy(false)
    }
  }
  const readReference = async (): Promise<void> => {
    setBusy(true)
    setError(false)
    setReference(undefined)
    try {
      const result = billingReferenceResponseSchema.parse(
        await send({
          type: 'billing.reference.read',
          requestId: requestId(),
          payload: { providerId: referenceProvider, modelId: referenceModel },
        }),
      )
      if (!isAlive()) return
      setReference(result.status)
      setReferenceTime(result.fetchedAt)
      if (result.price !== undefined) {
        setRules({
          ...(result.price.multipliers === undefined ? {} : { multipliers: result.price.multipliers }),
          ...(result.price.overrides === undefined ? {} : { overrides: result.price.overrides }),
        })
        setDraft((current) => ({
          ...toDraft(result.price!),
          providerId: current.providerId,
          modelId: current.modelId,
        }))
      }
    } catch {
      if (isAlive()) setError(true)
    } finally {
      if (isAlive()) setBusy(false)
    }
  }
  const price = draftPrice(draft, rules)
  const prices = snapshot?.settings.prices ?? []
  const withoutDraft = prices.filter(
    (p) =>
      !(priceKey(p) === editingKey && p.providerId === draft.providerId && p.modelId === draft.modelId) &&
      (price === undefined || priceKey(p) !== priceKey(price)),
  )
  useEffect(() => {
    const restoreFocus = editorWasOpen.current
    editorWasOpen.current = editorOpen
    if (!editorOpen) {
      if (restoreFocus)
        catalogRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
      return
    }
    editorRef.current
      ?.querySelector<HTMLInputElement>('input[data-price-input]')
      ?.focus({ preventScroll: true })
    editorRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' })
  }, [editorOpen])
  const configurationChanged =
    snapshot !== undefined &&
    (enabled !== snapshot.settings.enabled || automatic !== (snapshot.settings.automatic !== false))
  const entries =
    catalog?.entries ??
    prices
      .filter(
        (price, index) =>
          prices.findIndex((p) => p.providerId === price.providerId && p.modelId === price.modelId) === index,
      )
      .map((price) => ({
        providerId: price.providerId,
        modelId: price.modelId,
        label: price.modelId,
        status: 'manual' as const,
        price,
        candidates: [],
      }))
  const startNew = (): void => {
    setDraft(empty)
    setRules({})
    setEditingKey(undefined)
    setReference(undefined)
    setEditorOpen(true)
  }
  return (
    <div className="dsh-billing__editor" aria-busy={busy}>
      {error ? (
        <p className="dsh-billing__error" role="alert">
          {t('billing.failed')}
        </p>
      ) : null}
      <fieldset className="dsh-billing__controls" disabled={busy}>
        <label className="dsh-billing__switch">
          <input
            type="checkbox"
            disabled={snapshot === undefined}
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          {t('billing.enabled')}
        </label>
        <label className="dsh-billing__switch">
          <input
            type="checkbox"
            disabled={snapshot === undefined}
            checked={automatic}
            onChange={(event) => setAutomatic(event.target.checked)}
          />
          {t('billing.automatic')}
        </label>
        <div className="dsh-billing__control-actions">
          {configurationChanged ? (
            <button
              className="dsh-billing__primary"
              type="button"
              onClick={() => {
                void save(prices)
              }}
            >
              {t('billing.saveEnabled')}
            </button>
          ) : null}
          <button
            className="dsh-billing__icon-button"
            type="button"
            aria-label={t('billing.reload')}
            title={t('billing.reload')}
            onClick={() => {
              void load()
            }}
          >
            <Icon name="refresh" />
          </button>
        </div>
      </fieldset>
      <fieldset className="dsh-billing__content" disabled={busy || snapshot === undefined}>
        {editorOpen ? (
          <form
            ref={editorRef}
            className="dsh-billing__form"
            onSubmit={(event) => {
              event.preventDefault()
              if (price !== undefined) void save([...withoutDraft, price], undefined, true)
            }}
          >
            <div className="dsh-billing__section-head">
              <button className="dsh-billing__text-button" type="button" onClick={() => setEditorOpen(false)}>
                <Icon name="chevron-left" />
                {t('billing.backToModels')}
              </button>
              <span>{t('billing.configuration')}</span>
            </div>
            <div className="dsh-billing__route-fields">
              <label>
                {t('billing.providerId')}
                <input
                  list={providersId}
                  value={draft.providerId}
                  maxLength={256}
                  onChange={(event) => setDraft({ ...draft, providerId: event.target.value })}
                />
              </label>
              <label>
                {t('billing.modelId')}
                <input
                  list={modelsId}
                  value={draft.modelId}
                  maxLength={256}
                  onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
                />
              </label>
            </div>
            <datalist id={providersId}>
              {[...new Set(props.models.map((m) => m.providerId))].map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            <datalist id={modelsId}>
              {props.models
                .filter((m) => m.providerId === draft.providerId)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
            </datalist>
            <div className="dsh-billing__rates">
              <label>
                {t('billing.currency')}
                <input
                  value={draft.currency}
                  maxLength={3}
                  onChange={(event) => setDraft({ ...draft, currency: event.target.value.toUpperCase() })}
                />
              </label>
              <label>
                {t('billing.rate.input')}
                <input
                  data-price-input
                  inputMode="decimal"
                  maxLength={19}
                  required
                  placeholder={t('billing.required')}
                  value={draft.input}
                  onChange={(event) => setDraft({ ...draft, input: event.target.value })}
                />
              </label>
              {(['output', 'cacheRead', 'cacheWrite', 'reasoning'] as const).map((key) => (
                <label key={key}>
                  {t(`billing.rate.${key}`)}
                  <input
                    inputMode="decimal"
                    maxLength={19}
                    required={key === 'output'}
                    placeholder={t(key === 'output' ? 'billing.required' : 'billing.notConfigured')}
                    value={draft[key]}
                    onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                  />
                </label>
              ))}
            </div>
            <BillingRulesEditor rules={rules} onChange={setRules} />
            <details className="dsh-billing__disclosure dsh-billing__reference">
              <summary>{t('billing.reference')}</summary>
              <div className="dsh-billing__route-fields">
                <label>
                  {t('billing.referenceProvider')}
                  <input
                    value={referenceProvider}
                    maxLength={256}
                    onChange={(event) => setReferenceProvider(event.target.value)}
                  />
                </label>
                <label>
                  {t('billing.referenceModel')}
                  <input
                    value={referenceModel}
                    maxLength={256}
                    onChange={(event) => setReferenceModel(event.target.value)}
                  />
                </label>
              </div>
              <button
                type="button"
                disabled={referenceProvider.trim() === '' || referenceModel.trim() === ''}
                onClick={() => {
                  void readReference()
                }}
              >
                <Icon name="search" />
                {t('billing.readReference')}
              </button>
              {reference === undefined ? null : (
                <p className="dsh-billing__message" role="status">
                  {t(`billing.reference.${reference}`)}{' '}
                  {referenceTime === undefined
                    ? ''
                    : `${t('billing.timeZone')} ${billingDateLabel(Date.parse(referenceTime), locale)}`}
                </p>
              )}
            </details>
            <div className="dsh-billing__form-actions">
              <button
                className="dsh-billing__primary"
                type="submit"
                disabled={price === undefined || withoutDraft.length >= 256}
              >
                <Icon name="check" />
                {t('billing.savePrice')}
              </button>
              <button type="button" onClick={() => setEditorOpen(false)}>
                {t('billing.backToModels')}
              </button>
            </div>
          </form>
        ) : (
          <section ref={catalogRef} aria-label={t('billing.catalog')} className="dsh-billing__catalog">
            <div className="dsh-billing__section-head">
              <h3>{t('billing.configuration')}</h3>
              <button type="button" className="dsh-billing__text-button" onClick={startNew}>
                <Icon name="add" />
                {t('billing.newPrice')}
              </button>
            </div>
            <form
              className="dsh-billing__search"
              onSubmit={(event) => {
                event.preventDefault()
                if (snapshot !== undefined) void loadCatalog(snapshot, 0, query)
              }}
            >
              <Icon name="search" />
              <input
                aria-label={t('billing.searchModels')}
                placeholder={t('billing.searchModels')}
                value={query}
                maxLength={128}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button
                className="dsh-billing__icon-button"
                type="submit"
                disabled={catalogBusy}
                aria-label={t('billing.refreshModels')}
                title={t('billing.refreshModels')}
              >
                <Icon name="refresh" />
              </button>
            </form>
            {catalogFailed ? (
              <p className="dsh-billing__error" role="alert">
                {t('billing.catalogFailed')}
              </p>
            ) : null}
            {catalogBusy ? (
              <p className="dsh-billing__message" role="status">
                {t('billing.loading')}
              </p>
            ) : null}
            <BillingModelList
              request={props.request}
              entries={entries}
              prices={prices}
              onEdit={(entry, price) =>
                edit(price ?? { ...empty, providerId: entry.providerId, modelId: entry.modelId })
              }
              onRemove={(price) => {
                void save(prices.filter((p) => p !== price))
              }}
              onRestore={(entry) => {
                void save(
                  prices.filter((p) => p.providerId !== entry.providerId || p.modelId !== entry.modelId),
                  snapshot?.settings.mappings?.filter(
                    (m) => m.providerId !== entry.providerId || m.modelId !== entry.modelId,
                  ),
                )
              }}
              onReference={(entry, candidate) => {
                void save(
                  prices.filter((p) => p.providerId !== entry.providerId || p.modelId !== entry.modelId),
                  [
                    ...(snapshot?.settings.mappings ?? []).filter(
                      (m) => m.providerId !== entry.providerId || m.modelId !== entry.modelId,
                    ),
                    {
                      providerId: entry.providerId,
                      modelId: entry.modelId,
                      referenceProviderId: candidate.providerId,
                      referenceModelId: candidate.modelId,
                    },
                  ],
                )
              }}
            />
            {!catalogBusy && entries.length === 0 ? (
              <p className="dsh-billing__message">{t('billing.noMatchingModels')}</p>
            ) : null}
            {catalog?.hasMore === true ? (
              <button
                type="button"
                className="dsh-billing__more"
                disabled={catalogBusy}
                onClick={() => {
                  if (snapshot !== undefined) void loadCatalog(snapshot, catalog.nextOffset)
                }}
              >
                {t('billing.moreModels')}
                <Icon name="chevron-down" />
              </button>
            ) : null}
          </section>
        )}
      </fieldset>
      {busy ? (
        <p className="dsh-billing__message" role="status">
          {t('billing.loading')}
        </p>
      ) : null}
    </div>
  )
}
