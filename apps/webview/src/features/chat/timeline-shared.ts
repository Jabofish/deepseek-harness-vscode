import type { AssistantTiming, TimelineNode, TurnTokenUsage } from '@dsh-vscode/timeline'
import type {
  FeedbackCategory,
  MessageFeedbackItem,
  MessageFeedbackRating,
  MessageImageReference,
  TokenUsage,
} from '@dsh-vscode/domain'
import type { ToolTimelineNode } from './ToolCallCollection.js'
import type { PerformanceUsageMode, TranscriptViewMode } from '../../app/ui-preferences.js'
import type { Translate } from '../../i18n.js'

export type FeedbackSubmit = (
  messageId: string,
  rating: MessageFeedbackRating,
  note: string | undefined,
  category: FeedbackCategory | undefined,
) => Promise<void> | void

export type FeedbackPrepare = (
  messageId: string,
) => Promise<MessageFeedbackItem | undefined> | MessageFeedbackItem | undefined

export type DshEventNode = Extract<TimelineNode, { readonly kind: 'event' }>

export interface DshEventGroupNode {
  readonly kind: 'event-group'
  readonly id: string
  readonly events: readonly DshEventNode[]
  readonly textSize: number
}

export interface ReasoningBlock {
  readonly kind: 'reasoning'
  readonly id: string
  readonly markdown: string
  readonly streaming: boolean
}

export interface MessageBlock {
  readonly kind: 'message'
  readonly id: string
  readonly markdown: string
  readonly streaming: boolean
  readonly images?: readonly MessageImageReference[]
}

export interface ToolBlock {
  readonly kind: 'tool'
  readonly node: ToolTimelineNode
}

export type AssistantContentBlock = ReasoningBlock | MessageBlock | ToolBlock

export interface UserTextFacts {
  readonly sessionReferenceLabels: readonly string[]
}

export interface AssistantTurnNode {
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

export type DisplayTimelineNode =
  | Exclude<TimelineNode, DshEventNode | ToolTimelineNode>
  | ToolTimelineNode
  | DshEventGroupNode
  | AssistantTurnNode

export type ExpandedDetailsSetter = (
  next: ReadonlySet<string> | ((current: ReadonlySet<string>) => ReadonlySet<string>),
) => void

export interface TimelineNodeRenderContext {
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

export function assistantBlocksFromAggregates(node: AssistantTurnNode): readonly AssistantContentBlock[] {
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

export function assistantMessageId(node: AssistantTurnNode): string | undefined {
  if (!node.id.startsWith('assistant-turn:')) return undefined
  let id = node.id
  while (id.startsWith('assistant-turn:')) id = id.slice('assistant-turn:'.length)
  return id === '' ? undefined : id
}
