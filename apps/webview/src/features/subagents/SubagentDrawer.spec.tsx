// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubagentCatalog, SubagentView } from '@dsh-vscode/domain'
import { SubagentDrawer } from './SubagentDrawer.js'

function child(overrides: Partial<SubagentView> & Pick<SubagentView, 'id'>): SubagentView {
  return {
    kind: 'child',
    activity: 'inactive',
    parentSessionId: 'root',
    mode: 'one-shot',
    hasChildren: false,
    ...overrides,
  }
}

const ROOT: readonly SubagentView[] = [
  child({ id: 'c1', label: 'Researcher', activity: 'running', mode: 'continuable', hasChildren: true }),
  child({ id: 'c2', label: 'Coder' }),
]

function catalog(entries: SubagentCatalog['entries'], parentAvailable = true): SubagentCatalog {
  return { entries, parentAvailable }
}

describe('SubagentDrawer tree', () => {
  afterEach(() => cleanup())

  it('shows external executions without opening or loading a nonexistent child conversation', () => {
    const onOpenChild = vi.fn()
    const onLoadChildren = vi.fn()
    render(
      <SubagentDrawer
        parentSessionId="root"
        catalog={catalog([child({ id: 'external-1', mode: 'external' })])}
        onLoadChildren={onLoadChildren}
        onOpenChild={onOpenChild}
      />,
    )
    fireEvent.click(screen.getByRole('button'))
    const entry = screen.getByRole('treeitem', { name: /External/ })
    expect(entry.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(entry)
    fireEvent.keyDown(entry, { key: 'Enter' })
    expect(onOpenChild).not.toHaveBeenCalled()
    expect(onLoadChildren).not.toHaveBeenCalled()
  })

  it('reports a failed branch load and retries after collapsing and expanding it again', async () => {
    let branchAttempts = 0
    const onLoadChildren = vi.fn((sessionId: string) => {
      if (sessionId === 'root') return Promise.resolve(catalog(ROOT))
      branchAttempts += 1
      return branchAttempts === 1
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(catalog([child({ id: 'g1', label: 'Grandchild' })]))
    })
    render(
      <SubagentDrawer
        parentSessionId="root"
        catalog={catalog(ROOT)}
        onLoadChildren={onLoadChildren}
        onOpenChild={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Subagents: 2, 1 running' }))
    const disclosure = screen.getByRole('button', { name: 'Expand Researcher' })
    fireEvent.click(disclosure)
    await waitFor(() => expect(screen.getByText('Unable to load · expand to retry')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Researcher' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand Researcher' }))

    await waitFor(() => expect(screen.getByText('Grandchild')).toBeDefined())
    expect(branchAttempts).toBe(2)
  })

  it('keeps diagnostic rows visible and disabled without counting them as healthy children', () => {
    render(
      <SubagentDrawer
        parentSessionId="root"
        catalog={catalog([
          child({ id: 'c1', label: 'Researcher' }),
          { kind: 'diagnostic', id: 'broken', parentSessionId: 'root', reason: 'corrupt' },
        ])}
        onLoadChildren={vi.fn()}
        onOpenChild={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Subagents: 1, 1 unavailable' }))
    const diagnostic = screen.getByRole('treeitem', { name: 'broken · Corrupt child record' })
    expect(diagnostic.getAttribute('aria-disabled')).toBe('true')
  })
})
