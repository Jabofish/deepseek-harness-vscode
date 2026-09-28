import { useState, type ReactElement } from 'react'
import {
  terminalPresentationFailed,
  type ToolCallView,
  type ToolLocationView,
  type ToolPresentationView,
} from '@dsh-vscode/domain'

import { formatToolText, type PresentationTranslate } from '../tool-presentation.js'
import { toolStatusLabel } from '../tool-status.js'
import {
  renderStructuredDetails,
  type ToolCodeRenderProps,
  type ToolDiffRenderProps,
  type ToolSearchRenderProps,
  type ToolTerminalRenderProps,
  type ToolWebRenderProps,
} from '../tool-row-cards.js'
import { ToolIcon } from '../tool-row-icons.js'
import { toolRowModel } from '../tool-row-model.js'
import { removeDuplicateErrorPresentation } from '../tool-row-sections.js'
import { label } from '../tool-row-text.js'

export type { ToolRowVariant, ToolRowState, ToolRowModel } from '../tool-row-model.js'
export { classifyTool, isSpecializedTool, toolRowModel } from '../tool-row-model.js'
export type {
  ToolCodeRenderProps,
  ToolDiffRenderProps,
  ToolTerminalRenderProps,
  ToolSearchRenderProps,
  ToolWebRenderProps,
} from '../tool-row-cards.js'

export interface ToolRowProps {
  readonly tool: ToolCallView
  /** Controlled when supplied; registry consumers may omit both for local disclosure state. */
  readonly expanded?: boolean
  readonly onToggle?: () => void
  /** Host-owned link opener for files and web sources; the UI never fetches. */
  readonly onOpenLink?: (href: string) => void
  /** Optional label translator supplied by the hosting surface. */
  readonly translate?: PresentationTranslate
  /** Optional host-surface code renderer for structured read cards. */
  readonly renderCode?: (props: ToolCodeRenderProps) => ReactElement
  /** Optional host-surface renderer for structured diff cards. */
  readonly renderDiff?: (props: ToolDiffRenderProps) => ReactElement
  /** Optional host-surface renderer for structured terminal result cards. */
  readonly renderTerminal?: (props: ToolTerminalRenderProps) => ReactElement
  /** Optional host-surface renderer for structured search result cards. */
  readonly renderSearch?: (props: ToolSearchRenderProps) => ReactElement
  /** Optional host-surface renderer for structured web result cards. */
  readonly renderWeb?: (props: ToolWebRenderProps) => ReactElement
}

