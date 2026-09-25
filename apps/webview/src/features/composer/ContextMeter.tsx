import { createPortal } from 'react-dom'
import { useRef, useState, type ReactElement } from 'react'
import type { ContextBreakdown } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
import { useViewportMenuPosition } from '../../components/common/useViewportMenuPosition.js'

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
  const current = Math.max(0, Math.floor(props.tokens))
  const maximum = positive(props.maximum)
  const ratio = maximum === undefined ? 0 : Math.min(1, current / maximum)
  const percent = maximum === undefined ? undefined : Math.round(ratio * 100)
  const segments = contextSegments(props.breakdown)
  const circumference = 2 * Math.PI * 8
  const fullLabel = contextLabel(current, maximum)
  const compactLabel = compactContextLabel(current, maximum, percent)
  const detailsPosition = useViewportMenuPosition({
    open,
    anchorRef: triggerRef,
    menuRef: detailsRef,
    placement: 'above',
    align: 'end',
    refreshKey: `${current}:${maximum ?? ''}:${percent ?? ''}:${segments.length}`,
  })

  useDismissibleLayer({
    open,
    refs: [rootRef, detailsRef],
    onDismiss: () => setOpen(false),
  })

  return (
    <span ref={rootRef} className="dsh-context-meter">
      <button
        ref={triggerRef}
        type="button"
        className="dsh-context-meter__trigger"
        aria-label={t('controls.contextAria', { value: fullLabel })}
        aria-expanded={open}
        title={t('controls.contextDetails')}
        onClick={() => {
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
        <span className="dsh-context-meter__label dsh-context-meter__label--full" aria-hidden="true">
          {fullLabel}
        </span>
        <span className="dsh-context-meter__label dsh-context-meter__label--compact" aria-hidden="true">
          {compactLabel}
        </span>
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={detailsRef}
              className="dsh-context-meter__details"
              style={detailsPosition}
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
        className: 'dsh-context-meter__tone--system',
      },
      {
        key: 'tools' as const,
        tokens: positiveOrZero(breakdown.toolsTokens),
        className: 'dsh-context-meter__tone--tools',
      },
      {
        key: 'messages' as const,
        tokens: positiveOrZero(breakdown.messageTokens),
        className: 'dsh-context-meter__tone--messages',
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

function compactContextLabel(
  current: number,
  maximum: number | undefined,
  percent: number | undefined,
): string {
  if (maximum === undefined || percent === undefined) return `~${formatCount(current)}`
  return `~${formatCount(current)} · ${percent}%`
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
