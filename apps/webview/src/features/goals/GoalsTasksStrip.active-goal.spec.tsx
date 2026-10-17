// @vitest-environment jsdom

import { cleanup, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { GoalView, TodoView } from '@dsh-vscode/domain'
import { GoalsTasksStrip } from './GoalsTasksStrip.js'

const goal: GoalView = { id: 'g1', title: 'Ship the redesign', status: 'in-progress' }

/** The dock collapses everything behind one header: its label, the active
 * goal's status pill and the completion count are the everyday signal, so the
 * assertions stay inside that toggle rather than the expanded body. */
function headerOf(container: HTMLElement): HTMLElement {
  const toggle = container.querySelector<HTMLElement>('.dsh-goals-tasks__toggle')
  if (toggle === null) throw new Error('GoalsTasksStrip did not render its toggle header')
  return toggle
}

function labelOf(header: HTMLElement): string | null | undefined {
  return header.querySelector('.dsh-goals-tasks__label')?.textContent
}

describe('GoalsTasksStrip active goal', () => {
  afterEach(() => cleanup())

  it('heads the dock with an in-progress goal title and its pill', () => {
    const { container } = render(<GoalsTasksStrip goals={[goal]} todos={[]} />)
    const header = headerOf(container)

    expect(labelOf(header)).toBe('Ship the redesign')
    expect(within(header).getByText('Ship the redesign')).toBeDefined()
    const pill = header.querySelector('.dsh-status-pill')
    expect(pill?.textContent).toBe('In progress')
    expect(pill?.classList.contains('dsh-status-pill--in-progress')).toBe(true)
  })

  it('reports a blocked goal with the blocked pill', () => {
    const blocked: GoalView = {
      ...goal,
      status: 'blocked',
      blockedReason: { code: 'awaiting-input', message: 'Waiting for user input' },
    }
    const { container } = render(<GoalsTasksStrip goals={[blocked]} todos={[]} />)
    const header = headerOf(container)

    const pill = header.querySelector('.dsh-status-pill')
    expect(pill?.textContent).toBe('Blocked')
    expect(pill?.classList.contains('dsh-status-pill--blocked')).toBe(true)
  })

  it('falls back to the tasks label, without a pill, when only todos exist', () => {
    const todos: readonly TodoView[] = [
      { id: 't1', content: 'Write the tests', status: 'in-progress' },
      { id: 't2', content: 'Ship the tests', status: 'pending' },
    ]
    const { container } = render(<GoalsTasksStrip goals={[]} todos={todos} />)
    const header = headerOf(container)

    expect(labelOf(header)).toBe('Tasks')
    expect(within(header).queryByText('Goals')).toBeNull()
    expect(header.querySelector('.dsh-status-pill')).toBeNull()
  })

  it('falls back to the goals label when every goal is completed', () => {
    const { container } = render(<GoalsTasksStrip goals={[{ ...goal, status: 'completed' }]} todos={[]} />)
    const header = headerOf(container)

    expect(labelOf(header)).toBe('Goals')
    expect(header.querySelector('.dsh-status-pill')).toBeNull()
  })

  it('counts the active goal and its unfinished todos', () => {
    const todos: readonly TodoView[] = [
      { id: 't1', content: 'Write the tests', status: 'completed' },
      { id: 't2', content: 'Review the tests', status: 'pending' },
      { id: 't3', content: 'Ship the tests', status: 'in-progress' },
    ]
    const { container } = render(<GoalsTasksStrip goals={[goal]} todos={todos} />)

    const progress = within(headerOf(container)).getByRole('status', { name: '1/4 complete' })
    expect(progress.textContent).toBe('1/4')
  })

  it('sums completed goals and completed todos in one count', () => {
    const goals: readonly GoalView[] = [
      { id: 'g1', title: 'Ship the redesign', status: 'completed' },
      { id: 'g2', title: 'Ship the follow-up', status: 'in-progress' },
    ]
    const todos: readonly TodoView[] = [
      { id: 't1', content: 'Write the tests', status: 'completed' },
      { id: 't2', content: 'Review the tests', status: 'in-progress' },
    ]
    const { container } = render(<GoalsTasksStrip goals={goals} todos={todos} />)
    const header = headerOf(container)

    expect(labelOf(header)).toBe('Ship the follow-up')
    const progress = within(header).getByRole('status', { name: '2/4 complete' })
    expect(progress.textContent).toBe('2/4')
  })
})
