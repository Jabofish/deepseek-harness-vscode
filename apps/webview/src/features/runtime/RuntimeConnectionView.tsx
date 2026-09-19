import type { ReactElement } from 'react'
import type { DiagnosticsSnapshot } from '@dsh-vscode/domain'
import type { WebviewBackendState } from '../../app/store.js'
import { DiagnosticsDrawer } from '../diagnostics/DiagnosticsDrawer.js'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

/** Exported for the i18n key spec, which pins one label per stage. */
export type RuntimeConnectionStage =
  'discovering' | 'locating-runtime' | 'starting' | 'connecting' | 'sessions'

const RUNTIME_CONNECTION_STAGES: readonly RuntimeConnectionStage[] = [
  'discovering',
  'locating-runtime',
  'starting',
  'connecting',
  'sessions',
]

/** Keeps the bar visibly filled while the first stage is still resolving. */
const CONNECTION_MIN_PROGRESS = 6

/** Placeholder session rows, as [title width, meta width] sizes. */
const CONNECTION_PREVIEW_ROWS: readonly (readonly [string, string])[] = [
  ['62%', '2rem'],
  ['48%', '2.75rem'],
  ['70%', '1.75rem'],
  ['54%', '2.5rem'],
  ['44%', '2.25rem'],
]

export interface RuntimeConnectionViewProps {
  readonly state: WebviewBackendState
  /** True while the connected host is still returning the workspace/session catalog. */
  readonly loadingSessionCatalog?: boolean
  readonly onRetry?: () => void
  readonly onOpenSettings?: () => void
  readonly onReadDiagnostics?: () => Promise<DiagnosticsSnapshot | undefined>
  readonly onReconnectDiagnostics?: () => Promise<void>
  readonly onShowDiagnosticsOutput?: () => Promise<void>
}

