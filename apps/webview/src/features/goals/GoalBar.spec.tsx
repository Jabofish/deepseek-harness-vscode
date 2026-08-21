// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GoalView } from '@dsh-vscode/domain'
import { GoalBar } from './GoalBar.js'

const goal: GoalView = { id: 'g1', title: 'Ship the redesign', status: 'in-progress' }

describe('GoalBar', () => {
  afterEach(() => cleanup())

  it('renders the active goal with pause, edit and clear actions', () => {
    render(
      <GoalBar
        goals={[goal]}
        onUpdate={vi.fn(() => Promise.resolve())}
        onClear={vi.fn(() => Promise.resolve())}
      />,
    )
    expect(screen.getByText('Ship the redesign')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Pause goal' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Edit goal' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Clear goal' })).toBeDefined()
  })

  it('edits the objective and maps pause/resume to host goal status values', async () => {
    const onUpdate = vi.fn(() => Promise.resolve())
    const { rerender } = render(<GoalBar goals={[goal]} onUpdate={onUpdate} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Goal objective' }), {
      target: { value: 'Ship v2' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save goal' }))
    expect(onUpdate).toHaveBeenCalledWith('g1', { title: 'Ship v2' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause goal' })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Pause goal' }))
    expect(onUpdate).toHaveBeenCalledWith('g1', { status: 'pending' })

    rerender(<GoalBar goals={[{ ...goal, status: 'pending' }]} onUpdate={onUpdate} />)
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Resume goal' }).disabled).toBe(false),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Resume goal' }))
    expect(onUpdate).toHaveBeenCalledWith('g1', { status: 'in-progress' })
  })

  it('does not render completed-only goals', () => {
    const { container } = render(<GoalBar goals={[{ ...goal, status: 'completed' }]} />)
    expect(container.firstChild).toBeNull()
  })
})
