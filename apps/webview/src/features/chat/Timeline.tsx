import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react'
import { isInjectedUserMessage, type AssistantTiming, type TimelineNode } from '@dsh-vscode/timeline'
import type {
  MessageFeedbackItem,
  MessageFeedbackRating,
  MessageImageReference,
  TokenUsage,
} from '@dsh-vscode/domain'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ToolRendererRegistry } from '@dsh-vscode/ui'
import { MarkdownContent } from './MarkdownContent.js'
import { MessageImages } from './MessageImages.js'
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
  readonly usage?: TokenUsage
  readonly images?: readonly MessageImageReference[]
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
  readonly interrupted?: true
}

type DisplayTimelineNode =
  | Exclude<TimelineNode, DshEventNode | ToolTimelineNode>
  | ToolTimelineNode
  | DshEventGroupNode
  | AssistantTurnNode

const toolRendererRegistry = new ToolRendererRegistry()

export interface TimelineProps {
  readonly sessionId: string
  readonly nodes: readonly TimelineNode[]
  readonly streaming: boolean
  /** Authoritative session-level running bit from the host status stream. */
  readonly running?: boolean
  readonly assistantLabel?: string
  readonly onOpenLink?: (href: string) => void | Promise<void>
  readonly onLoadImage?: (image: MessageImageReference) => Promise<string | undefined>
  readonly onShowInFolder?: (href: string) => void
  readonly onOpenSession?: (sessionId: string) => void
  /** Fork the active session at a durable assistant-message sequence. */
  readonly onBranch?: (atSeq: number) => void
  readonly branching?: boolean
  /** DSH turn remains open across tool calls and multiple model steps. */
  readonly activeTurn?: number
  readonly feedback?: Readonly<Record<string, MessageFeedbackItem>>
  readonly feedbackUnavailable?: boolean | undefined
  readonly onFeedback?: (messageId: string, rating: MessageFeedbackRating) => void
  readonly onFeedbackNote?: (messageId: string, note: string | undefined) => Promise<void> | void
  /** Whether an older DSH history window is available. */
  readonly hasMoreHistory?: boolean
  readonly loadingOlderHistory?: boolean
  readonly onLoadOlderHistory?: () => Promise<void> | void
}

