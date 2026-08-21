// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageActions } from './MessageActions.js'

describe('MessageActions feedback controls', () => {
  afterEach(() => cleanup())

  it('toggles a persisted rating and exposes an editable note popover', async () => {
    const onFeedback = vi.fn()
    const onFeedbackNote = vi.fn().mockResolvedValue(undefined)
    render(
      <MessageActions
        text="answer"
        feedbackRating="positive"
        feedbackNote="keep this"
        onFeedback={onFeedback}
        onFeedbackNote={onFeedbackNote}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Good response' }))
    expect(onFeedback).toHaveBeenCalledWith('positive')
    fireEvent.click(screen.getByRole('button', { name: 'Add feedback note' }))
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Add feedback note' })
    fireEvent.change(editor, { target: { value: 'updated note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }))
    await waitFor(() => expect(onFeedbackNote).toHaveBeenCalledWith('updated note'))
  })

  it('sends an empty note as a clear operation', async () => {
    const onFeedbackNote = vi.fn().mockResolvedValue(undefined)
    render(
      <MessageActions
        text="answer"
        feedbackRating="negative"
        feedbackNote="remove me"
        onFeedbackNote={onFeedbackNote}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add feedback note' }))
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Add feedback note' }), {
      target: { value: '   ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }))
    await waitFor(() => expect(onFeedbackNote).toHaveBeenCalledWith(undefined))
  })

  it('keeps positive and negative controls aligned with their visible icons', () => {
    render(<MessageActions text="answer" onFeedback={() => undefined} />)

    const positive = screen.getByRole('button', { name: 'Good response' })
    const negative = screen.getByRole('button', { name: 'Poor response' })

    expect(positive.getAttribute('aria-pressed')).toBe('false')
    expect(negative.getAttribute('aria-pressed')).toBe('false')
    expect(positive.classList.contains('dsh-message-actions__button--feedback-positive')).toBe(true)
    expect(negative.classList.contains('dsh-message-actions__button--feedback-negative')).toBe(true)

    expect(positive.querySelector('path')?.getAttribute('d')).toBe(
      'M7 10v10H4.5A1.5 1.5 0 0 1 3 18.5v-7A1.5 1.5 0 0 1 4.5 10H7Z',
    )
    expect(negative.querySelector('path')?.getAttribute('d')).toBe(
      'M17 14V4h2.5A1.5 1.5 0 0 1 21 5.5v7a1.5 1.5 0 0 1-1.5 1.5H17Z',
    )
  })

  it('marks the persisted rating so the selected control can be colored', () => {
    render(<MessageActions text="answer" feedbackRating="negative" onFeedback={() => undefined} />)

    expect(screen.getByRole('button', { name: 'Good response' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Poor response' }).getAttribute('aria-pressed')).toBe('true')
  })
})
