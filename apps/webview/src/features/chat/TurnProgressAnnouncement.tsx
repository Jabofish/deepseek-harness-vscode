import { useState, type ReactElement } from 'react'
import type { Translate } from '../../i18n.js'

/** One persistent region; tool names, counts and token updates never feed it. */
export function TurnProgressAnnouncement(props: {
  readonly sessionId: string
  readonly running: boolean
  readonly translate: Translate
}): ReactElement {
  const [state, setState] = useState({ sessionId: props.sessionId, started: props.running })
  if (state.sessionId !== props.sessionId || (props.running && !state.started))
    setState({ sessionId: props.sessionId, started: props.running })
  return (
    <span className="dsh-sr-only" aria-live="polite" aria-atomic="true">
      {props.running
        ? props.translate('timeline.streaming')
        : state.started
          ? props.translate('timeline.responseFinished')
          : ''}
    </span>
  )
}