export function RuntimeConnectionView(props: RuntimeConnectionViewProps): ReactElement {
  const { t } = useI18n()
  const catalogLoading = props.loadingSessionCatalog === true && props.state.kind === 'connected'
  const copy = runtimeConnectionCopy(props.state, catalogLoading, t)
  const loading = runtimeConnectionLoading(props.state, catalogLoading)
  const currentStage = runtimeConnectionStage(props.state, catalogLoading)
  const failure = props.state.kind === 'failed' || props.state.kind === 'port-conflict'
  const message = failure ? props.state.message : undefined
  const retryable =
    (props.state.kind === 'failed' || props.state.kind === 'port-conflict') && props.state.retryable
  const diagnosticsReady =
    props.onReadDiagnostics !== undefined &&
    props.onReconnectDiagnostics !== undefined &&
    props.onShowDiagnosticsOutput !== undefined
  const percent = Math.max(
    Math.round(
      (Math.min(currentStage, RUNTIME_CONNECTION_STAGES.length) / RUNTIME_CONNECTION_STAGES.length) * 100,
    ),
    CONNECTION_MIN_PROGRESS,
  )
  const tone = failure ? 'danger' : loading ? 'loading' : 'ready'

  return (
    <section
      className={`dsh-runtime-connection${failure ? ' dsh-runtime-connection--failure' : ''}`}
      aria-labelledby="runtime-connection-title"
      aria-live="polite"
      aria-busy={loading}
    >
      <div className="dsh-runtime-connection__header">
        <span
          className={`dsh-runtime-connection__signal dsh-runtime-connection__signal--${tone}`}
          aria-hidden="true"
        >
          <Icon name={failure ? 'alert' : loading ? 'status' : 'check'} />
        </span>
        <h2 id="runtime-connection-title">{copy.title}</h2>
        {failure || props.onOpenSettings === undefined ? null : (
          <button
            className="dsh-icon-button"
            type="button"
            aria-label={t('runtime.openConnectionSettings')}
            title={t('runtime.openConnectionSettings')}
            onClick={props.onOpenSettings}
          >
            <Icon name="settings" />
          </button>
        )}
      </div>
      {failure ? null : (
        <div className="dsh-runtime-connection__track-row">
          <div
            className="dsh-runtime-connection__track"
            role="progressbar"
            aria-label={t('runtime.connectionProgress.stages')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span className="dsh-runtime-connection__track-fill" style={{ width: `${percent}%` }} />
          </div>
          <span className="dsh-runtime-connection__percent" aria-hidden="true">
            {`${percent}%`}
          </span>
        </div>
      )}
      {failure || !loading ? null : (
        <div className="dsh-runtime-connection__preview" aria-hidden="true">
          {CONNECTION_PREVIEW_ROWS.map(([name, meta]) => (
            <div className="dsh-runtime-connection__preview-row" key={name}>
              <span className="dsh-skeleton dsh-runtime-connection__preview-badge" />
              <span className="dsh-skeleton dsh-runtime-connection__preview-name" style={{ width: name }} />
              <span className="dsh-skeleton dsh-runtime-connection__preview-meta" style={{ width: meta }} />
            </div>
          ))}
        </div>
      )}
      <p className="dsh-runtime-connection__hint">{copy.description}</p>
      {message === undefined ? null : (
        <p className="dsh-runtime-connection__message" role="alert">
          {message}
        </p>
      )}
      {failure ? null : (
        <ol className="dsh-sr-only">
          {RUNTIME_CONNECTION_STAGES.map((stage, index) => (
            <li key={stage} aria-current={currentStage === index ? 'step' : 'false'}>
              {t(`runtime.connectionProgress.stage.${stage}`)}
            </li>
          ))}
        </ol>
      )}
      {failure && (retryable || props.onOpenSettings !== undefined || diagnosticsReady) ? (
        <div className="dsh-runtime-connection__actions">
          {!retryable || props.onRetry === undefined ? null : (
            <button className="dsh-button dsh-button--primary" type="button" onClick={props.onRetry}>
              {t('runtime.retry')}
            </button>
          )}
          {props.onOpenSettings === undefined ? null : (
            <button className="dsh-button dsh-button--ghost" type="button" onClick={props.onOpenSettings}>
              {t('runtime.openConnectionSettings')}
            </button>
          )}
          {!diagnosticsReady ? null : (
            <DiagnosticsDrawer
              onRead={props.onReadDiagnostics}
              onReconnect={props.onReconnectDiagnostics}
              onShowOutput={props.onShowDiagnosticsOutput}
            />
          )}
        </div>
      ) : null}
    </section>
  )
}

interface RuntimeConnectionCopy {
  readonly title: string
  readonly description: string
}

function runtimeConnectionCopy(
  state: WebviewBackendState,
  catalogLoading: boolean,
  t: (key: string) => string,
): RuntimeConnectionCopy {
  if (catalogLoading)
    return {
      title: t('runtime.connectionProgress.sessionsTitle'),
      description: t('runtime.connectionProgress.sessionsDescription'),
    }

  switch (state.kind) {
    case 'idle':
      return {
        title: t('runtime.connectionProgress.idleTitle'),
        description: t('runtime.connectionProgress.loadingDescription'),
      }
    case 'discovering':
      return {
        title: t('runtime.connectionProgress.discoveringTitle'),
        description: t('runtime.connectionProgress.loadingDescription'),
      }
    case 'locating-runtime':
      return {
        title: t('runtime.connectionProgress.locatingTitle'),
        description: t('runtime.connectionProgress.loadingDescription'),
      }
    case 'starting':
      return {
        title: t('runtime.connectionProgress.startingTitle'),
        description: t('runtime.connectionProgress.loadingDescription'),
      }
    case 'connecting':
      return {
        title: t('runtime.connectionProgress.connectingTitle'),
        description: t('runtime.connectionProgress.loadingDescription'),
      }
    case 'stopping':
      return {
        title: t('runtime.connectionProgress.stoppingTitle'),
        description: t('runtime.connectionProgress.loadingDescription'),
      }
    case 'failed':
    case 'port-conflict':
      return {
        title: t('runtime.connectionProgress.failureTitle'),
        description: t('runtime.connectionProgress.failureDescription'),
      }
    case 'runtime-missing':
      return {
        title: t('runtime.connectionProgress.failureTitle'),
        description: t('runtime.connectionProgress.failureDescription'),
      }
    case 'connected':
      return {
        title: t('runtime.connectionProgress.sessionsTitle'),
        description: t('runtime.connectionProgress.sessionsDescription'),
      }
  }
}

function runtimeConnectionLoading(state: WebviewBackendState, catalogLoading: boolean): boolean {
  if (catalogLoading) return true
  return (
    state.kind === 'idle' ||
    state.kind === 'discovering' ||
    state.kind === 'locating-runtime' ||
    state.kind === 'starting' ||
    state.kind === 'connecting' ||
    state.kind === 'stopping'
  )
}

function runtimeConnectionStage(state: WebviewBackendState, catalogLoading: boolean): number {
  if (catalogLoading) return RUNTIME_CONNECTION_STAGES.length - 1
  if (state.kind === 'connected') return RUNTIME_CONNECTION_STAGES.length
  switch (state.kind) {
    case 'discovering':
    case 'idle':
      return 0
    case 'locating-runtime':
      return 1
    case 'starting':
      return 2
    case 'connecting':
      return 3
    case 'stopping':
    case 'failed':
    case 'port-conflict':
    case 'runtime-missing':
      return 0
  }
}
