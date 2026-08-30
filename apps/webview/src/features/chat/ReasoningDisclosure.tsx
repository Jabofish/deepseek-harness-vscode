import type { ReactElement } from 'react'
import { ContentFlow } from '../../components/common/index.js'
import { Icon } from '../../ui/Icon.js'
import type { Translate } from '../../i18n.js'

export interface ReasoningDisclosureProps {
  readonly id: string
  readonly markdown: string
  readonly streaming: boolean
  readonly expanded: boolean
  readonly onExpandedChange: (expanded: boolean) => void
  readonly translate: Translate
}

/**
 * The conversation's low-priority reasoning surface. The Timeline owns the
 * expansion set, while this component owns the disclosure semantics, preview
 * policy, and compact visual contract.
 */
export function ReasoningDisclosure(props: ReasoningDisclosureProps): ReactElement | null {
  const content = props.markdown.trim()
  if (content === '') return null

  const preview = latestReasoningLines(content)
  const contentId = `${props.id}:content`
  const showPreview = props.expanded || (props.streaming && preview !== '')
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
          {!props.expanded && preview !== '' ? (
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
}

function latestReasoningLines(markdown: string): string {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n')
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop()
  const preview = lines.slice(-3).join('\n')
  return preview.trim() === '' ? '' : preview
}
