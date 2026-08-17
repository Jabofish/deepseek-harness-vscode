import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { buildTrajectory, searchTrajectoryRecords, type TrajectoryRecord } from '@dsh-vscode/timeline'
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
          placeholder={`Search ${projection.recordCount} records`}
          aria-label="Search trajectory records"
          onChange={(event) => setQuery(event.target.value)}
        />
        {searching ? (
          <span className="dsh-trajectory__count" role="status">
            {matches.length} match{matches.length === 1 ? '' : 'es'}
          </span>
        ) : (
          <span className="dsh-trajectory__count">
            {projection.recordCount} record{projection.recordCount === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <div ref={scrollRef} className="dsh-trajectory" aria-label="Trajectory ledger" onScroll={handleScroll}>
        {projection.recordCount === 0 ? (
          <p className="dsh-trajectory__empty">No trajectory records yet.</p>
        ) : searching ? (
          matches.length === 0 ? (
            <p className="dsh-trajectory__empty">No records match “{query.trim()}”.</p>
          ) : (
            <ul className="dsh-trajectory__rows">
              {matches.map((record) => (
                <TrajectoryRow
                  key={record.id}
                  record={record}
                  selected={selectedId === record.id}
                  onSelect={() => setSelectedId(record.id)}
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
              aria-label={section.kind === 'turn' ? `Turn ${section.turn ?? 0}` : 'Between turns'}
            >
              <h3 className="dsh-trajectory__section-title">
                {section.kind === 'turn' ? `Turn ${section.turn ?? 0}` : 'Between turns'}
              </h3>
              <ul className="dsh-trajectory__rows">
                {section.records.map((record) => (
                  <TrajectoryRow
                    key={record.id}
                    record={record}
                    selected={selectedId === record.id}
                    onSelect={() => setSelectedId(record.id)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
        {props.streaming ? (
          <span className="dsh-sr-only" aria-live="polite">
            Response is streaming
          </span>
        ) : null}
      </div>
      {selected === undefined ? null : (
        <TrajectoryInspector record={selected} onClose={() => setSelectedId(undefined)} />
      )}
      {showJumpToLatest ? (
        <button
          className="dsh-trajectory__jump"
          type="button"
          aria-label="Jump to latest"
          title="Jump to latest"
          onClick={scrollToLatest}
        >
          <Icon name="arrow-down" />
          <span>Jump to latest</span>
        </button>
      ) : null}
    </div>
  )
}

function TrajectoryRow(props: {
  readonly record: TrajectoryRecord
  readonly selected: boolean
  readonly onSelect: () => void
}): ReactElement {
  const { record } = props
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
            ? 'running'
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
}): ReactElement {
  const { record } = props
  const usage = record.usage
  return (
    <aside className="dsh-trajectory-inspector" role="region" aria-label={`Record #${record.index} details`}>
      <header className="dsh-trajectory-inspector__header">
        <h4>
          #{record.index} · {record.kind}
          {record.modelLabel === undefined ? '' : ` · ${record.modelLabel}`}
        </h4>
        <button
          className="dsh-icon-button"
          type="button"
          aria-label="Close details"
          title="Close details"
          onClick={props.onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <dl className="dsh-trajectory-inspector__facts">
        <dt>Duration</dt>
        <dd>{record.streaming ? 'running' : formatDuration(record.timeSeconds)}</dd>
        {record.startedAt === undefined ? null : (
          <>
            <dt>Started</dt>
            <dd>{new Date(record.startedAt).toLocaleTimeString()}</dd>
          </>
        )}
        {usage === undefined ? null : (
          <>
            <dt>Input</dt>
            <dd>{usage.inputTokens.toLocaleString()} tk</dd>
            {usage.cacheReadTokens === undefined ? null : (
              <>
                <dt>Cache read</dt>
                <dd>{usage.cacheReadTokens.toLocaleString()} tk</dd>
              </>
            )}
            {usage.cacheWriteTokens === undefined ? null : (
              <>
                <dt>Cache write</dt>
                <dd>{usage.cacheWriteTokens.toLocaleString()} tk</dd>
              </>
            )}
            <dt>Output</dt>
            <dd>{usage.outputTokens.toLocaleString()} tk</dd>
            {usage.reasoningTokens === undefined ? null : (
              <>
                <dt>Reasoning</dt>
                <dd>{usage.reasoningTokens.toLocaleString()} tk</dd>
              </>
            )}
          </>
        )}
      </dl>
      {record.inputDetail === undefined ? null : (
        <details className="dsh-trajectory-inspector__block" open>
          <summary>Input</summary>
          <pre>{record.inputDetail}</pre>
        </details>
      )}
      {record.outputDetail === undefined ? null : (
        <details className="dsh-trajectory-inspector__block" open>
          <summary>Output{record.isError ? ' · failed' : ''}</summary>
          <pre>{record.outputDetail}</pre>
        </details>
      )}
      {record.thinkingDetail === undefined ? null : (
        <details className="dsh-trajectory-inspector__block">
          <summary>Thinking</summary>
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
  return `${millis.toLocaleString('en-US')} ms`
}
