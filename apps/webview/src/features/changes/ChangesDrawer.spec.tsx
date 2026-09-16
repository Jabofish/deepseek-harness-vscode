// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChangeDetail, ChangeReviewState, ChangeSetFile } from '@dsh-vscode/domain'

import { I18nProvider } from '../../i18n.js'
import { ChangesDrawer } from './ChangesDrawer.js'

const identity = {
  backendInstanceId: 'backend-1',
  connectionGeneration: 1,
  stream: 'mux' as const,
  sessionId: 'session-1',
  serverSeq: 1,
}

const change: ChangeSetFile = {
  changeId: 'change-1',
  sessionId: 'session-1',
  workspaceFolderId: 'workspace-1',
  relativePath: 'src/main.ts',
  status: 'modified',
  additions: 2,
  deletions: 1,
  locations: [{ path: 'src/main.ts', line: 4 }],
  evidence: 'structuredProposal',
  applicationState: 'proposed',
  reviewState: 'unreviewed',
  sourceIds: ['tool-1'],
  sourceInteractionIds: [],
  sourceToolCallIds: ['tool-1'],
  firstSeenAt: 1_000,
  lastSeenAt: 1_100,
  identity,
  diffAvailable: true,
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function renderDrawer(
  overrides: Partial<React.ComponentProps<typeof ChangesDrawer>> = {},
): ReturnType<typeof render> {
  const props: React.ComponentProps<typeof ChangesDrawer> = {
    changes: [change],
    loading: false,
    onRefresh: vi.fn().mockResolvedValue(undefined),
    onOpen: vi.fn().mockResolvedValue(undefined),
    onDetail: vi.fn().mockResolvedValue({
      ...change,
      redactedDiff: '--- old\nold\n+++ new\nnew',
      diffTruncated: false,
    } satisfies ChangeDetail),
    onMarkReviewed: vi.fn().mockResolvedValue({ ...change, reviewState: 'viewed' }),
    ...overrides,
  }
  return render(
    <I18nProvider>
      <ChangesDrawer {...props} />
    </I18nProvider>,
  )
}

describe('ChangesDrawer', () => {
  afterEach(() => cleanup())

  it('keeps the trigger hidden for an empty settled session', () => {
    renderDrawer({ changes: [] })
    expect(screen.queryByRole('button', { name: '0 changes' })).toBeNull()
  })

  it('shows structured evidence, opens a detail preview, and marks a row viewed', async () => {
    const onDetail = vi.fn().mockResolvedValue({
      ...change,
      redactedDiff: '--- old\nold\n+++ new\nnew',
      diffTruncated: false,
    } satisfies ChangeDetail)
    const onMarkReviewed = vi.fn().mockResolvedValue({ ...change, reviewState: 'viewed' })
    const onOpen = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onDetail, onMarkReviewed, onOpen })

    fireEvent.click(screen.getByRole('button', { name: '1 changes' }))
    expect(screen.getByText('src/main.ts')).toBeDefined()
    expect(screen.getByText('Proposal')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Review src/main.ts' }))
    await waitFor(() => expect(document.querySelector('pre')?.textContent).toBe('--- old\nold\n+++ new\nnew'))
    fireEvent.click(screen.getByTitle('src/main.ts'))
    await waitFor(() => {
      expect(onOpen).toHaveBeenCalledWith('change-1')
      expect(onMarkReviewed).toHaveBeenCalledWith('change-1', 'viewed')
    })
  })

  it('keeps an older detail response from overwriting the newest selection', async () => {
    const second = { ...change, changeId: 'change-2', relativePath: 'src/other.ts' }
    const firstDetail = deferred<ChangeDetail>()
    const secondDetail = deferred<ChangeDetail>()
    const onDetail = vi.fn((changeId: string) =>
      changeId === 'change-1' ? firstDetail.promise : secondDetail.promise,
    )
    renderDrawer({ changes: [change, second], onDetail })

    fireEvent.click(screen.getByRole('button', { name: '2 changes' }))
    fireEvent.click(screen.getAllByRole('button', { name: /Review /u })[0]!)
    fireEvent.click(screen.getAllByRole('button', { name: /Review /u })[1]!)
    secondDetail.resolve({ ...second, redactedDiff: 'SECOND', diffTruncated: false })
    await waitFor(() => expect(document.querySelector('pre')?.textContent).toBe('SECOND'))
    firstDetail.resolve({ ...change, redactedDiff: 'FIRST', diffTruncated: false })
    await waitFor(() => expect(document.querySelector('pre')?.textContent).toBe('SECOND'))
  })

  it('offers explicit accept, reject, and attention review decisions in the detail view', async () => {
    const accepted = deferred<ChangeSetFile>()
    const rejected = deferred<ChangeSetFile>()
    const needsAttention = deferred<ChangeSetFile>()
    const onMarkReviewed = vi.fn((_changeId: string, reviewState: ChangeReviewState) => {
      if (reviewState === 'unreviewed') return Promise.resolve(undefined)
      if (reviewState === 'accepted') return accepted.promise
      if (reviewState === 'rejected') return rejected.promise
      if (reviewState === 'needs-attention') return needsAttention.promise
      return Promise.resolve({ ...change, reviewState })
    })
    renderDrawer({ onMarkReviewed })

    fireEvent.click(screen.getByRole('button', { name: '1 changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review src/main.ts' }))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Change detail' })).toBeDefined())

    expect(screen.getByRole('group', { name: 'Change review decision' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(onMarkReviewed).toHaveBeenCalledWith('change-1', 'accepted'))
    expect(screen.getByRole('button', { name: 'Reject' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Needs attention' })).toHaveProperty('disabled', true)

    accepted.resolve({ ...change, reviewState: 'accepted' })
    await waitFor(() => expect(screen.getByText('Accepted')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(onMarkReviewed).toHaveBeenCalledWith('change-1', 'rejected'))
    rejected.resolve({ ...change, reviewState: 'rejected' })
    await waitFor(() => expect(screen.getByText('Rejected')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'Needs attention' }))
    await waitFor(() => expect(onMarkReviewed).toHaveBeenCalledWith('change-1', 'needs-attention'))
    needsAttention.resolve({ ...change, reviewState: 'needs-attention' })
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Change detail' }).textContent).toContain('Needs attention'),
    )
    expect(onMarkReviewed).toHaveBeenCalledTimes(3)
  })

  it('shows an accessible error when a review decision cannot be saved', async () => {
    const onMarkReviewed = vi.fn().mockRejectedValue(new Error('unavailable'))
    renderDrawer({ onMarkReviewed })

    fireEvent.click(screen.getByRole('button', { name: '1 changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review src/main.ts' }))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Change detail' })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('The review decision could not be saved.'),
    )
  })

  it('reports a row review mark that the host rejected', async () => {
    const onOpen = vi.fn().mockResolvedValue(undefined)
    const onMarkReviewed = vi.fn().mockRejectedValue(new Error('session changed while reading'))
    renderDrawer({ onOpen, onMarkReviewed })

    fireEvent.click(screen.getByRole('button', { name: '1 changes' }))
    fireEvent.click(screen.getByTitle('src/main.ts'))

    // The row keeps its `unreviewed` state, so the failed mark is the only
    // difference the user could notice; it must not disappear silently.
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('The review decision could not be saved.'),
    )
  })

  it('reports a rejected refresh instead of leaving a stale list unexplained', async () => {
    const onRefresh = vi.fn().mockRejectedValue(new Error('host busy'))
    renderDrawer({ onRefresh })

    fireEvent.click(screen.getByRole('button', { name: '1 changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh changes' }))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('The change list could not be refreshed.'),
    )
  })

  it('reports a rejected file open instead of dropping the row click silently', async () => {
    const onOpen = vi.fn().mockRejectedValue(new Error('workspace folder is gone'))
    renderDrawer({ onOpen })

    fireEvent.click(screen.getByRole('button', { name: '1 changes' }))
    fireEvent.click(screen.getByTitle('src/main.ts'))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('The changed file could not be opened.'),
    )
  })

  it('clears a reported open failure once a later open succeeds', async () => {
    const onOpen = vi
      .fn()
      .mockRejectedValueOnce(new Error('workspace folder is gone'))
      .mockResolvedValue(undefined)
    renderDrawer({ onOpen })

    fireEvent.click(screen.getByRole('button', { name: '1 changes' }))
    fireEvent.click(screen.getByTitle('src/main.ts'))
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined())

    fireEvent.click(screen.getByTitle('src/main.ts'))
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})
