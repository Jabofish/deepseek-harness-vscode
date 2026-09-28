import {
  type ManagedPluginEntry,
  type PluginManagerBundle,
  type PluginManagerSnapshot,
  type PluginInstallProgressView,
  type PluginSpecInspection,
} from '@dsh-vscode/domain'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import type { PluginInstallInput, PluginInstallRecoveryState } from '../../app/plugin-install-recovery.js'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { SelectMenu } from '../../components/common/SelectMenu.js'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import {
  canRecoverGithubInstall,
  catalogOf,
  inspectionOf,
  localizedSearchValues,
  matchesSearch,
  newRequestId,
  pluginSearchValues,
  registryChoices,
  registryFromValue,
  registryOptions,
  registryValue,
  resultOf,
  resultText,
  registriesOf,
  isValidRegistry,
  CONFIGURED_REGISTRY,
  CUSTOM_REGISTRY,
  type RegistryView,
} from './optional-bundle-model.js'
import { BundleCard, PluginRow, type Notice } from './optional-bundle-cards.js'
import './optional-bundle-manager.css'

export interface OptionalBundleManagerProps {
  readonly revision?: number
  readonly installProgress?: PluginInstallProgressView | undefined
  readonly installOperation?: PluginInstallRecoveryState | undefined
  readonly onStartInstall?: (input: PluginInstallInput) => Promise<void>
  readonly onCancelInstall?: () => Promise<void>
  readonly onRecoverInstall?: () => Promise<void>
  readonly featureRequest: <T>(request: FeatureRequest) => Promise<T>
}

type CatalogLoadState = {
  readonly revision: number | undefined
  readonly refreshToken: number
  readonly status: 'ready' | 'failed'
}

interface FilteredBundle {
  readonly bundle: PluginManagerBundle
  readonly rows: PluginManagerBundle['rows']
  readonly expandForSearch: boolean
}

const EMPTY_BUNDLES: readonly PluginManagerBundle[] = []
const EMPTY_PLUGINS: readonly ManagedPluginEntry[] = []
const EMPTY_OPEN_BUNDLES: ReadonlySet<string> = new Set()
const STANDALONE_BODY_ID = 'dsh-plugin-standalone-plugins'
const SECTION_BODY_ID = 'dsh-plugin-manager-body'

