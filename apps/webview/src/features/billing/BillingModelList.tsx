import type { ReactElement } from 'react'
import type { BillingPrice } from '@dsh-vscode/domain'
import type { BillingCatalogResponse } from '@dsh-vscode/webview-protocol'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

type ModelRow = BillingCatalogResponse['entries'][number]

export function BillingModelList({
  entries,
  prices,
  onEdit,
  onRestore,
  onReference,
  onRemove,
}: {
  readonly entries: readonly ModelRow[]
  readonly prices: readonly BillingPrice[]
  readonly onEdit: (entry: ModelRow, price?: BillingPrice) => void
  readonly onRestore: (entry: ModelRow) => void
  readonly onReference: (entry: ModelRow, candidate: ModelRow['candidates'][number]) => void
  readonly onRemove: (price: BillingPrice) => void
}): ReactElement {
  const { t } = useI18n()
  return (
    <ul className="dsh-billing__models">
      {entries.map((entry) => {
        const periods = prices.filter((p) => p.providerId === entry.providerId && p.modelId === entry.modelId)
        const ruleCount = (entry.price?.multipliers?.length ?? 0) + (entry.price?.overrides?.length ?? 0)
        const candidates = entry.candidates.map((candidate) => (
          <button
            type="button"
            className="dsh-billing__candidate"
            key={JSON.stringify([candidate.providerId, candidate.modelId])}
            onClick={() => onReference(entry, candidate)}
          >
            <Icon name="branch" />
            {t('billing.useReference', { provider: candidate.providerId, model: candidate.modelId })}
            <Icon name="chevron-right" />
          </button>
        ))
        return (
          <li className="dsh-billing__model" key={JSON.stringify([entry.providerId, entry.modelId])}>
            <div className="dsh-billing__model-head">
              <div className="dsh-billing__identity">
                <strong>{entry.label}</strong>
                <span>
                  {entry.providerId} / {entry.modelId}
                </span>
              </div>
              <span className={`dsh-billing__badge dsh-billing__badge--${entry.status}`}>
                {t(`billing.match.${entry.status}`)}
              </span>
              <button
                type="button"
                className="dsh-billing__icon-button"
                aria-label={t('billing.edit')}
                title={t('billing.edit')}
                onClick={() => onEdit(entry, entry.price)}
              >
                <Icon name="edit" />
              </button>
            </div>
            {entry.price === undefined ? null : (
              <div className="dsh-billing__price-preview">
                <span>
                  {t('billing.rate.input')}{' '}
                  <b>
                    {entry.price.currency} {entry.price.input}
                  </b>
                </span>
                <span>
                  {t('billing.rate.output')}{' '}
                  <b>
                    {entry.price.currency} {entry.price.output}
                  </b>
                </span>
              </div>
            )}
            {ruleCount > 0 ? (
              <span className="dsh-billing__rule-label">
                <Icon name="clock" />
                {t('billing.specialRules', { count: ruleCount })}
              </span>
            ) : null}
            {entry.reference === undefined ||
            (entry.reference.providerId === entry.providerId &&
              entry.reference.modelId === entry.modelId) ? null : (
              <div className="dsh-billing__source">
                <Icon name="branch" />
                <span>
                  {entry.reference.providerId} / {entry.reference.modelId}
                </span>
              </div>
            )}
            {candidates.length > 2 ? (
              <details className="dsh-billing__disclosure">
                <summary>{t('billing.chooseReference', { count: candidates.length })}</summary>
                <div className="dsh-billing__candidates">{candidates}</div>
              </details>
            ) : candidates.length === 0 ? null : (
              <div className="dsh-billing__candidates">{candidates}</div>
            )}
            {periods.length > 1 ? (
              <details className="dsh-billing__disclosure">
                <summary>{t('billing.pricePeriods', { count: periods.length })}</summary>
                {periods.map((price) => (
                  <div
                    className="dsh-billing__period"
                    key={JSON.stringify([price.validFrom, price.validUntil])}
                  >
                    <span>
                      {price.validFrom === undefined
                        ? '…'
                        : new Date(price.validFrom).toISOString().slice(0, 16)}{' '}
                      –{' '}
                      {price.validUntil === undefined
                        ? '…'
                        : new Date(price.validUntil).toISOString().slice(0, 16)}{' '}
                      UTC
                    </span>
                    <button
                      type="button"
                      className="dsh-billing__icon-button"
                      aria-label={t('billing.edit')}
                      title={t('billing.edit')}
                      onClick={() => onEdit(entry, price)}
                    >
                      <Icon name="edit" />
                    </button>
                    <button
                      type="button"
                      className="dsh-billing__icon-button"
                      aria-label={t('billing.removePrice', { model: price.modelId })}
                      title={t('billing.remove')}
                      onClick={() => onRemove(price)}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                ))}
              </details>
            ) : null}
            {entry.status === 'manual' ||
            (entry.reference !== undefined &&
              (entry.reference.providerId !== entry.providerId ||
                entry.reference.modelId !== entry.modelId)) ? (
              <button type="button" className="dsh-billing__text-button" onClick={() => onRestore(entry)}>
                <Icon name="refresh" />
                {t('billing.restoreAutomatic')}
              </button>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
