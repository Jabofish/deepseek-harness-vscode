import { memo, useCallback, type ReactElement } from 'react'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { ToolRendererRegistry, toolNameLabel, toolStatusLabel } from '@dsh-vscode/ui'
import { ContentFlow } from '../../components/common/index.js'
import { Icon } from '../../ui/Icon.js'
import type { Translate } from '../../i18n.js'

export type ToolTimelineNode = Extract<TimelineNode, { readonly kind: 'tool' }>

export interface ToolCallCollectionProps {
  readonly tools: readonly ToolTimelineNode[]
  readonly expanded: ReadonlySet<string>
  readonly onExpandedChange: (expanded: ReadonlySet<string>) => void
  readonly translate: Translate
  readonly onOpenLink?: (href: string) => void
}

const toolRendererRegistry = new ToolRendererRegistry()

/**
 * Keeps one tool and a contiguous batch on the same timeline contract. The
 * collection itself is intentionally small; details remain delegated to the
 * shared UI registry so specialized tool presentations stay reusable.
 */
export const ToolCallCollection = memo(function ToolCallCollection(
  props: ToolCallCollectionProps,
): ReactElement | null {
  if (props.tools.length === 0) return null

  if (props.tools.length === 1) {
    const tool = props.tools[0]
    return tool === undefined ? null : (
      <div className="dsh-timeline__tool-collection">{renderToolCard(tool, props)}</div>
    )
  }

  const latest = props.tools[props.tools.length - 1]
  if (latest === undefined) return null

  return (
    <details className="dsh-timeline__tool-group dsh-timeline__tool-collection">
      <summary
        className="dsh-timeline__tool-group-summary"
        aria-label={props.translate('timeline.showToolCalls', { count: props.tools.length })}
      >
        <span className="dsh-timeline__tool-group-icon" aria-hidden="true">
          <Icon name="tool" />
        </span>
        <span className="dsh-timeline__tool-group-count" aria-hidden="true">
          {props.tools.length}
        </span>
        <ContentFlow
          as="span"
          variant="truncate"
          className="dsh-timeline__tool-group-latest"
          title={toolSummary(latest.tool, props.translate)}
        >
          {toolSummary(latest.tool, props.translate)}
        </ContentFlow>
        <span className="dsh-timeline__tool-group-disclosure" aria-hidden="true">
          <Icon name="chevron-down" />
        </span>
      </summary>
      <div className="dsh-timeline__tool-group-list">
        {props.tools.map((toolNode) => (
          <div key={toolNode.id}>{renderToolCard(toolNode, props)}</div>
        ))}
      </div>
    </details>
  )
}, toolCollectionEqual)

function renderToolCard(node: ToolTimelineNode, props: ToolCallCollectionProps): ReactElement {
  return (
    <ToolCardView
      node={node}
      expanded={props.expanded}
      onExpandedChange={props.onExpandedChange}
      translate={props.translate}
      {...(props.onOpenLink === undefined ? {} : { onOpenLink: props.onOpenLink })}
    />
  )
}

interface ToolCardViewProps {
  readonly node: ToolTimelineNode
  readonly expanded: ReadonlySet<string>
  readonly onExpandedChange: (expanded: ReadonlySet<string>) => void
  readonly translate: Translate
  readonly onOpenLink?: (href: string) => void
}

const ToolCardView = memo(function ToolCardView(props: ToolCardViewProps): ReactElement {
  const { expanded: expandedKeys, node, onExpandedChange } = props
  const expanded = expandedKeys.has(node.id)
  const onToggle = useCallback((): void => {
    const next = new Set(expandedKeys)
    if (next.has(node.id)) next.delete(node.id)
    else next.add(node.id)
    onExpandedChange(next)
  }, [expandedKeys, node.id, onExpandedChange])

  return toolRendererRegistry.render(node.tool, {
    expanded,
    translate: props.translate,
    onToggle,
    ...(props.onOpenLink === undefined ? {} : { onOpenLink: props.onOpenLink }),
  })
}, toolCardViewEqual)

function toolCollectionEqual(previous: ToolCallCollectionProps, next: ToolCallCollectionProps): boolean {
  if (
    previous.onExpandedChange !== next.onExpandedChange ||
    previous.onOpenLink !== next.onOpenLink ||
    previous.translate !== next.translate ||
    previous.tools.length !== next.tools.length
  )
    return false
  for (let index = 0; index < previous.tools.length; index += 1)
    if (previous.tools[index] !== next.tools[index]) return false
  if (previous.expanded === next.expanded) return true
  for (const tool of next.tools)
    if (previous.expanded.has(tool.id) !== next.expanded.has(tool.id)) return false
  return true
}

function toolCardViewEqual(previous: ToolCardViewProps, next: ToolCardViewProps): boolean {
  return (
    previous.node === next.node &&
    previous.onExpandedChange === next.onExpandedChange &&
    previous.onOpenLink === next.onOpenLink &&
    previous.translate === next.translate &&
    previous.expanded.has(previous.node.id) === next.expanded.has(next.node.id)
  )
}

function toolSummary(tool: ToolTimelineNode['tool'], translate: Translate): string {
  const title = tool.title.trim()
  const name = tool.name.trim()
  const normalizedTitle = title.toLowerCase()
  const normalizedName = name.toLowerCase()
  const label =
    title !== '' && normalizedTitle !== 'tool' && normalizedTitle !== normalizedName
      ? title
      : (toolNameLabel(name, translate) ?? (name || title || translate('timeline.toolFallback')))
  const status = toolStatusLabel(tool.status, translate)
  return label === '' ? status : `${label} · ${status}`
}
