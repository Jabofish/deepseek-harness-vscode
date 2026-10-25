import { useId, type ReactElement, type ReactNode } from 'react'
import { terminalPresentationFailed } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'
import type { ToolCallCollectionProps } from './ToolCallCollection.js'

/** Presentation only: keep every current tool available behind one disclosure. */
export function QuietToolActivity(
  props: ToolCallCollectionProps & {
    readonly groupId: string
    readonly children: ReactNode
  },
): ReactElement | null {
  const bodyId = useId()
  if (props.tools.length === 0) return null
  const running = props.tools.some(({ tool }) => tool.status === 'queued' || tool.status === 'running')
  const failed = props.tools.some(
    ({ tool }) =>
      tool.status === 'failed' ||
      tool.error !== undefined ||
      tool.autoReviewDenial !== undefined ||
      terminalPresentationFailed(tool.presentation),
  )
  const collapsedId = `${props.groupId}:collapsed`
  const visible =
    props.expanded.has(props.groupId) ||
    (!props.expanded.has(collapsedId) &&
      (!running || props.tools.some((tool) => props.expanded.has(tool.id))))
  return (
    <div className="dsh-focused-tools dsh-timeline__tool-collection" data-quiet-tools="true">
      <button
        type="button"
        className={`dsh-focused-tools__summary${failed ? ' dsh-focused-tools__summary--failed' : ''}`}
        aria-expanded={visible}
        aria-controls={bodyId}
        onClick={() => {
          props.onExpandedChange((current) => {
            const next = new Set(current)
            if (visible) {
              next.delete(props.groupId)
              next.add(collapsedId)
            } else {
              next.add(props.groupId)
              next.delete(collapsedId)
            }
            return next
          })
        }}
      >
        <Icon name={failed ? 'alert' : 'tool'} />
        <span>
          {props.translate(running ? 'timeline.quietTools.running' : 'timeline.quietTools.completed')}
        </span>
        <Icon name={visible ? 'chevron-down' : 'chevron-right'} />
      </button>
      {failed && !visible ? (
        <span className="dsh-focused-tools__failure" role="status">
          {props.translate('timeline.quietTools.failed')}
        </span>
      ) : null}
      <div id={bodyId} hidden={!visible} className="dsh-focused-tools__body">
        {visible ? props.children : null}
      </div>
    </div>
  )
}
