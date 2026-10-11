import { useEffect, useId, useState, type ReactElement } from 'react'
import { toolNameLabel } from '@dsh-vscode/ui'
import { terminalPresentationFailed } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'
import { ToolCallCollection, type ToolCallCollectionProps } from './ToolCallCollection.js'
import { SubmittedPlanCard } from './SubmittedPlanCard.js'
import { focusedPresentationPolicy } from './focused-presentation-policy.js'
import type { TranscriptViewMode } from '../../app/ui-preferences.js'
import type { ExpandedDetailsSetter } from './timeline-shared.js'

const TOOL_PAGE_SIZE = 20

/** Quiet DSH-style summary; tool details mount only after an explicit disclosure. */
export function FocusedToolActivity(
  props: Omit<ToolCallCollectionProps, 'onExpandedChange'> & {
    readonly onExpandedChange: ExpandedDetailsSetter
    readonly transcriptView: TranscriptViewMode
    readonly revealSourceNodeId?: string | undefined
    readonly revealRequestId?: string | undefined
  },
): ReactElement {
  const revealIndex = props.tools.findIndex((tool) => tool.id === props.revealSourceNodeId)
  const groupId = `focused-tools:${props.tools[0]?.id}`
  const revealKey = props.revealRequestId ?? props.revealSourceNodeId
  const revealHandledId = `${groupId}:reveal:${revealKey}`
  const [disclosure, setDisclosure] = useState(() => ({
    reveal: revealKey,
    open: props.expanded.has(groupId) || (revealIndex >= 0 && !props.expanded.has(revealHandledId)),
    page: revealIndex < 0 ? 0 : Math.floor(revealIndex / TOOL_PAGE_SIZE),
  }))
  if (disclosure.reveal !== revealKey)
    setDisclosure({
      ...disclosure,
      reveal: revealKey,
      ...(revealIndex < 0 ? {} : { open: true, page: Math.floor(revealIndex / TOOL_PAGE_SIZE) }),
    })
  const revealToolId = props.tools[revealIndex]?.id
  const { onExpandedChange } = props
  const revealHandled = props.expanded.has(revealHandledId)
  useEffect(() => {
    if (revealToolId === undefined || revealHandled) return
    onExpandedChange((current) => new Set([...current, groupId, revealToolId, revealHandledId]))
  }, [groupId, revealHandled, revealHandledId, revealToolId, onExpandedChange])
  const { open, page } = disclosure
  const bodyId = useId()
  const policy = focusedPresentationPolicy(props.transcriptView)
  const executed = props.tools.filter((node) => node.tool.preparation === undefined)
  const latest = props.tools.at(-1)
  const failed = props.tools.filter(
    (node) =>
      node.tool.status === 'failed' ||
      node.tool.error !== undefined ||
      node.tool.autoReviewDenial !== undefined ||
      terminalPresentationFailed(node.tool.presentation),
  )
  const preparing = latest?.tool.preparation !== undefined
  const names = [...new Set(executed.map((node) => toolNameLabel(node.tool.name, props.translate)))]
    .slice(0, 3)
    .join(' · ')
  const summary = preparing
    ? props.translate('timeline.focused.preparing')
    : props.translate('timeline.focused.tools', { count: executed.length })
  const visible = open || !policy.groupTools
  const start = Math.min(
    page * TOOL_PAGE_SIZE,
    Math.max(0, Math.floor((props.tools.length - 1) / TOOL_PAGE_SIZE) * TOOL_PAGE_SIZE),
  )
  return (
    <div className="dsh-focused-tools">
      {props.tools
        .filter((node) => node.tool.submittedPlan !== undefined)
        .map((node) => (
          <SubmittedPlanCard key={node.id} tool={node.tool} onOpenLink={props.onOpenLink} />
        ))}
      <button
        type="button"
        className="dsh-focused-tools__summary"
        aria-expanded={visible}
        aria-controls={bodyId}
        disabled={!policy.groupTools}
        onClick={() => {
          setDisclosure({ ...disclosure, open: !open })
          props.onExpandedChange((current) => {
            const next = new Set(current)
            if (open) next.delete(groupId)
            else next.add(groupId)
            return next
          })
        }}
      >
        <Icon name="tool" />
        <span>
          {summary}
          {policy.liveProcessDetail && names !== '' ? ` · ${names}` : ''}
        </span>
        {policy.groupTools ? <Icon name={open ? 'chevron-down' : 'chevron-right'} /> : null}
      </button>
      {failed.length === 0 ? null : (
        <p className="dsh-focused-tools__failure" role="status">
          <Icon name="alert" />
          {props.translate('timeline.focused.failedTools', { count: failed.length })}
          {failed[0]?.tool.error === undefined ? null : <span>{failed[0].tool.error}</span>}
        </p>
      )}
      <div id={bodyId} hidden={!visible} className="dsh-focused-tools__body">
        {visible ? (
          <ToolCallCollection
            {...props}
            grouped={false}
            tools={props.tools.slice(start, start + TOOL_PAGE_SIZE).map((node) => {
              const { submittedPlan: _plan, ...tool } = node.tool
              return _plan === undefined ? node : { ...node, tool }
            })}
          />
        ) : null}
        {visible && props.tools.length > TOOL_PAGE_SIZE ? (
          <nav
            className="dsh-focused-tools__pages"
            aria-label={props.translate('timeline.focused.toolPages')}
          >
            <button
              type="button"
              disabled={start === 0}
              onClick={() => setDisclosure({ ...disclosure, page: Math.max(0, page - 1) })}
            >
              {props.translate('timeline.focused.previous')}
            </button>
            <span>
              {props.translate('timeline.focused.range', {
                start: start + 1,
                end: Math.min(start + TOOL_PAGE_SIZE, props.tools.length),
                total: props.tools.length,
              })}
            </span>
            <button
              type="button"
              disabled={start + TOOL_PAGE_SIZE >= props.tools.length}
              onClick={() => setDisclosure({ ...disclosure, page: page + 1 })}
            >
              {props.translate('timeline.focused.next')}
            </button>
          </nav>
        ) : null}
      </div>
    </div>
  )
}
