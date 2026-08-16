import type { ReactElement } from 'react'
import type { ToolCallView } from '@dsh-vscode/domain'

export interface ToolCardProps {
  readonly tool: ToolCallView
  readonly expanded: boolean
  readonly onToggle: () => void
}

export function ToolCard(props: ToolCardProps): ReactElement {
  const title = toolTitle(props.tool)
  const input = bounded(props.tool.inputSummary)
  const output = bounded(props.tool.outputSummary)
  return (
    <article className={`dsh-tool-card dsh-tool-card--${props.tool.status}`}>
      <button
        type="button"
        className="dsh-tool-card__summary"
        aria-expanded={props.expanded}
        aria-label={`${props.expanded ? 'Collapse' : 'Expand'} ${title} details`}
        title={`${props.expanded ? 'Collapse' : 'Expand'} tool details`}
        onClick={props.onToggle}
      >
        <span className="dsh-tool-card__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" focusable="false">
            <path d="m14.5 5.5 4-2 .5 4-2.2 1.4-4.8 4.8" />
            <path d="m11.8 13.2-3.7 3.7a2.1 2.1 0 1 1-3-3l3.7-3.7" />
            <path d="m12.2 6.2 5.6 5.6" />
          </svg>
        </span>
        <span className="dsh-tool-card__title" title={title}>
          {title}
        </span>
        <span className="dsh-tool-card__meta">
          {props.tool.category} · {props.tool.status}
        </span>
        <span
          className={`dsh-tool-card__disclosure${props.expanded ? ' dsh-tool-card__disclosure--expanded' : ''}`}
          aria-hidden="true"
        >
          <svg viewBox="0 0 16 16" fill="none" focusable="false">
            <path d="m6 3 5 5-5 5" />
          </svg>
        </span>
      </button>
      {props.expanded ? (
        <div className="dsh-tool-card__details">
          {input === undefined ? null : <pre aria-label="Tool input">{input}</pre>}
          {output === undefined ? null : <pre aria-label="Tool output">{output}</pre>}
          {props.tool.error === undefined ? null : <p role="alert">{bounded(props.tool.error)}</p>}
        </div>
      ) : null}
    </article>
  )
}

function toolTitle(tool: ToolCallView): string {
  const title = tool.title.trim()
  const name = tool.name.trim()
  if (title !== '' && title.toLowerCase() !== 'tool') return title
  return name || title || 'Tool'
}

function bounded(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined
  return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value
}
