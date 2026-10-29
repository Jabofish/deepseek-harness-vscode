// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@dsh-vscode/domain'
import { SessionTitlePicker } from './SessionTitlePicker.js'

afterEach(cleanup)
const session = (id: string, title = id): SessionSummary => ({
  id,
  title,
  workspaceId: 'w',
  blank: false,
  status: 'idle',
  createdAt: '',
  updatedAt: '',
})

it('opens live catalog sessions through the existing navigation callback and returns focus on Escape', async () => {
  const active = session('a', 'Alpha')
  const onOpen = vi.fn()
  const sessions = [active, session('b', 'Beta'), { ...session('child'), origin: 'subagent' as const }]
  render(<SessionTitlePicker active={active} sessions={sessions} onOpen={onOpen} />)
  const trigger = screen.getByRole('button', { name: 'Sessions: Alpha' })
  fireEvent.click(trigger)
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Alpha', 'Beta'])
  expect(screen.getByRole('option', { name: 'Alpha' }).getAttribute('aria-selected')).toBe('true')
  fireEvent.click(screen.getByRole('option', { name: 'Beta' }))
  expect(onOpen).toHaveBeenCalledExactlyOnceWith('b')
  expect(screen.queryByRole('listbox')).toBeNull()
  fireEvent.click(trigger)
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
  await waitFor(() => expect(document.activeElement).toBe(trigger))
})

it('retains the actual current title if the catalog is delayed and follows renames without reopening', () => {
  const active = session('a', 'Current')
  const onOpen = vi.fn()
  const view = render(<SessionTitlePicker active={active} sessions={[]} onOpen={onOpen} />)
  fireEvent.click(screen.getByRole('button', { name: 'Sessions: Current' }))
  fireEvent.click(screen.getByRole('option', { name: 'Current' }))
  expect(onOpen).not.toHaveBeenCalled()
  view.rerender(
    <SessionTitlePicker
      active={{ ...active, title: 'Renamed' }}
      sessions={[session('b', 'Beta')]}
      onOpen={onOpen}
    />,
  )
  expect(screen.getByRole('button', { name: 'Sessions: Renamed' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Sessions: Renamed' }))
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Renamed', 'Beta'])
})

it('keeps ordinary forks selectable after navigating back to their parent', () => {
  const parent = session('parent', 'Parent')
  const fork = { ...session('fork', 'Branch'), parentSessionId: parent.id }
  const sessions = [
    parent,
    fork,
    { ...session('child'), parentSessionId: parent.id, origin: 'subagent' as const },
  ]
  const onOpen = vi.fn()
  const view = render(<SessionTitlePicker active={fork} sessions={sessions} onOpen={onOpen} />)
  fireEvent.click(screen.getByRole('button', { name: 'Sessions: Branch' }))
  fireEvent.click(screen.getByRole('option', { name: 'Parent' }))
  expect(onOpen).toHaveBeenLastCalledWith('parent')
  view.rerender(<SessionTitlePicker active={parent} sessions={sessions} onOpen={onOpen} />)
  fireEvent.click(screen.getByRole('button', { name: 'Sessions: Parent' }))
  expect(screen.queryByRole('option', { name: 'child' })).toBeNull()
  fireEvent.click(screen.getByRole('option', { name: 'Branch' }))
  expect(onOpen).toHaveBeenLastCalledWith('fork')
})
