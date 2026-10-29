import {
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
import type { TimelineNode } from '@dsh-vscode/timeline'
import type { MessageFeedbackItem, MessageFeedbackRating, MessageImageReference } from '@dsh-vscode/domain'
import {
  DEFAULT_ESTIMATED_ITEM_SIZE,
  DEFAULT_UNMEASURED_ROW_WINDOW,
  ScrollToLatestButton,
  useVirtualizedCollection,
  useScrollFollow,
  useTailEntrance,
  type ScrollAnchor,
} from '../../components/common/index.js'
import { Icon } from '../../ui/Icon.js'
import { compactActivity } from './compact-activity.js'
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
  type FeedbackPrepare,
  type FeedbackSubmit,
  type TimelineNodeRenderContext,
} from './timeline-shared.js'
import { StreamingActivity } from './timeline-renderers.js'
import { TurnProgressAnnouncement } from './TurnProgressAnnouncement.js'
import { TimelineRow } from './TimelineRow.js'
import { ToolLinkErrorDialog } from './ToolLinkErrorDialog.js'
import {
  createFocusedTimelineProjector,
  presentedSourceNodeIds,
  type PresentedTimelineNode,
} from './focused-timeline-projection.js'
import { useCompleteTranscriptNodes } from './useCompleteTranscriptNodes.js'
import { useCompletionCue } from '../../app/useCompletionCue.js'
import { useTranscriptCopyFallback } from './useTranscriptCopyFallback.js'
import { useConversationLayout } from '../../app/ConversationLayoutProvider.js'
import type { ConversationLayout } from '../../app/conversation-layout.js'
import { useQuietActivity } from '../../app/AccessibilityProvider.js'

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
  /** Nodes whose wire projection clipped their Markdown. */
  readonly omittedNodeIds?: readonly string[]
  readonly contentVersions?: Readonly<Record<string, string>>
  readonly loadFullNode?: (nodeId: string, signal?: AbortSignal) => Promise<TimelineNode>
  readonly loadFullContent?: (nodeId: string) => Promise<string>
  /** Receipt after the settled turn's current full bodies have committed. */
  readonly onResponseRendered?: (sessionId: string, turn: number) => Promise<boolean>
  /** Whether an older DSH history window is available. */
  readonly hasMoreHistory?: boolean
  readonly loadingOlderHistory?: boolean
  readonly onLoadOlderHistory?: () => Promise<void> | void
  readonly pagedHistory?: boolean
  readonly revealTarget?: { readonly nodeId: string; readonly requestId: string }
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
  // Measurements and temporary reading anchors belong to one conversation,
  // including when different sessions contain the same source node IDs.
  return <SessionTimeline key={props.sessionId} {...props} />
})

