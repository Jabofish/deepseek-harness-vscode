import { describe, expect, it } from 'vitest'

import { clientTimeZoneValue } from '../src/client-time-zone.js'

/**
 * The Host canonicalizes and validates this field itself
 * (`canonicalClientTimeZone` in dsh-util-time), and its profile accepts *every*
 * IANA Area/Location name — including the multi-segment names real users live
 * in (`America/Argentina/Buenos_Aires`, `America/Indiana/Indianapolis`). A
 * client-side filter that is stricter than that profile does not fail loudly:
 * it silently omits the field, and the model loses the message's local time.
 */
describe('client time zone provenance', () => {
  it('forwards multi-segment IANA zones the Host accepts', () => {
    // The Host canonicalizes through the same Intl call, so a derived name is
    // the value that ends up on the durable message; what matters here is that
    // a multi-segment zone is no longer dropped before it is ever sent.
    expect(clientTimeZoneValue('America/Argentina/Buenos_Aires')).toBe('America/Buenos_Aires')
    expect(clientTimeZoneValue('America/Indiana/Indianapolis')).toBe('America/Indianapolis')
    expect(clientTimeZoneValue('America/North_Dakota/New_Salem')).toBe('America/North_Dakota/New_Salem')
  })

  it('rejects a name the Host would refuse instead of sending it', () => {
    // A value the Host rejects fails the whole prompt, so the client may only
    // forward names that survive the same profile.
    expect(clientTimeZoneValue('')).toBeUndefined()
    expect(clientTimeZoneValue(' Asia/Shanghai')).toBeUndefined()
    expect(clientTimeZoneValue('Asia/Shanghai ')).toBeUndefined()
    expect(clientTimeZoneValue('Shanghai')).toBeUndefined()
    expect(clientTimeZoneValue('/Shanghai')).toBeUndefined()
    expect(clientTimeZoneValue('Asia/')).toBeUndefined()
    expect(clientTimeZoneValue('Mars/Phobos')).toBeUndefined()
    expect(clientTimeZoneValue(undefined)).toBeUndefined()
    expect(clientTimeZoneValue(7)).toBeUndefined()
  })
})
