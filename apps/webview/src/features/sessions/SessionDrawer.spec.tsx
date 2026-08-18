// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary, WorkspaceSummary } from '@dsh-vscode/domain'
import { SessionDrawer } from './SessionDrawer.js'

const workspaces: readonly WorkspaceSummary[] = [
  {
    id: 'w1',
    name: 'Alpha',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionIds: ['s1', 's2'],
    sessionCount: 2,
  },
  {
    id: 'w2',
    name: 'Beta',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionIds: ['s3'],
    sessionCount: 1,
  },
]

function session(partial: Partial<SessionSummary> & { id: string; title: string }): SessionSummary {
  return {
    workspaceId: 'w1',
    blank: false,
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  }
}

const sessions: readonly SessionSummary[] = [
  session({ id: 's1', title: 'Fix login bug', updatedAt: '2026-01-03T00:00:00.000Z' }),
  session({ id: 's2', title: 'Write docs', updatedAt: '2026-01-05T00:00:00.000Z' }),
  session({ id: 's3', title: 'Other workspace note', workspaceId: 'w2' }),
]

function renderDrawer(
  overrides: Partial<Parameters<typeof SessionDrawer>[0]> = {},
): ReturnType<typeof render> {
  const onSearch = vi.fn().mockResolvedValue([])
  const props = {
    sessions,
    workspaces,
    activeSessionId: 's1',
    open: true,
    showTrigger: false,
    onOpen: vi.fn(),
    onCreate: vi.fn(),
    onArchive: vi.fn().mockResolvedValue(undefined),
    onSearch,
    ...overrides,
  }
  return render(<SessionDrawer {...props} />)
}

describe('SessionDrawer', () => {
  afterEach(() => cleanup())

  it('filters the current workspace instantly by title substring', () => {
    renderDrawer()
    fireEvent.change(screen.getByLabelText('Search sessions by title or content'), {
      target: { value: 'login' },
    })
    expect(screen.getByTitle('Fix login bug')).toBeDefined()
    expect(screen.queryByTitle('Write docs')).toBeNull()
  })

  it('debounces host content search and surfaces other-workspace matches', async () => {
    const onSearch = vi.fn().mockResolvedValue([sessions[2]])
    renderDrawer({ onSearch })
    fireEvent.change(screen.getByLabelText('Search sessions by title or content'), {
      target: { value: 'note' },
    })
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith('note'))
    await waitFor(() => expect(screen.getByTitle('Other workspace note')).toBeDefined())
    await waitFor(() => expect(screen.getByText('Beta')).toBeDefined())
    expect(screen.getByText('Content matches')).toBeDefined()
  })

  it('switches between manual and last-updated ordering', () => {
    renderDrawer()
    const titles = (): (string | null)[] =>
      Array.from(
        screen.getAllByRole('list')[0]?.querySelectorAll('.dsh-session-item__copy strong') ?? [],
      ).map((node) => node.textContent)
    expect(titles()).toEqual(['Fix login bug', 'Write docs'])
    fireEvent.click(screen.getByTitle('Sort: manual. Switch to last updated.'))
    expect(titles()).toEqual(['Write docs', 'Fix login bug'])
  })

  it('keeps the sort control beside the new-session action', () => {
    renderDrawer()
    const sort = screen.getByTitle('Sort: manual. Switch to last updated.')
    const create = screen.getByRole('button', { name: 'New Session' })

    expect(sort.parentElement).toBe(create.parentElement)
    expect(sort.parentElement?.classList.contains('dsh-session-switcher__panel-actions')).toBe(true)
  })

  it('hides subagent children from the root conversation picker', () => {
    const subagent = session({
      id: 'child',
      title: 'Inspect the project layout',
      origin: 'subagent',
      parentSessionId: 's1',
      updatedAt: '2026-01-06T00:00:00.000Z',
    })
    renderDrawer({ sessions: [...sessions, subagent] })
    expect(screen.getByTitle('Fix login bug')).toBeDefined()
    expect(screen.getByTitle('Write docs')).toBeDefined()
    expect(screen.queryByTitle('Inspect the project layout')).toBeNull()
  })

  it('hides the active session when it is a subagent child', () => {
    const subagent = session({
      id: 'child',
      title: 'Inspect the project layout',
      origin: 'subagent',
      parentSessionId: 's1',
    })
    renderDrawer({ sessions: [...sessions, subagent], activeSessionId: 'child' })
    // Even while a subagent conversation is open, the root picker stays clean:
    // only user-facing root sessions are listed, so switching back to the
    // parent is one click away.
    expect(screen.getByTitle('Fix login bug')).toBeDefined()
    expect(screen.getByTitle('Write docs')).toBeDefined()
    expect(screen.queryByTitle('Inspect the project layout')).toBeNull()
  })
})
