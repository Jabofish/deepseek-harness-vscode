import type { ReactElement } from 'react'
import { Icon } from '../../ui/Icon.js'

export interface ScrollToLatestButtonProps {
  readonly label: string
  readonly onClick: () => void
}

/**
 * Shared scroll affordance for every append-only surface. The parent shell
 * owns the position; this component owns the accessible action contract.
 */
export function ScrollToLatestButton(props: ScrollToLatestButtonProps): ReactElement {
  return (
    <button
      className="dsh-scroll-to-latest"
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
    >
      <span className="dsh-scroll-to-latest__content">
        <Icon name="arrow-down" />
        <span>{props.label}</span>
      </span>
    </button>
  )
}
