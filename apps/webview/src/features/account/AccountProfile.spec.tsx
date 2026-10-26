// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AccountProfileDetailsSnapshot } from '@dsh-vscode/domain'
import { AccountProfile, type AccountProfileLabels } from './AccountProfile.js'

const labels: AccountProfileLabels = {
  title: 'DeepSeek account',
  refresh: 'Refresh',
  profile: 'Profile',
  balance: 'Balance',
  bonusBalance: 'Bonus balance',
  bonusNotice: 'Bonus credited',
  signedOut: 'Sign in to view',
  unavailable: 'Unavailable',
  failed: 'Could not load',
  noBalance: 'No balance',
  unnamed: 'DeepSeek account',
  dismissBonus: 'Dismiss',
  retryBonus: 'Retry',
  usage: 'Usage',
  topUp: 'Top up',
}

const bonusNotice = {
  orderId: '0bd8870d-2648-4c4c-95ca-d9e89f08095c',
  message: 'A bonus has been credited to your account.',
  amount: '10.00',
  currency: 'CNY' as const,
  expiresAt: '2099-10-01T00:00:00.000Z',
}

const snapshot: AccountProfileDetailsSnapshot = {
  accountScopeRevision: 1,
  profile: { status: 'ready', value: { name: 'Test User', contact: 'u***@example.test' } },
  balance: {
    status: 'ready',
    value: {
      wallets: [{ currency: 'CNY', balance: '1234.50' }],
      bonusWallets: [{ currency: 'USD', balance: '5.00' }],
    },
  },
  bonus: {
    status: 'ready',
    value: bonusNotice,
  },
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('AccountProfile', () => {
  it('renders the display profile and both wallet types and sends page actions to the Host', () => {
    const onOpenUsage = vi.fn()
    const onOpenTopUp = vi.fn()
    render(
      <AccountProfile
        snapshot={{ ...snapshot, bonus: { status: 'ready', value: null } }}
        signedIn
        labels={labels}
        locale="en-US"
        onRefresh={vi.fn()}
        onAcknowledgeBonus={vi.fn().mockResolvedValue(true)}
        onOpenUsage={onOpenUsage}
        onOpenTopUp={onOpenTopUp}
      />,
    )

    expect(screen.getByText('Test User')).toBeTruthy()
    expect(screen.getByText('u***@example.test')).toBeTruthy()
    expect(screen.getByText('¥1,234.50')).toBeTruthy()
    expect(screen.getByText('$5.00')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }))
    fireEvent.click(screen.getByRole('button', { name: 'Top up' }))
    expect(onOpenUsage).toHaveBeenCalledOnce()
    expect(onOpenTopUp).toHaveBeenCalledOnce()
  })

  it('isolates notice and acknowledgement state when the Host switches account scope', async () => {
    let resolveOldAcknowledgement!: (accepted: boolean) => void
    const oldAcknowledgement = new Promise<boolean>((resolve) => {
      resolveOldAcknowledgement = resolve
    })
    const onAcknowledgeBonus = vi
      .fn()
      .mockImplementationOnce(() => oldAcknowledgement)
      .mockResolvedValueOnce(true)
    const view = render(
      <AccountProfile
        snapshot={snapshot}
        signedIn
        labels={labels}
        locale="en-US"
        onRefresh={vi.fn()}
        onAcknowledgeBonus={onAcknowledgeBonus}
        onOpenUsage={vi.fn()}
        onOpenTopUp={vi.fn()}
      />,
    )
    await waitFor(() => expect(onAcknowledgeBonus).toHaveBeenCalledOnce())

    view.rerender(
      <AccountProfile
        snapshot={{
          ...snapshot,
          accountScopeRevision: 2,
          bonus: {
            status: 'ready',
            value: { ...bonusNotice, message: 'A different account bonus.' },
          },
        }}
        signedIn
        labels={labels}
        locale="en-US"
        onRefresh={vi.fn()}
        onAcknowledgeBonus={onAcknowledgeBonus}
        onOpenUsage={vi.fn()}
        onOpenTopUp={vi.fn()}
      />,
    )

    await waitFor(() => expect(onAcknowledgeBonus).toHaveBeenCalledTimes(2))
    await act(() => {
      resolveOldAcknowledgement(true)
      return oldAcknowledgement
    })
    expect(screen.getByText('A different account bonus.')).toBeTruthy()
    expect(screen.queryByText('A bonus has been credited to your account.')).toBeNull()
  })

  it('shows profile and balance failures independently with a retry action', () => {
    const onRefresh = vi.fn()
    render(
      <AccountProfile
        snapshot={{
          accountScopeRevision: 0,
          profile: { status: 'failed' },
          balance: { status: 'failed' },
          bonus: { status: 'unavailable' },
        }}
        signedIn
        requestFailed
        labels={labels}
        locale="en-US"
        onRefresh={onRefresh}
        onAcknowledgeBonus={vi.fn().mockResolvedValue(false)}
        onOpenUsage={vi.fn()}
        onOpenTopUp={vi.fn()}
      />,
    )

    for (const label of [labels.profile, labels.balance, labels.bonusBalance]) {
      expect(within(screen.getByLabelText(label)).getByRole('alert').textContent).toBe(labels.failed)
    }
    onRefresh.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(onRefresh).toHaveBeenCalled()
  })
})
