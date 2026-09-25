// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
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
    expect(screen.getByText('The agent is waiting for your decision')).toBeDefined()
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
