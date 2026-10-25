// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { TrajectoryView } from './TrajectoryView.js'

const nodes: readonly TimelineNode[] = [
  { kind: 'user-message', id: 'u1', markdown: 'Fix the failing test in parser.spec.ts' },
  {
    kind: 'assistant-message',
    id: 'a1',
    markdown: 'I will inspect the test first.',
    streaming: false,
    modelLabel: 'deepseek-chat',
    usage: {
      inputTokens: 120,
      outputTokens: 34,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      reasoningTokens: 12,
    },
    reasoning: { markdown: 'The parser spec fails on edge cases.', streaming: false },
  },
  {
    kind: 'tool',
    id: 't1',
    tool: {
      id: 't1',
      name: 'shell',
      category: 'execution',
      title: 'shell: pnpm test',
      status: 'completed',
      startedAt: '2026-08-17T05:00:00.000Z',
      completedAt: '2026-08-17T05:00:02.500Z',
      inputSummary: 'pnpm test',
      outputSummary: '1 failed',
      metadata: {},
    },
  },
  {
    kind: 'compaction',
    id: 'c1',
    compaction: { id: 'c1', phase: 'end', replacedCount: 12, estimatedTokens: 9_000 },
  },
  { kind: 'user-message', id: 'u2', markdown: 'Continue' },
  {
    kind: 'tool',
    id: 't2',
    tool: {
      id: 't2',
      name: 'shell',
      category: 'execution',
      title: 'shell: pnpm test',
      status: 'running',
      startedAt: '2026-08-17T05:01:00.000Z',
      inputSummary: 'pnpm test',
      metadata: {},
    },
  },
]

function renderView(
  overrides: Partial<Parameters<typeof TrajectoryView>[0]> = {},
): ReturnType<typeof render> {
  return render(<TrajectoryView sessionId="session-1" nodes={nodes} streaming={false} {...overrides} />)
}

