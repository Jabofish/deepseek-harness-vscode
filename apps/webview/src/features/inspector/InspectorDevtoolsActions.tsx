import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { AppStore } from '../../app/store.js'
import { useStableCallback } from '../../app/useStableCallback.js'
import { useI18n } from '../../i18n.js'
interface Result {
  readonly available: boolean
  readonly outcome: 'status' | 'opened' | 'copied' | 'unavailable'
}
export function InspectorDevtoolsActions(props: {
  readonly featureRequest: AppStore['featureRequest']
}): ReactElement {
  const { t } = useI18n()
  const request = useStableCallback(props.featureRequest)
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'failed' | 'copied' | 'opened'>(
    'loading',
  )
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const alive = useRef(false)
  const pending = useRef<string | undefined>(undefined)
  useEffect(() => {
    alive.current = true
    let current = true
    const requestId = `inspector-${crypto.randomUUID()}`
    void request<Result>({ type: 'inspector.devtools.status', requestId, payload: {} })
      .then((value) => {
        if (current) setStatus(value.available ? 'ready' : 'missing')
      })
      .catch(() => {
        if (current) setStatus('failed')
      })
    return () => {
      alive.current = false
      current = false
      for (const targetRequestId of [requestId, pending.current])
        if (targetRequestId !== undefined)
          void request({
            type: 'feature.request.cancel',
            requestId: `inspector-cancel-${crypto.randomUUID()}`,
            payload: { targetRequestId },
          }).catch(() => {})
    }
  }, [request, revision])
  const run = (type: 'inspector.devtools.open' | 'inspector.devtools.copy'): void => {
    if (pending.current !== undefined) return
    pending.current = `inspector-action-${crypto.randomUUID()}`
    setBusy(true)
    void request<Result>({ type, requestId: pending.current, payload: {} })
      .then((value) => {
        if (!alive.current) return
        setStatus(value.outcome === 'copied' ? 'copied' : value.outcome === 'opened' ? 'opened' : 'missing')
      })
      .catch(() => {
        if (alive.current) setStatus('failed')
      })
      .finally(() => {
        pending.current = undefined
        if (alive.current) setBusy(false)
      })
  }
  return (
    <details className="dsh-session-inspector__devtools" aria-label={t('inspector.devtools')}>
      <summary>{t('inspector.devtools')}</summary>
      <p role="status">
        {status === 'loading'
          ? t('inspector.devtools.loading')
          : status === 'missing'
            ? t('inspector.devtools.missing')
            : status === 'failed'
              ? t('inspector.devtools.failed')
              : status === 'copied'
                ? t('inspector.devtools.copied')
                : status === 'opened'
                  ? t('inspector.devtools.opened')
                  : t('inspector.devtools.ready')}
      </p>
      <div className="dsh-session-inspector__actions">
        <button
          type="button"
          disabled={busy || status === 'loading' || status === 'missing'}
          onClick={() => run('inspector.devtools.open')}
        >
          {t('inspector.devtools.open')}
        </button>
        <button
          type="button"
          disabled={busy || status === 'loading' || status === 'missing'}
          onClick={() => run('inspector.devtools.copy')}
        >
          {t('inspector.devtools.copy')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setStatus('loading')
            setRevision((value) => value + 1)
          }}
        >
          {t('inspector.refresh')}
        </button>
      </div>
    </details>
  )
}
