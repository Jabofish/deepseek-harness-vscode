/**
 * Sanitised, invented values for upstream master
 * fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159 (declares 0.2.2-rc.1).
 * packages/subagent/subagent/src/catalog.ts: SubagentCatalogEvent v3.
 * packages/subagent/subagent/src/control-types.ts: SubagentPromptRequest.
 * packages/api/session-controller/src/types.ts: SessionPromptRequest.
 * packages/api/session-controller/src/continuation.ts: conversationContinuation.
 * packages/session/session-format-v3-to-v4/src/validation.ts: nativeCatalogFact,
 * own-suffix sibling names and inherited catalog relationships.
 * packages/team/agent-team/src/types.ts: TeamProjection, team/mode.
 * packages/team/agent-team/tests/built-lib.e2e.ts: agentTeams/setEnabled wire.
 * packages/web/web/src/types.ts: WebProviderList.
 * packages/util/package-manifest/src/types.ts: LocalizedText.
 * packages/mcp/mcp-client/src/types.ts: McpConnectionStatus, McpProbeResult.
 * packages/mcp/mcp-manager/src/types.ts: McpManagedServerView.
 */
export const masterNamedCatalogFact = {
  version: 3,
  childId: 'child',
  childCreatedAt: 1_000,
  mode: 'continuable',
  label: 'Review the fixture',
  name: 'reviewer',
} as const

export const masterNamedChild = {
  id: 'child',
  createdAt: 1_000,
  mode: 'continuable',
  label: 'Review the fixture',
  name: 'reviewer',
} as const

export const masterCatalogSnapshot = {
  type: 'snapshot',
  header: { version: 4, id: 'root', createdAt: 1_000, isSeeded: false, delegationDepth: 0 },
  cursor: 1,
  hasMore: false,
  projections: { asOfSeq: 1, values: {} },
  records: [
    { type: 'event', event: { type: 'subagent/catalog', seq: 0, time: 1_000, data: masterNamedCatalogFact } },
    {
      type: 'event',
      event: {
        type: 'subagent/catalog',
        seq: 1,
        time: 1_001,
        data: { ...masterNamedCatalogFact, childId: 'second-child', name: 'writer' },
      },
    },
  ],
}

export const masterTeam = {
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

export const masterWebProviders = {
  search: [{ id: 'fixture-search', title: 'Fixture Search', description: { en: 'Fixture', zh: '示例' } }],
  fetch: [{ id: 'fixture-fetch' }],
}

export const masterMcpServers = [
  {
    name: 'fixture-server',
    configured: true,
    status: { state: 'connected', toolCount: 2, connectedAt: 1_000 },
  },
] as const

export const masterMcpProbe = {
  ok: true,
  toolNames: ['read', 'list'],
  truncated: false,
  durationMs: 1.5,
  closeConfirmed: false,
  cleanupError: 'Fixture cleanup remains pending',
} as const
