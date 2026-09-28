import type { ManagedPluginEntry, PluginBundleChangeResult, PluginManagerBundle } from '@dsh-vscode/domain'
import type { ReactElement } from 'react'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { failureKey, localized, pluginTitle, resultText } from './optional-bundle-model.js'

export type Notice =
  | { readonly kind: 'result'; readonly result: PluginBundleChangeResult }
  | { readonly kind: 'message'; readonly key: string }

export interface PluginRowProps {
  readonly entryId: string | undefined
  readonly moduleName: string
  readonly meta?: ManagedPluginEntry['meta']
  readonly plugins: readonly ManagedPluginEntry[]
  readonly busyKey: string | undefined
  readonly installBusy: boolean
  readonly onSetPlugin: (plugin: ManagedPluginEntry, enabled: boolean) => void
}

export interface BundleCardProps {
  readonly bundle: PluginManagerBundle
  readonly rows: PluginManagerBundle['rows']
  readonly open: boolean
  readonly notice: Notice | undefined
  readonly plugins: readonly ManagedPluginEntry[]
  readonly busyKey: string | undefined
  readonly installBusy: boolean
  readonly onSetPlugin: (plugin: ManagedPluginEntry, enabled: boolean) => void
  readonly onToggle: () => void
  readonly onSetBundle: (bundle: PluginManagerBundle, enabled: boolean) => void
  readonly onRemoveBundle: (bundle: PluginManagerBundle) => void
}

export function PluginRow(props: PluginRowProps): ReactElement {
  const { t, locale } = useI18n()
  const { entryId, moduleName, meta } = props
  const plugin =
    entryId === undefined ? undefined : props.plugins.find((candidate) => candidate.entryId === entryId)
  const title =
    plugin === undefined ? (localized(meta?.title, locale) ?? moduleName) : pluginTitle(plugin, locale)
  const disabled =
    plugin === undefined ||
    plugin.readOnlyReason !== undefined ||
    props.busyKey !== undefined ||
    props.installBusy
  return (
    <li className="dsh-optional-bundles__plugin">
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
          onClick={() => props.onSetPlugin(plugin, !plugin.enabled)}
        >
          {t(plugin.enabled ? 'plugins.bundles.disable' : 'plugins.bundles.enable')}
        </button>
      )}
    </li>
  )
}

export function BundleCard(props: BundleCardProps): ReactElement {
  const { t, locale } = useI18n()
  const { bundle, rows, notice, open } = props
  const title = localized(bundle.title, locale) ?? bundle.name
  const description = localized(bundle.description, locale)
  const blocked = bundle.readOnlyReason !== undefined || (!bundle.enabled && bundle.errorCode !== undefined)
  const actionDisabled = blocked || props.busyKey !== undefined || props.installBusy
  const bodyId = `dsh-bundle-body-${encodeURIComponent(bundle.name)}`
  return (
    <li className="dsh-optional-bundles__item" data-open={open ? 'true' : undefined}>
      <div className="dsh-optional-bundles__head">
        <button
          className="dsh-optional-bundles__toggle"
          type="button"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={() => props.onToggle()}
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
            {rows.length === 0 ? null : (
              <span className="dsh-optional-bundles__entry-count">
                {t('plugins.manager.entryCount', { count: rows.length })}
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
            onClick={() => props.onSetBundle(bundle, !bundle.enabled)}
          >
            {t(bundle.enabled ? 'plugins.bundles.disable' : 'plugins.bundles.enable')}
          </button>
          {bundle.removable ? (
            <button
              className="dsh-button dsh-button--secondary dsh-button--compact"
              type="button"
              aria-label={t('plugins.manager.remove.named', { name: title })}
              disabled={props.busyKey !== undefined || props.installBusy}
              onClick={() => props.onRemoveBundle(bundle)}
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
      {props.busyKey === bundle.name ? (
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
          {resultText(t, notice.result)}
        </p>
      ) : null}
      {open ? (
        <div className="dsh-optional-bundles__body" id={bodyId}>
          {description === undefined ? null : <p>{description}</p>}
          <p className="dsh-optional-bundles__muted">
            {t(bundle.installed ? 'plugins.bundles.profileDependency' : 'plugins.bundles.dshProvided')}
          </p>
          {rows.length === 0 ? null : (
            <ul
              className="dsh-optional-bundles__plugins"
              aria-label={t('plugins.manager.bundle.plugins', { name: title })}
            >
              {rows.map((row) => (
                <PluginRow
                  key={`${row.rowId}:${row.entryId ?? row.moduleName}`}
                  entryId={row.entryId}
                  moduleName={row.moduleName}
                  meta={row.meta}
                  plugins={props.plugins}
                  busyKey={props.busyKey}
                  installBusy={props.installBusy}
                  onSetPlugin={props.onSetPlugin}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  )
}
