// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    fireEvent.click(screen.getByRole('button', { name: 'Chat about it' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