describe('TrajectoryView', () => {
  afterEach(() => {
    cleanup()
    document.body.className = ''
  })

  it('keeps search counts readable without announcing streamed match-count changes in quiet mode', async () => {
    document.body.classList.add('vscode-using-screen-reader')
    const view = renderView({ streaming: true })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search trajectory records' }), {
      target: { value: 'parser' },
    })
    const count = view.container.querySelector('.dsh-trajectory__count')!
    expect(count.getAttribute('role')).toBeNull()
    expect(count.textContent).toContain('match')
    const next = [...nodes, { kind: 'user-message' as const, id: 'new-match', markdown: 'parser' }]
    view.rerender(<TrajectoryView sessionId="session-1" nodes={next} streaming />)
    expect(view.container.querySelector('.dsh-trajectory__count')).toBe(count)
    expect(count.getAttribute('role')).toBeNull()
    await act(async () => {
      document.body.className = ''
      await Promise.resolve()
    })
    expect(count.getAttribute('role')).toBe('status')
  })

  it('keeps one progress region and its role stable until the authoritative run ends', () => {
    const view = renderView({ running: true, streaming: true })
    const region = view.container.querySelector('[aria-live="polite"]')!
    const role = region.getAttribute('role')
    const observer = new MutationObserver(() => undefined)
    observer.observe(region, { subtree: true, attributes: true, characterData: true, childList: true })
    expect(region.textContent).toBe('Response is streaming')
    view.rerender(<TrajectoryView sessionId="session-1" nodes={nodes} running streaming={false} />)
    expect(region.textContent).toBe('Response is streaming')
    expect(observer.takeRecords()).toHaveLength(0)
    view.rerender(<TrajectoryView sessionId="session-1" nodes={nodes} running={false} streaming={false} />)
    expect(view.container.querySelector('[aria-live="polite"]')).toBe(region)
    expect(region.textContent).toBe('Response finished')
    expect(region.getAttribute('role')).toBe(role)
    expect(observer.takeRecords().filter((record) => record.type === 'attributes')).toHaveLength(0)
    view.rerender(<TrajectoryView sessionId="session-2" nodes={[]} streaming={false} />)
    expect(region.textContent).toBe('')
    view.rerender(<TrajectoryView sessionId="session-2" nodes={[]} streaming />)
    expect(region.textContent).toBe('Response is streaming')
    observer.disconnect()
  })

  it('automatically replaces a clipped selected tool result with its complete inline output', async () => {
    const tool = nodes.find((node) => node.kind === 'tool' && node.id === 't1')
    if (tool?.kind !== 'tool') throw new Error('tool fixture missing')
    const fullOutput = 'Complete tool output\n'.repeat(600) + 'LAST_OUTPUT_LINE'
    let finish!: (node: TimelineNode) => void
    const loadFullNode = vi.fn(
      () =>
        new Promise<TimelineNode>((resolve) => {
          finish = resolve
        }),
    )
    renderView({ nodes: [tool], omittedNodeIds: ['t1'], loadFullNode })
    fireEvent.click(screen.getByText('shell: pnpm test'))
    const region = screen.getByRole('region', { name: 'Record #1 details' })
    expect(within(region).getByRole('status').textContent).toContain('still incomplete')
    await waitFor(() => expect(loadFullNode).toHaveBeenCalledWith('t1', expect.any(AbortSignal)))
    await act(async () => {
      finish({ ...tool, tool: { ...tool.tool, outputSummary: fullOutput } })
      await Promise.resolve()
    })
    expect(region.querySelectorAll('pre')[1]?.textContent).toBe(fullOutput)
    expect(within(region).queryByRole('status')).toBeNull()
    expect(within(region).getAllByRole('button')).toHaveLength(1)
  })

  it('renders turn sections with a standalone between-turns compaction section', () => {
    renderView()
    expect(screen.getByRole('region', { name: 'Turn 1' })).toBeDefined()
    expect(screen.getByRole('region', { name: 'Between turns' })).toBeDefined()
    expect(screen.getByRole('region', { name: 'Turn 2' })).toBeDefined()
    expect(screen.getByText('6 records')).toBeDefined()
  })

  it('takes the keyboard into the inspector and returns it via Escape to the row', () => {
    renderView()

    const row = screen.getByRole('button', { name: /#2/u })
    fireEvent.click(row)
    const inspector = screen.getByRole('region', { name: /Record #2/u })
    expect(document.activeElement).toBe(inspector)

    // Escape dismisses the details and the keyboard goes back to the row that
    // opened them.
    fireEvent.keyDown(inspector, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: /Record #2/u })).toBeNull()
    expect(document.activeElement).toBe(row)
  })

  it('numbers records continuously and marks tool durations', () => {
    renderView()
    expect(screen.getAllByText('#1')).toHaveLength(1)
    expect(screen.getAllByText('#4')).toHaveLength(1)
    expect(screen.getByText('2,500 ms')).toBeDefined()
  })

  it('shows a live state instead of a duration for running rows', () => {
    renderView()
    expect(screen.getByText('running')).toBeDefined()
  })

  it('preserves unchanged ledger rows when a later node streams an update', () => {
    const view = renderView()
    const firstRow = screen.getByText('Fix the failing test in parser.spec.ts')
    const nextNodes = nodes.map((node, index) =>
      index === nodes.length - 1 && node.kind === 'tool'
        ? { ...node, tool: { ...node.tool, outputSummary: 'still running' } }
        : node,
    )

    view.rerender(<TrajectoryView sessionId="session-1" nodes={nextNodes} streaming />)

    expect(screen.getByText('Fix the failing test in parser.spec.ts')).toBe(firstRow)
  })

  it('opens the inspector with usage and payload details on selection', () => {
    renderView()
    fireEvent.click(screen.getByText('I will inspect the test first.'))
    const region = screen.getByRole('region', { name: 'Record #2 details' })
    expect(region).toBeDefined()
    expect(screen.getByText('120 tk')).toBeDefined()
    expect(screen.getByText('800 tk')).toBeDefined()
    expect(screen.getByText('34 tk')).toBeDefined()
    expect(screen.getByText('Thinking')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(screen.queryByRole('region', { name: 'Record #2 details' })).toBeNull()
  })

  it('filters the ledger with the toolbar search', () => {
    renderView()
    const search = screen.getByRole('searchbox', { name: 'Search trajectory records' })
    fireEvent.change(search, { target: { value: 'parser' } })
    expect(screen.getByText('2 matches')).toBeDefined()
    expect(screen.queryByRole('region', { name: 'Turn 1' })).toBeNull()
    fireEvent.change(search, { target: { value: 'no-such-needle' } })
    expect(screen.getByText('0 matches')).toBeDefined()
  })

  it('shows an empty state for blank sessions', () => {
    renderView({ nodes: [] })
    expect(screen.getByText('No trajectory records yet.')).toBeDefined()
  })
})
