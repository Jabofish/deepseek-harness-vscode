// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SurfaceHandoffPlaceholder } from './SurfaceHandoffPlaceholder.js'

describe('SurfaceHandoffPlaceholder', () => {
  afterEach(() => cleanup())

  it('explains the handoff and reports the editor tab count', () => {
    render(<SurfaceHandoffPlaceholder editorChats={2} onMoveToSidebar={vi.fn()} onOpenSessions={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Chat is open in the editor area' })).toBeDefined()
    expect(screen.getByText(/one tab per session \(2 open\)/u)).toBeDefined()
    // The card stands in for the conversation; it renders no composer and no
    // transcript of its own.
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('sends the move request from the primary action and opens the session list from the secondary one', () => {
    const onMoveToSidebar = vi.fn()
    const onOpenSessions = vi.fn()
    render(
      <SurfaceHandoffPlaceholder
        editorChats={1}
        onMoveToSidebar={onMoveToSidebar}
        onOpenSessions={onOpenSessions}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Move back to side bar' }))
    expect(onMoveToSidebar).toHaveBeenCalledTimes(1)
    expect(onOpenSessions).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Open sessions' }))
    expect(onOpenSessions).toHaveBeenCalledTimes(1)
  })
})
