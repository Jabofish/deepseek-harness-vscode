import type { FeatureCapabilityProfile, FeatureCapabilityState } from '@dsh-vscode/domain'
import { FEATURE_CAPABILITY_IDS } from '@dsh-vscode/domain'
import { useCallback, useRef, useState, type ReactElement } from 'react'
import {
  ContentFlow,
  PopoverCard,
  useDismissibleLayer,
  useViewportMenuPosition,
} from '../../components/common/index.js'
import type { WebviewBackendState } from '../../app/store.js'
import { useI18n, type Translate } from '../../i18n.js'
import { Icon, type IconName } from '../../ui/Icon.js'

export interface RuntimeStatusProps {
  readonly state: WebviewBackendState
  readonly connectedDshVersion?: string | undefined
  readonly compatibilityWarning?: string | undefined
  readonly featureProfile?: FeatureCapabilityProfile | undefined
  readonly onOpenSettings?: () => void
  readonly onRetry?: () => void
}

interface RuntimeDetail {
  readonly label: string
  readonly value: string
}

/** Label keys are literals so the key-table scan can prove they resolve. */
const CAPABILITY_STATE_KEYS: Record<FeatureCapabilityState, { readonly labelKey: string }> = {
  'verified-contract': { labelKey: 'runtime.capability.verified-contract' },
  'compatibility-fallback': { labelKey: 'runtime.capability.compatibility-fallback' },
  unavailable: { labelKey: 'runtime.capability.unavailable' },
}

export function RuntimeStatus({
  state,
  connectedDshVersion,
  compatibilityWarning,
  featureProfile,
  onOpenSettings,
  onRetry,
}: RuntimeStatusProps): ReactElement {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const label = runtimeStatusLabel(state, t)
  const loading = isRuntimeLoading(state)
  const menuPosition = useViewportMenuPosition({
    open,
    anchorRef: triggerRef,
    menuRef: panelRef,
    placement: 'below',
    align: 'end',
  })
  const close = useCallback((): void => setOpen(false), [])

  useDismissibleLayer({
    open,
    refs: [rootRef, panelRef],
    onDismiss: close,
    onEscape: () => {
      close()
      triggerRef.current?.focus()
    },
  })

  const retryable =
    onRetry !== undefined && (state.kind === 'failed' || state.kind === 'port-conflict') && state.retryable
  const message = state.kind === 'failed' || state.kind === 'port-conflict' ? state.message : undefined
  const details = runtimeDetails(state, connectedDshVersion, t)

  return (
    <div
      ref={rootRef}
      className={`dsh-runtime-status dsh-runtime-status--${state.kind}`}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <button
        ref={triggerRef}
        className="dsh-runtime-status__trigger"
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name={runtimeStatusIcon(state)} className="dsh-runtime-status__icon" />
        {loading ? (
          <span className="dsh-skeleton dsh-runtime-status__loading-indicator" aria-hidden="true" />
        ) : null}
        <ContentFlow as="span" variant="truncate" className="dsh-runtime-status__label">
          {label}
        </ContentFlow>
      </button>
      {open ? (
        <PopoverCard
          ref={panelRef}
          className="dsh-runtime-status__panel"
          role="dialog"
          aria-label={t('runtime.connectionDetails')}
          style={menuPosition}
        >
          <header className="dsh-runtime-status__panel-header">
            <div className="dsh-runtime-status__panel-heading">
              <strong>{t('runtime.connectionDetails')}</strong>
              <ContentFlow as="span" variant="truncate" className="dsh-runtime-status__panel-state">
                {label}
              </ContentFlow>
            </div>
            <button
              className="dsh-icon-button"
              type="button"
              aria-label={t('runtime.closeDetails')}
              title={t('runtime.closeDetails')}
              onClick={close}
            >
              <Icon name="close" />
            </button>
          </header>
          {details.length === 0 && message === undefined ? (
            <ContentFlow as="p" className="dsh-runtime-status__empty">
              {t('runtime.noConnectionDetails')}
            </ContentFlow>
          ) : null}
          {details.length === 0 ? null : (
            <dl className="dsh-runtime-status__details">
              {details.map((detail) => (
                <div key={detail.label}>
                  <dt>{detail.label}</dt>
                  <ContentFlow as="dd" variant="truncate" title={detail.value}>
                    {detail.value}
                  </ContentFlow>
                </div>
              ))}
            </dl>
          )}
          {message === undefined ? null : (
            <ContentFlow as="p" className="dsh-runtime-status__message" role="alert">
              {message}
            </ContentFlow>
          )}
          {state.kind === 'connected' && compatibilityWarning !== undefined ? (
            <ContentFlow as="p" className="dsh-runtime-status__warning" role="alert">
              {compatibilityWarning}
            </ContentFlow>
          ) : null}
          {state.kind === 'connected' && featureProfile !== undefined ? (
            <CapabilityProfile profile={featureProfile} t={t} />
          ) : null}
          {retryable || onOpenSettings !== undefined ? (
            <div className="dsh-runtime-status__actions">
              {retryable ? (
                <button
                  className="dsh-button dsh-button--secondary dsh-button--compact"
                  type="button"
                  onClick={() => {
                    close()
                    onRetry()
                  }}
                >
                  {t('runtime.retry')}
                </button>
              ) : null}
              {onOpenSettings === undefined ? null : (
                <button
                  className="dsh-button dsh-button--primary dsh-button--compact"
                  type="button"
                  onClick={() => {
                    close()
                    onOpenSettings()
                  }}
                >
                  {t('runtime.openConnectionSettings')}
                </button>
              )}
            </div>
          ) : null}
        </PopoverCard>
      ) : null}
    </div>
  )
}

