import { useId, type ReactElement } from 'react'
import { toolNameLabel } from '@dsh-vscode/ui'
import { terminalPresentationFailed } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'
import { focusedPresentationPolicy } from './focused-presentation-policy.js'
import type { FocusedWorkNode } from './focused-timeline-projection.js'
import { timelineSourceNodeIds } from './timeline-inspector-target.js'
import type { TimelineNodeRenderContext } from './timeline-shared.js'
import type { ToolTimelineNode } from './ToolCallCollection.js'

/** Tool nodes a process member carries, whether standalone or inside an assistant step. */
function memberTools(member: FocusedWorkNode): readonly ToolTimelineNode[] {
  if (member.kind === 'tool') return [member]
  return member.kind === 'assistant-turn' ? member.tools : []
}

function failedTool(node: ToolTimelineNode): boolean {
  return (
    node.tool.status === 'failed' ||
    node.tool.error !== undefined ||
    node.tool.autoReviewDenial !== undefined ||
    terminalPresentationFailed(node.tool.presentation)
  )
}

/**
 * One run of thinking and tool steps between replies, behind a single header
 * (DSH ui-chat `stepGrouping: 'collapsed'`, used by Compact and Standard).
 * The header carries the live activity while the run is the turn's tail, and
 * a count summary once it is closed; the body opens only on request.
 */
export function FocusedProcessGroup(props: {
  readonly members: readonly FocusedWorkNode[]
  /** Whether this run is the still-running tail of an unfinished turn. */
  readonly live: boolean
  readonly context: TimelineNodeRenderContext
  readonly renderBody: () => readonly ReactElement[]
}): ReactElement {
  const { context, members } = props
  const { t } = context
  const bodyId = useId()
  const groupId = `focused-process:${members[0]?.id}`
  const policy = focusedPresentationPolicy(context.transcriptView)
  const revealed =
    context.revealSourceNodeId !== undefined &&
    members.some((member) => timelineSourceNodeIds(member).includes(context.revealSourceNodeId!))
  const open = revealed || context.expandedDetails.has(groupId)
  const tools = members.flatMap(memberTools)
  const executed = tools.filter((node) => node.tool.preparation === undefined)
  const thinking = members.filter(
    (member) => member.kind !== 'tool' && memberTools(member).length === 0,
  ).length
  const failed = tools.filter(failedTool).length
  const tail = members.at(-1)
  const tailTool = tail === undefined ? undefined : memberTools(tail).at(-1)
  let label: string
  if (props.live) {
    if (tailTool === undefined) label = t('timeline.focused.thinking')
    else if (tailTool.tool.preparation !== undefined) label = t('timeline.focused.preparing')
    else
      label = policy.liveProcessDetail
        ? `${t('timeline.focused.runningTool')} · ${toolNameLabel(tailTool.tool.name, t)}`
        : t('timeline.focused.runningTool')
  } else {
    const parts: string[] = []
    if (thinking > 0) parts.push(t('timeline.focused.thinkingCount', { count: thinking }))
    if (executed.length > 0) parts.push(t('timeline.focused.tools', { count: executed.length }))
    label = parts.length === 0 ? t('timeline.focused.process') : parts.join(' · ')
  }
  const failureLabel = failed === 0 ? undefined : t('timeline.focused.failedTools', { count: failed })
  return (
    <div className="dsh-focused-process" data-live={props.live || undefined}>
      <button
        type="button"
        className={`dsh-focused-tools__summary${failureLabel === undefined ? '' : ' dsh-focused-tools__summary--failed'}`}
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={failureLabel === undefined ? undefined : `${label} · ${failureLabel}`}
        title={failureLabel}
        onClick={() =>
          context.setExpandedDetails((current) => {
            const next = new Set(current)
            if (open) next.delete(groupId)
            else next.add(groupId)
            return next
          })
        }
      >
        <Icon name={failureLabel !== undefined ? 'alert' : tools.length === 0 ? 'sparkles' : 'tool'} />
        <span>{label}</span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
      </button>
      <div id={bodyId} hidden={!open} className="dsh-focused-process__body">
        {open ? props.renderBody() : null}
      </div>
    </div>
  )
}
