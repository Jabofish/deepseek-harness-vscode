import { useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import type { ConnectionLogEntry } from '@dsh-vscode/domain'
import type { WebviewBackendState } from '../../app/store.js'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface RuntimeConnectionViewProps {
  readonly state: WebviewBackendState
  readonly output?: readonly ConnectionLogEntry[]
  readonly loadingSessionCatalog?: boolean
  readonly onRetry?: () => void
  readonly onOpenSettings?: () => void
  readonly onShowDiagnosticsOutput?: () => Promise<void>
}

export function RuntimeConnectionView(props: RuntimeConnectionViewProps): ReactElement {
  const { t } = useI18n()
  const catalogLoading = props.loadingSessionCatalog === true && props.state.kind === 'connected'
  const title = connectionTitle(props.state, catalogLoading, t)
  const failure = ['failed', 'port-conflict', 'runtime-missing'].includes(props.state.kind)
  const loading = catalogLoading || (!failure && props.state.kind !== 'connected')
  const retryable =
    (props.state.kind === 'failed' || props.state.kind === 'port-conflict') && props.state.retryable
  const message =
    props.state.kind === 'failed' || props.state.kind === 'port-conflict' ? props.state.message : undefined
  const [outputFailed, setOutputFailed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const pane = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const run = useRef<number | undefined>(undefined)
  const output = props.output
  const visibleOutput = expanded ? output : output?.slice(catalogLoading ? -3 : -4)
  useLayoutEffect(() => {
    const first = output?.[0]
    if (first?.phase === 'connect' && first.status === 'started' && run.current !== first.id) {
      run.current = first.id
      follow.current = true
    }
    if (follow.current && pane.current !== null) pane.current.scrollTop = pane.current.scrollHeight
  }, [output, catalogLoading, message, expanded])

  return (
    <>
      <span className="dsh-sr-only" role="status">
        {title}
      </span>
      <section
        className="dsh-runtime-connection"
        aria-labelledby="runtime-connection-title"
        aria-busy={loading}
      >
        <div className="dsh-runtime-connection__header">
          {loading ? (
            <svg
              className="dsh-runtime-connection__spinner"
              viewBox="0 0 48 48"
              role="progressbar"
              aria-label={title}
            >
              <circle className="dsh-runtime-connection__arc" cx="24" cy="24" r="20" />
            </svg>
          ) : (
            <span className="dsh-runtime-connection__result" data-failure={failure}>
              <Icon name={failure ? 'alert' : 'check'} />
            </span>
          )}
          <h2 id="runtime-connection-title">{title}</h2>
        </div>
        <div
          className="dsh-runtime-connection__output"
          id="runtime-connection-output"
          data-expanded={expanded}
          role="log"
          aria-label={t('runtime.connectionLog.title')}
          aria-live="off"
          tabIndex={0}
          ref={pane}
          onScroll={(event) => {
            const el = event.currentTarget
            if (expanded) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
        >
          {!visibleOutput?.length ? (
            <p>{title}</p>
          ) : (
            visibleOutput.map((entry) => (
              <p
                className="dsh-runtime-connection__line"
                key={entry.id}
                data-status={entry.status}
                title={connectionLine(entry, t)}
              >
                <time dateTime={entry.time}>{new Date(entry.time).toTimeString().slice(0, 8)}</time>{' '}
                <span>{connectionLine(entry, t)}</span>
              </p>
            ))
          )}
          {catalogLoading ? <p>{t('runtime.connectionLog.sessions')}</p> : null}
        </div>
        {message === undefined ? null : (
          <p className="dsh-runtime-connection__error" role="alert" tabIndex={0}>
            {message}
          </p>
        )}
        {!outputFailed ? null : (
          <p className="dsh-runtime-connection__error" role="alert">
            {t('runtime.connectionLog.outputFailed')}
          </p>
        )}
        <div className="dsh-runtime-connection__actions">
          <button
            className="dsh-button dsh-button--ghost"
            type="button"
            aria-expanded={expanded}
            aria-controls="runtime-connection-output"
            onClick={() => {
              follow.current = expanded
              if (pane.current !== null) pane.current.scrollTop = 0
              setExpanded(!expanded)
            }}
          >
            <Icon name="chevron-down" />
            {t(expanded ? 'runtime.connectionLog.collapse' : 'runtime.connectionLog.expand')}
          </button>
          {!failure || !retryable || props.onRetry === undefined ? null : (
            <button className="dsh-button dsh-button--primary" type="button" onClick={props.onRetry}>
              {t('runtime.retry')}
            </button>
          )}
          {props.onShowDiagnosticsOutput === undefined ? null : (
            <button
              className="dsh-icon-button dsh-runtime-connection__open-output"
              type="button"
              aria-label={t('runtime.connectionLog.openOutput')}
              title={t('runtime.connectionLog.openOutput')}
              onClick={() => {
                void props.onShowDiagnosticsOutput?.().catch(() => setOutputFailed(true))
              }}
            >
              <Icon name="open-in-editor" />
            </button>
          )}
          {props.onOpenSettings === undefined ? null : (
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
      </section>
    </>
  )
}

function connectionLine(
  entry: ConnectionLogEntry,
  t: (key: string, params?: Readonly<Record<string, string | number>>) => string,
): string {
  const phase = t(`runtime.connectionLog.phase.${entry.phase}`)
  const facts = [t(`runtime.connectionLog.status.${entry.status}`, { phase })]
  if (entry.mode !== undefined) facts.push(entry.mode)
  if (entry.attempt !== undefined) facts.push(t('runtime.connectionLog.attempt', { count: entry.attempt }))
  if (entry.count !== undefined) facts.push(t('runtime.connectionLog.count', { count: entry.count }))
  if (entry.candidateSource !== undefined)
    facts.push(t(`runtime.connectionLog.source.${entry.candidateSource}`))
  if (entry.hostVersion !== undefined) facts.push('DSH ' + entry.hostVersion)
  if (entry.ownership !== undefined) facts.push(t(`runtime.connectionLog.ownership.${entry.ownership}`))
  if (entry.code !== undefined) facts.push(entry.code)
  return facts.join(' · ')
}

function connectionTitle(
  state: WebviewBackendState,
  catalogLoading: boolean,
  t: (key: string) => string,
): string {
  if (catalogLoading) return t('runtime.connectionProgress.sessionsTitle')
  if ((state.kind === 'discovering' || state.kind === 'connecting') && state.phase !== undefined)
    return t(`runtime.connectionProgress.phase.${state.phase}.title`)
  switch (state.kind) {
    case 'idle':
      return t('runtime.connectionProgress.idleTitle')
    case 'discovering':
      return t('runtime.connectionProgress.discoveringTitle')
    case 'locating-runtime':
      return t('runtime.connectionProgress.locatingTitle')
    case 'starting':
      return t('runtime.connectionProgress.startingTitle')
    case 'connecting':
      return t('runtime.connectionProgress.connectingTitle')
    case 'stopping':
      return t('runtime.connectionProgress.stoppingTitle')
    case 'failed':
    case 'port-conflict':
      return t('runtime.connectionProgress.failureTitle')
    case 'runtime-missing':
      return t('runtime.title')
    case 'connected':
      return t('runtime.connectionProgress.readyTitle')
  }
}
