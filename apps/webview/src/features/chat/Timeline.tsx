import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from 'react'
import type { TimelineNode } from '@dsh-vscode/timeline'
import type { MessageFeedbackItem, MessageFeedbackRating, MessageImageReference } from '@dsh-vscode/domain'
import {
  DEFAULT_UNMEASURED_ROW_WINDOW,
  ScrollToLatestButton,
  useVirtualizedCollection,
  useScrollFollow,
  useTailEntrance,
  type ScrollAnchor,
} from '../../components/common/index.js'
import { Icon } from '../../ui/Icon.js'
import { useI18n } from '../../i18n.js'
import type { PerformanceUsageMode, TranscriptViewMode } from '../../app/ui-preferences.js'
import {
  createDisplayNodeProjector,
  createDisplayNodeTextSizeProjector,
  createNodeSignatureProjector,
  createTimelineFactsProjector,
  createVirtualizationProjector,
  createUserTextFactsProjector,
} from './timeline-projection.js'
import {
  type DisplayTimelineNode,
  type FeedbackPrepare,
  type FeedbackSubmit,
  type TimelineNodeRenderContext,
} from './timeline-shared.js'
import { StreamingActivity } from './timeline-renderers.js'
import { TimelineRow } from './TimelineRow.js'
import { ToolLinkErrorDialog } from './ToolLinkErrorDialog.js'

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
  const userTextFactsProjector = useMemo(() => createUserTextFactsProjector(), [])
  // Identity-stable across streaming frames: the facts only change when a
  // user-authored row actually does, so the render context below (and with it
  // every memoized TimelineRow) survives tool/assistant deltas untouched.
  const userTextFacts = userTextFactsProjector(props.nodes)
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
  // Until the virtualizer owns a measured viewport the rows come from the
  // plain list. Anchor that frame at the tail and keep it a constant: it still
  // has to cover a viewport for the measurement to be meaningful, and the
  // reader of a reopened long session is looking at the newest rows.
  const unmeasuredRowStart = Math.max(0, displayNodes.length - DEFAULT_UNMEASURED_ROW_WINDOW)
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
              : displayNodes.slice(unmeasuredRowStart).map((node, offset) => (
                  <div
                    key={node.id}
                    data-index={unmeasuredRowStart + offset}
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

function timelineNodeKey(node: DisplayTimelineNode): string {
  return node.id
}
