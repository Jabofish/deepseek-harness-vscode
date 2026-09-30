// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ReasoningDisclosure } from './ReasoningDisclosure.js'

describe('ReasoningDisclosure', () => {
  afterEach(() => cleanup())

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
