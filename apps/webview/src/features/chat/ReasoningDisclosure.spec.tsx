// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ReasoningDisclosure } from './ReasoningDisclosure.js'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'

describe('ReasoningDisclosure', () => {
  afterEach(() => cleanup())

  it('retains native disclosure semantics and the source identity in focused mode', () => {
    let expanded = false
    render(
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
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')).not.toBeNull()
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
