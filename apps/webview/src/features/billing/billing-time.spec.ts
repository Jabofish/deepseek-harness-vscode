import { afterEach, expect, it } from 'vitest'
import type { BillingCondition } from '@dsh-vscode/domain'
import { setActiveLocale, translate, type Locale } from '../../i18n.js'
import {
  billingConditionDescription,
  billingDateInput,
  billingDateLabel,
  parseBillingDateInput,
} from './billing-time.js'

afterEach(() => setActiveLocale('en'))
// models.dev's public schedule splits each interval into separate lower/upper predicates.

const describe = (condition: BillingCondition, locale: Locale): string => {
  setActiveLocale(locale)
  return billingConditionDescription(condition, translate, locale)
}

it('moves weekdays with the clock and splits ranges crossing Beijing midnight', () => {
  const nextDay: BillingCondition = { all: [{ utcDays: [1] }, { utcHours: { gte: '20:00', lt: '22:00' } }] }
  expect(describe(nextDay, 'zh')).toBe('周二 北京时间 04:00 – 06:00')
  expect(describe(nextDay, 'en')).toBe('Monday UTC 20:00 – 22:00')
  expect(describe({ all: [{ utcDays: [6] }, { utcHours: { gte: '14:00', lt: '18:00' } }] }, 'zh')).toBe(
    '(周日 北京时间 00:00 – 02:00 或 周六 北京时间 22:00 – 24:00)',
  )
})

it('preserves alternatives, negation, conflicting bounds and grouping of other conditions', () => {
  expect(describe({ not: { utcHours: { gte: '01:00', lt: '04:00' } } }, 'zh')).toBe(
    '(北京时间 00:00 – 09:00 或 北京时间 12:00 – 24:00)',
  )
  expect(describe({ all: [{ utcHours: { gte: '10:00' } }, { utcHours: { lt: '01:00' } }] }, 'en')).toBe(
    'No matching times',
  )
  expect(
    describe(
      {
        any: [
          { all: [{ context: { gt: 100 } }, { serviceTier: { equals: 'priority' } }] },
          { not: { all: [{ holiday: 'CN' }, { context: { lt: 10 } }] } },
        ],
      },
      'en',
    ),
  ).toBe(
    '((Prompt tokens: above 100 and Service tier: priority) or excluding (CN public holidays and Prompt tokens: below 10))',
  )
})

it('displays UTC date boundaries and round-trips validity inputs on the selected clock', () => {
  const instant = Date.parse('2026-12-31T22:30:00Z')
  expect(billingDateInput(instant, 'zh')).toBe('2027-01-01T06:30')
  expect(parseBillingDateInput(billingDateInput(instant, 'zh'), 'zh')).toBe(instant)
  expect(billingDateInput(instant, 'en')).toBe('2026-12-31T22:30')
  expect(parseBillingDateInput(billingDateInput(instant, 'en'), 'en')).toBe(instant)
  expect(describe({ date: { gte: '2026-12-31', lt: '2027-01-01' } }, 'zh')).toBe(
    '北京时间 2026-12-31 08:00 – 2027-01-01 08:00',
  )
  expect(billingDateLabel(Number.NaN, 'zh')).toBe('…')
  expect(billingDateInput(undefined, 'en')).toBe('')
})
