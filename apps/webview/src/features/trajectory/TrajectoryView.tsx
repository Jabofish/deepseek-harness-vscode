import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { buildTrajectory, searchTrajectoryRecords, type TrajectoryRecord } from '@dsh-vscode/timeline'
import { useI18n, type Translate } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface TrajectoryViewProps {
  readonly sessionId: string | undefined
  readonly nodes: readonly TimelineNode[]
  readonly streaming: boolean
}

/**
 * Turn-aware event ledger, mirroring the official Web UI's Trajectory view:
 * the main ledger keeps only index, kind, and content; selection opens a local
 * inspector with usage, duration, input, output, and thinking; a standalone
 * compaction lands in its own "Between turns" section; running rows keep a
 * live state instead of a fabricated duration. The ledger follows the tail
 * while streaming and suspends following once the user scrolls up.
 */
export function TrajectoryView(props: TrajectoryViewProps): ReactElement {
  const { t } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const previousSessionRef = useRef(props.sessionId)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)

  const projection = useMemo(() => buildTrajectory(props.nodes), [props.nodes])
  const matches = useMemo(() => searchTrajectoryRecords(projection, query), [projection, query])
  const searching = query.trim() !== ''
  const selected = useMemo(
    () =>
      projection.sections.flatMap((section) => section.records).find((record) => record.id === selectedId),
    [projection, selectedId],
  )

  const lastRecord = projection.sections.at(-1)?.records.at(-1)
  const tailSignature = lastRecord === undefined ? '' : `${lastRecord.id}:${lastRecord.text.length}`

  const scrollToLatest = (): void => {
    const element = scrollRef.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
    stickToBottomRef.current = true
    setShowJumpToLatest(false)
  }

  const handleScroll = (): void => {
    const element = scrollRef.current
    if (element === null) return
    const atLatest = element.scrollHeight - element.scrollTop - element.clientHeight <= 64
    stickToBottomRef.current = atLatest
    setShowJumpToLatest((current) => {
      const next = !atLatest && projection.recordCount > 0
      return current === next ? current : next
    })
  }

  useEffect(() => {
    if (previousSessionRef.current !== props.sessionId) {
      previousSessionRef.current = props.sessionId
      stickToBottomRef.current = true
      setShowJumpToLatest(false)
      setSelectedId(undefined)
      setQuery('')
    }
    if (!stickToBottomRef.current || projection.recordCount === 0) return
    const element = scrollRef.current
    if (element === null) return
    const timer = window.setTimeout(() => {
      element.scrollTop = element.scrollHeight
    }, 0)
    return () => window.clearTimeout(timer)
  }, [tailSignature, projection.recordCount, props.sessionId])

  return (
    <div className="dsh-trajectory-shell">
      <div className="dsh-trajectory__toolbar">
        <input
          className="dsh-trajectory__search"
          type="search"
          value={query}
          placeholder={t('trajectory.searchPlaceholder', { count: projection.recordCount })}
          aria-label={t('trajectory.searchAria')}
          onChange={(event) => setQuery(event.target.value)}
        />
        {searching ? (
          <span className="dsh-trajectory__count" role="status">
            {t(matches.length === 1 ? 'trajectory.matches' : 'trajectory.matches.plural', {
              count: matches.length,
            })}
          </span>
        ) : (
          <span className="dsh-trajectory__count">
            {t(projection.recordCount === 1 ? 'trajectory.records' : 'trajectory.records.plural', {
              count: projection.recordCount,
            })}
          </span>
        )}
      </div>
      <div
        ref={scrollRef}
        className="dsh-trajectory"
        aria-label={t('trajectory.ledger')}
        onScroll={handleScroll}
      >
        {projection.recordCount === 0 ? (
          <p className="dsh-trajectory__empty">{t('trajectory.empty')}</p>
        ) : searching ? (
          matches.length === 0 ? (
            <p className="dsh-trajectory__empty">{t('trajectory.noMatch', { query: query.trim() })}</p>
          ) : (
            <ul className="dsh-trajectory__rows">
              {matches.map((record) => (
                <TrajectoryRow
                  key={record.id}
                  record={record}
                  selected={selectedId === record.id}
                  onSelect={() => setSelectedId(record.id)}
                  t={t}
                />
              ))}
            </ul>
          )
        ) : (
          projection.sections.map((section, sectionIndex) => (
            <section
              className="dsh-trajectory__section"
              key={
                section.kind === 'turn' ? `turn:${section.turn ?? sectionIndex}` : `between:${sectionIndex}`
              }
              aria-label={
                section.kind === 'turn'
                  ? t('trajectory.turn', { turn: section.turn ?? 0 })
                  : t('trajectory.betweenTurns')
              }
            >
              <h3 className="dsh-trajectory__section-title">
                {section.kind === 'turn'
                  ? t('trajectory.turn', { turn: section.turn ?? 0 })
                  : t('trajectory.betweenTurns')}
              </h3>
              <ul className="dsh-trajectory__rows">
                {section.records.map((record) => (
                  <TrajectoryRow
                    key={record.id}
                    record={record}
                    selected={selectedId === record.id}
                    onSelect={() => setSelectedId(record.id)}
                    t={t}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
        {props.streaming ? (
          <span className="dsh-sr-only" aria-live="polite">
            {t('timeline.streaming')}
          </span>
        ) : null}
      </div>
      {selected === undefined ? null : (
        <TrajectoryInspector record={selected} onClose={() => setSelectedId(undefined)} t={t} />
      )}
      {showJumpToLatest ? (
        <button
          className="dsh-trajectory__jump"
          type="button"
          aria-label={t('timeline.jump')}
          title={t('timeline.jump')}
          onClick={scrollToLatest}
        >
          <Icon name="arrow-down" />
          <span>{t('timeline.jump')}</span>
        </button>
      ) : null}
    </div>
  )
}

function TrajectoryRow(props: {
  readonly record: TrajectoryRecord
  readonly selected: boolean
  readonly onSelect: () => void
  readonly t: Translate
}): ReactElement {
  const { record, t } = props
  return (
    <li>
      <button
        className={`dsh-trajectory__row${props.selected ? ' dsh-trajectory__row--selected' : ''}`}
        type="button"
        aria-pressed={props.selected}
        title={record.text}
        onClick={props.onSelect}
      >
        <span className="dsh-trajectory__index">#{record.index}</span>
        <span className={`dsh-trajectory__kind dsh-trajectory__kind--${record.kind}`}>{record.kind}</span>
        <span className="dsh-trajectory__text">{record.text}</span>
        <span className="dsh-trajectory__time">
          {record.streaming
            ? t('trajectory.running')
            : record.timeSeconds === null
              ? ''
              : formatDuration(record.timeSeconds)}
        </span>
      </button>
    </li>
  )
}

function TrajectoryInspector(props: {
  readonly record: TrajectoryRecord
  readonly onClose: () => void
  readonly t: Translate
}): ReactElement {
  const { record, t } = props
  const usage = record.usage
  return (
    <aside
      className="dsh-trajectory-inspector"
      role="region"
      aria-label={t('trajectory.inspectorAria', { index: record.index })}
    >
      <header className="dsh-trajectory-inspector__header">
        <h4>
          #{record.index} · {record.kind}
          {record.modelLabel === undefined ? '' : ` · ${record.modelLabel}`}
        </h4>
        <button
          className="dsh-icon-button"
          type="button"
          aria-label={t('trajectory.closeDetails')}
          title={t('trajectory.closeDetails')}
          onClick={props.onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <dl className="dsh-trajectory-inspector__facts">
        <dt>{t('trajectory.duration')}</dt>
        <dd>{record.streaming ? t('trajectory.running') : formatDuration(record.timeSeconds)}</dd>
        {record.startedAt === undefined ? null : (
          <>
            <dt>{t('trajectory.started')}</dt>
            <dd>{new Date(record.startedAt).toLocaleTimeString()}</dd>
          </>
        )}
        {usage === undefined ? null : (
          <>
            <dt>{t('trajectory.input')}</dt>
            <dd>{usage.inputTokens.toLocaleString()} tk</dd>
            {usage.cacheReadTokens === undefined ? null : (
              <>
                <dt>{t('trajectory.cacheRead')}</dt>
                <dd>{usage.cacheReadTokens.toLocaleString()} tk</dd>
              </>
            )}
            {usage.cacheWriteTokens === undefined ? null : (
              <>
                <dt>{t('trajectory.cacheWrite')}</dt>
                <dd>{usage.cacheWriteTokens.toLocaleString()} tk</dd>
              </>
            )}
            <dt>{t('trajectory.output')}</dt>
            <dd>{usage.outputTokens.toLocaleString()} tk</dd>
            {usage.reasoningTokens === undefined ? null : (
              <>
                <dt>{t('trajectory.reasoning')}</dt>
                <dd>{usage.reasoningTokens.toLocaleString()} tk</dd>
              </>
            )}
          </>
        )}
      </dl>
      {record.inputDetail === undefined ? null : (
        <details className="dsh-trajectory-inspector__block" open>
          <summary>{t('trajectory.input')}</summary>
          <pre>{record.inputDetail}</pre>
        </details>
      )}
      {record.outputDetail === undefined ? null : (
        <details className="dsh-trajectory-inspector__block" open>
          <summary>
            {t('trajectory.output')}
            {record.isError ? ` · ${t('trajectory.failed')}` : ''}
          </summary>
          <pre>{record.outputDetail}</pre>
        </details>
      )}
      {record.thinkingDetail === undefined ? null : (
        <details className="dsh-trajectory-inspector__block">
          <summary>{t('timeline.thinking')}</summary>
          <pre>{record.thinkingDetail}</pre>
        </details>
      )}
    </aside>
  )
}

/** Integer-millisecond duration label, matching the official ledger format. */
function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—'
  const millis = Math.round(seconds * 1000)
  return `${millis.toLocaleString()} ms`
}
