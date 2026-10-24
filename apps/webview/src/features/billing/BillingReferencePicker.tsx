import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { BillingCandidate } from '@dsh-vscode/domain'
import { billingReferencesResponseSchema, type BillingReferencesResponse } from '@dsh-vscode/webview-protocol'
import { useI18n } from '../../i18n.js'
import { requestId } from '../../app/store/ids.js'
import { useStableCallback } from '../../app/useStableCallback.js'
import { useBillingClient, type BillingClient } from './billing-client.js'
import { BillingReferenceDetails } from './BillingPriceDetails.js'

export function BillingReferencePicker(props: {
  readonly request: BillingClient
  readonly onSelect: (candidate: BillingCandidate) => void
}): ReactElement {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return (
    <details className="dsh-billing__disclosure" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t('billing.chooseAnyReference')}</summary>
      {open ? <ReferenceSearch {...props} /> : null}
    </details>
  )
}

function ReferenceSearch({
  request,
  onSelect,
}: {
  readonly request: BillingClient
  readonly onSelect: (candidate: BillingCandidate) => void
}): ReactElement {
  const { t } = useI18n()
  const { send, isAlive } = useBillingClient(request)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<BillingReferencesResponse>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const generation = useRef(0)
  const appliedQuery = useRef('')
  const searchInput = useRef<HTMLInputElement>(null)
  const search = useStableCallback(async (query: string, offset: number = 0): Promise<void> => {
    const epoch = ++generation.current
    appliedQuery.current = query
    setBusy(true)
    setFailed(false)
    try {
      const next = billingReferencesResponseSchema.parse(
        await send({
          type: 'billing.reference.search',
          requestId: requestId(),
          payload: { query, offset },
        }),
      )
      if (!isAlive() || generation.current !== epoch) return
      setResult((current) =>
        offset === 0 ? next : { ...next, entries: [...(current?.entries ?? []), ...next.entries] },
      )
    } catch {
      if (isAlive() && generation.current === epoch) setFailed(true)
    } finally {
      if (isAlive() && generation.current === epoch) setBusy(false)
    }
  })
  useEffect(() => {
    searchInput.current?.focus({ preventScroll: true })
    void search('')
  }, [search])
  return (
    <section
      aria-label={t('billing.referenceModels')}
      className="dsh-billing__reference-search"
      aria-busy={busy}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void search(query)
        }}
        className="dsh-billing__search"
      >
        <input
          ref={searchInput}
          aria-label={t('billing.searchReferences')}
          placeholder={t('billing.searchReferences')}
          maxLength={128}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" disabled={busy}>
          {t('billing.search')}
        </button>
      </form>
      {failed ? (
        <div role="alert">
          <p>{t('billing.referenceFailed')}</p>
          <button
            type="button"
            onClick={() => {
              void search(appliedQuery.current)
            }}
          >
            {t('billing.retryReference')}
          </button>
        </div>
      ) : null}
      {busy ? <p role="status">{t('billing.loading')}</p> : null}
      <ul className="dsh-billing__reference-results">
        {result?.entries.map((entry) => (
          <li key={JSON.stringify([entry.providerId, entry.modelId])}>
            <strong>{entry.label}</strong>
            <p>
              {entry.providerId} / {entry.modelId}
              {entry.official === true ? ` · ${t('billing.match.official')}` : ''}
            </p>
            <BillingReferenceDetails reference={entry} request={request} />
            <button type="button" onClick={() => onSelect(entry)}>
              {t('billing.useReference', { provider: entry.providerId, model: entry.modelId })}
            </button>
          </li>
        ))}
      </ul>
      {!busy && !failed && result?.entries.length === 0 ? <p>{t('billing.noMatchingModels')}</p> : null}
      {result?.hasMore ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void search(appliedQuery.current, result.nextOffset)
          }}
        >
          {t('billing.moreModels')}
        </button>
      ) : null}
    </section>
  )
}
