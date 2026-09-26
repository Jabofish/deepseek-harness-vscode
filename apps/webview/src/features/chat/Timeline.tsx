import {
  Fragment,
  memo,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from 'react'
import {
  isInjectedUserMessage,
  type AssistantTiming,
  type TimelineNode,
  type TurnTokenUsage,
} from '@dsh-vscode/timeline'
import type {
  FeedbackCategory,
  MessageFeedbackItem,
  MessageFeedbackRating,
  MessageImageReference,
  TokenUsage,
} from '@dsh-vscode/domain'
import { MarkdownContent } from './MarkdownContent.js'
import { MessageImages } from './MessageImages.js'
import { MessageActions } from './MessageActions.js'
import { containsUserTextReferences, projectUserText } from './UserText.js'
import { ReasoningDisclosure } from './ReasoningDisclosure.js'
import { ToolCallCollection, type ToolTimelineNode } from './ToolCallCollection.js'
import { WorkflowRunCard } from '../workflows/WorkflowDrawer.js'
import {
  ContentFlow,
  DEFAULT_VIRTUALIZATION_PAYLOAD_THRESHOLD,
  DEFAULT_VIRTUALIZATION_THRESHOLD,
  ScrollToLatestButton,
  useVirtualizedCollection,
  useScrollFollow,
  useTailEntrance,
  type ScrollAnchor,
} from '../../components/common/index.js'
import { Icon } from '../../ui/Icon.js'
import { useI18n, type Translate } from '../../i18n.js'
import type { PerformanceUsageMode, TranscriptViewMode } from '../../app/ui-preferences.js'

type FeedbackSubmit = (
  messageId: string,
  rating: MessageFeedbackRating,
  note: string | undefined,
  category: FeedbackCategory | undefined,
) => Promise<void> | void

type FeedbackPrepare = (
  messageId: string,
) => Promise<MessageFeedbackItem | undefined> | MessageFeedbackItem | undefined

type DshEventNode = Extract<TimelineNode, { readonly kind: 'event' }>

interface DshEventGroupNode {
  readonly kind: 'event-group'
  readonly id: string
  readonly events: readonly DshEventNode[]
  readonly textSize: number
}

interface ReasoningBlock {
  readonly kind: 'reasoning'
  readonly id: string
  readonly markdown: string
  readonly streaming: boolean
}

interface MessageBlock {
  readonly kind: 'message'
  readonly id: string
  readonly markdown: string
  readonly streaming: boolean
  readonly images?: readonly MessageImageReference[]
}

interface ToolBlock {
  readonly kind: 'tool'
  readonly node: ToolTimelineNode
}

type AssistantContentBlock = ReasoningBlock | MessageBlock | ToolBlock

interface UserTextFacts {
  readonly sessionReferenceLabels: readonly string[]
}

interface AssistantTurnNode {
  readonly kind: 'assistant-turn'
  readonly id: string
  readonly modelLabel?: string
  readonly usage?: TokenUsage
  readonly turnUsage?: TurnTokenUsage | undefined
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
  /** Ordered content blocks keep tools inside the answer they belong to. */
  readonly blocks: readonly AssistantContentBlock[]
}

type DisplayTimelineNode =
  | Exclude<TimelineNode, DshEventNode | ToolTimelineNode>
  | ToolTimelineNode
  | DshEventGroupNode
  | AssistantTurnNode

type ExpandedDetailsSetter = (
  next: ReadonlySet<string> | ((current: ReadonlySet<string>) => ReadonlySet<string>),
) => void

export interface TimelineProps {
  readonly sessionId: string
  readonly nodes: readonly TimelineNode[]
  /** Optional tabpanel semantics supplied when the timeline is tabbed. */
  readonly panelId?: string
  readonly panelLabelledBy?: string
  /** Reducer-provided first changed raw node; absent callers use identity scan. */
  readonly nodeChangeStart?: number
  /** Guards the reducer hint when React skips an intermediate snapshot. */
  readonly nodeChangeBase?: readonly TimelineNode[]
  readonly streaming: boolean
  /** Conversation chrome owns this preference when the Timeline is embedded in App. */
  readonly showDshEvents?: boolean
  readonly transcriptView?: TranscriptViewMode
  readonly performanceUsage?: PerformanceUsageMode
  readonly codingToolsEnabled?: boolean
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
  readonly onFeedbackSubmit?: FeedbackSubmit
  readonly onFeedbackPrepare?: FeedbackPrepare
  /** Whether an older DSH history window is available. */
  readonly hasMoreHistory?: boolean
  readonly loadingOlderHistory?: boolean
  readonly onLoadOlderHistory?: () => Promise<void> | void
}

/** Keep row handlers stable while still dispatching to the latest parent callback. */
function useStableOptionalCallback<Args extends unknown[], Result>(
  callback: ((...args: Args) => Result) | undefined,
): (...args: Args) => Result {
  const callbackRef = useRef(callback)
  useLayoutEffect(() => {
    callbackRef.current = callback
  }, [callback])
  return useCallback((...args: Args): Result => {
    const current = callbackRef.current
    return current === undefined ? (undefined as Result) : current(...args)
  }, [])
}

function handleTimelineScrollKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
  const timeline = event.currentTarget
  if (event.defaultPrevented || event.target !== timeline || event.altKey || event.ctrlKey || event.metaKey)
    return

  const maxScrollTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight)
  const pageSize = Math.max(1, timeline.clientHeight)
  const parsedLineHeight = Number.parseFloat(window.getComputedStyle(timeline).lineHeight)
  const lineSize = Number.isFinite(parsedLineHeight) && parsedLineHeight > 0 ? parsedLineHeight : 40
  const currentScrollTop = timeline.scrollTop
  let nextScrollTop: number

  switch (event.key) {
    case 'ArrowDown':
      nextScrollTop = currentScrollTop + lineSize
      break
    case 'ArrowUp':
      nextScrollTop = currentScrollTop - lineSize
      break
    case 'PageDown':
      nextScrollTop = currentScrollTop + pageSize
      break
    case 'PageUp':
      nextScrollTop = currentScrollTop - pageSize
      break
    case ' ':
      nextScrollTop = currentScrollTop + (event.shiftKey ? -pageSize : pageSize)
      break
    case 'Home':
      nextScrollTop = 0
      break
    case 'End':
      nextScrollTop = maxScrollTop
      break
    default:
      return
  }

  event.preventDefault()
  timeline.scrollTop = Math.min(maxScrollTop, Math.max(0, nextScrollTop))
}

