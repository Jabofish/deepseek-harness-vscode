/** Value equality at hydration/replacement boundaries; unchanged objects stay shared. */
export function sameTimelineValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== typeof right || left === null || right === null || typeof left !== 'object')
    return false
  if (Array.isArray(left))
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameTimelineValue(value, right[index]))
    )
  if (Array.isArray(right)) return false
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameTimelineValue(a[key], b[key]))
  )
}
