// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TimelineNode } from '@dsh-vscode/timeline'

import { ToolCallCollection } from './ToolCallCollection.js'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'
import type { ExpandedDetailsSetter } from './timeline-shared.js'

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

  it('opens a focused web target without toggling its independently controlled details', () => {
    const open = vi.fn()
    const expand = vi.fn<ExpandedDetailsSetter>()
    const source = toolNode('web_fetch', undefined, 'completed', {
      phase: 'result',
      card: 'web',
      kind: 'fetch',
      url: 'https://example.test/page',
      statusCode: 200,
      truncated: false,
    })
    const view = render(
      <ConversationLayoutProvider initialLayout="focused">
        <ToolCallCollection
          tools={[source]}
          grouped={false}
          expanded={new Set()}
          onExpandedChange={expand}
          translate={translate}
          onOpenLink={open}
        />
      </ConversationLayoutProvider>,
    )
    const target = view.container.querySelector<HTMLButtonElement>('.dsh-tool-row__inline-target')!
    target.focus()
    fireEvent.click(target)
    expect(open).toHaveBeenCalledWith('https://example.test/page')
    expect(expand).not.toHaveBeenCalled()
    const toggle = view.container.querySelector<HTMLButtonElement>('.dsh-tool-row__toggle')!
    fireEvent.click(toggle)
    expect(expand).toHaveBeenCalledOnce()
    const update = expand.mock.calls[0]?.[0]
    if (typeof update !== 'function') throw new Error('Expected a functional expansion update')
    expect(update(new Set(['reasoning']))).toEqual(new Set(['reasoning', 'web_fetch']))
    expect(target.closest('button')?.parentElement?.closest('button')).toBeNull()
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')).not.toBeNull()
  })

  it('keeps preparations visible outside the executed-call count and gives generic tools a preparation label', () => {
    const preview = toolNode('preview')
    const tools = [
      toolNode('first'),
      toolNode('second'),
      {
        ...preview,
        tool: {
          ...preview.tool,
          status: 'queued' as const,
          inputSummary: 'PRIVATE_INPUT',
          preparation: { attemptId: 'attempt-1', updateIndex: 1, description: 'Inspect metadata' },
        },
      },
    ]
    const view = render(
      <ToolCallCollection
        tools={tools}
        expanded={new Set()}
        onExpandedChange={() => undefined}
        translate={(key, params) =>
          key === 'toolrow.preparing' ? 'Preparing arguments' : translate(key, params)
        }
      />,
    )
    expect(screen.getByLabelText('Show 2 tool calls')).toBeDefined()
    expect(view.container.querySelector('[data-state="preparing"]')?.textContent).toContain(
      'Preparing arguments',
    )
    expect(view.container.textContent).not.toContain('PRIVATE_INPUT')
    expect(
      view.container
        .querySelector('details')
        ?.contains(view.container.querySelector('[data-state="preparing"]')),
    ).toBe(false)
  })

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

describe('tool result gallery', () => {
  afterEach(() => cleanup())
  it('loads nested tool images only after that tool is expanded', async () => {
    const image = {
      attachmentId: 'opaque-image',
      mediaType: 'image/png' as const,
      bytes: 80,
      width: 2,
      height: 1,
    }
    const child = toolNode('read_image', 'root')
    const tools = [toolNode('root'), { ...child, tool: { ...child.tool, images: [image] } }]
    const onLoadImage = vi.fn().mockResolvedValue('data:image/png;base64,iVBORw0KGgo=')
    const props = { tools, onExpandedChange: (): void => undefined, translate, onLoadImage }
    const view = render(<ToolCallCollection {...props} expanded={new Set()} />)
    expect(onLoadImage).not.toHaveBeenCalled()
    view.rerender(<ToolCallCollection {...props} expanded={new Set(['read_image'])} />)
    await screen.findByRole('button', { name: 'timeline.openImage' })
    expect(onLoadImage).toHaveBeenCalledExactlyOnceWith(image)
  })
})
