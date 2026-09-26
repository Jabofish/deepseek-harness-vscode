import {
  pluginLocalizedText,
  type AgentPresetPluginGroup,
  type AgentPresetPluginRow,
  type PluginFiberPhase,
  type PluginInventoryEntry,
  type PluginInventorySnapshot,
} from '@dsh-vscode/domain'
import { useEffect, useId, useMemo, useState, type ReactElement } from 'react'
import { SelectMenu } from '../../components/common/SelectMenu.js'
import { Icon } from '../../ui/Icon.js'
import { useI18n, type Translate } from '../../i18n.js'

export interface PluginInventoryProps {
  readonly revision?: number | undefined
  readonly onLoadInventory: () => Promise<PluginInventorySnapshot | undefined>
}

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: PluginInventorySnapshot }

type PluginRow = PluginInventoryEntry | AgentPresetPluginRow

const EMPTY_PRESETS: readonly AgentPresetPluginGroup[] = []
const EMPTY_PLUGIN_ENTRIES: readonly PluginInventoryEntry[] = []
const EMPTY_PRESET_ROWS: readonly AgentPresetPluginRow[] = []
const EMPTY_INDEXED_PRESET_ROWS: readonly { readonly row: AgentPresetPluginRow; readonly index: number }[] =
  []

type ExpandedPlugin =
  | { readonly scope: 'global'; readonly entryId: string }
  | { readonly scope: 'session'; readonly presetId: string; readonly rowKey: string }

type InventoryGroup = ExpandedPlugin['scope']

const EMPTY_GROUPS: ReadonlySet<InventoryGroup> = new Set()
const ALL_GROUPS: ReadonlySet<InventoryGroup> = new Set<InventoryGroup>(['session', 'global'])

