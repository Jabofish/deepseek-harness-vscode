import { describe, expect, it } from 'vitest'
import { rrulePreset } from './rrule-presets.js'

describe('rrulePreset', () => {
  it('starts weekdays on the next working day at local 09:00', () => {
    // Friday 2026-11-27 18:00 UTC: the next weekday is Monday the 30th.
    expect(rrulePreset('weekdays', new Date('2026-11-27T18:00:00Z'), 'UTC')).toBe(
      'DTSTART:20261130T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    )
  })

  it('writes the UTC weekdays of local 09:00 east of UTC', () => {
    // Sydney is UTC+11 in November: Monday 09:00 local is Sunday 22:00 UTC.
    expect(rrulePreset('weekdays', new Date('2026-11-27T12:00:00Z'), 'Australia/Sydney')).toBe(
      'DTSTART:20261129T220000Z\nRRULE:FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH',
    )
  })

  it('starts monthly on the next local 1st and keeps it on the 1st locally', () => {
    expect(rrulePreset('monthly', new Date('2026-11-24T12:00:00Z'), 'America/New_York')).toBe(
      'DTSTART:20261201T140000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1',
    )
    // The local 1st at 09:00 is the last day of the previous month in UTC.
    expect(rrulePreset('monthly', new Date('2026-11-24T12:00:00Z'), 'Pacific/Auckland')).toBe(
      'DTSTART:20261130T200000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=-1',
    )
  })
})
