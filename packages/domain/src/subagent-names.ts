/** One sibling name supplied by a named subagent catalog. */
export function isSubagentName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/u.test(value) && value !== 'lead'
}
