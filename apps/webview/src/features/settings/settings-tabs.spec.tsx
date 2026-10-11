// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'
import { SettingsTabs } from './settings-tabs.js'

const panels = {
  general: <div>General content</div>,
  models: <div>Models content</div>,
  presets: <div>Presets content</div>,
  plugins: <div>Plugins content</div>,
}
afterEach(() => {
  cleanup()
  sessionStorage.clear()
})
describe('settings section continuity', () => {
  it('reopens the last focused section while classic opens General', () => {
    const focused = (): ReactElement => (
      <ConversationLayoutProvider initialLayout="focused">
        <SettingsTabs panels={panels} />
      </ConversationLayoutProvider>
    )
    const first = render(focused())
    fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }))
    first.unmount()
    const second = render(focused())
    expect(screen.getByText('Plugins content')).toBeDefined()
    second.unmount()
    render(<SettingsTabs panels={panels} />)
    expect(screen.getByText('General content')).toBeDefined()
  })
  it('ignores a section that is no longer in the navigation', () => {
    sessionStorage.setItem('dsh-webview-settings-section', 'removed')
    render(
      <ConversationLayoutProvider initialLayout="focused">
        <SettingsTabs panels={panels} />
      </ConversationLayoutProvider>,
    )
    expect(screen.getByText('General content')).toBeDefined()
  })
})
