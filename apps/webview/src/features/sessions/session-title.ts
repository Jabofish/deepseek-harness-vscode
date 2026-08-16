export function isDefaultSessionTitle(title: string): boolean {
  const normalized = title.trim()
  return (
    normalized === '' || normalized.toLowerCase() === 'new session' || /^session\s+session-/i.test(normalized)
  )
}

export function displaySessionTitle(title: string): string {
  const normalized = title.trim()
  return isDefaultSessionTitle(normalized) ? 'New Session' : normalized
}
