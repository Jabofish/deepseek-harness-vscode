// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '../../i18n.js'
import { SettingsTabs, type SettingsTab } from './settings-tabs.js'

describe('SettingsTabs', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
  })
  afterEach(() => cleanup())

  function renderTabs(): void {
    const panels: Record<SettingsTab, React.ReactElement> = {
      general: <div data-testid="panel-general">General Panel</div>,
      models: <div data-testid="panel-models">Models Panel</div>,
      presets: <div data-testid="panel-presets">Presets Panel</div>,
      plugins: <div data-testid="panel-plugins">Plugins Panel</div>,
    }
    render(
      <I18nProvider>
        <SettingsTabs panels={panels} />
      </I18nProvider>,
    )
  }

  it('defaults to general tab when storage is empty', () => {
    renderTabs()
    expect(screen.getByTestId('panel-general')).toBeDefined()
  })

  it('remembers tab choice in localStorage and restores it across mounts', () => {
    renderTabs()
    const modelsTab = screen.getByRole('tab', { name: 'Models' })
    fireEvent.click(modelsTab)

    expect(screen.getByTestId('panel-models')).toBeDefined()
    expect(window.localStorage.getItem('dsh-webview-settings-section')).toBe('models')

    cleanup()

    // Second mount restores 'models'
    renderTabs()
    expect(screen.getByTestId('panel-models')).toBeDefined()
  })

  it('safely falls back to general when stored value is invalid', () => {
    window.localStorage.setItem('dsh-webview-settings-section', 'invalid-tab-name')
    renderTabs()
    expect(screen.getByTestId('panel-general')).toBeDefined()
  })

  it('preserves the previously remembered section when upgrading from session storage', () => {
    window.sessionStorage.setItem('dsh-webview-settings-section', 'models')
    renderTabs()
    expect(screen.getByTestId('panel-models')).toBeDefined()
    fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }))
    cleanup()
    renderTabs()
    expect(screen.getByTestId('panel-plugins')).toBeDefined()
  })
})
