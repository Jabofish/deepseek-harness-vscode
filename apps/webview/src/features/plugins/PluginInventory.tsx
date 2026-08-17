import { useEffect, useId, useMemo, useState, type ReactElement } from 'react'
import type { PluginFiberPhase, PluginInventoryEntry, PluginInventorySnapshot } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'
import { useI18n } from '../../i18n.js'

export interface PluginInventoryProps {
  readonly onLoadInventory: () => Promise<PluginInventorySnapshot | undefined>
}

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: PluginInventorySnapshot }

/** Localized accessible label for one root Fiber phase. */
function phaseLabel(phase: PluginFiberPhase, t: (key: string) => string): string {
  return phase === null ? t('plugins.phase.unmounted') : t(`plugins.phase.${phase}`)
}

/** Compact a module specifier without guessing whether its Loader id was generated. */
function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^dsh-(?:host-|client-)?/, '')
}

/** Whether an inventory row matches the local catalog query. */
function matches(entry: PluginInventoryEntry, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true
  return [entry.moduleName, entry.entryId].some((value) =>
    value.toLocaleLowerCase().includes(normalizedQuery),
  )
}

/**
 * The read-only plugin inventory, mirroring the upstream Settings section:
 * a search box over the loader projection, one expandable card per entry with
 * its configuration tag and — when enabled — its root Cordis fiber phase. The
 * pinned rc.6 contract publishes no mutation path, so the section is purely a
 * projection of what the deployment composed.
 */
export function PluginInventory(props: PluginInventoryProps): ReactElement {
  const { t } = useI18n()
  const catalogId = useId()
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<PluginInventoryEntry['entryId'] | null>(null)
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    void props
      .onLoadInventory()
      .catch(() => undefined)
      .then((snapshot) => {
        if (!current) return
        setState(snapshot === undefined ? { status: 'error' } : { status: 'ready', snapshot })
      })
    return () => {
      current = false
    }
    // Inventory reads are explicit (mount/retry). Parent renders publish a new
    // callback identity and must not turn ordinary backend events into polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredEntries = useMemo(
    () =>
      state.status === 'ready'
        ? state.snapshot.entries.filter((entry) => matches(entry, normalizedQuery))
        : [],
    [normalizedQuery, state],
  )

  // Upstream collapses an expanded card once the query filters it out; folding
  // that into the query change keeps it out of a cascading effect.
  const onQueryChange = (value: string): void => {
    setQuery(value)
    if (expanded === null || state.status !== 'ready') return
    const entry = state.snapshot.entries.find((item) => item.entryId === expanded)
    const nextQuery = value.trim().toLocaleLowerCase()
    if (entry === undefined || !matches(entry, nextQuery)) setExpanded(null)
  }

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest((value) => value + 1)
  }

  return (
    <section className="dsh-plugin-inventory" aria-busy={state.status === 'loading'}>
      {state.status === 'loading' ? (
        <p className="dsh-settings__empty" role="status">
          {t('plugins.reading')}
        </p>
      ) : null}
      {state.status === 'error' ? (
        <div className="dsh-plugin-inventory__failure">
          <p role="alert">{t('plugins.unavailable')}</p>
          <button
            className="dsh-button dsh-button--secondary dsh-button--compact"
            type="button"
            onClick={retry}
          >
            {t('plugins.retry')}
          </button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <div className="dsh-plugin-inventory__catalog">
          <label className="dsh-plugin-inventory__search">
            <Icon name="search" />
            <span className="dsh-sr-only">{t('plugins.search')}</span>
            <input
              type="search"
              value={query}
              placeholder={t('plugins.search')}
              aria-label={t('plugins.search')}
              onChange={(event) => {
                onQueryChange(event.currentTarget.value)
              }}
            />
          </label>
          <div className="dsh-plugin-inventory__heading">
            <h3>{t('plugins.list')}</h3>
            <span data-plugin-count={filteredEntries.length}>{filteredEntries.length}</span>
          </div>
          {state.snapshot.entries.length === 0 ? (
            <p className="dsh-settings__empty">{t('plugins.empty')}</p>
          ) : null}
          {state.snapshot.entries.length > 0 && filteredEntries.length === 0 ? (
            <p className="dsh-settings__empty">{t('plugins.noMatch')}</p>
          ) : null}
          {filteredEntries.length > 0 ? (
            <ul className="dsh-plugin-inventory__cards">
              {filteredEntries.map((entry) => {
                const status = phaseLabel(entry.fiberPhase, t)
                const title = moduleShortName(entry.moduleName)
                const configuration = entry.enabled ? t('plugins.enabled') : t('plugins.disabled')
                const open = expanded === entry.entryId
                const detailId = `${catalogId}-details-${encodeURIComponent(entry.entryId)}`
                return (
                  <li
                    className="dsh-plugin-inventory__card"
                    key={entry.entryId}
                    data-plugin-entry={entry.entryId}
                    data-open={open ? 'true' : undefined}
                  >
                    <button
                      className="dsh-plugin-inventory__card-content"
                      type="button"
                      aria-expanded={open}
                      aria-controls={detailId}
                      aria-label={
                        entry.enabled ? `${title}, ${status}, ${configuration}` : `${title}, ${configuration}`
                      }
                      onClick={() => {
                        setExpanded((current) => (current === entry.entryId ? null : entry.entryId))
                      }}
                    >
                      <strong className="dsh-plugin-inventory__card-title" title={entry.moduleName}>
                        {title}
                      </strong>
                      <span className="dsh-plugin-inventory__card-trailing">
                        {entry.enabled ? (
                          <span
                            className="dsh-plugin-inventory__status-dot"
                            data-phase={entry.fiberPhase ?? 'unobserved'}
                            role="img"
                            aria-label={status}
                            title={status}
                          />
                        ) : null}
                        <span
                          className="dsh-plugin-inventory__config-tag"
                          data-enabled={entry.enabled ? 'true' : 'false'}
                        >
                          {configuration}
                        </span>
                        <Icon name="chevron-down" />
                      </span>
                    </button>
                    {open ? (
                      <div className="dsh-plugin-inventory__card-details" id={detailId}>
                        <code className="dsh-plugin-inventory__entry-value" data-loader-entry>
                          {entry.entryId}
                        </code>
                        <dl className="dsh-plugin-inventory__details">
                          <div>
                            <dt>{t('plugins.configuration')}</dt>
                            <dd>{configuration}</dd>
                          </div>
                          {entry.enabled ? (
                            <div>
                              <dt>{t('plugins.cordisStatus')}</dt>
                              <dd>{status}</dd>
                            </div>
                          ) : null}
                        </dl>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