export function ToolRow(props: ToolRowProps): ReactElement {
  const [localExpanded, setLocalExpanded] = useState(false)
  const expanded = props.expanded ?? localExpanded
  const onToggle = props.onToggle ?? (() => setLocalExpanded((current) => !current))
  const model = toolRowModel(props.tool, props.translate)
  const hasDetails =
    model.sections.length > 0 || props.tool.error !== undefined || model.autoReviewOutput !== undefined
  const status = toolStatusLabel(
    props.tool.autoReviewDenial !== undefined || terminalPresentationFailed(props.tool.presentation)
      ? 'failed'
      : props.tool.status,
    props.translate,
  )
  const summary = model.errorSummary ?? model.summary
  // The accessible name is a formatted sentence per locale, never an
  // English "details" fragment glued onto a localized verb.
  const detailsAria = expanded
    ? label(props.translate, 'toolrow.collapseDetailsAria', `Collapse ${model.title} details`, {
        title: model.title,
      })
    : label(props.translate, 'toolrow.expandDetailsAria', `Expand ${model.title} details`, {
        title: model.title,
      })
  const targets =
    props.onOpenLink === undefined
      ? []
      : presentationTargets(props.tool.presentation, props.renderWeb !== undefined, props.tool.locations)
  const detailsPresentation = removeDuplicateErrorPresentation(
    props.tool.presentation,
    props.tool.error,
    props.translate,
  )
  const collapsedFetchUrl =
    !expanded &&
    props.onOpenLink !== undefined &&
    props.tool.presentation?.phase === 'result' &&
    props.tool.presentation.card === 'web' &&
    props.tool.presentation.kind === 'fetch'
      ? props.tool.presentation.url
      : undefined
  return (
    <article
      className={`dsh-tool-row dsh-tool-row--${model.state}`}
      data-tool={props.tool.name}
      data-variant={model.variant}
      data-state={model.state}
    >
      <button
        type="button"
        className="dsh-tool-row__summary"
        aria-expanded={expanded && hasDetails}
        aria-label={detailsAria}
        title={detailsAria}
        onClick={onToggle}
        disabled={!hasDetails}
      >
        <span className="dsh-tool-row__icon" aria-hidden="true">
          <ToolIcon variant={model.variant} state={model.state} />
        </span>
        <span className="dsh-tool-row__title">{model.title}</span>
        <span className="dsh-tool-row__separator" aria-hidden="true">
          ·
        </span>
        <span
          className={`dsh-tool-row__summary-text${model.errorSummary === undefined ? '' : ' dsh-tool-row__summary-text--error'}`}
        >
          {summary}
        </span>
        <span className="dsh-tool-row__status">{status}</span>
        {hasDetails ? (
          <span
            className={`dsh-tool-row__chevron${expanded ? ' dsh-tool-row__chevron--expanded' : ''}`}
            aria-hidden="true"
          >
            <svg viewBox="0 0 16 16" fill="none" focusable="false">
              <path d="m6 3 5 5-5 5" />
            </svg>
          </span>
        ) : null}
      </button>
      {collapsedFetchUrl === undefined ? null : (
        <button
          className="dsh-tool-row__collapsed-link"
          type="button"
          title={collapsedFetchUrl}
          aria-label={`${label(props.translate, 'toolrow.fetch.open', 'Open fetched page')} ${collapsedFetchUrl}`}
          onClick={() => props.onOpenLink?.(collapsedFetchUrl)}
        >
          {collapsedFetchUrl}
        </button>
      )}
      {expanded && hasDetails ? (
        <div className="dsh-tool-row__details">
          {model.autoReviewOutput === undefined ? (
            <>
              {renderStructuredDetails(
                detailsPresentation,
                model.sections,
                props.translate,
                props.onOpenLink,
                props.renderCode,
                props.renderDiff,
                props.renderTerminal,
                props.renderSearch,
                props.renderWeb,
                searchRecovery(props.tool),
              )}
              {props.onOpenLink === undefined || targets.length === 0 ? null : (
                <div
                  className="dsh-tool-row__targets"
                  aria-label={label(props.translate, 'toolrow.presentation.open', 'Open')}
                >
                  {targets.map((target) => (
                    <button
                      key={`${target.href}:${target.label}`}
                      type="button"
                      className="dsh-tool-row__target"
                      title={target.href}
                      onClick={() => props.onOpenLink?.(target.href)}
                    >
                      <span>{target.label}</span>
                    </button>
                  ))}
                </div>
              )}
              {props.tool.error === undefined ? null : (
                <section className="dsh-tool-row__section dsh-tool-row__section--error" role="alert">
                  <h4>{label(props.translate, 'toolrow.error', 'Error')}</h4>
                  <pre>{formatToolText(props.tool.error, props.translate) ?? props.tool.error.trim()}</pre>
                </section>
              )}
            </>
          ) : (
            <section className="dsh-tool-row__section dsh-tool-row__section--error" role="alert">
              <h4>{label(props.translate, 'toolrow.autoReview.rejected', 'Rejected by Auto review')}</h4>
              <pre>{model.autoReviewOutput}</pre>
            </section>
          )}
        </div>
      ) : null}
    </article>
  )
}

interface ToolPresentationTarget {
  readonly href: string
  readonly label: string
}

function presentationTargets(
  view: ToolPresentationView | undefined,
  hasWebRenderer = false,
  locations: readonly ToolLocationView[] | undefined = undefined,
): readonly ToolPresentationTarget[] {
  const targets: ToolPresentationTarget[] = []
  const add = (href: string | undefined, labelText: string): void => {
    const value = href?.trim()
    if (value === undefined || value === '' || targets.some((target) => target.href === value)) return
    targets.push({ href: value, label: labelText })
  }
  for (const location of locations ?? []) add(location.path, location.path)
  if (view === undefined) return targets.slice(0, 16)
  switch (view.card) {
    case 'generic':
      if (view.phase === 'call')
        for (const location of view.locations ?? []) add(location.path, location.path)
      break
    case 'diff':
      for (const location of view.phase === 'call' ? (view.locations ?? []) : [])
        add(location.path, location.path)
      for (const diff of view.diffs) add(diff.path, diff.path)
      break
    case 'read':
      add(view.path, `${view.path}:${view.offset}`)
      break
    case 'web':
      if (view.kind === 'fetch' && !hasWebRenderer) add(view.url, view.url)
      // Web search already renders each source, including its openable URL,
      // inside the specialized sources section. Adding the generic target
      // list here would render the same sources a second time.
      break
    default:
      break
  }
  return targets.slice(0, 16)
}

/**
 * The settled result text a capped search card replaced. A capped `grep`/`glob`
 * result keeps its rows and its `Full … stored at <locator>` footer in this text
 * only, so a card that took over the details surface has to hand it back.
 */
function searchRecovery(tool: ToolCallView): string | undefined {
  const view = tool.presentation
  if (view === undefined || view.card !== 'search' || view.phase !== 'result' || !view.truncated)
    return undefined
  const text = tool.outputSummary
  return text === undefined || text.trim() === '' ? undefined : text
}
