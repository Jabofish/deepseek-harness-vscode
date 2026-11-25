export type RrulePreset = 'weekdays' | 'monthly'

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
const DAY_MS = 86_400_000

/** The wall-clock date and time an instant shows in a time zone, as a UTC timestamp. */
function wallClock(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant)
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((entry) => entry.type === type)?.value ?? 0)
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'))
}

/** The instant a wall-clock time (given as a UTC timestamp) happens in a time zone. */
function instantOf(wall: number, timeZone: string): number {
  let instant = wall
  for (let step = 0; step < 3; step++) instant = wall - (wallClock(instant, timeZone) - instant)
  return instant
}

/**
 * An RFC 5545 block for "weekdays at 09:00" or "the 1st of each month at
 * 09:00" in the viewer's time zone. The DSH RRULE form carries no time
 * zone, so the rule is written in UTC: DTSTART is the next matching local
 * 09:00, and the weekday or month day is the UTC day of that moment (local
 * Monday 09:00 in Sydney is Sunday in UTC; the local 1st can be the last
 * day of the previous month). A daylight-saving change still moves the
 * local time by an hour; Weekly with a time zone avoids that.
 */
export function rrulePreset(
  preset: RrulePreset,
  now = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const today = new Date(wallClock(now.getTime(), timeZone))
  for (let offset = 0; offset <= 62; offset++) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset))
    const matches =
      preset === 'weekdays' ? day.getUTCDay() >= 1 && day.getUTCDay() <= 5 : day.getUTCDate() === 1
    if (!matches) continue
    const start = instantOf(day.getTime() + 9 * 3_600_000, timeZone)
    if (start <= now.getTime()) continue
    const startDate = new Date(start)
    const utcDay = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())
    const shift = Math.round((utcDay - day.getTime()) / DAY_MS)
    const rule =
      preset === 'weekdays'
        ? `FREQ=WEEKLY;BYDAY=${[1, 2, 3, 4, 5].map((weekday) => DAY_CODES[(weekday + shift + 7) % 7]).join(',')}`
        : `FREQ=MONTHLY;BYMONTHDAY=${shift < 0 ? -1 : 1 + shift}`
    const stamp = startDate
      .toISOString()
      .replace(/[-:]/gu, '')
      .replace(/\.\d{3}/u, '')
    return `DTSTART:${stamp}\nRRULE:${rule}`
  }
  throw new Error('No matching day within two months.')
}
