// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
const REASONING: PresentedTimelineNode = {
  kind: 'reasoning',
  id: 'reasoning-1',
  markdown: 'thinking',
  streaming: false,
}

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

  it('copies a user row with the same rule as an assistant row', () => {
    render(<TranscriptHarness rows={[ANSWER, PROMPT]} />)
    fireEvent.contextMenu(screen.getByTestId('text-user-1'))
    expect(dispatchCopy().written).toEqual(['text/plain:the prompt'])
  })

  it('resolves the keyboard menu key and Tab focus to the same row', () => {
    render(<TranscriptHarness rows={[ANSWER, PROMPT]} />)
    // The browser dispatches `contextmenu` on the focused element for the menu
    // key and Shift+F10, so the semantic target needs no pointer position.
    const focused = screen.getByRole('button', { name: 'user-1' })
    focused.focus()
    fireEvent.contextMenu(focused)
    expect(dispatchCopy().written).toEqual(['text/plain:the prompt'])
  })

  it('falls back to the focused row when a copy arrives without a context menu', () => {
    render(<TranscriptHarness rows={[ANSWER, PROMPT]} />)
    screen.getByRole('button', { name: 'assistant-1' }).focus()
    expect(dispatchCopy().written).toEqual(['text/plain:# Heading\n\nwith `code`'])
  })

  it('leaves a real selection to the browser', () => {
    render(<TranscriptHarness rows={[ANSWER]} />)
    fireEvent.contextMenu(screen.getByTestId('text-assistant-1'))
    select(screen.getByTestId('text-assistant-1'))
    const { event, written } = dispatchCopy()
    expect(written).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves a focused text field to the browser when no row was addressed', () => {
    render(<TranscriptHarness rows={[ANSWER]} />)
    screen.getByRole('textbox', { name: 'composer' }).focus()
    expect(dispatchCopy().written).toEqual([])
  })

  it('answers an addressed row even while a text field keeps focus', () => {
    render(<TranscriptHarness rows={[ANSWER]} />)
    // A browser that leaves the caret in the composer must not veto the row
    // the user pointed the menu at.
    fireEvent.contextMenu(screen.getByTestId('text-assistant-1'))
    screen.getByRole('textbox', { name: 'composer' }).focus()
    expect(dispatchCopy().written).toEqual(['text/plain:# Heading\n\nwith `code`'])
  })

  it('prefers the addressed row over a focused element in another row', () => {
    render(<TranscriptHarness rows={[ANSWER, PROMPT]} />)
    screen.getByRole('button', { name: 'assistant-1' }).focus()
    fireEvent.contextMenu(screen.getByTestId('text-user-1'))
    expect(dispatchCopy().written).toEqual(['text/plain:the prompt'])
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

  it('reads the rows of the current render', () => {
    const { rerender } = render(<TranscriptHarness rows={[ANSWER]} />)
    const updated: PresentedTimelineNode = { ...ANSWER, markdown: 'revised answer' }
    rerender(<TranscriptHarness rows={[updated]} />)
    fireEvent.contextMenu(screen.getByTestId('text-assistant-1'))
    expect(dispatchCopy().written).toEqual(['text/plain:revised answer'])
  })

  it('stops listening once it unmounts', () => {
    const { unmount } = render(<TranscriptHarness rows={[ANSWER]} />)
    fireEvent.contextMenu(screen.getByTestId('text-assistant-1'))
    unmount()
    const { event, written } = dispatchCopy()
    expect(written).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })

  it('ignores a copy event that carries no payload', () => {
    render(<TranscriptHarness rows={[ANSWER]} />)
    fireEvent.contextMenu(screen.getByTestId('text-assistant-1'))
    const event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: null })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('keeps a row without readable text a strict no-op', () => {
    render(<TranscriptHarness rows={[REASONING]} />)
    fireEvent.contextMenu(screen.getByTestId('text-reasoning-1'))
    const { event, written } = dispatchCopy()
    // Neither the clipboard nor the event is touched, so nothing is cleared.
    expect(written).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })

  it('forgets a row once the user moves on', () => {
    render(<TranscriptHarness rows={[ANSWER]} />)
    fireEvent.contextMenu(screen.getByTestId('text-assistant-1'))
    act(() => {
      document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(dispatchCopy().written).toEqual([])
  })

  it('retires the stored row on a key press, so Ctrl+C cannot replay it', () => {
    render(<TranscriptHarness rows={[ANSWER]} />)
    fireEvent.contextMenu(screen.getByTestId('text-assistant-1'))
    act(() => {
      document.dispatchEvent(new Event('keydown', { bubbles: true }))
    })
    expect(dispatchCopy().written).toEqual([])
  })

  it('announces the copy and then withdraws the announcement', () => {
    vi.useFakeTimers()
    render(<TranscriptHarness rows={[ANSWER]} />)
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.contextMenu(screen.getByTestId('text-assistant-1'))
    act(() => {
      dispatchCopy()
    })
    expect(screen.getByRole('status').textContent).toBe('Copied')
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('ignores a copy another listener already answered', () => {
    const claim = (event: Event): void => {
      event.preventDefault()
    }
    // Registered first, so it owns the event before the fallback sees it.
    document.addEventListener('copy', claim, true)
    try {
      render(<TranscriptHarness rows={[ANSWER]} />)
      fireEvent.contextMenu(screen.getByTestId('text-assistant-1'))
      expect(dispatchCopy().written).toEqual([])
    } finally {
      document.removeEventListener('copy', claim, true)
    }
  })
})
