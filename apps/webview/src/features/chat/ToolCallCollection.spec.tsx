// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { TimelineNode } from '@dsh-vscode/timeline'

import { ToolCallCollection } from './ToolCallCollection.js'

const translate = (key: string, params?: Readonly<Record<string, string | number>>): string => {
  if (key === 'timeline.toolSubcalls') return 'Nested tool calls'
  if (key === 'timeline.showToolCalls') return `Show ${params?.count ?? 0} tool calls`
  if (key === 'toolcard.status.running') return 'Running'
  if (key === 'toolcard.status.completed') return 'Done'
  if (key === 'toolcard.status.failed') return 'Failed'
  if (key === 'toolrow.title.bash') return 'Bash'
  return key
}

function toolNode(
  id: string,
  parentCallId?: string,
  status: 'running' | 'completed' | 'failed' = 'completed',
  presentation?: Extract<TimelineNode, { readonly kind: 'tool' }>['tool']['presentation'],
): Extract<TimelineNode, { readonly kind: 'tool' }> {
  return {
    kind: 'tool',
    id,
    tool: {
      id,
      ...(parentCallId === undefined ? {} : { parentCallId }),
      name: id === 'root' ? 'run_code' : id,
      category: 'test',
      title: id,
      status,
      inputSummary: id,
      ...(presentation === undefined ? {} : { presentation }),
      metadata: {},
    },
  }
}

describe('ToolCallCollection', () => {
  afterEach(() => cleanup())

  it('labels a collapsed group by the failure its latest shell row states', () => {
    render(
      <ToolCallCollection
        tools={[
          toolNode('first', undefined, 'completed'),
          toolNode('bash', undefined, 'completed', {
            phase: 'result',
            card: 'terminal',
            output: 'boom',
            exitCode: 2,
          }),
        ]}
        expanded={new Set()}
        onExpandedChange={() => undefined}
        translate={translate}
      />,
    )

    expect(screen.getByText('Bash · Failed')).toBeDefined()
  })

  it('renders recursively nested child calls with their independent lifecycle status', () => {
    const onExpandedChange = (): void => undefined
    const { container } = render(
      <ToolCallCollection
        tools={[
          toolNode('root', undefined, 'running'),
          toolNode('child', 'root', 'completed'),
          toolNode('grandchild', 'child', 'failed'),
        ]}
        expanded={new Set()}
        onExpandedChange={onExpandedChange}
        translate={translate}
      />,
    )

    const subcalls = container.querySelector<HTMLElement>('[data-subcalls="true"]')
    expect(subcalls).not.toBeNull()
    if (subcalls === null) return
    expect(subcalls.querySelectorAll('[data-tool-call-id]').length).toBe(2)
    expect(subcalls.querySelector('[data-tool-call-id="child"]')).not.toBeNull()
    expect(subcalls.querySelector('[data-tool-call-id="grandchild"]')).not.toBeNull()
    expect(container.querySelector('[data-tool-call-id="root"] .dsh-tool-card--running')).not.toBeNull()
    expect(container.querySelector('[data-tool-call-id="child"] .dsh-tool-card--completed')).not.toBeNull()
    expect(container.querySelector('[data-tool-call-id="grandchild"] .dsh-tool-card--failed')).not.toBeNull()
  })

  it('does not hide an orphan child when the parent is outside the rendered window', () => {
    render(
      <ToolCallCollection
        tools={[toolNode('child', 'missing-parent', 'running')]}
        expanded={new Set()}
        onExpandedChange={() => undefined}
        translate={translate}
      />,
    )

    expect(document.querySelector('[data-tool-call-id="child"]')).not.toBeNull()
    expect(screen.queryByRole('group', { name: 'Nested tool calls' })).toBeNull()
  })
})
