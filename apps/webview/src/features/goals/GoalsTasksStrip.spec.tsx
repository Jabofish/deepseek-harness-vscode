// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { GoalView, TodoView } from '@dsh-vscode/domain'
import { GoalsTasksStrip } from './GoalsTasksStrip.js'

const goal: GoalView = { id: 'g1', title: 'Ship the redesign', status: 'in-progress' }
const todos: readonly TodoView[] = [
  { id: 't1', content: 'Draft the migration guide', status: 'in-progress' },
  { id: 't2', content: 'Wire the release notes', status: 'pending' },
]

/** The strip's own disclosure, never the TodoList's nested one. */
function goalsTasksDisclosure(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('.dsh-goals-tasks__disclosure')
  if (element === null) throw new Error('expected the goals/tasks disclosure')
  return element
}

describe('GoalsTasksStrip', () => {
  afterEach(() => cleanup())

  it('renders nothing when there are neither goals nor tasks', () => {
    const { container } = render(<GoalsTasksStrip goals={[]} todos={[]} />)
    expect(container.firstChild).toBeNull()
    expect(screen.queryByRole('region', { name: 'Goals and tasks' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Expand goals and tasks' })).toBeNull()
  })

  it('starts collapsed and names the toggle for expansion', () => {
    const { container } = render(<GoalsTasksStrip goals={[goal]} todos={[]} />)
    const toggle = screen.getByRole('button', { name: 'Expand goals and tasks' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(goalsTasksDisclosure(container).getAttribute('data-open')).toBe('false')
    // The dock is a labelled landmark even before it is opened.
    expect(screen.getByRole('region', { name: 'Goals and tasks' })).toBeDefined()
  })

  it('opens the disclosure and renames the toggle when clicked', () => {
    const { container } = render(<GoalsTasksStrip goals={[goal]} todos={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand goals and tasks' }))

    const toggle = screen.getByRole('button', { name: 'Collapse goals and tasks' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(goalsTasksDisclosure(container).getAttribute('data-open')).toBe('true')
  })

  it('collapses back to the closed default on a second click', () => {
    const { container } = render(<GoalsTasksStrip goals={[]} todos={todos} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand goals and tasks' }))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse goals and tasks' }))

    const toggle = screen.getByRole('button', { name: 'Expand goals and tasks' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(goalsTasksDisclosure(container).getAttribute('data-open')).toBe('false')
  })

  it('renders the active goal bar and goal strip inside the open disclosure', () => {
    const { container } = render(<GoalsTasksStrip goals={[goal]} todos={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand goals and tasks' }))

    const disclosure = goalsTasksDisclosure(container)
    expect(disclosure.getAttribute('data-open')).toBe('true')
    expect(disclosure.querySelector('[data-goal-bar]')).not.toBeNull()
    expect(disclosure.querySelector('.dsh-goal-strip')).not.toBeNull()
    // The active objective reaches the dock's own disclosure, not just the page.
    expect(within(disclosure).queryAllByText('Ship the redesign').length).toBeGreaterThan(0)
  })

  it('renders the todo list content inside the open disclosure', () => {
    const { container } = render(<GoalsTasksStrip goals={[]} todos={todos} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand goals and tasks' }))

    const disclosure = goalsTasksDisclosure(container)
    expect(disclosure.querySelector('.dsh-todo-list')).not.toBeNull()
    expect(within(disclosure).queryAllByText('Draft the migration guide').length).toBeGreaterThan(0)
    // A tasks-only dock has no goal surfaces.
    expect(disclosure.querySelector('[data-goal-bar]')).toBeNull()
    expect(disclosure.querySelector('.dsh-goal-strip')).toBeNull()
  })
})
