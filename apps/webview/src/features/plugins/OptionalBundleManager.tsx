import {
  pluginLocalizedText,
  type OptionalPluginBundle,
  type PluginBundleChangeResult,
} from '@dsh-vscode/domain'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import { useEffect, useState, type ReactElement } from 'react'

import { useI18n } from '../../i18n.js'
import './optional-bundle-manager.css'

export interface OptionalBundleManagerProps {
  readonly revision?: number
  readonly featureRequest: <T>(request: FeatureRequest) => Promise<T>
}

interface BundleCatalogPayload {
  readonly kind: 'plugin.bundles'
  readonly available: boolean
  readonly bundles: readonly OptionalPluginBundle[]
}

interface BundleChangePayload {
  readonly kind: 'plugin.bundle.changed'
  readonly result: PluginBundleChangeResult
}

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly catalog: BundleCatalogPayload }

type Notice =
  { readonly kind: 'result'; readonly result: PluginBundleChangeResult } | { readonly kind: 'request-failed' }

let requestOrdinal = 0

function newRequestId(): string {
  requestOrdinal += 1
  return `plugin-bundles-${Date.now().toString(36)}-${requestOrdinal.toString(36)}`
}

function responseObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function failureMessageKey(code: PluginBundleChangeResult['errorCode']): string {
  if (code === 'incompatible-version') return 'plugins.bundles.failure.incompatible'
  if (code === 'management-required' || code === 'unaddressable') return 'plugins.bundles.failure.protected'
  if (code === 'unknown-plugin' || code === 'not-bundle') return 'plugins.bundles.failure.missing'
  return 'plugins.bundles.failure.generic'
}

