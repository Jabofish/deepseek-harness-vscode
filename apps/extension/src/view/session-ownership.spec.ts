import { describe, expect, it } from 'vitest'

import { ownsCurrentWorkspaceSession, type SessionOwnershipInput } from './session-ownership.js'

type Session = { readonly id: string; readonly workspaceId: string; readonly cwd?: string }

function ownership(options: {
  readonly sessionId: string
  readonly detail: Session
  readonly parents?: Readonly<Record<string, string>>
  readonly known?: readonly Session[]
  readonly readFailure?: Error
}): SessionOwnershipInput & { readonly reads: string[] } {
  const reads: string[] = []
  const known = new Map((options.known ?? []).map((session) => [session.id, session]))
  return {
    sessionId: options.sessionId,
    detail: options.detail,
    belongs: (session) => session.workspaceId === 'workspace-1',
    parentOf: (childSessionId) => options.parents?.[childSessionId],
    reads,
    readSession: (sessionId) => {
      reads.push(sessionId)
      if (options.readFailure !== undefined) return Promise.reject(options.readFailure)
      const session = known.get(sessionId)
      return session === undefined
        ? Promise.reject(new Error(`unknown session ${sessionId}`))
        : Promise.resolve(session)
    },
  }
}

describe('ownsCurrentWorkspaceSession', () => {
  it('accepts a session of the current workspace without reading any parent', async () => {
    const input = ownership({
      sessionId: 'session-1',
      detail: { id: 'session-1', workspaceId: 'workspace-1' },
    })
    await expect(ownsCurrentWorkspaceSession(input)).resolves.toBe(true)
    expect(input.reads).toEqual([])
  })

  it('accepts a child through its durable parent when the catalog published one', async () => {
    // The child itself carries no workspace: `session/list` drops a child
    // without a cwd, so the catalog parent link is the only ownership fact.
    const input = ownership({
      sessionId: 'child-1',
      detail: { id: 'child-1', workspaceId: '' },
      parents: { 'child-1': 'parent-1' },
      known: [{ id: 'parent-1', workspaceId: 'workspace-1' }],
    })
    await expect(ownsCurrentWorkspaceSession(input)).resolves.toBe(true)
    expect(input.reads).toEqual(['parent-1'])
  })

  it('follows a nested delegation chain to the workspace member', async () => {
    const input = ownership({
      sessionId: 'grandchild',
      detail: { id: 'grandchild', workspaceId: '' },
      parents: { grandchild: 'child-1', 'child-1': 'parent-1' },
      known: [
        { id: 'child-1', workspaceId: '' },
        { id: 'parent-1', workspaceId: 'workspace-1' },
      ],
    })
    await expect(ownsCurrentWorkspaceSession(input)).resolves.toBe(true)
    expect(input.reads).toEqual(['child-1', 'parent-1'])
  })

  it('refuses a child whose parent belongs to another workspace', async () => {
    const input = ownership({
      sessionId: 'child-1',
      detail: { id: 'child-1', workspaceId: '' },
      parents: { 'child-1': 'parent-1' },
      known: [{ id: 'parent-1', workspaceId: 'workspace-2' }],
    })
    await expect(ownsCurrentWorkspaceSession(input)).resolves.toBe(false)
  })

  it('refuses a child no catalog described', async () => {
    const input = ownership({ sessionId: 'child-1', detail: { id: 'child-1', workspaceId: '' } })
    await expect(ownsCurrentWorkspaceSession(input)).resolves.toBe(false)
    expect(input.reads).toEqual([])
  })

  it('stops on a self-parent instead of walking forever', async () => {
    const input = ownership({
      sessionId: 'child-1',
      detail: { id: 'child-1', workspaceId: '' },
      parents: { 'child-1': 'child-1' },
      known: [{ id: 'child-1', workspaceId: 'workspace-1' }],
    })
    await expect(ownsCurrentWorkspaceSession(input)).resolves.toBe(false)
    expect(input.reads).toEqual([])
  })

  it('stops on a repeated id in a malformed chain', async () => {
    const input = ownership({
      sessionId: 'child-1',
      detail: { id: 'child-1', workspaceId: '' },
      parents: { 'child-1': 'child-2', 'child-2': 'child-1' },
      known: [
        { id: 'child-2', workspaceId: '' },
        { id: 'child-1', workspaceId: '' },
      ],
    })
    await expect(ownsCurrentWorkspaceSession(input)).resolves.toBe(false)
    expect(input.reads).toEqual(['child-2'])
  })

  it('propagates a parent read failure so the route reports it instead of a refusal', async () => {
    const input = ownership({
      sessionId: 'child-1',
      detail: { id: 'child-1', workspaceId: '' },
      parents: { 'child-1': 'parent-1' },
      readFailure: new Error('the host refused the parent read'),
    })
    await expect(ownsCurrentWorkspaceSession(input)).rejects.toThrow('the host refused the parent read')
  })
})
