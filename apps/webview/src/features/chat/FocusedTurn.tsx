import { useId, type ReactElement } from 'react'
import { Icon } from '../../ui/Icon.js'
import { renderTimelineNode } from './timeline-renderers.js'
import { assistantBlocksFromAggregates, type TimelineNodeRenderContext } from './timeline-shared.js'
import type { FocusedAnswerNode, FocusedTurnNode } from './focused-timeline-projection.js'
import { focusedPresentationPolicy } from './focused-presentation-policy.js'
import { FocusedToolActivity } from './FocusedToolActivity.js'
import type { ToolTimelineNode } from './ToolCallCollection.js'
import { producedFilePaths, renderProducedFiles } from './timeline-produced-files.js'

export function FocusedTurn(props: {
  readonly node: FocusedTurnNode
  readonly context: TimelineNodeRenderContext
}): ReactElement {
  const { node, context } = props
  const processId = node.processId ?? node.id
  const bodyId = useId()
  const policy = focusedPresentationPolicy(context.transcriptView)
  const foldable = node.foldable && policy.foldCompletedTurns
  const work = node.nodes.filter((member) => member !== node.answer)
  let answer: FocusedAnswerNode | undefined = node.answer
  if (answer !== undefined) {
    if (answer.kind === 'assistant-turn') {
      const { reasoning, turnUsage, ...plain } = answer
      const blocks = answer.blocks.length === 0 ? assistantBlocksFromAggregates(answer) : answer.blocks
      const thinking = blocks.filter((block) => block.kind === 'reasoning')
      if (thinking.length > 0) {
        work.push({
          ...plain,
          ...(reasoning === undefined ? {} : { reasoning }),
          kind: 'assistant-turn',
          markdown: '',
          images: [],
          blocks: thinking,
        })
        answer = {
          ...plain,
          kind: 'assistant-turn',
          blocks: blocks.filter((block) => block.kind !== 'reasoning'),
          turnUsage,
        }
      }
    } else if (answer.reasoning !== undefined) {
      const { reasoning, turnUsage, ...plain } = answer
      work.push({ ...plain, markdown: '', images: [], reasoning })
      answer = { ...plain, turnUsage }
    }
  }
  const revealDismissedId = `${processId}:reveal-dismissed:${context.revealRequestId ?? context.revealSourceNodeId}`
  const revealed =
    context.revealSourceNodeId !== undefined &&
    node.sourceIds.includes(context.revealSourceNodeId) &&
    !context.expandedDetails.has(revealDismissedId)
  const collapsedId = `${processId}:collapsed`
  const open =
    revealed ||
    (!context.expandedDetails.has(collapsedId) && (!foldable || context.expandedDetails.has(processId)))
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
  const toggle = (): void =>
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
