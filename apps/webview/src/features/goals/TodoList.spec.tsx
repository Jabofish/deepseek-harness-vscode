// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TodoList } from './TodoList.js'
import type { TodoView } from '@dsh-vscode/domain'

afterEach(cleanup)

describe('TodoList', () => {
  const todos: TodoView[] = [
    { id: '1', content: 'First task', status: 'completed' },
    { id: '2', content: 'Second task', status: 'in-progress' },
    { id: '3', content: 'Third task', status: 'pending' },
  ]

  it('toggles expansion on click and collapses on Escape key', () => {
    render(<TodoList todos={todos} />)
    const toggle = screen.getByRole('button', { name: 'Expand tasks' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('First task')).toBeDefined()
    expect(screen.getByText('Second task')).toBeDefined()

    // Test Escape key collapses the list
    fireEvent.keyDown(toggle, { key: 'Escape' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('returns keyboard focus to the toggle when Escape hides the focused task list', () => {
    render(<TodoList todos={todos} />)
    const toggle = screen.getByRole('button', { name: 'Expand tasks' })
    fireEvent.click(toggle)
    const list = screen.getByRole('list')
    list.focus()
    fireEvent.keyDown(list, { key: 'Escape' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)
  })
})
