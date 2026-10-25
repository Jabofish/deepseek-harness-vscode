import { type ReactElement } from 'react'
import { useActivityPreference } from './AccessibilityProvider.js'
import { ACTIVITY_PRESENTATION_OPTIONS, isActivityPresentation } from './activity-presentation.js'
import { SettingRow } from '../components/common/SettingCard.js'
import { SelectMenu } from '../components/common/SelectMenu.js'
import { useI18n } from '../i18n.js'

export function ActivityPresentationControl(): ReactElement | null {
  const preference = useActivityPreference()
  const { t } = useI18n()
  if (preference === undefined) return null
  return (
    <SettingRow
      title={t('settings.activityPresentation.label')}
      description={t('settings.activityPresentation.hint')}
      control={
        <SelectMenu
          icon="list"
          density="regular"
          label={t(`settings.activityPresentation.${preference.presentation}`)}
          ariaLabel={t('settings.activityPresentation.label')}
          title={t('settings.activityPresentation.label')}
          value={preference.presentation}
          options={ACTIVITY_PRESENTATION_OPTIONS.map((value) => ({
            value,
            label: t(`settings.activityPresentation.${value}`),
          }))}
          onChange={(next) => {
            if (isActivityPresentation(next)) preference.setPresentation(next)
          }}
        />
      }
    />
  )
}