/** Localized accessible label for one root Fiber phase. */
function phaseLabel(phase: PluginFiberPhase, t: Translate): string {
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

function presetName(preset: AgentPresetPluginGroup, t: Translate): string {
  if (preset.name !== undefined) return preset.name

  switch (preset.id) {
    case 'standard':
      return t('presets.builtin.standard.name')
    case 'ptc':
      return t('presets.builtin.ptc.name')
    case 'minimal':
      return t('presets.builtin.minimal.name')
    case 'cordis':
      return t('presets.builtin.cordis.name')
    default:
      return preset.id
  }
}

/** The host's default marker belongs to the same string in the menu and on the trigger. */
function presetChoiceLabel(preset: AgentPresetPluginGroup, t: Translate): string {
  const name = presetName(preset, t)
  return preset.isDefault ? `${name} (${t('plugins.defaultPreset')})` : name
}

/** Keep a user's inspection choice when it survives a refresh; otherwise use the host default. */
function selectedPresetId(
  presets: readonly AgentPresetPluginGroup[],
  requestedId: string | undefined,
): string | undefined {
  if (requestedId !== undefined && presets.some((preset) => preset.id === requestedId)) return requestedId
  return presets.find((preset) => preset.isDefault)?.id ?? presets[0]?.id
}

function matchesValues(values: readonly (string | undefined | null)[], normalizedQuery: string): boolean {
  return (
    normalizedQuery.length === 0 ||
    values.some((value) => value?.toLocaleLowerCase().includes(normalizedQuery) === true)
  )
}

/** Search visible metadata and stable inventory identifiers without inspecting opaque payloads. */
function matchesGlobal(entry: PluginInventoryEntry, normalizedQuery: string, locale: string): boolean {
  return matchesValues(
    [
      entry.entryId,
      entry.moduleName,
      pluginLocalizedText(entry.meta?.title, locale),
      pluginLocalizedText(entry.meta?.description, locale),
    ],
    normalizedQuery,
  )
}

function matchesSession(row: AgentPresetPluginRow, normalizedQuery: string, locale: string): boolean {
  return matchesValues(
    [
      row.entryId,
      row.moduleName,
      pluginLocalizedText(row.meta?.title, locale),
      pluginLocalizedText(row.meta?.description, locale),
    ],
    normalizedQuery,
  )
}

function sessionRowKey(presetId: string, row: AgentPresetPluginRow, index: number): string {
  return `${encodeURIComponent(presetId)}:${encodeURIComponent(row.entryId ?? row.moduleName)}:${index}`
}

function countLabel(matches: number, total: number, searching: boolean, t: Translate): string {
  return searching
    ? t('plugins.inventory.matchCount', { matches, total })
    : t('plugins.inventory.totalCount', { count: total })
}

/** The heading of an inventory group doubles as the disclosure for its plugin list. */
function GroupToggle(props: {
  readonly open: boolean
  readonly onToggle: () => void
  readonly bodyId: string
  readonly label: string
}): ReactElement {
  return (
    <button
      className="dsh-plugin-inventory__group-toggle"
      type="button"
      aria-expanded={props.open}
      aria-controls={props.open ? props.bodyId : undefined}
      onClick={props.onToggle}
    >
      <Icon name={props.open ? 'chevron-down' : 'chevron-right'} />
      <span>{props.label}</span>
    </button>
  )
}

function PluginCard(props: {
  readonly cardId: string
  readonly entry: PluginRow
  readonly scope: 'session' | 'global'
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly detailId: string
  readonly locale: string
  readonly t: Translate
}): ReactElement {
  const { entry, scope, t, locale } = props
  const title = pluginLocalizedText(entry.meta?.title, locale) ?? moduleShortName(entry.moduleName)
  const enabled = entry.enabled === true
  const conditional = entry.enabled === 'conditional'
  const configuration = conditional
    ? t('plugins.conditional')
    : enabled
      ? t('plugins.enabled')
      : t('plugins.disabled')
  const status = phaseLabel(entry.fiberPhase, t)
  const condition = 'condition' in entry ? entry.condition : undefined
  const entryId = entry.entryId

  return (
    <li
      className="dsh-plugin-inventory__card"
      key={props.cardId}
      data-plugin-scope={scope}
      data-plugin-entry={entryId ?? undefined}
      data-plugin-row={scope === 'session' ? props.cardId : undefined}
      data-open={props.expanded ? 'true' : undefined}
    >
      <button
        className="dsh-plugin-inventory__card-content"
        type="button"
        aria-expanded={props.expanded}
        aria-controls={props.expanded ? props.detailId : undefined}
        onClick={props.onToggle}
      >
        <strong className="dsh-plugin-inventory__card-title" title={entry.moduleName}>
          {title}
        </strong>
        <span className="dsh-plugin-inventory__card-trailing">
          {enabled ? (
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
            data-enabled={conditional ? 'conditional' : enabled ? 'true' : 'false'}
          >
            {configuration}
          </span>
          <Icon name="chevron-down" />
        </span>
      </button>
      {props.expanded ? (
        <div className="dsh-plugin-inventory__card-details" id={props.detailId}>
          {entry.meta?.description === undefined ? null : (
            <p>{pluginLocalizedText(entry.meta.description, locale)}</p>
          )}
          {entry.meta?.error === undefined ? null : <p role="alert">{entry.meta.error}</p>}
          {entryId === null ? null : (
            <code className="dsh-plugin-inventory__entry-value" data-loader-entry>
              {entryId}
            </code>
          )}
          <dl className="dsh-plugin-inventory__details">
            <div>
              <dt>{t('plugins.configuration')}</dt>
              <dd>{configuration}</dd>
            </div>
            {enabled ? (
              <div>
                <dt>{t('plugins.cordisStatus')}</dt>
                <dd>{status}</dd>
              </div>
            ) : null}
            {condition === undefined ? null : (
              <div>
                <dt>{t('plugins.inventory.condition')}</dt>
                <dd>
                  <code>{condition}</code>
                </dd>
              </div>
            )}
          </dl>
        </div>
      ) : null}
    </li>
  )
}

/** Read-only projection of the host's per-preset composition and global plugin inventory. */
export function PluginInventory(props: PluginInventoryProps): ReactElement {
  const { t, locale } = useI18n()
  const catalogId = useId()
  const modeSelectId = useId()
  const sessionHeadingId = useId()
  const globalHeadingId = useId()
  const sessionBodyId = useId()
  const globalBodyId = useId()
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [expanded, setExpanded] = useState<ExpandedPlugin | null>(null)
  const [openGroups, setOpenGroups] = useState<ReadonlySet<InventoryGroup>>(EMPTY_GROUPS)
  const [openGroupsWhileSearching, setOpenGroupsWhileSearching] =
    useState<ReadonlySet<InventoryGroup>>(ALL_GROUPS)
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    void props
      .onLoadInventory()
      .catch(() => undefined)
      .then((snapshot) => {
        if (!current) return
        setExpanded(null)
        if (snapshot !== undefined) {
          setSelectedId((previous) => selectedPresetId(snapshot.agentPresets ?? [], previous))
        }
        setState(snapshot === undefined ? { status: 'error' } : { status: 'ready', snapshot })
      })
    return () => {
      current = false
    }
    // Inventory reads are explicit (mount/retry/invalidation). Parent renders publish a new
    // callback identity and must not turn ordinary backend events into polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, props.revision])

  const snapshot = state.status === 'ready' ? state.snapshot : undefined
  const presets = snapshot?.agentPresets ?? EMPTY_PRESETS
  const selectedPreset =
    presets.find((preset) => preset.id === selectedId) ??
    presets.find((preset) => preset.isDefault) ??
    presets[0]
  const currentPresetId = selectedPreset?.id
  const globalEntries = snapshot?.entries ?? EMPTY_PLUGIN_ENTRIES
  const sessionRows = selectedPreset?.rows ?? EMPTY_PRESET_ROWS
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const searching = normalizedQuery.length > 0
  const filteredGlobal = useMemo(
    () => globalEntries.filter((entry) => matchesGlobal(entry, normalizedQuery, locale)),
    [globalEntries, locale, normalizedQuery],
  )
  const filteredPresets = useMemo(
    () =>
      presets.map((preset) => ({
        preset,
        rows: preset.rows
          .map((row, index) => ({ row, index }))
          .filter(({ row }) => matchesSession(row, normalizedQuery, locale)),
      })),
    [locale, normalizedQuery, presets],
  )
  const filteredSession =
    filteredPresets.find(({ preset }) => preset.id === currentPresetId)?.rows ?? EMPTY_INDEXED_PRESET_ROWS
  const otherPresetMatches = searching
    ? filteredPresets.filter(({ preset, rows }) => preset.id !== currentPresetId && rows.length > 0)
    : []
  const otherMatchCount = otherPresetMatches.reduce((total, { rows }) => total + rows.length, 0)
  const resultCount = filteredGlobal.length + filteredSession.length + otherMatchCount
  // A query must not hide its own matches, so searching starts from both groups open and keeps
  // the user's per-group choice for after the query is cleared.
  const openGroupsInEffect = searching ? openGroupsWhileSearching : openGroups

  const toggleGroup = (group: InventoryGroup): void => {
    const setOpen = searching ? setOpenGroupsWhileSearching : setOpenGroups
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  const onQueryChange = (value: string): void => {
    const nextQuery = value.trim().toLocaleLowerCase()
    setQuery(value)
    if (nextQuery.length > 0 && normalizedQuery.length === 0) setOpenGroupsWhileSearching(ALL_GROUPS)
    if (expanded === null || snapshot === undefined) return

    if (expanded.scope === 'global') {
      const entry = snapshot.entries.find((item) => item.entryId === expanded.entryId)
      if (entry === undefined || !matchesGlobal(entry, nextQuery, locale)) setExpanded(null)
      return
    }

    if (selectedPreset?.id !== expanded.presetId) {
      setExpanded(null)
      return
    }
    const indexedRow = selectedPreset.rows
      .map((row, index) => ({ row, index }))
      .find(({ row, index }) => sessionRowKey(selectedPreset.id, row, index) === expanded.rowKey)
    const row = indexedRow?.row
    if (row === undefined || !matchesSession(row, nextQuery, locale)) setExpanded(null)
  }

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest((value) => value + 1)
  }

  const selectPreset = (value: string): void => {
    setSelectedId(value)
    setExpanded(null)
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
          {selectedPreset === undefined ? null : (
            <div className="dsh-plugin-inventory__mode-selector">
              <label htmlFor={modeSelectId}>{t('plugins.inventory.chooseAgentMode')}</label>
              <SelectMenu
                id={modeSelectId}
                className="dsh-plugin-inventory__mode-picker"
                icon="sparkles"
                density="regular"
                label={presetChoiceLabel(selectedPreset, t)}
                ariaLabel={t('plugins.inventory.chooseAgentMode')}
                title={t('plugins.inventory.chooseAgentMode')}
                value={selectedPreset.id}
                options={presets.map((preset) => ({
                  value: preset.id,
                  label: presetChoiceLabel(preset, t),
                }))}
                onChange={selectPreset}
              />
            </div>
          )}
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

          {selectedPreset === undefined ? null : (
            <section
              className="dsh-plugin-inventory__group"
              data-plugin-scope="session"
              data-agent-preset-id={selectedPreset.id}
              aria-labelledby={sessionHeadingId}
            >
              <div className="dsh-plugin-inventory__heading">
                <h3 id={sessionHeadingId}>
                  <GroupToggle
                    open={openGroupsInEffect.has('session')}
                    onToggle={() => toggleGroup('session')}
                    bodyId={sessionBodyId}
                    label={t('plugins.inventory.session')}
                  />
                </h3>
                <span
                  data-plugin-count={filteredSession.length}
                  data-plugin-total={sessionRows.length}
                  aria-label={countLabel(filteredSession.length, sessionRows.length, searching, t)}
                >
                  {countLabel(filteredSession.length, sessionRows.length, searching, t)}
                </span>
              </div>
              {selectedPreset.broken === undefined ? null : <p role="alert">{selectedPreset.broken}</p>}
              {openGroupsInEffect.has('session') ? (
                <div className="dsh-plugin-inventory__group-body" id={sessionBodyId}>
                  <code className="dsh-plugin-inventory__preset-id">{selectedPreset.id}</code>
                  {sessionRows.length === 0 && selectedPreset.broken === undefined ? (
                    <p className="dsh-settings__empty">{t('plugins.inventory.sessionEmpty')}</p>
                  ) : null}
                  {filteredSession.length > 0 ? (
                    <ul className="dsh-plugin-inventory__cards">
                      {filteredSession.map(({ row, index }) => {
                        const rowKey = sessionRowKey(selectedPreset.id, row, index)
                        const isExpanded =
                          expanded?.scope === 'session' &&
                          expanded.presetId === selectedPreset.id &&
                          expanded.rowKey === rowKey
                        return (
                          <PluginCard
                            key={rowKey}
                            cardId={rowKey}
                            entry={row}
                            scope="session"
                            expanded={isExpanded}
                            onToggle={() => {
                              setExpanded(
                                isExpanded ? null : { scope: 'session', presetId: selectedPreset.id, rowKey },
                              )
                            }}
                            detailId={`${catalogId}-details-${encodeURIComponent(rowKey)}`}
                            locale={locale}
                            t={t}
                          />
                        )
                      })}
                    </ul>
                  ) : null}
                  {otherMatchCount > 0 ? (
                    <div className="dsh-plugin-inventory__preset-search-matches">
                      <p className="dsh-plugin-inventory__preset-search-note" role="status">
                        {t('plugins.inventory.otherPresetMatches', { count: otherMatchCount })}
                      </p>
                      <ul className="dsh-plugin-inventory__preset-search-links">
                        {otherPresetMatches.map(({ preset, rows }) => (
                          <li key={preset.id}>
                            <button
                              className="dsh-button dsh-button--secondary dsh-button--compact"
                              type="button"
                              data-agent-preset-id={preset.id}
                              aria-label={t('plugins.inventory.viewPresetMatches', {
                                name: presetName(preset, t),
                              })}
                              onClick={() => selectPreset(preset.id)}
                            >
                              {t('plugins.inventory.viewPresetMatches', {
                                name: `${presetName(preset, t)} (${rows.length})`,
                              })}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          )}

          <section
            className="dsh-plugin-inventory__group"
            data-plugin-scope="global"
            aria-labelledby={globalHeadingId}
          >
            <div className="dsh-plugin-inventory__heading">
              <h3 id={globalHeadingId}>
                <GroupToggle
                  open={openGroupsInEffect.has('global')}
                  onToggle={() => toggleGroup('global')}
                  bodyId={globalBodyId}
                  label={t('plugins.inventory.global')}
                />
              </h3>
              {snapshot?.managementAvailable === undefined ? null : (
                <span>
                  {t(
                    snapshot.managementAvailable
                      ? 'plugins.managementInDsh'
                      : 'plugins.managementUnavailable',
                  )}
                </span>
              )}
              <span
                data-plugin-count={filteredGlobal.length}
                data-plugin-total={globalEntries.length}
                aria-label={countLabel(filteredGlobal.length, globalEntries.length, searching, t)}
              >
                {countLabel(filteredGlobal.length, globalEntries.length, searching, t)}
              </span>
            </div>
            {openGroupsInEffect.has('global') ? (
              <div className="dsh-plugin-inventory__group-body" id={globalBodyId}>
                {globalEntries.length === 0 ? (
                  <p className="dsh-settings__empty">{t('plugins.empty')}</p>
                ) : null}
                {filteredGlobal.length > 0 ? (
                  <ul className="dsh-plugin-inventory__cards">
                    {filteredGlobal.map((entry) => {
                      const isExpanded = expanded?.scope === 'global' && expanded.entryId === entry.entryId
                      return (
                        <PluginCard
                          key={entry.entryId}
                          cardId={entry.entryId}
                          entry={entry}
                          scope="global"
                          expanded={isExpanded}
                          onToggle={() => {
                            setExpanded(isExpanded ? null : { scope: 'global', entryId: entry.entryId })
                          }}
                          detailId={`${catalogId}-details-${encodeURIComponent(`global:${entry.entryId}`)}`}
                          locale={locale}
                          t={t}
                        />
                      )
                    })}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </section>
          {searching && resultCount === 0 ? (
            <p className="dsh-settings__empty" role="status">
              {t('plugins.noMatch')}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
