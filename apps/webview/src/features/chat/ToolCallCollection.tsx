import { memo, useCallback, type ReactElement } from 'react'
import { terminalPresentationFailed } from '@dsh-vscode/domain'
import { projectToolCallTree, type TimelineNode, type ToolCallTreeNode } from '@dsh-vscode/timeline'
import {
  ToolRendererRegistry,
  toolNameLabel,
  toolStatusLabel,
  type ToolCodeRenderProps,
  type ToolDiffRenderProps,
  type ToolSearchRenderProps,
  type ToolTerminalRenderProps,
  type ToolWebRenderProps,
} from '@dsh-vscode/ui'
import { ContentFlow } from '../../components/common/index.js'
import { Icon } from '../../ui/Icon.js'
import type { Translate } from '../../i18n.js'
import { ToolCodePreview } from './ToolCodePreview.js'
import { ToolDiffPreview } from './ToolDiffPreview.js'
import { ToolSearchPreview } from './ToolSearchPreview.js'
import { ToolTerminalPreview } from './ToolTerminalPreview.js'
import { ToolWebPreview } from './ToolWebPreview.js'

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
  const roots = projectToolCallTree(props.tools)

  if (roots.length === 1) {
    const root = roots[0]
    return root === undefined ? null : (
      <div className="dsh-timeline__tool-collection">{renderToolCard(root, props)}</div>
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
        {roots.map((root) => (
          <div key={root.node.id}>{renderToolCard(root, props)}</div>
        ))}
      </div>
    </details>
  )
}, toolCollectionEqual)

function renderToolCard(tree: ToolCallTreeNode, props: ToolCallCollectionProps): ReactElement {
  return (
    <ToolCardView
      tree={tree}
      expanded={props.expanded}
      onExpandedChange={props.onExpandedChange}
      translate={props.translate}
      {...(props.onOpenLink === undefined ? {} : { onOpenLink: props.onOpenLink })}
    />
  )
}

interface ToolCardViewProps {
  readonly tree: ToolCallTreeNode
  readonly expanded: ReadonlySet<string>
  readonly onExpandedChange: (expanded: ReadonlySet<string>) => void
  readonly translate: Translate
  readonly onOpenLink?: (href: string) => void
}

const ToolCardView = memo(function ToolCardView(props: ToolCardViewProps): ReactElement {
  const { expanded: expandedKeys, tree, onExpandedChange } = props
  const node = tree.node
  const expanded = expandedKeys.has(node.id)
  const onToggle = useCallback((): void => {
    const next = new Set(expandedKeys)
    if (next.has(node.id)) next.delete(node.id)
    else next.add(node.id)
    onExpandedChange(next)
  }, [expandedKeys, node.id, onExpandedChange])

  return (
    <div className="dsh-timeline__tool-call" data-tool-call-id={node.id}>
      {toolRendererRegistry.render(node.tool, {
        expanded,
        translate: props.translate,
        onToggle,
        renderCode: renderToolCode,
        renderDiff: renderToolDiff,
        renderTerminal: renderToolTerminal,
        renderSearch: renderToolSearch,
        renderWeb: renderToolWeb,
        ...(props.onOpenLink === undefined ? {} : { onOpenLink: props.onOpenLink }),
      })}
      {tree.children.length === 0 ? null : (
        <div
          className="dsh-timeline__tool-subcalls"
          data-subcalls="true"
          role="group"
          aria-label={props.translate('timeline.toolSubcalls')}
        >
          {tree.children.map((child) => (
            <ToolCardView
              key={child.node.id}
              tree={child}
              expanded={expandedKeys}
              onExpandedChange={onExpandedChange}
              translate={props.translate}
              {...(props.onOpenLink === undefined ? {} : { onOpenLink: props.onOpenLink })}
            />
          ))}
        </div>
      )}
    </div>
  )
}, toolCardViewEqual)

function renderToolCode(props: ToolCodeRenderProps): ReactElement {
  return <ToolCodePreview {...props} />
}

function renderToolDiff(props: ToolDiffRenderProps): ReactElement {
  return <ToolDiffPreview {...props} />
}

function renderToolTerminal(props: ToolTerminalRenderProps): ReactElement {
  return <ToolTerminalPreview {...props} />
}

function renderToolSearch(props: ToolSearchRenderProps): ReactElement {
  return <ToolSearchPreview {...props} />
}

function renderToolWeb(props: ToolWebRenderProps): ReactElement {
  return <ToolWebPreview {...props} />
}

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
    previous.tree.node === next.tree.node &&
    previous.tree.children === next.tree.children &&
    previous.onExpandedChange === next.onExpandedChange &&
    previous.onOpenLink === next.onOpenLink &&
    previous.translate === next.translate &&
    expandedTreeEqual(previous.tree, previous.expanded, next.expanded)
  )
}

function expandedTreeEqual(
  tree: ToolCallTreeNode,
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>,
): boolean {
  if (previous.has(tree.node.id) !== next.has(tree.node.id)) return false
  return tree.children.every((child) => expandedTreeEqual(child, previous, next))
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
  const status = toolStatusLabel(
    terminalPresentationFailed(tool.presentation) ? 'failed' : tool.status,
    translate,
  )
  return label === '' ? status : `${label} · ${status}`
}
