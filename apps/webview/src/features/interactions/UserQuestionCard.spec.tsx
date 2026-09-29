// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserQuestion } from '@dsh-vscode/domain'
import { UserQuestionCard } from './UserQuestionCard.js'
import { I18nProvider } from '../../i18n.js'

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

  it('renders every question of one ask with header, detail, and option descriptions', () => {
    render(
      <UserQuestionCard question={batchQuestion()} disabled={false} onRespond={vi.fn()} onCancel={vi.fn()} />,
    )

    // A plan-review intent inside a multi-question ask stays in the generic flow.
    expect(screen.getByText('INPUT NEEDED')).toBeDefined()
    expect(screen.getByText('Refactor')).toBeDefined()
    expect(screen.getByText('1. Do it')).toBeDefined()
    expect(screen.getByText('Run the plan now')).toBeDefined()
    expect(screen.getByText('Stop here')).toBeDefined()
    expect(screen.getAllByText('Who to notify?').length).toBeGreaterThan(0)
    expect(screen.queryByText(/approves the plan/)).toBeNull()
  })

  it('localizes the interaction chrome without changing upstream question content', () => {
    window.localStorage.setItem('dsh-webview-locale', 'zh')
    render(
      <I18nProvider>
        <UserQuestionCard
          question={batchQuestion()}
          disabled={false}
          onRespond={vi.fn()}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(screen.getByText('需要输入')).toBeDefined()
    expect(screen.getByRole('button', { name: '提交' })).toBeDefined()
    expect(screen.getAllByText('Proceed with this plan?')).toHaveLength(2)
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
    fireEvent.click(screen.getByRole('radio', { name: /Approve/ }))
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

  it('keeps a free-text-only answer as custom without selections', () => {
    const onRespond = vi.fn()
    render(
      <UserQuestionCard
        question={{
          id: 'q-free',
          sessionId: 's1',
          prompt: 'Name the branch',
          allowFreeText: true,
        }}
        disabled={false}
        onRespond={onRespond}
        onCancel={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('Answer for Name the branch'), {
      target: { value: 'feature/question-batch' },
    })
    fireEvent.click(submitButton())

    expect(onRespond).toHaveBeenCalledWith([{ id: 'q-free', response: [], custom: 'feature/question-batch' }])
  })

  it('falls back to the legacy single-question shape without items', () => {
    const onRespond = vi.fn()
    render(
      <UserQuestionCard
        question={{
          id: 'q1',
          sessionId: 's1',
          prompt: 'Choose',
          choices: [{ id: 'Allow', label: 'Allow' }],
          allowFreeText: false,
        }}
        disabled={false}
        onRespond={onRespond}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByText('INPUT NEEDED')).toBeDefined()
    expect(screen.getByLabelText('Answer for Choose')).toBeDefined()
    fireEvent.click(screen.getByLabelText('Allow'))
    fireEvent.click(submitButton())
    expect(onRespond).toHaveBeenCalledWith([{ id: 'q1', response: ['Allow'] }])
  })

  it('stays disabled until every question has an answer', () => {
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
    expect(submitButton().disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Alice'))
    expect(submitButton().disabled).toBe(false)
  })

  it('encodes an official Skip as selected: [] without custom text', () => {
    const onRespond = vi.fn()
    render(
      <UserQuestionCard
        question={batchQuestion()}
        disabled={false}
        onRespond={onRespond}
        onCancel={vi.fn()}
      />,
    )

    const skipButtons = screen.getAllByRole('button', { name: 'Skip this question' })
    fireEvent.click(skipButtons[0]!)
    fireEvent.click(skipButtons[1]!)
    fireEvent.click(submitButton())
    expect(onRespond).toHaveBeenCalledWith([
      { id: 'q-plan', response: [] },
      { id: 'q-extra', response: [] },
    ])
  })

  it('clears a single selection when custom text is entered', () => {
    const onRespond = vi.fn()
    render(
      <UserQuestionCard
        question={{
          id: 'q1',
          sessionId: 's1',
          prompt: 'Choose',
          choices: [{ id: 'Allow', label: 'Allow' }],
          allowFreeText: true,
        }}
        disabled={false}
        onRespond={onRespond}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByLabelText('Allow'))
    fireEvent.change(screen.getByLabelText('Answer for Choose'), { target: { value: 'Something else' } })
    fireEvent.click(submitButton())
    expect(onRespond).toHaveBeenCalledWith([{ id: 'q1', response: [], custom: 'Something else' }])
  })

  it('keeps the actions row outside the scrolling question body', () => {
    const { container } = render(
      <UserQuestionCard question={batchQuestion()} disabled={false} onRespond={vi.fn()} onCancel={vi.fn()} />,
    )

    const card = container.querySelector('.dsh-interaction')
    const body = container.querySelector('.dsh-interaction__body')
    const actions = container.querySelector('.dsh-interaction__actions')
    expect(card).not.toBeNull()
    expect(body?.parentElement).toBe(card)
    expect(actions?.parentElement).toBe(card)
    expect(body?.contains(actions ?? null)).toBe(false)
    expect(body?.querySelectorAll('.dsh-question__item')).toHaveLength(2)
    expect(actions?.querySelectorAll('.dsh-button')).toHaveLength(2)
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
    expect(screen.getByText('PLAN REVIEW')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Skip this question' })).toBeNull()
    // The generic Submit can never be enabled for a review, so the decision row
    // is the only footer.
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Chat about it' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('claims timed foreground waits, shows the host countdown, and releases on unmount', async () => {
    const onAttachWait = vi.fn().mockResolvedValue(2_400)
    const onReleaseWait = vi.fn().mockResolvedValue(undefined)
    const { unmount } = render(
      <UserQuestionCard
        question={{
          id: 'scope',
          callId: 'call-timed',
          sessionId: 's1',
          prompt: 'Which scope?',
          allowFreeText: true,
          timed: true,
          state: 'open',
        }}
        disabled={false}
        onRespond={vi.fn()}
        onCancel={vi.fn()}
        onAttachWait={onAttachWait}
        onReleaseWait={onReleaseWait}
      />,
    )

    await waitFor(() => expect(onAttachWait).toHaveBeenCalledOnce())
    expect(await screen.findByText(/You have 3 seconds to answer/u)).toBeDefined()
    expect(submitButton().disabled).toBe(true)
    unmount()
    expect(onReleaseWait).toHaveBeenCalledOnce()
  })

  it('keeps one timed claim when unrelated renders replace the host callbacks', async () => {
    const onAttachWait = vi.fn().mockResolvedValue(4_000)
    const originalRelease = vi.fn().mockResolvedValue(undefined)
    const currentRelease = vi.fn().mockResolvedValue(undefined)
    const nextAttach = vi.fn().mockResolvedValue(1_000)
    const question: UserQuestion = {
      id: 'scope',
      callId: 'call-stable',
      sessionId: 's1',
      prompt: 'Which scope?',
      allowFreeText: true,
      timed: true,
      state: 'open',
    }
    const view = render(
      <UserQuestionCard
        question={question}
        disabled={false}
        onRespond={vi.fn()}
        onCancel={vi.fn()}
        onAttachWait={onAttachWait}
        onReleaseWait={originalRelease}
      />,
    )

    await waitFor(() => expect(onAttachWait).toHaveBeenCalledOnce())
    view.rerender(
      <UserQuestionCard
        question={{ ...question }}
        disabled={false}
        onRespond={vi.fn()}
        onCancel={vi.fn()}
        onAttachWait={nextAttach}
        onReleaseWait={currentRelease}
      />,
    )

    expect(nextAttach).not.toHaveBeenCalled()
    view.unmount()
    expect(originalRelease).not.toHaveBeenCalled()
    expect(currentRelease).toHaveBeenCalledOnce()
  })

  it('releases its host route if the timed stream ends before returning a duration', async () => {
    const onReleaseWait = vi.fn().mockResolvedValue(undefined)
    const { unmount } = render(
      <UserQuestionCard
        question={{
          id: 'scope',
          callId: 'call-ended',
          sessionId: 's1',
          prompt: 'Which scope?',
          allowFreeText: true,
          timed: true,
          state: 'open',
        }}
        disabled={false}
        onRespond={vi.fn()}
        onCancel={vi.fn()}
        onAttachWait={() => Promise.resolve(undefined)}
        onReleaseWait={onReleaseWait}
      />,
    )

    await waitFor(() => expect(onReleaseWait).toHaveBeenCalledOnce())
    unmount()
  })

  it('releases the timed claim when the foreground countdown expires', async () => {
    const onReleaseWait = vi.fn().mockResolvedValue(undefined)
    const { unmount } = render(
      <UserQuestionCard
        question={{
          id: 'scope',
          callId: 'call-expiring',
          sessionId: 's1',
          prompt: 'Which scope?',
          allowFreeText: true,
          timed: true,
          state: 'open',
        }}
        disabled={false}
        onRespond={vi.fn()}
        onCancel={vi.fn()}
        onAttachWait={() => Promise.resolve(1)}
        onReleaseWait={onReleaseWait}
      />,
    )

    await waitFor(() => expect(onReleaseWait).toHaveBeenCalledOnce(), { timeout: 1_500 })
    unmount()
  })

  it('restores a queued late reply after Inbox discards it', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    const question: UserQuestion = {
      id: 'call-late',
      callId: 'call-late',
      sessionId: 's1',
      prompt: 'Which scope?',
      allowFreeText: true,
      timed: true,
      state: 'continued',
    }
    const { rerender } = render(
      <UserQuestionCard question={question} disabled={false} onRespond={onRespond} onCancel={vi.fn()} />,
    )

    fireEvent.change(screen.getByLabelText('Answer for Which scope?'), { target: { value: 'workspace' } })
    fireEvent.click(submitButton())
    expect(await screen.findByText('Answer queued for the next agent turn')).toBeDefined()

    rerender(
      <UserQuestionCard
        question={{ ...question, replyQueued: true }}
        disabled={false}
        onRespond={onRespond}
        onCancel={vi.fn()}
      />,
    )
    rerender(
      <UserQuestionCard
        question={{ ...question, replyQueued: false }}
        disabled={false}
        onRespond={onRespond}
        onCancel={vi.fn()}
      />,
    )

    await waitFor(() => expect(submitButton().disabled).toBe(false))
    expect(screen.queryByText('Answer queued for the next agent turn')).toBeNull()
    expect(onRespond).toHaveBeenCalledOnce()
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
