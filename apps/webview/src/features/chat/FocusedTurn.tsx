import { useEffect, useId, useState, type ReactElement } from 'react'
import { Icon } from '../../ui/Icon.js'
import { renderTimelineNode } from './timeline-renderers.js'
import { assistantBlocksFromAggregates, type TimelineNodeRenderContext } from './timeline-shared.js'
import type { FocusedAnswerNode, FocusedTurnNode } from './focused-timeline-projection.js'
import { focusedPresentationPolicy } from './focused-presentation-policy.js'
import { FocusedToolActivity } from './FocusedToolActivity.js'
import type { ToolTimelineNode } from './ToolCallCollection.js'
import { producedFilePaths, renderProducedFiles } from './timeline-produced-files.js'

function splitAnswerThinking(candidate: FocusedAnswerNode): {
  readonly thinking: FocusedAnswerNode | undefined
  readonly answer: FocusedAnswerNode
} {
  if (candidate.kind === 'assistant-turn') {
    const { reasoning, turnUsage, ...plain } = candidate
    const blocks = candidate.blocks.length === 0 ? assistantBlocksFromAggregates(candidate) : candidate.blocks
    const thinking = blocks.filter((block) => block.kind === 'reasoning')
    if (thinking.length === 0) return { thinking: undefined, answer: candidate }
    return {
      thinking: stripReasoningStepMetadata({
        ...plain,
        ...(reasoning === undefined ? {} : { reasoning }),
        kind: 'assistant-turn',
        markdown: '',
        images: [],
        blocks: thinking,
      }),
      answer: {
        ...plain,
        kind: 'assistant-turn',
        blocks: blocks.filter((block) => block.kind !== 'reasoning'),
        turnUsage,
      },
    }
  }
  if (candidate.reasoning === undefined) return { thinking: undefined, answer: candidate }
  const { reasoning, turnUsage, ...plain } = candidate
  return {
    thinking: stripReasoningStepMetadata({ ...plain, markdown: '', images: [], reasoning }),
    answer: { ...plain, turnUsage },
  }
}

/** Keep step metrics off pure-reasoning and synthetic thinking cards so headers never pop in or vanish before the answer arrives. */
function stripReasoningStepMetadata(node: FocusedAnswerNode): FocusedAnswerNode {
  if (
    node.turn === undefined &&
    node.step === undefined &&
    node.timing === undefined &&
    node.usage === undefined &&
    node.turnUsage === undefined
  )
    return node
  const { turn, step, timing, usage, turnUsage, ...plain } = node
  void turn
  void step
  void timing
  void usage
  void turnUsage
  return plain
}

function hasAnswerBody(node: FocusedAnswerNode): boolean {
  if (node.markdown.trim() !== '' || (node.images?.length ?? 0) > 0) return true
  if (node.kind !== 'assistant-turn') return false
  const blocks = node.blocks.length === 0 ? assistantBlocksFromAggregates(node) : node.blocks
  return blocks.some(
    (block) => block.kind === 'message' && (block.markdown.trim() !== '' || (block.images?.length ?? 0) > 0),
  )
}

