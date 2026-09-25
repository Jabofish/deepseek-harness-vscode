import {
  pluginLocalizedText,
  type ManagedPluginEntry,
  type PluginBundleChangeResult,
  type PluginManagerBundle,
  type PluginManagerSnapshot,
  type PluginInstallProgressView,
  type PluginRegistry,
  type PluginRegistryCatalog,
  type PluginSpecInspection,
} from '@dsh-vscode/domain'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import type { PluginInstallInput, PluginInstallRecoveryState } from '../../app/plugin-install-recovery.js'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { SelectMenu, type SelectMenuOption } from '../../components/common/SelectMenu.js'
import { useI18n, type Translate } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
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

interface RegistryView {
  readonly catalog: PluginRegistryCatalog | null
  readonly selected: string
  readonly custom: string
}

type Notice =
  | { readonly kind: 'result'; readonly result: PluginBundleChangeResult }
  | { readonly kind: 'message'; readonly key: string }

type CatalogLoadState = {
  readonly revision: number | undefined
  readonly refreshToken: number
  readonly status: 'ready' | 'failed'
}

const EMPTY_BUNDLES: readonly PluginManagerBundle[] = []
const EMPTY_OPEN_BUNDLES: ReadonlySet<string> = new Set()
const STANDALONE_BODY_ID = 'dsh-plugin-standalone-plugins'
const SECTION_BODY_ID = 'dsh-plugin-manager-body'

let requestOrdinal = 0

