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

const snapshot: AccountProfileDetailsSnapshot = {
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
    value: {
      orderId: '0bd8870d-2648-4c4c-95ca-d9e89f08095c',
      message: 'A bonus has been credited to your account.',
      amount: '10.00',
      currency: 'CNY',
      expiresAt: '2099-10-01T00:00:00.000Z',
    },
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

  it('acknowledges a presented bonus but keeps its card open until the user dismisses it', async () => {
    const onAcknowledgeBonus = vi.fn().mockResolvedValue(true)
    render(
      <AccountProfile
        snapshot={snapshot}
        signedIn
        labels={labels}
        locale="zh-CN"
        onRefresh={vi.fn()}
        onAcknowledgeBonus={onAcknowledgeBonus}
        onOpenUsage={vi.fn()}
        onOpenTopUp={vi.fn()}
      />,
    )

    expect(screen.getByText('A bonus has been credited to your account.')).toBeTruthy()
    await waitFor(() =>
      expect(onAcknowledgeBonus).toHaveBeenCalledExactlyOnceWith('0bd8870d-2648-4c4c-95ca-d9e89f08095c'),
    )
    expect(screen.getByText('A bonus has been credited to your account.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('A bonus has been credited to your account.')).toBeNull()
    expect(onAcknowledgeBonus).toHaveBeenCalledOnce()
  })

  it('retains a presented notice after an empty refresh until it is dismissed', async () => {
    const onAcknowledgeBonus = vi.fn().mockResolvedValue(true)
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
        snapshot={{ ...snapshot, bonus: { status: 'ready', value: null } }}
        signedIn
        labels={labels}
        locale="en-US"
        onRefresh={vi.fn()}
        onAcknowledgeBonus={onAcknowledgeBonus}
        onOpenUsage={vi.fn()}
        onOpenTopUp={vi.fn()}
      />,
    )

    expect(screen.getByText('A bonus has been credited to your account.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('A bonus has been credited to your account.')).toBeNull()
  })

  it('waits for the document to become visible before acknowledging a presented notice', async () => {
    const originalVisibility = document.visibilityState
    const onAcknowledgeBonus = vi.fn().mockResolvedValue(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    try {
      render(
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
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(onAcknowledgeBonus).not.toHaveBeenCalled()

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      fireEvent(document, new Event('visibilitychange'))
      await waitFor(() => expect(onAcknowledgeBonus).toHaveBeenCalledOnce())
    } finally {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: originalVisibility,
      })
    }
  })

  it('retries transient acknowledgement failures with bounded backoff', async () => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const onAcknowledgeBonus = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(true)
    render(
      <AccountProfile
        snapshot={snapshot}
        signedIn
        labels={labels}
        locale="en-US"
        onRefresh={vi.fn()}
        onAcknowledgeBonus={onAcknowledgeBonus}
        onOpenUsage={vi.fn()}
        onOpenTopUp={vi.fn()}
        ackRetryDelayMs={10}
        ackRetryMaxDelayMs={20}
      />,
    )

    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(onAcknowledgeBonus).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(9))
    expect(onAcknowledgeBonus).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(onAcknowledgeBonus).toHaveBeenCalledTimes(2)
    expect(screen.getByText('A bonus has been credited to your account.')).toBeTruthy()
  })

  it('formats decimal strings with the upstream two-decimal and sub-cent rules', () => {
    render(
      <AccountProfile
        snapshot={{
          profile: { status: 'unavailable' },
          balance: {
            status: 'ready',
            value: {
              wallets: [
                { currency: 'CNY', balance: '1234.56999' },
                { currency: 'USD', balance: '5e0' },
                { currency: 'CNY', balance: '0.00000001' },
              ],
              bonusWallets: [],
            },
          },
          bonus: { status: 'ready', value: null },
        }}
        signedIn
        labels={labels}
        locale="en-US"
        onRefresh={vi.fn()}
        onAcknowledgeBonus={vi.fn().mockResolvedValue(true)}
        onOpenUsage={vi.fn()}
        onOpenTopUp={vi.fn()}
      />,
    )

    expect(screen.getByText('¥1,234.56')).toBeTruthy()
    expect(screen.getByText('$5.00')).toBeTruthy()
    expect(screen.getByText('<¥0.01')).toBeTruthy()
  })

  it('shows only positive bonus-wallet balances, following the upstream account view', () => {
    render(
      <AccountProfile
        snapshot={{
          ...snapshot,
          balance: {
            status: 'ready',
            value: {
              wallets: [{ currency: 'CNY', balance: '0' }],
              bonusWallets: [
                { currency: 'CNY', balance: '0' },
                { currency: 'USD', balance: '-1.00' },
                { currency: 'USD', balance: '2.50' },
              ],
            },
          },
          bonus: { status: 'ready', value: null },
        }}
        signedIn
        labels={labels}
        locale="en-US"
        onRefresh={vi.fn()}
        onAcknowledgeBonus={vi.fn().mockResolvedValue(true)}
        onOpenUsage={vi.fn()}
        onOpenTopUp={vi.fn()}
      />,
    )

    expect(screen.getByText('$2.50')).toBeTruthy()
    const bonusBalance = within(screen.getByLabelText('Bonus balance'))
    expect(bonusBalance.getAllByRole('listitem')).toHaveLength(1)
    expect(bonusBalance.queryByText('¥0.00')).toBeNull()
    expect(bonusBalance.queryByText('-$1.00')).toBeNull()
  })

  it('shows profile and balance failures independently with a retry action', () => {
    const onRefresh = vi.fn()
    render(
      <AccountProfile
        snapshot={{
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

    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0)
    expect(onRefresh).toHaveBeenCalledOnce()
    onRefresh.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('keeps page actions disabled while signed out', () => {
    render(
      <AccountProfile
        snapshot={{
          profile: { status: 'unavailable' },
          balance: { status: 'unavailable' },
          bonus: { status: 'unavailable' },
        }}
        signedIn={false}
        labels={labels}
        locale="en-US"
        onRefresh={vi.fn()}
        onAcknowledgeBonus={vi.fn().mockResolvedValue(false)}
        onOpenUsage={vi.fn()}
        onOpenTopUp={vi.fn()}
      />,
    )

    expect(screen.getAllByText('Sign in to view').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Usage' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Top up' }).hasAttribute('disabled')).toBe(true)
  })
})
