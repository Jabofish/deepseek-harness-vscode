import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { ContextBreakdown } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'

export interface ContextMeterProps {
  readonly tokens: number
  readonly maximum?: number
  /** rc.8 token-meter categories; absent on older DSH projections. */
  readonly breakdown?: ContextBreakdown
}

interface ContextSegment {
  readonly key: 'system' | 'tools' | 'messages'
  readonly tokens: number
  readonly className: string
}

/** Compact context occupancy meter with an on-demand, overflow-safe breakdown view. */
export function ContextMeter(props: ContextMeterProps): ReactElement {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const detailsRef = useRef<HTMLDivElement>(null)
  const [detailsPosition, setDetailsPosition] = useState<CSSProperties | undefined>()
  const current = Math.max(0, Math.floor(props.tokens))
  const maximum = positive(props.maximum)
  const ratio = maximum === undefined ? 0 : Math.min(1, current / maximum)
  const percent = maximum === undefined ? undefined : Math.round(ratio * 100)
  const segments = contextSegments(props.breakdown)
  const circumference = 2 * Math.PI * 8

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current
      const details = detailsRef.current
      if (
        event.target instanceof Node &&
        ((root !== null && root.contains(event.target)) ||
          (details !== null && details.contains(event.target)))
      )
        return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return

    const updateDetailsPosition = (): void => {
      const trigger = triggerRef.current
      const details = detailsRef.current
      if (trigger === null || details === null) return

      const viewportWidth = document.documentElement.clientWidth || window.innerWidth
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight
      const horizontalMargin = Math.min(8, viewportWidth / 2)
      const verticalMargin = Math.min(8, viewportHeight / 2)
      const availableWidth = Math.max(0, viewportWidth - horizontalMargin * 2)
      const width = Math.min(264, availableWidth)
      const maxLeft = Math.max(horizontalMargin, viewportWidth - width - horizontalMargin)
      const triggerRect = trigger.getBoundingClientRect()
      const left = Math.max(horizontalMargin, Math.min(maxLeft, triggerRect.right - width))
      const maxHeight = Math.min(260, Math.max(0, viewportHeight - verticalMargin * 2))
      const measuredHeight = Math.min(details.scrollHeight, maxHeight)
      const aboveTop = triggerRect.top - measuredHeight - 8
      const belowTop = triggerRect.bottom + 8
      const top =
        aboveTop >= verticalMargin
          ? aboveTop
          : Math.min(
              Math.max(verticalMargin, belowTop),
              Math.max(verticalMargin, viewportHeight - measuredHeight - verticalMargin),
            )

      setDetailsPosition({
        position: 'fixed',
        top: `${Math.max(verticalMargin, top)}px`,
        left: `${left}px`,
        right: 'auto',
        bottom: 'auto',
        width: `${width}px`,
        maxWidth: `calc(100vw - ${horizontalMargin * 2}px)`,
        maxHeight: `${maxHeight}px`,
        visibility: 'visible',
      })
    }

    updateDetailsPosition()
    window.addEventListener('resize', updateDetailsPosition)
    window.addEventListener('scroll', updateDetailsPosition, true)
    return () => {
      window.removeEventListener('resize', updateDetailsPosition)
      window.removeEventListener('scroll', updateDetailsPosition, true)
    }
  }, [open, current, maximum, percent, segments.length])

  return (
    <span ref={rootRef} className="dsh-context-meter">
      <button
        ref={triggerRef}
        type="button"
        className="dsh-context-meter__trigger"
        aria-label={t('controls.contextAria', { value: contextLabel(current, maximum) })}
        aria-expanded={open}
        title={t('controls.contextDetails')}
        onClick={() => {
          if (!open) setDetailsPosition(undefined)
          setOpen((value) => !value)
        }}
      >
        <svg className="dsh-context-meter__ring" viewBox="0 0 20 20" aria-hidden="true">
          <circle className="dsh-context-meter__track" cx="10" cy="10" r="8" />
          <circle
            className="dsh-context-meter__value"
            cx="10"
            cy="10"
            r="8"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - ratio)}
          />
        </svg>
        <span>{contextLabel(current, maximum)}</span>
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={detailsRef}
              className="dsh-context-meter__details"
              style={detailsPosition ?? { visibility: 'hidden' }}
              role="dialog"
              aria-label={t('controls.contextDetails')}
            >
              {segments.length === 0 ? (
                <>
                  <strong>{t('controls.contextDetails')}</strong>
                  <dl>
                    <div>
                      <dt>{t('controls.contextUsed')}</dt>
                      <dd>{formatCount(current)}</dd>
                    </div>
                    {maximum === undefined ? null : (
                      <div>
                        <dt>{t('controls.contextWindow')}</dt>
                        <dd>{formatCount(maximum)}</dd>
                      </div>
                    )}
                    {percent === undefined ? null : (
                      <div>
                        <dt>{t('controls.contextPercent')}</dt>
                        <dd>{percent}%</dd>
                      </div>
                    )}
                  </dl>
                </>
              ) : (
                <>
                  <div className="dsh-context-meter__header">
                    <strong>
                      {t('controls.contextUsedHeadline', { percent: percent === undefined ? '—' : percent })}
                    </strong>
                    <strong title={`${current} / ${maximum ?? '—'}`}>
                      ~{formatDetailCount(current)} /{' '}
                      {maximum === undefined ? '—' : formatDetailCount(maximum)}
                    </strong>
                  </div>
                  <div
                    className="dsh-context-meter__bar"
                    role="img"
                    aria-label={t('controls.contextBreakdownAria')}
                  >
                    {segments.map((segment) => (
                      <span
                        key={segment.key}
                        className={`dsh-context-meter__segment ${segment.className}`}
                        style={{ width: `${segmentWidth(segment, segments)}%` }}
                      />
                    ))}
                  </div>
                  <dl className="dsh-context-meter__breakdown">
                    {segments.map((segment) => (
                      <div key={segment.key}>
                        <dt>
                          <span
                            className={`dsh-context-meter__swatch ${segment.className}`}
                            aria-hidden="true"
                          />
                          <span>{contextSegmentLabel(segment.key, t)}</span>
                        </dt>
                        <dd>~{formatDetailCount(segment.tokens)}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </span>
  )
}

function contextSegments(breakdown: ContextBreakdown | undefined): readonly ContextSegment[] {
  if (breakdown === undefined) return []
  return (
    [
      {
        key: 'system' as const,
        tokens: positiveOrZero(breakdown.systemTokens),
        className: 'dsh-context-meter__segment--system',
      },
      {
        key: 'tools' as const,
        tokens: positiveOrZero(breakdown.toolsTokens),
        className: 'dsh-context-meter__segment--tools',
      },
      {
        key: 'messages' as const,
        tokens: positiveOrZero(breakdown.messageTokens),
        className: 'dsh-context-meter__segment--messages',
      },
    ] satisfies readonly ContextSegment[]
  ).filter((segment) => segment.tokens > 0)
}

function contextSegmentLabel(
  key: ContextSegment['key'],
  t: (key: string, params?: Readonly<Record<string, string | number>>) => string,
): string {
  switch (key) {
    case 'system':
      return t('controls.contextSystem')
    case 'tools':
      return t('controls.contextTools')
    case 'messages':
      return t('controls.contextMessages')
  }
}

function segmentWidth(segment: ContextSegment, segments: readonly ContextSegment[]): number {
  const total = segments.reduce((sum, entry) => sum + entry.tokens, 0)
  return total === 0 ? 0 : (segment.tokens / total) * 100
}

function contextLabel(current: number, maximum: number | undefined): string {
  return maximum === undefined
    ? `~${formatCount(current)}`
    : `~${formatCount(current)} / ${formatCount(maximum)}`
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function formatDetailCount(value: number): string {
  if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`
  if (value >= 1_000) return `${trimDecimal(value / 1_000)}K`
  return String(value)
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/u, '')
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function positiveOrZero(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
