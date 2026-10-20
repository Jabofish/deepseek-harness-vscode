// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PermissionRequest } from '@dsh-vscode/domain'
import { I18nProvider, setActiveLocale } from '../../i18n.js'
import { ApprovalCard } from './ApprovalCard.js'

function approvalRequest(): PermissionRequest {
  return {
    id: 'approval-1',
    sessionId: 's1',
    title: 'bash',
    description: 'The command needs approval.',
    risk: 'medium',
    options: [
      { id: 'allowed-once', label: 'Allow once', kind: 'allow-once' },
      { id: 'rejected', label: 'Reject', kind: 'deny' },
    ],
  }
}

describe('ApprovalCard', () => {
  it('keeps rejection available while a complete request is still loading', () => {
    const onRespond = vi.fn()
    render(
      <ApprovalCard
        request={approvalRequest()}
        disabled={false}
        contentPending
        contentFailed
        onRespond={onRespond}
      />,
    )
    const allow = screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' })
    const deny = screen.getByRole<HTMLButtonElement>('button', { name: 'Reject' })
    expect(allow.disabled).toBe(true)
    expect(deny.disabled).toBe(false)
    expect(screen.getByRole('status').textContent).toContain('Retrying automatically')
    fireEvent.click(allow)
    fireEvent.click(deny)
    expect(onRespond.mock.calls).toEqual([['rejected']])
  })
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    setActiveLocale('en')
  })

  it('renders the command the request asks to authorize', () => {
    const command = 'rm -rf build && pnpm install --frozen-lockfile && pnpm build'
    render(
      <ApprovalCard request={approvalRequest()} disabled={false} command={command} onRespond={vi.fn()} />,
    )

    // The command is the thing being approved: a strip that names a decision
    // without showing it asks the user to authorize text they cannot read.
    expect(screen.getByText(command)).toBeDefined()
  })

  it('renders no command line when the request has no resolvable command', () => {
    const { container } = render(
      <ApprovalCard request={approvalRequest()} disabled={false} onRespond={vi.fn()} />,
    )

    expect(container.querySelector('code')).toBeNull()
    expect(screen.getByText('The command needs approval.')).toBeDefined()
    expect(screen.queryByText('The agent is waiting for your decision')).toBeNull()
  })

  it('keeps decisions outside the scrollable command and description', () => {
    const onRespond = vi.fn()
    const { container } = render(
      <ApprovalCard
        request={{ ...approvalRequest(), description: 'Detailed approval reason. '.repeat(100) }}
        disabled={false}
        command={'pnpm check\n'.repeat(100)}
        onRespond={onRespond}
      />,
    )

    const body = container.querySelector<HTMLElement>('.dsh-interaction__body')!
    expect(body.tabIndex).toBe(0)
    expect(body.querySelector('code')?.textContent).toContain('pnpm check')
    const allow = screen.getByRole('button', { name: 'Allow once' })
    const reject = screen.getByRole('button', { name: 'Reject' })
    expect(body.contains(allow)).toBe(false)
    expect(body.contains(reject)).toBe(false)
    fireEvent.click(allow)
    fireEvent.click(reject)
    expect(onRespond.mock.calls).toEqual([['allowed-once'], ['rejected']])
  })

  it('renders the upstream display reason in the active language', () => {
    window.localStorage.setItem('dsh-webview-locale', 'zh')
    render(
      <I18nProvider>
        <ApprovalCard
          request={{
            ...approvalRequest(),
            displayReason: {
              en: 'Allow this command to modify workspace files?',
              zh: '允许此命令修改工作区文件吗？',
            },
          }}
          disabled={false}
          onRespond={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(screen.getByText('允许此命令修改工作区文件吗？')).toBeDefined()
  })

  it('uses DSH English map fallback before the plain approval reason', () => {
    window.localStorage.setItem('dsh-webview-locale', 'zh')
    render(
      <I18nProvider>
        <ApprovalCard
          request={{ ...approvalRequest(), displayReason: { en: 'English fallback copy' } }}
          disabled={false}
          onRespond={vi.fn()}
        />
      </I18nProvider>,
    )

    expect(screen.getByText('English fallback copy')).toBeDefined()
  })
})
