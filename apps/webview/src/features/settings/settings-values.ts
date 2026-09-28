import type { DshSettingsSnapshot } from '../../app/store.js'
import type { Locale } from '../../i18n.js'

export function settingValueAt(values: Readonly<Record<string, unknown>>, path: string): unknown {
  let cursor: unknown = values
  for (const part of path.split('.')) {
    const record =
      typeof cursor === 'object' && cursor !== null && !Array.isArray(cursor)
        ? (cursor as Record<string, unknown>)
        : undefined
    if (record === undefined) return undefined
    cursor = record[part]
  }
  return cursor
}

export function withSettingValue(
  snapshot: DshSettingsSnapshot,
  path: string,
  value: unknown,
): DshSettingsSnapshot {
  const segments = path.split('.')
  if (segments.length === 0 || segments.some((segment) => segment.trim() === '')) return snapshot
  const update = (current: unknown, index: number): Record<string, unknown> => {
    const record =
      typeof current === 'object' && current !== null && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : {}
    const key = segments[index]
    if (key === undefined) return record
    return {
      ...record,
      [key]: index === segments.length - 1 ? value : update(record[key], index + 1),
    }
  }
  return { ...snapshot, values: update(snapshot.values, 0) }
}

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'zh'
}

/** Same permission label formatting the session controls use. */
export function formatSettingValue(value: string, t: (key: string) => string): string {
  const localized = new Set([
    'danger-full-access',
    'workspace-write',
    'read-only',
    'en',
    'zh',
    'light',
    'dark',
    'system',
    'queue',
    'steer',
    'compact',
    'standard',
    'detailed',
    'verbose',
  ])
  if (localized.has(value)) return t(`settings.value.${value}`)
  if (!value.includes('-')) return value
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
