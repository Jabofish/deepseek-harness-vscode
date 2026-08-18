import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { isInjectedUserMessage, type AssistantTiming, type TimelineNode } from '@dsh-vscode/timeline'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ToolCard } from '@dsh-vscode/ui'
import { MarkdownContent } from './MarkdownContent.js'
import { MessageActions } from './MessageActions.js'
import { WorkflowRunCard } from '../workflows/WorkflowDrawer.js'
import { Icon } from '../../ui/Icon.js'
import { useI18n, type Translate } from '../../i18n.js'

type DshEventNode = Extract<TimelineNode, { readonly kind: 'event' }>
type ToolTimelineNode = Extract<TimelineNode, { readonly kind: 'tool' }>

interface DshEventGroupNode {
  readonly kind: 'event-group'
  readonly id: string
  readonly events: readonly DshEventNode[]
}

interface AssistantTurnNode {
  readonly kind: 'assistant-turn'
  readonly id: string
  readonly modelLabel?: string
  readonly timing?: AssistantTiming
  readonly reasoning?: {
    readonly markdown: string
    readonly streaming: boolean
  }
  readonly tools: readonly ToolTimelineNode[]
  readonly markdown: string
  readonly streaming: boolean
  readonly sequence?: number
  readonly turn?: number
  readonly step?: number
  readonly turnCompleted?: boolean
}

type DisplayTimelineNode =
  | Exclude<TimelineNode, DshEventNode | ToolTimelineNode>
  | ToolTimelineNode
  | DshEventGroupNode
  | AssistantTurnNode

export interface TimelineProps {
  readonly sessionId: string
  readonly nodes: readonly TimelineNode[]
  readonly streaming: boolean
  /** Authoritative session-level running bit from the host status stream. */
  readonly running?: boolean
  readonly assistantLabel?: string
  readonly onOpenLink?: (href: string) => void
  readonly onOpenSession?: (sessionId: string) => void
  /** Fork the active session at a durable assistant-message sequence. */
  readonly onBranch?: (atSeq: number) => void
  readonly branching?: boolean
  /** DSH turn remains open across tool calls and multiple model steps. */
  readonly activeTurn?: number
}

