/**
 * Sanitised, invented values pinned to dsh-v0.2.2-rc.3 /
 * 38a6a5c965aa99ab525161efb7cc5cf1fe62fced.
 * api/session-controller/src/types.ts retains SessionProjectionUpdate;
 * util/official-bundles/src/plugin-manager.ts adds the optional importer;
 * boot/plugin-manager/src/types.ts retains expected-package installation.
 */
import { rc222NamedChild, rc222Team } from './rc222-contract.js'

export const rc223Projection = {
  type: 'projection',
  sessionId: 's',
  seq: 5,
  changes: [
    { key: 'subagentCatalog', val: [rc222NamedChild] },
    { key: 'conversationContinuation', val: 4 },
    { key: 'agentTeam', val: rc222Team },
  ],
} as const

export const rc223ImportBundle = {
  name: '@deepseek-ai/dsh-deepseek-chat-import',
  version: '0.2.2-rc.3',
  enabled: false,
  installed: false,
  optional: true,
  removable: true,
  experimental: true,
  official: true,
  availability: 'missing',
  installTarget: { spec: '@deepseek-ai/dsh-deepseek-chat-import@0.2.2-rc.3', version: '0.2.2-rc.3' },
  rows: [],
  overrides: [],
} as const
