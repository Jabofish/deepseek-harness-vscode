// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@dsh-vscode/domain'
import { SessionLineage } from './SessionLineage.js'

function session(partial: Partial<SessionSummary> & { id: string; title: string }): SessionSummary {
  return {
    workspaceId: 'w1',
    blank: false,
    status: 'completed',
    createdAt: '',
    updatedAt: '',
    ...partial,
  }
}

describe('SessionLineage', () => {
  afterEach(() => cleanup())

  it('renders a clickable parent breadcrumb for an active subagent', () => {
    const onOpenSession = vi.fn()
    render(
      <SessionLineage
        active={session({ id: 'child', title: 'Child', origin: 'subagent', parentSessionId: 'root' })}
        activeSubagent={{ id: 'child', label: 'Child', parentSessionId: 'root' }}
        sessions={[session({ id: 'root', title: 'Main session' })]}
        onOpenSession={onOpenSession}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open ancestor Main session' }))
    expect(onOpenSession).toHaveBeenCalledWith('root')
    expect(screen.getByText('Child')).toBeDefined()
  })
})
