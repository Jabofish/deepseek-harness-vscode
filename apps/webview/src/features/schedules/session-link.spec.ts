import { describe, expect, it } from 'vitest'
import type { SessionSummary, WorkspaceSummary } from '@dsh-vscode/domain'
import { resolveScheduleSessionLink } from './session-link.js'

const session: SessionSummary = {
  id: 'session-one',
  workspaceId: 'workspace-one',
  title: 'Planning conversation',
  blank: false,
  status: 'idle',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

const workspace: WorkspaceSummary = {
  id: 'workspace-one',
  name: 'Current workspace',
  sessionIds: ['session-one'],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  sessionCount: 1,
}

describe('resolveScheduleSessionLink', () => {
  it('exposes only a loaded, current-workspace, unarchived Session', () => {
    expect(resolveScheduleSessionLink('session-one', 'ready', [session], [workspace], [])).toEqual({
      status: 'available',
      title: 'Planning conversation',
    })
  })

  it('uses the Session id if its title is empty', () => {
    expect(
      resolveScheduleSessionLink('session-one', 'ready', [{ ...session, title: '  ' }], [workspace], []),
    ).toEqual({ status: 'available', title: 'session-one' })
  })

  it('blocks archived, missing and unconfirmed Workspace membership', () => {
    expect(resolveScheduleSessionLink('session-one', 'ready', [session], [workspace], ['session-one'])).toEqual({
      status: 'archived',
    })
    expect(resolveScheduleSessionLink('session-missing', 'ready', [session], [workspace], [])).toEqual({
      status: 'missing',
    })
    expect(
      resolveScheduleSessionLink('session-one', 'ready', [session], [{ ...workspace, sessionIds: [] }], []),
    ).toEqual({ status: 'missing' })
    expect(resolveScheduleSessionLink('session-one', 'ready', [session], [], [])).toEqual({ status: 'missing' })
  })

  it('does not infer availability from stale rows while metadata is loading or failed', () => {
    expect(resolveScheduleSessionLink('session-one', 'loading', [session], [workspace], [])).toEqual({
      status: 'loading',
    })
    expect(resolveScheduleSessionLink('session-one', 'error', [session], [workspace], [])).toEqual({
      status: 'error',
    })
  })
})
