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

  it('keeps parent, child and grandchild tool calls visible', () => {
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

    expect(container.textContent).toContain('root')
    for (const [id, status] of [
      ['root', 'Running'],
      ['child', 'Done'],
      ['grandchild', 'Failed'],
    ] as const) {
      const action = screen.getAllByText(id).find((element) => element.closest('button') !== null)
      expect(action?.closest('button')?.textContent).toContain(status)
    }
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

    expect(screen.getAllByText('child')).toBeDefined()
    expect(screen.queryByRole('group', { name: 'Nested tool calls' })).toBeNull()
  })
})
