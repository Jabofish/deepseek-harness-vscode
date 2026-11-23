// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary, SubagentCatalog, SubagentView } from '@dsh-vscode/domain'
import { SubagentActivityStrip } from './SubagentActivityStrip.js'

function child(overrides: Partial<SubagentView> & Pick<SubagentView, 'id'>): SubagentView {
  return {
    kind: 'child',
    activity: 'inactive',
    parentSessionId: 'root',
    mode: 'continuable',
    hasChildren: false,
    ...overrides,
  }
}

function catalog(entries: SubagentCatalog['entries'], parentAvailable = true): SubagentCatalog {
  return { entries, parentAvailable }
}

describe('SubagentActivityStrip', () => {
  afterEach(() => cleanup())

  it('renders nothing when the session has no subagents', () => {
    const { container } = render(
      <SubagentActivityStrip
        parentSessionId="root"
        catalog={catalog([])}
        onLoadChildren={vi.fn()}
        onOpenChild={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('stays collapsed by default with live heading and constructs detail DOM lazily on click', async () => {
    const onLoadChildren = vi
      .fn()
      .mockResolvedValue(
        catalog([child({ id: 'c1', name: 'reviewer', label: 'Audit diff', activity: 'running' })]),
      )
    const { container } = render(
      <SubagentActivityStrip
        parentSessionId="root"
        catalog={catalog([child({ id: 'c1', name: 'reviewer', label: 'Audit diff', activity: 'running' })])}
        activities={{
          c1: { sessionId: 'c1', phase: 'tool', toolName: 'edit', activeToolCount: 1 },
        }}
        onLoadChildren={onLoadChildren}
        onOpenChild={vi.fn()}
        onOpenInEditor={vi.fn()}
      />,
    )

    const toggle = screen.getByRole('button', { name: /reviewer · Audit diff/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toContain('Running')
    // Lazy DOM: subpanel is not constructed while collapsed.
    expect(container.querySelector('.dsh-subagent-strip__panel')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.dsh-subagent-strip__panel')).not.toBeNull()
    await waitFor(() => expect(onLoadChildren).toHaveBeenCalledWith('root'))

    // Escape collapses the subpanel and returns focus to the toggle.
    fireEvent.keyDown(screen.getByRole('region', { name: 'Subagent details' }), { key: 'Escape' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.dsh-subagent-strip__panel')).toBeNull()
    expect(document.activeElement).toBe(toggle)
  })

  it('prioritizes awaiting-approval children in the collapsed heading and wires open, editor, and stop actions', async () => {
    const runningChild = child({
      id: 'c1',
      label: 'Builder',
      activity: 'running',
      mode: 'continuable',
      hasChildren: true,
    })
    const blockedChild = child({
      id: 'c2',
      label: 'Deployer',
      activity: 'running',
      mode: 'continuable',
    })
    const externalChild = child({
      id: 'ext-1',
      label: 'External job',
      mode: 'external',
    })
    const onOpenChild = vi.fn()
    const onOpenInEditor = vi.fn()
    let failStop = true
    const onInterruptChild = vi.fn(() => {
      if (failStop) {
        failStop = false
        return Promise.reject(new Error('Interrupt failed'))
      }
      return Promise.resolve()
    })
    const onLoadChildren = vi.fn((sessionId: string) =>
      sessionId === 'c1'
        ? Promise.resolve(catalog([child({ id: 'g1', label: 'Grandchild worker' })]))
        : Promise.resolve(catalog([runningChild, blockedChild, externalChild])),
    )

    render(
      <SubagentActivityStrip
        parentSessionId="root"
        catalog={catalog([runningChild, blockedChild, externalChild])}
        activities={{
          c1: { sessionId: 'c1', phase: 'thinking' },
          c2: { sessionId: 'c2', phase: 'awaiting-approval' },
        }}
        onLoadChildren={onLoadChildren}
        onOpenChild={onOpenChild}
        onOpenInEditor={onOpenInEditor}
        onInterruptChild={onInterruptChild}
      />,
    )

    const toggle = screen.getByRole('button', { name: /Deployer · Awaiting approval/ })
    fireEvent.click(toggle)

    // Open in current surface.
    fireEvent.click(screen.getByRole('button', { name: /^Builder/ }))
    expect(onOpenChild).toHaveBeenCalledWith(runningChild, true)

    // Open in editor tab.
    fireEvent.click(screen.getByRole('button', { name: 'Open Deployer in editor' }))
    expect(onOpenInEditor).toHaveBeenCalledWith(blockedChild)

    // Stop reports a visible retryable failure, then succeeds on retry.
    const stopButton = screen.getByRole('button', { name: 'Stop Deployer' })
    fireEvent.click(stopButton)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Interrupt failed'))
    fireEvent.click(stopButton)
    await waitFor(() => expect(onInterruptChild).toHaveBeenCalledTimes(2))

    // Lazily expand grandchildren.
    fireEvent.click(screen.getByRole('button', { name: 'Expand Builder' }))
    await waitFor(() => expect(screen.getByText('Grandchild worker')).toBeDefined())

    // External child has no open-in-editor or stop button.
    expect(screen.queryByRole('button', { name: 'Open External job in editor' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop External job' })).toBeNull()
  })

  it('features a running grandchild and removes its stop control when the session goes idle', async () => {
    const parent = child({ id: 'c1', label: 'Builder', hasChildren: true })
    const grandchild = child({
      id: 'g1',
      label: 'Worker',
      parentSessionId: 'c1',
      activity: 'running',
    })
    const props = {
      parentSessionId: 'root',
      catalog: catalog([parent]),
      onLoadChildren: vi.fn((id: string) => Promise.resolve(catalog(id === 'c1' ? [grandchild] : [parent]))),
      onOpenChild: vi.fn(),
      onInterruptChild: vi.fn(),
    }
    const { rerender } = render(<SubagentActivityStrip {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Subagent · Builder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand Builder' }))
    await screen.findByRole('button', { name: 'Stop Worker' })
    expect(screen.getByRole('button', { name: 'Worker · Running' })).toBeDefined()

    const summary: SessionSummary = {
      id: 'g1',
      title: 'Worker',
      workspaceId: 'workspace',
      origin: 'subagent',
      parentSessionId: 'c1',
      status: 'idle',
      blank: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }
    rerender(<SubagentActivityStrip {...props} summaries={[summary]} />)
    expect(screen.getByRole('button', { name: '2 subagents' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Stop Worker' })).toBeNull()
  })
})
