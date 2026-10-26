// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AccessibilityProvider, useQuietActivity } from './AccessibilityProvider.js'
import { ActivityPresentationControl } from './ActivityPresentationControl.js'
import { readActivityPresentation, rememberActivityPresentation } from './activity-presentation.js'
import { I18nProvider } from '../i18n.js'

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.body.className = ''
  vi.restoreAllMocks()
})

function Probe(): React.JSX.Element {
  return <output data-testid="quiet">{String(useQuietActivity())}</output>
}
function Settings(): React.JSX.Element {
  return (
    <I18nProvider>
      <AccessibilityProvider>
        <ActivityPresentationControl />
        <Probe />
      </AccessibilityProvider>
    </I18nProvider>
  )
}

it('persists the selection, restores it on reopen and lets live override screen-reader auto', async () => {
  document.body.classList.add('vscode-using-screen-reader')
  const view = render(<Settings />)
  expect(screen.getByTestId('quiet').textContent).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: /^Process display:/u }))
  fireEvent.click(screen.getByRole('option', { name: 'Live' }))
  expect(readActivityPresentation()).toBe('live')
  expect(screen.getByTestId('quiet').textContent).toBe('false')
  view.unmount()
  const reopened = render(<Settings />)
  expect(screen.getByRole('button', { name: /^Process display:/u }).textContent).toContain('Live')
  expect(screen.getByTestId('quiet').textContent).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: /^Process display:/u }))
  fireEvent.click(screen.getByRole('option', { name: 'Quiet' }))
  await act(async () => {
    await Promise.resolve()
    document.body.className = ''
  })
  expect(screen.getByTestId('quiet').textContent).toBe('true')
  reopened.unmount()
  render(<Settings />)
  expect(screen.getByTestId('quiet').textContent).toBe('true')
})

it('retains usable display controls when browser storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  expect(readActivityPresentation()).toBe('auto')
  expect(() => rememberActivityPresentation('quiet')).not.toThrow()
  render(<Settings />)
  fireEvent.click(screen.getByRole('button', { name: /^Process display:/u }))
  fireEvent.click(screen.getByRole('option', { name: 'Quiet' }))
  expect(screen.getByTestId('quiet').textContent).toBe('true')
})
