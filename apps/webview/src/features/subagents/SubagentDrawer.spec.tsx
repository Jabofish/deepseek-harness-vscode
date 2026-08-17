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

  it('renders nothing until the session has children', () => {
    const { container } = render(
      <SubagentDrawer
        parentSessionId="root"
        catalog={catalog([])}
        onLoadChildren={vi.fn()}
        onOpenChild={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('uses a descriptive trigger with a separate count badge', () => {
    const { container } = render(
      <SubagentDrawer
        parentSessionId="root"
        catalog={catalog([child({ id: 'c1', label: 'Researcher' })])}
        onLoadChildren={vi.fn()}
        onOpenChild={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Subagents: 1' })).toBeDefined()
    expect(screen.getByText('Subagents')).toBeDefined()
    expect(container.querySelector('.dsh-subagent-tree__trigger-count')?.textContent).toBe('1')
  })

  it('positions the catalog as a viewport-clamped floating menu', () => {
    render(
      <SubagentDrawer
        parentSessionId="root"
        catalog={catalog(ROOT)}
        onLoadChildren={vi.fn().mockResolvedValue(catalog(ROOT))}
        onOpenChild={vi.fn()}
      />,
    )
    const trigger = screen.getByRole('button', { name: 'Subagents: 2, 1 running' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 430,
      y: 8,
      top: 8,
      right: 498,
      bottom: 38,
      left: 430,
      width: 68,
      height: 30,
      toJSON: () => ({}),
    })

    fireEvent.click(trigger)

    const menu = screen.getByRole('tree')
    expect(menu.style.position).toBe('')
    expect(menu.style.top).toBe('44px')
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(12)
    expect(Number.parseFloat(menu.style.width)).toBeLessThanOrEqual(window.innerWidth - 24)
  })

  it('lazily loads a branch on disclosure and nests it at level 2', async () => {
    const onLoadChildren = vi.fn().mockResolvedValue(catalog([child({ id: 'g1', label: 'Grandchild' })]))
    render(
      <SubagentDrawer
        parentSessionId="root"
        catalog={catalog(ROOT)}
        onLoadChildren={onLoadChildren}
        onOpenChild={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Subagents: 2, 1 running' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand Researcher' }))
    await waitFor(() => expect(onLoadChildren).toHaveBeenCalledWith('c1'))
    await waitFor(() =>
      expect(screen.getByRole('treeitem', { name: 'Grandchild · One-shot · Inactive' })).toBeDefined(),
    )
    expect(
      screen.getByRole('treeitem', { name: 'Grandchild · One-shot · Inactive' }).getAttribute('aria-level'),
    ).toBe('2')
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

  it('opens a child session on Enter and toggles branches with arrow keys', () => {
    const onOpenChild = vi.fn()
    render(
      <SubagentDrawer
        parentSessionId="root"
        catalog={catalog(ROOT)}
        onLoadChildren={vi.fn().mockResolvedValue(catalog([]))}
        onOpenChild={onOpenChild}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Subagents: 2, 1 running' }))
    const coder = screen.getByRole('treeitem', { name: 'Coder · One-shot · Inactive' })
    fireEvent.keyDown(coder, { key: 'Enter' })
    expect(onOpenChild).toHaveBeenCalledWith(ROOT[1], true)
    const researcher = screen.getByRole('treeitem', { name: 'Researcher · Continuable · Running' })
    fireEvent.keyDown(researcher, { key: 'ArrowRight' })
    expect(researcher.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(researcher, { key: 'ArrowLeft' })
    expect(researcher.getAttribute('aria-expanded')).toBe('false')
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

  it('preserves parent availability when opening a continuable child', () => {
    const onOpenChild = vi.fn()
    render(
      <SubagentDrawer
        parentSessionId="root"
        catalog={catalog([child({ id: 'c1', label: 'Researcher', mode: 'continuable' })], false)}
        onLoadChildren={vi.fn()}
        onOpenChild={onOpenChild}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Subagents: 1' }))
    fireEvent.click(
      screen.getByRole('treeitem', {
        name: 'Researcher · Continuable · Inactive · Parent unavailable',
      }),
    )
    expect(onOpenChild).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), false)
  })
})
