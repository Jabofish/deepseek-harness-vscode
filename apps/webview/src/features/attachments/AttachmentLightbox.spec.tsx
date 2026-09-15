// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef, type ReactElement } from 'react'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
import { AttachmentLightbox } from './AttachmentLightbox.js'

describe('AttachmentLightbox', () => {
  afterEach(() => cleanup())

  it('shows a loading status while the preview is still pending', () => {
    render(<AttachmentLightbox name="photo.png" src={undefined} onClose={vi.fn()} />)

    expect(screen.getByRole('status').textContent).toBe('Loading preview…')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a settled failure instead of a pending load', () => {
    render(<AttachmentLightbox name="photo.png" src={undefined} unavailable onClose={vi.fn()} />)

    expect(screen.getByRole('alert').textContent).toBe('Unable to load image')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('prefers the resolved image over a stale failure flag', () => {
    render(
      <AttachmentLightbox name="photo.png" src="data:image/png;base64,AAAA" unavailable onClose={vi.fn()} />,
    )

    expect(screen.getByRole('img', { name: 'photo.png' })).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<AttachmentLightbox name="photo.png" src={undefined} onClose={onClose} />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves Escape to a layer that already consumed it', () => {
    const onClose = vi.fn()
    const onEscape = vi.fn()
    function Consumer(): ReactElement {
      const ref = useRef<HTMLDivElement>(null)
      useDismissibleLayer({ open: true, refs: [ref], onDismiss: () => undefined, onEscape })
      return <div ref={ref} />
    }
    render(
      <>
        <Consumer />
        <AttachmentLightbox name="photo.png" src="data:image/png;base64,AAAA" onClose={onClose} />
      </>,
    )

    // The key targets a node inside the document, so it reaches the layer's
    // document listener before the lightbox's window listener -- the order a
    // real key press takes.
    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })
})
