import { memo, type ReactElement } from 'react'
import type { MessageFeedbackItem } from '@dsh-vscode/domain'
import {
  assistantBlocksFromAggregates,
  assistantMessageId,
  type DisplayTimelineNode,
  type TimelineNodeRenderContext,
} from './timeline-shared.js'
import { renderTimelineNode } from './timeline-renderers.js'

export const TimelineRow = memo(
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
