// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TodoView } from '@dsh-vscode/domain'
import { TodoList } from './TodoList.js'

const todos: readonly TodoView[] = [
  { id: 'todo-1', content: '查询系统信息', status: 'completed' },
  { id: 'todo-2', content: '执行子代理调研', status: 'in-progress' },
  { id: 'todo-3', content: '整理最终答案', status: 'pending' },
]

describe('TodoList', () => {
  afterEach(() => cleanup())

  it('starts collapsed with the current task and progress', () => {
    render(<TodoList todos={todos} />)

    const list = screen.getByRole('region', { name: 'Current to-do list' })
    const toggle = screen.getByRole('button', { name: 'Expand tasks' })
    expect(within(list).getByText('1/3 completed')).toBeDefined()
    expect(toggle.textContent).toContain('执行子代理调研')
    expect(toggle.textContent).toContain('In progress')
    expect(toggle.textContent).not.toContain('查询系统信息')
    expect(toggle.textContent).not.toContain('整理最终答案')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(within(list).getByText('1 completed · 1 in progress · 1 pending')).toBeDefined()
  })

  it('toggles when the outer card surface is clicked', () => {
    render(<TodoList todos={todos} />)

    const list = screen.getByRole('region', { name: 'Current to-do list' })
    const toggle = screen.getByRole('button', { name: 'Expand tasks' })

    fireEvent.click(list)

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'Collapse tasks' })).toBeDefined()
  })

  it('renders nothing when no task exists', () => {
    const { container } = render(<TodoList todos={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('expands to show every task and its semantic status', () => {
    render(<TodoList todos={todos} />)

    const list = screen.getByRole('region', { name: 'Current to-do list' })
    const disclosure = list.querySelector<HTMLElement>('.dsh-todo-list__disclosure')
    expect(disclosure?.getAttribute('data-open')).toBe('false')
    expect(disclosure?.querySelector('.dsh-todo-list__items')?.getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Expand tasks' }))

    expect(disclosure?.getAttribute('data-open')).toBe('true')
    expect(disclosure?.querySelector('.dsh-todo-list__items')?.getAttribute('aria-hidden')).toBe('false')
    expect(within(list).getByText('查询系统信息')).toBeDefined()
    expect(within(list).getByText('Completed')).toBeDefined()
    expect(within(list).getByText('执行子代理调研')).toBeDefined()
    expect(within(list).getByText('In progress')).toBeDefined()
    expect(within(list).getByText('整理最终答案')).toBeDefined()
    expect(within(list).getByText('Pending')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Collapse tasks' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('falls back to the first pending task when no task is in progress', () => {
    const pendingTodos: readonly TodoView[] = [
      { id: 'todo-1', content: '完成第一项', status: 'pending' },
      { id: 'todo-2', content: '完成第二项', status: 'pending' },
      { id: 'todo-3', content: '已完成', status: 'completed' },
    ]
    render(<TodoList todos={pendingTodos} />)

    const list = screen.getByRole('region', { name: 'Current to-do list' })
    const toggle = screen.getByRole('button', { name: 'Expand tasks' })
    expect(within(list).getByText('1/3 completed')).toBeDefined()
    expect(toggle.textContent).toContain('完成第一项')
    expect(toggle.textContent).toContain('Pending')

    fireEvent.click(toggle)
    expect(within(list).getByText('1 completed · 0 in progress · 2 pending')).toBeDefined()
  })
})