export function FocusedTurn(props: {
  readonly node: FocusedTurnNode
  readonly context: TimelineNodeRenderContext
}): ReactElement {
  const { node, context } = props
  const processId = node.processId ?? node.id
  const bodyId = useId()
  const policy = focusedPresentationPolicy(context.transcriptView)
  const foldable = node.foldable && policy.foldCompletedTurns
  const rawWork = node.nodes.filter((member) => member !== node.answer)
  let answer: FocusedAnswerNode | undefined = node.answer
  if (answer !== undefined) {
    const split = splitAnswerThinking(answer)
    if (split.thinking !== undefined) rawWork.push(split.thinking)
    answer = split.answer
  } else {
    const tail = rawWork.at(-1)
    if (
      tail !== undefined &&
      tail.kind !== 'tool' &&
      (tail.kind !== 'assistant-turn' || tail.tools.length === 0) &&
      hasAnswerBody(tail)
    ) {
      const split = splitAnswerThinking(tail)
      if (split.thinking !== undefined) {
        rawWork[rawWork.length - 1] = split.thinking
        answer = split.answer
      }
    }
  }
  const work = rawWork.map((member) =>
    member.kind !== 'tool' &&
    (member.kind !== 'assistant-turn' || member.tools.length === 0) &&
    !hasAnswerBody(member)
      ? stripReasoningStepMetadata(member)
      : member,
  )
  const revealDismissedId = `${processId}:reveal-dismissed:${context.revealRequestId ?? context.revealSourceNodeId}`
  const revealed =
    context.revealSourceNodeId !== undefined &&
    node.sourceIds.includes(context.revealSourceNodeId) &&
    !context.expandedDetails.has(revealDismissedId)
  const collapsedId = `${processId}:collapsed`
  const [liveWatchedProcessId, setLiveWatchedProcessId] = useState<string | undefined>(() =>
    !node.foldable && work.length > 0 && !context.expandedDetails.has(collapsedId) ? processId : undefined,
  )
  if (
    !node.foldable &&
    work.length > 0 &&
    liveWatchedProcessId !== processId &&
    !context.expandedDetails.has(collapsedId)
  ) {
    setLiveWatchedProcessId(processId)
  }
  const keepLiveOpen = liveWatchedProcessId === processId && work.length > 0
  const { expandedDetails, setExpandedDetails } = context
  useEffect(() => {
    if (!keepLiveOpen || !foldable || expandedDetails.has(collapsedId) || expandedDetails.has(processId)) {
      return
    }
    setExpandedDetails((current) => {
      if (current.has(collapsedId) || current.has(processId)) return current
      const next = new Set(current)
      next.add(processId)
      return next
    })
  }, [collapsedId, expandedDetails, foldable, keepLiveOpen, processId, setExpandedDetails])
  const open =
    revealed ||
    (!context.expandedDetails.has(collapsedId) &&
      (!foldable || keepLiveOpen || context.expandedDetails.has(processId)))
  const process: ReactElement[] = []
  if (open)
    for (let index = 0; index < work.length; index++) {
      const member = work[index]!
      if (member.kind !== 'tool') {
        process.push(
          <div key={member.id} data-source-node-id={member.id}>
            {renderTimelineNode(member, context)}
          </div>,
        )
        continue
      }
      const tools: ToolTimelineNode[] = [member]
      while (work[index + 1]?.kind === 'tool') {
        const next = work[index + 1]!
        if (next.kind !== 'tool') break
        tools.push(next)
        index++
      }
      process.push(
        <div key={member.id}>
          <FocusedToolActivity
            tools={tools}
            expanded={context.expandedDetails}
            onExpandedChange={context.setExpandedDetails}
            translate={context.t}
            transcriptView={context.transcriptView}
            revealSourceNodeId={context.revealSourceNodeId}
            revealRequestId={context.revealRequestId}
            {...(context.onOpenLink === undefined ? {} : { onOpenLink: context.requestOpenLink })}
            {...(context.onLoadImage === undefined ? {} : { onLoadImage: context.onLoadImage })}
          />
        </div>,
      )
    }
  const toggle = (): void => {
    if (open) setLiveWatchedProcessId(undefined)
    context.setExpandedDetails((current) => {
      const next = new Set(current)
      if (open) {
        next.delete(processId)
        next.add(collapsedId)
        if (revealed) next.add(revealDismissedId)
      } else {
        next.delete(collapsedId)
        next.add(processId)
      }
      return next
    })
  }
  return (
    <section className="dsh-focused-turn" data-turn={node.turn} data-process-foldable={foldable}>
      {work.length === 0 && !foldable ? null : (
        <>
          {node.continuation === true ? null : (
            <button
              type="button"
              className="dsh-focused-turn__summary"
              disabled={work.length === 0}
              aria-expanded={work.length === 0 ? undefined : open}
              aria-controls={bodyId}
              onClick={toggle}
            >
              <Icon name={foldable ? 'check' : 'status'} />
              <span>{context.t(foldable ? 'timeline.focused.completed' : 'timeline.focused.process')}</span>
              {work.length > 0 ? (
                <span className="dsh-focused-turn__count">
                  {context.t('timeline.focused.entries', { count: node.processCount ?? work.length })}
                </span>
              ) : null}
              {work.length > 0 ? <Icon name={open ? 'chevron-down' : 'chevron-right'} /> : null}
            </button>
          )}
          <div id={bodyId} hidden={!open} className="dsh-focused-turn__process">
            {process}
          </div>
        </>
      )}
      {answer === undefined ? null : (
        <div className="dsh-focused-turn__answer">{renderTimelineNode(answer, context)}</div>
      )}
      {renderProducedFiles(
        producedFilePaths(node.nodes.flatMap((member) => (member.kind === 'tool' ? [member] : []))),
        context.onOpenLink === undefined ? undefined : context.requestOpenLink,
        context.onShowInFolder,
        context.t,
      )}
    </section>
  )
}
