// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueuedInput } from '@dsh-vscode/domain'

import { I18nProvider } from '../../i18n.js'
import { QueuePanel } from './QueuePanel.js'

function queuedInput(id: string, text = id): QueuedInput {
  return {
    id,
    sessionId: 'session-1',
    text,
    attachments: [],
    mode: 'queue',
    createdAt: '2026-08-31T00:00:00.000Z',
  }
}

function renderQueue(
  items: readonly QueuedInput[],
  running = false,
  onModeChange: (id: string, mode: QueuedInput['mode']) => void = vi.fn(),
): void {
  render(
    <I18nProvider>
      <QueuePanel
        items={items}
        running={running}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onModeChange={onModeChange}
      />
    </I18nProvider>,
  )
}

describe('QueuePanel', () => {
  afterEach(() => cleanup())

  it('does not present a lone queued prompt while the session is idle', () => {
    renderQueue([queuedInput('q1', 'first')])

    expect(screen.queryByRole('region', { name: 'Queued prompts' })).toBeNull()
  })

  it('renders one pending prompt as a compact row while the session is running', () => {
    renderQueue([queuedInput('q1', 'first')], true)

    expect(screen.getByRole('region', { name: 'Queued prompts' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Edit queued prompt q1' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Queued prompts/u })).toBeNull()
  })

  it('shows queued images and prevents an edit that the pinned host cannot preserve', () => {
    const item: QueuedInput = {
      ...queuedInput('q-image', 'describe this'),
      images: [
        {
          attachmentId: 'image-1',
          mediaType: 'image/png',
          bytes: 4,
          width: 2,
          height: 2,
        },
      ],
    }
    renderQueue([item], true)

    expect(screen.getByLabelText('Attached images')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Edit queued prompt q-image' }).hasAttribute('readonly')).toBe(
      true,
    )
    expect(
      screen.getByRole('textbox', { name: 'Edit queued prompt q-image' }).getAttribute('title'),
    ).toContain('cannot be edited')
  })

  it('promotes a queued prompt to steer', () => {
    const onModeChange = vi.fn()
    renderQueue([queuedInput('q1', 'first')], true, onModeChange)

    fireEvent.click(screen.getByRole('button', { name: /Mode for queued prompt q1/u }))
    fireEvent.click(screen.getByRole('option', { name: 'Steer' }))

    expect(onModeChange).toHaveBeenCalledWith('q1', 'steer')
  })

  it('does not offer a delivery mode the Host cannot apply to a steering prompt', () => {
    const onModeChange = vi.fn()
    renderQueue([{ ...queuedInput('q-steer', 'first'), mode: 'steer' }], true, onModeChange)

    // The pinned Host only accepts `action: { kind: 'steer' }`; no request
    // moves a steering prompt back into the queue, so the mode is reported
    // instead of offered as a choice that silently does nothing.
    const trigger = screen.getByRole('button', { name: /Mode for queued prompt q-steer/u })
    expect(trigger.textContent).toContain('Steer')
    expect(trigger.hasAttribute('disabled')).toBe(true)
    expect(onModeChange).not.toHaveBeenCalled()
  })

  it('collapses a multi-prompt backlog until the user opens it', () => {
    renderQueue([queuedInput('q1', 'first'), queuedInput('q2', 'second')])

    const toggle = screen.getByRole('button', { name: /Queued prompts/u })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('textbox', { name: 'Edit queued prompt q1' })).toBeNull()

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('textbox', { name: 'Edit queued prompt q1' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Edit queued prompt q2' })).toBeTruthy()
  })
})