/**
 * The host derives this profile from the connected adapter; showing it here is
 * what makes a compatibility fallback visible instead of silent.
 */
function CapabilityProfile({
  profile,
  t,
}: {
  readonly profile: FeatureCapabilityProfile
  readonly t: Translate
}): ReactElement {
  return (
    <section className="dsh-runtime-status__capabilities" aria-label={t('runtime.capabilities')}>
      <div className="dsh-runtime-status__capabilities-header">
        <strong>{t('runtime.capabilities')}</strong>
        <span>
          {t(
            profile.source === 'pinned-adapter'
              ? 'runtime.capabilities.pinned'
              : 'runtime.capabilities.fallback',
          )}
        </span>
      </div>
      <ul className="dsh-runtime-status__capability-list">
        {FEATURE_CAPABILITY_IDS.map((id) => {
          const capability = profile.capabilities[id]
          return (
            <li
              key={id}
              className={`dsh-runtime-status__capability dsh-runtime-status__capability--${capability.state}`}
              title={capability.reason}
            >
              <code>{id}</code>
              <span>
                {t(
                  capability.upstream === 'not-applicable'
                    ? 'runtime.capability.local'
                    : CAPABILITY_STATE_KEYS[capability.state].labelKey,
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function runtimeStatusLabel(state: WebviewBackendState, t: Translate): string {
  if (state.kind === 'connected') return t('runtime.status.connected')
  if (state.kind === 'runtime-missing') return t('runtime.status.runtime-missing')
  if (state.kind === 'failed' || state.kind === 'port-conflict') return t('runtime.status.connection-failed')
  return t(`runtime.status.${state.kind}`)
}

function isRuntimeLoading(state: WebviewBackendState): boolean {
  return (
    state.kind === 'locating-runtime' ||
    state.kind === 'discovering' ||
    state.kind === 'connecting' ||
    state.kind === 'starting'
  )
}

function runtimeStatusIcon(state: WebviewBackendState): IconName {
  if (state.kind === 'connected') return 'check'
  if (state.kind === 'failed' || state.kind === 'port-conflict') return 'alert'
  return 'status'
}

function runtimeDetails(
  state: WebviewBackendState,
  connectedDshVersion: string | undefined,
  t: Translate,
): readonly RuntimeDetail[] {
  if (state.kind === 'connected' && connectedDshVersion !== undefined) {
    return [{ label: t('runtime.dshVersion'), value: connectedDshVersion }]
  }
  if (state.kind === 'port-conflict') {
    return [{ label: t('runtime.port'), value: String(state.port) }]
  }
  return []
}
