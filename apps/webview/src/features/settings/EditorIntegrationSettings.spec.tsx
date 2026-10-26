// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorIntegrationStatus } from '@dsh-vscode/domain'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import { I18nProvider } from '../../i18n.js'
import { EditorIntegrationSettings } from './EditorIntegrationSettings.js'

afterEach(cleanup)
const ready: EditorIntegrationStatus = {
  kind: 'editor.companion',
  preferences: { enabled: true, autoSetup: true, allowEdits: true },
  phase: 'ready',
  capabilities: ['content', 'edit'],
  canInstall: true,
  canRestart: true,
  canUndo: true,
}
function mount(handle: (request: FeatureRequest) => Promise<unknown>): void {
  const request = <T,>(value: FeatureRequest): Promise<T> => handle(value) as Promise<T>
  render(
    <I18nProvider>
      <EditorIntegrationSettings request={request} />
    </I18nProvider>,
  )
}
describe('editor integration in Webview settings', () => {
  it('shows the native installation cause and preserves the retry action', async () => {
    mount(() =>
      Promise.resolve({
        ...ready,
        phase: 'limited',
        reason: 'setup-failed',
        installation: 'failed',
        installationFailureKind: 'pnpm-missing',
        installed: false,
      }),
    )
    await screen.findByText(/DSH cannot run pnpm/)
    expect(screen.queryByText(/Restart to use the bundled integration/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Install and enable companion' })).toBeDefined()
  })
  it('sends a separate native cancellation while Install is pending and waits for the actual result', async () => {
    const missing = {
      ...ready,
      phase: 'limited',
      reason: 'missing',
      preferences: { ...ready.preferences, autoSetup: false },
    }
    let finish!: (value: unknown) => void
    const handle = vi.fn<(request: FeatureRequest) => Promise<unknown>>().mockImplementation((request) => {
      if (request.type === 'editor.companion.action' && request.payload.action === 'setup')
        return new Promise((resolve) => {
          finish = resolve
        })
      if (request.type === 'editor.companion.action' && request.payload.action === 'cancel-install')
        return Promise.resolve({ ...missing, installation: 'cancelling', canCancelInstall: false })
      return Promise.resolve(missing)
    })
    mount(handle)
    fireEvent.click(await screen.findByRole('button', { name: 'Install and enable companion' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel installation' }))
    await waitFor(() =>
      expect(handle).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'editor.companion.action', payload: { action: 'cancel-install' } }),
      ),
    )
    expect(screen.queryByText('Companion installation cancelled.')).toBeNull()
    finish({ ...missing, installation: 'cancelled', canCancelInstall: false })
    await screen.findByText('Companion installation cancelled.')
    expect(screen.queryByRole('button', { name: 'Cancel installation' })).toBeNull()
  })

  it('requests installation only after the user clicks Install and enable companion', async () => {
    const handle = vi.fn<(request: FeatureRequest) => Promise<unknown>>().mockResolvedValue({
      ...ready,
      preferences: { ...ready.preferences, autoSetup: false },
      phase: 'limited',
      reason: 'missing',
    })
    mount(handle)
    const install = await screen.findByRole('button', { name: 'Install and enable companion' })
    expect(handle.mock.calls.every(([request]) => request.type === 'editor.companion.status')).toBe(true)
    fireEvent.click(install)
    await waitFor(() =>
      expect(handle).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'editor.companion.action', payload: { action: 'setup' } }),
      ),
    )
  })
})
