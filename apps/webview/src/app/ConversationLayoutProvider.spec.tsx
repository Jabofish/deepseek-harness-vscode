// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import { ConversationLayoutProvider, useConversationLayout } from './ConversationLayoutProvider.js'

function LayoutChoice(): ReactElement {
  const preference = useConversationLayout()
  return (
    <button type="button" onClick={() => preference?.setLayout('classic')}>
      Classic
    </button>
  )
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  delete document.documentElement.dataset.dshConversationLayout
})

describe('conversation layout for portalled surfaces', () => {
  it.each([undefined, 'classic'])('restores the prior root preference %s after disposal', (previous) => {
    if (previous !== undefined) document.documentElement.dataset.dshConversationLayout = previous
    const view = render(
      <ConversationLayoutProvider initialLayout="focused">
        <LayoutChoice />
      </ConversationLayoutProvider>,
    )
    expect(document.documentElement.dataset.dshConversationLayout).toBe('focused')

    fireEvent.click(screen.getByRole('button', { name: 'Classic' }))
    expect(document.documentElement.dataset.dshConversationLayout).toBe('classic')

    view.unmount()
    expect(document.documentElement.dataset.dshConversationLayout).toBe(previous)
  })
})
