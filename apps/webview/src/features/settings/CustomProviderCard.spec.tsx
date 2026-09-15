// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../i18n.js'
import { CustomProviderCard } from './CustomProviderCard.js'

function renderCard(): Record<string, ReturnType<typeof vi.fn>> {
  const onCreate = vi.fn().mockResolvedValue({ profileCommitted: true, credentialConfigured: true })
  const onConfigureSecret = vi.fn().mockResolvedValue(true)
  render(
    <I18nProvider>
      <CustomProviderCard
        template={{
          settingsNamespace: 'llm-custom',
          collectionPath: ['providers'],
          protocols: ['openai-compatible'],
          revision: 4,
        }}
        providers={[]}
        writable
        saving={false}
        onClose={vi.fn()}
        onCreate={onCreate}
        onConfigureSecret={onConfigureSecret}
        onDiscover={vi.fn().mockResolvedValue([])}
      />
    </I18nProvider>,
  )
  return { onCreate, onConfigureSecret }
}

function addModel(id: string): void {
  fireEvent.click(screen.getByRole('button', { name: 'Add model' }))
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: id } })
}

describe('CustomProviderCard model validation', () => {
  afterEach(() => cleanup())

  it('names the capacity field that is actually invalid', () => {
    renderCard()
    addModel('model-a')
    fireEvent.click(screen.getByRole('button', { name: 'Advanced model settings' }))
    fireEvent.change(screen.getByLabelText('Max output tokens'), { target: { value: 'abc' } })

    expect(
      screen.getByText('Max output tokens must be a positive integer, optionally using K or M.'),
    ).toBeDefined()
    expect(
      screen.queryByText('Context window must be a positive integer, optionally using K or M.'),
    ).toBeNull()
  })

  it('still enables submission for a valid model capacity', () => {
    renderCard()
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'my-router' } })
    fireEvent.change(screen.getByLabelText('Provider base URL'), {
      target: { value: 'https://api.example.com' },
    })
    addModel('model-a')
    fireEvent.click(screen.getByRole('button', { name: 'Advanced model settings' }))
    fireEvent.change(screen.getByLabelText('Max output tokens'), { target: { value: '32K' } })

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save provider' }).disabled).toBe(false)
  })
})