function newRequestId(): string {
  requestOrdinal += 1
  return `plugin-manager-${Date.now().toString(36)}-${requestOrdinal.toString(36)}`
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function resultOf(value: unknown): PluginBundleChangeResult | undefined {
  const payload = object(value)
  const result = object(payload?.result)
  if (
    payload?.kind !== 'plugin.bundle.changed' ||
    typeof result?.name !== 'string' ||
    typeof result.changed !== 'boolean' ||
    !['applied', 'restart-required', 'overridden', 'failed', 'cancelled'].includes(String(result.application))
  )
    return undefined
  return result as unknown as PluginBundleChangeResult
}

function catalogOf(value: unknown): PluginManagerSnapshot | undefined {
  const payload = object(value)
  if (
    payload?.kind !== 'plugin.bundles' ||
    typeof payload.available !== 'boolean' ||
    !Array.isArray(payload.bundles) ||
    !Array.isArray(payload.plugins)
  )
    return undefined
  return payload as unknown as PluginManagerSnapshot
}

function registriesOf(value: unknown): PluginRegistryCatalog | null {
  const payload = object(value)
  if (payload?.kind !== 'plugin.registries' || payload.available !== true) return null
  const registries = object(payload.registries)
  if (
    registries === undefined ||
    !(registries.registry === null || typeof registries.registry === 'string') ||
    !Array.isArray(registries.fallbackRegistries) ||
    !registries.fallbackRegistries.every((entry) => typeof entry === 'string') ||
    !(registries.resolved === null || typeof registries.resolved === 'string')
  )
    return null
  return registries as unknown as PluginRegistryCatalog
}

function inspectionOf(value: unknown): PluginSpecInspection | undefined {
  const payload = object(value)
  const inspection = object(payload?.inspection)
  if (payload?.kind !== 'plugin.inspection' || inspection === undefined) return undefined
  if (inspection.status === 'refused' && typeof inspection.problem === 'string')
    return inspection as unknown as PluginSpecInspection
  if (
    inspection.status === 'accepted' &&
    typeof inspection.kind === 'string' &&
    (inspection.bundle === null || typeof inspection.bundle === 'boolean') &&
    (inspection.registry === null || typeof inspection.registry === 'string')
  )
    return inspection as unknown as PluginSpecInspection
  return undefined
}

function localized(
  value: PluginManagerBundle['title'],
  locale: string,
): ReturnType<typeof pluginLocalizedText> {
  return pluginLocalizedText(value, locale)
}

/** Registry picker sentinels: the host's configured default, and a user-supplied URL. */
const CONFIGURED_REGISTRY = '__configured__'
const CUSTOM_REGISTRY = '__custom__'

function registryOptions(catalog: PluginRegistryCatalog | null): readonly PluginRegistry[] {
  if (catalog === null) return [null]
  const values: PluginRegistry[] = [catalog.registry, ...catalog.fallbackRegistries]
  const resolved = catalog.resolved
  return values.filter((value, index) => {
    const key = value ?? resolved ?? ''
    return values.findIndex((candidate) => (candidate ?? resolved ?? '') === key) === index
  })
}

function registryValue(registry: PluginRegistry): string {
  return registry === null ? CONFIGURED_REGISTRY : registry
}

function registryFromValue(value: string): PluginRegistry | undefined {
  return value === CONFIGURED_REGISTRY ? null : value === CUSTOM_REGISTRY ? undefined : value
}

/** The registry menu and its trigger must agree on one label per value. */
function registryChoices(
  registries: readonly PluginRegistry[],
  view: RegistryView,
  t: Translate,
): readonly SelectMenuOption[] {
  return [
    ...registries.map((registry) => ({
      value: registryValue(registry),
      label:
        registry === null
          ? t('plugins.manager.registry.configured', {
              name: view.catalog?.resolved ?? t('plugins.manager.registry.current'),
            })
          : registry,
    })),
    { value: CUSTOM_REGISTRY, label: t('plugins.manager.registry.custom') },
  ]
}

function isValidRegistry(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

function failureKey(result: PluginBundleChangeResult): string {
  if (result.errorCode === 'incompatible-version') return 'plugins.manager.failure.incompatible'
  if (result.errorCode === 'management-required' || result.errorCode === 'unaddressable')
    return 'plugins.manager.failure.protected'
  if (
    result.errorCode === 'not-removable' ||
    result.errorCode === 'bundle-in-use' ||
    result.errorCode === 'stop-profile'
  )
    return 'plugins.manager.failure.inUse'
  if (result.errorCode === 'stale-approval') return 'plugins.manager.failure.staleApproval'
  if (result.failureKind === 'network' || result.failedAt === 'registry' || result.failedAt === 'spec-host')
    return 'plugins.manager.failure.network'
  if (result.failureKind === 'permission') return 'plugins.manager.failure.permission'
  if (result.failureKind === 'build-blocked') return 'plugins.manager.failure.buildBlocked'
  if (result.failureKind === 'disk-full') return 'plugins.manager.failure.diskFull'
  if (result.failureKind === 'timeout') return 'plugins.manager.failure.timeout'
  return 'plugins.manager.failure.generic'
}

function pluginTitle(plugin: ManagedPluginEntry, locale: string): string {
  return localized(plugin.meta?.title, locale) ?? plugin.moduleName
}

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
  const [spec, setSpec] = useState('')
  const [inspection, setInspection] = useState<PluginSpecInspection>()
  const [checking, setChecking] = useState(false)
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
  const plugins = catalog?.plugins ?? []
  const linkedEntryIds = useMemo(
    () =>
      new Set(
        bundles.flatMap((bundle) =>
          bundle.rows.flatMap((row) => (row.entryId === undefined ? [] : [row.entryId])),
        ),
      ),
    [bundles],
  )
  const standalonePlugins = plugins.filter((plugin) => !linkedEntryIds.has(plugin.entryId))
  const availableRegistries = registryOptions(registryView.catalog)
  const registryMenuOptions = registryChoices(availableRegistries, registryView, t)
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

  const resultText = (result: PluginBundleChangeResult): string => {
    if (result.application === 'failed') return t(failureKey(result))
    if (result.application === 'restart-required') return t('plugins.bundles.result.restart')
    if (result.application === 'overridden') return t('plugins.bundles.result.overridden')
    if (result.application === 'cancelled') return t('plugins.bundles.result.cancelled')
    if (!result.changed) return t('plugins.bundles.result.unchanged')
    if (result.stage === 'install') return t('plugins.manager.install.done')
    if (result.stage === 'remove') return t('plugins.manager.remove.done')
    return result.enabled === false
      ? t('plugins.bundles.result.disabled')
      : t('plugins.bundles.result.enabled')
  }

  const renderPluginRow = (
    entryId: string | undefined,
    rowId: string,
    moduleName: string,
    meta?: ManagedPluginEntry['meta'],
  ): ReactElement => {
    const plugin =
      entryId === undefined ? undefined : plugins.find((candidate) => candidate.entryId === entryId)
    const title =
      plugin === undefined ? (localized(meta?.title, locale) ?? moduleName) : pluginTitle(plugin, locale)
    const disabled =
      plugin === undefined || plugin.readOnlyReason !== undefined || busyKey !== undefined || installBusy
    return (
      <li className="dsh-optional-bundles__plugin" key={`${rowId}:${entryId ?? moduleName}`}>
        <span>{title}</span>
        {plugin === undefined ? (
          <span className="dsh-optional-bundles__muted">{t('plugins.manager.plugin.notActive')}</span>
        ) : (
          <button
            className="dsh-button dsh-button--secondary dsh-button--compact"
            type="button"
            aria-pressed={plugin.enabled}
            aria-label={t(plugin.enabled ? 'plugins.bundles.disableNamed' : 'plugins.bundles.enableNamed', {
              name: title,
            })}
            disabled={disabled}
            onClick={() => setPlugin(plugin, !plugin.enabled)}
          >
            {t(plugin.enabled ? 'plugins.bundles.disable' : 'plugins.bundles.enable')}
          </button>
        )}
      </li>
    )
  }

  const renderBundle = (bundle: PluginManagerBundle): ReactElement => {
    const title = localized(bundle.title, locale) ?? bundle.name
    const description = localized(bundle.description, locale)
    const blocked = bundle.readOnlyReason !== undefined || (!bundle.enabled && bundle.errorCode !== undefined)
    const actionDisabled = blocked || busyKey !== undefined || installBusy
    const open = openBundles.has(bundle.name)
    const bodyId = `dsh-bundle-body-${encodeURIComponent(bundle.name)}`
    return (
      <li className="dsh-optional-bundles__item" key={bundle.name} data-open={open ? 'true' : undefined}>
        <div className="dsh-optional-bundles__head">
          <button
            className="dsh-optional-bundles__toggle"
            type="button"
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            onClick={() => toggleBundle(bundle.name)}
          >
            <Icon name={open ? 'chevron-down' : 'chevron-right'} />
            <span className="dsh-optional-bundles__title-row">
              <strong>{title}</strong>
              {bundle.version === undefined ? null : (
                <span className="dsh-optional-bundles__version">{bundle.version}</span>
              )}
              <span
                className={`dsh-optional-bundles__state${bundle.enabled ? ' dsh-optional-bundles__state--enabled' : ''}`}
              >
                {bundle.enabled ? t('plugins.bundles.selected') : t('plugins.bundles.notSelected')}
              </span>
              {bundle.optional ? (
                <span className="dsh-optional-bundles__state">{t('plugins.manager.bundle.optional')}</span>
              ) : null}
              {bundle.rows.length === 0 ? null : (
                <span className="dsh-optional-bundles__entry-count">
                  {t('plugins.manager.entryCount', { count: bundle.rows.length })}
                </span>
              )}
            </span>
          </button>
          <div className="dsh-optional-bundles__actions">
            <button
              className="dsh-button dsh-button--secondary dsh-button--compact"
              type="button"
              aria-pressed={bundle.enabled}
              aria-label={t(bundle.enabled ? 'plugins.bundles.disableNamed' : 'plugins.bundles.enableNamed', {
                name: title,
              })}
              disabled={actionDisabled}
              onClick={() => setBundle(bundle, !bundle.enabled)}
            >
              {t(bundle.enabled ? 'plugins.bundles.disable' : 'plugins.bundles.enable')}
            </button>
            {bundle.removable ? (
              <button
                className="dsh-button dsh-button--secondary dsh-button--compact"
                type="button"
                aria-label={t('plugins.manager.remove.named', { name: title })}
                disabled={busyKey !== undefined || installBusy}
                onClick={() => removeBundle(bundle)}
              >
                {t('plugins.manager.remove')}
              </button>
            ) : null}
          </div>
        </div>
        {bundle.errorCode === undefined ? null : (
          <p className="dsh-optional-bundles__warning" role="status">
            {t(
              failureKey({
                name: bundle.name,
                changed: false,
                application: 'failed',
                errorCode: bundle.errorCode,
              }),
            )}
          </p>
        )}
        {bundle.readOnlyReason === undefined ? null : (
          <p className="dsh-optional-bundles__warning" role="status">
            {t(
              bundle.readOnlyReason === 'management-required'
                ? 'plugins.bundles.readOnly.management'
                : 'plugins.bundles.readOnly.unaddressable',
            )}
          </p>
        )}
        {busyKey === bundle.name ? (
          <p className="dsh-optional-bundles__muted" role="status">
            {t('plugins.bundles.working')}
          </p>
        ) : null}
        {notice?.kind === 'result' &&
        (notice.result.name === bundle.name || notice.result.bundle === bundle.name) ? (
          <p
            className={`dsh-optional-bundles__notice${notice.result.application === 'failed' ? ' dsh-optional-bundles__notice--error' : ''}`}
            role={notice.result.application === 'failed' ? 'alert' : 'status'}
          >
            {resultText(notice.result)}
          </p>
        ) : null}
        {open ? (
          <div className="dsh-optional-bundles__body" id={bodyId}>
            {description === undefined ? null : <p>{description}</p>}
            <p className="dsh-optional-bundles__muted">
              {t(bundle.installed ? 'plugins.bundles.profileDependency' : 'plugins.bundles.dshProvided')}
            </p>
            {bundle.rows.length === 0 ? null : (
              <ul
                className="dsh-optional-bundles__plugins"
                aria-label={t('plugins.manager.bundle.plugins', { name: title })}
              >
                {bundle.rows.map((row) => renderPluginRow(row.entryId, row.rowId, row.moduleName, row.meta))}
              </ul>
            )}
          </div>
        ) : null}
      </li>
    )
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
                    type="text"
                    autoComplete="off"
                    maxLength={4_096}
                    value={spec}
                    disabled={checking || busyKey !== undefined || installBusy}
                    placeholder={t('plugins.manager.install.placeholder')}
                    onChange={(event) => {
                      setSpec(event.currentTarget.value)
                      setInspection(undefined)
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
                {installOperation?.phase === 'unknown' ? (
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
                {installOperation?.phase === 'settled' && installOperation.result !== undefined ? (
                  <p
                    className={`dsh-optional-bundles__notice${installOperation.result.application === 'failed' ? ' dsh-optional-bundles__notice--error' : ''}`}
                    role={installOperation.result.application === 'failed' ? 'alert' : 'status'}
                  >
                    {resultText(installOperation.result)}
                  </p>
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
                  {resultText(notice.result)}
                </p>
              ) : null}

              {bundles.length === 0 ? (
                <p className="dsh-optional-bundles__muted">{t('plugins.bundles.empty')}</p>
              ) : (
                <ul className="dsh-optional-bundles__list" aria-label={t('plugins.bundles.listAria')}>
                  {bundles.map(renderBundle)}
                </ul>
              )}

              {standalonePlugins.length > 0 ? (
                <section
                  className="dsh-plugin-manager__standalone"
                  aria-labelledby="dsh-plugin-standalone-title"
                >
                  <h3 id="dsh-plugin-standalone-title">
                    <button
                      className="dsh-plugin-manager__standalone-toggle"
                      type="button"
                      aria-expanded={standaloneOpen}
                      aria-controls={standaloneOpen ? STANDALONE_BODY_ID : undefined}
                      onClick={() => setStandaloneOpen((current) => !current)}
                    >
                      <Icon name={standaloneOpen ? 'chevron-down' : 'chevron-right'} />
                      <span>{t('plugins.manager.plugin.standalone')}</span>
                      <span className="dsh-optional-bundles__entry-count">
                        {t('plugins.manager.entryCount', { count: standalonePlugins.length })}
                      </span>
                    </button>
                  </h3>
                  {standaloneOpen ? (
                    <ul className="dsh-optional-bundles__plugins" id={STANDALONE_BODY_ID}>
                      {standalonePlugins.map((plugin) =>
                        renderPluginRow(plugin.entryId, plugin.entryId, plugin.moduleName, plugin.meta),
                      )}
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
