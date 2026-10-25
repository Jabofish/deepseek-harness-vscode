// @vitest-environment jsdom
import { useState, type ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'
import type { ConversationLayout } from '../../app/conversation-layout.js'
import { ReasoningDisclosure } from './ReasoningDisclosure.js'
import { ToolCallCollection, type ToolTimelineNode } from './ToolCallCollection.js'
import { FocusedToolActivity } from './FocusedToolActivity.js'
import { Timeline } from './Timeline.js'
import { GoalsTasksStrip } from '../goals/GoalsTasksStrip.js'
import type { TranscriptViewMode } from '../../app/ui-preferences.js'

const t = (key: string): string => key
afterEach(() => {
  cleanup()
  localStorage.clear()
  document.body.className = ''
  vi.restoreAllMocks()
})

it('keeps progress counters readable without automatic count announcements in quiet mode', async () => {
  const view = render(
    <GoalsTasksStrip goals={[]} todos={[{ id: 'one', content: 'Inspect', status: 'pending' }]} />,
  )
  expect(view.container.querySelector('.dsh-goals-tasks__count')?.getAttribute('role')).toBe('status')
  await act(async () => {
    await Promise.resolve()
    document.body.classList.add('vscode-using-screen-reader')
  })
  view.rerender(
    <GoalsTasksStrip goals={[]} todos={[{ id: 'one', content: 'Inspect', status: 'completed' }]} />,
  )
  expect(view.container.querySelector('.dsh-goals-tasks__count')?.textContent).toBe('1/1')
  expect(view.container.querySelector('.dsh-goals-tasks__count')?.getAttribute('role')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Expand goals and tasks' }))
  expect(view.container.querySelector('.dsh-todo-list__progress')?.getAttribute('role')).toBeNull()
})

function tool(
  id: string,
  status: ToolTimelineNode['tool']['status'] = 'running',
  output = 'first',
): ToolTimelineNode {
  return {
    kind: 'tool',
    id,
    tool: {
      id,
      name: 'shell',
      title: output,
      category: 'execution',
      status,
      inputSummary: output,
      outputSummary: output,
      metadata: {},
    },
  }
}

function Tools(props: {
  readonly layout: ConversationLayout
  readonly tools: readonly ToolTimelineNode[]
}): ReactElement {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const input = { tools: props.tools, expanded, translate: t }
  return (
    <ConversationLayoutProvider initialLayout={props.layout}>
      {props.layout === 'focused' ? (
        <FocusedToolActivity {...input} transcriptView="detailed" onExpandedChange={setExpanded} />
      ) : (
        <ToolCallCollection {...input} onExpandedChange={setExpanded} />
      )}
    </ConversationLayoutProvider>
  )
}

it.each<readonly [ConversationLayout, TranscriptViewMode, boolean]>([
  ['classic', 'compact', true],
  ['classic', 'standard', true],
  ['classic', 'detailed', true],
  ['classic', 'verbose', true],
  ['focused', 'standard', false],
  ['focused', 'verbose', false],
  ['focused', 'verbose', true],
])('controls stable Timeline rows in %s/%s (turn coordinates: %s)', (layout, transcriptView, hasTurn) => {
  document.body.classList.add('vscode-using-screen-reader')
  const source = (status: ToolTimelineNode['tool']['status']): ToolTimelineNode => {
    const node = tool('one', status, 'current tool output')
    return hasTurn ? { ...node, tool: { ...node.tool, turn: 1, step: 0 } } : node
  }
  const runningNodes = [source('running')]
  const completedNodes = [source('completed')]
  const content = (running: boolean): ReactElement => (
    <ConversationLayoutProvider initialLayout={layout}>
      <Timeline
        sessionId="s"
        running={running}
        streaming={running}
        transcriptView={transcriptView}
        nodes={running ? runningNodes : completedNodes}
      />
    </ConversationLayoutProvider>
  )
  const view = render(content(true))
  const toggle = screen.getByRole('button', { name: 'Tools working…' })
  if (layout === 'classic' && transcriptView !== 'verbose')
    expect(toggle.closest('.dsh-timeline__card--assistant')).not.toBeNull()
  if (layout === 'focused') expect(toggle.closest('.dsh-focused-turn') !== null).toBe(hasTurn)
  const group = toggle.closest('[data-quiet-tools]')!
  toggle.focus()
  // No new source delta or parent rerender: only Timeline's expansion state changes.
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(group.querySelector('[data-tool-call-id]')).not.toBeNull()
  expect(document.activeElement).toBe(toggle)
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(group.querySelector('[data-tool-call-id]')).toBeNull()
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  view.rerender(content(false))
  const settledToggle = screen.getByRole('button', { name: 'Tool activity finished' })
  fireEvent.click(settledToggle)
  expect(settledToggle.getAttribute('aria-expanded')).toBe('false')
  expect(group.querySelector('[data-tool-call-id]')).toBeNull()
  fireEvent.click(settledToggle)
  expect(settledToggle.getAttribute('aria-expanded')).toBe('true')
  expect(group.querySelector('[data-tool-call-id]')).not.toBeNull()
})

it.each([false, true])(
  'keeps focus on the process summary or row when a preparing tool has no live controls (turn: %s)',
  async (hasTurn) => {
    document.body.classList.add('vscode-using-screen-reader')
    const preparing: ToolTimelineNode = {
      kind: 'tool',
      id: 'preparing',
      tool: {
        id: 'preparing',
        name: 'dynamic',
        title: 'Preparing tool',
        category: 'other',
        status: 'queued',
        metadata: {},
        preparation: { attemptId: 'attempt', updateIndex: 1 },
        ...(hasTurn ? { turn: 1, step: 0 } : {}),
      },
    }
    const view = render(
      <ConversationLayoutProvider initialLayout="focused">
        <Timeline sessionId="s" streaming running transcriptView="detailed" nodes={[preparing]} />
      </ConversationLayoutProvider>,
    )
    const quietSummary = screen.getByRole('button', { name: 'Tools working…' })
    const row = quietSummary.closest<HTMLElement>('.dsh-timeline__row')!
    quietSummary.focus()
    await act(async () => {
      document.body.classList.remove('vscode-using-screen-reader')
      await Promise.resolve()
    })
    expect(quietSummary.isConnected).toBe(false)
    expect(document.activeElement).toBe(hasTurn ? row.querySelector('.dsh-focused-turn__summary') : row)
    if (!hasTurn) expect(row.tabIndex).toBe(-1)
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    await act(async () => {
      document.body.classList.add('vscode-using-screen-reader')
      await Promise.resolve()
    })
    expect(document.activeElement).toBe(outside)
    outside.remove()
    view.unmount()
  },
)

describe.each(['focused', 'classic'] as const)('%s quiet activity', (layout) => {
  it('preserves the group trigger and focus when another tool joins its running batch', () => {
    document.body.classList.add('vscode-using-screen-reader')
    const one = tool('one')
    const two = tool('two')
    const batch = [one, two].map((node) => ({ ...node, tool: { ...node.tool, turn: 1, step: 0 } }))
    const content = (tools: readonly ToolTimelineNode[]): ReactElement => (
      <ConversationLayoutProvider initialLayout={layout}>
        <Timeline sessionId="s" streaming running nodes={tools} />
      </ConversationLayoutProvider>
    )
    const view = render(content(batch.slice(0, 1)))
    const trigger = screen.getByRole('button', { name: 'Tools working…' })
    trigger.focus()
    view.rerender(content(batch))
    expect(screen.getByRole('button', { name: 'Tools working…' })).toBe(trigger)
    expect(document.activeElement).toBe(trigger)
  })

  it('does not overwrite another disclosure when a memoized tool card is toggled', () => {
    document.body.classList.add('vscode-using-screen-reader')
    render(
      <ConversationLayoutProvider initialLayout={layout}>
        <Timeline
          sessionId="s"
          streaming
          running
          nodes={[
            tool('one'),
            {
              kind: 'assistant-message',
              id: 'answer',
              markdown: 'Live answer',
              streaming: true,
              reasoning: { markdown: 'Current reasoning', streaming: true },
            },
          ]}
        />
      </ConversationLayoutProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Tools working…' }))
    const card = document.querySelector('[data-tool-call-id] button')!
    fireEvent.click(screen.getByRole('button', { name: 'Show reasoning' }))
    expect(screen.getByRole('button', { name: 'Hide reasoning' })).toBeDefined()
    fireEvent.click(card)
    expect(screen.getByRole('button', { name: 'Hide reasoning' })).toBeDefined()
    expect(card.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Tools working…' }))
    expect(screen.getByRole('button', { name: 'Hide reasoning' })).toBeDefined()
  })

  it.each(['standard', 'verbose'] as const)(
    'keeps keyboard focus in the tool row when screen-reader presentation changes in %s',
    async (transcriptView) => {
      document.body.classList.add('vscode-using-screen-reader')
      const view = render(
        <ConversationLayoutProvider initialLayout={layout}>
          <Timeline
            sessionId="s"
            streaming
            running
            transcriptView={transcriptView}
            nodes={
              layout === 'classic' && transcriptView === 'standard'
                ? [tool('one'), tool('two')]
                : [tool('one')]
            }
          />
        </ConversationLayoutProvider>,
      )
      screen.getByRole('button', { name: 'Tools working…' }).focus()
      await act(async () => {
        document.body.classList.remove('vscode-using-screen-reader')
        await Promise.resolve()
      })
      expect(document.activeElement?.closest('.dsh-timeline__row')).not.toBeNull()
      await act(async () => {
        document.body.classList.add('vscode-using-screen-reader')
        await Promise.resolve()
      })
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Tools working…' }))
      // A later presentation change must not steal focus from the composer/settings.
      const outside = document.createElement('button')
      document.body.append(outside)
      outside.focus()
      await act(async () => {
        document.body.classList.remove('vscode-using-screen-reader')
        await Promise.resolve()
      })
      expect(document.activeElement).toBe(outside)
      outside.remove()
      view.unmount()
    },
  )

  it('keeps an opened submitted plan mounted when screen-reader presentation changes', async () => {
    document.body.classList.add('vscode-using-screen-reader')
    const node = tool('plan')
    const plan = {
      ...node,
      tool: { ...node.tool, submittedPlan: { title: 'Saved plan', markdown: 'Full plan text' } },
    }
    const view = render(<Tools layout={layout} tools={[plan]} />)
    const artifact = view.container.querySelector<HTMLDetailsElement>('.dsh-submitted-plan')!
    artifact.open = true
    fireEvent(artifact, new Event('toggle'))
    await screen.findByText('Full plan text')
    const summary = artifact.querySelector('summary')!
    summary.focus()
    await act(async () => {
      document.body.classList.remove('vscode-using-screen-reader')
      await Promise.resolve()
    })
    await waitFor(() => expect(view.container.querySelector('[data-quiet-tools]')).toBeNull())
    expect(view.container.querySelector('.dsh-submitted-plan')).toBe(artifact)
    expect(artifact.open).toBe(true)
    expect(screen.getByText('Full plan text')).toBeDefined()
    expect(document.activeElement).toBe(summary)
  })

  it('keeps a submitted plan outside the tool disclosure throughout running and settlement', () => {
    document.body.classList.add('vscode-using-screen-reader')
    const node = tool('plan', 'running')
    const plan = {
      ...node,
      tool: { ...node.tool, turn: 1, submittedPlan: { title: 'A durable plan', markdown: 'Plan content' } },
    }
    const content = (running: boolean): ReactElement => (
      <ConversationLayoutProvider initialLayout={layout}>
        <Timeline
          sessionId="s"
          running={running}
          streaming={running}
          nodes={running ? [plan] : [{ ...plan, tool: { ...plan.tool, status: 'completed' } }]}
        />
      </ConversationLayoutProvider>
    )
    const view = render(content(true))
    const artifact = view.container.querySelector('.dsh-submitted-plan')!
    expect(artifact).not.toBeNull()
    expect(artifact.closest('[data-quiet-tools]')).toBeNull()
    const toggle = screen.getByRole('button', { name: 'Tools working…' })
    fireEvent.click(toggle)
    expect(view.container.querySelectorAll('.dsh-submitted-plan')).toHaveLength(1)
    expect(view.container.querySelector('.dsh-submitted-plan')).toBe(artifact)
    fireEvent.click(toggle)
    expect(view.container.querySelector('.dsh-submitted-plan')).toBe(artifact)
    view.rerender(content(false))
    expect(view.container.querySelector('.dsh-submitted-plan')).toBe(artifact)
    expect(artifact.closest('[hidden]')).toBeNull()
  })

  it('omits the collapsed failure prompt when completed error details are available', () => {
    document.body.classList.add('vscode-using-screen-reader')
    const node = tool('one', 'failed')
    render(<Tools layout={layout} tools={[{ ...node, tool: { ...node.tool, error: 'Execution failed' } }]} />)
    expect(screen.queryByText('timeline.quietTools.failed')).toBeNull()
    const card = document.querySelector('[data-tool-call-id]')!
    fireEvent.click(card.querySelector('button')!)
    expect(screen.getByRole('alert').textContent).toContain('Execution failed')
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('keeps the collapsed streaming reasoning subtree unchanged, reveals current text on demand and settles', () => {
    document.body.classList.add('vscode-using-screen-reader')
    const props = {
      id: 'thinking',
      streaming: true,
      expanded: false,
      translate: t,
      onExpandedChange: vi.fn(),
    }
    const content = (markdown: string, expanded = false, streaming = true): ReactElement => (
      <ConversationLayoutProvider initialLayout={layout}>
        <ReasoningDisclosure {...props} markdown={markdown} expanded={expanded} streaming={streaming} />
      </ConversationLayoutProvider>
    )
    const view = render(content('first\nparagraph\n\n'))
    const section = view.container.querySelector('section')!
    const observer = new MutationObserver(() => undefined)
    observer.observe(section, { subtree: true, childList: true, characterData: true, attributes: true })
    for (const text of [
      'first\nparagraph\n\nnext',
      'a completely new paragraph\nwith details',
      'final thinking',
    ])
      view.rerender(content(text))
    expect(observer.takeRecords()).toHaveLength(0)
    expect(section.textContent).not.toContain('final thinking')
    expect(section.querySelector('[aria-live], [role="status"]')).toBeNull()
    const button = screen.getByRole('button', { name: 'timeline.showReasoning' })
    button.focus()
    fireEvent.click(button)
    expect(props.onExpandedChange).toHaveBeenCalledWith(true)
    view.rerender(content('latest thinking', true))
    expect(section.textContent).toContain('latest thinking')
    view.rerender(content('latest thinking plus tokens', true))
    expect(section.textContent).toContain('latest thinking plus tokens')
    expect(document.activeElement).toBe(button)
    view.rerender(content('settled thinking', false, false))
    expect(section.textContent).toContain('settled thinking')
    observer.disconnect()
  })

  it('holds tool summaries stable through output, state and count updates; expansion and completion reveal current cards', () => {
    document.body.classList.add('vscode-using-screen-reader')
    const view = render(<Tools layout={layout} tools={[tool('one', 'queued')]} />)
    const group = view.container.querySelector('[data-quiet-tools]')!
    const observer = new MutationObserver(() => undefined)
    observer.observe(group, { subtree: true, childList: true, characterData: true, attributes: true })
    view.rerender(<Tools layout={layout} tools={[tool('one', 'running', 'token update')]} />)
    view.rerender(<Tools layout={layout} tools={[tool('one', 'completed', 'done one'), tool('two')]} />)
    expect(observer.takeRecords()).toHaveLength(0)
    expect(group.textContent).toBe('timeline.quietTools.running')
    expect(group.querySelector('[data-tool-call-id]')).toBeNull()
    const toggle = screen.getByRole('button', { name: 'timeline.quietTools.running' })
    toggle.focus()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(group.querySelectorAll('[data-tool-call-id]')).toHaveLength(2)
    view.rerender(
      <Tools
        layout={layout}
        tools={[tool('one', 'completed', 'done one'), tool('two', 'running', 'new output')]}
      />,
    )
    expect(group.textContent).toContain('new output')
    expect(document.activeElement).toBe(toggle)
    fireEvent.click(toggle)
    expect(group.querySelector('[data-tool-call-id]')).toBeNull()
    view.rerender(
      <Tools layout={layout} tools={[tool('one', 'completed'), tool('two', 'completed', 'final output')]} />,
    )
    // The user's explicit collapse survives completion; reopening reads the latest data.
    expect(group.querySelector('[data-tool-call-id]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'timeline.quietTools.completed' }))
    expect(group.textContent).toContain('final output')
    observer.disconnect()
    view.unmount()
    const settled = render(<Tools layout={layout} tools={[tool('one')]} />)
    settled.rerender(<Tools layout={layout} tools={[tool('one', 'completed', 'settled output')]} />)
    expect(settled.container.querySelector('[data-tool-call-id]')).not.toBeNull()
    expect(settled.container.textContent).toContain('settled output')
  })

  it('exposes errors once without broadcasting changing failure counts or output', () => {
    document.body.classList.add('vscode-using-screen-reader')
    const view = render(<Tools layout={layout} tools={[tool('one')]} />)
    view.rerender(<Tools layout={layout} tools={[tool('one', 'failed', 'first failure'), tool('two')]} />)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('timeline.quietTools.failed')
    const observer = new MutationObserver(() => undefined)
    observer.observe(status, { subtree: true, childList: true, characterData: true, attributes: true })
    view.rerender(
      <Tools
        layout={layout}
        tools={[tool('one', 'failed', 'more error text'), tool('two', 'failed'), tool('three')]}
      />,
    )
    expect(observer.takeRecords()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'timeline.quietTools.running' }))
    expect(view.container.textContent).toContain('more error text')
    expect(screen.queryByText('timeline.quietTools.failed')).toBeNull()
    observer.disconnect()
  })

  it('keeps the main answer streaming with one stable start/end region across tool transitions', async () => {
    document.body.classList.add('vscode-using-screen-reader')
    const content = (
      markdown: string,
      running = true,
      tools: readonly ToolTimelineNode[] = [],
    ): ReactElement => (
      <ConversationLayoutProvider initialLayout={layout}>
        <Timeline
          sessionId="s"
          running={running}
          streaming={running}
          nodes={[
            ...tools,
            {
              kind: 'assistant-message',
              id: 'answer',
              markdown,
              images: [],
              reasoning: { markdown: 'private thinking', streaming: running },
              streaming: running,
            },
          ]}
        />
      </ConversationLayoutProvider>
    )
    const view = render(content('Answer one'))
    const region = view.container.querySelector('[aria-live="polite"]')!
    const initialRole = region.getAttribute('role')
    const observer = new MutationObserver(() => undefined)
    observer.observe(region, { subtree: true, childList: true, characterData: true, attributes: true })
    view.rerender(content('Answer one two', true, [tool('one')]))
    expect(screen.getByText('Answer one two')).toBeDefined()
    view.rerender(content('Answer one two three', true, [tool('one', 'completed')]))
    expect(screen.getByText('Answer one two three')).toBeDefined()
    expect(observer.takeRecords()).toHaveLength(0)
    expect(view.container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1)
    view.rerender(content('Answer finished', false, [tool('one', 'completed')]))
    expect(region.textContent).toBe('Response finished')
    expect(view.container.querySelector('[aria-live="polite"]')).toBe(region)
    expect(region.getAttribute('role')).toBe(initialRole)
    expect(observer.takeRecords().filter((record) => record.type === 'attributes')).toHaveLength(0)
    await act(async () => {
      await Promise.resolve()
    })
    observer.disconnect()
  })
})
