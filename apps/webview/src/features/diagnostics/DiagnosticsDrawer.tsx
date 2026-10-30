import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
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
  const [readError, setReadError] = useState(false)
  const [actionError, setActionError] = useState(false)
  const error = readError || actionError
  const openRef = useRef(false)
  const readGeneration = useRef(0)
  const pendingRead = useRef<Promise<DiagnosticsSnapshot | undefined> | undefined>(undefined)
  const onRead = props.onRead
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

  const load = useCallback(
    async (options?: { readonly silent?: boolean }): Promise<void> => {
      const silent = options?.silent === true
      if (!openRef.current || (silent && pendingRead.current !== undefined)) return
      const generation = ++readGeneration.current
      if (!silent) setLoading(true)
      if (!silent) {
        setReadError(false)
        setActionError(false)
      }
      let pending = pendingRead.current
      if (pending === undefined) {
        try {
          pending = onRead()
        } catch (reason) {
          pending = Promise.reject(
            reason instanceof Error ? reason : new Error('Diagnostics snapshot unavailable'),
          )
        }
        pendingRead.current = pending
      }
      try {
        const next = await pending
        if (generation !== readGeneration.current || !openRef.current) return
        if (next === undefined) throw new Error('Diagnostics snapshot unavailable')
        setSnapshot(next)
        setReadError(false)
      } catch {
        if (generation !== readGeneration.current || !openRef.current) return
        if (!silent) setSnapshot(undefined)
        setReadError(true)
      } finally {
        if (pendingRead.current === pending) pendingRead.current = undefined
        if (!silent && generation === readGeneration.current && openRef.current) setLoading(false)
      }
    },
    [onRead],
  )

  useEffect(() => {
    readGeneration.current += 1
    pendingRead.current = undefined
    if (openRef.current) void load()
  }, [load])

  useEffect(
    () => () => {
      openRef.current = false
      readGeneration.current += 1
    },
    [],
  )

  const close = useCallback((): void => {
    openRef.current = false
    readGeneration.current += 1
    setLoading(false)
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  useDismissibleLayer({
    open,
    refs: [rootRef, panelRef],
    onDismiss: close,
    onEscape: close,
  })

  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const interval = window.setInterval(() => {
      if (!busy && !loading && pendingRead.current === undefined) void load({ silent: true })
    }, 5_000)
    return () => window.clearInterval(interval)
  }, [open, busy, loading, load])

  const toggle = (): void => {
    if (open) {
      close()
      return
    }
    setOpen(true)
    openRef.current = true
    void load()
  }

  const run = async (action: () => Promise<void>): Promise<void> => {
    const generation = readGeneration.current
    setBusy(true)
    setReadError(false)
    setActionError(false)
    try {
      await action()
      // A poll started before the action cannot describe its result. Drain
      // that read before requesting a fresh snapshot without overlapping RPCs.
      await pendingRead.current?.catch(() => undefined)
      if (!openRef.current || generation !== readGeneration.current) return
      await load()
    } catch {
      if (openRef.current && generation === readGeneration.current) setActionError(true)
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
          tabIndex={-1}
          aria-label={t('diagnostics.aria')}
          style={menuPosition}
        >
          <div className="dsh-diagnostics-popover__close">
            <button className="dsh-icon-button" type="button" aria-label={t('common.close')} onClick={close}>
              <Icon name="close" />
            </button>
          </div>
          {loading && snapshot === undefined ? (
            <ContentFlow as="p" className="dsh-diagnostics-popover__status" role="status">
              {t('diagnostics.loading')}
            </ContentFlow>
          ) : error && snapshot === undefined ? (
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
            <>
              {/* A failed action must not discard the snapshot that is still
              on screen: it stays readable, and the failure is stated inline. */}
              {error ? (
                <ContentFlow as="p" className="dsh-diagnostics-popover__status" role="alert">
                  {t('diagnostics.actionFailed')}
                </ContentFlow>
              ) : null}
              <DiagnosticsPanel
                snapshot={snapshot}
                busy={busy}
                onRefresh={load}
                {...(snapshot.canReconnect ? { onReconnect: () => run(props.onReconnect) } : {})}
                onShowOutput={() => run(props.onShowOutput)}
              />
            </>
          )}
        </PopoverCard>
      ) : null}
    </div>
  )
}
