// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '../../i18n.js'
import { ContextMeter } from './ContextMeter.js'

afterEach(() => cleanup())

describe('ContextMeter', () => {
  it('shows the rc.8 context breakdown with bounded labels and segments', () => {
    render(
      <I18nProvider>
        <ContextMeter
          tokens={50_600}
          maximum={1_000_000}
          breakdown={{ systemTokens: 1_600, toolsTokens: 6_700, messageTokens: 19_500 }}
        />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Context ~50\.6k \/ 1\.0m tokens/u }))

    const dialog = screen.getByRole('dialog')
    expect(dialog.parentElement).toBe(document.body)
    expect(dialog.textContent).toContain('5% of context used')
    expect(dialog.textContent).toContain('~50.6K / 1M')
    expect(dialog.textContent).toContain('System prompt')
    expect(dialog.textContent).toContain('~1.6K')
    expect(dialog.textContent).toContain('Tools')
    expect(dialog.textContent).toContain('~6.7K')
    expect(dialog.textContent).toContain('Conversation messages')
    expect(dialog.textContent).toContain('~19.5K')
    expect(document.querySelectorAll('.dsh-context-meter__segment')).toHaveLength(3)
  })

  it('warns when the estimate exceeds the window instead of clamping to a silent 100%', () => {
    render(
      <I18nProvider>
        <ContextMeter tokens={1_040_000} maximum={1_000_000} />
      </I18nProvider>,
    )

    // The ring saturates, but the trigger states the overflow and the meter
    // carries the overflow state for the failure tint.
    expect(
      screen.getByRole('button', {
        name: 'Context ~1.0m / 1.0m tokens, estimated above the window',
      }),
    ).toBeDefined()
    expect(document.querySelector('.dsh-context-meter')?.getAttribute('data-overflow')).toBe('true')

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Estimated above the context window.')).toBeDefined()
    expect(screen.getByText('104%')).toBeDefined()
  })

  it('closes on Escape and outside pointer input', () => {
    render(
      <I18nProvider>
        <ContextMeter
          tokens={5_000}
          maximum={100_000}
          breakdown={{ systemTokens: 100, toolsTokens: 200, messageTokens: 300 }}
        />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('dialog')).toBeDefined()
    fireEvent.pointerDown(screen.getByRole('dialog'))
    expect(screen.getByRole('dialog')).toBeDefined()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button'))
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('moves the keyboard into the details on open and back to the trigger on close', () => {
    render(
      <I18nProvider>
        <ContextMeter tokens={5_000} maximum={100_000} />
      </I18nProvider>,
    )

    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Context details' }))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
