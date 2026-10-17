import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@dsh-vscode/domain'
import {
  projectSessionLists,
  readOrderDrag,
  type SessionListProjectionInput,
} from './session-drawer-model.js'

describe('order drag payload', () => {
  const transfer = (value: string): DataTransfer => ({ getData: () => value }) as unknown as DataTransfer

  it('rejects the empty workspace id a non-reorderable row writes', () => {
    // Even a malformed transfer cannot reorder across an unknown workspace.
    expect(
      readOrderDrag(transfer(JSON.stringify({ kind: 'session', workspaceId: '', itemId: 's1' }))),
    ).toBeUndefined()
    expect(
      readOrderDrag(transfer(JSON.stringify({ kind: 'session', workspaceId: 'w1', itemId: 's1' }))),
    ).toEqual({ kind: 'session', workspaceId: 'w1', itemId: 's1' })
  })
})

describe('workspace membership projection', () => {
  const session = (id: string, workspaceId = 'other'): SessionSummary => ({
    id,
    workspaceId,
    title: id,
    blank: false,
    status: 'idle' as const,
    createdAt: '2026-10-18T00:00:00Z',
    updatedAt: '2026-10-18T00:00:00Z',
  })
  const workspace = {
    id: 'w',
    name: 'Workspace',
    sessionIds: ['s2', 's1', 's2', 'missing'],
    createdAt: '2026-10-18T00:00:00Z',
    updatedAt: '2026-10-18T00:00:00Z',
    sessionCount: 3,
  }
  const input: SessionListProjectionInput = {
    sessions: [
      session('s1'),
      session('s2'),
      session('s3', 'w'),
      session('outside'),
      { ...session('hidden-blank', 'w'), blank: true },
      { ...session('current-blank', 'w'), blank: true },
      { ...session('child', 'w'), origin: 'subagent' },
    ],
    archivedSessions: [],
    visibleWorkspaces: [workspace],
    selectedWorkspace: workspace,
    activeSessionId: 'current-blank',
    contentMatches: [],
    query: '',
    sorting: 'manual',
    archiveFilter: 'hide',
    workspaceDisplay: 'grouped',
    t: (key) => key,
  }

  it('retains explicit membership, direct ownership, manual order and the current blank', () => {
    expect(projectSessionLists(input).grouped[0]?.sessions.map(({ id }) => id)).toEqual([
      'current-blank',
      's1',
      's2',
      's3',
    ])
  })

  it('scopes archived rows using membership when a summary has a stale workspace', () => {
    const result = projectSessionLists({
      ...input,
      archiveFilter: 'archived',
      workspaceDisplay: 'current',
      query: 's2',
      archivedSessions: input.sessions.slice(0, 4),
    })
    expect(result.archivedInScope.map(({ id }) => id)).toEqual(['s1', 's2', 's3'])
    expect(result.archived.map(({ id }) => id)).toEqual(['s2'])
  })
})
