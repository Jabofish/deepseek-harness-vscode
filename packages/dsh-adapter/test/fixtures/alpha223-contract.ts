/** dsh-v0.2.2-alpha.3 / 05b1cae8db6e674c5685101494d4eec24652424a.
 * schedule/schedule/src/types.ts: ScheduleCatalogEntry, ScheduleEditRequest;
 * api/session-controller/src/types.ts: SessionProjectionUpdate. Invented content and identities.
 */
export const alpha223Task = {
  id: 'native-task',
  kind: 'rrule',
  title: 'Review changes',
  prompt: 'Review the fixture project',
  rrule: 'DTSTART:20991104T090000Z\nRRULE:FREQ=DAILY',
  scheduledAt: '2099-11-04T09:00:00.000Z',
  status: 'paused',
  updatedAt: '2026-11-03T00:00:00.000Z',
  target: {
    kind: 'new_once',
    sessionId: 'reserved-session',
    create: { cwd: '/fixture/workspace', agentPreset: 'fixture-preset' },
  },
  involvedSessionIds: ['creator-session'],
} as const
export const alpha223Projection = {
  type: 'projection',
  sessionId: 's',
  seq: 5,
  changes: [
    { key: 'todos', val: [{ content: 'Review', status: 'in_progress' }] },
    { key: 'inbox', val: { 'next-turn': [], 'next-step': [] } },
  ],
} as const
