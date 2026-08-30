import type { ReactElement } from 'react'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface ConversationEventToggleProps {
  readonly count: number
  readonly pressed: boolean
  readonly onPressedChange: (pressed: boolean) => void
}

/**
 * A low-frequency diagnostic control for the conversation action surface.
 * Keeping it in shell chrome prevents event visibility from becoming a
 * floating element inside the timeline's scroll and measurement system.
 */
export function ConversationEventToggle(props: ConversationEventToggleProps): ReactElement {
  const { t } = useI18n()
  return (
    <button
      className="dsh-conversation__events-toggle dsh-conversation__events-toggle--menu"
      type="button"
      aria-pressed={props.pressed}
      aria-label={props.pressed ? t('timeline.hideEvents') : t('timeline.showEvents')}
      title={props.pressed ? t('timeline.hideEvents') : t('timeline.showEventsCount', { count: props.count })}
      onClick={() => props.onPressedChange(!props.pressed)}
    >
      <Icon name="terminal" />
      <span>{props.pressed ? t('timeline.hideEvents') : t('timeline.showEvents')}</span>
      <span className="dsh-conversation__events-toggle-count" aria-hidden="true">
        ({props.count})
      </span>
    </button>
  )
}
