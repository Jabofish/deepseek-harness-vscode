// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AttachmentLightbox } from './AttachmentLightbox.js'

describe('AttachmentLightbox', () => {
  afterEach(() => cleanup())

  it('reports an unavailable image as failed and lets Escape close it', () => {
    const onClose = vi.fn()
    render(<AttachmentLightbox name="photo.png" src={undefined} unavailable onClose={onClose} />)

    expect(screen.getByRole('alert').textContent).toBe('Unable to load image')
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
