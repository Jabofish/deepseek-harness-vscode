import { useId, type ReactElement } from 'react'
import { useConversationLayout } from './ConversationLayoutProvider.js'
import { isConversationLayout } from './conversation-layout.js'
import { useI18n } from '../i18n.js'
import { SelectMenu } from '../components/common/SelectMenu.js'

export function ConversationLayoutControl(): ReactElement | null {
  const preference = useConversationLayout()
  const id = useId()
  const { t } = useI18n()
  if (preference === undefined) return null
  return (
    <label className="dsh-conversation-layout" htmlFor={id}>
      <span>{t('settings.conversationLayout.label')}</span>
      <SelectMenu
        id={id}
        icon="list"
        density="regular"
        label={t(`settings.conversationLayout.${preference.layout}`)}
        ariaLabel={t('settings.conversationLayout.label')}
        title={t('settings.conversationLayout.label')}
        value={preference.layout}
        options={[
          { value: 'focused', label: t('settings.conversationLayout.focused') },
          { value: 'classic', label: t('settings.conversationLayout.classic') },
        ]}
        onChange={(next) => {
          if (isConversationLayout(next)) preference.setLayout(next)
        }}
      />
    </label>
  )
}
