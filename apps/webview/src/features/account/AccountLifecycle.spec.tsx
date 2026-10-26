// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AccountLifecycle, type AccountLifecycleLabels } from './AccountLifecycle.js'

const labels: AccountLifecycleLabels = {
  title: 'DeepSeek account',
  loading: 'Loading account status',
  signedOut: 'Signed out',
  credentialStored: 'Account credential stored',
  signIn: 'Sign in',
  cancelSignIn: 'Cancel sign-in',
  checkSignOutImpact: 'Check active tasks',
  signOut: 'Sign out',
  sessionExpired: 'The account session expired',
  requestFailed: 'Could not load account state',
  retry: 'Retry',
  phases: {
    initializing: 'Preparing sign-in',
    'waiting-browser': 'Waiting for browser',
    exchanging: 'Completing sign-in',
    committing: 'Saving account',
    succeeded: 'Sign-in complete',
    cancelled: 'Sign-in cancelled',
    expired: 'Sign-in expired',
    failed: 'Sign-in failed',
  },
  errors: {
    network: 'Network error',
    protocol: 'Protocol error',
    expired: 'Expired',
    storage: 'Storage error',
  },
  hostErrors: {
    'state-stream-failed': 'Account state stream failed',
    'expiry-stream-failed': 'Account expiry stream failed',
    'browser-open-failed': 'Browser could not open',
  },
  impacts: {
    none: 'No account tasks are running',
    running: 'Account tasks are running',
    unknown: 'Could not check active tasks',
  },
}

afterEach(cleanup)

describe('AccountLifecycle', () => {
  it('renders the safe signed-out state and starts sign-in', () => {
    const onSignIn = vi.fn()
    render(
      <AccountLifecycle
        snapshot={{ status: 'signed-out', attempt: null }}
        labels={labels}
        onSignIn={onSignIn}
        onCancelSignIn={vi.fn()}
        onCheckSignOutImpact={vi.fn()}
        onSignOut={vi.fn()}
        onRetry={vi.fn()}
      />,
    )

    expect(screen.getByRole('status').textContent).toContain('Signed out')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(onSignIn).toHaveBeenCalledOnce()
  })

  it('cancels by the visible attempt id and displays safe errors without auth material', () => {
    const onCancelSignIn = vi.fn()
    render(
      <AccountLifecycle
        snapshot={{
          status: 'signed-out',
          attempt: {
            id: 'd80ff092-0cdd-4a34-b5fb-05503d8574d8',
            phase: 'waiting-browser',
            errorCode: 'network',
          },
        }}
        labels={labels}
        onSignIn={vi.fn()}
        onCancelSignIn={onCancelSignIn}
        onCheckSignOutImpact={vi.fn()}
        onSignOut={vi.fn()}
        onRetry={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }))
    expect(onCancelSignIn).toHaveBeenCalledExactlyOnceWith('d80ff092-0cdd-4a34-b5fb-05503d8574d8')
    expect(screen.getByRole('alert').textContent).toContain('Network error')
    expect(screen.queryByText(/code_challenge|authorize|token/i)).toBeNull()
  })
})
