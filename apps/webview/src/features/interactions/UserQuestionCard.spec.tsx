// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserQuestion } from '@dsh-vscode/domain'
import { UserQuestionCard } from './UserQuestionCard.js'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'

function batchQuestion(): UserQuestion {
  return {
    id: 'q-plan',
    rpcId: 'rpc-plan',
    sessionId: 's1',
    prompt: 'Proceed with this plan?',
    allowFreeText: true,
    items: [
      {
        id: 'q-plan',
        prompt: 'Proceed with this plan?',
        header: 'Refactor',
        detail: '1. Do it',
        choices: [
          { id: 'Approve', label: 'Approve', description: 'Run the plan now' },
          { id: 'Decline', label: 'Decline', description: 'Stop here' },
        ],
        allowFreeText: true,
        intent: { kind: 'plan-review', approve: 'Approve' },
      },
      {
        id: 'q-extra',
        prompt: 'Who to notify?',
        choices: [
          { id: 'Alice', label: 'Alice' },
          { id: 'Bob', label: 'Bob' },
        ],
        multiSelect: true,
        allowFreeText: true,
      },
    ],
  }
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Submit' })
}

describe('UserQuestionCard', () => {
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  it('keeps the complete focused prompt and submits its original choice', () => {
    const prompt = 'Choose a scope after reviewing these requirements. '.repeat(50)
    const onRespond = vi.fn()
    const { container } = render(
      <ConversationLayoutProvider initialLayout="focused">
        <UserQuestionCard
          question={{
            id: 'long-question',
            sessionId: 's1',
            prompt,
            choices: [{ id: 'all', label: 'All pages' }],
            allowFreeText: true,
          }}
          disabled={false}
          onRespond={onRespond}
          onCancel={vi.fn()}
        />
      </ConversationLayoutProvider>,
    )

    expect(container.textContent).toContain(prompt)
    fireEvent.click(screen.getByRole('radio', { name: 'All pages' }))
    fireEvent.click(submitButton())
    expect(onRespond).toHaveBeenCalledWith([{ id: 'long-question', response: ['all'] }])
  })

  it('answers all questions of one ask with a single batch submission', () => {
    const onRespond = vi.fn()
    render(
      <UserQuestionCard
        question={batchQuestion()}
        disabled={false}
        onRespond={onRespond}
        onCancel={vi.fn()}
      />,
    )

    expect(submitButton().disabled).toBe(true)
    expect(screen.queryByText(/approves the plan/)).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: /Approve/ }))
    expect(submitButton().disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Alice'))
    fireEvent.click(screen.getByLabelText('Bob'))
    expect(submitButton().disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('Answer for Who to notify?'), {
      target: { value: 'also ping the release channel' },
    })
    fireEvent.click(submitButton())

    expect(onRespond).toHaveBeenCalledTimes(1)
    expect(onRespond).toHaveBeenCalledWith([
      { id: 'q-plan', response: ['Approve'] },
      { id: 'q-extra', response: ['Alice', 'Bob'], custom: 'also ping the release channel' },
    ])
  })

  it('keeps multi-select choices when focusing custom text and excludes unchecked custom text', () => {
    const onRespond = vi.fn()
    render(
      <UserQuestionCard
        question={batchQuestion()}
        disabled={false}
        onRespond={onRespond}
        onCancel={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('radio', { name: /Approve/ }))
    const alice = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Alice' })
    fireEvent.click(alice)
    const field = screen.getByRole('textbox', { name: 'Answer for Who to notify?' })
    const custom = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Custom answer for Who to notify?',
    })
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: 'The release channel' } })
    expect(custom.checked).toBe(true)
    expect(alice.checked).toBe(true)
    fireEvent.click(custom)
    fireEvent.click(submitButton())
    expect(onRespond).toHaveBeenCalledWith([
      { id: 'q-plan', response: ['Approve'] },
      { id: 'q-extra', response: ['Alice'] },
    ])
  })

  it('narrows only a valid single plan review and exposes Chat about it cancellation', () => {
    const onCancel = vi.fn()
    const question = batchQuestion()
    const reviewItem = question.items?.[0]
    if (reviewItem === undefined) throw new Error('fixture requires a plan-review item')
    render(
      <UserQuestionCard
        question={{ ...question, items: [reviewItem] }}
        disabled={false}
        onRespond={vi.fn()}
        onCancel={onCancel}
      />,
    )
    expect(screen.getByText('Review plan')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Skip this question' })).toBeNull()
    // The generic Submit can never be enabled for a review, so the decision row
    // is the only footer.
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Chat about it' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('freezes the answer fields once the reply is queued', () => {
    // When a reply is queued the Submit control is replaced by status text, so
    // the card can no longer act on edits. Leaving the radios and the free-text
    // box live invites the user to keep "answering" something that is already
    // sent and can never be submitted again.
    render(
      <UserQuestionCard
        question={{
          id: 'scope',
          callId: 'call-timed',
          sessionId: 's1',
          prompt: 'Which scope?',
          choices: [
            { id: 'workspace', label: 'workspace' },
            { id: 'all', label: 'all' },
          ],
          allowFreeText: true,
          timed: true,
          state: 'continued',
          replyQueued: true,
        }}
        disabled={false}
        onRespond={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('queued')
    expect(screen.getByRole('radio', { name: /workspace/ }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(true)
  })

  it('does not send a stale cancel request for a continued plan review', () => {
    const onCancel = vi.fn()
    render(
      <UserQuestionCard
        question={{
          id: 'call-plan',
          callId: 'call-plan',
          sessionId: 's1',
          prompt: 'Proceed?',
          allowFreeText: true,
          state: 'continued',
          items: [
            {
              id: 'decision',
              prompt: 'Proceed?',
              detail: 'Review the plan',
              choices: [
                { id: 'Approve', label: 'Approve' },
                { id: 'Decline', label: 'Decline' },
              ],
              allowFreeText: true,
              intent: { kind: 'plan-review', approve: 'Approve' },
            },
          ],
        }}
        disabled={false}
        onRespond={vi.fn()}
        onCancel={onCancel}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Chat about it' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined()
    expect(onCancel).not.toHaveBeenCalled()
  })
})
