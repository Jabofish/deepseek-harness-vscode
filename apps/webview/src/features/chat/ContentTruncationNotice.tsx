import { useState, type ReactElement } from 'react'
import type { Translate } from '../../i18n.js'

/** Content access stays visible even while message actions are unavailable. */
export function ContentTruncationNotice(props: {
  readonly streaming?: boolean
  readonly onOpen?: (() => void | Promise<void>) | undefined
  readonly translate: Translate
}): ReactElement {
  const [failed, setFailed] = useState(false)
  const open = (): void => {
    setFailed(false)
    let operation: void | Promise<void>
    try {
      operation = props.onOpen?.()
    } catch {
      setFailed(true)
      return
    }
    void Promise.resolve(operation).catch(() => setFailed(true))
  }
  return (
    <div className="dsh-message-truncated" role="note">
      <span>
        {props.translate(props.streaming ? 'message.streamingContentTruncated' : 'message.contentTruncated')}
      </span>
      {props.onOpen === undefined ? null : (
        <button
          className="dsh-message-truncated__open"
          type="button"
          disabled={props.streaming}
          onClick={open}
        >
          {props.translate('message.openFullContent')}
        </button>
      )}
      {failed ? <span role="alert">{props.translate('message.fullContentFailed')}</span> : null}
    </div>
  )
}
