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
})
