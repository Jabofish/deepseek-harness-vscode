// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { SessionSummary, WorkspaceSummary } from '@dsh-vscode/domain'
import { SessionDrawer } from './SessionDrawer.js'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

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
  layout?: 'focused',
): ReturnType<typeof render> {
  const onSearch = vi.fn().mockResolvedValue({ items: [] })
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
  return render(
    layout === undefined ? (
      <SessionDrawer {...props} />
    ) : (
      <ConversationLayoutProvider initialLayout={layout}>
        <SessionDrawer {...props} />
      </ConversationLayoutProvider>
    ),
  )
}

describe('session dragging respects cancellation and explicit opening', () => {
  afterEach(cleanup)

  function stubWidePanel(): void {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  }

  function sessionRow(): HTMLElement {
    const row = screen.getAllByRole('button', { name: /Fix login bug/u })[0]?.closest('li')
    if (row === null || row === undefined) throw new Error('the session row is missing')
    return row
  }

  it('does not interpret an unaccepted external drop as an editor-open request', () => {
    const onOpenInEditor = vi.fn()
    stubWidePanel()
    renderDrawer({ onOpenInEditor }, 'focused')
    const row = sessionRow()
    const dataTransfer = createDataTransfer()

    fireEvent.dragStart(row, { dataTransfer })
    // The editor area is outside the Webview viewport. jsdom's DragEvent drops
    // MouseEvent coordinates, so the native event is dispatched directly.
    const outside = new Event('drag', { bubbles: true })
    Object.assign(outside, { clientX: 5_000, clientY: 5_000 })
    document.dispatchEvent(outside)
    dataTransfer.dropEffect = 'none'
    fireEvent.dragEnd(row, { dataTransfer })

    expect(onOpenInEditor).not.toHaveBeenCalled()
  })
})

function createDataTransfer(): {
  effectAllowed: string
  dropEffect: string
  setData: Mock<(type: string, value: string) => void>
  getData: Mock<(type: string) => string>
} {
  const values = new Map<string, string>()
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: vi.fn((type: string, next: string) => {
      values.set(type, next)
    }),
    getData: vi.fn((type: string) => values.get(type) ?? ''),
  }
}

const archiveFilterLabels = {
  hide: 'Hide archived',
  all: 'All conversations',
  archived: 'Archived only',
} as const

/** The filter is a themed menu, not a native `<select>`. */
function chooseArchiveFilter(value: keyof typeof archiveFilterLabels): void {
  fireEvent.click(screen.getByRole('button', { name: /Archived conversation filter/u }))
  fireEvent.click(screen.getByRole('option', { name: archiveFilterLabels[value] }))
}

/**
 * A row's rarer actions live behind one trigger so revealing them cannot take
 * width from the title. Tests open that menu before picking an action.
 */
function rowActionsTrigger(title: string): HTMLElement {
  return screen.getByRole('button', { name: `Session actions for ${title}` })
}

function openRowActions(title: string): void {
  fireEvent.click(rowActionsTrigger(title))
}

