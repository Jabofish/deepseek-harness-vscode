// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GoalView } from '@dsh-vscode/domain'
import { GoalBar } from './GoalBar.js'

const goal: GoalView = { id: 'g1', title: 'Ship the redesign', status: 'in-progress' }

describe('GoalBar', () => {
  afterEach(() => cleanup())

  it('requires a fresh clear confirmation when the active goal changes', () => {
    const onClear = vi.fn(() => Promise.resolve())
    const { rerender } = render(<GoalBar goals={[goal]} onClear={onClear} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear goal' }))
    expect(screen.getByRole('status').textContent).toBe('Press again to clear this goal')

    const nextGoal = { ...goal, id: 'g2', title: 'Ship the next release' }
    rerender(<GoalBar goals={[nextGoal]} onClear={onClear} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear goal' }))
    expect(onClear).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Press again to clear this goal' }))
    expect(onClear).toHaveBeenCalledOnce()
    expect(onClear).toHaveBeenCalledWith('g2')
  })

  it('explains a blocked goal with the host block reason', () => {
    const { container } = render(
      <GoalBar
        goals={[
          {
            ...goal,
            status: 'blocked',
            blockedReason: { code: 'awaiting-input', message: 'Waiting for user input' },
          },
        ]}
        onUpdate={vi.fn(() => Promise.resolve())}
      />,
    )
    const bar = container.querySelector('[data-goal-bar]')
    expect(bar?.getAttribute('title')).toBe('Waiting for user input')
  })

  describe('an open editor against a live goal list', () => {
    // The goal list is re-read from the host on ordinary session events, so the
    // host's objective can change while the inline input is open. The draft is a
    // copy, and Save posts whatever it holds.

    it('keeps the words the user typed instead of replacing them', () => {
      const onUpdate = vi.fn(() => Promise.resolve())
      const { rerender } = render(<GoalBar goals={[goal]} onUpdate={onUpdate} />)
      fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Goal objective' }), {
        target: { value: 'Ship v2' },
      })

      rerender(<GoalBar goals={[{ ...goal, title: 'Ship it later' }]} onUpdate={onUpdate} />)

      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Goal objective' }).value).toBe('Ship v2')
    })
  })
})
