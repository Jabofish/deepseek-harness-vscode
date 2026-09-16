import { describe, expect, it } from 'vitest'

import { clientTimeZoneField, clientTimeZoneValue } from '../src/client-time-zone.js'

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

  it('forwards the ordinary Area/Location names and UTC', () => {
    expect(clientTimeZoneValue('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(clientTimeZoneValue('America/New_York')).toBe('America/New_York')
    expect(clientTimeZoneValue('Etc/GMT+8')).toBe('Etc/GMT+8')
    expect(clientTimeZoneValue('UTC')).toBe('UTC')
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

  it('omits the field only when the runtime zone cannot be used', () => {
    const field = clientTimeZoneField()
    const zone = field.clientTimeZone
    if (zone === undefined) {
      expect(Object.keys(field)).toEqual([])
      return
    }
    // Whatever the runtime reports must round-trip through the profile above.
    expect(clientTimeZoneValue(zone)).toBeDefined()
  })
})
