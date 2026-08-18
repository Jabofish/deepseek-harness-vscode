import type { Translate } from '../../i18n.js'

export function isDefaultSessionTitle(title: string): boolean {
  const normalized = title.trim()
  return (
    normalized === '' || normalized.toLowerCase() === 'new session' || /^session\s+session-/i.test(normalized)
  )
}

export function displaySessionTitle(title: string, t?: Translate): string {
  const normalized = title.trim()
  return isDefaultSessionTitle(normalized)
    ? t === undefined
      ? 'New Session'
      : t('sessions.new')
    : normalized
}
