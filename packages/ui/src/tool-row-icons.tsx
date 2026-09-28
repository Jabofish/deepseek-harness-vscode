import type { ReactElement } from 'react'

import type { ToolRowState, ToolRowVariant } from './tool-row-model.js'

export function ToolIcon(props: {
  readonly variant: ToolRowVariant
  readonly state: ToolRowState
}): ReactElement {
  const path =
    props.variant === 'skill'
      ? 'M5 4.5h6l3 3v8H5zM11 4.5v3h3M8 11h3M8 13.5h3'
      : props.variant === 'bash' || props.variant === 'code'
        ? 'm5 7 4 4-4 4m5 0h5'
        : props.variant === 'search' || props.variant === 'web'
          ? 'm10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12m4.3 10.3 4 4'
          : props.variant === 'question'
            ? 'M8.5 8a3.5 3.5 0 1 1 5.8 2.7c-1.1.8-1.8 1.3-1.8 2.8M12.5 16h.01'
            : 'M5 5h14v14H5zM8 9h8M8 12h8M8 15h5'
  return (
    <svg viewBox="0 0 24 24" fill="none" focusable="false">
      <path d={path} />
      {props.state === 'running' ? <path d="M18 4v3m-1.5-1.5h3" /> : null}
    </svg>
  )
}
