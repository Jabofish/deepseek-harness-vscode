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
  it('offers standard installation even while an old overlay still provides working tools', async () => {
    mount(() => Promise.resolve({ ...ready, installed: false, packageManager: 'ready' }))
    expect(
      (await screen.findByRole('button', { name: 'Install and enable companion' })).hasAttribute('disabled'),
    ).toBe(false)
  })
  it('shows first installation despite old consent and guides dependency preparation before any install', async () => {
    const handle = vi.fn<(request: FeatureRequest) => Promise<unknown>>().mockResolvedValue({
      ...ready,
      installed: false,
      packageManager: 'broken',
      phase: 'limited',
      reason: 'missing',
    })
    mount(handle)
    const install = await screen.findByRole('button', { name: 'Install and enable companion' })
    expect(install.hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Repair or update companion' })).toBeNull()
    await screen.findByText(/pnpm was found but cannot run/)
    fireEvent.click(screen.getByRole('button', { name: 'Install / repair pnpm' }))
    await waitFor(() =>
      expect(handle).toHaveBeenCalledWith(expect.objectContaining({ payload: { action: 'prepare-pnpm' } })),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy pnpm install command' }))
    await waitFor(() =>
      expect(handle).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { action: 'copy-pnpm-command' } }),
      ),
    )
    expect(
      handle.mock.calls.some(
        ([value]) => value.type === 'editor.companion.action' && value.payload.action === 'setup',
      ),
    ).toBe(false)
  })
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
  it('offers cancellation for an unknown install after the settings panel is reopened', async () => {
    const handle = vi.fn<(request: FeatureRequest) => Promise<unknown>>().mockResolvedValue({
      ...ready,
      phase: 'setup',
      installation: 'unknown',
      canInstall: false,
      canCancelInstall: true,
    })
    mount(handle)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel installation' }))
    await waitFor(() =>
      expect(handle).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'editor.companion.action', payload: { action: 'cancel-install' } }),
      ),
    )
    expect(
      handle.mock.calls.some(
        ([request]) => request.type === 'editor.companion.action' && request.payload.action === 'setup',
      ),
    ).toBe(false)
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
  it.each([
    ['workspace', 'Choose folder'],
    ['untrusted', 'Manage workspace trust'],
  ] as const)('offers a direct action when waiting for %s', async (reason, label) => {
    const handle = vi.fn<(request: FeatureRequest) => Promise<unknown>>().mockResolvedValue({
      ...ready,
      phase: 'waiting',
      reason,
    })
    mount(handle)
    fireEvent.click(await screen.findByRole('button', { name: label }))
    await waitFor(() =>
      expect(handle).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'editor.companion.action', payload: { action: 'retry' } }),
      ),
    )
  })
  it('shows live status and applies persistent read-only/off choices directly without a native dialog', async () => {
    let state = ready
    const calls: FeatureRequest[] = []
    mount((request) => {
      calls.push(request)
      if (request.type === 'editor.companion.configure')
        state = {
          ...state,
          preferences: {
            enabled: request.payload.enabled ?? state.preferences.enabled,
            autoSetup: request.payload.autoSetup ?? state.preferences.autoSetup,
            allowEdits: request.payload.allowEdits ?? state.preferences.allowEdits,
          },
          ...(request.payload.enabled === false ? { phase: 'off' } : {}),
        }
      return Promise.resolve(state)
    })
    await screen.findByText('Editor tools ready')
    fireEvent.click(screen.getByRole('switch', { name: 'Allow agent edits' }))
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Allow agent edits' }).getAttribute('aria-checked')).toBe(
        'false',
      ),
    )
    expect(calls).toContainEqual(
      expect.objectContaining({ type: 'editor.companion.configure', payload: { allowEdits: false } }),
    )
    fireEvent.click(screen.getByRole('switch', { name: 'Editor tools' }))
    await screen.findByText('Off')
    expect(calls).toContainEqual(
      expect.objectContaining({ type: 'editor.companion.configure', payload: { enabled: false } }),
    )
  })
  it('keeps settings available while disconnected and offers repair/restart/undo only when the Host supports them', async () => {
    const handle = vi.fn<(request: FeatureRequest) => Promise<unknown>>().mockResolvedValue({
      ...ready,
      phase: 'waiting',
      reason: 'disconnected',
      canInstall: false,
      canRestart: false,
      canUndo: false,
    })
    mount(handle)
    await screen.findByText('Connect to DSH to use editor tools. Settings are saved for this workspace.')
    expect(screen.queryByRole('button', { name: 'Repair or update companion' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restart DSH' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }))
    await waitFor(() =>
      expect(handle).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'editor.companion.action', payload: { action: 'retry' } }),
      ),
    )
  })
  it('preserves the previous setting when a save fails and rejects unexpected status fields', async () => {
    mount((request) =>
      request.type === 'editor.companion.status'
        ? Promise.resolve(ready)
        : Promise.resolve({ ...ready, endpoint: 'private origin' }),
    )
    await screen.findByText('Editor tools ready')
    fireEvent.click(screen.getByRole('switch', { name: 'Allow agent edits' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('switch', { name: 'Allow agent edits' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(screen.queryByText('private origin')).toBeNull()
  })
})
