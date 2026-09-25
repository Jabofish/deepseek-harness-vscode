import { describe, expect, it } from 'vitest'

import {
  accountLifecycleErrorCodeSchema,
  accountLifecycleSnapshotSchema,
  accountSignOutImpactSchema,
} from './account-lifecycle-schemas.js'

const id = 'd80ff092-0cdd-4a34-b5fb-05503d8574d8'

describe('account lifecycle Webview DTO schemas', () => {
  it('accepts only the safe status and attempt projection', () => {
    expect(
      accountLifecycleSnapshotSchema.parse({
        status: 'credential-stored',
        attempt: { id, phase: 'waiting-browser', expiresAt: 1_900_000_000_000 },
      }),
    ).toEqual({
      status: 'credential-stored',
      attempt: { id, phase: 'waiting-browser', expiresAt: 1_900_000_000_000 },
    })
    expect(accountLifecycleSnapshotSchema.parse({ status: 'signed-out', attempt: null })).toEqual({
      status: 'signed-out',
      attempt: null,
    })
  })

  it.each([
    {
      status: 'credential-stored',
      attempt: { id, phase: 'waiting-browser', authorizeUrl: 'https://platform/?code_challenge=secret' },
    },
    { status: 'credential-stored', attempt: { id, phase: 'waiting-browser', token: 'secret' } },
    { status: 'credential-stored', attempt: { id, phase: 'waiting-browser', callbackCode: 'secret' } },
  ])('rejects host-only or credential-shaped fields', (value) => {
    expect(accountLifecycleSnapshotSchema.safeParse(value).success).toBe(false)
  })

  it('keeps sign-out impact conservative and errors allowlisted', () => {
    expect(accountSignOutImpactSchema.options).toEqual(['none', 'running', 'unknown'])
    expect(accountSignOutImpactSchema.safeParse('unknown').success).toBe(true)
    expect(accountSignOutImpactSchema.safeParse('active').success).toBe(false)
    expect(accountLifecycleErrorCodeSchema.safeParse('browser-open-failed').success).toBe(true)
    expect(accountLifecycleErrorCodeSchema.safeParse('secret-token').success).toBe(false)
  })
})
