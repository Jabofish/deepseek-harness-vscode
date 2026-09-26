export function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return object(value) !== undefined
}
