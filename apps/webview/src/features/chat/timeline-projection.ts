import {
  isInjectedUserMessage,
  type AssistantTiming,
  type TimelineNode,
  type TurnTokenUsage,
} from '@dsh-vscode/timeline'
import type { MessageImageReference, TokenUsage } from '@dsh-vscode/domain'
import {
  DEFAULT_VIRTUALIZATION_PAYLOAD_THRESHOLD,
  DEFAULT_VIRTUALIZATION_THRESHOLD,
} from '../../components/common/index.js'
import type { ToolTimelineNode } from './ToolCallCollection.js'
import type { TranscriptViewMode } from '../../app/ui-preferences.js'
import type { Translate } from '../../i18n.js'
import {
  assistantBlocksFromAggregates,
  type AssistantContentBlock,
  type AssistantTurnNode,
  type DisplayTimelineNode,
  type DshEventGroupNode,
  type DshEventNode,
  type ReasoningBlock,
  type UserTextFacts,
} from './timeline-shared.js'

interface VirtualizationCache {
  readonly sourceNodes: readonly DisplayTimelineNode[]
  readonly firstLargeNodeIndex: number
}

export function createVirtualizationProjector(): (
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

interface TimelineFacts {
  readonly hasActiveTool: boolean
}

interface TimelineFactsCache extends TimelineFacts {
  readonly sourceNodes: readonly TimelineNode[]
  readonly firstActiveToolIndex: number
}

export function createTimelineFactsProjector(): (
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
      return node.markdown.length
    case 'user-message':
      return (
        node.markdown.length +
        (node.questionReply?.questions.reduce(
          (total, question) => total + question.prompt.length + (question.header?.length ?? 0),
          0,
        ) ?? 0)
      )
    case 'compaction':
      return node.compaction.summary?.length ?? 0
    case 'event-group':
      return node.textSize
    default:
      return 0
  }
}

export function createDisplayNodeTextSizeProjector(): (node: DisplayTimelineNode) => number {
  const cache = new WeakMap<object, number>()
  return (node) => {
    const cached = cache.get(node)
    if (cached !== undefined) return cached
    const size = displayNodeTextSize(node)
    cache.set(node, size)
    return size
  }
}

export function createNodeSignatureProjector(): (node: DisplayTimelineNode | undefined) => string {
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
  if (node.kind === 'user-message')
    return `${node.id}:${node.questionReply?.callId ?? ''}:${node.questionReply?.questions.length ?? 0}:${node.markdown.length}`
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

const formattedEventPayloadCache = new WeakMap<object, string>()

export function formatEventPayload(value: unknown, t: Translate = (key) => key): string {
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

export function createDisplayNodeProjector(): (
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

/**
 * Streaming appends to the same nodes array identity every frame, and the
 * facts of user-authored rows rarely change with it. Returning the previous
 * map while the computed facts are equal keeps the render context identity
 * (and every memoized row that receives it) stable across those frames.
 */
export function createUserTextFactsProjector(): (
  nodes: readonly TimelineNode[],
) => ReadonlyMap<string, UserTextFacts> {
  let previous: ReadonlyMap<string, UserTextFacts> = new Map()
  return (nodes) => {
    const next = collectUserTextFacts(nodes)
    if (sameUserTextFacts(previous, next)) return previous
    previous = next
    return next
  }
}

function sameUserTextFacts(
  left: ReadonlyMap<string, UserTextFacts>,
  right: ReadonlyMap<string, UserTextFacts>,
): boolean {
  if (left.size !== right.size) return false
  for (const [id, facts] of right) {
    const known = left.get(id)
    if (known === undefined) return false
    if (
      known.sessionReferenceLabels.length !== facts.sessionReferenceLabels.length ||
      known.sessionReferenceLabels.some((label, index) => label !== facts.sessionReferenceLabels[index])
    )
      return false
  }
  return true
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
