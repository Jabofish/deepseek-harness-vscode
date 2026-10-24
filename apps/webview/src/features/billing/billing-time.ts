import type { BillingCondition } from '@dsh-vscode/domain'
import type { Locale, Translate } from '../../i18n.js'

const dayMinutes = 1440
const offsetMinutes = (locale: Locale): number => (locale === 'zh' ? 480 : 0)

/** datetime-local has no zone; keep display and parsing on the same explicit clock. */
export function billingDateInput(value: number | undefined, locale: Locale): string {
  if (value === undefined || !Number.isFinite(value)) return ''
  const date = new Date(value + offsetMinutes(locale) * 60_000)
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 16) : ''
}

export function parseBillingDateInput(value: string, locale: Locale): number {
  return Date.parse(`${value}${locale === 'zh' ? '+08:00' : 'Z'}`)
}

export function billingDateLabel(value: number | undefined, locale: Locale): string {
  return billingDateInput(value, locale).replace('T', ' ') || '…'
}

function weekly(c: BillingCondition): boolean {
  if ('utcHours' in c || 'utcDays' in c) return true
  if ('all' in c) return c.all.every(weekly)
  if ('any' in c) return c.any.every(weekly)
  return 'not' in c && weekly(c.not)
}

function minute(value: string): number {
  const [hour = 0, minute = 0] = value.split(':').map(Number)
  return hour * 60 + minute
}

function matches(c: BillingCondition, day: number, time: number): boolean {
  if ('all' in c) return c.all.every((value) => matches(value, day, time))
  if ('any' in c) return c.any.some((value) => matches(value, day, time))
  if ('not' in c) return !matches(c.not, day, time)
  if ('utcDays' in c) return c.utcDays.includes(day)
  return (
    'utcHours' in c && time >= minute(c.utcHours.gte ?? '00:00') && time < minute(c.utcHours.lt ?? '24:00')
  )
}

function dayLabels(days: readonly number[], t: Translate): string {
  const labels: string[] = []
  for (let index = 0; index < days.length; index++) {
    const start = days[index]!
    let end = index
    while (end + 1 < days.length && days[end + 1] === days[end]! + 1) end++
    if (end - index >= 2) {
      labels.push(
        t('billing.dayRange', { from: t(`billing.day.${start}`), to: t(`billing.day.${days[end]!}`) }),
      )
      index = end
    } else labels.push(t(`billing.day.${start}`))
  }
  return labels.join(t('billing.daySeparator'))
}

/** Partition only at predicate boundaries, then shift ranges and weekdays together. */
function weeklyDescription(c: BillingCondition, t: Translate, locale: Locale): string {
  const boundaries = new Set([0, dayMinutes])
  const collect = (value: BillingCondition): void => {
    if ('utcHours' in value) {
      for (const bound of Object.values(value.utcHours)) boundaries.add(minute(bound))
    } else if ('all' in value) value.all.forEach(collect)
    else if ('any' in value) value.any.forEach(collect)
    else if ('not' in value) collect(value.not)
  }
  collect(c)
  const cuts = [...boundaries].sort((a, b) => a - b)
  const ranges: [number, number][][] = Array.from({ length: 7 }, () => [])
  const offset = offsetMinutes(locale)
  for (let day = 0; day < 7; day++) {
    for (let index = 0; index + 1 < cuts.length; index++) {
      const start = cuts[index]!
      const end = cuts[index + 1]!
      if (!matches(c, day, start)) continue
      const from = start + offset
      const until = end + offset
      if (from < dayMinutes) ranges[day]!.push([from, Math.min(until, dayMinutes)])
      if (until > dayMinutes)
        ranges[(day + 1) % 7]!.push([Math.max(0, from - dayMinutes), until - dayMinutes])
    }
  }
  const grouped = new Map<string, { from: number; until: number; days: number[] }>()
  for (const [day, intervals] of ranges.entries()) {
    const merged: [number, number][] = []
    for (const interval of intervals.sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1)
      if (last !== undefined && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1])
      else merged.push([...interval])
    }
    for (const [from, until] of merged) {
      const key = `${from}:${until}`
      const group = grouped.get(key) ?? { from, until, days: [] }
      group.days.push(day)
      grouped.set(key, group)
    }
  }
  const clock = (value: number): string =>
    `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
  const byDays = new Map<string, { days: number[]; times: string[] }>()
  for (const { from, until, days } of [...grouped.values()].sort((a, b) => a.from - b.from)) {
    const key = days.join(',')
    const group = byDays.get(key) ?? { days, times: [] }
    group.times.push(`${t('billing.timeZone')} ${clock(from)} – ${clock(until)}`)
    byDays.set(key, group)
  }
  const descriptions = [...byDays.values()].map(({ days, times }) => {
    const time = times.join(t('billing.or'))
    return `${days.length === 7 ? '' : `${dayLabels(days, t)} `}${times.length > 1 ? `(${time})` : time}`
  })
  if (descriptions.length === 0) return t('billing.noMatchingTime')
  const text = descriptions.join(t('billing.or'))
  return descriptions.length > 1 ? `(${text})` : text
}

function flatten(c: BillingCondition): readonly BillingCondition[] {
  return 'all' in c ? c.all.flatMap(flatten) : [c]
}

export function billingConditionDescription(c: BillingCondition, t: Translate, locale: Locale): string {
  const describe = (value: BillingCondition, nested = false): string => {
    if (weekly(value)) return weeklyDescription(value, t, locale)
    if ('all' in value) {
      const parts = value.all.flatMap(flatten)
      const times = parts.filter(weekly)
      let inserted = false
      const descriptions = parts.flatMap((part) => {
        if (!weekly(part)) return [describe(part, true)]
        if (inserted) return []
        inserted = true
        return [weeklyDescription({ all: times }, t, locale)]
      })
      const text = descriptions.join(t('billing.and'))
      return nested && descriptions.length > 1 ? `(${text})` : text
    }
    if ('any' in value) return `(${value.any.map((part) => describe(part, true)).join(t('billing.or'))})`
    if ('not' in value) return t('billing.except', { condition: describe(value.not, true) })
    if ('holiday' in value) return t('billing.holiday', { region: value.holiday })
    if ('serviceTier' in value) return t('billing.serviceTier', { tier: value.serviceTier.equals })
    if ('date' in value)
      return `${t('billing.timeZone')} ${billingDateLabel(value.date.gte === undefined ? undefined : Date.parse(value.date.gte), locale)} – ${billingDateLabel(value.date.lt === undefined ? undefined : Date.parse(value.date.lt), locale)}`
    if ('context' in value)
      return t('billing.contextCondition', {
        bounds: Object.entries(value.context)
          .map(([op, n]) => `${t(`billing.bound.${op}`)} ${n}`)
          .join(', '),
      })
    return t('billing.noMatchingTime')
  }
  return describe(c)
}
