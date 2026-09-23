// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    onAddWorkspace: vi.fn().mockResolvedValue(undefined),
    onArchive: vi.fn().mockResolvedValue(undefined),
    archivedSessions: [],
    onLoadArchived: vi.fn().mockResolvedValue(undefined),
    onRestore: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn().mockResolvedValue(undefined),
    onRenameWorkspace: vi.fn().mockResolvedValue(undefined),
    onRemoveWorkspace: vi.fn().mockResolvedValue(undefined),
    onMoveWorkspace: vi.fn().mockResolvedValue(undefined),
    onMoveSession: vi.fn().mockResolvedValue(undefined),
    onSearch,
    ...overrides,
  }
  return render(<SessionDrawer {...props} />)
}

function createDataTransfer(): {
  effectAllowed: string
  dropEffect: string
  setData: ReturnType<typeof vi.fn>
  getData: ReturnType<typeof vi.fn>
} {
  let value = ''
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: vi.fn((_type: string, next: string) => {
      value = next
    }),
    getData: vi.fn(() => value),
  }
}

describe('SessionDrawer', () => {
  afterEach(() => cleanup())

  it('prioritizes approval, plan review and answers over running indicators', () => {
    renderDrawer({
      sessions: sessions.map((entry) => ({ ...entry, workspaceId: 'w1', status: 'running' })),
      permissions: [
        { id: 'p', sessionId: 's1', title: 'Approve', description: '', risk: 'low', options: [] },
      ],
      questions: [
        {
          id: 'q1',
          sessionId: 's2',
          prompt: 'Plan',
          allowFreeText: false,
          intent: { kind: 'plan-review', approve: 'yes' },
        },
        { id: 'q2', sessionId: 's3', prompt: 'Answer', allowFreeText: true },
      ],
    })
    for (const label of ['Waiting for approval', 'Waiting for plan review', 'Waiting for answer']) {
      expect(screen.getByRole('img', { name: label })).toBeDefined()
    }
    expect(screen.queryByRole('img', { name: 'Running' })).toBeNull()
  })

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
    await waitFor(() => expect(screen.getAllByText('Beta').length).toBeGreaterThan(0))
    expect(screen.getByText('Content matches')).toBeDefined()
  })

  it('keeps a pasted search query inside the session.search wire contract', async () => {
    const onSearch = vi.fn().mockResolvedValue([])
    renderDrawer({ onSearch })
    const input = screen.getByLabelText('Search sessions by title or content')

    // The host refuses a query over 500 UTF-16 code units or one carrying a NUL
    // with `bad-request`, so the field and the request must both stay inside the
    // wire contract instead of sending text the host can only reject.
    fireEvent.change(input, { target: { value: `${'x'.repeat(600)}\u0000tail` } })

    await waitFor(() => expect(onSearch).toHaveBeenCalled())
    const sent = onSearch.mock.calls.at(-1)?.[0] as string
    expect(sent).toHaveLength(500)
    expect(sent).not.toContain('\u0000')

    // Truncation must not cut a surrogate pair in half: the leading 499 units
    // plus an astral character would be 501, so the whole pair is dropped.
    fireEvent.change(input, { target: { value: `${'y'.repeat(499)}\u{1f600}` } })
    await waitFor(() => expect(onSearch).toHaveBeenCalledTimes(2))
    expect(onSearch.mock.calls.at(-1)?.[0]).toBe('y'.repeat(499))
  })

  it('reports an unavailable content search instead of an empty result set', async () => {
    const onSearch = vi.fn().mockRejectedValue(new Error('the host index is disabled'))
    renderDrawer({ onSearch })
    fireEvent.change(screen.getByLabelText('Search sessions by title or content'), {
      target: { value: 'note' },
    })

    // A refused content search is not "no sessions match": the host never
    // answered. The name filter above still applies, so the notice explains
    // which half of the search produced nothing.
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith('note'))
    const notice = await screen.findByRole('status')
    expect(notice.textContent).toContain('Content search is unavailable')
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

  it('pins the active blank New Session row before stale manual order', () => {
    const blank = session({
      id: 'blank',
      title: 'New Session',
      blank: true,
      status: 'idle',
      updatedAt: '2026-01-06T00:00:00.000Z',
    })
    renderDrawer({
      sessions: [sessions[0]!, blank, sessions[1]!],
      activeSessionId: 'blank',
    })
    const titles = Array.from(
      screen.getAllByRole('list')[0]?.querySelectorAll('.dsh-session-item__copy strong') ?? [],
    ).map((node) => node.textContent)
    expect(titles).toEqual(['New Session', 'Fix login bug', 'Write docs'])
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

  it('opens an existing root session when no session is active yet', () => {
    const onOpen = vi.fn()
    renderDrawer({ activeSessionId: undefined, onOpen })

    const sessionButton = screen.getByText('Fix login bug').closest('button')
    expect(sessionButton).not.toBeNull()
    fireEvent.click(sessionButton!)

    expect(onOpen).toHaveBeenCalledWith('s1')
  })

  it('opens a session rename dialog, warns about a duplicate, and saves the edited title', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onRename })

    fireEvent.click(screen.getAllByTitle('Rename session')[0]!)
    const input = screen.getByLabelText('Session name')
    fireEvent.change(input, { target: { value: 'Write docs' } })

    expect(screen.getByText('Another session in this workspace already uses this name.')).toBeDefined()
    fireEvent.change(input, { target: { value: 'Rename me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onRename).toHaveBeenCalledWith('s1', 'Rename me'))
    expect(screen.queryByRole('dialog', { name: 'Rename session' })).toBeNull()
  })

  it('scopes a rename conflict warning to the renamed session workspace', async () => {
    const peer = session({ id: 's4', title: 'Beta notes', workspaceId: 'w2' })
    const onSearch = vi.fn().mockResolvedValue([sessions[2]!])
    renderDrawer({ sessions: [...sessions, peer], onSearch })

    fireEvent.change(screen.getByLabelText('Search sessions by title or content'), {
      target: { value: 'note' },
    })
    await waitFor(() => expect(screen.getByTitle('Other workspace note')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'Rename session Other workspace note' }))
    const input = screen.getByLabelText('Session name')

    // "Write docs" only exists in Alpha; Beta has no such title.
    fireEvent.change(input, { target: { value: 'Write docs' } })
    expect(screen.queryByText('Another session in this workspace already uses this name.')).toBeNull()

    // "Beta notes" does live in Beta, the workspace this row belongs to.
    fireEvent.change(input, { target: { value: 'Beta notes' } })
    expect(screen.getByText('Another session in this workspace already uses this name.')).toBeDefined()
  })

  it('confirms workspace removal and keeps the destructive action explicit', async () => {
    const onRemoveWorkspace = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onRemoveWorkspace })

    fireEvent.click(screen.getByRole('button', { name: 'Remove workspace Alpha' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Remove workspace' })
    expect(dialog).toBeDefined()
    expect(dialog.parentElement?.parentElement).toBe(document.body)
    expect(screen.getByText('Remove “Alpha” from DSH? Its 2 session(s) and files will remain.')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(onRemoveWorkspace).toHaveBeenCalledWith('w1'))
  })

  it('dismisses the switcher on Escape and returns focus to its trigger', () => {
    const onOpenChange = vi.fn()
    renderDrawer({ open: true, showTrigger: true, onOpenChange })
    const trigger = screen.getByRole('button', { name: 'Switch session: Fix login bug' })
    trigger.focus()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('dismisses the switcher when the pointer goes elsewhere', () => {
    const onOpenChange = vi.fn()
    renderDrawer({ open: true, onOpenChange })

    fireEvent.pointerDown(document.body)

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('closes the switcher when its own trigger is pressed again', () => {
    renderDrawer({ open: undefined, showTrigger: true })
    const trigger = screen.getByRole('button', { name: 'Switch session: Fix login bug' })
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    // A real press is pointerdown then click. The layer only owns the panel, so
    // the pointerdown on the trigger reads as an outside press and closes the
    // switcher; the click then toggles it back open, and the trigger can never
    // close what it opened.
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)

    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('lets Escape dismiss the rename dialog before the switcher', () => {
    const onOpenChange = vi.fn()
    const onRename = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ open: true, onOpenChange, onRename })

    fireEvent.click(screen.getAllByTitle('Rename session')[0]!)
    expect(screen.getByRole('dialog', { name: 'Rename session' })).toBeDefined()

    fireEvent.keyDown(document, { key: 'Escape' })

    // The dialog is the innermost layer: the switcher underneath survives.
    expect(screen.queryByRole('dialog', { name: 'Rename session' })).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(onRename).not.toHaveBeenCalled()
  })

  it('cancels the workspace removal confirmation on Escape without removing anything', () => {
    const onOpenChange = vi.fn()
    const onRemoveWorkspace = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ open: true, onOpenChange, onRemoveWorkspace })

    fireEvent.click(screen.getByRole('button', { name: 'Remove workspace Alpha' }))
    expect(screen.getByRole('alertdialog', { name: 'Remove workspace' })).toBeDefined()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('alertdialog', { name: 'Remove workspace' })).toBeNull()
    expect(onRemoveWorkspace).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('keeps the removal confirmation while its removal is in flight', () => {
    const onRemoveWorkspace = vi.fn().mockImplementation(() => new Promise(() => undefined))
    renderDrawer({ open: true, onRemoveWorkspace })

    fireEvent.click(screen.getByRole('button', { name: 'Remove workspace Alpha' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.getByRole('alertdialog', { name: 'Remove workspace' })).toBeDefined()
  })

  it('keeps a pointer inside the rename dialog from dismissing the switcher', () => {
    const onOpenChange = vi.fn()
    renderDrawer({ open: true, onOpenChange })

    fireEvent.click(screen.getAllByTitle('Rename session')[0]!)
    fireEvent.pointerDown(screen.getByLabelText('Session name'))

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Rename session' })).toBeDefined()
  })

  it('switches to grouped workspace view and exposes explicit status badges', () => {
    renderDrawer()
    fireEvent.click(screen.getByTitle('Show sessions grouped by workspace'))

    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Beta').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0)
  })

  it('moves workspaces and sessions through host-backed drop targets', async () => {
    const onMoveWorkspace = vi.fn().mockResolvedValue(undefined)
    const onMoveSession = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onMoveWorkspace, onMoveSession })
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      value: '',
      setData: vi.fn((_type: string, value: string) => {
        dataTransfer.value = value
      }),
      getData: vi.fn(() => dataTransfer.value),
    }
    const workspaceCards = screen.getAllByTitle('Drag to reorder workspace')
    fireEvent.dragStart(workspaceCards[1]!, { dataTransfer })
    fireEvent.drop(workspaceCards[0]!, { dataTransfer })
    await waitFor(() => expect(onMoveWorkspace).toHaveBeenCalledWith('w2', 'w1'))

    const sessionRows = screen.getAllByTitle('Drag to reorder session')
    fireEvent.dragStart(sessionRows[1]!, { dataTransfer })
    fireEvent.drop(sessionRows[0]!, { dataTransfer })
    await waitFor(() => expect(onMoveSession).toHaveBeenCalledWith('w1', 's2', 's1'))
  })

  it('reports a rejected session move instead of dropping it silently', async () => {
    const onMoveSession = vi.fn().mockRejectedValue(new Error('Session order is stale.'))
    renderDrawer({ onMoveSession })

    const dataTransfer = createDataTransfer()
    const sessionRows = screen.getAllByTitle('Drag to reorder session')
    fireEvent.dragStart(sessionRows[1]!, { dataTransfer })
    fireEvent.drop(sessionRows[0]!, { dataTransfer })

    await waitFor(() => expect(onMoveSession).toHaveBeenCalledWith('w1', 's2', 's1'))
    expect((await screen.findByRole('alert')).textContent).toBe('Session order is stale.')
  })

  it('reports a rejected workspace move instead of dropping it silently', async () => {
    const onMoveWorkspace = vi.fn().mockRejectedValue(new Error('Workspace order is stale.'))
    renderDrawer({ onMoveWorkspace })

    const dataTransfer = createDataTransfer()
    const workspaceCards = screen.getAllByTitle('Drag to reorder workspace')
    fireEvent.dragStart(workspaceCards[1]!, { dataTransfer })
    fireEvent.drop(workspaceCards[0]!, { dataTransfer })

    await waitFor(() => expect(onMoveWorkspace).toHaveBeenCalledWith('w2', 'w1'))
    expect((await screen.findByRole('alert')).textContent).toBe('Workspace order is stale.')
  })

  it('falls back to a translated message when a move rejects without an Error', async () => {
    const onMoveSession = vi.fn().mockRejectedValue('nope')
    renderDrawer({ onMoveSession })

    const dataTransfer = createDataTransfer()
    const sessionRows = screen.getAllByTitle('Drag to reorder session')
    fireEvent.dragStart(sessionRows[1]!, { dataTransfer })
    fireEvent.drop(sessionRows[0]!, { dataTransfer })

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Unable to reorder.'))
  })

  it('takes focus into the workspace removal confirmation and gives it back to the row', () => {
    renderDrawer()

    const trigger = screen.getByRole('button', { name: 'Remove workspace Alpha' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('alertdialog', { name: 'Remove workspace' })
    expect(dialog.contains(document.activeElement)).toBe(true)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog', { name: 'Remove workspace' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('returns focus to the renamed row after the rename dialog closes', () => {
    renderDrawer()

    const trigger = screen.getAllByTitle('Rename session')[0]!
    trigger.focus()
    fireEvent.click(trigger)
    const input = screen.getByLabelText('Session name')
    expect(document.activeElement).toBe(input)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog', { name: 'Rename session' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('clears a reported move failure once a later move succeeds', async () => {
    const onMoveSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('Session order is stale.'))
      .mockResolvedValue(undefined)
    renderDrawer({ onMoveSession })

    const dataTransfer = createDataTransfer()
    const dragSecondOntoFirst = (): void => {
      const sessionRows = screen.getAllByTitle('Drag to reorder session')
      fireEvent.dragStart(sessionRows[1]!, { dataTransfer })
      fireEvent.drop(sessionRows[0]!, { dataTransfer })
    }
    dragSecondOntoFirst()
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined())

    dragSecondOntoFirst()
    await waitFor(() => expect(onMoveSession).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})

describe('workspace folder picker', () => {
  afterEach(() => cleanup())
  it('opens the host picker without choosing a path in the Webview', async () => {
    const onAddWorkspace = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onAddWorkspace })
    fireEvent.click(screen.getByRole('button', { name: 'Add folder to workspace' }))
    await waitFor(() => expect(onAddWorkspace).toHaveBeenCalledExactlyOnceWith())
  })
  it('reports picker failures and permits retry', async () => {
    const onAddWorkspace = vi
      .fn()
      .mockRejectedValueOnce(new Error('Picker unavailable'))
      .mockResolvedValue(undefined)
    renderDrawer({ onAddWorkspace })
    fireEvent.click(screen.getByRole('button', { name: 'Add folder to workspace' }))
    await waitFor(() => expect(screen.getByText('Picker unavailable')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Add folder to workspace' }))
    await waitFor(() => expect(onAddWorkspace).toHaveBeenCalledTimes(2))
  })
})

afterEach(() => cleanup())

it.each([false, true])('gates archived restore on advertised support: %s', async (canRestoreSessions) => {
  const onRestore = vi.fn().mockResolvedValue(undefined)
  renderDrawer({
    canRestoreSessions,
    onRestore,
    archivedSessions: [session({ id: 'old', title: 'Archived chat' })],
  })
  fireEvent.click(screen.getByRole('button', { name: /Archived/u }))
  const button = await screen.findByRole('button', { name: 'Restore session Archived chat' })
  expect((button as HTMLButtonElement).disabled).toBe(!canRestoreSessions)
  fireEvent.click(button)
  expect(onRestore).toHaveBeenCalledTimes(canRestoreSessions ? 1 : 0)
})

describe('session archive failures', () => {
  it('shows the upstream active-session rejection and releases the row action', async () => {
    const message = "cannot archive session 's1': the session is active (turn)"
    const onArchive = vi.fn().mockRejectedValue(new Error(message))
    renderDrawer({ onArchive })

    const archiveButton = screen.getByRole('button', { name: 'Archive session Fix login bug' })
    fireEvent.click(archiveButton)

    expect((await screen.findByRole('alert')).textContent).toContain(message)
    expect(screen.getByTitle('Fix login bug')).toBeDefined()
    await waitFor(() => expect(archiveButton.hasAttribute('disabled')).toBe(false))
  })

  it('shows an ordinary RPC error instead of silently keeping the session', async () => {
    const message = 'The workspace archive request failed.'
    const onArchive = vi.fn().mockRejectedValue(new Error(message))
    renderDrawer({ onArchive })

    fireEvent.click(screen.getByRole('button', { name: 'Archive session Fix login bug' }))

    expect((await screen.findByRole('alert')).textContent).toContain(message)
    expect(screen.getByTitle('Fix login bug')).toBeDefined()
  })

  it('uses the existing archive error translation when rejection has no message', async () => {
    const onArchive = vi.fn().mockRejectedValue('rejected')
    renderDrawer({ onArchive })

    fireEvent.click(screen.getByRole('button', { name: 'Archive session Fix login bug' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Unable to archive session.')
  })

  it('continues to show restore failures in the archived section', async () => {
    const onRestore = vi.fn().mockRejectedValue(new Error('The restore RPC failed.'))
    renderDrawer({
      canRestoreSessions: true,
      onRestore,
      archivedSessions: [session({ id: 'old', title: 'Archived chat' })],
    })

    fireEvent.click(screen.getByRole('button', { name: /Archived/u }))
    fireEvent.click(await screen.findByRole('button', { name: 'Restore session Archived chat' }))

    expect((await screen.findByRole('alert')).textContent).toContain('The restore RPC failed.')
  })
})