export const Timeline = memo(function Timeline(props: TimelineProps): ReactElement {
  const { t } = useI18n()
  const prependAnchorRef = useRef<ScrollAnchor | undefined>(undefined)
  const olderHistoryRequestRef = useRef<{ readonly sessionId: string } | undefined>(undefined)
  useLayoutEffect(() => {
    prependAnchorRef.current = undefined
    olderHistoryRequestRef.current = undefined
  }, [props.sessionId])
  const [expandedDetails, setExpandedDetails] = useState<ReadonlySet<string>>(new Set())
  const showDshEvents = props.showDshEvents ?? false
  const transcriptView = props.transcriptView ?? 'standard'
  const performanceUsage = props.performanceUsage ?? 'detailed'
  const codingToolsEnabled = props.codingToolsEnabled ?? true
  // The reducer keeps authoritative assistant step ids so separate visible
  // answers cannot be fused. Thinking-only steps are different: the official
  // conversation surface presents one collapsed thinking block for a
  // continuous run, then attaches it to the following visible answer.
  const displayProjector = useMemo(() => createDisplayNodeProjector(), [])
  const nodeSignatureProjector = useMemo(() => createNodeSignatureProjector(), [])
  const displayProjection = useMemo(
    () =>
      displayProjector(
        props.nodes,
        showDshEvents,
        transcriptView,
        props.nodeChangeStart,
        props.nodeChangeBase,
      ),
    [
      displayProjector,
      props.nodeChangeBase,
      props.nodeChangeStart,
      props.nodes,
      showDshEvents,
      transcriptView,
    ],
  )
  const displayNodes = displayProjection.nodes
  const running = props.running ?? props.streaming
  const hasMoreHistory = props.hasMoreHistory
  const loadingOlderHistory = props.loadingOlderHistory
  const onLoadOlderHistory = props.onLoadOlderHistory
  const displayNodeTextSizeProjector = useMemo(() => createDisplayNodeTextSizeProjector(), [])
  const timelineFactsProjector = useMemo(() => createTimelineFactsProjector(), [])
  const timelineFacts = useMemo(
    () => timelineFactsProjector(props.nodes, props.nodeChangeStart, props.nodeChangeBase),
    [timelineFactsProjector, props.nodeChangeBase, props.nodeChangeStart, props.nodes],
  )
  const userTextFacts = useMemo(() => collectUserTextFacts(props.nodes), [props.nodes])
  const virtualizationProjector = useMemo(() => createVirtualizationProjector(), [])

  const usingTool = timelineFacts.hasActiveTool
  const hasOpenLink = props.onOpenLink !== undefined
  const stableOnOpenLink = useStableOptionalCallback(props.onOpenLink)
  const stableOnLoadImage = useStableOptionalCallback(props.onLoadImage)
  const stableOnShowInFolder = useStableOptionalCallback(props.onShowInFolder)
  const stableOnOpenSession = useStableOptionalCallback(props.onOpenSession)
  const stableOnBranch = useStableOptionalCallback(props.onBranch)
  const stableOnFeedback = useStableOptionalCallback(props.onFeedback)
  const stableOnFeedbackSubmit = useStableOptionalCallback(props.onFeedbackSubmit)
  const stableOnFeedbackPrepare = useStableOptionalCallback(props.onFeedbackPrepare)
  const [openLinkError, setOpenLinkError] = useState<{ readonly href: string; readonly message: string }>()
  const [openLinkBusy, setOpenLinkBusy] = useState(false)
  const requestOpenLink = useCallback(
    (href: string): void => {
      if (!hasOpenLink) return
      const normalized = href.trim()
      if (normalized === '') return
      setOpenLinkError(undefined)
      setOpenLinkBusy(true)
      let operation: void | Promise<void>
      try {
        operation = stableOnOpenLink(normalized)
      } catch (reason: unknown) {
        setOpenLinkError({
          href: normalized,
          message: reason instanceof Error ? reason.message : t('app.error.openLink'),
        })
        setOpenLinkBusy(false)
        return
      }
      void Promise.resolve(operation)
        .catch((reason: unknown) => {
          setOpenLinkError({
            href: normalized,
            message: reason instanceof Error ? reason.message : t('app.error.openLink'),
          })
        })
        .finally(() => setOpenLinkBusy(false))
    },
    [hasOpenLink, stableOnOpenLink, t],
  )
  /**
   * The refusal dialog is `aria-modal`, so the keyboard has to come back to
   * whichever control asked for the open. The opener is recorded from the click
   * itself rather than from `document.activeElement`, because a link inside a
   * markdown/`code` fragment can be a nested node and Safari does not focus a
   * button on click. Controls inside the dialog are skipped so a retry keeps
   * pointing at the original link.
   *
   * The restore is a layout effect: it has to close in the same commit that
   * removes the dialog, or the keyboard sits on `body` for a task and a key
   * pressed in that window goes nowhere.
   */
  const openLinkTriggerRef = useRef<HTMLElement | null>(null)
  const openLinkWasOpen = useRef(false)
  useLayoutEffect(() => {
    if (openLinkWasOpen.current && openLinkError === undefined) {
      const target = openLinkTriggerRef.current
      // Retry remounts the dialog, so the opener is deliberately kept for the
      // close that follows it; the connection guard covers a recycled row.
      if (target !== null && target.isConnected) target.focus()
    }
    openLinkWasOpen.current = openLinkError !== undefined
  }, [openLinkError])
  const rememberOpenLinkTrigger = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!(target instanceof Element) || target.closest('[role="dialog"]') !== null) return
    const control = target.closest<HTMLElement>('button, [href], [tabindex]')
    if (control !== null) openLinkTriggerRef.current = control
  }
  const latestNode = displayNodes[displayNodes.length - 1]
  const latestSignature = nodeSignatureProjector(latestNode)
  const virtualizeTimeline = virtualizationProjector(displayNodes, displayNodeTextSizeProjector)
  const {
    scrollRef,
    contentRef,
    userScrollToLatest,
    scheduleScrollToLatest,
    captureScrollAnchor,
    restoreScrollAnchor,
    applyScrollAdjustment,
    isUserScrollActive,
    isPinnedToBottom,
    showJumpToLatest,
  } = useScrollFollow({
    contentKey: latestSignature,
    itemCount: displayNodes.length,
    sessionId: props.sessionId,
    observeContentSize: !virtualizeTimeline,
  })
  const getFocusedTimelineIndex = useCallback((): number | undefined => {
    const timeline = scrollRef.current
    if (timeline === null) return undefined
    const activeElement = timeline.ownerDocument.activeElement
    if (activeElement === null || !timeline.contains(activeElement)) return undefined
    const row = activeElement.closest<HTMLElement>('.dsh-timeline__row[data-index][data-node-id]')
    if (row === null) return undefined
    const nodeId = row.dataset.nodeId
    if (nodeId === undefined) return undefined
    const currentIndex = Number(row.dataset.index)
    if (!Number.isInteger(currentIndex)) return undefined
    if (displayNodes[currentIndex]?.id === nodeId) return currentIndex
    const shiftedIndex = displayNodes.findIndex((node) => node.id === nodeId)
    return shiftedIndex >= 0 ? shiftedIndex : undefined
  }, [displayNodes, scrollRef])
  const virtualized = useVirtualizedCollection({
    items: displayNodes,
    scrollRef,
    enabled: virtualizeTimeline,
    getItemKey: timelineNodeKey,
    getPinnedItemIndex: getFocusedTimelineIndex,
    onScrollAdjustment: applyScrollAdjustment,
  })
  const virtualizedReady = virtualized.enabled && virtualized.ready
  const enteredId = useTailEntrance(latestNode?.id, props.sessionId, props.streaming || running)
  useLayoutEffect(() => {
    if (!virtualizedReady || virtualized.totalSize <= 0) return
    // Virtual rows refine the canvas height as they enter the measurement
    // cache. Reconcile that estimate only through the shared scroll owner;
    // native reader input cancels it before it can move the viewport.
    scheduleScrollToLatest({ preserveBottom: true, immediate: true })
  }, [scheduleScrollToLatest, virtualizedReady, virtualized.totalSize])
  const loadOlderHistory = useCallback((): void => {
    if (
      hasMoreHistory !== true ||
      loadingOlderHistory === true ||
      onLoadOlderHistory === undefined ||
      olderHistoryRequestRef.current?.sessionId === props.sessionId
    )
      return
    prependAnchorRef.current = captureScrollAnchor()
    if (prependAnchorRef.current === undefined) return
    const request = { sessionId: props.sessionId }
    olderHistoryRequestRef.current = request
    const result = onLoadOlderHistory()
    if (result === undefined) {
      if (olderHistoryRequestRef.current === request) olderHistoryRequestRef.current = undefined
      return
    }
    void result.finally(() => {
      if (olderHistoryRequestRef.current === request) olderHistoryRequestRef.current = undefined
    })
  }, [captureScrollAnchor, hasMoreHistory, loadingOlderHistory, onLoadOlderHistory, props.sessionId])
  const handleScroll = useCallback((): void => {
    const element = scrollRef.current
    if (element !== null && element.scrollTop <= 24 && isUserScrollActive()) loadOlderHistory()
  }, [isUserScrollActive, loadOlderHistory, scrollRef])

  const hasLoadImage = props.onLoadImage !== undefined
  const hasShowInFolder = props.onShowInFolder !== undefined
  const hasOpenSession = props.onOpenSession !== undefined
  const hasBranch = props.onBranch !== undefined
  const hasFeedback = props.onFeedback !== undefined || props.onFeedbackSubmit !== undefined
  const nodeRenderContext = useMemo<TimelineNodeRenderContext>(
    () => ({
      expandedDetails,
      setExpandedDetails,
      assistantLabel: props.assistantLabel,
      onOpenLink: hasOpenLink ? requestOpenLink : undefined,
      onLoadImage: hasLoadImage ? stableOnLoadImage : undefined,
      onShowInFolder: hasShowInFolder ? stableOnShowInFolder : undefined,
      onOpenSession: hasOpenSession ? stableOnOpenSession : undefined,
      userTextFacts,
      onBranch: hasBranch ? stableOnBranch : undefined,
      branching: props.branching === true,
      running,
      feedback: props.feedback,
      feedbackUnavailable: props.feedbackUnavailable,
      transcriptView,
      performanceUsage,
      onFeedback: hasFeedback ? stableOnFeedback : undefined,
      onFeedbackSubmit: props.onFeedbackSubmit === undefined ? undefined : stableOnFeedbackSubmit,
      onFeedbackPrepare: props.onFeedbackPrepare === undefined ? undefined : stableOnFeedbackPrepare,
      requestOpenLink,
      t,
    }),
    [
      expandedDetails,
      hasBranch,
      hasFeedback,
      hasLoadImage,
      hasOpenLink,
      hasOpenSession,
      hasShowInFolder,
      props.assistantLabel,
      props.branching,
      props.feedback,
      props.feedbackUnavailable,
      performanceUsage,
      props.onFeedbackSubmit,
      props.onFeedbackPrepare,
      requestOpenLink,
      running,
      stableOnBranch,
      stableOnFeedback,
      stableOnFeedbackSubmit,
      stableOnFeedbackPrepare,
      stableOnLoadImage,
      stableOnOpenSession,
      stableOnShowInFolder,
      transcriptView,
      t,
      userTextFacts,
    ],
  )

  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current
    const element = scrollRef.current
    if (anchor === undefined || element === null || props.loadingOlderHistory === true) return
    const restore = (): void => {
      const current = prependAnchorRef.current
      if (current === undefined) return
      restoreScrollAnchor(current)
      prependAnchorRef.current = undefined
    }
    restore()
  }, [props.loadingOlderHistory, props.nodes.length, restoreScrollAnchor, scrollRef])

  return (
    <div
      id={props.panelId}
      role={props.panelId === undefined ? undefined : 'tabpanel'}
      aria-labelledby={props.panelLabelledBy}
      tabIndex={props.panelId === undefined ? undefined : 0}
      className="dsh-timeline-shell"
      onClickCapture={rememberOpenLinkTrigger}
    >
      <div
        ref={scrollRef}
        className="dsh-timeline"
        data-scroll-follow={isPinnedToBottom ? 'pinned' : 'free'}
        data-transcript-view={transcriptView}
        data-performance-usage={performanceUsage}
        data-coding-tools-enabled={codingToolsEnabled}
        role="region"
        aria-label={t('timeline.aria')}
        tabIndex={0}
        onKeyDown={handleTimelineScrollKeyDown}
        onScroll={handleScroll}
      >
        {props.hasMoreHistory && props.onLoadOlderHistory !== undefined ? (
          <div className="dsh-timeline__history-more">
            <button
              type="button"
              className="dsh-timeline__history-more-button"
              disabled={props.loadingOlderHistory === true}
              onClick={loadOlderHistory}
            >
              {props.loadingOlderHistory === true ? (
                <>
                  <span className="dsh-skeleton dsh-timeline__history-more-skeleton" aria-hidden="true" />
                  <span>{t('timeline.loadingOlder')}</span>
                </>
              ) : (
                t('timeline.loadOlder')
              )}
            </button>
          </div>
        ) : null}
        {displayNodes.length === 0 ? (
          <div className="dsh-timeline__empty" role="status">
            <span className="dsh-timeline__empty-icon" aria-hidden="true">
              <Icon name="sparkles" />
            </span>
            <strong>{t('timeline.emptyTitle')}</strong>
            <span>{t('timeline.emptyHint')}</span>
          </div>
        ) : null}
        <div
          key={props.sessionId}
          ref={contentRef}
          className="dsh-timeline__content dsh-timeline__content--session-enter"
        >
          <div
            className={`dsh-timeline__canvas${virtualized.enabled ? ' dsh-timeline__canvas--virtualized' : ''}${virtualizedReady ? ' dsh-timeline__canvas--virtualized-ready' : ''}`}
            style={virtualizedReady ? { height: `${virtualized.totalSize}px` } : undefined}
          >
            {virtualizedReady
              ? virtualized.virtualItems.map((item) => {
                  const node = displayNodes[item.index]
                  if (node === undefined) return null
                  return (
                    <div
                      key={item.key}
                      ref={virtualized.measureElement}
                      data-index={item.index}
                      data-node-id={node.id}
                      className={`dsh-timeline__row${node.id === enteredId ? ' dsh-timeline__row--enter' : ''}`}
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      <TimelineRow node={node} context={nodeRenderContext} />
                    </div>
                  )
                })
              : displayNodes.map((node, index) => (
                  <div
                    key={node.id}
                    data-index={index}
                    data-node-id={node.id}
                    className={`dsh-timeline__row${node.id === enteredId ? ' dsh-timeline__row--enter' : ''}`}
                  >
                    <TimelineRow node={node} context={nodeRenderContext} />
                  </div>
                ))}
          </div>
          {running ? (
            <StreamingActivity
              id={`turn:${props.activeTurn ?? latestNode?.id ?? props.sessionId}`}
              usingTool={usingTool}
              translate={t}
            />
          ) : null}
        </div>
        {props.streaming ? (
          <span className="dsh-sr-only" aria-live="polite">
            {t('timeline.streaming')}
          </span>
        ) : null}
      </div>
      {showJumpToLatest ? (
        <ScrollToLatestButton label={t('timeline.jump')} onClick={userScrollToLatest} />
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
})

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
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  useLayoutEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useLayoutEffect(() => {
    // The modal owns the keyboard while it is up, but only takes it back when
    // the keyboard is not already inside: re-running this on every render
    // would drag focus off whichever control the user had reached while the
    // timeline kept streaming. A mount that starts busy (a retry still in
    // flight) takes focus as soon as its controls are enabled.
    const dialog = dialogRef.current
    const active = document.activeElement
    if (dialog !== null && active !== null && dialog.contains(active)) return
    closeRef.current?.focus()
  }, [busy])

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // The dialog is aria-modal: the keyboard dismisses it, and the refocus
      // effect above returns the keyboard to the control that asked for the
      // open. A key an inner surface already consumed is not ours. Registered
      // at layout time so the modal answers the key from its first paint.
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      className="dsh-tool-error-modal__backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        ref={dialogRef}
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
  userTextFacts: ReadonlyMap<string, UserTextFacts>,
  expanded: ReadonlySet<string>,
  setExpanded: ExpandedDetailsSetter,
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
  onFeedbackSubmit?: FeedbackSubmit,
  onFeedbackPrepare?: FeedbackPrepare,
  t: Translate = (key) => key,
  feedbackUnavailable = false,
  transcriptView: TranscriptViewMode = 'standard',
  performanceUsage: PerformanceUsageMode = 'detailed',
): ReactElement {
  switch (node.kind) {
    case 'tool':
      return (
        <ToolCallCollection
          tools={[node]}
          expanded={expanded}
          onExpandedChange={setExpanded}
          translate={t}
          {...(onOpenLink === undefined ? {} : { onOpenLink })}
          {...(onLoadImage === undefined ? {} : { onLoadImage })}
        />
      )
    case 'deliverables':
      return (
        <section
          className="dsh-timeline__card dsh-timeline__card--event"
          aria-label={t('timeline.deliverables')}
        >
          <header className="dsh-timeline__card-header">
            <div className="dsh-timeline__card-heading">
              <span className="dsh-message-avatar dsh-message-avatar--system" aria-hidden="true">
                <Icon name="file" />
              </span>
              <strong>{t('timeline.deliverables')}</strong>
            </div>
            <span className="dsh-timeline__card-meta">
              {t('timeline.items', { count: node.files.length })}
            </span>
          </header>
          <ul
            className="dsh-timeline__event-list dsh-timeline__presented-files"
            data-presented-files-row="true"
          >
            {node.files.map((file, index) => {
              const label = producedFileLabel(file.path)
              return (
                <li className="dsh-timeline__presented-file" key={`${file.path}:${index}`}>
                  <div className="dsh-timeline__presented-file-main" title={file.path}>
                    <Icon name="file" />
                    <ContentFlow as="span" variant="truncate">
                      {label}
                    </ContentFlow>
                  </div>
                  {file.description === undefined || file.description.trim() === '' ? null : (
                    <span className="dsh-timeline__presented-file-description">{file.description}</span>
                  )}
                  <div className="dsh-timeline__presented-file-actions">
                    {onOpenLink === undefined ? null : (
                      <button
                        className="dsh-button dsh-button--secondary dsh-button--compact"
                        type="button"
                        aria-label={t('timeline.openPresented', { name: label })}
                        onClick={() => onOpenLink(file.path)}
                      >
                        {t('timeline.openProduced', { name: label })}
                      </button>
                    )}
                    {onShowInFolder === undefined ? null : (
                      <button
                        className="dsh-button dsh-button--secondary dsh-button--compact"
                        type="button"
                        aria-label={t('timeline.revealPresented', { name: label })}
                        onClick={() => onShowInFolder(file.path)}
                      >
                        {t('timeline.showInFolder')}
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )
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
        onFeedbackSubmit,
        onFeedbackPrepare,
        feedbackUnavailable,
        transcriptView,
        performanceUsage,
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
          <span className="dsh-timeline__turn-terminal-message">
            <span>{turnTerminalLabel(node.reason, t)}</span>
            {node.failure === undefined ? null : (
              <span className="dsh-timeline__turn-terminal-detail">
                {node.failure.code === undefined ? null : <code>{node.failure.code}</code>}
                <span>{node.failure.message}</span>
              </span>
            )}
          </span>
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
    case 'user-message': {
      const facts = userTextFacts.get(node.id)
      const sessionReferenceLabels = facts?.sessionReferenceLabels ?? []
      const projected = containsUserTextReferences(node.markdown, sessionReferenceLabels)
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
            {node.markdown.trim() === '' ? null : projected ? (
              <div className="dsh-timeline__user-text">
                {projectUserText(
                  node.markdown,
                  sessionReferenceLabels,
                  onOpenLink === undefined ? undefined : { openFile: onOpenLink },
                )}
              </div>
            ) : (
              <MarkdownContent markdown={node.markdown} onOpenLink={onOpenLink} />
            )}
            {sessionReferenceLabels.length === 0 ? null : (
              <div className="dsh-timeline__reference-summary" data-reference-summary="session">
                {t('timeline.referenceSummary', { labels: sessionReferenceLabels.join(', ') })}
              </div>
            )}
          </article>
          {node.markdown.trim() === '' ? null : <MessageActions text={node.markdown} translate={t} />}
        </div>
      )
    }
    case 'assistant-message':
      return renderAssistantMessage(
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
        onFeedbackSubmit,
        onFeedbackPrepare,
        feedbackUnavailable,
        transcriptView,
        performanceUsage,
      )
    case 'reasoning':
      if (transcriptView === 'compact') return <></>
      return renderAssistantTurn(
        {
          kind: 'assistant-turn',
          id: `assistant-turn:${node.id}`,
          tools: [],
          markdown: '',
          streaming: node.streaming,
          reasoning: node,
          blocks: [
            {
              kind: 'reasoning',
              id: node.id,
              markdown: node.markdown,
              streaming: node.streaming,
            },
          ],
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
        undefined,
        feedbackUnavailable,
        transcriptView,
        performanceUsage,
      )
  }
}

interface TimelineNodeRenderContext {
  readonly expandedDetails: ReadonlySet<string>
  readonly setExpandedDetails: ExpandedDetailsSetter
  readonly assistantLabel: string | undefined
  readonly onOpenLink: ((href: string) => void) | undefined
  readonly onLoadImage: ((image: MessageImageReference) => Promise<string | undefined>) | undefined
  readonly onShowInFolder: ((href: string) => void) | undefined
  readonly onOpenSession: ((sessionId: string) => void) | undefined
  readonly userTextFacts: ReadonlyMap<string, UserTextFacts>
  readonly onBranch: ((atSeq: number) => void) | undefined
  readonly branching: boolean
  readonly requestOpenLink: (href: string) => void
  readonly running: boolean
  readonly feedback: Readonly<Record<string, MessageFeedbackItem>> | undefined
  readonly feedbackUnavailable: boolean | undefined
  readonly transcriptView: TranscriptViewMode
  readonly performanceUsage: PerformanceUsageMode
  readonly onFeedback: ((messageId: string, rating: MessageFeedbackRating) => void) | undefined
  readonly onFeedbackSubmit: FeedbackSubmit | undefined
  readonly onFeedbackPrepare: FeedbackPrepare | undefined
  readonly t: Translate
}

function renderTimelineNode(node: DisplayTimelineNode, context: TimelineNodeRenderContext): ReactElement {
  return renderNode(
    node,
    context.userTextFacts,
    context.expandedDetails,
    context.setExpandedDetails,
    context.assistantLabel,
    context.onOpenLink === undefined ? undefined : context.requestOpenLink,
    context.onLoadImage,
    context.onShowInFolder,
    context.onOpenSession,
    context.onBranch,
    branchUnavailableForNode(node, context.branching),
    context.running,
    context.feedback,
    context.onFeedback,
    context.onFeedbackSubmit,
    context.onFeedbackPrepare,
    context.t,
    context.feedbackUnavailable,
    context.transcriptView,
    context.performanceUsage,
  )
}

const TimelineRow = memo(
  function TimelineRow(props: {
    readonly node: DisplayTimelineNode
    readonly context: TimelineNodeRenderContext
  }): ReactElement {
    return renderTimelineNode(props.node, props.context)
  },
  (previous, next) =>
    previous.node === next.node && timelineRowContextEqual(previous.node, previous.context, next.context),
)

function timelineRowContextEqual(
  node: DisplayTimelineNode,
  previous: TimelineNodeRenderContext,
  next: TimelineNodeRenderContext,
): boolean {
  if (previous === next) return true
  if (
    previous.assistantLabel !== next.assistantLabel ||
    previous.setExpandedDetails !== next.setExpandedDetails ||
    previous.onOpenLink !== next.onOpenLink ||
    previous.requestOpenLink !== next.requestOpenLink ||
    previous.onLoadImage !== next.onLoadImage ||
    previous.onShowInFolder !== next.onShowInFolder ||
    previous.onOpenSession !== next.onOpenSession ||
    previous.userTextFacts !== next.userTextFacts ||
    previous.onBranch !== next.onBranch ||
    previous.branching !== next.branching ||
    previous.running !== next.running ||
    previous.onFeedback !== next.onFeedback ||
    previous.onFeedbackSubmit !== next.onFeedbackSubmit ||
    previous.onFeedbackPrepare !== next.onFeedbackPrepare ||
    previous.feedbackUnavailable !== next.feedbackUnavailable ||
    previous.transcriptView !== next.transcriptView ||
    previous.performanceUsage !== next.performanceUsage ||
    previous.t !== next.t
  )
    return false

  if (!expandedDetailsEqualForNode(node, previous.expandedDetails, next.expandedDetails)) return false
  return feedbackEqualForNode(node, previous.feedback, next.feedback)
}

function expandedDetailsEqualForNode(
  node: DisplayTimelineNode,
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>,
): boolean {
  if (previous === next) return true
  const check = (key: string): boolean => previous.has(key) === next.has(key)
  switch (node.kind) {
    case 'tool':
      return check(node.id)
    case 'assistant-message':
      return node.reasoning === undefined || check(`reasoning:${node.id}`)
    case 'reasoning':
      return check(`reasoning:assistant-turn:${node.id}:${node.id}`)
    case 'assistant-turn': {
      const blocks = node.blocks.length === 0 ? assistantBlocksFromAggregates(node) : node.blocks
      for (const block of blocks) {
        const key = block.kind === 'tool' ? block.node.id : `reasoning:${node.id}:${block.id}`
        if (!check(key)) return false
      }
      return true
    }
    default:
      return true
  }
}

function feedbackEqualForNode(
  node: DisplayTimelineNode,
  previous: Readonly<Record<string, MessageFeedbackItem>> | undefined,
  next: Readonly<Record<string, MessageFeedbackItem>> | undefined,
): boolean {
  if (previous === next) return true
  const messageId =
    node.kind === 'assistant-message'
      ? node.id
      : node.kind === 'assistant-turn'
        ? assistantMessageId(node)
        : undefined
  return messageId === undefined ? true : previous?.[messageId] === next?.[messageId]
}

interface VirtualizationCache {
  readonly sourceNodes: readonly DisplayTimelineNode[]
  readonly firstLargeNodeIndex: number
}

function createVirtualizationProjector(): (
  nodes: readonly DisplayTimelineNode[],
  textSize?: (node: DisplayTimelineNode) => number,
) => boolean {
  let previous: VirtualizationCache | undefined
  return (nodes, textSize = displayNodeTextSize) => {
    const previousCache = previous
    if (previousCache?.sourceNodes === nodes) {
      return nodes.length >= DEFAULT_VIRTUALIZATION_THRESHOLD || previousCache.firstLargeNodeIndex >= 0
    }

    const commonPrefix =
      previousCache === undefined ? 0 : commonDisplayNodePrefixLength(previousCache.sourceNodes, nodes)
    let firstLargeNodeIndex =
      previousCache !== undefined &&
      previousCache.firstLargeNodeIndex >= 0 &&
      previousCache.firstLargeNodeIndex < commonPrefix
        ? previousCache.firstLargeNodeIndex
        : -1

    for (let index = commonPrefix; index < nodes.length; index += 1) {
      const node = nodes[index]
      if (node !== undefined && textSize(node) >= DEFAULT_VIRTUALIZATION_PAYLOAD_THRESHOLD) {
        firstLargeNodeIndex = firstLargeNodeIndex < 0 ? index : Math.min(firstLargeNodeIndex, index)
        break
      }
    }

    previous = { sourceNodes: nodes, firstLargeNodeIndex }
    return nodes.length >= DEFAULT_VIRTUALIZATION_THRESHOLD || firstLargeNodeIndex >= 0
  }
}

function commonDisplayNodePrefixLength(
  previous: readonly DisplayTimelineNode[],
  next: readonly DisplayTimelineNode[],
): number {
  const length = Math.min(previous.length, next.length)
  let index = 0
  while (index < length && previous[index] === next[index]) index += 1
  return index
}

function timelineNodeKey(node: DisplayTimelineNode): string {
  return node.id
}

interface TimelineFacts {
  readonly hasActiveTool: boolean
}

interface TimelineFactsCache extends TimelineFacts {
  readonly sourceNodes: readonly TimelineNode[]
  readonly firstActiveToolIndex: number
}

function createTimelineFactsProjector(): (
  nodes: readonly TimelineNode[],
  nodeChangeStart?: number,
  nodeChangeBase?: readonly TimelineNode[],
) => TimelineFacts {
  let previous: TimelineFactsCache | undefined
  return (nodes, nodeChangeStart, nodeChangeBase) => {
    const previousCache = previous
    if (previousCache?.sourceNodes === nodes) return previousCache

    const commonPrefix =
      previousCache === undefined
        ? 0
        : nodeChangeStart === undefined || nodeChangeBase !== previousCache.sourceNodes
          ? commonNodePrefixLength(previousCache.sourceNodes, nodes)
          : Math.max(0, Math.min(nodeChangeStart, previousCache.sourceNodes.length, nodes.length))
    const stableActiveTool =
      previousCache !== undefined &&
      previousCache.firstActiveToolIndex >= 0 &&
      previousCache.firstActiveToolIndex < commonPrefix
    let firstActiveToolIndex = stableActiveTool ? (previousCache?.firstActiveToolIndex ?? -1) : -1

    for (let index = commonPrefix; index < nodes.length; index += 1) {
      const node = nodes[index]
      if (
        firstActiveToolIndex < 0 &&
        node?.kind === 'tool' &&
        (node.tool.status === 'queued' || node.tool.status === 'running')
      )
        firstActiveToolIndex = index
      if (firstActiveToolIndex >= 0) break
    }

    previous = {
      sourceNodes: nodes,
      firstActiveToolIndex,
      hasActiveTool: firstActiveToolIndex >= 0,
    }
    return previous
  }
}

function displayNodeTextSize(node: DisplayTimelineNode): number {
  switch (node.kind) {
    case 'assistant-turn':
      return (
        node.markdown.length +
        (node.reasoning?.markdown.length ?? 0) +
        node.blocks.reduce((total, block) => total + (block.kind === 'tool' ? 0 : block.markdown.length), 0)
      )
    case 'assistant-message':
    case 'reasoning':
    case 'user-message':
      return node.markdown.length
    case 'compaction':
      return node.compaction.summary?.length ?? 0
    case 'event-group':
      return node.textSize
    default:
      return 0
  }
}

function createDisplayNodeTextSizeProjector(): (node: DisplayTimelineNode) => number {
  const cache = new WeakMap<object, number>()
  return (node) => {
    const cached = cache.get(node)
    if (cached !== undefined) return cached
    const size = displayNodeTextSize(node)
    cache.set(node, size)
    return size
  }
}

function renderTeamActivity(
  activity: Extract<TimelineNode, { readonly kind: 'team' }>['activity'],
  t: Translate = (key) => key,
): ReactElement {
  const body =
    activity.kind === 'message.queued' || activity.kind === 'message.delivered' ? activity.content : undefined
  const title =
    activity.kind === 'member'
      ? activity.name
      : activity.kind === 'task'
        ? activity.subject
        : activity.messageId
  // The phase, task status and delivery values are wire identifiers; the pill
  // carries the reader-facing label and the delivery mode stays a meta detail
  // instead of replacing the message state.
  const statusKey =
    activity.kind === 'member'
      ? `timeline.teamStatus.${activity.phase}`
      : activity.kind === 'task'
        ? `timeline.teamStatus.${activity.status}`
        : activity.kind === 'message.queued'
          ? 'timeline.teamStatus.queued'
          : 'timeline.teamStatus.delivered'
  return (
    <section className="dsh-timeline__card dsh-timeline__card--event" aria-label={t('timeline.teamActivity')}>
      <header className="dsh-timeline__card-header">
        <div className="dsh-timeline__card-heading">
          <span className="dsh-message-avatar dsh-message-avatar--system" aria-hidden="true">
            <Icon name="users" />
          </span>
          <strong>{t('timeline.teamActivity')}</strong>
        </div>
        <span className="dsh-status-pill dsh-status-pill--info">{t(statusKey)}</span>
      </header>
      <ul className="dsh-timeline__event-list">
        <li>
          {body === undefined ? (
            <span className="dsh-timeline__event-title">{title}</span>
          ) : (
            // A peer message is prose, not a label: the host admits a body far
            // past one line (`maxMessageBytes`), so the row wraps it the way a
            // prompt row does instead of ending it in an ellipsis. A receipt
            // with no known body keeps the id fallback above.
            <span className="dsh-timeline__event-body">{body}</span>
          )}
          {activity.kind === 'task' && activity.blockedByCount > 0 ? (
            <span className="dsh-timeline__card-meta">
              {t('timeline.teamBlockedBy', { count: activity.blockedByCount })}
            </span>
          ) : null}
          {activity.kind === 'member' && activity.error !== undefined ? (
            // The roster stores the failure reason verbatim, so it is often a
            // multi-line diagnostic rather than a one-line label.
            <span className="dsh-timeline__event-error">{activity.error}</span>
          ) : null}
          {'senderName' in activity && activity.senderName !== undefined ? (
            <span className="dsh-timeline__card-meta">
              {t('timeline.teamSender', { sender: activity.senderName })}
            </span>
          ) : null}
          {'targetId' in activity && activity.targetId !== '' ? (
            <span className="dsh-timeline__card-meta">
              {t('timeline.teamTarget', { target: activity.targetId })}
            </span>
          ) : null}
          {'delivery' in activity && activity.delivery !== undefined ? (
            <span className="dsh-timeline__card-meta">{t(`timeline.teamDelivery.${activity.delivery}`)}</span>
          ) : null}
        </li>
      </ul>
    </section>
  )
}

function renderAssistantTurn(
  node: AssistantTurnNode,
  expanded: ReadonlySet<string>,
  setExpanded: ExpandedDetailsSetter,
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
  onFeedbackSubmit?: FeedbackSubmit,
  onFeedbackPrepare?: FeedbackPrepare,
  feedbackUnavailable = false,
  transcriptView: TranscriptViewMode = 'standard',
  performanceUsage: PerformanceUsageMode = 'detailed',
): ReactElement {
  const inProgress = assistantNodeInProgress(node)
  const actionsUnavailable = running || inProgress || (node.turn !== undefined && node.turnCompleted !== true)
  const producedFiles = producedFilePaths(node.tools)
  const metricsLabel =
    performanceUsage === 'detailed' ? assistantMetricsLabel(node.timing, node.usage, t) : undefined
  const turnUsage =
    performanceUsage === 'detailed' && node.turnCompleted === true ? node.turnUsage : undefined
  const detailLabel =
    transcriptView === 'detailed' && node.turn !== undefined && node.step !== undefined
      ? t('timeline.stepMetadata', { turn: node.turn, step: node.step })
      : undefined
  return (
    <div className="dsh-timeline__message-stack">
      <article className="dsh-timeline__card dsh-timeline__card--assistant">
        <header className="dsh-timeline__card-header">
          <strong>{node.modelLabel ?? assistantLabel}</strong>
          {detailLabel === undefined ? null : <span className="dsh-timeline__card-meta">{detailLabel}</span>}
          {node.interrupted === true ? (
            <span className="dsh-timeline__card-meta">{t('timeline.interrupted')}</span>
          ) : null}
          {metricsLabel === undefined ? null : (
            <span className="dsh-timeline__assistant-metrics" title={metricsLabel}>
              {metricsLabel}
            </span>
          )}
        </header>
        {renderAssistantBlocks(
          node,
          expanded,
          setExpanded,
          onOpenLink,
          onLoadImage,
          t,
          producedFiles,
          transcriptView,
        )}
        {renderProducedFiles(producedFiles, onOpenLink, onShowInFolder, t)}
      </article>
      {turnUsage === undefined ? null : <TurnUsageDisclosure usage={turnUsage} translate={t} />}
      {node.markdown.trim() === '' || actionsUnavailable ? null : (
        <MessageActions
          text={node.markdown}
          {...feedbackActionProps(
            assistantMessageId(node),
            feedback,
            onFeedback,
            onFeedbackSubmit,
            onFeedbackPrepare,
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
  expanded: ReadonlySet<string>,
  setExpanded: ExpandedDetailsSetter,
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
  onFeedbackSubmit?: FeedbackSubmit,
  onFeedbackPrepare?: FeedbackPrepare,
  feedbackUnavailable = false,
  transcriptView: TranscriptViewMode = 'standard',
  performanceUsage: PerformanceUsageMode = 'detailed',
): ReactElement {
  const inProgress = assistantNodeInProgress(node)
  const actionsUnavailable = running || inProgress || (node.turn !== undefined && node.turnCompleted !== true)
  const metricsLabel =
    performanceUsage === 'detailed' ? assistantMetricsLabel(node.timing, node.usage, t) : undefined
  const turnUsage =
    performanceUsage === 'detailed' && node.turnCompleted === true ? node.turnUsage : undefined
  const detailLabel =
    transcriptView === 'detailed' && node.turn !== undefined && node.step !== undefined
      ? t('timeline.stepMetadata', { turn: node.turn, step: node.step })
      : undefined
  return (
    <div className="dsh-timeline__message-stack">
      <article className="dsh-timeline__card dsh-timeline__card--assistant">
        <header className="dsh-timeline__card-header">
          <strong>{node.modelLabel ?? assistantLabel}</strong>
          {detailLabel === undefined ? null : <span className="dsh-timeline__card-meta">{detailLabel}</span>}
          {node.interrupted === true ? (
            <span className="dsh-timeline__card-meta">{t('timeline.interrupted')}</span>
          ) : null}
          {metricsLabel === undefined ? null : (
            <span className="dsh-timeline__assistant-metrics" title={metricsLabel}>
              {metricsLabel}
            </span>
          )}
        </header>
        {node.reasoning === undefined ? null : (
          <ReasoningDisclosure
            id={`reasoning:${node.id}`}
            markdown={node.reasoning.markdown}
            streaming={node.reasoning.streaming}
            hideSettledPreview={transcriptView === 'compact'}
            expanded={expanded.has(`reasoning:${node.id}`)}
            onExpandedChange={reasoningExpandedChange(setExpanded, `reasoning:${node.id}`)}
            translate={t}
          />
        )}
        <MessageImages
          images={node.images ?? []}
          {...(onLoadImage === undefined ? {} : { loadImage: onLoadImage })}
          translate={t}
        />
        {node.markdown.trim() === '' ? null : (
          <MarkdownContent markdown={node.markdown} streaming={node.streaming} onOpenLink={onOpenLink} />
        )}
      </article>
      {turnUsage === undefined ? null : <TurnUsageDisclosure usage={turnUsage} translate={t} />}
      {node.markdown.trim() === '' || actionsUnavailable ? null : (
        <MessageActions
          text={node.markdown}
          {...feedbackActionProps(
            node.id,
            feedback,
            onFeedback,
            onFeedbackSubmit,
            onFeedbackPrepare,
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

function renderAssistantBlocks(
  node: AssistantTurnNode,
  expanded: ReadonlySet<string>,
  setExpanded: ExpandedDetailsSetter,
  onOpenLink: ((href: string) => void) | undefined,
  onLoadImage: ((image: MessageImageReference) => Promise<string | undefined>) | undefined,
  t: Translate,
  producedFiles: readonly string[],
  transcriptView: TranscriptViewMode,
): ReactElement[] {
  const blocks = node.blocks.length === 0 ? assistantBlocksFromAggregates(node) : node.blocks
  const lastMessageIndex = blocks.reduce(
    (last, block, index) => (block.kind === 'message' ? index : last),
    -1,
  )
  const rendered: ReactElement[] = []

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block === undefined) continue
    if (block.kind === 'reasoning') {
      rendered.push(
        <Fragment key={`reasoning:${block.id}:${index}`}>
          <ReasoningDisclosure
            id={`reasoning:${node.id}:${block.id}`}
            markdown={block.markdown}
            streaming={block.streaming}
            hideSettledPreview={transcriptView === 'compact'}
            expanded={expanded.has(`reasoning:${node.id}:${block.id}`)}
            onExpandedChange={reasoningExpandedChange(setExpanded, `reasoning:${node.id}:${block.id}`)}
            translate={t}
          />
        </Fragment>,
      )
      continue
    }
    if (block.kind === 'message') {
      rendered.push(
        <Fragment key={`message:${block.id}:${index}`}>
          <MessageImages
            images={block.images ?? []}
            {...(onLoadImage === undefined ? {} : { loadImage: onLoadImage })}
            translate={t}
          />
          {block.markdown.trim() === '' ? null : (
            <MarkdownContent
              markdown={block.markdown}
              streaming={block.streaming}
              onOpenLink={onOpenLink}
              {...(index === lastMessageIndex ? { producedFiles } : {})}
            />
          )}
        </Fragment>,
      )
      continue
    }

    const tools: ToolTimelineNode[] = [block.node]
    while (index + 1 < blocks.length && blocks[index + 1]?.kind === 'tool') {
      index += 1
      const next = blocks[index]
      if (next?.kind === 'tool') tools.push(next.node)
    }
    rendered.push(
      <div className="dsh-timeline__assistant-tools" key={`tools:${tools.map((tool) => tool.id).join('|')}`}>
        <ToolCallCollection
          tools={tools}
          expanded={expanded}
          onExpandedChange={setExpanded}
          translate={t}
          {...(onOpenLink === undefined ? {} : { onOpenLink })}
          {...(onLoadImage === undefined ? {} : { onLoadImage })}
        />
      </div>,
    )
  }

  return rendered
}

function assistantBlocksFromAggregates(node: AssistantTurnNode): readonly AssistantContentBlock[] {
  const blocks: AssistantContentBlock[] = []
  if (node.reasoning !== undefined) {
    blocks.push({
      kind: 'reasoning',
      id: `reasoning:${node.id}`,
      markdown: node.reasoning.markdown,
      streaming: node.reasoning.streaming,
    })
  }
  if (node.markdown.trim() !== '' || (node.images?.length ?? 0) > 0) {
    blocks.push({
      kind: 'message',
      id: node.id,
      markdown: node.markdown,
      streaming: node.streaming,
      ...(node.images === undefined ? {} : { images: node.images }),
    })
  }
  for (const tool of node.tools) blocks.push({ kind: 'tool', node: tool })
  return blocks
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
  onFeedbackSubmit: FeedbackSubmit | undefined,
  onFeedbackPrepare: FeedbackPrepare | undefined,
  feedbackUnavailable: boolean,
): {
  readonly feedbackRating?: MessageFeedbackRating
  readonly feedbackNote?: string
  readonly feedbackCategory?: FeedbackCategory
  readonly onFeedback?: (rating: MessageFeedbackRating) => void
  readonly onFeedbackSubmit?: (
    rating: MessageFeedbackRating,
    note: string | undefined,
    category: FeedbackCategory | undefined,
  ) => Promise<void> | void
  readonly onFeedbackPrepare?: () =>
    Promise<MessageFeedbackItem | undefined> | MessageFeedbackItem | undefined
  readonly feedbackUnavailable?: boolean
} {
  if (messageId === undefined || (onFeedback === undefined && onFeedbackSubmit === undefined)) return {}
  const item = feedback?.[messageId]
  const rating = item?.rating
  return {
    ...(rating === undefined ? {} : { feedbackRating: rating }),
    ...(item?.note === undefined ? {} : { feedbackNote: item.note }),
    ...(item?.category === undefined ? {} : { feedbackCategory: item.category }),
    ...(onFeedback === undefined
      ? {}
      : { onFeedback: (next: MessageFeedbackRating) => onFeedback(messageId, next) }),
    ...(onFeedbackSubmit === undefined
      ? {}
      : {
          onFeedbackSubmit: (
            next: MessageFeedbackRating,
            note: string | undefined,
            category: FeedbackCategory | undefined,
          ) => onFeedbackSubmit(messageId, next, note, category),
        }),
    ...(onFeedbackPrepare === undefined ? {} : { onFeedbackPrepare: () => onFeedbackPrepare(messageId) }),
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
    <div
      className="dsh-timeline__produced-files"
      data-produced-files-row="true"
      aria-label={t('timeline.producedFiles')}
    >
      <span className="dsh-timeline__produced-label">{t('timeline.producedFiles')}</span>
      <div className="dsh-timeline__produced-list">
        {paths.map((path) => {
          const label = producedFileLabel(path)
          return onOpenLink === undefined ? (
            <span className="dsh-timeline__produced-chip" key={path} title={path}>
              <Icon name="file" />
              <ContentFlow as="span" variant="truncate">
                {label}
              </ContentFlow>
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
              <ContentFlow as="span" variant="truncate">
                {label}
              </ContentFlow>
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

function TurnUsageDisclosure(props: {
  readonly usage: TurnTokenUsage
  readonly translate: Translate
}): ReactElement {
  const { usage, translate } = props
  return (
    <details className="dsh-timeline__turn-usage" aria-label={translate('timeline.tokenUsage')}>
      <summary>{translate('timeline.tokenUsage')}</summary>
      <dl>
        <div>
          <dt>{translate('timeline.uncachedInputTokens')}</dt>
          <dd>{formatExactTokens(usage.inputTokens)}</dd>
        </div>
        <div>
          <dt>{translate('stats.output')}</dt>
          <dd>{formatExactTokens(usage.outputTokens)}</dd>
        </div>
        {usage.cacheReadTokens === undefined ? null : (
          <div>
            <dt>{translate('stats.cacheRead')}</dt>
            <dd>{formatExactTokens(usage.cacheReadTokens)}</dd>
          </div>
        )}
        {usage.cacheWriteTokens === undefined ? null : (
          <div>
            <dt>{translate('stats.cacheWrite')}</dt>
            <dd>{formatExactTokens(usage.cacheWriteTokens)}</dd>
          </div>
        )}
        {usage.reasoningTokens === undefined ? null : (
          <div>
            <dt>{translate('stats.reasoning')}</dt>
            <dd>{formatExactTokens(usage.reasoningTokens)}</dd>
          </div>
        )}
        <div>
          <dt>{translate('timeline.totalTokens')}</dt>
          <dd>{formatExactTokens(usage.totalTokens)}</dd>
        </div>
      </dl>
    </details>
  )
}

function formatExactTokens(value: number): string {
  return value.toLocaleString()
}

function producedFilePaths(tools: readonly ToolTimelineNode[]): readonly string[] {
  const cached = producedFilePathsCache.get(tools)
  if (cached !== undefined) return cached

  const paths: string[] = []
  const seen = new Set<string>()
  for (const node of tools) {
    const tool = node.tool
    if (tool.status !== 'completed' || !isMutationTool(tool)) continue
    for (const location of tool.locations ?? []) {
      if (seen.has(location.path)) continue
      seen.add(location.path)
      paths.push(location.path)
      if (paths.length >= 6) {
        producedFilePathsCache.set(tools, paths)
        return paths
      }
    }
  }
  const result = paths.length === 0 ? EMPTY_PRODUCED_FILE_PATHS : paths
  producedFilePathsCache.set(tools, result)
  return result
}

// Timeline snapshots are immutable, so the tool-array identity safely scopes
// this projection cache without retaining completed conversations forever.
const producedFilePathsCache = new WeakMap<readonly ToolTimelineNode[], readonly string[]>()
const EMPTY_PRODUCED_FILE_PATHS: readonly string[] = []

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
  const key = props.usingTool === true ? 'timeline.activity.usingTool' : 'timeline.activity.responding'
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

const reasoningExpandedChangeCache = new WeakMap<
  ExpandedDetailsSetter,
  Map<string, (expanded: boolean) => void>
>()

function reasoningExpandedChange(
  setExpanded: ExpandedDetailsSetter,
  id: string,
): (expanded: boolean) => void {
  let callbacks = reasoningExpandedChangeCache.get(setExpanded)
  if (callbacks === undefined) {
    callbacks = new Map()
    reasoningExpandedChangeCache.set(setExpanded, callbacks)
  }
  const cached = callbacks.get(id)
  if (cached !== undefined) return cached
  const callback = (nextExpanded: boolean): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (nextExpanded) next.add(id)
      else next.delete(id)
      return next
    })
  }
  callbacks.set(id, callback)
  return callback
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

function createNodeSignatureProjector(): (node: DisplayTimelineNode | undefined) => string {
  const cache = new WeakMap<object, string>()
  return (node) => {
    if (node === undefined) return ''
    const cached = cache.get(node)
    if (cached !== undefined) return cached
    const signature = nodeSignature(node)
    cache.set(node, signature)
    return signature
  }
}

function nodeSignature(node: DisplayTimelineNode): string {
  if (node === undefined) return ''
  if (node.kind === 'assistant-turn') {
    const latest = node.tools[node.tools.length - 1]
    return `${node.id}:${node.markdown.length}:${node.streaming}:${node.interrupted === true}:${node.reasoning?.markdown.length ?? 0}:${node.reasoning?.streaming ?? false}:${node.images?.map((image) => image.attachmentId).join('|') ?? ''}:${node.tools.length}:${latest === undefined ? '' : toolNodeSignature(latest)}:${assistantBlockSignature(node.blocks)}`
  }
  if (node.kind === 'assistant-message')
    return `${node.id}:${node.markdown.length}:${node.streaming}:${node.interrupted === true}:${node.reasoning?.markdown.length ?? 0}:${node.reasoning?.streaming ?? false}:${node.images?.map((image) => image.attachmentId).join('|') ?? ''}`
  if (node.kind === 'reasoning') return `${node.id}:${node.markdown.length}:${node.streaming}`
  if (node.kind === 'tool') return toolNodeSignature(node)
  if (node.kind === 'event-group') return `${node.id}:${node.events.length}`
  return node.id
}

function assistantBlockSignature(blocks: readonly AssistantContentBlock[]): string {
  return blocks
    .map((block) =>
      block.kind === 'tool'
        ? `tool:${toolNodeSignature(block.node)}`
        : `${block.kind}:${block.id}:${block.markdown.length}:${block.streaming}`,
    )
    .join('|')
}

function toolNodeSignature(node: ToolTimelineNode): string {
  const tool = node.tool
  const presentation = tool.presentation
  return `${node.id}:${tool.images?.map((image) => image.attachmentId).join('|') ?? ''}:${tool.status}:${tool.inputSummary?.length ?? 0}:${tool.outputSummary?.length ?? 0}:${tool.error?.length ?? 0}:${tool.locations?.map((location) => `${location.path}:${location.line ?? ''}`).join('|') ?? ''}:${presentation?.phase ?? ''}:${presentation?.card ?? ''}`
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

const formattedEventPayloadCache = new WeakMap<object, string>()

function formatEventPayload(value: unknown, t: Translate = (key) => key): string {
  if (typeof value === 'object' && value !== null) {
    const cached = formattedEventPayloadCache.get(value)
    if (cached !== undefined) return cached
    try {
      const json = JSON.stringify(value, null, 2)
      const formatted = (json ?? '').slice(0, 8_192)
      formattedEventPayloadCache.set(value, formatted)
      return formatted
    } catch {
      return t('timeline.payloadUnavailable')
    }
  }
  try {
    const json = JSON.stringify(value, null, 2)
    return (json ?? '').slice(0, 8_192)
  } catch {
    return t('timeline.payloadUnavailable')
  }
}

interface DisplayNodeProjectionCache {
  readonly sourceNodes: readonly TimelineNode[]
  readonly showDshEvents: boolean
  readonly transcriptView: TranscriptViewMode
  /** Raw-node prefix that ends at a collapse/event boundary. */
  readonly stableRawLength: number
  /** Display nodes corresponding to the stable raw prefix. */
  readonly stableDisplayNodes: readonly DisplayTimelineNode[]
}

interface DisplayNodeProjection {
  readonly nodes: readonly DisplayTimelineNode[]
  readonly cache: DisplayNodeProjectionCache
}

function createDisplayNodeProjector(): (
  nodes: readonly TimelineNode[],
  showDshEvents: boolean,
  transcriptView: TranscriptViewMode,
  nodeChangeStart?: number,
  nodeChangeBase?: readonly TimelineNode[],
) => DisplayNodeProjection {
  let previous: DisplayNodeProjectionCache | undefined
  return (nodes, showDshEvents, transcriptView, nodeChangeStart, nodeChangeBase) => {
    const projection = projectDisplayNodes(
      nodes,
      showDshEvents,
      transcriptView,
      previous,
      nodeChangeStart,
      nodeChangeBase,
    )
    previous = projection.cache
    return projection
  }
}

function projectDisplayNodes(
  nodes: readonly TimelineNode[],
  showDshEvents: boolean,
  transcriptView: TranscriptViewMode,
  previous: DisplayNodeProjectionCache | undefined,
  nodeChangeStart?: number,
  nodeChangeBase?: readonly TimelineNode[],
): DisplayNodeProjection {
  let start = 0
  let prefix: readonly DisplayTimelineNode[] = []
  if (previous?.showDshEvents === showDshEvents && previous.transcriptView === transcriptView) {
    const commonPrefix =
      nodeChangeStart === undefined || nodeChangeBase !== previous.sourceNodes
        ? commonNodePrefixLength(previous.sourceNodes, nodes)
        : Math.max(0, Math.min(nodeChangeStart, previous.sourceNodes.length, nodes.length))
    if (commonPrefix >= previous.stableRawLength && nodes.length >= previous.stableRawLength) {
      start = previous.stableRawLength
      prefix = previous.stableDisplayNodes
    }
  }

  const suffix = nodes.slice(start)
  const display = prepareVisibleNodes(suffix, showDshEvents)
  const project = (
    visible: readonly DisplayTimelineNode[],
    stable: readonly DisplayTimelineNode[],
  ): readonly DisplayTimelineNode[] =>
    transcriptView === 'verbose' ? [...stable, ...visible] : collapseAssistantTurns(visible, stable)
  const projected = project(display, prefix)
  const stableRawLength = latestDisplayBoundary(nodes, start)
  let stableDisplayNodes = prefix
  if (stableRawLength === nodes.length) stableDisplayNodes = projected
  else if (stableRawLength > start) {
    stableDisplayNodes = project(
      prepareVisibleNodes(nodes.slice(start, stableRawLength), showDshEvents),
      prefix,
    )
  }

  return {
    nodes: projected,
    cache: {
      sourceNodes: nodes,
      showDshEvents,
      transcriptView,
      stableRawLength,
      stableDisplayNodes,
    },
  }
}

function commonNodePrefixLength(previous: readonly TimelineNode[], next: readonly TimelineNode[]): number {
  const length = Math.min(previous.length, next.length)
  let index = 0
  while (index < length && previous[index] === next[index]) index += 1
  return index
}

function latestDisplayBoundary(nodes: readonly TimelineNode[], start: number): number {
  let assistantWorkAfterBoundary = false
  for (let index = nodes.length; index > start; index -= 1) {
    const node = nodes[index - 1]
    if (node === undefined) continue
    if (node.kind === 'event') {
      // An event run immediately before assistant work cannot be changed by
      // a later streaming update. Keep it in the stable display prefix so
      // event grouping does not rebuild the whole run on every delta.
      if (assistantWorkAfterBoundary) return index
      continue
    }
    if (isAssistantWorkNode(node)) {
      assistantWorkAfterBoundary = true
      continue
    }
    if (isDisplayBoundary(node)) return index
  }
  return start
}

function isDisplayBoundary(node: TimelineNode): boolean {
  if (node.kind === 'event' || isAssistantWorkNode(node)) return false
  if (node.kind !== 'user-message') return true
  return !isInjectedUserTimelineNode(node)
}

function prepareVisibleNodes(
  nodes: readonly TimelineNode[],
  showDshEvents: boolean,
): readonly DisplayTimelineNode[] {
  const display: DisplayTimelineNode[] = []
  let activeEventGroup: (DshEventGroupNode & { events: DshEventNode[]; textSize: number }) | undefined

  for (const node of nodes) {
    if (node.kind === 'user-message' && isInjectedUserTimelineNode(node)) continue
    if (node.kind !== 'event') {
      activeEventGroup = undefined
      display.push(node)
      continue
    }
    if (!showDshEvents) {
      activeEventGroup = undefined
      continue
    }
    const eventTextSize = formatEventPayload(node.payload).length
    if (activeEventGroup !== undefined) {
      activeEventGroup.events.push(node)
      activeEventGroup.textSize += eventTextSize
      continue
    }
    activeEventGroup = {
      kind: 'event-group',
      id: `event-group:${node.id}`,
      events: [node],
      textSize: eventTextSize,
    }
    display.push(activeEventGroup)
  }

  return display
}

function isInjectedUserTimelineNode(node: Extract<TimelineNode, { readonly kind: 'user-message' }>): boolean {
  return isInjectedUserMessage({
    type: 'message.user',
    sessionId: '',
    messageId: node.id,
    markdown: node.markdown,
    ...(node.source === undefined ? {} : { source: node.source }),
  })
}

/**
 * DSH projects structured context messages immediately after the user turn
 * they enrich. Keep those hidden records out of the visible timeline while
 * retaining their display facts for the preceding user-authored text.
 */
function collectUserTextFacts(nodes: readonly TimelineNode[]): ReadonlyMap<string, UserTextFacts> {
  const facts = new Map<string, UserTextFacts>()
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (node?.kind !== 'user-message' || isInjectedUserTimelineNode(node)) continue

    const labels: string[] = []
    for (let nextIndex = index + 1; nextIndex < nodes.length; nextIndex += 1) {
      const next = nodes[nextIndex]
      if (next?.kind !== 'user-message' || !isInjectedUserTimelineNode(next)) break
      if (next.source === 'session-reference') labels.push(...(next.sessionReferenceLabels ?? []))
    }

    const uniqueLabels = [...new Set(labels)].slice(0, 32)
    if (uniqueLabels.length > 0) facts.set(node.id, { sessionReferenceLabels: uniqueLabels })
  }
  return facts
}

interface PendingAssistantWork {
  readonly id: string
  modelLabel?: string
  timing?: AssistantTiming
  usage?: TokenUsage
  turnUsage?: TurnTokenUsage | undefined
  images?: readonly MessageImageReference[]
  reasoning?: Pick<ReasoningBlock, 'markdown' | 'streaming'> | undefined
  readonly tools: ToolTimelineNode[]
  readonly blocks: AssistantContentBlock[]
  markdown: string
  streaming: boolean
  sequence?: number
  turn?: number
  step?: number
  turnCompleted?: boolean
  interrupted?: true
}

function collapseAssistantTurns(
  nodes: readonly DisplayTimelineNode[],
  initial: readonly DisplayTimelineNode[] = [],
): readonly DisplayTimelineNode[] {
  const collapsed: DisplayTimelineNode[] = [...initial]
  let pending: PendingAssistantWork | undefined

  const flush = (): void => {
    if (pending === undefined) return
    collapsed.push({
      kind: 'assistant-turn',
      id: `assistant-turn:${pending.id}`,
      ...(pending.modelLabel === undefined ? {} : { modelLabel: pending.modelLabel }),
      ...(pending.timing === undefined ? {} : { timing: pending.timing }),
      ...(pending.usage === undefined ? {} : { usage: pending.usage }),
      ...(pending.turnUsage === undefined ? {} : { turnUsage: pending.turnUsage }),
      ...(pending.images === undefined ? {} : { images: pending.images }),
      ...(pending.reasoning === undefined ? {} : { reasoning: pending.reasoning }),
      tools: pending.tools,
      blocks: pending.blocks,
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
    if (pending !== undefined && isAssistantWorkNode(node) && !canJoinPending(pending, node)) flush()
    if (node.kind === 'reasoning') {
      if (pending === undefined) {
        const previous = collapsed[collapsed.length - 1]
        if (previous?.kind === 'assistant-message' && canJoinPrevious(previous, node)) {
          collapsed.pop()
          pending = pendingFromAssistantMessage(previous)
        } else if (previous?.kind === 'assistant-turn' && canJoinPrevious(previous, node)) {
          collapsed.pop()
          pending = pendingFromAssistantTurn(previous)
        } else {
          pending = { id: node.id, tools: [], blocks: [], markdown: '', streaming: false }
        }
      }
      pending.reasoning = appendReasoning(pending.reasoning, node)
      appendReasoningContent(pending.blocks, node.id, node)
      continue
    }
    if (node.kind === 'tool') {
      if (pending === undefined) {
        const previous = collapsed[collapsed.length - 1]
        if (previous?.kind === 'assistant-message' && canJoinPrevious(previous, node)) {
          collapsed.pop()
          pending = pendingFromAssistantMessage(previous)
        } else if (previous?.kind === 'assistant-turn' && canJoinPrevious(previous, node)) {
          collapsed.pop()
          pending = {
            id: previous.id,
            ...(previous.modelLabel === undefined ? {} : { modelLabel: previous.modelLabel }),
            ...(previous.timing === undefined ? {} : { timing: previous.timing }),
            ...(previous.usage === undefined ? {} : { usage: previous.usage }),
            ...(previous.turnUsage === undefined ? {} : { turnUsage: previous.turnUsage }),
            ...(previous.images === undefined ? {} : { images: previous.images }),
            ...(previous.reasoning === undefined ? {} : { reasoning: previous.reasoning }),
            tools: [...previous.tools],
            blocks: [...assistantBlocks(previous)],
            markdown: previous.markdown,
            streaming: previous.streaming,
            ...(previous.sequence === undefined ? {} : { sequence: previous.sequence }),
            ...(previous.turn === undefined ? {} : { turn: previous.turn }),
            ...(previous.step === undefined ? {} : { step: previous.step }),
            ...(previous.turnCompleted === undefined ? {} : { turnCompleted: previous.turnCompleted }),
            ...(previous.interrupted === undefined ? {} : { interrupted: previous.interrupted }),
          }
        } else pending = { id: node.id, tools: [], blocks: [], markdown: '', streaming: false }
      }
      pending.tools.push(node)
      pending.blocks.push({ kind: 'tool', node })
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
        pending.turnUsage = node.turnUsage
        if (node.interrupted !== undefined) pending.interrupted = node.interrupted
        pending.reasoning = appendReasoning(pending.reasoning, node.reasoning)
        if (node.reasoning !== undefined) appendReasoningContent(pending.blocks, node.id, node.reasoning)
        if (hasVisibleOutput) appendMessageContent(pending.blocks, node)
        pending.markdown = joinAssistantMarkdown(pending.markdown, node.markdown)
        pending.streaming = node.streaming
        if (!hasVisibleOutput) continue

        collapsed.push(toAssistantTurn(pending, node.id))
        pending = undefined
        continue
      }
      if (node.reasoning !== undefined) {
        if (hasVisibleOutput) {
          collapsed.push(toAssistantTurn(pendingFromAssistantMessage(node), node.id))
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

function isAssistantWorkNode(node: DisplayTimelineNode): node is AssistantWorkNode {
  return (
    node.kind === 'assistant-message' ||
    node.kind === 'assistant-turn' ||
    node.kind === 'reasoning' ||
    node.kind === 'tool'
  )
}

type AssistantWorkNode =
  | Extract<DisplayTimelineNode, { readonly kind: 'assistant-message' }>
  | Extract<DisplayTimelineNode, { readonly kind: 'assistant-turn' }>
  | Extract<DisplayTimelineNode, { readonly kind: 'reasoning' }>
  | ToolTimelineNode

function canJoinPrevious(
  previous: Extract<DisplayTimelineNode, { readonly kind: 'assistant-message' }> | AssistantTurnNode,
  next: AssistantWorkNode,
): boolean {
  return canJoinPending(
    previous.kind === 'assistant-message'
      ? pendingFromAssistantMessage(previous)
      : pendingFromAssistantTurn(previous),
    next,
  )
}

function canJoinPending(pending: PendingAssistantWork, next: AssistantWorkNode): boolean {
  const nextTurn = assistantWorkTurn(next)
  if (pending.turn !== undefined && nextTurn !== undefined) return pending.turn === nextTurn
  // A durable completed turn is a boundary even when a legacy reasoning node
  // lacks turn metadata. The following assistant message can still adopt this
  // pending reasoning block as its own turn because pending has no turn yet.
  if (pending.turnCompleted === true && nextTurn === undefined) return false
  return true
}

function assistantWorkTurn(node: AssistantWorkNode): number | undefined {
  if (node.kind === 'tool') return node.tool.turn
  if (node.kind === 'reasoning') return undefined
  return node.turn
}

function pendingFromAssistantMessage(
  node: Extract<DisplayTimelineNode, { readonly kind: 'assistant-message' }>,
): PendingAssistantWork {
  return {
    id: node.id,
    ...(node.modelLabel === undefined ? {} : { modelLabel: node.modelLabel }),
    ...(node.timing === undefined ? {} : { timing: node.timing }),
    ...(node.usage === undefined ? {} : { usage: node.usage }),
    ...(node.turnUsage === undefined ? {} : { turnUsage: node.turnUsage }),
    ...(node.images === undefined ? {} : { images: node.images }),
    ...(node.reasoning === undefined ? {} : { reasoning: node.reasoning }),
    tools: [],
    blocks: assistantContentBlocksFromMessage(node),
    markdown: node.markdown,
    streaming: node.streaming,
    ...(node.sequence === undefined ? {} : { sequence: node.sequence }),
    ...(node.turn === undefined ? {} : { turn: node.turn }),
    ...(node.step === undefined ? {} : { step: node.step }),
    ...(node.turnCompleted === undefined ? {} : { turnCompleted: node.turnCompleted }),
    ...(node.interrupted === undefined ? {} : { interrupted: node.interrupted }),
  }
}

function pendingFromAssistantTurn(node: AssistantTurnNode): PendingAssistantWork {
  return {
    id: node.id,
    ...(node.modelLabel === undefined ? {} : { modelLabel: node.modelLabel }),
    ...(node.timing === undefined ? {} : { timing: node.timing }),
    ...(node.usage === undefined ? {} : { usage: node.usage }),
    ...(node.turnUsage === undefined ? {} : { turnUsage: node.turnUsage }),
    ...(node.images === undefined ? {} : { images: node.images }),
    ...(node.reasoning === undefined ? {} : { reasoning: node.reasoning }),
    tools: [...node.tools],
    blocks: [...assistantBlocks(node)],
    markdown: node.markdown,
    streaming: node.streaming,
    ...(node.sequence === undefined ? {} : { sequence: node.sequence }),
    ...(node.turn === undefined ? {} : { turn: node.turn }),
    ...(node.step === undefined ? {} : { step: node.step }),
    ...(node.turnCompleted === undefined ? {} : { turnCompleted: node.turnCompleted }),
    ...(node.interrupted === undefined ? {} : { interrupted: node.interrupted }),
  }
}

function assistantBlocks(node: AssistantTurnNode): readonly AssistantContentBlock[] {
  return node.blocks.length === 0 ? assistantBlocksFromAggregates(node) : node.blocks
}

function assistantContentBlocksFromMessage(
  node: Extract<DisplayTimelineNode, { readonly kind: 'assistant-message' }>,
): AssistantContentBlock[] {
  const blocks: AssistantContentBlock[] = []
  if (node.reasoning !== undefined) appendReasoningContent(blocks, node.id, node.reasoning)
  if (node.markdown.trim() !== '' || (node.images?.length ?? 0) > 0) appendMessageContent(blocks, node)
  return blocks
}

function appendReasoningContent(
  blocks: AssistantContentBlock[],
  id: string,
  reasoning: Pick<ReasoningBlock, 'markdown' | 'streaming'>,
): void {
  const index = blocks.findIndex((block) => block.kind === 'reasoning')
  if (index < 0) {
    blocks.unshift({ kind: 'reasoning', id, markdown: reasoning.markdown, streaming: reasoning.streaming })
    return
  }
  const current = blocks[index]
  if (current?.kind !== 'reasoning') return
  const merged = appendReasoning(current, reasoning)
  if (merged === undefined) return
  blocks[index] = { kind: 'reasoning', id: current.id, ...merged }
  if (index !== 0) {
    const [reasoningBlock] = blocks.splice(index, 1)
    if (reasoningBlock !== undefined) blocks.unshift(reasoningBlock)
  }
}

function appendMessageContent(
  blocks: AssistantContentBlock[],
  node: Extract<DisplayTimelineNode, { readonly kind: 'assistant-message' }>,
): void {
  const current = blocks[blocks.length - 1]
  if (current?.kind === 'message' && current.id === node.id) {
    const images = mergeImages(current.images, node.images ?? [])
    blocks[blocks.length - 1] = {
      kind: 'message',
      id: current.id,
      markdown: joinAssistantMarkdown(current.markdown, node.markdown),
      streaming: node.streaming,
      ...(images.length === 0 ? {} : { images }),
    }
    return
  }
  blocks.push({
    kind: 'message',
    id: node.id,
    markdown: node.markdown,
    streaming: node.streaming,
    ...(node.images === undefined ? {} : { images: node.images }),
  })
}

function toAssistantTurn(pending: PendingAssistantWork, id: string): AssistantTurnNode {
  return {
    kind: 'assistant-turn',
    id: `assistant-turn:${id}`,
    ...(pending.modelLabel === undefined ? {} : { modelLabel: pending.modelLabel }),
    ...(pending.timing === undefined ? {} : { timing: pending.timing }),
    ...(pending.usage === undefined ? {} : { usage: pending.usage }),
    ...(pending.turnUsage === undefined ? {} : { turnUsage: pending.turnUsage }),
    ...(pending.images === undefined ? {} : { images: pending.images }),
    ...(pending.reasoning === undefined ? {} : { reasoning: pending.reasoning }),
    tools: pending.tools,
    blocks: pending.blocks,
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
  left: Pick<ReasoningBlock, 'markdown' | 'streaming'> | undefined,
  right: Pick<ReasoningBlock, 'markdown' | 'streaming'> | undefined,
): Pick<ReasoningBlock, 'markdown' | 'streaming'> | undefined {
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