/** RC2 profile Plugin Manager backed only by the live Plugin Manager Remotes. */
export function OptionalBundleManager(props: OptionalBundleManagerProps): ReactElement {
  const { t, locale } = useI18n()
  const [catalog, setCatalog] = useState<PluginManagerSnapshot>()
  const [registryView, setRegistryView] = useState<RegistryView>({
    catalog: null,
    selected: CONFIGURED_REGISTRY,
    custom: '',
  })
  const [catalogLoadState, setCatalogLoadState] = useState<CatalogLoadState>()
  const [refreshToken, setRefreshToken] = useState(0)
  const [sectionOpen, setSectionOpen] = useState(false)
  const [openBundles, setOpenBundles] = useState<ReadonlySet<string>>(EMPTY_OPEN_BUNDLES)
  const [standaloneOpen, setStandaloneOpen] = useState(false)
  const [busyKey, setBusyKey] = useState<string>()
  const [notice, setNotice] = useState<Notice>()
  const [searchText, setSearchText] = useState('')
  const [spec, setSpec] = useState('')
  const specInputRef = useRef<HTMLInputElement>(null)
  const [dismissedRecoveryRequestId, setDismissedRecoveryRequestId] = useState<string>()
  const [inspection, setInspection] = useState<PluginSpecInspection>()
  const [checking, setChecking] = useState(false)
  const [collapsedSearchBundles, setCollapsedSearchBundles] = useState<{
    readonly query: string
    readonly names: ReadonlySet<string>
  }>({ query: '', names: EMPTY_OPEN_BUNDLES })
  const installOperation = props.installOperation
  const installBusy = installOperation !== undefined && installOperation.phase !== 'settled'
  const pendingBuilds = installOperation?.result?.pendingBuilds ?? []
  const matchingInstallProgress =
    installOperation !== undefined && props.installProgress?.requestId === installOperation.requestId
      ? props.installProgress
      : undefined
  const displayedInstallPhase =
    installOperation?.phase === 'unknown' || installOperation?.phase === 'settled'
      ? installOperation.phase
      : (matchingInstallProgress?.phase ?? installOperation?.phase)
  const currentCatalogLoadState =
    catalogLoadState !== undefined &&
    catalogLoadState.revision === props.revision &&
    catalogLoadState.refreshToken === refreshToken
      ? catalogLoadState
      : undefined
  const loading = currentCatalogLoadState === undefined
  const loadFailed = currentCatalogLoadState?.status === 'failed'
  // A running install must never be hidden behind the collapsed section.
  const sectionRevealed = sectionOpen || installBusy

  useEffect(() => {
    let current = true
    void Promise.all([
      props.featureRequest<unknown>({ type: 'plugin.bundles.list', requestId: newRequestId(), payload: {} }),
      props.featureRequest<unknown>({
        type: 'plugin.registries.list',
        requestId: newRequestId(),
        payload: {},
      }),
    ])
      .then(([rawCatalog, rawRegistries]) => {
        if (!current) return
        const next = catalogOf(rawCatalog)
        if (next === undefined) throw new Error('malformed catalog')
        setCatalog(next)
        const registries = registriesOf(rawRegistries)
        setRegistryView((previous) => ({
          catalog: registries,
          selected:
            previous.selected === CUSTOM_REGISTRY
              ? previous.selected
              : registryValue(registries?.registry ?? null),
          custom: previous.custom,
        }))
        setCatalogLoadState({ revision: props.revision, refreshToken, status: 'ready' })
      })
      .catch(() => {
        if (current) setCatalogLoadState({ revision: props.revision, refreshToken, status: 'failed' })
      })
    return () => {
      current = false
    }
    // This read is explicit (mount/retry/invalidation); ordinary parent renders must not poll DSH.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.revision, refreshToken])

  const bundles = useMemo(() => catalog?.bundles ?? EMPTY_BUNDLES, [catalog])
  const plugins = catalog?.plugins ?? EMPTY_PLUGINS
  const normalizedSearch = searchText.trim().toLocaleLowerCase(locale)
  const searching = normalizedSearch.length > 0
  const pluginsByEntryId = useMemo(
    () => new Map(plugins.map((plugin) => [plugin.entryId, plugin] as const)),
    [plugins],
  )
  const filteredBundles = useMemo<readonly FilteredBundle[]>(
    () =>
      bundles.flatMap((bundle) => {
        const bundleMatches = matchesSearch(normalizedSearch, locale, [
          bundle.name,
          bundle.version,
          ...localizedSearchValues(bundle.title),
          ...localizedSearchValues(bundle.description),
        ])
        if (!searching) return [{ bundle, rows: bundle.rows, expandForSearch: false }]

        const matchingRows = bundle.rows.filter((row) => {
          const plugin = row.entryId === undefined ? undefined : pluginsByEntryId.get(row.entryId)
          return matchesSearch(normalizedSearch, locale, [
            row.rowId,
            row.moduleName,
            row.entryId,
            ...localizedSearchValues(row.meta?.title),
            ...localizedSearchValues(row.meta?.description),
            ...(plugin === undefined ? [] : pluginSearchValues(plugin)),
          ])
        })
        if (!bundleMatches && matchingRows.length === 0) return []
        return [
          {
            bundle,
            rows: bundleMatches ? bundle.rows : matchingRows,
            expandForSearch: !bundleMatches && matchingRows.length > 0,
          },
        ]
      }),
    [bundles, locale, normalizedSearch, pluginsByEntryId, searching],
  )
  const linkedEntryIds = useMemo(
    () =>
      new Set(
        bundles.flatMap((bundle) =>
          bundle.rows.flatMap((row) => (row.entryId === undefined ? [] : [row.entryId])),
        ),
      ),
    [bundles],
  )
  const standalonePlugins = useMemo(
    () => plugins.filter((plugin) => !linkedEntryIds.has(plugin.entryId)),
    [linkedEntryIds, plugins],
  )
  const filteredStandalonePlugins = useMemo(
    () =>
      standalonePlugins.filter((plugin) =>
        matchesSearch(normalizedSearch, locale, pluginSearchValues(plugin)),
      ),
    [locale, normalizedSearch, standalonePlugins],
  )
  const availableRegistries = registryOptions(registryView.catalog)
  const registryMenuOptions = registryChoices(availableRegistries, registryView, t, locale)
  const registryMenuLabel =
    registryMenuOptions.find((option) => option.value === registryView.selected)?.label ??
    t('plugins.manager.registry.label')
  const selectedRegistry =
    registryView.selected === CUSTOM_REGISTRY
      ? isValidRegistry(registryView.custom)
        ? registryView.custom
        : undefined
      : registryFromValue(registryView.selected)
  const registryError =
    registryView.selected === CUSTOM_REGISTRY &&
    selectedRegistry === undefined &&
    registryView.custom.trim() !== ''

  const retry = (): void => {
    setCatalog(undefined)
    setRefreshToken((value) => value + 1)
  }

  const toggleBundle = (name: string): void => {
    setOpenBundles((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const toggleSearchExpandedBundle = (name: string): void => {
    setCollapsedSearchBundles((current) => {
      const names = current.query === normalizedSearch ? current.names : EMPTY_OPEN_BUNDLES
      const next = new Set(names)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return { query: normalizedSearch, names: next }
    })
  }

  const loadInspection = async (): Promise<void> => {
    const value = spec.trim()
    if (value === '' || checking || busyKey !== undefined || installBusy) return
    if (selectedRegistry === undefined && registryView.selected === CUSTOM_REGISTRY) {
      setNotice({ kind: 'message', key: 'plugins.manager.registry.invalid' })
      return
    }
    setChecking(true)
    setInspection(undefined)
    setNotice(undefined)
    try {
      const response = await props.featureRequest<unknown>({
        type: 'plugin.spec.inspect',
        requestId: newRequestId(),
        payload: { spec: value, ...(selectedRegistry === undefined ? {} : { registry: selectedRegistry }) },
      })
      const answer = inspectionOf(response)
      if (answer === undefined) throw new Error('malformed inspection')
      setInspection(answer)
    } catch {
      setNotice({ kind: 'message', key: 'plugins.manager.inspect.failed' })
    } finally {
      setChecking(false)
    }
  }

  const runInstall = async (approved?: readonly string[]): Promise<void> => {
    if (busyKey !== undefined || installBusy || props.onStartInstall === undefined) return
    const value = spec.trim()
    if (value === '' || (selectedRegistry === undefined && registryView.selected === CUSTOM_REGISTRY)) return
    setNotice(undefined)
    setInspection(undefined)
    setDismissedRecoveryRequestId(undefined)
    await props.onStartInstall({
      spec: value,
      ...(selectedRegistry === undefined ? {} : { registry: selectedRegistry }),
      ...(approved === undefined ? {} : { approvedBuilds: [...approved] }),
    })
  }

  const cancelInstall = async (): Promise<void> => {
    const recoveryWaitCanBeCancelled = installOperation?.phase === 'unknown' && installOperation.waiting
    if (
      installOperation === undefined ||
      !installBusy ||
      installOperation.cancelRequested ||
      installOperation.phase === 'applying' ||
      installOperation.cancellation === 'cancelled' ||
      installOperation.cancellation === 'too-late' ||
      (installOperation.phase === 'unknown' && !recoveryWaitCanBeCancelled) ||
      (installOperation.waiting && !recoveryWaitCanBeCancelled)
    )
      return
    await props.onCancelInstall?.()
  }

  const applyChange = async (
    key: string,
    request: FeatureRequest,
    expectedEnabled?: boolean,
  ): Promise<void> => {
    if (busyKey !== undefined || installBusy) return
    setBusyKey(key)
    setNotice(undefined)
    try {
      const result = resultOf(await props.featureRequest<unknown>(request))
      if (result === undefined || (expectedEnabled !== undefined && result.enabled !== expectedEnabled))
        throw new Error('malformed change result')
      setNotice({ kind: 'result', result })
      setRefreshToken((value) => value + 1)
    } catch {
      setNotice({ kind: 'message', key: 'plugins.manager.change.uncertain' })
      setRefreshToken((value) => value + 1)
    } finally {
      setBusyKey(undefined)
    }
  }

  const setBundle = (bundle: PluginManagerBundle, enabled: boolean): void => {
    void applyChange(
      bundle.name,
      {
        type: 'plugin.bundle.setEnabled',
        requestId: newRequestId(),
        payload: { name: bundle.name, enabled },
      },
      enabled,
    )
  }

  const setPlugin = (plugin: ManagedPluginEntry, enabled: boolean): void => {
    void applyChange(
      plugin.entryId,
      {
        type: 'plugin.entry.setEnabled',
        requestId: newRequestId(),
        payload: { entryId: plugin.entryId, enabled },
      },
      enabled,
    )
  }

  const removeBundle = (bundle: PluginManagerBundle): void => {
    void applyChange(bundle.name, {
      type: 'plugin.bundle.remove',
      requestId: newRequestId(),
      payload: { name: bundle.name },
    })
  }

  const recoverGithubInstall = (): void => {
    if (
      installOperation === undefined ||
      installOperation.result === undefined ||
      !canRecoverGithubInstall(installOperation.result)
    )
      return
    setDismissedRecoveryRequestId(installOperation.requestId)
    setSpec('')
    setInspection(undefined)
    setNotice(undefined)
    specInputRef.current?.focus()
  }

  const installEnabled =
    inspection?.status === 'accepted' &&
    inspection.bundle !== false &&
    spec.trim() !== '' &&
    !checking &&
    busyKey === undefined &&
    !installBusy &&
    props.onStartInstall !== undefined &&
    !(registryView.selected === CUSTOM_REGISTRY && selectedRegistry === undefined)
  const recoveryWaitCanBeCancelled = installOperation?.phase === 'unknown' && installOperation.waiting

  return (
    <section className="dsh-optional-bundles" aria-labelledby="dsh-optional-bundles-title">
      <header className="dsh-optional-bundles__heading">
        <h2 id="dsh-optional-bundles-title">
          <button
            className="dsh-optional-bundles__section-toggle"
            type="button"
            aria-expanded={sectionRevealed}
            aria-controls={sectionRevealed ? SECTION_BODY_ID : undefined}
            disabled={installBusy}
            onClick={() => setSectionOpen((current) => !current)}
          >
            <Icon name={sectionRevealed ? 'chevron-down' : 'chevron-right'} />
            <span>{t('plugins.bundles.title')}</span>
          </button>
        </h2>
        <div className="dsh-optional-bundles__heading-actions">
          {bundles.length === 0 ? null : (
            <span className="dsh-optional-bundles__entry-count">
              {t('plugins.manager.entryCount', { count: bundles.length })}
            </span>
          )}
          <button
            className="dsh-button dsh-button--secondary dsh-button--compact"
            type="button"
            onClick={retry}
          >
            {t('plugins.bundles.refresh')}
          </button>
        </div>
      </header>

      {loading ? (
        <p className="dsh-optional-bundles__muted" role="status">
          {t('plugins.manager.loading')}
        </p>
      ) : null}
      {loadFailed ? (
        <div className="dsh-optional-bundles__notice" role="alert">
          <span>{t('plugins.bundles.loadFailed')}</span>
          <button
            className="dsh-button dsh-button--secondary dsh-button--compact"
            type="button"
            onClick={retry}
          >
            {t('plugins.bundles.retry')}
          </button>
        </div>
      ) : null}
      {!loading && !loadFailed && catalog?.available !== true ? (
        <p className="dsh-optional-bundles__muted">{t('plugins.bundles.unavailable')}</p>
      ) : null}

      {sectionRevealed ? (
        <div className="dsh-optional-bundles__section-body" id={SECTION_BODY_ID}>
          <p>{t('plugins.manager.description')}</p>
          <p className="dsh-optional-bundles__muted">{t('plugins.bundles.scopeNotice')}</p>
          <p className="dsh-optional-bundles__muted">{t('plugins.bundles.restartNotice')}</p>
          {!loading && !loadFailed && catalog?.available === true ? (
            <>
              <section className="dsh-plugin-manager__install" aria-labelledby="dsh-plugin-install-title">
                <h3 id="dsh-plugin-install-title">{t('plugins.manager.install.title')}</h3>
                <label>
                  <span>{t('plugins.manager.install.spec')}</span>
                  <input
                    ref={specInputRef}
                    type="text"
                    autoComplete="off"
                    maxLength={4_096}
                    value={spec}
                    disabled={checking || busyKey !== undefined || installBusy}
                    placeholder={t('plugins.manager.install.placeholder')}
                    onChange={(event) => {
                      setSpec(event.currentTarget.value)
                      setInspection(undefined)
                      setDismissedRecoveryRequestId(installOperation?.requestId)
                    }}
                  />
                </label>
                <div className="dsh-plugin-manager__registry">
                  <label>
                    <span>{t('plugins.manager.registry.label')}</span>
                    <SelectMenu
                      className="dsh-plugin-manager__registry-picker"
                      icon="box"
                      density="regular"
                      label={registryMenuLabel}
                      ariaLabel={t('plugins.manager.registry.label')}
                      title={t('plugins.manager.registry.label')}
                      value={registryView.selected}
                      options={registryMenuOptions}
                      disabled={checking || busyKey !== undefined || installBusy}
                      onChange={(selected) => {
                        setRegistryView((previous) => ({ ...previous, selected }))
                        setInspection(undefined)
                        setDismissedRecoveryRequestId(installOperation?.requestId)
                      }}
                    />
                  </label>
                  {registryView.selected === CUSTOM_REGISTRY ? (
                    <label>
                      <span>{t('plugins.manager.registry.customUrl')}</span>
                      <input
                        type="url"
                        autoComplete="off"
                        value={registryView.custom}
                        disabled={checking || busyKey !== undefined || installBusy}
                        onChange={(event) => {
                          setRegistryView((previous) => ({ ...previous, custom: event.currentTarget.value }))
                          setInspection(undefined)
                        }}
                      />
                    </label>
                  ) : null}
                </div>
                {registryError ? (
                  <p className="dsh-optional-bundles__warning" role="alert">
                    {t('plugins.manager.registry.invalid')}
                  </p>
                ) : null}
                <div className="dsh-optional-bundles__confirm-actions">
                  <button
                    className="dsh-button dsh-button--secondary dsh-button--compact"
                    type="button"
                    disabled={
                      spec.trim() === '' || checking || busyKey !== undefined || installBusy || registryError
                    }
                    onClick={() => void loadInspection()}
                  >
                    {checking ? t('plugins.manager.inspect.checking') : t('plugins.manager.inspect.action')}
                  </button>
                  {!installBusy ? (
                    <button
                      className="dsh-button dsh-button--primary dsh-button--compact"
                      type="button"
                      disabled={!installEnabled}
                      onClick={() => void runInstall()}
                    >
                      {t('plugins.manager.install.action')}
                    </button>
                  ) : installOperation?.phase === 'unknown' && !recoveryWaitCanBeCancelled ? null : (
                    <button
                      className="dsh-button dsh-button--secondary dsh-button--compact"
                      type="button"
                      disabled={
                        (installOperation?.waiting === true && !recoveryWaitCanBeCancelled) ||
                        installOperation?.cancelRequested === true ||
                        installOperation?.phase === 'applying' ||
                        installOperation?.cancellation === 'cancelled' ||
                        installOperation?.cancellation === 'too-late' ||
                        displayedInstallPhase === 'cancelling' ||
                        displayedInstallPhase === 'applying' ||
                        props.onCancelInstall === undefined
                      }
                      onClick={() => void cancelInstall()}
                    >
                      {t(
                        displayedInstallPhase === 'cancelling' || installOperation?.cancelRequested
                          ? 'plugins.manager.install.cancelling'
                          : displayedInstallPhase === 'applying'
                            ? 'plugins.manager.install.applying'
                            : 'plugins.manager.install.cancel',
                      )}
                    </button>
                  )}
                </div>
                {inspection?.status === 'accepted' ? (
                  <div className="dsh-optional-bundles__notice" role="status">
                    <span>
                      {t('plugins.manager.inspect.accepted', {
                        name: inspection.name ?? t('plugins.manager.inspect.unnamed'),
                      })}
                      {inspection.version === undefined ? '' : ` · ${inspection.version}`}
                    </span>
                    {inspection.description === undefined ? null : <span>{inspection.description}</span>}
                    {inspection.bundle === false ? (
                      <span>{t('plugins.manager.inspect.notBundle')}</span>
                    ) : null}
                  </div>
                ) : inspection?.status === 'refused' ? (
                  <p
                    className="dsh-optional-bundles__notice dsh-optional-bundles__notice--error"
                    role="alert"
                  >
                    {t(`plugins.manager.inspect.problem.${inspection.problem}`)}
                  </p>
                ) : null}
                {installBusy && installOperation !== undefined ? (
                  <p className="dsh-optional-bundles__muted" role="status">
                    {displayedInstallPhase === 'installing' &&
                    matchingInstallProgress?.attemptIndex !== undefined &&
                    matchingInstallProgress.attemptTotal !== undefined
                      ? t('plugins.manager.install.attempt', {
                          current: matchingInstallProgress.attemptIndex,
                          total: matchingInstallProgress.attemptTotal,
                        })
                      : t(
                          installOperation.phase === 'unknown'
                            ? 'plugins.manager.install.unknown'
                            : displayedInstallPhase === 'cancelling'
                              ? 'plugins.manager.install.cancelling'
                              : displayedInstallPhase === 'applying'
                                ? 'plugins.manager.install.applying'
                                : 'plugins.manager.install.running',
                        )}
                  </p>
                ) : null}
                {installBusy && installOperation?.waiting === true ? (
                  <p className="dsh-optional-bundles__muted" role="status">
                    {t('plugins.manager.install.recovering')}
                  </p>
                ) : null}
                {installOperation?.phase === 'unknown' || installOperation?.phase === 'applying' ? (
                  <button
                    className="dsh-button dsh-button--secondary dsh-button--compact"
                    type="button"
                    disabled={installOperation.waiting}
                    onClick={() => void props.onRecoverInstall?.()}
                  >
                    {installOperation.waiting
                      ? t('plugins.manager.install.recovering')
                      : t('plugins.manager.install.recover')}
                  </button>
                ) : null}
                {installOperation?.phase === 'settled' &&
                installOperation.result !== undefined &&
                dismissedRecoveryRequestId !== installOperation.requestId ? (
                  <div
                    className={`dsh-optional-bundles__notice${installOperation.result.application === 'failed' ? ' dsh-optional-bundles__notice--error' : ''}`}
                    role={installOperation.result.application === 'failed' ? 'alert' : 'status'}
                  >
                    <span>{resultText(t, installOperation.result)}</span>
                    {canRecoverGithubInstall(installOperation.result) ? (
                      <button
                        className="dsh-button dsh-button--secondary dsh-button--compact"
                        type="button"
                        onClick={recoverGithubInstall}
                      >
                        {locale === 'zh' ? '试试其他方式' : 'Try another way'}
                      </button>
                    ) : null}
                  </div>
                ) : installOperation?.cancellation === 'cancelled' ? (
                  <p className="dsh-optional-bundles__notice" role="status">
                    {t('plugins.bundles.result.cancelled')}
                  </p>
                ) : null}
                {pendingBuilds.length > 0 ? (
                  <div className="dsh-optional-bundles__warning" role="status">
                    <p>{t('plugins.manager.install.buildApproval', { names: pendingBuilds.join(', ') })}</p>
                    <button
                      className="dsh-button dsh-button--secondary dsh-button--compact"
                      type="button"
                      disabled={busyKey !== undefined}
                      onClick={() => void runInstall(pendingBuilds)}
                    >
                      {t('plugins.manager.install.approveRetry')}
                    </button>
                  </div>
                ) : null}
              </section>

              {notice?.kind === 'message' ? (
                <p className="dsh-optional-bundles__notice dsh-optional-bundles__notice--error" role="alert">
                  {t(notice.key)}
                </p>
              ) : notice?.kind === 'result' ? (
                <p
                  className={`dsh-optional-bundles__notice${notice.result.application === 'failed' ? ' dsh-optional-bundles__notice--error' : ''}`}
                  role={notice.result.application === 'failed' ? 'alert' : 'status'}
                >
                  {resultText(t, notice.result)}
                </p>
              ) : null}

              <label className="dsh-plugin-manager__search">
                <Icon name="search" />
                <span>{t('plugins.search')}</span>
                <input
                  type="search"
                  value={searchText}
                  aria-label={t('plugins.search')}
                  onChange={(event) => setSearchText(event.currentTarget.value)}
                />
              </label>

              {searching && filteredBundles.length === 0 && filteredStandalonePlugins.length === 0 ? (
                <p className="dsh-optional-bundles__muted" role="status">
                  {t('plugins.noMatch')}
                </p>
              ) : null}

              {!searching && bundles.length === 0 ? (
                <p className="dsh-optional-bundles__muted">{t('plugins.bundles.empty')}</p>
              ) : filteredBundles.length > 0 ? (
                <ul className="dsh-optional-bundles__list" aria-label={t('plugins.bundles.listAria')}>
                  {filteredBundles.map((filtered) => {
                    const { bundle, rows, expandForSearch } = filtered
                    const collapsed =
                      collapsedSearchBundles.query === normalizedSearch &&
                      collapsedSearchBundles.names.has(bundle.name)
                    return (
                      <BundleCard
                        key={bundle.name}
                        bundle={bundle}
                        rows={rows}
                        open={expandForSearch ? !collapsed : openBundles.has(bundle.name)}
                        notice={notice}
                        plugins={plugins}
                        busyKey={busyKey}
                        installBusy={installBusy}
                        onSetPlugin={setPlugin}
                        onToggle={() =>
                          expandForSearch
                            ? toggleSearchExpandedBundle(bundle.name)
                            : toggleBundle(bundle.name)
                        }
                        onSetBundle={setBundle}
                        onRemoveBundle={removeBundle}
                      />
                    )
                  })}
                </ul>
              ) : null}

              {filteredStandalonePlugins.length > 0 ? (
                <section
                  className="dsh-plugin-manager__standalone"
                  aria-labelledby="dsh-plugin-standalone-title"
                >
                  <h3 id="dsh-plugin-standalone-title">
                    {searching ? (
                      <span>{t('plugins.manager.plugin.standalone')}</span>
                    ) : (
                      <button
                        className="dsh-plugin-manager__standalone-toggle"
                        type="button"
                        aria-expanded={standaloneOpen}
                        aria-controls={standaloneOpen ? STANDALONE_BODY_ID : undefined}
                        onClick={() => setStandaloneOpen((current) => !current)}
                      >
                        <Icon name={standaloneOpen ? 'chevron-down' : 'chevron-right'} />
                        <span>{t('plugins.manager.plugin.standalone')}</span>
                      </button>
                    )}
                    <span className="dsh-optional-bundles__entry-count">
                      {t('plugins.manager.entryCount', { count: filteredStandalonePlugins.length })}
                    </span>
                  </h3>
                  {searching || standaloneOpen ? (
                    <ul className="dsh-optional-bundles__plugins" id={STANDALONE_BODY_ID}>
                      {filteredStandalonePlugins.map((plugin) => (
                        <PluginRow
                          key={`${plugin.entryId}:${plugin.entryId}`}
                          entryId={plugin.entryId}
                          moduleName={plugin.moduleName}
                          meta={plugin.meta}
                          plugins={plugins}
                          busyKey={busyKey}
                          installBusy={installBusy}
                          onSetPlugin={setPlugin}
                        />
                      ))}
                    </ul>
                  ) : null}
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