export function Timeline(props: TimelineProps): ReactElement {
  const { t } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const previousSessionRef = useRef(props.sessionId)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<string>>(new Set())
  const [showDshEvents, setShowDshEvents] = useState(false)
  const dshEventCount = useMemo(
    () => props.nodes.reduce((count, node) => (node.kind === 'event' ? count + 1 : count), 0),
    [props.nodes],
  )
  // The reducer keeps authoritative assistant step ids so separate visible
  // answers cannot be fused. Thinking-only steps are different: the official
  // conversation surface presents one collapsed thinking block for a
  // continuous run, then attaches it to the following visible answer.
  const displayNodes = useMemo(
    () => prepareDisplayNodes(props.nodes, showDshEvents),
    [props.nodes, showDshEvents],
  )
  const running = props.running ?? props.streaming
  const usingTool = props.nodes.some(
    (node) => node.kind === 'tool' && (node.tool.status === 'queued' || node.tool.status === 'running'),
  )
  const latestNode = displayNodes[displayNodes.length - 1]
  const latestSignature = nodeSignature(latestNode)
  const scrollToLatest = useCallback((): void => {
    const element = scrollRef.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
    stickToBottomRef.current = true
    setShowJumpToLatest(false)
  }, [])
  const handleScroll = useCallback((): void => {
    const element = scrollRef.current
    if (element === null) return
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    const atLatest = distanceFromBottom <= 64
    stickToBottomRef.current = atLatest
    setShowJumpToLatest((current) => {
      const next = !atLatest && displayNodes.length > 0
      return current === next ? current : next
    })
  }, [displayNodes.length])

  useEffect(() => {
    const sessionChanged = previousSessionRef.current !== props.sessionId
    if (sessionChanged) {
      previousSessionRef.current = props.sessionId
      stickToBottomRef.current = true
      setShowJumpToLatest(false)
      setShowDshEvents(false)
    }
    if (!stickToBottomRef.current || displayNodes.length === 0) return

    let followUpTimer: number | undefined
    const initialTimer = window.setTimeout(() => {
      scrollToLatest()
      followUpTimer = window.setTimeout(scrollToLatest, 80)
    }, 0)
    return () => {
      window.clearTimeout(initialTimer)
      if (followUpTimer !== undefined) window.clearTimeout(followUpTimer)
    }
  }, [latestSignature, displayNodes.length, props.sessionId, scrollToLatest])

  useEffect(() => {
    const element = scrollRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    let previousWidth: number | undefined
    let settleTimer: number | undefined
    let followUpTimer: number | undefined
    const clearTimers = (): void => {
      if (settleTimer !== undefined) window.clearTimeout(settleTimer)
      if (followUpTimer !== undefined) window.clearTimeout(followUpTimer)
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width === undefined) return
      if (previousWidth === undefined) {
        previousWidth = width
        return
      }
      if (Math.abs(width - previousWidth) < 0.5) return
      previousWidth = width
      // Text reflows before the virtualizer finishes remeasuring every row.
      // Correct immediately so a resize-generated scroll event still sees the
      // viewport pinned, then settle twice for the asynchronous measurements.
      if (!stickToBottomRef.current) return
      clearTimers()
      scrollToLatest()
      settleTimer = window.setTimeout(() => {
        if (!stickToBottomRef.current) return
        scrollToLatest()
        followUpTimer = window.setTimeout(() => {
          if (stickToBottomRef.current) scrollToLatest()
        }, 80)
      }, 0)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      clearTimers()
    }
  }, [scrollToLatest])

  // TanStack Virtual owns scroll measurement; stable timeline ids keep
  // streaming cards from remounting as their Markdown grows.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: displayNodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 6,
    getItemKey: (index) => displayNodes[index]?.id ?? index,
  })
  return (
    <div className="dsh-timeline-shell">
      <div ref={scrollRef} className="dsh-timeline" aria-label={t('timeline.aria')} onScroll={handleScroll}>
        {dshEventCount > 0 ? (
          <div className="dsh-timeline__toolbar">
            <button
              className="dsh-timeline__events-toggle"
              type="button"
              aria-pressed={showDshEvents}
              aria-label={showDshEvents ? t('timeline.hideEvents') : t('timeline.showEvents')}
              title={
                showDshEvents
                  ? t('timeline.hideEvents')
                  : t('timeline.showEventsCount', { count: dshEventCount })
              }
              onClick={() => setShowDshEvents((current) => !current)}
            >
              <Icon name="terminal" />
              <span aria-hidden="true">{dshEventCount}</span>
            </button>
          </div>
        ) : null}
        {displayNodes.length === 0 && dshEventCount === 0 ? (
          <p className="dsh-timeline__empty">{t('timeline.empty')}</p>
        ) : null}
        <div
          className="dsh-timeline__canvas"
          style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const node = displayNodes[item.index]
            if (node === undefined) return null
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="dsh-timeline__row"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {renderNode(
                  node,
                  expandedTools,
                  setExpandedTools,
                  props.assistantLabel,
                  props.onOpenLink,
                  props.onOpenSession,
                  props.onBranch,
                  branchUnavailableForNode(node, props.branching === true),
                  running,
                  t,
                )}
              </div>
            )
          })}
        </div>
        {running ? (
          <StreamingActivity
            id={`turn:${props.activeTurn ?? latestNode?.id ?? props.sessionId}`}
            usingTool={usingTool}
            translate={t}
          />
        ) : null}
        {props.streaming ? (
          <span className="dsh-sr-only" aria-live="polite">
            {t('timeline.streaming')}
          </span>
        ) : null}
      </div>
      {showJumpToLatest ? (
        <button
          className="dsh-timeline__jump"
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

function renderNode(
  node: DisplayTimelineNode,
  expanded: ReadonlySet<string>,
  setExpanded: (next: ReadonlySet<string>) => void,
  assistantLabel = 'Model',
  onOpenLink?: (href: string) => void,
  onOpenSession?: (sessionId: string) => void,
  onBranch?: (atSeq: number) => void,
  branchUnavailable = true,
  running = false,
  t: Translate = (key) => key,
): ReactElement {
  switch (node.kind) {
    case 'tool':
      return renderToolCard(node, expanded, setExpanded, t)
    case 'assistant-turn':
      return renderAssistantTurn(
        node,
        expanded,
        setExpanded,
        assistantLabel,
        onOpenLink,
        t,
        onBranch,
        branchUnavailable,
        running,
      )
    case 'goal':
      return (
        <section className="dsh-timeline__card dsh-timeline__card--event">
          <header className="dsh-timeline__card-header">
            <div className="dsh-timeline__card-heading">
              <span className="dsh-message-avatar dsh-message-avatar--system" aria-hidden="true">
                <Icon name="target" />
              </span>
              <strong>{t('timeline.goals')}</strong>
            </div>
            <span className="dsh-timeline__card-meta">
              {t('timeline.items', { count: node.goals.length })}
            </span>
          </header>
          <ul className="dsh-timeline__event-list">
            {node.goals.map((goal) => (
              <li key={goal.id}>
                <span className="dsh-timeline__event-title">{goal.title}</span>
                <span className={`dsh-status-pill dsh-status-pill--${goal.status}`}>
                  {t(`goal.status.${goal.status}`)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )
    case 'todo':
      return (
        <section className="dsh-timeline__card dsh-timeline__card--event">
          <header className="dsh-timeline__card-header">
            <div className="dsh-timeline__card-heading">
              <span className="dsh-message-avatar dsh-message-avatar--system" aria-hidden="true">
                <Icon name="check" />
              </span>
              <strong>{t('app.todo')}</strong>
            </div>
            <span className="dsh-timeline__card-meta">
              {t('timeline.items', { count: node.todos.length })}
            </span>
          </header>
          <ul className="dsh-timeline__event-list">
            {node.todos.map((todo) => (
              <li key={todo.id}>
                <span className="dsh-timeline__event-title">{todo.content}</span>
                <span className={`dsh-status-pill dsh-status-pill--${todo.status}`}>
                  {t(`todo.status.${todo.status}`)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )
    case 'compaction':
      return (
        <details className="dsh-timeline__card dsh-timeline__card--event">
          <summary className="dsh-timeline__card-header">
            <div className="dsh-timeline__card-heading">
              <span className="dsh-message-avatar dsh-message-avatar--system" aria-hidden="true">
                <Icon name="box" />
              </span>
              <strong>{t('timeline.contextCompaction')}</strong>
            </div>
            <span className="dsh-timeline__card-meta">{compactionMeta(node.compaction, t)}</span>
          </summary>
          {node.compaction.summary === undefined ? null : (
            <MarkdownContent markdown={node.compaction.summary} onOpenLink={onOpenLink} />
          )}
        </details>
      )
    case 'retry':
      return (
        <p
          className={`dsh-timeline__retry${
            node.state === 'cancelled' ? ' dsh-timeline__retry--terminal' : ''
          }`}
          role="status"
        >
          {node.state === 'scheduled' ? (
            <span className="dsh-timeline__retry-shimmer" aria-hidden="true" />
          ) : null}
          <span>
            {node.state === 'cancelled'
              ? t('timeline.retryCancelled', { attempt: node.attempt })
              : node.state === 'started'
                ? t('timeline.retryStarted', { attempt: node.attempt })
                : node.attempt > 1
                  ? t('timeline.retryingAttempt', { attempt: node.attempt })
                  : t('timeline.retryConnectionLost')}
            {node.message === undefined ? '' : ` — ${node.message}`}
          </span>
        </p>
      )
    case 'workflow':
      return (
        <WorkflowRunCard
          workflow={node.workflow}
          {...(onOpenSession === undefined ? {} : { onOpenChild: onOpenSession })}
        />
      )
    case 'notice':
      return (
        <p
          className={`dsh-timeline__notice dsh-timeline__notice--${node.level}`}
          role={node.level === 'error' ? 'alert' : 'status'}
        >
          {node.text}
        </p>
      )
    case 'event-group':
      return (
        <details className="dsh-timeline__event-group">
          <summary className="dsh-timeline__event-group-summary">
            <span className="dsh-timeline__event-group-heading">
              <Icon name="terminal" />
              <span>{t('timeline.events')}</span>
            </span>
            <span className="dsh-timeline__event-group-meta">
              <span>{node.events.length}</span>
              <span className="dsh-timeline__disclosure" aria-hidden="true">
                <Icon name="chevron-down" />
              </span>
            </span>
          </summary>
          <ol className="dsh-timeline__event-group-list">
            {node.events.map((event) => (
              <li key={event.id} className="dsh-timeline__event-group-item">
                <code title={event.name}>{event.name}</code>
                <details className="dsh-timeline__event-payload">
                  <summary>{t('timeline.payload')}</summary>
                  <pre>{formatEventPayload(event.payload, t)}</pre>
                </details>
              </li>
            ))}
          </ol>
        </details>
      )
    case 'user-message':
      return (
        <div className="dsh-timeline__message-stack dsh-timeline__message-stack--user">
          <article
            className="dsh-timeline__card dsh-timeline__card--user"
            aria-label={t('timeline.yourMessage')}
          >
            {node.attachments === undefined || node.attachments.length === 0 ? null : (
              <div className="dsh-timeline__attachments" aria-label={t('timeline.attachedFiles')}>
                {node.attachments.map((attachment, index) => (
                  <span
                    className="dsh-timeline__attachment"
                    key={`${attachment.name}:${index}`}
                    title={attachment.name}
                  >
                    <Icon name={attachment.mimeType?.startsWith('image/') === true ? 'image' : 'file'} />
                    <span>{attachment.name}</span>
                  </span>
                ))}
              </div>
            )}
            {node.markdown.trim() === '' ? null : (
              <MarkdownContent markdown={node.markdown} onOpenLink={onOpenLink} />
            )}
          </article>
          {node.markdown.trim() === '' ? null : <MessageActions text={node.markdown} translate={t} />}
        </div>
      )
    case 'assistant-message':
      return renderAssistantMessage(node, assistantLabel, onOpenLink, t, onBranch, branchUnavailable, running)
    case 'reasoning':
      return renderAssistantTurn(
        {
          kind: 'assistant-turn',
          id: `assistant-turn:${node.id}`,
          tools: [],
          markdown: '',
          streaming: node.streaming,
          reasoning: node,
        },
        expanded,
        setExpanded,
        assistantLabel,
        onOpenLink,
        t,
        undefined,
        true,
        running,
      )
  }
}

function renderAssistantTurn(
  node: AssistantTurnNode,
  expanded: ReadonlySet<string>,
  setExpanded: (next: ReadonlySet<string>) => void,
  assistantLabel: string,
  onOpenLink?: (href: string) => void,
  t: Translate = (key) => key,
  onBranch?: (atSeq: number) => void,
  branchUnavailable = true,
  running = false,
): ReactElement {
  const inProgress = assistantNodeInProgress(node)
  const actionsUnavailable = running || inProgress || (node.turn !== undefined && node.turnCompleted !== true)
  return (
    <div className="dsh-timeline__message-stack">
      <article className="dsh-timeline__card dsh-timeline__card--assistant">
        <header className="dsh-timeline__card-header">
          <strong>{node.modelLabel ?? assistantLabel}</strong>
          {assistantDurationLabel(node.timing, t) === undefined ? null : (
            <span className="dsh-timeline__assistant-duration">{assistantDurationLabel(node.timing, t)}</span>
          )}
        </header>
        {node.reasoning === undefined ? null : renderReasoning(node.reasoning, onOpenLink, t)}
        {node.tools.length === 0 ? null : (
          <div className="dsh-timeline__assistant-tools">
            {renderToolCollection(node.tools, expanded, setExpanded, t)}
          </div>
        )}
        {node.markdown.trim() === '' ? null : (
          <MarkdownContent markdown={node.markdown} onOpenLink={onOpenLink} />
        )}
      </article>
      {node.markdown.trim() === '' || actionsUnavailable ? null : (
        <MessageActions
          text={node.markdown}
          {...(onBranch === undefined
            ? {}
            : { onBranch: node.sequence === undefined ? () => undefined : () => onBranch(node.sequence!) })}
          branchUnavailable={branchUnavailable}
          translate={t}
        />
      )}
    </div>
  )
}

function renderAssistantMessage(
  node: Extract<DisplayTimelineNode, { readonly kind: 'assistant-message' }>,
  assistantLabel: string,
  onOpenLink: ((href: string) => void) | undefined,
  t: Translate,
  onBranch: ((atSeq: number) => void) | undefined,
  branchUnavailable: boolean,
  running = false,
): ReactElement {
  const inProgress = assistantNodeInProgress(node)
  const actionsUnavailable = running || inProgress || (node.turn !== undefined && node.turnCompleted !== true)
  return (
    <div className="dsh-timeline__message-stack">
      <article className="dsh-timeline__card dsh-timeline__card--assistant">
        <header className="dsh-timeline__card-header">
          <strong>{node.modelLabel ?? assistantLabel}</strong>
          {assistantDurationLabel(node.timing, t) === undefined ? null : (
            <span className="dsh-timeline__assistant-duration">{assistantDurationLabel(node.timing, t)}</span>
          )}
        </header>
        {node.reasoning === undefined ? null : renderReasoning(node.reasoning, onOpenLink, t)}
        {node.markdown.trim() === '' ? null : (
          <MarkdownContent markdown={node.markdown} onOpenLink={onOpenLink} />
        )}
      </article>
      {node.markdown.trim() === '' || actionsUnavailable ? null : (
        <MessageActions
          text={node.markdown}
          {...(onBranch === undefined
            ? {}
            : { onBranch: node.sequence === undefined ? () => undefined : () => onBranch(node.sequence!) })}
          branchUnavailable={branchUnavailable}
          translate={t}
        />
      )}
    </div>
  )
}

function StreamingActivity(props: {
  readonly id: string
  readonly usingTool?: boolean
  readonly translate: Translate
}): ReactElement {
  const phraseKeys = [
    'timeline.activity.deepDiving',
    'timeline.activity.thinking',
    'timeline.activity.checking',
    'timeline.activity.composing',
  ] as const
  const key =
    props.usingTool === true
      ? 'timeline.activity.usingTool'
      : (phraseKeys[stableHash(props.id) % phraseKeys.length] ?? 'timeline.activity.deepDiving')
  return (
    <span className="dsh-timeline__streaming-status" role="status" aria-live="polite">
      <Icon name={props.usingTool === true ? 'tool' : 'sparkles'} />
      <span>{props.translate(key)}</span>
    </span>
  )
}

function assistantNodeInProgress(
  node:
    | Pick<AssistantTurnNode, 'streaming' | 'reasoning' | 'tools' | 'turn'>
    | Extract<DisplayTimelineNode, { readonly kind: 'assistant-message' }>,
): boolean {
  return (
    node.streaming ||
    node.reasoning?.streaming === true ||
    ('tools' in node &&
      node.tools.some((tool) => tool.tool.status === 'queued' || tool.tool.status === 'running'))
  )
}

function stableHash(value: string): number {
  let hash = 0
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return hash
}

function renderReasoning(
  reasoning: {
    readonly markdown: string
    readonly streaming: boolean
  },
  onOpenLink?: (href: string) => void,
  t: Translate = (key) => key,
): ReactElement {
  return (
    <details className="dsh-timeline__reasoning">
      <summary className="dsh-timeline__reasoning-summary" aria-label={t('timeline.showReasoning')}>
        <span>{t('timeline.thinking')}</span>
        <span className="dsh-timeline__reasoning-meta">
          {reasoning.streaming ? <span className="dsh-sr-only">{t('timeline.inProgress')}</span> : null}
          <span className="dsh-timeline__disclosure" aria-hidden="true">
            <Icon name="chevron-down" />
          </span>
        </span>
      </summary>
      <MarkdownContent markdown={reasoning.markdown} onOpenLink={onOpenLink} />
    </details>
  )
}

function renderToolCard(
  node: ToolTimelineNode,
  expanded: ReadonlySet<string>,
  setExpanded: (next: ReadonlySet<string>) => void,
  t: Translate = (key) => key,
): ReactElement {
  return (
    <ToolCard
      tool={node.tool}
      expanded={expanded.has(node.id)}
      translate={t}
      onToggle={() => {
        const next = new Set(expanded)
        if (next.has(node.id)) next.delete(node.id)
        else next.add(node.id)
        setExpanded(next)
      }}
    />
  )
}

function renderToolCollection(
  tools: readonly ToolTimelineNode[],
  expanded: ReadonlySet<string>,
  setExpanded: (next: ReadonlySet<string>) => void,
  t: Translate = (key) => key,
): ReactElement {
  if (tools.length === 1) {
    const tool = tools[0]
    if (tool !== undefined) return renderToolCard(tool, expanded, setExpanded, t)
  }
  const latest = tools[tools.length - 1]!
  return (
    <details className="dsh-timeline__reasoning dsh-timeline__tool-group">
      <summary
        className="dsh-timeline__reasoning-summary dsh-timeline__tool-group-summary"
        aria-label={t('timeline.showToolCalls', { count: tools.length })}
      >
        <span className="dsh-timeline__tool-group-icon" aria-hidden="true">
          <Icon name="tool" />
        </span>
        <span className="dsh-timeline__tool-group-count" aria-hidden="true">
          {tools.length}
        </span>
        <span className="dsh-timeline__tool-group-latest" title={toolSummary(latest.tool, t)}>
          {toolSummary(latest.tool, t)}
        </span>
        <span className="dsh-timeline__reasoning-meta">
          <span className="dsh-timeline__disclosure" aria-hidden="true">
            <Icon name="chevron-down" />
          </span>
        </span>
      </summary>
      <div className="dsh-timeline__tool-group-list">
        {tools.map((toolNode) => (
          <div key={toolNode.id}>{renderToolCard(toolNode, expanded, setExpanded, t)}</div>
        ))}
      </div>
    </details>
  )
}

function toolSummary(tool: ToolTimelineNode['tool'], t: Translate = (key) => key): string {
  const title = tool.title.trim()
  const name = tool.name.trim()
  const label =
    title !== '' && title.toLowerCase() !== 'tool' ? title : name || title || t('timeline.toolFallback')
  return `${label} · ${tool.status}`
}

function compactionMeta(
  compaction: Extract<TimelineNode, { readonly kind: 'compaction' }>['compaction'],
  t: Translate = (key) => key,
): string {
  const parts: string[] = []
  if (compaction.replacedCount !== undefined)
    parts.push(t('timeline.compactionEntries', { count: compaction.replacedCount }))
  if (compaction.estimatedTokens !== undefined)
    parts.push(t('timeline.compactionTokens', { count: formatTokenCount(compaction.estimatedTokens) }))
  if (parts.length === 0) parts.push(compaction.phase)
  return parts.join(' · ')
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return `${value}`
}

/**
 * Render the same completed-run duration that DSH exposes in chat chrome.
 * Missing boundaries stay hidden: a historical or interrupted message must
 * not display a duration invented by the Webview clock.
 */
function assistantDurationLabel(
  timing: AssistantTiming | undefined,
  t: Translate = (key) => key,
): string | undefined {
  const start = timing?.stepStartTime
  const end = timing?.completedTime
  if (start === undefined || start === null || end === undefined || end === null) return undefined
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const duration = minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`
  return t('timeline.ranFor', { duration })
}

function nodeSignature(node: DisplayTimelineNode | undefined): string {
  if (node === undefined) return ''
  if (node.kind === 'assistant-turn') {
    const latest = node.tools[node.tools.length - 1]
    return `${node.id}:${node.markdown.length}:${node.streaming}:${node.reasoning?.markdown.length ?? 0}:${node.reasoning?.streaming ?? false}:${node.tools.length}:${latest?.tool.status ?? ''}`
  }
  if (node.kind === 'assistant-message')
    return `${node.id}:${node.markdown.length}:${node.streaming}:${node.reasoning?.markdown.length ?? 0}:${node.reasoning?.streaming ?? false}`
  if (node.kind === 'reasoning') return `${node.id}:${node.markdown.length}:${node.streaming}`
  if (node.kind === 'event-group') return `${node.id}:${node.events.length}`
  return node.id
}

function branchUnavailableForNode(node: DisplayTimelineNode, branching: boolean): boolean {
  if (node.kind !== 'assistant-message' && node.kind !== 'assistant-turn') return true
  return (
    branching ||
    assistantNodeInProgress(node) ||
    (node.turn !== undefined && node.turnCompleted !== true) ||
    node.sequence === undefined
  )
}

function formatEventPayload(value: unknown, t: Translate = (key) => key): string {
  try {
    const json = JSON.stringify(value, null, 2)
    return (json ?? '').slice(0, 8_192)
  } catch {
    return t('timeline.payloadUnavailable')
  }
}

function prepareDisplayNodes(
  nodes: readonly TimelineNode[],
  showDshEvents: boolean,
): readonly DisplayTimelineNode[] {
  const display: DisplayTimelineNode[] = []

  for (const node of nodes) {
    if (
      node.kind === 'user-message' &&
      isInjectedUserMessage({
        type: 'message.user',
        sessionId: '',
        messageId: node.id,
        markdown: node.markdown,
        ...(node.source === undefined ? {} : { source: node.source }),
      })
    )
      continue
    if (node.kind !== 'event') {
      display.push(node)
      continue
    }
    if (!showDshEvents) continue

    const previous = display[display.length - 1]
    if (previous?.kind === 'event-group') {
      display[display.length - 1] = {
        ...previous,
        events: [...previous.events, node],
      }
    } else {
      display.push({ kind: 'event-group', id: `event-group:${node.id}`, events: [node] })
    }
  }

  return collapseAssistantTurns(display)
}

interface ReasoningBlock {
  readonly markdown: string
  readonly streaming: boolean
}

interface PendingAssistantWork {
  readonly id: string
  modelLabel?: string
  timing?: AssistantTiming
  reasoning?: ReasoningBlock | undefined
  readonly tools: ToolTimelineNode[]
  markdown: string
  streaming: boolean
  sequence?: number
  turn?: number
  step?: number
  turnCompleted?: boolean
}

function collapseAssistantTurns(nodes: readonly DisplayTimelineNode[]): readonly DisplayTimelineNode[] {
  const collapsed: DisplayTimelineNode[] = []
  let pending: PendingAssistantWork | undefined

  const flush = (): void => {
    if (pending === undefined) return
    collapsed.push({
      kind: 'assistant-turn',
      id: `assistant-turn:${pending.id}`,
      ...(pending.modelLabel === undefined ? {} : { modelLabel: pending.modelLabel }),
      ...(pending.timing === undefined ? {} : { timing: pending.timing }),
      ...(pending.reasoning === undefined ? {} : { reasoning: pending.reasoning }),
      tools: pending.tools,
      markdown: pending.markdown,
      streaming: pending.streaming || pending.reasoning?.streaming === true,
      ...(pending.sequence === undefined ? {} : { sequence: pending.sequence }),
      ...(pending.turn === undefined ? {} : { turn: pending.turn }),
      ...(pending.step === undefined ? {} : { step: pending.step }),
      ...(pending.turnCompleted === undefined ? {} : { turnCompleted: pending.turnCompleted }),
    })
    pending = undefined
  }

  for (const node of nodes) {
    if (node.kind === 'reasoning') {
      if (pending === undefined)
        pending = { id: node.id, reasoning: node, tools: [], markdown: '', streaming: node.streaming }
      else pending.reasoning = appendReasoning(pending.reasoning, node)
      continue
    }
    if (node.kind === 'tool') {
      if (pending === undefined) {
        const previous = collapsed[collapsed.length - 1]
        if (previous?.kind === 'assistant-message') {
          collapsed.pop()
          pending = pendingFromAssistantMessage(previous)
        } else if (previous?.kind === 'assistant-turn') {
          collapsed.pop()
          pending = {
            id: previous.id,
            ...(previous.modelLabel === undefined ? {} : { modelLabel: previous.modelLabel }),
            ...(previous.timing === undefined ? {} : { timing: previous.timing }),
            ...(previous.reasoning === undefined ? {} : { reasoning: previous.reasoning }),
            tools: [...previous.tools],
            markdown: previous.markdown,
            streaming: previous.streaming,
            ...(previous.sequence === undefined ? {} : { sequence: previous.sequence }),
            ...(previous.turn === undefined ? {} : { turn: previous.turn }),
            ...(previous.step === undefined ? {} : { step: previous.step }),
            ...(previous.turnCompleted === undefined ? {} : { turnCompleted: previous.turnCompleted }),
          }
        } else pending = { id: node.id, tools: [], markdown: '', streaming: false }
      }
      pending.tools.push(node)
      continue
    }
    if (node.kind === 'assistant-message') {
      const hasVisibleOutput = node.markdown.trim() !== ''
      if (pending !== undefined) {
        if (node.modelLabel !== undefined) pending.modelLabel = node.modelLabel
        if (node.timing !== undefined) pending.timing = node.timing
        if (node.sequence !== undefined) pending.sequence = node.sequence
        if (node.turn !== undefined) pending.turn = node.turn
        if (node.step !== undefined) pending.step = node.step
        if (node.turnCompleted !== undefined) pending.turnCompleted = node.turnCompleted
        pending.reasoning = appendReasoning(pending.reasoning, node.reasoning)
        pending.markdown = joinAssistantMarkdown(pending.markdown, node.markdown)
        pending.streaming = node.streaming
        if (!hasVisibleOutput) continue

        collapsed.push(toAssistantTurn(pending, node.id))
        pending = undefined
        continue
      }
      if (node.reasoning !== undefined) {
        if (hasVisibleOutput) {
          collapsed.push({
            kind: 'assistant-turn',
            id: `assistant-turn:${node.id}`,
            ...(node.modelLabel === undefined ? {} : { modelLabel: node.modelLabel }),
            ...(node.timing === undefined ? {} : { timing: node.timing }),
            reasoning: node.reasoning,
            tools: [],
            markdown: node.markdown,
            streaming: node.streaming,
            ...(node.sequence === undefined ? {} : { sequence: node.sequence }),
            ...(node.turn === undefined ? {} : { turn: node.turn }),
            ...(node.step === undefined ? {} : { step: node.step }),
            ...(node.turnCompleted === undefined ? {} : { turnCompleted: node.turnCompleted }),
          })
        } else {
          pending = pendingFromAssistantMessage(node)
        }
        continue
      }
      collapsed.push(node)
      continue
    }

    flush()
    collapsed.push(node)
  }
  flush()
  return collapsed
}

function pendingFromAssistantMessage(
  node: Extract<DisplayTimelineNode, { readonly kind: 'assistant-message' }>,
): PendingAssistantWork {
  return {
    id: node.id,
    ...(node.modelLabel === undefined ? {} : { modelLabel: node.modelLabel }),
    ...(node.timing === undefined ? {} : { timing: node.timing }),
    ...(node.reasoning === undefined ? {} : { reasoning: node.reasoning }),
    tools: [],
    markdown: node.markdown,
    streaming: node.streaming,
    ...(node.sequence === undefined ? {} : { sequence: node.sequence }),
    ...(node.turn === undefined ? {} : { turn: node.turn }),
    ...(node.step === undefined ? {} : { step: node.step }),
    ...(node.turnCompleted === undefined ? {} : { turnCompleted: node.turnCompleted }),
  }
}

function toAssistantTurn(pending: PendingAssistantWork, id: string): AssistantTurnNode {
  return {
    kind: 'assistant-turn',
    id: `assistant-turn:${id}`,
    ...(pending.modelLabel === undefined ? {} : { modelLabel: pending.modelLabel }),
    ...(pending.timing === undefined ? {} : { timing: pending.timing }),
    ...(pending.reasoning === undefined ? {} : { reasoning: pending.reasoning }),
    tools: pending.tools,
    markdown: pending.markdown,
    streaming: pending.streaming || pending.reasoning?.streaming === true,
    ...(pending.sequence === undefined ? {} : { sequence: pending.sequence }),
    ...(pending.turn === undefined ? {} : { turn: pending.turn }),
    ...(pending.step === undefined ? {} : { step: pending.step }),
    ...(pending.turnCompleted === undefined ? {} : { turnCompleted: pending.turnCompleted }),
  }
}

function joinAssistantMarkdown(left: string, right: string): string {
  if (left.trim() === '') return right
  if (right.trim() === '') return left
  if (left === right || left.endsWith(right)) return left
  if (right.startsWith(left)) return right
  return `${left}\n\n${right}`
}

function appendReasoning(
  left: ReasoningBlock | undefined,
  right: ReasoningBlock | undefined,
): ReasoningBlock | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return {
    markdown: joinReasoning(left.markdown, right.markdown),
    streaming: left.streaming || right.streaming,
  }
}

function joinReasoning(left: string, right: string): string {
  if (left === '') return right
  if (right === '') return left
  // A completed assistant message may repeat the reasoning already delivered
  // by deltas. Keep one copy instead of showing a duplicated chain of thought.
  if (left === right || left.endsWith(right)) return left
  if (right.startsWith(left)) return right
  return `${left}\n\n${right}`
}
