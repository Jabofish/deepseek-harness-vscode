// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChangeDetail, ChangeSetFile } from '@dsh-vscode/domain'

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
})
