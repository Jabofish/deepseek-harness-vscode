import { useCallback, useRef, useState, type ReactElement } from 'react'
import type { DiagnosticsSnapshot } from '@dsh-vscode/domain'
import {
  ContentFlow,
  PopoverCard,
  useDismissibleLayer,
  useViewportMenuPosition,
} from '../../components/common/index.js'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { DiagnosticsPanel } from './DiagnosticsPanel.js'

export interface DiagnosticsDrawerProps {
  readonly onRead: () => Promise<DiagnosticsSnapshot | undefined>
  readonly onReconnect: () => Promise<void>
  readonly onShowOutput: () => Promise<void>
  readonly className?: string
}

/** User-facing diagnostics surface backed entirely by Extension Host state. */
export function DiagnosticsDrawer(props: DiagnosticsDrawerProps): ReactElement {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const menuPosition = useViewportMenuPosition({
    open,
    anchorRef: triggerRef,
    menuRef: panelRef,
    placement: 'above',
    align: 'end',
  })

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(false)
    try {
      const next = await props.onRead()
      if (next === undefined) throw new Error('Diagnostics snapshot unavailable')
      setSnapshot(next)
    } catch {
      setSnapshot(undefined)
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [props])

  const close = useCallback((): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  useDismissibleLayer({
    open,
    refs: [rootRef, panelRef],
    onDismiss: close,
    onEscape: close,
  })

  const toggle = (): void => {
    if (open) {
      close()
      return
    }
    setOpen(true)
    void load()
  }

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(false)
    try {
      await action()
      await load()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      ref={rootRef}
      className={`dsh-diagnostics-popover${props.className === undefined ? '' : ` ${props.className}`}`}
    >
      <button
        ref={triggerRef}
        className="dsh-diagnostics-popover__trigger"
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t('diagnostics.open')}
        title={t('diagnostics.open')}
        onClick={toggle}
      >
        <Icon name="alert" />
        <span>{t('diagnostics.open')}</span>
      </button>
      {open ? (
        <PopoverCard
          ref={panelRef}
          className="dsh-diagnostics-popover__menu"
          role="dialog"
          aria-label={t('diagnostics.aria')}
          style={menuPosition}
        >
          {loading ? (
            <ContentFlow as="p" className="dsh-diagnostics-popover__status" role="status">
              {t('diagnostics.loading')}
            </ContentFlow>
          ) : error ? (
            <div className="dsh-diagnostics-popover__failure">
              <ContentFlow as="p" role="alert">
                {t('diagnostics.unavailable')}
              </ContentFlow>
              <button
                className="dsh-button dsh-button--secondary dsh-button--compact"
                type="button"
                onClick={() => void load()}
              >
                {t('diagnostics.refresh')}
              </button>
            </div>
          ) : snapshot === undefined ? null : (
            <DiagnosticsPanel
              snapshot={snapshot}
              busy={busy}
              onRefresh={load}
              {...(snapshot.canReconnect ? { onReconnect: () => run(props.onReconnect) } : {})}
              onShowOutput={() => run(props.onShowOutput)}
            />
          )}
        </PopoverCard>
      ) : null}
    </div>
  )
}
