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

  it('shows every current task with progress and semantic status', () => {
    render(<TodoList todos={todos} />)

    const list = screen.getByRole('region', { name: 'Current to-do list' })
    expect(within(list).getByText('1/3 completed')).toBeDefined()
    expect(within(list).getByText('查询系统信息')).toBeDefined()
    expect(within(list).getByText('Completed')).toBeDefined()
    expect(within(list).getByText('执行子代理调研')).toBeDefined()
    expect(within(list).getByText('In progress')).toBeDefined()
    expect(within(list).getByText('整理最终答案')).toBeDefined()
    expect(within(list).getByText('Pending')).toBeDefined()
  })

  it('renders nothing when no task exists', () => {
    const { container } = render(<TodoList todos={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('collapses to one line containing only the current task', () => {
    render(<TodoList todos={todos} />)

    fireEvent.click(screen.getByRole('button', { name: 'Collapse tasks' }))

    const list = screen.getByRole('region', { name: 'Current to-do list' })
    expect(within(list).getByText('执行子代理调研')).toBeDefined()
    expect(within(list).getByText('In progress')).toBeDefined()
    expect(within(list).queryByText('查询系统信息')).toBeNull()
    expect(within(list).queryByText('整理最终答案')).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand tasks' }).getAttribute('aria-expanded')).toBe('false')
  })
})
