/** Sanitised, invented values pinned to dsh-v0.2.2-rc.2 /
 * ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c:
 * credentials/deepseek-account/src/types.ts (AccountUpdate, notifications);
 * boot/plugin-manager/src/types.ts (expected package and refusal).
 * Named catalog/Team shapes match the independently audited fcc0ad snapshot.
 */
export { masterNamedChild as rc222NamedChild, masterTeam as rc222Team } from './master-fcc0ad-contract.js'

export const rc222AccountState = {
  status: 'credential-stored',
  links: {
    usageUrl: 'https://platform.deepseek.com/usage',
    topUpUrl: 'https://platform.deepseek.com/top_up',
  },
  attempt: null,
} as const

export const rc222Notification = {
  id: 'notice-1',
  createdAt: '2026-11-12T00:00:00Z',
  displayUntil: null,
  title: 'Fixture notice',
  body: 'Fixture content',
  actions: [
    { label: 'Account', style: 'primary', target: { type: 'app_route', name: 'account' } },
    { label: 'Dismiss', style: 'secondary', target: { type: 'dismiss' } },
  ],
  data: { privateFixtureMetadata: 'omit' },
} as const
