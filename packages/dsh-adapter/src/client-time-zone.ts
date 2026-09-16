/**
 * The official client records the caller's IANA zone on every prompt for
 * message provenance (the host stores it on that exact user message). The host
 * canonicalizes the value and rejects anything that is not "UTC" or an IANA
 * Area/Location name, so this side must apply the same profile: a stricter
 * filter would silently drop the provenance, and a looser one would fail the
 * whole prompt with `session/invalid-time-zone`.
 *
 * `IANA_TIME_ZONE` mirrors `canonicalClientTimeZone` in the host's
 * `@deepseek-ai/dsh-util-time`. Multi-segment names (`Asia/…`, and real zones
 * such as `America/Argentina/Buenos_Aires` or `America/Indiana/Indianapolis`)
 * are accepted: the profile allows any number of `/`-separated segments.
 */
const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/u

/** Validate and canonicalize one zone exactly as the host does. */
export function clientTimeZoneValue(zone: unknown): string | undefined {
  if (typeof zone !== 'string' || zone.length === 0 || zone.trim() !== zone) return undefined
  if (zone !== 'UTC' && !IANA_TIME_ZONE.test(zone)) return undefined
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
    if (canonical !== 'UTC' && !IANA_TIME_ZONE.test(canonical)) return undefined
    return canonical
  } catch {
    return undefined
  }
}

export function clientTimeZoneField(): { readonly clientTimeZone: string } | Readonly<Record<string, never>> {
  let zone: string | undefined
  try {
    zone = clientTimeZoneValue(Intl.DateTimeFormat().resolvedOptions().timeZone)
  } catch {
    /* an omitted zone is contract-legal */
  }
  return zone === undefined ? {} : { clientTimeZone: zone }
}
