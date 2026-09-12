import { useCallback, useState, type ReactElement } from 'react'
import type { DiagnosticsSnapshot } from '@dsh-vscode/domain'
import { ContentFlow } from '../../components/common/ContentFlow.js'
import { useI18n, type Translate } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { writeClipboard } from '../chat/clipboard.js'

export interface DiagnosticsPanelProps {
  readonly snapshot: DiagnosticsSnapshot
  readonly busy?: boolean
  readonly onRefresh?: () => Promise<void>
  readonly onReconnect?: () => Promise<void>
  readonly onShowOutput?: () => Promise<void>
}

export function DiagnosticsPanel(props: DiagnosticsPanelProps): ReactElement {
  const { t } = useI18n()
  const [copyState, setCopyState] = useState<{
    readonly report: string
    readonly status: 'idle' | 'copied' | 'failed'
  }>({ report: '', status: 'idle' })
  const snapshot = props.snapshot
  const report = diagnosticsReport(snapshot, t)
  const copyStatus = copyState.report === report ? copyState.status : 'idle'

  const copy = useCallback((): void => {
    void writeClipboard(report)
      .then((success) => setCopyState({ report, status: success ? 'copied' : 'failed' }))
      .catch(() => setCopyState({ report, status: 'failed' }))
  }, [report])

  return (
    <section className="dsh-diagnostics" aria-labelledby="dsh-diagnostics-title">
      <div className="dsh-diagnostics__header">
        <h2 id="dsh-diagnostics-title">{t('diagnostics.title')}</h2>
        {props.onRefresh === undefined ? null : (
          <button
            className="dsh-icon-button"
            type="button"
            aria-label={t('diagnostics.refresh')}
            title={t('diagnostics.refresh')}
            disabled={props.busy === true}
            onClick={() => void props.onRefresh?.()}
          >
            <Icon name="refresh" />
          </button>
        )}
      </div>
      <dl className="dsh-diagnostics__details">
        <div>
          <dt>{t('diagnostics.extension')}</dt>
          <dd>{snapshot.extensionVersion}</dd>
        </div>
        <div>
          <dt>{t('diagnostics.dsh')}</dt>
          <dd>{snapshot.dshVersion ?? t('diagnostics.notConnected')}</dd>
        </div>
        <div>
          <dt>{t('diagnostics.state')}</dt>
          <dd>{diagnosticsStateLabel(snapshot.state, t)}</dd>
        </div>
        <div>
          <dt>{t('diagnostics.ownership')}</dt>
          <dd>{diagnosticsEndpointLabel(snapshot.endpointKind, t)}</dd>
        </div>
      </dl>
      {snapshot.recentEvents.length === 0 ? (
        <ContentFlow as="p" className="dsh-diagnostics__empty">
          {t('diagnostics.noEvents')}
        </ContentFlow>
      ) : null}
      <ContentFlow as="details">
        <summary>{t('diagnostics.preview')}</summary>
        <pre>{report}</pre>
      </ContentFlow>
      <div className="dsh-diagnostics__actions">
        {props.onReconnect === undefined || !snapshot.canReconnect ? null : (
          <button
            className="dsh-button dsh-button--primary dsh-button--compact"
            type="button"
            disabled={props.busy === true}
            onClick={() => void props.onReconnect?.()}
          >
            <Icon name="refresh" />
            {t('diagnostics.reconnect')}
          </button>
        )}
        {props.onShowOutput === undefined ? null : (
          <button
            className="dsh-button dsh-button--ghost dsh-button--compact"
            type="button"
            disabled={props.busy === true}
            onClick={() => void props.onShowOutput?.()}
          >
            {t('diagnostics.openOutput')}
          </button>
        )}
        <button
          className="dsh-button dsh-button--secondary dsh-button--compact"
          type="button"
          disabled={props.busy === true}
          onClick={copy}
        >
          <Icon name={copyStatus === 'copied' ? 'check' : 'copy'} />
          {copyStatus === 'copied' ? t('diagnostics.copied') : t('diagnostics.copy')}
        </button>
      </div>
      {copyStatus === 'failed' ? (
        <ContentFlow as="p" className="dsh-diagnostics__error" role="alert">
          {t('diagnostics.copyFailed')}
        </ContentFlow>
      ) : null}
      {copyStatus === 'copied' ? (
        <ContentFlow as="p" className="dsh-diagnostics__notice" role="status">
          {t('diagnostics.copied')}
        </ContentFlow>
      ) : null}
    </section>
  )
}

function diagnosticsReport(snapshot: DiagnosticsSnapshot, t: Translate): string {
  return [
    `${t('diagnostics.extension')}: ${snapshot.extensionVersion}`,
    `${t('diagnostics.dsh')}: ${snapshot.dshVersion ?? t('diagnostics.notConnected')}`,
    `${t('diagnostics.state')}: ${diagnosticsStateLabel(snapshot.state, t)}`,
    `${t('diagnostics.ownership')}: ${diagnosticsEndpointLabel(snapshot.endpointKind, t)}`,
    ...snapshot.recentEvents.slice(-20).map((event) => `${t('diagnostics.event')}: ${event.slice(0, 256)}`),
  ].join('\n')
}

function diagnosticsStateLabel(snapshotState: DiagnosticsSnapshot['state'], t: Translate): string {
  return t(`diagnostics.state.${snapshotState}`)
}

function diagnosticsEndpointLabel(endpointKind: DiagnosticsSnapshot['endpointKind'], t: Translate): string {
  return endpointKind === undefined ? t('diagnostics.unknown') : t(`diagnostics.endpoint.${endpointKind}`)
}
