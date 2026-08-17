import type { ReactElement } from 'react'
import type { ToolCallView } from '@dsh-vscode/domain'
import { toolPresentation } from '../tool-presentation.js'

export interface ToolCardProps {
  readonly tool: ToolCallView
  readonly expanded: boolean
  readonly onToggle: () => void
}

export function ToolCard(props: ToolCardProps): ReactElement {
  const presentation = toolPresentation(props.tool)
  const hasDetails =
    presentation.request.length > 0 || presentation.response.length > 0 || props.tool.error !== undefined
  return (
    <article className={`dsh-tool-card dsh-tool-card--${props.tool.status}`}>
      <button
        type="button"
        className="dsh-tool-card__summary"
        aria-expanded={props.expanded}
        aria-label={`${props.expanded ? 'Collapse' : 'Expand'} ${presentation.title} details`}
        title={`${props.expanded ? 'Collapse' : 'Expand'} tool details`}
        onClick={props.onToggle}
        disabled={!hasDetails}
      >
        <span className="dsh-tool-card__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" focusable="false">
            <path d="m14.5 5.5 4-2 .5 4-2.2 1.4-4.8 4.8" />
            <path d="m11.8 13.2-3.7 3.7a2.1 2.1 0 1 1-3-3l3.7-3.7" />
            <path d="m12.2 6.2 5.6 5.6" />
          </svg>
        </span>
        <span className="dsh-tool-card__heading">
          <span className="dsh-tool-card__title" title={presentation.title}>
            {presentation.title}
          </span>
          {presentation.summary === undefined ? null : (
            <span className="dsh-tool-card__subtitle" title={presentation.summary}>
              {presentation.summary}
            </span>
          )}
        </span>
        <span className={`dsh-tool-card__status dsh-tool-card__status--${props.tool.status}`}>
          {statusLabel(props.tool.status)}
        </span>
        {hasDetails ? (
          <span
            className={`dsh-tool-card__disclosure${props.expanded ? ' dsh-tool-card__disclosure--expanded' : ''}`}
            aria-hidden="true"
          >
            <svg viewBox="0 0 16 16" fill="none" focusable="false">
              <path d="m6 3 5 5-5 5" />
            </svg>
          </span>
        ) : null}
      </button>
      {props.expanded && hasDetails ? (
        <div className="dsh-tool-card__details">
          {presentation.request.map((block, index) => (
            <section className="dsh-tool-card__section" key={`request:${block.label}:${index}`}>
              <h4>{block.label}</h4>
              <p>{block.content}</p>
            </section>
          ))}
          {presentation.response.map((block, index) => (
            <section className="dsh-tool-card__section" key={`response:${block.label}:${index}`}>
              <h4>{block.label}</h4>
              <p>{block.content}</p>
            </section>
          ))}
          {props.tool.error === undefined ? null : (
            <section className="dsh-tool-card__section dsh-tool-card__section--error" role="alert">
              <h4>Error</h4>
              <p>{bounded(props.tool.error)}</p>
            </section>
          )}
        </div>
      ) : null}
    </article>
  )
}

function statusLabel(status: ToolCallView['status']): string {
  switch (status) {
    case 'queued':
      return 'Queued'
    case 'running':
      return 'Running'
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
  }
}

function bounded(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined
  return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value
}
