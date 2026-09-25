import { describe, expect, it } from 'vitest'

import {
  accountLifecycleErrorCodeSchema,
  accountProfileDetailsSnapshotSchema,
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

  it('accepts only the minimal profile, wallet, and bonus projection', () => {
    const snapshot = {
      profile: { status: 'ready', value: { name: 'Ada', contact: 'ada@example.test' } },
      balance: {
        status: 'ready',
        value: {
          wallets: [{ currency: 'CNY', balance: '12.30' }],
          bonusWallets: [{ currency: 'USD', balance: '0.5' }],
        },
      },
      bonus: {
        status: 'ready',
        value: {
          orderId: id,
          message: 'Welcome',
          amount: '2.00',
          currency: 'CNY',
          expiresAt: '2026-10-01T00:00:00.000Z',
        },
      },
    }
    expect(accountProfileDetailsSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(
      accountProfileDetailsSnapshotSchema.safeParse({
        ...snapshot,
        profile: { status: 'ready', value: { name: 'Ada', contact: null, id: 'account-1' } },
      }).success,
    ).toBe(false)
    expect(
      accountProfileDetailsSnapshotSchema.safeParse({
        ...snapshot,
        profile: {
          status: 'ready',
          value: { name: 'Ada', contact: null, avatarUrl: 'https://example.test/a.png' },
        },
      }).success,
    ).toBe(false)
    expect(
      accountProfileDetailsSnapshotSchema.safeParse({
        ...snapshot,
        bonus: { status: 'ready', value: { ...snapshot.bonus.value, accountId: 'account-1' } },
      }).success,
    ).toBe(false)
  })
})
