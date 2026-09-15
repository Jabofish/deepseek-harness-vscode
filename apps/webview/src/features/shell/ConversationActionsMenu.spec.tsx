// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '../../i18n.js'
import { SelectMenu } from '../../components/common/SelectMenu.js'
import { DiagnosticsDrawer } from '../diagnostics/DiagnosticsDrawer.js'
import { ConversationActionsMenu } from './ConversationActionsMenu.js'

function renderMenu(options: { readonly onClose?: () => void } = {}): void {
  render(
    <I18nProvider>
      <ConversationActionsMenu {...(options.onClose === undefined ? {} : { onClose: options.onClose })}>
        <SelectMenu
          icon="sparkles"
          label="Global"
          ariaLabel="Scope"
          title="Scope"
          value="global"
          options={[
            { value: 'global', label: 'Global' },
            { value: 'workspace', label: 'Workspace' },
          ]}
          onChange={() => undefined}
        />
      </ConversationActionsMenu>
    </I18nProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Conversation tools' }))
}

function renderMenuWithDiagnostics(options: { readonly onClose?: () => void } = {}): void {
  render(
    <I18nProvider>
      <ConversationActionsMenu {...(options.onClose === undefined ? {} : { onClose: options.onClose })}>
        <DiagnosticsDrawer
          onRead={() => Promise.resolve(undefined)}
          onReconnect={() => Promise.resolve()}
          onShowOutput={() => Promise.resolve()}
        />
      </ConversationActionsMenu>
    </I18nProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Conversation tools' }))
}

describe('ConversationActionsMenu', () => {
  afterEach(() => cleanup())

  it('keeps the panel open when Escape only dismisses a nested menu', () => {
    const onClose = vi.fn()
    renderMenu({ onClose })
    expect(screen.getByRole('dialog', { name: 'Conversation tools' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Scope: Global' }))
    expect(screen.getByRole('listbox', { name: 'Scope' })).toBeDefined()

    fireEvent.keyDown(screen.getByRole('option', { name: 'Global' }), { key: 'Escape' })

    expect(screen.queryByRole('listbox', { name: 'Scope' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Conversation tools' })).toBeDefined()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps the panel open when Escape only dismisses a nested dismissible layer', async () => {
    const onClose = vi.fn()
    renderMenuWithDiagnostics({ onClose })
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'DSH diagnostics' })).toBeDefined())

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'DSH diagnostics' }), { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'DSH diagnostics' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Conversation tools' })).toBeDefined()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('lets the next Escape close the panel after the nested layer is gone', async () => {
    const onClose = vi.fn()
    renderMenuWithDiagnostics({ onClose })
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'DSH diagnostics' })).toBeDefined())

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'DSH diagnostics' }), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Conversation tools' }), { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Conversation tools' })).toBeNull()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps the panel open when a nested dismissible layer is used', async () => {
    const onClose = vi.fn()
    renderMenuWithDiagnostics({ onClose })
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }))
    const nested = await screen.findByRole('dialog', { name: 'DSH diagnostics' })

    fireEvent.pointerDown(nested)
    fireEvent.click(nested)

    expect(screen.getByRole('dialog', { name: 'DSH diagnostics' })).toBeDefined()
    expect(screen.getByRole('dialog', { name: 'Conversation tools' })).toBeDefined()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes the panel on Escape when no inner layer consumed it', () => {
    const onClose = vi.fn()
    renderMenu({ onClose })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Conversation tools' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Conversation tools' })).toBeNull()
    expect(onClose).toHaveBeenCalled()
  })
})
