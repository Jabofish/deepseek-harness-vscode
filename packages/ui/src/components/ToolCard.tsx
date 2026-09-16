import type { ReactElement } from 'react'
import type { ToolCallView } from '@dsh-vscode/domain'
import { formatToolText, toolPresentation, type PresentationTranslate } from '../tool-presentation.js'
import { toolStatusLabel } from '../tool-status.js'

export interface ToolCardProps {
  readonly tool: ToolCallView
  readonly expanded: boolean
  readonly onToggle: () => void
  /** Optional label translator supplied by the hosting surface (English default). */
  readonly translate?: PresentationTranslate
}

export function ToolCard(props: ToolCardProps): ReactElement {
  const presentation = toolPresentation(props.tool, props.translate)
  const request = presentation.request
  const response = presentation.response
  const hasDetails = request.length > 0 || response.length > 0 || props.tool.error !== undefined
  const expand = props.translate === undefined ? 'Expand' : props.translate('toolcard.expand')
  const collapse = props.translate === undefined ? 'Collapse' : props.translate('toolcard.collapse')
  const expandTitle =
    props.translate === undefined ? 'Expand tool details' : props.translate('toolcard.expandTitle')
  const collapseTitle =
    props.translate === undefined ? 'Collapse tool details' : props.translate('toolcard.collapseTitle')
  const errorLabel = props.translate === undefined ? 'Error' : props.translate('toolcard.error')
  return (
    <article className={`dsh-tool-card dsh-tool-card--${props.tool.status}`}>
      <button
        type="button"
        className="dsh-tool-card__summary"
        aria-expanded={props.expanded}
        aria-label={`${props.expanded ? collapse : expand} ${presentation.title} details`}
        title={props.expanded ? collapseTitle : expandTitle}
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
        <span
          className={`dsh-tool-card__heading${
            presentation.summary === undefined ? '' : ' dsh-tool-card__heading--with-summary'
          }`}
        >
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
          {toolStatusLabel(props.tool.status, props.translate)}
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
          {request.map((block, index) => (
            <section className="dsh-tool-card__section" key={`request:${block.label}:${index}`}>
              <h4>{block.label}</h4>
              <p>{block.content}</p>
            </section>
          ))}
          {response.map((block, index) => (
            <section className="dsh-tool-card__section" key={`response:${block.label}:${index}`}>
              <h4>{block.label}</h4>
              <p>{block.content}</p>
            </section>
          ))}
          {props.tool.error === undefined ? null : (
            <section className="dsh-tool-card__section dsh-tool-card__section--error" role="alert">
              <h4>{errorLabel}</h4>
              <p>{formatToolText(props.tool.error, props.translate) ?? props.tool.error.trim()}</p>
            </section>
          )}
        </div>
      ) : null}
    </article>
  )
}
