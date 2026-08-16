import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ToolCard } from '@dsh-vscode/ui'
import { MarkdownContent } from './MarkdownContent.js'
import { Icon } from '../../ui/Icon.js'

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
  readonly reasoning?: {
    readonly markdown: string
    readonly streaming: boolean
  }
  readonly tools: readonly ToolTimelineNode[]
  readonly markdown: string
  readonly streaming: boolean
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
  readonly assistantLabel?: string
  readonly onOpenLink?: (href: string) => void
}

export function Timeline(props: TimelineProps): ReactElement {
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
      <div
        ref={scrollRef}
        className="dsh-timeline"
        aria-label="Conversation timeline"
        onScroll={handleScroll}
      >
        {dshEventCount > 0 ? (
          <div className="dsh-timeline__toolbar">
            <button
              className="dsh-timeline__events-toggle"
              type="button"
              aria-pressed={showDshEvents}
              aria-label={showDshEvents ? 'Hide DSH events' : 'Show DSH events'}
              title={showDshEvents ? 'Hide DSH events' : `Show DSH events (${dshEventCount})`}
              onClick={() => setShowDshEvents((current) => !current)}
            >
              <Icon name="terminal" />
              <span aria-hidden="true">{dshEventCount}</span>
            </button>
          </div>
        ) : null}
        {displayNodes.length === 0 && dshEventCount === 0 ? (
          <p className="dsh-timeline__empty">Start a session by sending a prompt.</p>
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
                {renderNode(node, expandedTools, setExpandedTools, props.assistantLabel, props.onOpenLink)}
              </div>
            )
          })}
        </div>
        {props.streaming ? (
          <span className="dsh-sr-only" aria-live="polite">
            Response is streaming
          </span>
        ) : null}
      </div>
      {showJumpToLatest ? (
        <button
          className="dsh-timeline__jump"
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

function renderNode(
  node: DisplayTimelineNode,
  expanded: ReadonlySet<string>,
  setExpanded: (next: ReadonlySet<string>) => void,
  assistantLabel = 'Model',
  onOpenLink?: (href: string) => void,
): ReactElement {
  switch (node.kind) {
    case 'tool':
      return renderToolCard(node, expanded, setExpanded)
    case 'assistant-turn':
      return renderAssistantTurn(node, expanded, setExpanded, assistantLabel, onOpenLink)
    case 'goal':
      return (
        <section className="dsh-timeline__card dsh-timeline__card--event">
          <header className="dsh-timeline__card-header">
            <div className="dsh-timeline__card-heading">
              <span className="dsh-message-avatar dsh-message-avatar--system" aria-hidden="true">
                <Icon name="target" />
              </span>
              <strong>Goals</strong>
            </div>
            <span className="dsh-timeline__card-meta">{node.goals.length} items</span>
          </header>
          <ul className="dsh-timeline__event-list">
            {node.goals.map((goal) => (
              <li key={goal.id}>
                <span className="dsh-timeline__event-title">{goal.title}</span>
                <span className={`dsh-status-pill dsh-status-pill--${goal.status}`}>{goal.status}</span>
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
              <strong>To-do</strong>
            </div>
            <span className="dsh-timeline__card-meta">{node.todos.length} items</span>
          </header>
          <ul className="dsh-timeline__event-list">
            {node.todos.map((todo) => (
              <li key={todo.id}>
                <span className="dsh-timeline__event-title">{todo.content}</span>
                <span className={`dsh-status-pill dsh-status-pill--${todo.status}`}>{todo.status}</span>
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
              <strong>Context compaction</strong>
            </div>
            <span className="dsh-timeline__card-meta">{node.compaction.phase}</span>
          </summary>
          {node.compaction.summary === undefined ? null : (
            <MarkdownContent markdown={node.compaction.summary} onOpenLink={onOpenLink} />
          )}
        </details>
      )
    case 'job':
      return (
        <section className="dsh-timeline__card dsh-timeline__card--event">
          <header className="dsh-timeline__card-header">
            <div className="dsh-timeline__card-heading">
              <span className="dsh-message-avatar dsh-message-avatar--system" aria-hidden="true">
                <Icon name="terminal" />
              </span>
              <strong title={node.job.label}>{node.job.label}</strong>
            </div>
            <span className={`dsh-status-pill dsh-status-pill--${node.job.status}`}>
              {node.job.progress === undefined ? node.job.status : `${Math.round(node.job.progress * 100)}%`}
            </span>
          </header>
        </section>
      )
    case 'subagent':
      return (
        <section className="dsh-timeline__card dsh-timeline__card--event">
          <header className="dsh-timeline__card-header">
            <div className="dsh-timeline__card-heading">
              <span className="dsh-message-avatar dsh-message-avatar--system" aria-hidden="true">
                <Icon name="users" />
              </span>
              <strong title={node.subagent.label}>{node.subagent.label}</strong>
            </div>
            <span className={`dsh-status-pill dsh-status-pill--${node.subagent.status}`}>
              {node.subagent.status}
            </span>
          </header>
        </section>
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
              <span>Events</span>
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
                  <summary>Payload</summary>
                  <pre>{formatEventPayload(event.payload)}</pre>
                </details>
              </li>
            ))}
          </ol>
        </details>
      )
    case 'user-message':
      return (
        <article className="dsh-timeline__card dsh-timeline__card--user" aria-label="Your message">
          <MarkdownContent markdown={node.markdown} onOpenLink={onOpenLink} />
        </article>
      )
    case 'assistant-message':
      return (
        <article className="dsh-timeline__card dsh-timeline__card--assistant">
          <header className="dsh-timeline__card-header">
            <strong>{node.modelLabel ?? assistantLabel}</strong>
          </header>
          {node.reasoning === undefined ? null : renderReasoning(node.reasoning, onOpenLink)}
          {node.markdown.trim() === '' ? null : (
            <MarkdownContent markdown={node.markdown} onOpenLink={onOpenLink} />
          )}
          {node.streaming || node.reasoning?.streaming ? (
            <span className="dsh-sr-only" aria-live="polite">
              Response is streaming
            </span>
          ) : null}
        </article>
      )
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
      )
  }
}

function renderAssistantTurn(
  node: AssistantTurnNode,
  expanded: ReadonlySet<string>,
  setExpanded: (next: ReadonlySet<string>) => void,
  assistantLabel: string,
  onOpenLink?: (href: string) => void,
): ReactElement {
  return (
    <article className="dsh-timeline__card dsh-timeline__card--assistant">
      <header className="dsh-timeline__card-header">
        <strong>{node.modelLabel ?? assistantLabel}</strong>
      </header>
      {node.reasoning === undefined ? null : renderReasoning(node.reasoning, onOpenLink)}
      {node.tools.length === 0 ? null : (
        <div className="dsh-timeline__assistant-tools">
          {renderToolCollection(node.tools, expanded, setExpanded)}
        </div>
      )}
      {node.markdown.trim() === '' ? null : (
        <MarkdownContent markdown={node.markdown} onOpenLink={onOpenLink} />
      )}
      {node.streaming || node.reasoning?.streaming ? (
        <span className="dsh-sr-only" aria-live="polite">
          Response is streaming
        </span>
      ) : null}
    </article>
  )
}

function renderReasoning(
  reasoning: {
    readonly markdown: string
    readonly streaming: boolean
  },
  onOpenLink?: (href: string) => void,
): ReactElement {
  return (
    <details className="dsh-timeline__reasoning">
      <summary className="dsh-timeline__reasoning-summary" aria-label="Show reasoning">
        <span>Thinking</span>
        <span className="dsh-timeline__reasoning-meta">
          {reasoning.streaming ? <span className="dsh-sr-only">In progress</span> : null}
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
): ReactElement {
  return (
    <ToolCard
      tool={node.tool}
      expanded={expanded.has(node.id)}
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
): ReactElement {
  if (tools.length === 1) {
    const tool = tools[0]
    if (tool !== undefined) return renderToolCard(tool, expanded, setExpanded)
  }
  const latest = tools[tools.length - 1]!
  return (
    <details className="dsh-timeline__reasoning dsh-timeline__tool-group">
      <summary
        className="dsh-timeline__reasoning-summary dsh-timeline__tool-group-summary"
        aria-label={`Show ${tools.length} tool calls`}
      >
        <span className="dsh-timeline__tool-group-icon" aria-hidden="true">
          <Icon name="tool" />
        </span>
        <span className="dsh-timeline__tool-group-count" aria-hidden="true">
          {tools.length}
        </span>
        <span className="dsh-timeline__tool-group-latest" title={toolSummary(latest.tool)}>
          {toolSummary(latest.tool)}
        </span>
        <span className="dsh-timeline__reasoning-meta">
          <span className="dsh-timeline__disclosure" aria-hidden="true">
            <Icon name="chevron-down" />
          </span>
        </span>
      </summary>
      <div className="dsh-timeline__tool-group-list">
        {tools.map((toolNode) => (
          <div key={toolNode.id}>{renderToolCard(toolNode, expanded, setExpanded)}</div>
        ))}
      </div>
    </details>
  )
}

function toolSummary(tool: ToolTimelineNode['tool']): string {
  const title = tool.title.trim()
  const name = tool.name.trim()
  const label = title !== '' && title.toLowerCase() !== 'tool' ? title : name || title || 'Tool'
  return `${label} · ${tool.status}`
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

function formatEventPayload(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2)
    return (json ?? '').slice(0, 8_192)
  } catch {
    return '[event payload unavailable]'
  }
}

function prepareDisplayNodes(
  nodes: readonly TimelineNode[],
  showDshEvents: boolean,
): readonly DisplayTimelineNode[] {
  const display: DisplayTimelineNode[] = []

  for (const node of nodes) {
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
  reasoning?: ReasoningBlock | undefined
  readonly tools: ToolTimelineNode[]
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
      ...(pending.reasoning === undefined ? {} : { reasoning: pending.reasoning }),
      tools: pending.tools,
      markdown: '',
      streaming: pending.reasoning?.streaming ?? false,
    })
    pending = undefined
  }

  for (const node of nodes) {
    if (node.kind === 'reasoning') {
      if (pending === undefined) pending = { id: node.id, reasoning: node, tools: [] }
      else pending.reasoning = appendReasoning(pending.reasoning, node)
      continue
    }
    if (node.kind === 'tool') {
      if (pending === undefined) pending = { id: node.id, tools: [] }
      pending.tools.push(node)
      continue
    }
    if (node.kind === 'assistant-message') {
      const hasVisibleOutput = node.markdown.trim() !== ''
      if (pending !== undefined) {
        if (node.modelLabel !== undefined) pending.modelLabel = node.modelLabel
        pending.reasoning = appendReasoning(pending.reasoning, node.reasoning)
        if (!hasVisibleOutput) continue

        const modelLabel = node.modelLabel ?? pending.modelLabel
        collapsed.push({
          kind: 'assistant-turn',
          id: `assistant-turn:${node.id}`,
          ...(modelLabel === undefined ? {} : { modelLabel }),
          ...(pending.reasoning === undefined ? {} : { reasoning: pending.reasoning }),
          tools: pending.tools,
          markdown: node.markdown,
          streaming: node.streaming,
        })
        pending = undefined
        continue
      }
      if (node.reasoning !== undefined) {
        if (hasVisibleOutput) {
          collapsed.push({
            kind: 'assistant-turn',
            id: `assistant-turn:${node.id}`,
            ...(node.modelLabel === undefined ? {} : { modelLabel: node.modelLabel }),
            reasoning: node.reasoning,
            tools: [],
            markdown: node.markdown,
            streaming: node.streaming,
          })
        } else {
          pending = {
            id: node.id,
            ...(node.modelLabel === undefined ? {} : { modelLabel: node.modelLabel }),
            reasoning: node.reasoning,
            tools: [],
          }
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
