import { useState, type ReactElement } from 'react'
import type { ToolCallView } from '@dsh-vscode/domain'
import { MarkdownContent } from './MarkdownContent.js'
import { CopyButton } from './CopyButton.js'
import { useI18n } from '../../i18n.js'

/** A durable artifact: independent of whether the review was accepted or dismissed. */
export function SubmittedPlanCard(props: {
  readonly tool: ToolCallView
  readonly onOpenLink?: ((href: string) => void) | undefined
}): ReactElement | null {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const plan = props.tool.submittedPlan
  if (plan === undefined) return null
  return (
    <details
      className="dsh-submitted-plan"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary title={plan.title}>
        {t('plans.submitted')}: {plan.title}
      </summary>
      {open ? (
        <div className="dsh-submitted-plan__body" tabIndex={0}>
          <CopyButton className="dsh-message-actions__button" text={plan.markdown} translate={t} />
          <MarkdownContent
            markdown={plan.markdown}
            {...(props.onOpenLink === undefined ? {} : { onOpenLink: props.onOpenLink })}
          />
        </div>
      ) : null}
    </details>
  )
}
