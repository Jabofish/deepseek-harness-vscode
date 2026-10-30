// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageActions } from './MessageActions.js'

describe('MessageActions feedback controls', () => {
  afterEach(() => cleanup())

  it('keeps the draft and selected category visible after a failed submission', async () => {
    const onFeedbackSubmit = vi.fn().mockRejectedValue(new Error('network'))
    render(<MessageActions text="answer" onFeedbackSubmit={onFeedbackSubmit} />)

    fireEvent.click(screen.getByRole('button', { name: 'Good response' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stability and speed' }))
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Feedback details' })
    fireEvent.change(editor, { target: { value: 'keep the draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await screen.findByRole('alert')
    expect(screen.getByRole('dialog', { name: 'Submit feedback' })).toBeDefined()
    expect(editor.value).toBe('keep the draft')
    expect(screen.getByRole('button', { name: 'Stability and speed' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  it('submits feedback dialog when pressing Ctrl+Enter in the details textarea', async () => {
    const onFeedbackSubmit = vi.fn().mockResolvedValue(undefined)
    render(<MessageActions text="answer" onFeedbackSubmit={onFeedbackSubmit} />)

    fireEvent.click(screen.getByRole('button', { name: 'Good response' }))
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Feedback details' })
    fireEvent.change(editor, { target: { value: 'quick submit with keyboard' } })
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })

    expect(onFeedbackSubmit).toHaveBeenCalledWith('positive', 'quick submit with keyboard', undefined)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Submit feedback' })).toBeNull())
  })
})