const SessionTimeline = memo(function SessionTimeline(props: TimelineProps): ReactElement {
  const { t } = useI18n()
  const activityRegionId = useId()
  const [activityDisclosure, setActivityDisclosure] = useState<{
    expanded: boolean
    dismissedReveal?: string
  }>({ expanded: false })
  const revealKey = props.revealTarget?.requestId ?? props.revealTarget?.nodeId
  const allActivity =
    activityDisclosure.expanded ||
    (revealKey !== undefined && activityDisclosure.dismissedReveal !== revealKey)
  const layoutPreference = useConversationLayout()
  const conversationLayout = layoutPreference?.layout ?? 'classic'
  const [layoutAnchor, setLayoutAnchor] = useState<{
    readonly layout: ConversationLayout
    readonly sessionId: string
    readonly nodeId: string
    readonly offset: number
    readonly interaction: ScrollAnchor
  }>()
  const focusedProjector = useMemo(() => createFocusedTimelineProjector(), [])
  const prependAnchorRef = useRef<ScrollAnchor | undefined>(undefined)
  const restoredPrependAnchorRef = useRef<ScrollAnchor | undefined>(undefined)
  const readerAnchorRef = useRef<ScrollAnchor | undefined>(undefined)
  const deferredReaderLayoutRef = useRef<(() => void) | undefined>(undefined)
  const measuredWidthRef = useRef(0)
  const olderHistoryRequestRef = useRef<
    { readonly sessionId: string; readonly firstNodeId: string | undefined } | undefined
  >(undefined)
  useLayoutEffect(() => {
    prependAnchorRef.current = undefined
    restoredPrependAnchorRef.current = undefined
    readerAnchorRef.current = undefined
    measuredWidthRef.current = 0
    olderHistoryRequestRef.current = undefined
  }, [props.sessionId])
  const [expandedDetails, setExpandedDetails] = useState<ReadonlySet<string>>(new Set())
  const quietActivity = useQuietActivity()
  const presentationFocus = useRef<
    | {
        readonly element: HTMLElement
        readonly sessionId: string
        readonly rowId: string
        readonly toolId: string | undefined
      }
    | undefined
  >(undefined)
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
  const complete = useCompleteTranscriptNodes(
    props.sessionId,
    props.nodes,
    props.omittedNodeIds,
    props.loadFullNode,
    undefined,
    props.contentVersions,
  )
  const sourceNodes = complete.nodes
  useCompletionCue(
    props.onResponseRendered,
    { sessionId: props.sessionId, nodes: sourceNodes },
    complete.pendingIds,
  )
  const changeStart = sourceNodes === props.nodes ? props.nodeChangeStart : undefined
  const changeBase = sourceNodes === props.nodes ? props.nodeChangeBase : undefined
  const compactProjection = useMemo(
    () => (transcriptView === 'compact' ? compactActivity(sourceNodes) : { nodes: sourceNodes, hidden: 0 }),
    [sourceNodes, transcriptView],
  )
  const activityNodes = allActivity ? sourceNodes : compactProjection.nodes
  const displayProjection = useMemo(
    () =>
      displayProjector(
        activityNodes,
        showDshEvents,
        conversationLayout === 'focused' || transcriptView === 'compact' ? 'verbose' : transcriptView,
        activityNodes === sourceNodes ? changeStart : undefined,
        activityNodes === sourceNodes ? changeBase : undefined,
      ),
    [
      displayProjector,
      changeBase,
      changeStart,
      sourceNodes,
      activityNodes,
      showDshEvents,
      transcriptView,
      conversationLayout,
    ],
  )
  const displayNodes = useMemo(
    () =>
      conversationLayout === 'focused' ? focusedProjector(displayProjection.nodes) : displayProjection.nodes,
    [conversationLayout, displayProjection.nodes, focusedProjector],
  )
  // The Webview's own "Copy" copies nothing without a selection; this fills it
  // with the addressed row's Markdown instead of an empty clipboard.
  const copyFallbackAnnounced = useTranscriptCopyFallback(
    displayNodes,
    props.omittedNodeIds,
    props.loadFullContent,
  )
  const running = props.running ?? props.streaming
  const hasMoreHistory = props.hasMoreHistory
  const loadingOlderHistory = props.loadingOlderHistory
  const onLoadOlderHistory = props.onLoadOlderHistory
  const displayNodeTextSizeProjector = useMemo(() => createDisplayNodeTextSizeProjector(), [])
  const timelineFactsProjector = useMemo(() => createTimelineFactsProjector(), [])
  const timelineFacts = useMemo(
    () => timelineFactsProjector(sourceNodes, changeStart, changeBase),
    [timelineFactsProjector, changeBase, changeStart, sourceNodes],
  )
  const userTextFactsProjector = useMemo(() => createUserTextFactsProjector(), [])
  // Identity-stable across streaming frames: the facts only change when a
  // user-authored row actually does, so the render context below (and with it
  // every memoized TimelineRow) survives tool/assistant deltas untouched.
  const userTextFacts = userTextFactsProjector(sourceNodes, changeStart, changeBase)
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
  const stableLoadFullContent = useStableOptionalCallback(props.loadFullContent)
  const truncatedNodeIds = useMemo(() => new Set(props.omittedNodeIds), [props.omittedNodeIds])
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
  const latestSignature =
    latestNode?.kind === 'focused-turn'
      ? `${latestNode.id}:${latestNode.foldable}:${latestNode.nodes.map(nodeSignatureProjector).join('|')}`
      : nodeSignatureProjector(latestNode)
  const virtualizeTimeline = virtualizationProjector(displayProjection.nodes, displayNodeTextSizeProjector)
  const {
    scrollRef,
    contentRef,
    userScrollToLatest,
    userScrollToOffset,
    scheduleScrollToLatest,
    captureScrollAnchor,
    isScrollAnchorCurrent,
    restoreScrollAnchor,
    applyScrollAdjustment,
    isUserScrollActive,
    isPinnedToBottom,
    showJumpToLatest,
  } = useScrollFollow({
    contentKey: latestSignature,
    itemCount: displayNodes.length,
    sessionId: props.sessionId,
    layoutMeasurementsActive: virtualizeTimeline,
    onScrollIdle: () => {
      const reconcile = deferredReaderLayoutRef.current
      deferredReaderLayoutRef.current = undefined
      reconcile?.()
    },
  })
  useLayoutEffect(() => {
    const saved = presentationFocus.current
    if (saved !== undefined && saved.sessionId !== props.sessionId) {
      presentationFocus.current = undefined
      return
    }
    if (saved === undefined || saved.element.isConnected || document.activeElement !== document.body) return
    // A host screen-reader change can replace a tool disclosure while its
    // keyboard focus is inside. Restore only the removed control's row; never
    // take focus back from settings, the composer or another live control.
    const row = [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-node-id]') ?? [])].find(
      (element) => element.dataset.nodeId === saved.rowId,
    )
    const tool = [...(row?.querySelectorAll<HTMLElement>('[data-tool-call-id]') ?? [])].find(
      (element) => element.dataset.toolCallId === saved.toolId,
    )
    const visible = (element: HTMLElement): boolean => {
      for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
        if (parent.hidden) return false
        if (
          parent instanceof HTMLDetailsElement &&
          !parent.open &&
          !parent.querySelector(':scope > summary')?.contains(element)
        )
          return false
      }
      return true
    }
    const candidates = [
      ...(tool?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []),
      ...(row?.querySelectorAll<HTMLElement>(
        '[data-quiet-tools] button:not(:disabled), .dsh-focused-tools__summary:not(:disabled), .dsh-timeline__tool-group > summary, .dsh-tool-card__summary:not(:disabled), .dsh-tool-row__toggle:not(:disabled)',
      ) ?? []),
      ...(row?.querySelectorAll<HTMLElement>('.dsh-focused-turn__summary:not(:disabled)') ?? []),
    ]
    // Preparing tools can have no enabled detail controls in the live view.
    // Prefer the outer process disclosure, then keep a programmatic focus
    // anchor on the original row without adding it to sequential Tab order.
    const target = candidates.find(visible) ?? (row !== undefined && visible(row) ? row : undefined)
    if (target === row && row !== undefined) row.tabIndex = -1
    target?.focus({ preventScroll: true })
  }, [quietActivity, props.sessionId, scrollRef])
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
  const revealNodeId = props.revealTarget?.nodeId
  const revealIndex =
    revealNodeId === undefined
      ? -1
      : displayNodes.findIndex((node) => presentedSourceNodeIds(node).includes(revealNodeId))
  const anchorIndex =
    layoutAnchor?.layout === conversationLayout && layoutAnchor.sessionId === props.sessionId
      ? displayNodes.findIndex((node) => presentedSourceNodeIds(node).includes(layoutAnchor.nodeId))
      : -1
  // A prepended page can enable virtualization while the reader's old row is
  // outside the new initial range. Keep that row mounted until restoration has
  // used its real position instead of estimating from the whole canvas.
  const getPinnedTimelineIndex = useCallback((): number | undefined => {
    if (anchorIndex >= 0 && layoutAnchor !== undefined && isScrollAnchorCurrent(layoutAnchor.interaction))
      return anchorIndex
    const prependAnchor = prependAnchorRef.current
    const prependNodeId =
      prependAnchor !== undefined && isScrollAnchorCurrent(prependAnchor) ? prependAnchor.nodeId : undefined
    const prependIndex =
      prependNodeId === undefined ? -1 : displayNodes.findIndex((node) => node.id === prependNodeId)
    if (prependIndex >= 0) return prependIndex
    const readerAnchor = readerAnchorRef.current
    const readerIndex =
      !isPinnedToBottom && readerAnchor !== undefined && isScrollAnchorCurrent(readerAnchor)
        ? displayNodes.findIndex((node) => node.id === readerAnchor.nodeId)
        : -1
    // Measure the actual tail while following it. An estimated final row can
    // grow after an explicit jump and leave the latest answer offscreen.
    return (
      getFocusedTimelineIndex() ??
      (revealIndex >= 0
        ? revealIndex
        : readerIndex >= 0
          ? readerIndex
          : isPinnedToBottom
            ? displayNodes.length - 1
            : undefined)
    )
  }, [
    anchorIndex,
    displayNodes,
    getFocusedTimelineIndex,
    isPinnedToBottom,
    isScrollAnchorCurrent,
    layoutAnchor,
    revealIndex,
  ])
  // Seed the virtualizer with the heights the rows actually had in the
  // non-virtualized list. Without it the canvas starts at count × 96px, so the
  // frame that crosses the virtualization threshold collapses the scroll range
  // and the transcript jumps (measured at 1534px on a 30-node conversation).
  // Per-row heights matter: a conversation mixes short user rows with tall
  // answers, and an average alone still moved the viewport by 237px.
  const measuredRowHeightsRef = useRef(new Map<string, number>())
  const measuredSessionRef = useRef(props.sessionId)
  useLayoutEffect(() => {
    if (measuredSessionRef.current === props.sessionId) return
    measuredSessionRef.current = props.sessionId
    measuredRowHeightsRef.current.clear()
  }, [props.sessionId])
  useLayoutEffect(() => {
    if (virtualizeTimeline) return
    const timeline = scrollRef.current
    if (timeline === null) return
    const rows = timeline.querySelectorAll<HTMLElement>('.dsh-timeline__row')
    if (rows.length === 0) return
    const currentIds = new Set(displayNodes.map((node) => node.id))
    for (const id of measuredRowHeightsRef.current.keys()) {
      if (!currentIds.has(id)) measuredRowHeightsRef.current.delete(id)
    }
    const measureRows = (changedRows: readonly HTMLElement[]): void => {
      let readerAdjustment = 0
      let precedingAdjustment = 0
      const viewportTop = timeline.getBoundingClientRect().top
      // A resize above another changed row also changes the latter's current
      // top. Process in transcript order and recover its pre-resize position.
      const orderedRows = [...changedRows].sort(
        (left, right) => Number(left.dataset.index) - Number(right.dataset.index),
      )
      for (const row of orderedRows) {
        if (!row.isConnected) continue
        const id = row.dataset.nodeId
        const height = row.getBoundingClientRect().height || row.offsetHeight
        if (id === undefined || height <= 0) continue
        const previousHeight = measuredRowHeightsRef.current.get(id)
        const delta = previousHeight === undefined ? 0 : height - previousHeight
        if (
          previousHeight !== undefined &&
          Math.abs(delta) > 0.5 &&
          !isPinnedToBottom &&
          !isUserScrollActive() &&
          row.getBoundingClientRect().top - precedingAdjustment + previousHeight <= viewportTop + 0.5
        )
          readerAdjustment += delta
        precedingAdjustment += delta
        measuredRowHeightsRef.current.set(id, height)
      }
      if (Math.abs(readerAdjustment) > 0.5) applyScrollAdjustment(readerAdjustment)
    }
    // A React commit can resize an earlier row before ResizeObserver runs.
    // Measure during the layout effect so its anchor correction precedes paint.
    measureRows([...rows])
    // Images and other asynchronous content can resize a row without a React
    // render. Release the observer when the session or virtual window changes.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      measureRows(
        entries.map((entry) => entry.target).filter((row): row is HTMLElement => row instanceof HTMLElement),
      )
    })
    for (const row of rows) observer.observe(row, { box: 'border-box' })
    return () => observer.disconnect()
  }, [
    applyScrollAdjustment,
    displayNodes,
    isPinnedToBottom,
    isUserScrollActive,
    props.sessionId,
    scrollRef,
    virtualizeTimeline,
  ])
  const estimateRowHeight = useCallback(
    (index: number): number => {
      const node = displayNodes[index]
      if (node !== undefined && measuredSessionRef.current === props.sessionId) {
        const measured = measuredRowHeightsRef.current.get(node.id)
        if (measured !== undefined) return measured
      }
      // A newly appended row begins short even when earlier answers are tall.
      // Using their average temporarily grows the canvas by hundreds of pixels
      // and then shrinks it as soon as the new row is measured.
      return DEFAULT_ESTIMATED_ITEM_SIZE
    },
    [displayNodes, props.sessionId],
  )
  const virtualized = useVirtualizedCollection({
    items: displayNodes,
    scrollRef,
    enabled: virtualizeTimeline,
    estimateSize: estimateRowHeight,
    getItemKey: timelineNodeKey,
    getPinnedItemIndex: getPinnedTimelineIndex,
    onScrollAdjustment: applyScrollAdjustment,
  })
  const virtualizedReady = virtualized.enabled && virtualized.ready
  useLayoutEffect(() => {
    const timeline = scrollRef.current
    if (timeline === null || typeof ResizeObserver === 'undefined') return
    const content = contentRef.current
    const reconcile = (entries: readonly ResizeObserverEntry[], deferred = false): void => {
      const viewportEntry = entries.find((entry) => entry.target === timeline)
      const width = viewportEntry?.contentRect.width ?? timeline.clientWidth
      if (width <= 0 || timeline.clientHeight <= 0) return
      const previousWidth = measuredWidthRef.current
      measuredWidthRef.current = width
      const contentResized = entries.some((entry) => entry.target === content && entry.contentRect.height > 0)
      const widthChanged = previousWidth > 0 && Math.abs(previousWidth - width) > 0.5
      const anchor = readerAnchorRef.current
      if (
        (!widthChanged && !contentResized && !deferred) ||
        isPinnedToBottom ||
        prependAnchorRef.current !== undefined ||
        anchor?.nodeId === undefined ||
        anchor.nodeOffset === undefined ||
        !isScrollAnchorCurrent(anchor)
      )
        return
      if (isUserScrollActive()) {
        deferredReaderLayoutRef.current = () => reconcile(entries, true)
        return
      }
      const node = displayNodes.find((node) => node.id === anchor.nodeId)
      if (node === undefined) return
      const row = [...timeline.querySelectorAll<HTMLElement>('.dsh-timeline__row')].find(
        (row) => row.dataset.nodeId === anchor.nodeId,
      )
      const delta =
        row === undefined
          ? 0
          : row.getBoundingClientRect().top - timeline.getBoundingClientRect().top - anchor.nodeOffset
      if (!widthChanged && Math.abs(delta) <= 0.5) return
      applyScrollAdjustment(delta)
      // Width changes, image decoding and a revealed virtual canvas can all
      // move a reading row. Reuse the bounded layout measurement pass.
      const nodeId = presentedSourceNodeIds(node)[0]
      if (nodeId !== undefined)
        setLayoutAnchor({
          layout: conversationLayout,
          sessionId: props.sessionId,
          nodeId,
          offset: anchor.nodeOffset,
          interaction: anchor,
        })
    }
    const observer = new ResizeObserver((entries) => reconcile(entries))
    observer.observe(timeline)
    if (content !== null) observer.observe(content)
    return () => {
      observer.disconnect()
      deferredReaderLayoutRef.current = undefined
    }
  }, [
    applyScrollAdjustment,
    conversationLayout,
    contentRef,
    displayNodes,
    isPinnedToBottom,
    isScrollAnchorCurrent,
    isUserScrollActive,
    props.sessionId,
    scrollRef,
  ])
  const beforeLayoutChange = layoutPreference?.beforeChange
  useLayoutEffect(
    () =>
      beforeLayoutChange?.((next) => {
        const timeline = scrollRef.current
        if (next === conversationLayout || isPinnedToBottom || timeline === null) return
        const viewport = timeline.getBoundingClientRect()
        const rows = Array.from(timeline.querySelectorAll<HTMLElement>('.dsh-timeline__row'))
        const row =
          rows.find((element) => {
            const bounds = element.getBoundingClientRect()
            return bounds.top >= viewport.top && bounds.top < viewport.bottom
          }) ?? rows.find((element) => element.getBoundingClientRect().bottom > viewport.top)
        const node = row === undefined ? undefined : displayNodes[Number(row.dataset.index)]
        if (node === undefined || row === undefined) return
        const nodeId =
          node.kind === 'focused-turn'
            ? (node.answer?.id ?? node.sourceIds[0])
            : presentedSourceNodeIds(node)[0]
        if (nodeId === undefined) return
        const interaction = captureScrollAnchor()
        if (interaction === undefined) return
        setLayoutAnchor({
          layout: next,
          sessionId: props.sessionId,
          nodeId,
          offset: row.getBoundingClientRect().top - viewport.top,
          interaction,
        })
      }),
    [
      beforeLayoutChange,
      captureScrollAnchor,
      conversationLayout,
      displayNodes,
      isPinnedToBottom,
      props.sessionId,
      scrollRef,
    ],
  )
  useLayoutEffect(() => {
    if (layoutAnchor === undefined || anchorIndex < 0 || (virtualized.enabled && !virtualized.ready)) return
    const timeline = scrollRef.current
    if (timeline === null) return
    let frame: number | undefined
    let remaining = 8
    const release = (): void => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      readerAnchorRef.current = captureScrollAnchor()
      setLayoutAnchor((current) => (current === layoutAnchor ? undefined : current))
    }
    const correct = (): boolean => {
      // Explicit latest/Inspector navigation can arrive without a native
      // gesture. An old layout pass must yield before writing another offset.
      if (!isScrollAnchorCurrent(layoutAnchor.interaction)) {
        release()
        return false
      }
      const row = Array.from(timeline.querySelectorAll<HTMLElement>('.dsh-timeline__row')).find(
        (element) => Number(element.dataset.index) === anchorIndex,
      )
      if (row !== undefined)
        applyScrollAdjustment(
          row.getBoundingClientRect().top - timeline.getBoundingClientRect().top - layoutAnchor.offset,
        )
      return true
    }
    if (!correct()) return
    // The virtualizer refines row heights after commit. Pin the original source
    // until that measurement has settled, then release it without stealing focus.
    const settle = (): void => {
      if (!correct()) return
      if (--remaining > 0) frame = window.requestAnimationFrame(settle)
      else release()
    }
    frame = window.requestAnimationFrame(settle)
    // A new reader gesture always wins over the bounded measurement pass.
    timeline.addEventListener('wheel', release, { passive: true })
    timeline.addEventListener('pointerdown', release)
    timeline.addEventListener('keydown', release)
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      timeline.removeEventListener('wheel', release)
      timeline.removeEventListener('pointerdown', release)
      timeline.removeEventListener('keydown', release)
    }
  }, [
    anchorIndex,
    applyScrollAdjustment,
    captureScrollAnchor,
    isScrollAnchorCurrent,
    layoutAnchor,
    scrollRef,
    virtualized.enabled,
    virtualized.ready,
  ])
  const revealedRequest = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    const requestId = props.revealTarget?.requestId
    if (requestId === undefined || revealedRequest.current === requestId || revealIndex < 0) return
    if (virtualized.enabled && !virtualized.ready) return
    const row = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('.dsh-timeline__row') ?? []).find(
      (element) => Number(element.dataset.index) === revealIndex,
    )
    if (row === undefined) return
    const offset = virtualized.enabled ? virtualized.getItemOffset(revealIndex) : row.offsetTop
    if (offset === undefined) return
    revealedRequest.current = requestId
    userScrollToOffset(offset)
    row.tabIndex = -1
    row.focus({ preventScroll: true })
  }, [props.revealTarget, revealIndex, scrollRef, userScrollToOffset, virtualized])
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
    // native reader input cancels it before it can move the viewport. Coalesce
    // (no `immediate`) so a streaming row's provisional heights collapse into
    // one write per microtask instead of a synchronous write per refinement.
    scheduleScrollToLatest({ preserveBottom: true })
  }, [running, scheduleScrollToLatest, virtualizedReady, virtualized.totalSize])
  const loadOlderHistory = useCallback((): void => {
    if (
      hasMoreHistory !== true ||
      loadingOlderHistory === true ||
      onLoadOlderHistory === undefined ||
      olderHistoryRequestRef.current?.sessionId === props.sessionId
    )
      return
    prependAnchorRef.current = captureScrollAnchor()
    const request = { sessionId: props.sessionId, firstNodeId: displayNodes[0]?.id }
    olderHistoryRequestRef.current = request
    const result = onLoadOlderHistory()
    if (result === undefined) {
      if (olderHistoryRequestRef.current === request) olderHistoryRequestRef.current = undefined
      return
    }
    void result.finally(() => {
      if (olderHistoryRequestRef.current === request) olderHistoryRequestRef.current = undefined
    })
  }, [
    captureScrollAnchor,
    displayNodes,
    hasMoreHistory,
    loadingOlderHistory,
    onLoadOlderHistory,
    props.sessionId,
  ])
  const handleScroll = useCallback((): void => {
    const element = scrollRef.current
    if (element === null || element.clientHeight <= 0) return
    if (!isPinnedToBottom && layoutAnchor === undefined && prependAnchorRef.current === undefined)
      readerAnchorRef.current = captureScrollAnchor()
    const request = olderHistoryRequestRef.current
    if (
      element !== null &&
      loadingOlderHistory === true &&
      request?.sessionId === props.sessionId &&
      request.firstNodeId === displayNodes[0]?.id &&
      prependAnchorRef.current !== undefined &&
      isUserScrollActive()
    )
      prependAnchorRef.current = captureScrollAnchor()
    if (props.pagedHistory !== true && element !== null && element.scrollTop <= 24 && isUserScrollActive())
      loadOlderHistory()
  }, [
    captureScrollAnchor,
    displayNodes,
    isPinnedToBottom,
    isUserScrollActive,
    layoutAnchor,
    loadOlderHistory,
    loadingOlderHistory,
    props.sessionId,
    scrollRef,
    props.pagedHistory,
  ])

  const hasLoadImage = props.onLoadImage !== undefined
  const hasShowInFolder = props.onShowInFolder !== undefined
  const hasOpenSession = props.onOpenSession !== undefined
  const hasBranch = props.onBranch !== undefined
  const hasFeedback = props.onFeedback !== undefined || props.onFeedbackSubmit !== undefined
  const nodeRenderContext = useMemo<TimelineNodeRenderContext>(
    () => ({
      conversationLayout,
      revealSourceNodeId: props.revealTarget?.nodeId,
      revealRequestId: props.revealTarget?.requestId,
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
      feedback: props.feedback,
      feedbackUnavailable: props.feedbackUnavailable,
      transcriptView,
      performanceUsage,
      onFeedback: hasFeedback ? stableOnFeedback : undefined,
      onFeedbackSubmit: props.onFeedbackSubmit === undefined ? undefined : stableOnFeedbackSubmit,
      onFeedbackPrepare: props.onFeedbackPrepare === undefined ? undefined : stableOnFeedbackPrepare,
      truncatedNodeIds,
      loadFullContent: props.loadFullContent === undefined ? undefined : stableLoadFullContent,
      requestOpenLink,
      t,
    }),
    [
      conversationLayout,
      props.revealTarget?.nodeId,
      props.revealTarget?.requestId,
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
      props.loadFullContent,
      props.onFeedbackSubmit,
      props.onFeedbackPrepare,
      requestOpenLink,
      stableLoadFullContent,
      stableOnBranch,
      stableOnFeedback,
      stableOnFeedbackSubmit,
      stableOnFeedbackPrepare,
      stableOnLoadImage,
      stableOnOpenSession,
      stableOnShowInFolder,
      transcriptView,
      t,
      truncatedNodeIds,
      userTextFacts,
    ],
  )

  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current
    const element = scrollRef.current
    if (
      anchor === undefined ||
      element === null ||
      props.loadingOlderHistory === true ||
      (virtualized.enabled && !virtualized.ready)
    )
      return
    let frame: number | undefined
    const release = (): void => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      element.removeEventListener('wheel', release)
      element.removeEventListener('pointerdown', release)
      element.removeEventListener('keydown', release)
      if (prependAnchorRef.current === anchor) prependAnchorRef.current = undefined
      if (restoredPrependAnchorRef.current === anchor) restoredPrependAnchorRef.current = undefined
    }
    if (restoredPrependAnchorRef.current !== anchor) {
      if (!restoreScrollAnchor(anchor)) {
        release()
        return
      }
      restoredPrependAnchorRef.current = anchor
    }
    // The virtual canvas can replace its initial estimated heights immediately
    // after the first restoration. Keep the same visible row in place while
    // that bounded measurement pass settles; any new reader gesture wins.
    const correct = (): boolean => {
      if (prependAnchorRef.current !== anchor || !isScrollAnchorCurrent(anchor)) {
        release()
        return false
      }
      if (anchor.nodeId === undefined || anchor.nodeOffset === undefined) return true
      const row = [...element.querySelectorAll<HTMLElement>('.dsh-timeline__row[data-node-id]')].find(
        (item) => item.dataset.nodeId === anchor.nodeId,
      )
      if (row !== undefined)
        applyScrollAdjustment(
          row.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.nodeOffset,
        )
      return true
    }
    if (!correct()) return
    let remaining = 8
    const settle = (): void => {
      if (!correct()) return
      if (--remaining > 0) frame = window.requestAnimationFrame(settle)
      else release()
    }
    frame = window.requestAnimationFrame(settle)
    element.addEventListener('wheel', release, { passive: true })
    element.addEventListener('pointerdown', release)
    element.addEventListener('keydown', release)
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      element.removeEventListener('wheel', release)
      element.removeEventListener('pointerdown', release)
      element.removeEventListener('keydown', release)
    }
  }, [
    applyScrollAdjustment,
    isScrollAnchorCurrent,
    props.loadingOlderHistory,
    props.nodes.length,
    restoreScrollAnchor,
    scrollRef,
    virtualized.enabled,
    virtualized.ready,
  ])

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
        id={activityRegionId}
        key={props.sessionId}
        ref={scrollRef}
        className="dsh-timeline"
        data-scroll-follow={isPinnedToBottom ? 'pinned' : 'free'}
        data-transcript-view={transcriptView}
        data-conversation-layout={conversationLayout}
        data-performance-usage={performanceUsage}
        data-coding-tools-enabled={codingToolsEnabled}
        role="region"
        aria-label={t('timeline.aria')}
        tabIndex={0}
        onKeyDown={handleTimelineScrollKeyDown}
        onScroll={handleScroll}
        onFocusCapture={(event) => {
          const element = event.target
          const row = element.closest<HTMLElement>('.dsh-timeline__row[data-node-id]')
          if (row?.dataset.nodeId === undefined) {
            presentationFocus.current = undefined
            return
          }
          presentationFocus.current = {
            element,
            sessionId: props.sessionId,
            rowId: row.dataset.nodeId,
            toolId: element.closest<HTMLElement>('[data-tool-call-id]')?.dataset.toolCallId,
          }
        }}
        onBlurCapture={(event) => {
          if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget))
            presentationFocus.current = undefined
        }}
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
                      <TimelineRow
                        node={node}
                        context={nodeRenderContext}
                        contentStatus={
                          presentedSourceNodeIds(node).some((id) => complete.pendingIds.has(id))
                            ? complete.failed
                              ? 'retrying'
                              : 'loading'
                            : undefined
                        }
                      />
                      {running && item.index === displayNodes.length - 1 ? (
                        <StreamingActivity
                          id={`turn:${props.activeTurn ?? latestNode?.id ?? props.sessionId}`}
                          usingTool={usingTool}
                          translate={t}
                        />
                      ) : null}
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
                    <TimelineRow
                      node={node}
                      context={nodeRenderContext}
                      contentStatus={
                        presentedSourceNodeIds(node).some((id) => complete.pendingIds.has(id))
                          ? complete.failed
                            ? 'retrying'
                            : 'loading'
                          : undefined
                      }
                    />
                  </div>
                ))}
          </div>
          {running &&
          (!virtualizedReady ||
            !virtualized.virtualItems.some((item) => item.index === displayNodes.length - 1)) ? (
            <StreamingActivity
              id={`turn:${props.activeTurn ?? latestNode?.id ?? props.sessionId}`}
              usingTool={usingTool}
              translate={t}
            />
          ) : null}
        </div>
        <TurnProgressAnnouncement sessionId={props.sessionId} running={running} translate={t} />
        {compactProjection.hidden === 0 ? null : (
          <button
            type="button"
            className="dsh-timeline__history-more-button dsh-timeline__activity-toggle"
            aria-expanded={allActivity}
            aria-controls={activityRegionId}
            onClick={() =>
              setActivityDisclosure({
                expanded: !allActivity,
                ...(revealKey === undefined ? {} : { dismissedReveal: revealKey }),
              })
            }
          >
            {allActivity ? t('timeline.activity.showRecent') : t('timeline.activity.showAll')}
          </button>
        )}
        {/* Mounted only while an outcome is up, like the per-row copy button. */}
        {copyFallbackAnnounced ? (
          <span className="dsh-sr-only" role="status">
            {t(copyFallbackAnnounced === 'copied' ? 'message.copied' : 'message.copyFailed')}
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

function timelineNodeKey(node: PresentedTimelineNode): string {
  return node.id
}