/** Profile-wide optional bundle control, kept separate from the read-only Plugin Inventory. */
export function OptionalBundleManager(props: OptionalBundleManagerProps): ReactElement {
  const { t, locale } = useI18n()
  const { featureRequest, revision } = props
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [refreshToken, setRefreshToken] = useState(0)
  const [busyName, setBusyName] = useState<string>()
  const [notice, setNotice] = useState<Notice>()

  useEffect(() => {
    let current = true
    void Promise.resolve()
      .then(() =>
        featureRequest<BundleCatalogPayload>({
          type: 'plugin.bundles.list',
          requestId: newRequestId(),
          payload: {},
        }),
      )
      .then((value) => {
        if (!current) return
        const payload = responseObject(value)
        if (
          payload?.kind !== 'plugin.bundles' ||
          typeof payload.available !== 'boolean' ||
          !Array.isArray(payload.bundles)
        ) {
          setState({ status: 'error' })
          return
        }
        setState({ status: 'ready', catalog: value })
      })
      .catch(() => {
        if (current) setState({ status: 'error' })
      })
    return () => {
      current = false
    }
  }, [featureRequest, revision, refreshToken])

  const requestChange = async (bundle: OptionalPluginBundle, enabled: boolean): Promise<void> => {
    if (busyName !== undefined) return
    setBusyName(bundle.name)
    setNotice(undefined)
    try {
      const value = await featureRequest<BundleChangePayload>({
        type: 'plugin.bundle.setEnabled',
        requestId: newRequestId(),
        payload: { name: bundle.name, enabled },
      })
      const payload = responseObject(value)
      const result = responseObject(payload?.result)
      if (
        payload?.kind !== 'plugin.bundle.changed' ||
        result?.name !== bundle.name ||
        typeof result.changed !== 'boolean' ||
        result.enabled !== enabled ||
        !['applied', 'restart-required', 'overridden', 'failed', 'cancelled'].includes(
          String(result.application),
        )
      )
        throw new Error('invalid bundle result')
      setNotice({ kind: 'result', result: value.result })
    } catch {
      // The reply may have been lost after DSH applied the profile change. Keep the uncertainty visible and reread.
      setNotice({ kind: 'request-failed' })
    } finally {
      setBusyName(undefined)
      setRefreshToken((value) => value + 1)
    }
  }

  const retry = (): void => {
    setState({ status: 'loading' })
    setRefreshToken((value) => value + 1)
  }

  const resultText = (result: PluginBundleChangeResult): string => {
    if (result.application === 'failed') return t(failureMessageKey(result.errorCode))
    if (result.application === 'restart-required') return t('plugins.bundles.result.restart')
    if (result.application === 'overridden') return t('plugins.bundles.result.overridden')
    if (result.application === 'cancelled') return t('plugins.bundles.result.cancelled')
    if (!result.changed) return t('plugins.bundles.result.unchanged')
    return t(result.enabled === false ? 'plugins.bundles.result.disabled' : 'plugins.bundles.result.enabled')
  }

  return (
    <section className="dsh-optional-bundles" aria-labelledby="dsh-optional-bundles-title">
      <header className="dsh-optional-bundles__heading">
        <div>
          <h2 id="dsh-optional-bundles-title">{t('plugins.bundles.title')}</h2>
          <p>{t('plugins.bundles.description')}</p>
          <p className="dsh-optional-bundles__muted">{t('plugins.bundles.scopeNotice')}</p>
          <p className="dsh-optional-bundles__muted">{t('plugins.bundles.restartNotice')}</p>
        </div>
        <button
          className="dsh-button dsh-button--secondary dsh-button--compact"
          type="button"
          onClick={retry}
        >
          {t('plugins.bundles.refresh')}
        </button>
      </header>

      {state.status === 'loading' ? (
        <p className="dsh-optional-bundles__muted" role="status">
          {t('plugins.bundles.loading')}
        </p>
      ) : state.status === 'error' ? (
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
      ) : !state.catalog.available ? (
        <p className="dsh-optional-bundles__muted">{t('plugins.bundles.unavailable')}</p>
      ) : state.catalog.bundles.length === 0 ? (
        <p className="dsh-optional-bundles__muted">{t('plugins.bundles.empty')}</p>
      ) : (
        <ul className="dsh-optional-bundles__list" aria-label={t('plugins.bundles.listAria')}>
          {state.catalog.bundles.map((bundle) => {
            const title = pluginLocalizedText(bundle.title, locale) ?? bundle.name
            const description = pluginLocalizedText(bundle.description, locale)
            const blocked = bundle.readOnlyReason !== undefined || (!bundle.enabled && bundle.hasIssue)
            return (
              <li className="dsh-optional-bundles__item" key={bundle.name}>
                <div className="dsh-optional-bundles__copy">
                  <div className="dsh-optional-bundles__title-row">
                    <h3>{title}</h3>
                    {bundle.version === undefined ? null : (
                      <span className="dsh-optional-bundles__version">{bundle.version}</span>
                    )}
                    <span
                      className={`dsh-optional-bundles__state${bundle.enabled ? ' dsh-optional-bundles__state--enabled' : ''}`}
                    >
                      {bundle.enabled ? t('plugins.bundles.selected') : t('plugins.bundles.notSelected')}
                    </span>
                  </div>
                  {description === undefined ? null : <p>{description}</p>}
                  <p className="dsh-optional-bundles__muted">
                    {t(
                      bundle.installed ? 'plugins.bundles.profileDependency' : 'plugins.bundles.dshProvided',
                    )}
                  </p>
                  {bundle.hasIssue ? (
                    <p className="dsh-optional-bundles__warning" role="status">
                      {t('plugins.bundles.bundleIssue')}
                    </p>
                  ) : null}
                  {bundle.readOnlyReason === undefined ? null : (
                    <p className="dsh-optional-bundles__warning" role="status">
                      {t(
                        bundle.readOnlyReason === 'management-required'
                          ? 'plugins.bundles.readOnly.management'
                          : 'plugins.bundles.readOnly.unaddressable',
                      )}
                    </p>
                  )}
                  {busyName === bundle.name ? (
                    <p className="dsh-optional-bundles__muted" role="status">
                      {t('plugins.bundles.working')}
                    </p>
                  ) : null}
                  {notice?.kind === 'result' && notice.result.name === bundle.name ? (
                    <p
                      className={`dsh-optional-bundles__notice${notice.result.application === 'failed' ? ' dsh-optional-bundles__notice--error' : ''}`}
                      role={notice.result.application === 'failed' ? 'alert' : 'status'}
                    >
                      {resultText(notice.result)}
                    </p>
                  ) : null}
                </div>
                <button
                  className="dsh-button dsh-button--secondary dsh-button--compact"
                  type="button"
                  aria-pressed={bundle.enabled}
                  aria-label={t(
                    bundle.enabled ? 'plugins.bundles.disableNamed' : 'plugins.bundles.enableNamed',
                    { name: title },
                  )}
                  disabled={blocked || busyName !== undefined}
                  onClick={() => void requestChange(bundle, !bundle.enabled)}
                >
                  {t(bundle.enabled ? 'plugins.bundles.disable' : 'plugins.bundles.enable')}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {notice?.kind === 'request-failed' ? (
        <p className="dsh-optional-bundles__notice dsh-optional-bundles__notice--error" role="alert">
          {t('plugins.bundles.result.requestFailed')}
        </p>
      ) : null}
    </section>
  )
}
