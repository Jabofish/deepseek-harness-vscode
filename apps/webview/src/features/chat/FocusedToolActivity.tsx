import { useEffect, useId, useState, type ReactElement } from 'react'
import { toolNameLabel } from '@dsh-vscode/ui'
import { terminalPresentationFailed } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'
import { ToolCallCollection, type ToolCallCollectionProps } from './ToolCallCollection.js'
import { SubmittedPlanCard } from './SubmittedPlanCard.js'
import { focusedPresentationPolicy } from './focused-presentation-policy.js'
import type { TranscriptViewMode } from '../../app/ui-preferences.js'
import type { ExpandedDetailsSetter } from './timeline-shared.js'
import { useQuietActivity } from '../../app/AccessibilityProvider.js'
import { QuietToolActivity } from './QuietToolActivity.js'

/** Inline group disclosure retains every tool result without a page submenu. */
export function FocusedToolActivity(
  props: Omit<ToolCallCollectionProps, 'onExpandedChange'> & {
    readonly onExpandedChange: ExpandedDetailsSetter
    readonly transcriptView: TranscriptViewMode
    readonly revealSourceNodeId?: string | undefined
    readonly revealRequestId?: string | undefined
  },
): ReactElement {
  const quiet = useQuietActivity()
  const revealIndex = props.tools.findIndex((tool) => tool.id === props.revealSourceNodeId)
  const groupId = `focused-tools:${props.tools[0]?.id}`
  const revealKey = props.revealRequestId ?? props.revealSourceNodeId
  const revealHandledId = `${groupId}:reveal:${revealKey}`
  const [disclosure, setDisclosure] = useState(() => ({
    reveal: revealKey,
    open: props.expanded.has(groupId) || (revealIndex >= 0 && !props.expanded.has(revealHandledId)),
  }))
  if (disclosure.reveal !== revealKey)
    setDisclosure({
      ...disclosure,
      reveal: revealKey,
      ...(revealIndex < 0 ? {} : { open: true }),
    })
  const revealToolId = props.tools[revealIndex]?.id
  const { onExpandedChange } = props
  const revealHandled = props.expanded.has(revealHandledId)
  useEffect(() => {
    if (revealToolId === undefined || revealHandled) return
    onExpandedChange((current) => new Set([...current, groupId, revealToolId, revealHandledId]))
  }, [groupId, revealHandled, revealHandledId, revealToolId, onExpandedChange])
  const { open } = disclosure
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
  const summaryLabel = `${summary}${policy.liveProcessDetail && names !== '' ? ` · ${names}` : ''}`
  const failureLabel =
    failed.length === 0
      ? undefined
      : props.translate('timeline.focused.failedTools', { count: failed.length })
  const visible = open || !policy.groupTools
  const plans = props.tools
    .filter((node) => node.tool.submittedPlan !== undefined)
    .map((node) => <SubmittedPlanCard key={node.id} tool={node.tool} onOpenLink={props.onOpenLink} />)
  const toolCards = (): ReactElement => (
    <ToolCallCollection
      {...props}
      grouped={false}
      tools={props.tools.map((node) => {
        const { submittedPlan: _plan, ...tool } = node.tool
        return _plan === undefined ? node : { ...node, tool }
      })}
    />
  )
  return (
    <div className="dsh-focused-tools">
      {plans}
      {quiet ? (
        <QuietToolActivity
          {...props}
          groupId={groupId}
          onExpandedChange={(next) => {
            const updated = typeof next === 'function' ? next(props.expanded) : next
            setDisclosure({ ...disclosure, open: updated.has(groupId) })
            onExpandedChange(next)
          }}
        >
          {toolCards()}
        </QuietToolActivity>
      ) : (
        <>
          <button
            type="button"
            className={`dsh-focused-tools__summary${failureLabel === undefined ? '' : ' dsh-focused-tools__summary--failed'}`}
            aria-expanded={visible}
            aria-controls={bodyId}
            aria-label={failureLabel === undefined ? undefined : `${summaryLabel} · ${failureLabel}`}
            title={failureLabel}
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
            <Icon name={failureLabel === undefined ? 'tool' : 'alert'} />
            <span>{summaryLabel}</span>
            {policy.groupTools ? <Icon name={open ? 'chevron-down' : 'chevron-right'} /> : null}
          </button>
          <div id={bodyId} hidden={!visible} className="dsh-focused-tools__body">
            {visible ? toolCards() : null}
          </div>
        </>
      )}
    </div>
  )
}
