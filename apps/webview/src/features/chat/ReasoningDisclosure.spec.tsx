// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ReasoningDisclosure } from './ReasoningDisclosure.js'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'

describe('ReasoningDisclosure', () => {
  afterEach(() => cleanup())

  it('uses the completed paragraph first line in focused streams and lazily renders Markdown details', () => {
    const props = {
      id: 'focused-reasoning',
      expanded: false,
      onExpandedChange: () => undefined,
      translate: (key: string): string => key,
    }
    const view = render(
      <ConversationLayoutProvider initialLayout="focused">
        <ReasoningDisclosure {...props} markdown={'**First**\nDetails\n\nSecond partial'} streaming />
      </ConversationLayoutProvider>,
    )
    expect(view.container.querySelector('.dsh-timeline__reasoning-summary')?.textContent).toBe('First')
    expect(view.container.querySelector('.dsh-markdown')).toBeNull()
    view.rerender(
      <ConversationLayoutProvider initialLayout="focused">
        <ReasoningDisclosure
          {...props}
          markdown={'**First**\nDetails\n\nSecond completed\nDetails'}
          streaming
        />
      </ConversationLayoutProvider>,
    )
    expect(view.container.querySelector('.dsh-timeline__reasoning-summary')?.textContent).toBe(
      'Second completed',
    )
    view.rerender(
      <ConversationLayoutProvider initialLayout="focused">
        <ReasoningDisclosure {...props} markdown={'**First**\n\n- Detail'} streaming={false} expanded />
      </ConversationLayoutProvider>,
    )
    expect(view.container.querySelector('.dsh-markdown strong')?.textContent).toBe('First')
    expect(view.container.querySelector('.dsh-markdown li')?.textContent).toBe('Detail')
  })

  it('retains native disclosure semantics and the source identity in focused mode', () => {
    let expanded = false
    const view = render(
      <ConversationLayoutProvider initialLayout="focused">
        <ReasoningDisclosure
          id="reasoning-source"
          markdown="Inspect source"
          streaming={false}
          expanded={expanded}
          onExpandedChange={(value) => {
            expanded = value
          }}
          translate={(key) => key}
        />
      </ConversationLayoutProvider>,
    )
    const toggle = screen.getByRole('button', { name: 'timeline.showReasoning' })
    fireEvent.click(toggle)
    expect(expanded).toBe(true)
    expect(view.container.querySelector('[data-reasoning-id="reasoning-source"]')).not.toBeNull()
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')).not.toBeNull()
  })

  it('keeps only the latest three non-blank reasoning lines in the streaming preview', () => {
    const { container } = render(
      <ReasoningDisclosure
        id="reasoning-1"
        markdown={'one\ntwo\nthree\nfour\n\n'}
        streaming
        expanded={false}
        onExpandedChange={() => undefined}
        translate={(key) => key}
      />,
    )

    expect(screen.getByText('timeline.thinking')).toBeDefined()
    expect(container.querySelector('.dsh-timeline__reasoning-summary')?.textContent).toBe('two three four')
  })

  it('normalizes CRLF and hides a whitespace-only reasoning value', () => {
    const { container, rerender } = render(
      <ReasoningDisclosure
        id="reasoning-1"
        markdown={'one\r\ntwo\r\nthree\r\nfour\r\n  \r\n'}
        streaming
        expanded={false}
        onExpandedChange={() => undefined}
        translate={(key) => key}
      />,
    )

    expect(container.querySelector('.dsh-timeline__reasoning-summary')?.textContent).toBe('two three four')

    rerender(
      <ReasoningDisclosure
        id="reasoning-1"
        markdown={' \r\n\t'}
        streaming
        expanded={false}
        onExpandedChange={() => undefined}
        translate={(key) => key}
      />,
    )
    expect(container.querySelector('.dsh-timeline__reasoning-summary')).toBeNull()
  })

  it('does not announce every reasoning token as it streams', () => {
    // Reasoning arrives token by token, and the preview is rebuilt from the
    // markdown on each render. A live region covering this section would queue
    // an announcement per token, drowning the answer the user is waiting for.
    // The Timeline already announces streaming once through its own constant
    // sr-only region (`Timeline.tsx`), which is the intended signal.
    const props = {
      id: 'reasoning-1',
      streaming: true,
      expanded: false,
      onExpandedChange: () => undefined,
      translate: (key: string) => key,
    }
    const { container, rerender } = render(<ReasoningDisclosure {...props} markdown={'step one'} />)

    expect(container.querySelector('[aria-live]')).toBeNull()

    rerender(<ReasoningDisclosure {...props} markdown={'step one\nstep two'} />)
    expect(container.querySelector('[aria-live]')).toBeNull()
    expect(container.querySelector('[role="status"]')).toBeNull()
  })
})
