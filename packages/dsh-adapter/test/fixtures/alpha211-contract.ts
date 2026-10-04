/**
 * Sanitized DSH dsh-v0.2.1-alpha.1 contract fixtures.
 * Commit: 5badb15009ae1756c3afe0ae0cef1faafc290ccc.
 * ScheduleUpdateResult: packages/schedule/schedule/src/types.ts and index.ts.
 * SignInAttemptView: packages/credentials/deepseek-account/src/types.ts.
 * ChangeResult/BundleInfo: packages/boot/plugin-manager/src/types.ts.
 * Values are invented; source/target are deliberately Host-only adversarial data.
 */
export const subagentScheduleRefusal = {
  code: 'subagent_session',
  message: 'This Session belongs to subagent routing, which never receives reminder delivery.',
} as const

export const failedAccountAttempt = {
  status: 'signed-out',
  attempt: {
    id: '00000000-0000-4000-8000-000000000001',
    phase: 'failed',
    errorCode: 'no-response',
  },
  links: {
    usageUrl: 'https://platform.deepseek.com/usage',
    topUpUrl: 'https://platform.deepseek.com/top_up',
  },
} as const

export const installedBundle = {
  stage: 'enable',
  target: 'fixture-bundle',
  bundle: 'fixture-bundle',
  version: '1.2.3',
  changed: true,
  enabled: true,
  application: 'restart-required',
  source: 'file:///private/profile/bundle',
} as const

/** alpha.1 lets a selected, retired dependency be removed by deselection. */
export const retiredBundle = {
  name: 'fixture-retired-bundle',
  enabled: true,
  installed: false,
  optional: false,
  removable: true,
  error: { code: 'not-bundle' },
  rows: [],
  overrides: [],
  source: 'file:///private/profile/bundle',
} as const

export const scheduleUpdate = {
  sessionId: 'child-session',
  id: 'task-1',
  expected: {
    id: 'task-1',
    title: 'Fixture reminder',
    prompt: 'Fixture instruction',
    kind: 'at',
    scheduledAt: '2030-01-01T00:00:00.000Z',
  },
  title: 'Updated fixture',
} as const