export function Timeline(props: TimelineProps): ReactElement {
  const { t } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const previousSessionRef = useRef(props.sessionId)
  const prependAnchorRef = useRef<{ readonly height: number; readonly top: number } | undefined>(undefined)
  const olderHistoryRequestRef = useRef(false)
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
  const hasMoreHistory = props.hasMoreHistory
  const loadingOlderHistory = props.loadingOlderHistory
  const onLoadOlderHistory = props.onLoadOlderHistory
  const usingTool = props.nodes.some(
    (node) => node.kind === 'tool' && (node.tool.status === 'queued' || node.tool.status === 'running'),
  )
  const onOpenLink = props.onOpenLink
  const [openLinkError, setOpenLinkError] = useState<{ readonly href: string; readonly message: string }>()
  const [openLinkBusy, setOpenLinkBusy] = useState(false)
  const requestOpenLink = useCallback(
    (href: string): void => {
      if (onOpenLink === undefined) return
      setOpenLinkError(undefined)
      setOpenLinkBusy(true)
      let operation: void | Promise<void>
      try {
        operation = onOpenLink(href)
      } catch (reason: unknown) {
        setOpenLinkError({
          href,
          message: reason instanceof Error ? reason.message : t('app.error.openLink'),
        })
        setOpenLinkBusy(false)
        return
      }
      void Promise.resolve(operation)
        .catch((reason: unknown) => {
          setOpenLinkError({
            href,
            message: reason instanceof Error ? reason.message : t('app.error.openLink'),
          })
        })
        .finally(() => setOpenLinkBusy(false))
    },
    [onOpenLink, t],
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
  const loadOlderHistory = useCallback((): void => {
    if (
      hasMoreHistory !== true ||
      loadingOlderHistory === true ||
      onLoadOlderHistory === undefined ||
      olderHistoryRequestRef.current
    )
      return
    const element = scrollRef.current
    if (element !== null) prependAnchorRef.current = { height: element.scrollHeight, top: element.scrollTop }
    olderHistoryRequestRef.current = true
    const result = onLoadOlderHistory()
    if (result === undefined) {
      olderHistoryRequestRef.current = false
      return
    }
    void result.finally(() => {
      olderHistoryRequestRef.current = false
    })
  }, [hasMoreHistory, loadingOlderHistory, onLoadOlderHistory])
  const handleScroll = useCallback((): void => {
    const element = scrollRef.current
    if (element === null) return
    if (element.scrollTop <= 24) loadOlderHistory()
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    const atLatest = distanceFromBottom <= 64
    stickToBottomRef.current = atLatest
    setShowJumpToLatest((current) => {
      const next = !atLatest && displayNodes.length > 0
      return current === next ? current : next
    })
  }, [displayNodes.length, loadOlderHistory])

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

  useEffect(() => {
    const anchor = prependAnchorRef.current
    const element = scrollRef.current
    if (anchor === undefined || element === null || props.loadingOlderHistory === true) return
    const restore = (): void => {
      const current = prependAnchorRef.current
      if (current === undefined) return
      element.scrollTop = element.scrollHeight - current.height + current.top
      prependAnchorRef.current = undefined
    }
    restore()
    const timer = window.setTimeout(restore, 80)
    return () => window.clearTimeout(timer)
  }, [props.loadingOlderHistory, props.nodes.length])

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
        {props.hasMoreHistory && props.onLoadOlderHistory !== undefined ? (
          <div className="dsh-timeline__history-more">
            <button
              type="button"
              className="dsh-timeline__history-more-button"
              disabled={props.loadingOlderHistory === true}
              onClick={loadOlderHistory}
            >
              {props.loadingOlderHistory === true ? t('timeline.loadingOlder') : t('timeline.loadOlder')}
            </button>
          </div>
        ) : null}
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
                  props.onOpenLink === undefined ? undefined : requestOpenLink,
                  props.onLoadImage,
                  props.onShowInFolder,
                  props.onOpenSession,
                  props.onBranch,
                  branchUnavailableForNode(node, props.branching === true),
                  running,
                  props.feedback,
                  props.onFeedback,
                  props.onFeedbackNote,
                  t,
                  props.feedbackUnavailable,
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
      {openLinkError === undefined ? null : (
        <ToolLinkErrorDialog
          href={openLinkError.href}
          message={openLinkError.message}
          busy={openLinkBusy}
          onClose={() => setOpenLinkError(undefined)}
          onRetry={() => requestOpenLink(openLinkError.href)}
          t={t}
        />
      )}
    </div>
  )
}

/** Host/OS refusal while opening a file or URL from a tool card. The retry
 * repeats the sanctioned Host open operation; it never replays a tool call. */
function ToolLinkErrorDialog({
  href,
  message,
  busy,
  onClose,
  onRetry,
  t,
}: {
  readonly href: string
  readonly message: string
  readonly busy: boolean
  readonly onClose: () => void
  readonly onRetry: () => void
  readonly t: Translate
}): ReactElement {
  const titleId = useId()
  const descriptionId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="dsh-tool-error-modal__backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        className="dsh-tool-error-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="dsh-tool-error-modal__header">
          <h2 id={titleId}>{t('timeline.openErrorTitle')}</h2>
          <button
            ref={closeRef}
            className="dsh-icon-button"
            type="button"
            aria-label={t('app.dismissError')}
            title={t('app.dismissError')}
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        <p id={descriptionId} className="dsh-tool-error-modal__message">
          {message}
        </p>
        <code className="dsh-tool-error-modal__path" title={href}>
          {href}
        </code>
        <footer className="dsh-tool-error-modal__actions">
          <button
            className="dsh-button dsh-button--secondary"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            {t('timeline.cancelOpen')}
          </button>
          <button className="dsh-button dsh-button--primary" type="button" onClick={onRetry} disabled={busy}>
            {t('timeline.retryOpen')}
          </button>
        </footer>
      </section>
    </div>
  )
}

