import type { ReactElement } from 'react'
import { ToolIcon } from '../tool-row-icons.js'
import type { ToolRowState, ToolRowVariant } from '../tool-row-model.js'

/** Native sibling buttons keep file navigation independent from row disclosure. */
export function FocusedToolSummary(props: {
  readonly title: string
  readonly summary: string
  readonly variant: ToolRowVariant
  readonly state: ToolRowState
  readonly status: string
  readonly expanded: boolean
  readonly hasDetails: boolean
  readonly detailsAria: string
  readonly contentId: string
  readonly onToggle: () => void
  readonly target?: { readonly href: string; readonly ariaLabel: string } | undefined
  readonly onOpenLink?: ((href: string) => void) | undefined
}): ReactElement {
  return (
    <div className="dsh-tool-row__summary dsh-tool-row__summary--focused">
      <button
        type="button"
        className="dsh-tool-row__toggle"
        aria-expanded={props.expanded && props.hasDetails}
        aria-controls={props.contentId}
        aria-label={props.detailsAria}
        disabled={!props.hasDetails}
        onClick={props.onToggle}
      />
      <span className="dsh-tool-row__icon" aria-hidden="true">
        <ToolIcon variant={props.variant} state={props.state} />
      </span>
      <span className="dsh-tool-row__title" aria-hidden="true">
        {props.title}
      </span>
      <span className="dsh-tool-row__separator" aria-hidden="true">
        ·
      </span>
      {props.target === undefined ? (
        <span className="dsh-tool-row__summary-text" aria-hidden="true" title={props.summary}>
          {props.summary}
        </span>
      ) : (
        <button
          type="button"
          className="dsh-tool-row__inline-target"
          aria-label={props.target.ariaLabel}
          title={props.target.href}
          onClick={() => {
            if (props.target !== undefined) props.onOpenLink?.(props.target.href)
          }}
        >
          {props.summary}
        </button>
      )}
      <span className="dsh-tool-row__status">{props.status}</span>
      <span
        className={`dsh-tool-row__chevron${props.expanded ? ' dsh-tool-row__chevron--expanded' : ''}`}
        aria-hidden="true"
      >
        {props.hasDetails ? (
          <svg viewBox="0 0 16 16" fill="none" focusable="false">
            <path d="m6 3 5 5-5 5" />
          </svg>
        ) : null}
      </span>
    </div>
  )
}
