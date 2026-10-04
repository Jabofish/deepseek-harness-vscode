import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { AgentPresetRoster } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { useStableCallback } from '../../app/useStableCallback.js'

interface PluginCreatorActionProps {
  readonly revision?: number | undefined
  readonly loadRoster: () => Promise<AgentPresetRoster | undefined>
  readonly startDraft: () => Promise<void>
}

/** The upstream Creator identity is selectable only when the live roster advertises it. */
export function PluginCreatorAction(props: PluginCreatorActionProps): ReactElement {
  const { t } = useI18n()
  const [loaded, setLoaded] = useState<{
    readonly revision: number | undefined
    readonly retry: number
    readonly status: 'ready' | 'missing' | 'error'
  }>()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [retry, setRetry] = useState(0)
  const status = loaded?.revision === props.revision && loaded?.retry === retry ? loaded.status : 'loading'
  const load = useStableCallback(props.loadRoster)
  useEffect(() => {
    let current = true
    void load().then(
      (roster) => {
        if (current)
          setLoaded({
            revision: props.revision,
            retry,
            status:
              roster?.presets.some((preset) => preset.id === 'cordis' && preset.broken === undefined) === true
                ? 'ready'
                : 'missing',
          })
      },
      () => {
        if (current) setLoaded({ revision: props.revision, retry, status: 'error' })
      },
    )
    return () => {
      current = false
    }
  }, [load, props.revision, retry])
  return (
    <div>
      <button
        className="dsh-button dsh-button--secondary dsh-button--compact"
        type="button"
        disabled={status !== 'ready' || busy}
        aria-busy={busy}
        title={
          status === 'ready'
            ? t('plugins.manager.creator.ready')
            : status === 'loading'
              ? t('plugins.manager.creator.loading')
              : status === 'missing'
                ? t('plugins.manager.creator.missing')
                : t('plugins.manager.creator.error')
        }
        onClick={() => {
          if (pending.current || status !== 'ready') return
          pending.current = true
          setBusy(true)
          void props
            .startDraft()
            .catch(() => setLoaded({ revision: props.revision, retry, status: 'error' }))
            .finally(() => {
              pending.current = false
              setBusy(false)
            })
        }}
      >
        {t('plugins.manager.creator')}
      </button>
      {status === 'error' ? (
        <button
          className="dsh-button dsh-button--secondary dsh-button--compact"
          type="button"
          onClick={() => setRetry((value) => value + 1)}
        >
          {t('plugins.bundles.retry')}
        </button>
      ) : null}
    </div>
  )
}
