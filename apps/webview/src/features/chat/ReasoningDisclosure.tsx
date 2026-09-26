import { memo, type ReactElement } from 'react'
import { ContentFlow } from '../../components/common/index.js'
import { Icon } from '../../ui/Icon.js'
import type { Translate } from '../../i18n.js'

export interface ReasoningDisclosureProps {
  readonly id: string
  readonly markdown: string
  readonly streaming: boolean
  /** Compact transcript mode hides settled previews while keeping details inspectable. */
  readonly hideSettledPreview?: boolean
  readonly expanded: boolean
  readonly onExpandedChange: (expanded: boolean) => void
  readonly translate: Translate
}

/**
 * The conversation's low-priority reasoning surface. The Timeline owns the
 * expansion set, while this component owns the disclosure semantics, preview
 * policy, and compact visual contract.
 */
export const ReasoningDisclosure = memo(function ReasoningDisclosure(
  props: ReasoningDisclosureProps,
): ReactElement | null {
  const content = props.markdown.trim()
  if (content === '') return null

  const preview = latestReasoningLines(content)
  const contentId = `${props.id}:content`
  const showPreview = props.expanded || (props.streaming && preview !== '')
  const showCollapsedPreview = preview !== '' && (!props.hideSettledPreview || props.streaming)
  const toggle = (): void => props.onExpandedChange(!props.expanded)

  return (
    <section
      className={`dsh-timeline__reasoning-preview${props.expanded ? ' dsh-timeline__reasoning-preview--expanded' : ''}`}
      aria-live={props.streaming ? 'polite' : undefined}
      data-reasoning-id={props.id}
      data-open={props.expanded}
    >
      <button
        className="dsh-timeline__reasoning-toggle"
        type="button"
        aria-expanded={props.expanded}
        aria-controls={contentId}
        aria-label={
          props.expanded
            ? props.translate('timeline.hideReasoning')
            : props.translate('timeline.showReasoning')
        }
        onClick={toggle}
      >
        <span className="dsh-timeline__reasoning-icon" aria-hidden="true">
          <Icon name="sparkles" />
        </span>
        <span className="dsh-timeline__reasoning-heading">
          <strong>{props.translate('timeline.thinking')}</strong>
          {!props.expanded && showCollapsedPreview ? (
            <ContentFlow as="span" variant="truncate" className="dsh-timeline__reasoning-summary">
              {preview.replace(/\s+/gu, ' ')}
            </ContentFlow>
          ) : null}
        </span>
        {props.streaming ? <span className="dsh-timeline__streaming" aria-hidden="true" /> : null}
        <span className="dsh-timeline__disclosure" aria-hidden="true">
          <Icon name="chevron-down" />
        </span>
      </button>
      <div className="dsh-disclosure" data-open={props.expanded}>
        <div className="dsh-disclosure__inner">
          <ContentFlow
            id={contentId}
            as="div"
            variant="preserve-breaks"
            className="dsh-timeline__reasoning-preview-content"
            aria-hidden={!props.expanded}
          >
            {showPreview ? (props.expanded ? content : preview) : null}
          </ContentFlow>
        </div>
      </div>
    </section>
  )
})

function latestReasoningLines(markdown: string): string {
  let end = markdown.length
  while (end > 0) {
    const breakStart = previousLineBreakStart(markdown, end)
    const lineStart = breakStart < 0 ? 0 : lineStartAfterBreak(markdown, breakStart)
    if (markdown.slice(lineStart, end).trim() !== '') break
    end = breakStart < 0 ? 0 : breakStart
  }
  if (end === 0) return ''

  let start = 0
  let cursor = end
  for (let line = 0; line < 3; line += 1) {
    const breakStart = previousLineBreakStart(markdown, cursor)
    if (breakStart < 0) {
      start = 0
      break
    }
    start = lineStartAfterBreak(markdown, breakStart)
    cursor = breakStart
  }

  const preview = markdown.slice(start, end).replace(/\r\n?/gu, '\n')
  return preview.trim() === '' ? '' : preview
}

function previousLineBreakStart(value: string, before: number): number {
  const lineFeed = value.lastIndexOf('\n', before - 1)
  const carriageReturn = value.lastIndexOf('\r', before - 1)
  const index = Math.max(lineFeed, carriageReturn)
  if (index < 0) return -1
  return value[index] === '\n' && value[index - 1] === '\r' ? index - 1 : index
}

function lineStartAfterBreak(value: string, breakStart: number): number {
  return value[breakStart] === '\r' && value[breakStart + 1] === '\n' ? breakStart + 2 : breakStart + 1
}
