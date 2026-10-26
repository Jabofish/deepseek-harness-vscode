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
})
