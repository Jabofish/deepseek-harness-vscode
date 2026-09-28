import { useEffect, useState, type ReactElement } from 'react'
import { useI18n } from '../../i18n.js'

export type SettingsTab = 'general' | 'models' | 'presets' | 'plugins'
type SettingsTabOrientation = 'horizontal' | 'vertical'

const SETTINGS_TABS: readonly SettingsTab[] = ['general', 'models', 'presets', 'plugins']

function settingsTabOrientation(): SettingsTabOrientation {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 52rem)').matches
    ? 'horizontal'
    : 'vertical'
}

export interface SettingsTabsProps {
  readonly panels: Readonly<Record<SettingsTab, ReactElement>>
}

export function SettingsTabs(props: SettingsTabsProps): ReactElement {
  const { t } = useI18n()
  const [tab, setTab] = useState<SettingsTab>('general')
  const [tabOrientation, setTabOrientation] = useState<SettingsTabOrientation>(settingsTabOrientation)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(max-width: 52rem)')
    const updateOrientation = (event: MediaQueryListEvent): void => {
      setTabOrientation(event.matches ? 'horizontal' : 'vertical')
    }
    query.addEventListener('change', updateOrientation)
    return () => query.removeEventListener('change', updateOrientation)
  }, [])

  return (
    <div className="dsh-settings__layout">
      <nav
        className="dsh-settings__tabs"
        role="tablist"
        aria-label={t('settings.sections')}
        aria-orientation={tabOrientation}
      >
        {SETTINGS_TABS.map((entry) => (
          <button
            key={entry}
            id={`dsh-settings-tab-${entry}`}
            className={`dsh-settings__tab${tab === entry ? ' dsh-settings__tab--active' : ''}`}
            type="button"
            role="tab"
            aria-selected={tab === entry}
            aria-controls={tab === entry ? `dsh-settings-panel-${entry}` : undefined}
            tabIndex={tab === entry ? 0 : -1}
            onClick={() => setTab(entry)}
            onKeyDown={(event) => {
              const index = SETTINGS_TABS.indexOf(entry)
              let next: SettingsTab | undefined
              if (event.key === 'Home') next = SETTINGS_TABS[0]
              else if (event.key === 'End') next = SETTINGS_TABS[SETTINGS_TABS.length - 1]
              else if (
                (tabOrientation === 'horizontal' && event.key === 'ArrowRight') ||
                (tabOrientation === 'vertical' && event.key === 'ArrowDown')
              )
                next = SETTINGS_TABS[(index + 1) % SETTINGS_TABS.length]
              else if (
                (tabOrientation === 'horizontal' && event.key === 'ArrowLeft') ||
                (tabOrientation === 'vertical' && event.key === 'ArrowUp')
              )
                next = SETTINGS_TABS[(index + SETTINGS_TABS.length - 1) % SETTINGS_TABS.length]
              else return

              event.preventDefault()
              if (next === undefined) return
              setTab(next)
              document.getElementById(`dsh-settings-tab-${next}`)?.focus()
            }}
          >
            {t(`settings.${entry}`)}
          </button>
        ))}
      </nav>
      <div className="dsh-settings__content">{props.panels[tab]}</div>
    </div>
  )
}
