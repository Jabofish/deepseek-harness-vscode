import { useId, type ReactElement } from 'react'
import { useConversationLayout } from './ConversationLayoutProvider.js'
import { isConversationLayout } from './conversation-layout.js'
import { useI18n } from '../i18n.js'

export function ConversationLayoutControl(): ReactElement | null {
  const preference = useConversationLayout()
  const id = useId()
  const { t } = useI18n()
  if (preference === undefined) return null
  return (
    <label className="dsh-conversation-layout" htmlFor={id}>
      <span>{t('settings.conversationLayout.label')}</span>
      <select
        id={id}
        value={preference.layout}
        onChange={(event) => {
          const next = event.currentTarget.value
          if (isConversationLayout(next)) preference.setLayout(next)
        }}
      >
        <option value="focused">{t('settings.conversationLayout.focused')}</option>
        <option value="classic">{t('settings.conversationLayout.classic')}</option>
      </select>
    </label>
  )
}
