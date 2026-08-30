import type { ReactElement, ReactNode } from 'react'
import { ContentFlow } from './ContentFlow.js'

export interface PresetCardProps {
  readonly title: ReactNode
  readonly description: ReactNode
  readonly id: ReactNode
  readonly tags?: ReactNode
  readonly reason?: ReactNode
  readonly footer: ReactNode
  readonly revealed?: ReactNode
  readonly mainLabel: string
  readonly mainTitle?: string
  readonly mainPressed?: boolean
  readonly mainDisabled?: boolean
  readonly onMainClick: () => void
  readonly className?: string | undefined
}

/**
 * A preset card keeps trust/status tags in the header while leaving every
 * piece of descriptive copy in a predictable left-aligned content column.
 */
export function PresetCard(props: PresetCardProps): ReactElement {
  return (
    <li
      className={`dsh-preset-card${props.className === undefined ? '' : ` ${props.className}`}`}
      data-component="preset-card"
    >
      <button
        className="dsh-preset-card__main"
        type="button"
        aria-pressed={props.mainPressed}
        disabled={props.mainDisabled}
        aria-label={props.mainLabel}
        {...(props.mainTitle === undefined ? {} : { title: props.mainTitle })}
        onClick={props.onMainClick}
      >
        <span className="dsh-preset-card__head">
          <ContentFlow as="span" className="dsh-preset-card__name">
            {props.title}
          </ContentFlow>
          {props.tags === undefined ? null : <span className="dsh-preset-card__tags">{props.tags}</span>}
        </span>
        <ContentFlow as="span" className="dsh-preset-card__description">
          {props.description}
        </ContentFlow>
        {props.reason === undefined ? null : (
          <ContentFlow as="span" className="dsh-preset-card__reason" role="alert">
            {props.reason}
          </ContentFlow>
        )}
        <ContentFlow as="code" variant="code" className="dsh-preset-card__id">
          {props.id}
        </ContentFlow>
      </button>
      <div className="dsh-preset-card__footer">{props.footer}</div>
      {props.revealed === undefined ? null : (
        <div className="dsh-preset-card__revealed">{props.revealed}</div>
      )}
    </li>
  )
}