function renderNode(
  node: DisplayTimelineNode,
  expanded: ReadonlySet<string>,
  setExpanded: (next: ReadonlySet<string>) => void,
  assistantLabel = 'Model',
  onOpenLink?: (href: string) => void,
  onLoadImage?: (image: MessageImageReference) => Promise<string | undefined>,
  onShowInFolder?: (href: string) => void,
  onOpenSession?: (sessionId: string) => void,
  onBranch?: (atSeq: number) => void,
  branchUnavailable = true,
  running = false,
  feedback?: Readonly<Record<string, MessageFeedbackItem>>,
  onFeedback?: (messageId: string, rating: MessageFeedbackRating) => void,
  onFeedbackNote?: (messageId: string, note: string | undefined) => Promise<void> | void,
  t: Translate = (key) => key,
  feedbackUnavailable = false,
): ReactElement {
  switch (node.kind) {
    case 'tool':
      return renderToolCard(node, expanded, setExpanded, t, onOpenLink)
    case 'assistant-turn':
      return renderAssistantTurn(
        node,
        expanded,
        setExpanded,
        assistantLabel,
        onOpenLink,
        onLoadImage,
        onShowInFolder,
        t,
        onBranch,
        branchUnavailable,
        running,
        feedback,
        onFeedback,
        onFeedbackNote,
        feedbackUnavailable,
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
    case 'team':
      return renderTeamActivity(node.activity, t)
    case 'command-input':
      return (
        <article className="dsh-timeline__command-input" aria-label={t('timeline.commandInput')}>
          <Icon name="terminal" />
          <code>{node.text}</code>
        </article>
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
    case 'turn-terminal':
      return (
        <p
          className={`dsh-timeline__turn-terminal dsh-timeline__turn-terminal--${node.reason}`}
          data-reason={node.reason}
          role="status"
        >
          <Icon name="alert" />
          <span>{turnTerminalLabel(node.reason, t)}</span>
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
            <MessageImages
              images={node.images ?? []}
              {...(onLoadImage === undefined ? {} : { loadImage: onLoadImage })}
              translate={t}
            />
            {node.markdown.trim() === '' ? null : (
              <MarkdownContent markdown={node.markdown} onOpenLink={onOpenLink} />
            )}
          </article>
          {node.markdown.trim() === '' ? null : <MessageActions text={node.markdown} translate={t} />}
        </div>
      )
    case 'assistant-message':
      return renderAssistantMessage(
        node,
        assistantLabel,
        onOpenLink,
        onLoadImage,
        onShowInFolder,
        t,
        onBranch,
        branchUnavailable,
        running,
        feedback,
        onFeedback,
        onFeedbackNote,
        feedbackUnavailable,
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
        onLoadImage,
        onShowInFolder,
        t,
        undefined,
        true,
        running,
        feedback,
        onFeedback,
        undefined,
        feedbackUnavailable,
      )
  }
}

function renderTeamActivity(
  activity: Extract<TimelineNode, { readonly kind: 'team' }>['activity'],
  t: Translate = (key) => key,
): ReactElement {
  const title =
    activity.kind === 'member'
      ? activity.name
      : activity.kind === 'task'
        ? activity.subject
        : (activity.content ?? activity.messageId)
  const status =
    activity.kind === 'member'
      ? activity.phase
      : activity.kind === 'task'
        ? activity.status
        : activity.kind === 'message.queued'
          ? (activity.delivery ?? 'queued')
          : 'delivered'
  return (
    <section className="dsh-timeline__card dsh-timeline__card--event" aria-label={t('timeline.teamActivity')}>
      <header className="dsh-timeline__card-header">
        <div className="dsh-timeline__card-heading">
          <span className="dsh-message-avatar dsh-message-avatar--system" aria-hidden="true">
            <Icon name="users" />
          </span>
          <strong>{t('timeline.teamActivity')}</strong>
        </div>
        <span className="dsh-status-pill dsh-status-pill--info">{status}</span>
      </header>
      <ul className="dsh-timeline__event-list">
        <li>
          <span className="dsh-timeline__event-title">{title}</span>
          {activity.kind === 'task' && activity.blockedByCount > 0 ? (
            <span className="dsh-timeline__card-meta">
              {t('timeline.teamBlockedBy', { count: activity.blockedByCount })}
            </span>
          ) : null}
          {activity.kind === 'member' && activity.error !== undefined ? (
            <span className="dsh-timeline__card-meta">{activity.error}</span>
          ) : null}
          {activity.kind === 'message.queued' && activity.targetId !== '' ? (
            <span className="dsh-timeline__card-meta">
              {t('timeline.teamTarget', { target: activity.targetId })}
            </span>
          ) : null}
        </li>
      </ul>
    </section>
  )
}

function renderAssistantTurn(
  node: AssistantTurnNode,
  expanded: ReadonlySet<string>,
  setExpanded: (next: ReadonlySet<string>) => void,
  assistantLabel: string,
  onOpenLink?: (href: string) => void,
  onLoadImage?: (image: MessageImageReference) => Promise<string | undefined>,
  onShowInFolder?: (href: string) => void,
  t: Translate = (key) => key,
  onBranch?: (atSeq: number) => void,
  branchUnavailable = true,
  running = false,
  feedback?: Readonly<Record<string, MessageFeedbackItem>>,
  onFeedback?: (messageId: string, rating: MessageFeedbackRating) => void,
  onFeedbackNote?: (messageId: string, note: string | undefined) => Promise<void> | void,
  feedbackUnavailable = false,
): ReactElement {
  const inProgress = assistantNodeInProgress(node)
  const actionsUnavailable = running || inProgress || (node.turn !== undefined && node.turnCompleted !== true)
  const producedFiles = producedFilePaths(node.tools)
  return (
    <div className="dsh-timeline__message-stack">
      <article className="dsh-timeline__card dsh-timeline__card--assistant">
        <header className="dsh-timeline__card-header">
          <strong>{node.modelLabel ?? assistantLabel}</strong>
          {node.interrupted === true ? (
            <span className="dsh-timeline__card-meta">{t('timeline.interrupted')}</span>
          ) : null}
          {assistantDurationLabel(node.timing, t) === undefined ? null : (
            <span className="dsh-timeline__assistant-duration">{assistantDurationLabel(node.timing, t)}</span>
          )}
          {assistantMetricsLabel(node.timing, node.usage, t) === undefined ? null : (
            <span
              className="dsh-timeline__assistant-metrics"
              title={assistantMetricsLabel(node.timing, node.usage, t)}
            >
              {assistantMetricsLabel(node.timing, node.usage, t)}
            </span>
          )}
        </header>
        {node.reasoning === undefined ? null : renderReasoning(node.reasoning, onOpenLink, t)}
        <MessageImages
          images={node.images ?? []}
          {...(onLoadImage === undefined ? {} : { loadImage: onLoadImage })}
          translate={t}
        />
        {node.tools.length === 0 ? null : (
          <div className="dsh-timeline__assistant-tools">
            {renderToolCollection(node.tools, expanded, setExpanded, t, onOpenLink)}
          </div>
        )}
        {node.markdown.trim() === '' ? null : (
          <MarkdownContent
            markdown={node.markdown}
            streaming={node.streaming}
            onOpenLink={onOpenLink}
            producedFiles={producedFiles}
          />
        )}
        {renderProducedFiles(producedFiles, onOpenLink, onShowInFolder, t)}
      </article>
      {node.markdown.trim() === '' || actionsUnavailable ? null : (
        <MessageActions
          text={node.markdown}
          {...feedbackActionProps(
            assistantMessageId(node),
            feedback,
            onFeedback,
            onFeedbackNote,
            feedbackUnavailable,
          )}
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
  onLoadImage: ((image: MessageImageReference) => Promise<string | undefined>) | undefined,
  onShowInFolder: ((href: string) => void) | undefined,
  t: Translate,
  onBranch: ((atSeq: number) => void) | undefined,
  branchUnavailable: boolean,
  running = false,
  feedback?: Readonly<Record<string, MessageFeedbackItem>>,
  onFeedback?: (messageId: string, rating: MessageFeedbackRating) => void,
  onFeedbackNote?: (messageId: string, note: string | undefined) => Promise<void> | void,
  feedbackUnavailable = false,
): ReactElement {
  const inProgress = assistantNodeInProgress(node)
  const actionsUnavailable = running || inProgress || (node.turn !== undefined && node.turnCompleted !== true)
  return (
    <div className="dsh-timeline__message-stack">
      <article className="dsh-timeline__card dsh-timeline__card--assistant">
        <header className="dsh-timeline__card-header">
          <strong>{node.modelLabel ?? assistantLabel}</strong>
          {node.interrupted === true ? (
            <span className="dsh-timeline__card-meta">{t('timeline.interrupted')}</span>
          ) : null}
          {assistantDurationLabel(node.timing, t) === undefined ? null : (
            <span className="dsh-timeline__assistant-duration">{assistantDurationLabel(node.timing, t)}</span>
          )}
          {assistantMetricsLabel(node.timing, node.usage, t) === undefined ? null : (
            <span
              className="dsh-timeline__assistant-metrics"
              title={assistantMetricsLabel(node.timing, node.usage, t)}
            >
              {assistantMetricsLabel(node.timing, node.usage, t)}
            </span>
          )}
        </header>
        {node.reasoning === undefined ? null : renderReasoning(node.reasoning, onOpenLink, t)}
        <MessageImages
          images={node.images ?? []}
          {...(onLoadImage === undefined ? {} : { loadImage: onLoadImage })}
          translate={t}
        />
        {node.markdown.trim() === '' ? null : (
          <MarkdownContent markdown={node.markdown} streaming={node.streaming} onOpenLink={onOpenLink} />
        )}
      </article>
      {node.markdown.trim() === '' || actionsUnavailable ? null : (
        <MessageActions
          text={node.markdown}
          {...feedbackActionProps(node.id, feedback, onFeedback, onFeedbackNote, feedbackUnavailable)}
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

function assistantMessageId(node: AssistantTurnNode): string | undefined {
  if (!node.id.startsWith('assistant-turn:')) return undefined
  let id = node.id
  while (id.startsWith('assistant-turn:')) id = id.slice('assistant-turn:'.length)
  return id === '' ? undefined : id
}

function feedbackActionProps(
  messageId: string | undefined,
  feedback: Readonly<Record<string, MessageFeedbackItem>> | undefined,
  onFeedback: ((messageId: string, rating: MessageFeedbackRating) => void) | undefined,
  onFeedbackNote: ((messageId: string, note: string | undefined) => Promise<void> | void) | undefined,
  feedbackUnavailable: boolean,
): {
  readonly feedbackRating?: MessageFeedbackRating
  readonly feedbackNote?: string
  readonly onFeedback?: (rating: MessageFeedbackRating) => void
  readonly onFeedbackNote?: (note: string | undefined) => Promise<void> | void
  readonly feedbackUnavailable?: boolean
} {
  if (messageId === undefined || (onFeedback === undefined && onFeedbackNote === undefined)) return {}
  const rating = feedback?.[messageId]?.rating
  return {
    ...(rating === undefined ? {} : { feedbackRating: rating }),
    ...(feedback?.[messageId]?.note === undefined ? {} : { feedbackNote: feedback[messageId].note }),
    ...(onFeedback === undefined
      ? {}
      : { onFeedback: (next: MessageFeedbackRating) => onFeedback(messageId, next) }),
    ...(onFeedbackNote === undefined
      ? {}
      : { onFeedbackNote: (note: string | undefined) => onFeedbackNote(messageId, note) }),
    ...(feedbackUnavailable ? { feedbackUnavailable: true } : {}),
  }
}

function renderProducedFiles(
  paths: readonly string[],
  onOpenLink: ((href: string) => void) | undefined,
  onShowInFolder: ((href: string) => void) | undefined,
  t: Translate,
): ReactElement | null {
  if (paths.length === 0) return null
  return (
    <div className="dsh-timeline__produced-files" aria-label={t('timeline.producedFiles')}>
      <span className="dsh-timeline__produced-label">{t('timeline.producedFiles')}</span>
      <div className="dsh-timeline__produced-list">
        {paths.map((path) => {
          const label = producedFileLabel(path)
          return onOpenLink === undefined ? (
            <span className="dsh-timeline__produced-chip" key={path} title={path}>
              <Icon name="file" />
              <span>{label}</span>
            </span>
          ) : (
            <button
              className="dsh-timeline__produced-chip"
              key={path}
              type="button"
              title={path}
              aria-label={t('timeline.openProduced', { name: path })}
              onClick={() => onOpenLink(path)}
            >
              <Icon name="file" />
              <span>{label}</span>
            </button>
          )
        })}
      </div>
      {onShowInFolder === undefined ? null : (
        <button
          className="dsh-button dsh-button--secondary dsh-button--compact dsh-timeline__show-folder"
          type="button"
          onClick={() => onShowInFolder(paths[0]!)}
        >
          {t('timeline.showInFolder')}
        </button>
      )}
    </div>
  )
}

function producedFilePaths(tools: readonly ToolTimelineNode[]): readonly string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const node of tools) {
    const tool = node.tool
    if (tool.status !== 'completed' || !isMutationTool(tool)) continue
    for (const location of tool.locations ?? []) {
      if (seen.has(location.path)) continue
      seen.add(location.path)
      paths.push(location.path)
      if (paths.length >= 6) return paths
    }
  }
  return paths
}

function isMutationTool(tool: ToolTimelineNode['tool']): boolean {
  const metadata = tool.metadata
  return (
    tool.category === 'diff' ||
    tool.category === 'edit' ||
    metadata.card === 'diff' ||
    metadata.kind === 'edit'
  )
}

function producedFileLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, '')
  const slash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return slash >= 0 && slash + 1 < normalized.length ? normalized.slice(slash + 1) : normalized
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
      <MarkdownContent
        markdown={reasoning.markdown}
        streaming={reasoning.streaming}
        onOpenLink={onOpenLink}
      />
    </details>
  )
}

function renderToolCard(
  node: ToolTimelineNode,
  expanded: ReadonlySet<string>,
  setExpanded: (next: ReadonlySet<string>) => void,
  t: Translate = (key) => key,
  onOpenLink?: (href: string) => void,
): ReactElement {
  const onToggle = (): void => {
    const next = new Set(expanded)
    if (next.has(node.id)) next.delete(node.id)
    else next.add(node.id)
    setExpanded(next)
  }
  return toolRendererRegistry.render(node.tool, {
    expanded: expanded.has(node.id),
    translate: t,
    onToggle,
    ...(onOpenLink === undefined ? {} : { onOpenLink }),
  })
}

function renderToolCollection(
  tools: readonly ToolTimelineNode[],
  expanded: ReadonlySet<string>,
  setExpanded: (next: ReadonlySet<string>) => void,
  t: Translate = (key) => key,
  onOpenLink?: (href: string) => void,
): ReactElement {
  if (tools.length === 1) {
    const tool = tools[0]
    if (tool !== undefined) return renderToolCard(tool, expanded, setExpanded, t, onOpenLink)
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
          <div key={toolNode.id}>{renderToolCard(toolNode, expanded, setExpanded, t, onOpenLink)}</div>
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

function turnTerminalLabel(
  reason: Extract<TimelineNode, { readonly kind: 'turn-terminal' }>['reason'],
  t: Translate,
): string {
  switch (reason) {
    case 'max-tokens':
      return t('timeline.turnMaxTokens')
    case 'error':
      return t('timeline.turnError')
    case 'blocked':
      return t('timeline.turnBlocked')
    case 'aborted':
      return t('timeline.turnAborted')
    case 'interrupted':
      return t('timeline.turnInterrupted')
    default:
      return t('timeline.turnEndedUnexpectedly')
  }
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

/**
 * Per-message hover telemetry. Every value is derived only from DSH durable
 * timing/usage fields; the Webview never starts its own stopwatch for a
 * completed message.
 */
function assistantMetricsLabel(
  timing: AssistantTiming | undefined,
  usage: TokenUsage | undefined,
  t: Translate = (key) => key,
): string | undefined {
  if (timing === undefined) return undefined
  const parts: string[] = []
  if (timing.stepStartTime !== null && timing.firstTokenTime !== null) {
    parts.push(
      t('timeline.metrics.ttft', {
        duration: formatMetricDuration(Math.max(0, timing.firstTokenTime - timing.stepStartTime)),
      }),
    )
  }
  if (usage !== undefined && timing.firstTokenTime !== null && timing.completedTime !== null) {
    const seconds = Math.max(0, timing.completedTime - timing.firstTokenTime) / 1_000
    if (seconds > 0 && usage.outputTokens > 0)
      parts.push(
        t('timeline.metrics.rate', {
          rate: formatMetricRate(usage.outputTokens / seconds),
        }),
      )
  }
  return parts.length === 0 ? undefined : parts.join(' · ')
}

function formatMetricDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`
  return `${Math.round((milliseconds / 1_000) * 10) / 10}s`
}

function formatMetricRate(value: number): string {
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K tok/s`
  return `${Math.round(value * 10) / 10} tok/s`
}

function nodeSignature(node: DisplayTimelineNode | undefined): string {
  if (node === undefined) return ''
  if (node.kind === 'assistant-turn') {
    const latest = node.tools[node.tools.length - 1]
    return `${node.id}:${node.markdown.length}:${node.streaming}:${node.interrupted === true}:${node.reasoning?.markdown.length ?? 0}:${node.reasoning?.streaming ?? false}:${node.images?.map((image) => image.attachmentId).join('|') ?? ''}:${node.tools.length}:${latest?.tool.status ?? ''}:${latest?.tool.locations?.map((location) => location.path).join('|') ?? ''}`
  }
  if (node.kind === 'assistant-message')
    return `${node.id}:${node.markdown.length}:${node.streaming}:${node.interrupted === true}:${node.reasoning?.markdown.length ?? 0}:${node.reasoning?.streaming ?? false}:${node.images?.map((image) => image.attachmentId).join('|') ?? ''}`
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
  usage?: TokenUsage
  images?: readonly MessageImageReference[]
  reasoning?: ReasoningBlock | undefined
  readonly tools: ToolTimelineNode[]
  markdown: string
  streaming: boolean
  sequence?: number
  turn?: number
  step?: number
  turnCompleted?: boolean
  interrupted?: true
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
      ...(pending.usage === undefined ? {} : { usage: pending.usage }),
      ...(pending.images === undefined ? {} : { images: pending.images }),
      ...(pending.reasoning === undefined ? {} : { reasoning: pending.reasoning }),
      tools: pending.tools,
      markdown: pending.markdown,
      streaming: pending.streaming || pending.reasoning?.streaming === true,
      ...(pending.sequence === undefined ? {} : { sequence: pending.sequence }),
      ...(pending.turn === undefined ? {} : { turn: pending.turn }),
      ...(pending.step === undefined ? {} : { step: pending.step }),
      ...(pending.turnCompleted === undefined ? {} : { turnCompleted: pending.turnCompleted }),
      ...(pending.interrupted === undefined ? {} : { interrupted: pending.interrupted }),
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
            ...(previous.usage === undefined ? {} : { usage: previous.usage }),
            ...(previous.images === undefined ? {} : { images: previous.images }),
            ...(previous.reasoning === undefined ? {} : { reasoning: previous.reasoning }),
            tools: [...previous.tools],
            markdown: previous.markdown,
            streaming: previous.streaming,
            ...(previous.sequence === undefined ? {} : { sequence: previous.sequence }),
            ...(previous.turn === undefined ? {} : { turn: previous.turn }),
            ...(previous.step === undefined ? {} : { step: previous.step }),
            ...(previous.turnCompleted === undefined ? {} : { turnCompleted: previous.turnCompleted }),
            ...(previous.interrupted === undefined ? {} : { interrupted: previous.interrupted }),
          }
        } else pending = { id: node.id, tools: [], markdown: '', streaming: false }
      }
      pending.tools.push(node)
      continue
    }
    if (node.kind === 'assistant-message') {
      const hasVisibleOutput = node.markdown.trim() !== '' || (node.images?.length ?? 0) > 0
      if (pending !== undefined) {
        if (node.modelLabel !== undefined) pending.modelLabel = node.modelLabel
        if (node.timing !== undefined) pending.timing = node.timing
        if (node.usage !== undefined) pending.usage = node.usage
        if (node.images !== undefined) pending.images = mergeImages(pending.images, node.images)
        if (node.sequence !== undefined) pending.sequence = node.sequence
        if (node.turn !== undefined) pending.turn = node.turn
        if (node.step !== undefined) pending.step = node.step
        if (node.turnCompleted !== undefined) pending.turnCompleted = node.turnCompleted
        if (node.interrupted !== undefined) pending.interrupted = node.interrupted
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
            ...(node.usage === undefined ? {} : { usage: node.usage }),
            ...(node.images === undefined ? {} : { images: node.images }),
            reasoning: node.reasoning,
            tools: [],
            markdown: node.markdown,
            streaming: node.streaming,
            ...(node.sequence === undefined ? {} : { sequence: node.sequence }),
            ...(node.turn === undefined ? {} : { turn: node.turn }),
            ...(node.step === undefined ? {} : { step: node.step }),
            ...(node.turnCompleted === undefined ? {} : { turnCompleted: node.turnCompleted }),
            ...(node.interrupted === undefined ? {} : { interrupted: node.interrupted }),
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
    ...(node.usage === undefined ? {} : { usage: node.usage }),
    ...(node.images === undefined ? {} : { images: node.images }),
    ...(node.reasoning === undefined ? {} : { reasoning: node.reasoning }),
    tools: [],
    markdown: node.markdown,
    streaming: node.streaming,
    ...(node.sequence === undefined ? {} : { sequence: node.sequence }),
    ...(node.turn === undefined ? {} : { turn: node.turn }),
    ...(node.step === undefined ? {} : { step: node.step }),
    ...(node.turnCompleted === undefined ? {} : { turnCompleted: node.turnCompleted }),
    ...(node.interrupted === undefined ? {} : { interrupted: node.interrupted }),
  }
}

function toAssistantTurn(pending: PendingAssistantWork, id: string): AssistantTurnNode {
  return {
    kind: 'assistant-turn',
    id: `assistant-turn:${id}`,
    ...(pending.modelLabel === undefined ? {} : { modelLabel: pending.modelLabel }),
    ...(pending.timing === undefined ? {} : { timing: pending.timing }),
    ...(pending.usage === undefined ? {} : { usage: pending.usage }),
    ...(pending.images === undefined ? {} : { images: pending.images }),
    ...(pending.reasoning === undefined ? {} : { reasoning: pending.reasoning }),
    tools: pending.tools,
    markdown: pending.markdown,
    streaming: pending.streaming || pending.reasoning?.streaming === true,
    ...(pending.sequence === undefined ? {} : { sequence: pending.sequence }),
    ...(pending.turn === undefined ? {} : { turn: pending.turn }),
    ...(pending.step === undefined ? {} : { step: pending.step }),
    ...(pending.turnCompleted === undefined ? {} : { turnCompleted: pending.turnCompleted }),
    ...(pending.interrupted === undefined ? {} : { interrupted: pending.interrupted }),
  }
}

function mergeImages(
  left: readonly MessageImageReference[] | undefined,
  right: readonly MessageImageReference[],
): readonly MessageImageReference[] {
  if (left === undefined || left.length === 0) return right
  if (right.length === 0) return left
  const result = [...left]
  const seen = new Set(result.map((image) => image.attachmentId))
  for (const image of right) {
    if (seen.has(image.attachmentId)) continue
    seen.add(image.attachmentId)
    result.push(image)
    if (result.length >= 32) break
  }
  return result
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
