/**
 * The official client records the caller's IANA zone on every prompt for
 * message provenance (the host stores it on that exact user message). The
 * host canonicalizes the value and rejects anything that is not "UTC" or an
 * IANA Area/Location name, so omit the field when the runtime cannot produce
 * one; the contract marks it optional for exactly that case.
 */
export function clientTimeZoneField(): { readonly clientTimeZone: string } | Readonly<Record<string, never>> {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone === 'string' && /^[A-Za-z_]+\/[A-Za-z_0-9+-]+$|^UTC$/u.test(zone.trim()))
      return { clientTimeZone: zone.trim() }
  } catch {
    /* an omitted zone is contract-legal */
  }
  return {}
}
