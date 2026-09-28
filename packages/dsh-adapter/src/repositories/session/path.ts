export function samePath(
  left: string | undefined,
  right: string | undefined,
  comparator?: (left: string, right: string) => boolean,
): boolean {
  if (left === undefined || right === undefined || left.trim() === '' || right.trim() === '') return false
  if (comparator !== undefined) return comparator(left, right)
  return normalizePath(left) === normalizePath(right)
}

/**
 * Tests and non-VS Code consumers still get useful matching without making
 * the adapter call a platform filesystem. The Extension Host injects the
 * canonical realpath comparator for production workspace matching.
 */
function normalizePath(value: string): string {
  const segments: string[] = []
  for (const segment of value.trim().replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return segments.join('/').toLocaleLowerCase()
}
