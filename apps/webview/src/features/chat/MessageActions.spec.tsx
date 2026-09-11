// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageActions } from './MessageActions.js'

describe('MessageActions feedback controls', () => {
  afterEach(() => cleanup())

  it('opens the rc.2 feedback dialog before submitting an unrecorded rating', async () => {
    const onFeedback = vi.fn()
    const onFeedbackSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <MessageActions
        text="answer"
        feedbackRating="positive"
        onFeedback={onFeedback}
        onFeedbackSubmit={onFeedbackSubmit}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Bad response' }))
    expect(onFeedback).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Submit feedback' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Task result' }))
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Feedback details' }), {
      target: { value: 'needs work' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await waitFor(() =>
      expect(onFeedbackSubmit).toHaveBeenCalledWith('negative', 'needs work', 'task-result'),
    )
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Submit feedback' })).toBeNull())
    expect(screen.getByRole('status', { name: '' }).textContent).toContain('Thanks for your feedback')
  })

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

  it('retracts an already recorded rating without opening the dialog', () => {
    const onFeedback = vi.fn()
    const onFeedbackSubmit = vi.fn()
    render(
      <MessageActions
        text="answer"
        feedbackRating="positive"
        onFeedback={onFeedback}
        onFeedbackSubmit={onFeedbackSubmit}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove rating' }))
    expect(onFeedback).toHaveBeenCalledWith('positive')
    expect(onFeedbackSubmit).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('waits for a cold feedback catalog before retracting a stored rating', async () => {
    const onFeedback = vi.fn()
    const observed = { messageId: 'message-1', rating: 'positive' as const, version: 'v1' }
    let release: (value: typeof observed) => void = () => undefined
    const pending = new Promise<typeof observed>((resolve) => {
      release = resolve
    })
    const onFeedbackPrepare = vi.fn(() => pending)
    render(
      <MessageActions
        text="answer"
        onFeedback={onFeedback}
        onFeedbackSubmit={vi.fn()}
        onFeedbackPrepare={onFeedbackPrepare}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Good response' }))
    expect(onFeedback).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Good response' }).disabled).toBe(true)

    release(observed)
    await waitFor(() => expect(onFeedback).toHaveBeenCalledWith('positive'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps positive and negative controls aligned with their visible icons', () => {
    render(<MessageActions text="answer" onFeedback={() => undefined} />)

    const positive = screen.getByRole('button', { name: 'Good response' })
    const negative = screen.getByRole('button', { name: 'Bad response' })

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

  it('uses the same dialog to edit an existing note and category', async () => {
    const onFeedbackSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <MessageActions
        text="answer"
        feedbackRating="negative"
        feedbackNote="keep this"
        feedbackCategory="task-result"
        onFeedbackSubmit={onFeedbackSubmit}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add feedback note' }))
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Feedback details' })
    expect(editor.value).toBe('keep this')
    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    fireEvent.change(editor, { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await waitFor(() => expect(onFeedbackSubmit).toHaveBeenCalledWith('negative', undefined, 'other'))
  })

  it('marks the persisted rating so the selected control can be colored', () => {
    render(<MessageActions text="answer" feedbackRating="negative" onFeedback={() => undefined} />)

    expect(screen.getByRole('button', { name: 'Good response' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Remove rating' }).getAttribute('aria-pressed')).toBe('true')
  })
})
