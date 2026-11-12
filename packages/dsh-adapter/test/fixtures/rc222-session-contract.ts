/**
 * Sanitised, invented values for dsh-v0.2.2-rc.2 /
 * ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c.
 * packages/subagent/subagent/src/catalog.ts: SubagentCatalogEvent v3.
 * packages/subagent/subagent/src/control-types.ts: SubagentPromptRequest.
 * packages/api/session-controller/src/types.ts: SessionPromptRequest.
 * packages/api/session-controller/src/continuation.ts: conversationContinuation.
 * packages/session/session-format-v3-to-v4/src/validation.ts: nativeCatalogFact,
 * own-suffix sibling names and inherited catalog relationships.
 * packages/team/agent-team/src/types.ts: TeamProjection, team/mode.
 */
export const rc222NamedCatalogFact = {
  version: 3,
  childId: 'child',
  childCreatedAt: 1_000,
  mode: 'continuable',
  label: 'Review the fixture',
  name: 'reviewer',
} as const

export const rc222NamedChild = {
  id: 'child',
  createdAt: 1_000,
  mode: 'continuable',
  label: 'Review the fixture',
  name: 'reviewer',
} as const

export const rc222CatalogSnapshot = {
  type: 'snapshot',
  header: { version: 4, id: 'root', createdAt: 1_000, isSeeded: false, delegationDepth: 0 },
  cursor: 1,
  hasMore: false,
  projections: { asOfSeq: 1, values: {} },
  records: [
    { type: 'event', event: { type: 'subagent/catalog', seq: 0, time: 1_000, data: rc222NamedCatalogFact } },
    {
      type: 'event',
      event: {
        type: 'subagent/catalog',
        seq: 1,
        time: 1_001,
        data: { ...rc222NamedCatalogFact, childId: 'second-child', name: 'writer' },
      },
    },
  ],
}

export const rc222Team = {
  enabled: true,
  tasks: [
    {
      id: 'task-1',
      revision: 2,
      subject: 'Review',
      description: 'Review the disposable fixture',
      status: 'in_progress',
      ownerId: 'child',
      ownerName: 'reviewer',
      blockedBy: [],
      writeScopes: ['/fixture/private'],
      ready: true,
      writeScopeWarnings: [],
    },
  ],
} as const
