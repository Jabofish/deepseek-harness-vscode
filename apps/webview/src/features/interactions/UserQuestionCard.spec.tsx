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
          allowFreeText: true,
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

  it('keeps the answer submittable when the host reports no remaining time', async () => {
    // Upstream suspends the Host deadline while a Client holds the claim
    // (`TimedQuestionWait.schedule` returns early when `claims.size > 0`), so a
    // card that is still on screen is still answerable. A zero frame means the
    // wait is over, not that the question became unanswerable — disabling
    // Submit there strands the user with a question upstream still accepts.
    const onRespond = vi.fn().mockResolvedValue(undefined)
    const onReleaseWait = vi.fn().mockResolvedValue(undefined)
    render(
      <UserQuestionCard
        question={{
          id: 'scope',
          callId: 'call-timed',
          sessionId: 's1',
          prompt: 'Which scope?',
          choices: [{ id: 'workspace', label: 'workspace' }],
          allowFreeText: true,
          timed: true,
          state: 'open',
        }}
        disabled={false}
        onRespond={onRespond}
        onCancel={vi.fn()}
        onAttachWait={vi.fn().mockResolvedValue(0)}
        onReleaseWait={onReleaseWait}
      />,
    )

    fireEvent.click(screen.getByRole('radio', { name: /workspace/ }))
    await waitFor(() => expect(onReleaseWait).toHaveBeenCalled())

    expect(submitButton().disabled).toBe(false)
    fireEvent.click(submitButton())
    await waitFor(() => expect(onRespond).toHaveBeenCalledOnce())
  })

  it('lets the user answer while the timed claim is still connecting', async () => {
    // `attach()` resolves only after the Host answers the claim, and nothing
    // bounds that round trip. Until it settles `waitReady` is false, so a card
    // that gates Submit on `waitReady` shows a disabled button with no Retry and
    // no other way forward: the question is on screen, the user has picked an
    // answer, and every control that could send it is inert. Upstream has not
    // refused the batch at that point, so the card must not refuse it either.
    const onRespond = vi.fn().mockResolvedValue(undefined)
    render(
      <UserQuestionCard
        question={{
          id: 'scope',
          callId: 'call-timed',
          sessionId: 's1',
          prompt: 'Which scope?',
          choices: [{ id: 'workspace', label: 'workspace' }],
          allowFreeText: true,
          timed: true,
          state: 'open',
        }}
        disabled={false}
        onRespond={onRespond}
        onCancel={vi.fn()}
        onAttachWait={() => new Promise<number | undefined>(() => undefined)}
        onReleaseWait={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(await screen.findByText('Connecting to the timed question…')).toBeDefined()
    fireEvent.click(screen.getByRole('radio', { name: /workspace/ }))
    expect(submitButton().disabled).toBe(false)
    fireEvent.click(submitButton())
    await waitFor(() => expect(onRespond).toHaveBeenCalledOnce())
  })

  it('freezes the answer fields when the timed wait fails', async () => {
    // A failed claim is the one timed state where Submit is genuinely blocked
    // (`question.waitUnavailable` says to reconnect). While that message is on
    // screen the fields must not keep accepting edits, or the user retypes an
    // answer into a card whose Submit is disabled and whose only exit is Retry.
    render(
      <UserQuestionCard
        question={{
          id: 'scope',
          callId: 'call-timed',
          sessionId: 's1',
          prompt: 'Which scope?',
          choices: [{ id: 'workspace', label: 'workspace' }],
          allowFreeText: true,
          timed: true,
          state: 'open',
        }}
        disabled={false}
        onRespond={vi.fn()}
        onCancel={vi.fn()}
        onAttachWait={vi.fn().mockRejectedValue(new Error('claim refused'))}
        onReleaseWait={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(await screen.findByText(/could not be claimed/u)).toBeDefined()
    expect(screen.getByRole('radio', { name: /workspace/ }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByLabelText('Answer for Which scope?').hasAttribute('disabled')).toBe(true)
    expect(submitButton().disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
  })

  it('reads the countdown as singular when one second remains', async () => {
    // The card polls every 250ms and rounds up, so the last whole second is a
    // state the user reliably sees. The catalog has no plural handling, so the
    // singular has to be its own message rather than a hardcoded "seconds".
    render(
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
        onAttachWait={vi.fn().mockResolvedValue(1_000)}
        onReleaseWait={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(await screen.findByText('You have 1 second to answer')).toBeDefined()
    expect(screen.queryByText(/1 seconds/u)).toBeNull()
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

  it('keeps the ticking countdown out of a live region', async () => {
    // The countdown updates every 250ms. Announcing it through `aria-live` or
    // `role="status"` makes a screen reader speak "you have N seconds" four
    // times a second, drowning the question the user actually has to answer;
    // the surrounding container already announces the card's arrival.
    const { container } = render(
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
        onAttachWait={vi.fn().mockResolvedValue(60_000)}
        onReleaseWait={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    await waitFor(() => expect(screen.getByText(/seconds to answer/u)).toBeDefined())
    const countdown = screen.getByText(/seconds to answer/u)
    const region = countdown.closest('[role="status"], [aria-live]')
    expect(region).toBeNull()
    expect(container.querySelector('.dsh-question__wait')?.getAttribute('role')).toBeNull()
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

  describe('answers a plan review with the option label', () => {
    // Upstream carries no option id: `options` hold a `label`, the asker checks
    // `intent.approve` against `option.label`, and the answer batch carries
    // those labels. The adapters derive `choice.id` from the label today, so
    // these tests pin the submitted value rather than a distinction that the
    // wire cannot currently express.
    function reviewQuestion(): UserQuestion {
      return {
        id: 'call-review',
        callId: 'call-review',
        sessionId: 's1',
        prompt: 'Proceed?',
        allowFreeText: true,
        state: 'open',
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
      }
    }

    it('submits the approve option', async () => {
      const onRespond = vi.fn().mockResolvedValue(undefined)
      render(
        <UserQuestionCard
          question={reviewQuestion()}
          disabled={false}
          onRespond={onRespond}
          onCancel={vi.fn()}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

      await waitFor(() => expect(onRespond).toHaveBeenCalledOnce())
      expect(onRespond).toHaveBeenCalledWith([{ id: 'decision', response: ['Approve'] }])
    })

    it('submits the non-approve option through the refuse control', async () => {
      const onRespond = vi.fn().mockResolvedValue(undefined)
      render(
        <UserQuestionCard
          question={reviewQuestion()}
          disabled={false}
          onRespond={onRespond}
          onCancel={vi.fn()}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Refuse' }))

      await waitFor(() => expect(onRespond).toHaveBeenCalledOnce())
      expect(onRespond).toHaveBeenCalledWith([{ id: 'decision', response: ['Decline'] }])
    })
  })

  describe('a question that forbids free text', () => {
    // The DSH answer contract rejects any batch that carries `custom` for an
    // item whose `allowFreeText` is not true -- `interaction-repository`
    // `singleAnswer` refuses it before the Host ever sees it. Offering the box
    // anyway invites an answer the app cannot deliver.
    function noFreeTextQuestion(): UserQuestion {
      return {
        id: 'q-strict',
        sessionId: 's1',
        prompt: 'Pick a target',
        allowFreeText: false,
        items: [
          {
            id: 'q-strict',
            prompt: 'Pick a target',
            choices: [
              { id: 'Web', label: 'Web' },
              { id: 'Mobile', label: 'Mobile' },
            ],
            allowFreeText: false,
          },
        ],
      }
    }

    it('offers no free-text box', () => {
      render(
        <UserQuestionCard
          question={noFreeTextQuestion()}
          disabled={false}
          onRespond={vi.fn()}
          onCancel={vi.fn()}
        />,
      )

      expect(screen.queryByLabelText('Answer for Pick a target')).toBeNull()
      expect(document.querySelectorAll('.dsh-question__field')).toHaveLength(0)
    })

    it('keeps submit disabled until a choice is picked', () => {
      render(
        <UserQuestionCard
          question={noFreeTextQuestion()}
          disabled={false}
          onRespond={vi.fn()}
          onCancel={vi.fn()}
        />,
      )

      // With no custom box there is no way to answer by typing, so submit must
      // wait for a selection instead of counting an empty draft as complete.
      expect(submitButton().disabled).toBe(true)
      fireEvent.click(screen.getByLabelText('Web'))
      expect(submitButton().disabled).toBe(false)
    })

    it('answers with the selected label and no custom text', () => {
      const onRespond = vi.fn()
      render(
        <UserQuestionCard
          question={noFreeTextQuestion()}
          disabled={false}
          onRespond={onRespond}
          onCancel={vi.fn()}
        />,
      )

      fireEvent.click(screen.getByLabelText('Mobile'))
      fireEvent.click(submitButton())

      expect(onRespond).toHaveBeenCalledWith([{ id: 'q-strict', response: ['Mobile'] }])
    })

    it('still offers free text when the item allows it, even alongside choices', () => {
      render(
        <UserQuestionCard
          question={{
            ...noFreeTextQuestion(),
            allowFreeText: true,
            items: [{ ...noFreeTextQuestion().items![0]!, allowFreeText: true }],
          }}
          disabled={false}
          onRespond={vi.fn()}
          onCancel={vi.fn()}
        />,
      )

      expect(screen.getByLabelText('Answer for Pick a target')).toBeDefined()
    })
  })
})
