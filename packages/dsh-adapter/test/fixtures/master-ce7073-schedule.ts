/**
 * Sanitised values based on upstream ce7073d51254c26cd63b22a60835b8f948deb447,
 * packages/schedule/schedule/src/types.ts: ScheduleCatalogEntry and ScheduleTarget.
 */
export const masterScheduleCatalog = [
  {
    id: 'schedule-daily',
    kind: 'daily',
    title: 'Review changes',
    prompt: 'Review the current changes',
    time: '09:30:00.000',
    timeZone: 'UTC',
    scheduledAt: '2026-11-04T09:30:00.000Z',
    target: { kind: 'session', sessionId: 'session-1' },
    involvedSessionIds: ['session-1'],
    status: 'active',
    updatedAt: '2026-11-03T00:00:00.000Z',
    lastDelivery: {
      scheduledAt: '2026-11-03T09:30:00.000Z',
      deliveredAt: '2026-11-03T09:30:01.000Z',
      messageId: 'message-1',
      targetSessionId: 'session-1',
    },
  },
  {
    id: 'schedule-rrule',
    kind: 'rrule',
    title: 'Weekly review',
    prompt: 'Review the project',
    rrule: 'DTSTART:20261104T090000Z\nRRULE:FREQ=WEEKLY',
    scheduledAt: '2026-11-04T09:00:00.000Z',
    target: { kind: 'new', create: { cwd: '/private/example', agentPreset: 'standard' } },
    involvedSessionIds: [],
    status: 'paused',
  },
] as const
