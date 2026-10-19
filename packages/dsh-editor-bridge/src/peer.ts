/**
 * Before Principal was introduced, the authenticated Gateway supplied only id/ctx.
 * New gateways must still prove owner authority when a principal is present.
 */
export function editorPeerId(value: unknown): string | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0
  )
    return undefined
  if (!('principal' in value)) return value.id
  const principal = value.principal
  return typeof principal === 'object' &&
    principal !== null &&
    'kind' in principal &&
    principal.kind === 'owner'
    ? value.id
    : undefined
}
