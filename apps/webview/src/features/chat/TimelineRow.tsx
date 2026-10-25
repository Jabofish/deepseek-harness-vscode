import { memo, type ReactElement } from 'react'
import type { MessageFeedbackItem } from '@dsh-vscode/domain'
import {
  assistantBlocksFromAggregates,
  assistantMessageId,
  type DisplayTimelineNode,
  type TimelineNodeRenderContext,
} from './timeline-shared.js'
import { renderTimelineNode } from './timeline-renderers.js'
import { FocusedTurn } from './FocusedTurn.js'
import type { PresentedTimelineNode } from './focused-timeline-projection.js'

export const TimelineRow = memo(
  function TimelineRow(props: {
    readonly node: PresentedTimelineNode
    readonly context: TimelineNodeRenderContext
    readonly contentStatus?: 'loading' | 'retrying' | undefined
  }): ReactElement {
    return (
      <>
        {props.contentStatus === undefined ? null : (
          <p role={props.contentStatus === 'retrying' ? 'alert' : 'status'}>
            {props.context.t(
              props.contentStatus === 'retrying' ? 'transcript.syncRetrying' : 'transcript.syncLoading',
            )}
          </p>
        )}
        {props.node.kind === 'focused-turn' ? (
          <FocusedTurn node={props.node} context={props.context} />
        ) : (
          renderTimelineNode(props.node, props.context)
        )}
      </>
    )
  },
  (previous, next) =>
    previous.node === next.node &&
    previous.contentStatus === next.contentStatus &&
    timelineRowContextEqual(previous.node, previous.context, next.context),
)

function timelineRowContextEqual(
  node: PresentedTimelineNode,
  previous: TimelineNodeRenderContext,
  next: TimelineNodeRenderContext,
): boolean {
  if (previous === next) return true
  if (
    previous.conversationLayout !== next.conversationLayout ||
    previous.revealSourceNodeId !== next.revealSourceNodeId ||
    previous.revealRequestId !== next.revealRequestId
  )
    return false
  if (node.kind === 'focused-turn') return previous === next
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
    previous.truncatedNodeIds !== next.truncatedNodeIds ||
    previous.loadFullContent !== next.loadFullContent ||
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
  const checkTool = (id: string): boolean => {
    if (!check(id)) return false
    for (const prefix of ['quiet-tools', 'focused-tools']) {
      const groupId = `${prefix}:${id}`
      if (!check(groupId) || !check(`${groupId}:collapsed`)) return false
    }
    return true
  }
  switch (node.kind) {
    case 'tool':
      return checkTool(node.id)
    case 'assistant-message':
      return node.reasoning === undefined || check(`reasoning:${node.id}`)
    case 'reasoning':
      return check(`reasoning:assistant-turn:${node.id}:${node.id}`)
    case 'assistant-turn': {
      const blocks = node.blocks.length === 0 ? assistantBlocksFromAggregates(node) : node.blocks
      for (const block of blocks) {
        if (block.kind === 'tool' ? !checkTool(block.node.id) : !check(`reasoning:${node.id}:${block.id}`))
          return false
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
