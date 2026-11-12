import type { ConversationLayout } from '../../app/conversation-layout.js'
import { DEFAULT_ESTIMATED_ITEM_SIZE } from '../../components/common/index.js'
import type { PresentedTimelineNode } from './focused-timeline-projection.js'
import { assistantNodeInProgress } from './timeline-labels.js'
import { assistantBlocksFromAggregates, type DisplayTimelineNode } from './timeline-shared.js'

const MAX_ESTIMATED_MARKDOWN_HEIGHT = 4_000
// Fixed conservative wrap width prevents late ResizeObserver width updates
// from shifting every unmeasured historical row estimate when a later turn arrives.
const CONSERVATIVE_CHARS_PER_LINE = 84
const CONSERVATIVE_USER_CHARS_PER_LINE = 68

/**
 * Conservative height estimates keep unmeasured tail appends from over-growing
 * and shrinking `scrollHeight`, while estimating historical rows close enough to
 * prevent hundreds of pixels of jump when scrolling up into long history.
 */
function estimateMarkdownBodyHeight(markdown: string, charsPerLine: number): number {
  const trimmed = markdown.trimEnd()
  if (trimmed.length === 0) return 0
  if (trimmed.length < 40 && !trimmed.includes('\n')) return 0

  let visualLines = 0
  let fenceLines = 0
  let lineStart = 0
  while (lineStart <= trimmed.length) {
    const nextNewline = trimmed.indexOf('\n', lineStart)
    const lineEnd = nextNewline === -1 ? trimmed.length : nextNewline
    const lineLen = lineEnd - lineStart
    if (lineLen > 0) {
      visualLines += Math.ceil(lineLen / charsPerLine)
      if (lineLen >= 3 && trimmed.startsWith('```', lineStart)) fenceLines += 1
    }
    if (nextNewline === -1) break
    lineStart = nextNewline + 1
  }

  const extraLines = Math.max(0, visualLines - 1)
  const codeBlocks = Math.floor(fenceLines / 2)
  return Math.min(MAX_ESTIMATED_MARKDOWN_HEIGHT, extraLines * 16 + codeBlocks * 36)
}

function estimateAssistantLikeHeight(
  node:
    | Extract<DisplayTimelineNode, { readonly kind: 'assistant-message' }>
    | Extract<DisplayTimelineNode, { readonly kind: 'assistant-turn' }>,
  layout: ConversationLayout,
  charsPerLine: number,
): number {
  const inProgress = assistantNodeInProgress(node)
  const messageBlocks =
    node.kind === 'assistant-turn'
      ? (node.blocks.length === 0 ? assistantBlocksFromAggregates(node) : node.blocks).filter(
          (block) => block.kind === 'message',
        )
      : []
  const hasBody = node.markdown.trim() !== '' || messageBlocks.some((block) => block.markdown.trim() !== '')
  const actionsVisible =
    !inProgress && node.markdown.trim() !== '' && (node.turn === undefined || node.turnCompleted === true)
  let height = !hasBody
    ? layout === 'focused'
      ? 44
      : 58
    : actionsVisible
      ? layout === 'focused'
        ? 116
        : 114
      : layout === 'focused'
        ? 74
        : 82

  height += (node.images?.length ?? 0) * 80
  if (node.reasoning !== undefined) height += node.reasoning.streaming ? 48 : 32

  if (node.kind === 'assistant-turn') {
    if (node.tools.length > 0) height += 32
    for (const block of messageBlocks) {
      height += estimateMarkdownBodyHeight(block.markdown, charsPerLine)
    }
    return height
  }

  return height + estimateMarkdownBodyHeight(node.markdown, charsPerLine)
}

function computePresentedNodeHeight(node: PresentedTimelineNode, layout: ConversationLayout): number {
  switch (node.kind) {
    case 'user-message': {
      const base = layout === 'focused' ? 88 : 76
      const imagesHeight = (node.images?.length ?? 0) * 80
      const questionHeight = node.questionReply === undefined ? 0 : node.questionReply.questions.length * 40
      const textHeight =
        node.markdown.trim() === ''
          ? 0
          : estimateMarkdownBodyHeight(node.markdown, CONSERVATIVE_USER_CHARS_PER_LINE)
      return base + imagesHeight + questionHeight + textHeight
    }
    case 'assistant-message':
    case 'assistant-turn':
      return estimateAssistantLikeHeight(node, layout, CONSERVATIVE_CHARS_PER_LINE)
    case 'focused-turn': {
      const workCount = node.answer === undefined ? node.nodes.length : Math.max(0, node.nodes.length - 1)
      if (node.answer === undefined) {
        return node.foldable ? 44 : 80
      }
      return (
        estimateAssistantLikeHeight(node.answer, 'focused', CONSERVATIVE_CHARS_PER_LINE) +
        (workCount > 0 ? 32 : 0)
      )
    }
    case 'tool': {
      const base = node.tool.preparation !== undefined ? 84 : 36
      return base + (node.tool.images?.length ?? 0) * 80
    }
    case 'reasoning':
    case 'event-group':
    case 'compaction':
      return 36
    case 'retry':
    case 'notice':
    case 'turn-terminal':
    case 'command-input':
      return 40
    case 'deliverables':
    case 'goal':
    case 'todo':
    case 'workflow':
    case 'team':
      return 76
    default:
      return DEFAULT_ESTIMATED_ITEM_SIZE
  }
}

interface HeightCacheEntry {
  readonly layout: ConversationLayout
  readonly height: number
}

export function createTimelineHeightEstimator(): (
  node: PresentedTimelineNode,
  layout: ConversationLayout,
) => number {
  const cache = new WeakMap<object, HeightCacheEntry>()
  return (node, layout) => {
    const cached = cache.get(node)
    if (cached !== undefined && cached.layout === layout) return cached.height
    const height = computePresentedNodeHeight(node, layout)
    cache.set(node, { layout, height })
    return height
  }
}
