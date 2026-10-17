// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { GoalsTasksStrip } from './GoalsTasksStrip.js'

afterEach(cleanup)

it('hides collapsed goal controls and restores focus when Escape dismisses them', () => {
  const { container } = render(
    <GoalsTasksStrip
      goals={[{ id: 'g1', title: 'Objective', status: 'in-progress' }]}
      todos={[]}
      onClearGoal={vi.fn()}
    />,
  )
  const trigger = screen.getByRole('button', { name: 'Expand goals and tasks' })
  const panel = container.querySelector<HTMLElement>('.dsh-goals-tasks__disclosure')!
  expect(panel.hidden).toBe(true)
  expect(trigger.getAttribute('aria-controls')).toBe(panel.id)
  expect(screen.queryAllByRole('button')).toHaveLength(1)
  fireEvent.click(trigger)
  expect(panel.hidden).toBe(false)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(panel.hidden).toBe(true)
  expect(document.activeElement).toBe(trigger)
  fireEvent.click(trigger)
  fireEvent.pointerDown(document.body)
  expect(panel.hidden).toBe(true)
})
