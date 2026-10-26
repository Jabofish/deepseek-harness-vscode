// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { useTranscriptCopyFallback } from './useTranscriptCopyFallback.js'
import { rowCopyMarkdown } from './transcript-copy.js'
import type { PresentedTimelineNode } from './focused-timeline-projection.js'

/**
 * The Timeline renders rows with `data-node-id` and mounts the hook; this
 * harness keeps the DOM contract identical while letting each case pick rows.
 */
function TranscriptHarness(props: { readonly rows: readonly PresentedTimelineNode[] }): ReactElement {
  const announced = useTranscriptCopyFallback(props.rows)
  return (
    <div>
      {props.rows.map((row) => (
        <div key={row.id} data-node-id={row.id}>
          <span data-testid={`text-${row.id}`}>{rowCopyMarkdown(row)}</span>
          <button type="button">{row.id}</button>
        </div>
      ))}
      <textarea aria-label="composer" />
      {announced ? <span role="status">Copied</span> : null}
    </div>
  )
}

const ANSWER: PresentedTimelineNode = {
  kind: 'assistant-message',
  id: 'assistant-1',
  markdown: '# Heading\n\nwith `code`',
  streaming: false,
}
const PROMPT: PresentedTimelineNode = { kind: 'user-message', id: 'user-1', markdown: 'the prompt' }

/** jsdom has no `ClipboardEvent`, so the copy event carries a stub payload. */
function dispatchCopy(): { readonly event: Event; readonly written: string[] } {
  const written: string[] = []
  const event = new Event('copy', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      setData: (type: string, text: string): void => {
        written.push(`${type}:${text}`)
      },
    },
  })
  document.dispatchEvent(event)
  return { event, written }
}

function select(contents: Element): void {
  const range = document.createRange()
  range.selectNodeContents(contents)
  const selection = document.getSelection()
  expect(selection).not.toBeNull()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

describe('useTranscriptCopyFallback', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    document.getSelection()?.removeAllRanges()
  })

  it('fills the menu Copy with the row the mouse addressed', () => {
    render(<TranscriptHarness rows={[ANSWER, PROMPT]} />)
    fireEvent.contextMenu(screen.getByTestId('text-assistant-1'))
    const { event, written } = dispatchCopy()
    expect(written).toEqual(['text/plain:# Heading\n\nwith `code`'])
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves a real selection to the browser', () => {
    render(<TranscriptHarness rows={[ANSWER]} />)
    fireEvent.contextMenu(screen.getByTestId('text-assistant-1'))
    select(screen.getByTestId('text-assistant-1'))
    const { event, written } = dispatchCopy()
    expect(written).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })

  it('keeps an addressed row that is no longer projected a strict no-op', () => {
    render(<TranscriptHarness rows={[ANSWER]} />)
    const stale = document.createElement('div')
    stale.setAttribute('data-node-id', 'gone-1')
    document.body.appendChild(stale)
    try {
      fireEvent.contextMenu(stale)
      expect(dispatchCopy().written).toEqual([])
    } finally {
      stale.remove()
    }
  })
})