describe('SessionDrawer', () => {
  afterEach(() => cleanup())

  it('remembers sorting and grouping after the list is recreated without persisting a search', () => {
    const first = renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Sort sessions by last updated' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show grouped workspaces' }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'docs' } })
    first.unmount()
    const second = renderDrawer()
    expect(screen.getByRole('button', { name: 'Sort sessions by manual order' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Show current workspace' })).toBeDefined()
    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('')
    expect(screen.getByText('Other workspace note')).toBeDefined()
    const rows = screen.getAllByRole('button', { name: /^(?!Session actions).*(Fix login bug|Write docs)/u })
    expect(
      rows.map((item) => (item.textContent?.includes('Write docs') ? 'Write docs' : 'Fix login bug')),
    ).toEqual(['Write docs', 'Fix login bug'])
    fireEvent.click(screen.getByRole('button', { name: 'Sort sessions by manual order' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show current workspace' }))
    second.unmount()
    renderDrawer()
    expect(screen.getByRole('button', { name: 'Sort sessions by last updated' })).toBeDefined()
    expect(screen.queryByText('Other workspace note')).toBeNull()
  })

  it('keeps list controls usable when browser storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Sort sessions by last updated' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show grouped workspaces' }))
    expect(screen.getByRole('button', { name: 'Sort sessions by manual order' })).toBeDefined()
    expect(screen.getByText('Other workspace note')).toBeDefined()
  })

  it('uses the existing defaults when saved presentation choices are malformed', () => {
    window.localStorage.setItem('dsh-webview-session-list-preferences', '{broken')
    renderDrawer()
    expect(screen.getByRole('button', { name: 'Sort sessions by last updated' })).toBeDefined()
    expect(screen.queryByText('Other workspace note')).toBeNull()
  })

  it('focuses search on opening and selects the previous query on reopening', () => {
    renderDrawer({ open: undefined, showTrigger: true })
    const trigger = screen.getByRole('button', { name: /Fix login bug/u })
    fireEvent.click(trigger)
    const input = screen.getByRole<HTMLInputElement>('searchbox')
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'docs' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(trigger)
    const reopened = screen.getByRole<HTMLInputElement>('searchbox')
    expect(document.activeElement).toBe(reopened)
    expect(reopened.value.slice(reopened.selectionStart ?? 0, reopened.selectionEnd ?? 0)).toBe('docs')
  })

  it.each([false, true])('opens the only visible search result with Enter, grouped=%s', async (grouped) => {
    const onOpen = vi.fn()
    renderDrawer({ onOpen })
    if (grouped) fireEvent.click(screen.getByRole('button', { name: 'Show grouped workspaces' }))
    const input = screen.getByRole('searchbox')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'docs' } })
      await Promise.resolve()
    })
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('s2')
  })

  it('keeps ambiguous and empty searches open instead of choosing a conversation', () => {
    const onOpen = vi.fn()
    renderDrawer({ onOpen })
    const input = screen.getByRole('searchbox')
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: 'i' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: 'missing' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('does not treat IME confirmation, modified Enter or repeated Enter as opening a result', async () => {
    const onOpen = vi.fn()
    renderDrawer({ onOpen })
    const input = screen.getByRole('searchbox')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'docs' } })
      await Promise.resolve()
    })
    for (const modifiers of [
      { isComposing: true },
      { keyCode: 229 },
      { shiftKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { repeat: true },
    ])
      fireEvent.keyDown(input, { key: 'Enter', ...modifiers })
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('s2')
  })

  it('does not take focus from the composer when the docked list appears', () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    const composer = document.createElement('textarea')
    document.body.append(composer)
    composer.focus()
    try {
      renderDrawer({ open: undefined }, 'focused')
      expect(document.activeElement).toBe(composer)
    } finally {
      composer.remove()
      vi.unstubAllGlobals()
    }
  })

  it('can search again after closing the list during IME composition', async () => {
    const onOpen = vi.fn()
    renderDrawer({ open: undefined, showTrigger: true, onOpen })
    const trigger = screen.getByRole('button', { name: /Fix login bug/u })
    fireEvent.click(trigger)
    const input = screen.getByRole('searchbox')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'docs' } })
      await Promise.resolve()
    })
    fireEvent.compositionStart(input)
    fireEvent.click(trigger)
    await act(async () => {
      fireEvent.click(trigger)
      await Promise.resolve()
    })
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('s2')
  })

  it('waits for pending content matches before opening an apparently unique title result', async () => {
    let resolveSearch!: (value: { items: readonly SessionSummary[] }) => void
    const onSearch = vi.fn(
      () =>
        new Promise<{ items: readonly SessionSummary[] }>((resolve) => {
          resolveSearch = resolve
        }),
    )
    const onOpen = vi.fn()
    renderDrawer({ onSearch, onOpen })
    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'docs' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onOpen).not.toHaveBeenCalled()
    await act(async () => {
      resolveSearch({ items: [sessions[2]!] })
      await Promise.resolve()
    })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onOpen).not.toHaveBeenCalled()
    expect(screen.getByText('Write docs')).toBeDefined()
    expect(screen.getByText('Other workspace note')).toBeDefined()
  })

  it('waits for a fresh content search when reopening the same query', async () => {
    let resolveSearch!: (value: { items: readonly SessionSummary[] }) => void
    const pending = new Promise<{ items: readonly SessionSummary[] }>((resolve) => {
      resolveSearch = resolve
    })
    const onSearch = vi.fn().mockResolvedValueOnce({ items: [] }).mockReturnValue(pending)
    const onOpen = vi.fn()
    renderDrawer({ open: undefined, showTrigger: true, onOpen, onSearch })
    const trigger = screen.getByRole('button', { name: /Fix login bug/u })
    fireEvent.click(trigger)
    await act(async () => {
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'docs' } })
      await Promise.resolve()
    })
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' })
    expect(onOpen).not.toHaveBeenCalled()
    await act(async () => {
      resolveSearch({ items: [sessions[2]!] })
      await Promise.resolve()
    })
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('opens a unique content match from another workspace using the same search action', async () => {
    const onOpen = vi.fn()
    const onSearch = vi.fn().mockResolvedValue({ items: [sessions[2]] })
    renderDrawer({ onOpen, onSearch })
    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'needle' } })
    await screen.findByText('Other workspace note')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('s3')
  })

  it.each([false, true])(
    'counts content matches when deciding if Enter is unambiguous, extra=%s',
    async (extra) => {
      const onOpen = vi.fn()
      const onSearch = vi.fn().mockResolvedValue({ items: [sessions[1]], searchHasMore: extra })
      renderDrawer({ onOpen, onSearch })
      const input = screen.getByRole('searchbox')
      await act(async () => {
        fireEvent.change(input, { target: { value: 'docs' } })
        await Promise.resolve()
      })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onOpen).toHaveBeenCalledTimes(extra ? 0 : 1)
    },
  )

  it('leaves mixed active and archived results available for explicit selection', () => {
    const onOpen = vi.fn()
    renderDrawer({ onOpen, archivedSessions: [session({ id: 'old', title: 'Archived docs' })] })
    chooseArchiveFilter('all')
    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'docs' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('keeps a pasted search query inside the session.search wire contract', async () => {
    const onSearch = vi.fn().mockResolvedValue({ items: [] })
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

  it('opens a session rename dialog, warns about a duplicate, and saves the edited title', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onRename })

    openRowActions('Fix login bug')
    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    const input = screen.getByLabelText('Session name')
    fireEvent.change(input, { target: { value: 'Write docs' } })

    expect(screen.getByText('Another session in this workspace already uses this name.')).toBeDefined()
    fireEvent.change(input, { target: { value: 'Rename me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onRename).toHaveBeenCalledWith('s1', 'Rename me'))
    expect(screen.queryByRole('dialog', { name: 'Rename session' })).toBeNull()
  })

  it('confirms workspace removal and keeps the destructive action explicit', async () => {
    const onRemoveWorkspace = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onRemoveWorkspace })

    const trigger = screen.getByRole('button', { name: 'Remove workspace Alpha' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('alertdialog', { name: 'Remove workspace' })
    expect(dialog).toBeDefined()
    expect(screen.getByText('Remove “Alpha” from DSH? Its 2 session(s) and files will remain.')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(onRemoveWorkspace).toHaveBeenCalledWith('w1'))
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'Remove workspace' })).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
})

describe('workspace folder picker', () => {
  afterEach(() => cleanup())

  it('reports picker failures and permits retry', async () => {
    const onAddWorkspace = vi
      .fn()
      .mockRejectedValueOnce(new Error('Picker unavailable'))
      .mockResolvedValue(undefined)
    renderDrawer({ onAddWorkspace })
    fireEvent.click(screen.getByRole('button', { name: 'Add folder to workspace' }))
    await waitFor(() => expect(screen.getByText('Picker unavailable')).toBeDefined())
    expect(onAddWorkspace).toHaveBeenCalledExactlyOnceWith()
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
  chooseArchiveFilter('all')
  const button = await screen.findByRole('button', { name: 'Restore session Archived chat' })
  expect((button as HTMLButtonElement).disabled).toBe(!canRestoreSessions)
  fireEvent.click(button)
  expect(onRestore).toHaveBeenCalledTimes(canRestoreSessions ? 1 : 0)
})
